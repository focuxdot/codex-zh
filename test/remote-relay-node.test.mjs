import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";

import { createRelayServer, parsePath } from "../remote/relay-node/server.mjs";
import { acceptKey, decodeFrame, encodeFrame } from "../remote/relay-node/ws-server.mjs";

test("parsePath 只接受合法路径", () => {
  assert.deepEqual(parsePath("/v1/daemon/abcdefgh"), { role: "daemon", daemonId: "abcdefgh" });
  assert.deepEqual(parsePath("/v1/client/abc-DEF_123"), { role: "client", daemonId: "abc-DEF_123" });
  assert.equal(parsePath("/v1/daemon/short"), null);
  assert.equal(parsePath("/v1/other/abcdefgh"), null);
  assert.equal(parsePath("/v1/daemon/包含中文字符不合法"), null);
});

test("acceptKey 符合 RFC 6455 样例", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("帧编解码往返（含掩码帧与分片长度档）", () => {
  for (const size of [0, 5, 125, 126, 300, 70000]) {
    const payload = Buffer.alloc(size, 0x61);
    const frame = decodeFrame(encodeFrame(payload));
    assert.equal(frame.fin, true);
    assert.equal(frame.opcode, 1);
    assert.deepEqual(frame.payload, payload);
  }
  // 客户端掩码帧
  const data = Buffer.from("hello");
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
  const raw = Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, masked]);
  const frame = decodeFrame(raw);
  assert.deepEqual(frame.payload, Buffer.from("hello"));
});

test("relay 撮合：daemon 与 client 互通、状态广播", async (t) => {
  const server = createRelayServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const base = `ws://127.0.0.1:${port}/v1`;
  const daemonId = "testdaemon01";

  const received = { daemon: [], client: [] };
  const client = new WebSocket(`${base}/client/${daemonId}`);
  const clientQueue = makeQueue(client, received.client);
  await once2(client, "open");
  // 断言失败也保证关闭 socket/server，否则遗留句柄会让进程吊死到测试超时
  t.after(() => { client.close(); server.close(); });

  // daemon 未上线时 client 收到 offline 状态（lastSeen 初始为 null）
  assert.deepEqual(await clientQueue.next(), { t: "status", online: false, lastSeen: null });

  const daemon = new WebSocket(`${base}/daemon/${daemonId}`);
  const daemonQueue = makeQueue(daemon, received.daemon);
  await once2(daemon, "open");

  // daemon 上线广播（在线态不带 lastSeen） + open 帧
  assert.deepEqual(await clientQueue.next(), { t: "status", online: true });
  const openFrame = await daemonQueue.next();
  assert.equal(openFrame.t, "open");
  const cid = openFrame.cid;

  // client -> daemon
  client.send(JSON.stringify({ t: "msg", data: { n: "iv", c: "cipher" } }));
  assert.deepEqual(await daemonQueue.next(), { t: "msg", cid, data: { n: "iv", c: "cipher" } });

  // daemon -> client
  daemon.send(JSON.stringify({ t: "msg", cid, data: { n: "iv2", c: "cipher2" } }));
  assert.deepEqual(await clientQueue.next(), { t: "msg", data: { n: "iv2", c: "cipher2" } });

  // 心跳回显
  daemon.send(JSON.stringify({ t: "hb" }));
  assert.deepEqual(await daemonQueue.next(), { t: "hb" });

  // daemon 下线 -> client 收 offline，并带上最近在线时间戳（动态值，校验类型）
  daemon.close();
  const offline = await clientQueue.next();
  assert.equal(offline.t, "status");
  assert.equal(offline.online, false);
  assert.equal(typeof offline.lastSeen, "number");

  client.close();
  server.close();
});

function makeQueue(ws, sink) {
  const waiting = [];
  const buffered = [];
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data);
    sink.push(frame);
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else buffered.push(frame);
  });
  return {
    next() {
      if (buffered.length > 0) return Promise.resolve(buffered.shift());
      return new Promise((resolve, reject) => {
        waiting.push(resolve);
        setTimeout(() => reject(new Error("等待帧超时")), 5000).unref?.();
      });
    },
  };
}

function once2(ws, name) {
  return new Promise((resolve, reject) => {
    ws.addEventListener(name, resolve, { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`ws error: ${e.message ?? ""}`)), { once: true });
  });
}
