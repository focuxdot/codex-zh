#!/usr/bin/env node
// 端到端冒烟：relay + daemon（真实 codex app-server）+ 模拟客户端
// 验证链路：配对握手 -> E2E 加密 -> sessions.list -> session.watch 快照
// 用法：node remote/scripts/smoke.mjs [--codex <cmd>] [--relay wss://...]
//   默认在本地拉起 relay-node；--relay 指定外部实例（如线上 wss://relay.wokey.ai）
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { createRelayServer } from "../relay-node/server.mjs";
import { issuePairToken, loadOrCreateConfig, saveConfig } from "../daemon/src/config.mjs";
import { startDaemon } from "../daemon/src/main.mjs";
import { deriveSessionKey, exportPublicKeyRaw, open, seal } from "../daemon/src/crypto.mjs";

const { values } = parseArgs({
  options: { codex: { type: "string" }, relay: { type: "string" } },
});

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
function ok(message) {
  console.log(`✓ ${message}`);
}

// 1. relay：默认本地拉起，--relay 时用外部实例
let relay = null;
let relayUrl = values.relay ?? null;
if (relayUrl) {
  ok(`使用外部 relay: ${relayUrl}`);
} else {
  relay = createRelayServer();
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  relayUrl = `ws://127.0.0.1:${relay.address().port}`;
  ok(`relay 启动: ${relayUrl}`);
}

// 2. daemon（独立临时配置，不碰真实 ~/.codex-zh）
const dir = mkdtempSync(join(tmpdir(), "czr-smoke-"));
const configPath = join(dir, "daemon.json");
const config = loadOrCreateConfig(configPath);
config.relayUrl = relayUrl;
config.appServerPort = 20000 + Math.floor(Math.random() * 20000);
if (values.codex) config.codexCommand = values.codex;
saveConfig(configPath, config);

const daemon = await startDaemon({ configPath });
ok(`daemon 启动（codex app-server 就绪）`);
const pairToken = issuePairToken(configPath, loadOrCreateConfig(configPath));

// 3. 模拟手机客户端
const clientKeys = generateKeyPairSync("x25519");
const sessionKey = deriveSessionKey(
  clientKeys.privateKey,
  Buffer.from(config.publicKey, "base64"),
  config.daemonId,
);

const ws = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
const inbox = [];
const waiting = [];
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data);
  if (frame.t === "status") return;
  if (frame.t !== "msg") return;
  const message = open(sessionKey, "d2c", frame.data);
  const waiter = waiting.shift();
  if (waiter) waiter(message);
  else inbox.push(message);
};
function nextMessage(timeoutMs = 15000) {
  if (inbox.length > 0) return Promise.resolve(inbox.shift());
  return new Promise((resolve, reject) => {
    waiting.push(resolve);
    setTimeout(() => reject(new Error("等待响应超时")), timeoutMs).unref?.();
  });
}
let sentFirst = false;
function send(payload) {
  const envelope = seal(sessionKey, "c2d", payload);
  if (!sentFirst) {
    envelope.v = 1;
    envelope.k = exportPublicKeyRaw(clientKeys.publicKey).toString("base64");
    sentFirst = true;
  }
  ws.send(JSON.stringify({ t: "msg", data: envelope }));
}
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("client 无法连接 relay"));
});
ok("client 连接 relay");

// 4. 配对鉴权
send({ id: 1, method: "auth", params: { pairToken } });
const authResult = await nextMessage();
if (!authResult.result?.deviceToken) fail(`配对失败: ${JSON.stringify(authResult)}`);
ok(`配对成功: deviceId=${authResult.result.deviceId} daemon=${authResult.result.daemonName}`);

// 5. 会话列表
send({ id: 2, method: "sessions.list", params: { limit: 5 } });
const listResult = await nextMessage();
const sessions = listResult.result?.sessions ?? [];
ok(`sessions.list 返回 ${sessions.length} 个会话`);
if (sessions.length > 0) {
  console.log(`  最近会话: ${(sessions[0].name || sessions[0].preview || "").slice(0, 60)}`);

  // 6. 实时查看快照
  send({ id: 3, method: "session.watch", params: { sessionId: sessions[0].id } });
  let snapshot = null;
  for (let i = 0; i < 5; i++) {
    const msg = await nextMessage();
    if (msg.method === "session.snapshot") {
      snapshot = msg;
      break;
    }
  }
  if (!snapshot) fail("未收到 session.snapshot");
  ok(`session.watch 快照 ${snapshot.params.items.length} 条`);
}

// 7. 错误路径：错误配对码必须被拒绝
const badKeys = generateKeyPairSync("x25519");
const badKey = deriveSessionKey(
  badKeys.privateKey,
  Buffer.from(config.publicKey, "base64"),
  config.daemonId,
);
const ws2 = new WebSocket(`${relayUrl}/v1/client/${config.daemonId}`);
await new Promise((resolve) => (ws2.onopen = resolve));
const rejection = await new Promise((resolve, reject) => {
  ws2.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    if (frame.t === "msg") resolve(open(badKey, "d2c", frame.data));
  };
  const envelope = seal(badKey, "c2d", { id: 1, method: "auth", params: { pairToken: "wrong" } });
  envelope.v = 1;
  envelope.k = exportPublicKeyRaw(badKeys.publicKey).toString("base64");
  ws2.send(JSON.stringify({ t: "msg", data: envelope }));
  setTimeout(() => reject(new Error("等待拒绝超时")), 10000).unref?.();
});
if (!rejection.error) fail("错误配对码未被拒绝");
ok(`错误配对码被拒绝: ${rejection.error.message}`);

console.log("\n端到端冒烟全部通过。");
ws.close();
ws2.close();
daemon.stop();
relay?.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
