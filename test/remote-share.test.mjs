// 围观链接的铸造/撤销/列表（share.*，仅全权设备）与回放模式（fromStart 从头读）。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClientSession } from "../remote/daemon/src/client-session.mjs";
import {
  issueDeviceToken,
  issueViewerToken,
  loadOrCreateConfig,
} from "../remote/daemon/src/config.mjs";
import {
  deriveSessionKey,
  generateKeyPair,
  open as sealedOpen,
  privateKeyFromPem,
  seal,
} from "../remote/daemon/src/crypto.mjs";

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "czr-share-"));
  return { dir, path: join(dir, "daemon.json") };
}

// 与 remote-viewer-gate.test.mjs 同款：真实 E2E 信道的连接驾驭器
function harness(configPath, { threads = [], hub = {}, kicked = [] } = {}) {
  const config = loadOrCreateConfig(configPath);
  const daemon = {
    config,
    configPath,
    privateKey: privateKeyFromPem(config.privateKeyPem),
    appServer: { healthy: true, listThreads: async () => threads },
    hub: {
      registerClient() {},
      removeClient() {},
      subscribe() {},
      unsubscribe() {},
      viewerCount: () => 0,
      viewerCountByDevice: () => 0,
      isRunning: () => false,
      approvalCount: () => 0,
      ...hub,
    },
    log: () => {},
    getBufferedAmount: () => 0,
    kickDevice: (deviceId) => kicked.push(deviceId),
  };
  const received = [];
  const eph = generateKeyPair();
  const key = deriveSessionKey(
    privateKeyFromPem(eph.privateKeyPem),
    Buffer.from(config.publicKey, "base64"),
    config.daemonId,
  );
  const session = new ClientSession("cid-s", daemon, {
    send: (env) => received.push(sealedOpen(key, "d2c", env)),
    close: () => {},
  });
  let nextId = 1;
  async function request(method, params) {
    const id = nextId++;
    await session.onEnvelope({
      v: 1,
      k: eph.publicKeyRaw.toString("base64"),
      ...seal(key, "c2d", { id, method, params }),
    });
    return received.find((m) => m.id === id);
  }
  return { session, request, received, daemon };
}

function writeRollout(dir, n) {
  const file = join(dir, "rollout.jsonl");
  writeFileSync(
    file,
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: `第${i}条` } }),
    ).join("\n") + "\n",
  );
  return file;
}

test("share.create：仅全权可铸；ttl 两档；share.list 返回可复制 url；share.revoke 只删 viewer 并触发踢断", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    config.webUrl = "https://example/remote/";
    const full = issueDeviceToken(path, config);
    const kicked = [];
    const threads = [{ id: "thr-1", name: "重构支付", path: join(dir, "nope.jsonl") }];
    const h = harness(path, { threads, kicked });
    await h.request("auth", { deviceToken: full.deviceToken });

    // ttl 枚举校验
    const bad = await h.request("share.create", { sessionId: "thr-1", ttl: "1h" });
    assert.equal(bad.error?.code, 400);
    // 会话必须存在
    const gone = await h.request("share.create", { sessionId: "thr-x", ttl: "24h" });
    assert.equal(gone.error?.code, 404);

    const r24 = await h.request("share.create", { sessionId: "thr-1", ttl: "24h" });
    assert.ok(r24.result.url.includes("#d="));
    assert.ok(r24.result.deviceId);
    const rForever = await h.request("share.create", { sessionId: "thr-1", ttl: null });
    assert.ok(rForever.result.deviceId);

    // 落盘条目形状正确
    const onDisk = loadOrCreateConfig(path);
    const entries = onDisk.devices.filter((d) => d.role === "viewer");
    assert.equal(entries.length, 2);
    assert.ok(entries.every((d) => d.scope.sessionId === "thr-1" && d.url.includes("#d=")));
    assert.ok(entries.some((d) => typeof d.expiresAt === "number"));
    assert.ok(entries.some((d) => d.expiresAt === null));

    // share.list：仅该会话、含 url/expiresAt/viewers
    const list = await h.request("share.list", { sessionId: "thr-1" });
    assert.equal(list.result.links.length, 2);
    assert.ok(list.result.links.every((l) => l.url.includes("#d=") && "expiresAt" in l && "viewers" in l));
    const other = await h.request("share.list", { sessionId: "thr-2" });
    assert.equal(other.result.links.length, 0);

    // share.revoke：不能撤销全权设备（协议面不扩权）
    const denyFull = await h.request("share.revoke", { deviceId: full.device.deviceId });
    assert.equal(denyFull.error?.code, 404);
    // 撤销围观链接：删条目 + 触发按 deviceId 踢断
    const target = r24.result.deviceId;
    const ok = await h.request("share.revoke", { deviceId: target });
    assert.equal(ok.result.ok, true);
    assert.deepEqual(kicked, [target]);
    assert.ok(!loadOrCreateConfig(path).devices.some((d) => d.deviceId === target));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回放模式：已结束会话 fromStart 从头读，session.more 向后翻页至 done", async () => {
  const { dir, path } = tempConfig();
  try {
    const { utimesSync } = await import("node:fs");
    const file = writeRollout(dir, 300);
    // 回放判定依赖"文件近 60s 无写入"：把 mtime 拨回一小时前 = 已结束会话
    const old = new Date(Date.now() - 3600_000);
    utimesSync(file, old, old);
    const config = loadOrCreateConfig(path);
    const viewer = issueViewerToken(path, config, { sessionId: "thr-1" });
    const h = harness(path, { threads: [{ id: "thr-1", name: "n", path: file }] });
    try {
      await h.request("auth", { deviceToken: viewer.deviceToken });
      const watch = await h.request("session.watch", { sessionId: "thr-1", fromStart: true });
      assert.equal(watch.result.mode, "replay");
      assert.equal(watch.result.total, 300);

      // 首屏是开头 200 条（顺序），以 snapshot 下发
      const snap = h.received.find((m) => m.method === "session.snapshot");
      assert.ok(snap);
      assert.equal(snap.params.total, 300);
      const firstItems = h.received
        .filter((m) => m.method === "session.snapshot" || m.method === "session.event")
        .flatMap((m) => m.params.items);
      assert.equal(firstItems.length, 200);
      assert.equal(firstItems[0].payload.message, "第0条");
      assert.equal(firstItems[199].payload.message, "第199条");

      // 向后翻页：session.event 追加 [200,300)，done=true（首个 more 不受 2s 频控影响）
      const before = h.received.length;
      const more = await h.request("session.more", { limit: 200 });
      assert.equal(more.result.mode, "replay");
      assert.equal(more.result.done, true);
      const extra = h.received
        .slice(before)
        .filter((m) => m.method === "session.event")
        .flatMap((m) => m.params.items);
      assert.equal(extra.length, 100);
      assert.equal(extra[0].payload.message, "第200条");
      assert.equal(extra[99].payload.message, "第299条");
    } finally {
      h.session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回放判定：会话运行中忽略 fromStart，回落尾部实时（mode:tail）", async () => {
  const { dir, path } = tempConfig();
  try {
    const file = writeRollout(dir, 10);
    const config = loadOrCreateConfig(path);
    const viewer = issueViewerToken(path, config, { sessionId: "thr-1" });
    const h = harness(path, {
      threads: [{ id: "thr-1", name: "n", path: file }],
      hub: { isRunning: () => true },
    });
    try {
      await h.request("auth", { deviceToken: viewer.deviceToken });
      const watch = await h.request("session.watch", { sessionId: "thr-1", fromStart: true });
      assert.equal(watch.result.mode, "tail");
    } finally {
      h.session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
