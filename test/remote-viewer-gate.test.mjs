// 围观（只读）连接的服务端强制：方法白名单、scope 校验、图片会话归属、
// 频控、鉴权分支（过期/熔断/条目保护）与观众帧低优先级发送。
// 服务端强制是唯一安全边界（前端隐藏只是第二道保险），故全部在 ClientSession 层断言。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ClientSession, extractImages } from "../remote/daemon/src/client-session.mjs";
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
  const dir = mkdtempSync(join(tmpdir(), "czr-viewer-"));
  return { dir, path: join(dir, "daemon.json") };
}

// 模拟一条已建立 E2E 信道的手机端连接：走真实加解密，返回可发请求的驾驭器
function harness(configPath, { threads = [], hub = {}, bufferedAmount = () => 0 } = {}) {
  const config = loadOrCreateConfig(configPath);
  const hubStub = {
    registered: [],
    registerClient(c) { this.registered.push(c); },
    removeClient() {},
    subscribe() {},
    unsubscribe() {},
    viewerCount: () => 0,
    isRunning: () => false,
    approvalCount: () => 0,
    ...hub,
  };
  const daemon = {
    config,
    configPath,
    privateKey: privateKeyFromPem(config.privateKeyPem),
    appServer: { healthy: true, listThreads: async () => threads },
    hub: hubStub,
    log: () => {},
    getBufferedAmount: bufferedAmount,
  };
  const received = []; // 解密后的 d2c 消息
  let closed = false;
  const eph = generateKeyPair();
  const key = deriveSessionKey(
    privateKeyFromPem(eph.privateKeyPem),
    Buffer.from(config.publicKey, "base64"),
    config.daemonId,
  );
  const session = new ClientSession("cid-t", daemon, {
    send: (env) => received.push(sealedOpen(key, "d2c", env)),
    close: () => { closed = true; },
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
  return { session, request, received, hub: hubStub, isClosed: () => closed };
}

test("viewer 鉴权：响应含 role/scope/会话名；条目名不被 UA 改写；lastSeenAt 节流", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    config.webUrl = "https://example/remote/";
    const { device, deviceToken } = issueViewerToken(path, config, {
      sessionId: "thr-1",
      sessionName: "演示会话",
    });

    const h = harness(path);
    const reply = await h.request("auth", { deviceToken, name: "iPhone · 微信" });
    assert.equal(reply.result.role, "viewer");
    assert.equal(reply.result.scope.sessionId, "thr-1");
    assert.equal(reply.result.sessionName, "演示会话");
    assert.equal(h.hub.registered.length, 1, "鉴权成功注册进 hub");

    // 共享条目不被观众 UA 变脸；首次连接写入 lastSeenAt
    const onDisk = loadOrCreateConfig(path).devices.find((d) => d.deviceId === device.deviceId);
    assert.equal(onDisk.name, device.name);
    assert.ok(onDisk.lastSeenAt);

    // 10 分钟内第二个观众连入：不再写盘（节流）
    const before = onDisk.lastSeenAt;
    await delay(5);
    const h2 = harness(path);
    await h2.request("auth", { deviceToken, name: "Android · Chrome" });
    const again = loadOrCreateConfig(path).devices.find((d) => d.deviceId === device.deviceId);
    assert.equal(again.lastSeenAt, before, "节流期内不重复写盘");
    assert.equal(again.name, device.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("存量全权设备：鉴权响应无 role 字段，UA 刷新可读名（行为不变）", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueDeviceToken(path, config);
    const h = harness(path);
    const reply = await h.request("auth", { deviceToken, name: "iPhone · Safari" });
    assert.equal(reply.result.role, undefined);
    assert.equal(reply.result.scope, undefined);
    const onDisk = loadOrCreateConfig(path).devices[0];
    assert.equal(onDisk.name, "iPhone · Safari");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("方法白名单：越权方法与未知方法一律 403（默认拒绝）", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1" });
    const h = harness(path);
    await h.request("auth", { deviceToken });
    for (const method of [
      "sessions.list",
      "session.send",
      "goal.set",
      "models.list",
      "image.push",
      "turn.interrupt",
      "session.new",
      "approval.respond",
      "share.create",
      "share.revoke",
      "some.future.method",
    ]) {
      const reply = await h.request(method, {});
      assert.equal(reply.error?.code, 403, `${method} 应被拒绝`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch 越 scope 403；本会话可看；session.more 频控 429", async () => {
  const { dir, path } = tempConfig();
  try {
    const rollout = join(dir, "rollout.jsonl");
    writeFileSync(rollout, '{"type":"event","payload":{"n":1}}\n');
    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1" });
    const h = harness(path, {
      threads: [
        { id: "thr-1", path: rollout },
        { id: "thr-2", path: rollout },
      ],
    });
    try {
      await h.request("auth", { deviceToken });
      const cross = await h.request("session.watch", { sessionId: "thr-2" });
      assert.equal(cross.error?.code, 403);
      const own = await h.request("session.watch", { sessionId: "thr-1" });
      assert.equal(own.result?.ok, true);

      const first = await h.request("session.more", { limit: 10 });
      assert.equal(first.result?.ok, true);
      const second = await h.request("session.more", { limit: 10 });
      assert.equal(second.error?.code, 429, "2 秒内重复触发被频控");
    } finally {
      h.session.dispose(); // 关掉 watch 建立的 RolloutTail（fs.watch 会保持事件循环）
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("image.fetch：观众只能取本会话抽出的图片", async () => {
  const { dir, path } = tempConfig();
  try {
    // 向全局缓存注入一张归属 sess-A 的图片
    const big = "A".repeat(5000);
    const item = extractImages(
      { timestamp: 1, type: "response_item", payload: { type: "image_generation_call", result: big } },
      "sess-A",
    );
    const imageId = item.payload.imageRef.id;
    assert.ok(imageId);

    const config = loadOrCreateConfig(path);
    const outsider = issueViewerToken(path, config, { sessionId: "sess-B" });
    const insider = issueViewerToken(path, config, { sessionId: "sess-A" });

    const hOut = harness(path);
    await hOut.request("auth", { deviceToken: outsider.deviceToken });
    const denied = await hOut.request("image.fetch", { id: imageId });
    assert.equal(denied.error?.code, 403);

    const hIn = harness(path);
    await hIn.request("auth", { deviceToken: insider.deviceToken });
    const ok = await hIn.request("image.fetch", { id: imageId });
    assert.equal(ok.result.data.length, 5000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("share.react：枚举校验、令牌桶频控、静音链接静默丢弃", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const { device, deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1" });
    const reacted = [];
    const h = harness(path, { hub: { addReaction: (sid, emoji, dev) => reacted.push([sid, emoji, dev]) } });
    await h.request("auth", { deviceToken });

    // 枚举外表情 400（不消耗令牌桶）
    const bad = await h.request("share.react", { emoji: "🖕" });
    assert.equal(bad.error?.code, 400);

    // 突发 5 个通过，第 6 个 429（令牌桶容量 5）
    for (let i = 0; i < 5; i++) {
      const r = await h.request("share.react", { emoji: "👏" });
      assert.equal(r.result?.ok, true, `第 ${i + 1} 次喝彩应通过`);
    }
    const sixth = await h.request("share.react", { emoji: "👏" });
    assert.equal(sixth.error?.code, 429);
    assert.equal(reacted.length, 5);
    assert.deepEqual(reacted[0], ["thr-1", "👏", device.deviceId]);

    // 创作者静音该链接：react 返回 ok 但不计数不广播（静默，不给刷子反馈面）
    const edited = loadOrCreateConfig(path);
    edited.devices.find((d) => d.deviceId === device.deviceId).muted = true;
    const { saveConfig } = await import("../remote/daemon/src/config.mjs");
    saveConfig(path, edited);
    const h2 = harness(path, { hub: { addReaction: (sid, emoji, dev) => reacted.push([sid, emoji, dev]) } });
    await h2.request("auth", { deviceToken });
    const mutedR = await h2.request("share.react", { emoji: "🔥" });
    assert.equal(mutedR.result?.ok, true);
    assert.equal(reacted.length, 5, "静音后不再计数");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("过期围观链接：鉴权 403 且连接被断开", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1", ttlMs: 1 });
    await delay(10);
    const h = harness(path);
    const reply = await h.request("auth", { deviceToken });
    assert.equal(reply.error.code, 403);
    assert.ok(reply.error.message.includes("已过期"));
    assert.equal(h.isClosed(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("熔断背板：同会话在线观众达上限时鉴权 403（文案诚实）", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1" });
    const h = harness(path, { hub: { viewerCount: () => 100 } });
    const reply = await h.request("auth", { deviceToken });
    assert.equal(reply.error.code, 403);
    assert.ok(reply.error.message.includes("上限"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("发送优先级：观众通知帧按水位排空，全权帧不受影响", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const viewer = issueViewerToken(path, config, { sessionId: "thr-1" });
    const full = issueDeviceToken(path, loadOrCreateConfig(path));

    let buffered = 8 * 1024 * 1024; // 上行饱和
    const hv = harness(path, { bufferedAmount: () => buffered });
    await hv.request("auth", { deviceToken: viewer.deviceToken });
    const baseline = hv.received.length;
    hv.session.pushLiveEvent("thr-1", "turn/started", {});
    assert.equal(hv.received.length, baseline, "饱和时观众帧滞留 outbox");
    assert.ok(hv.session.congestedSince > 0, "记录拥塞起始时刻");

    // 全权连接同水位下直发（控制通道优先）
    const hf = harness(path, { bufferedAmount: () => buffered });
    await hf.request("auth", { deviceToken: full.deviceToken });
    const fullBase = hf.received.length;
    hf.session.pushLiveEvent("thr-1", "turn/started", {});
    assert.equal(hf.received.length, fullBase + 1, "全权帧永远直发");

    // 水位回落后观众帧排空、拥塞状态清零
    buffered = 0;
    await delay(120);
    assert.equal(hv.received.length, baseline + 1);
    assert.equal(hv.session.congestedSince, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("outbox 超限：整段丢弃观众积压帧（允许跳帧，不涨内存）", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1" });
    let buffered = 8 * 1024 * 1024;
    const h = harness(path, { bufferedAmount: () => buffered });
    await h.request("auth", { deviceToken });
    const baseline = h.received.length;
    for (let i = 0; i < 205; i++) h.session.pushLiveEvent("thr-1", "turn/started", { i });
    buffered = 0;
    await delay(120);
    // 第 201 帧触发整段丢弃（含当帧），其后 4 帧照常入队——观众跳帧续播，
    // 内存不随积压无限增长
    assert.equal(h.received.length, baseline + 4, "旧积压被丢弃，仅送达丢弃后的新帧");
    const delivered = h.received.slice(baseline).map((m) => m.params.params.i);
    assert.deepEqual(delivered, [201, 202, 203, 204]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session.watch 频控：观众 2 秒内重复 watch 429（fromStart 是整文件读，读放大入口）", async () => {
  const { dir, path } = tempConfig();
  try {
    const rollout = join(dir, "rollout.jsonl");
    writeFileSync(rollout, '{"type":"event","payload":{"n":1}}\n');
    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1" });
    const h = harness(path, { threads: [{ id: "thr-1", path: rollout }] });
    try {
      await h.request("auth", { deviceToken });
      const first = await h.request("session.watch", { sessionId: "thr-1" });
      assert.equal(first.result?.ok, true);
      const second = await h.request("session.watch", { sessionId: "thr-1", fromStart: true });
      assert.equal(second.error?.code, 429, "同连接 2 秒内重复 watch 被频控");
    } finally {
      h.session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("回放模式 outbox 溢出：水位回落后从丢弃点按序补发，无重无漏", async () => {
  const { dir, path } = tempConfig();
  try {
    // 200 条首屏 × ~12KB/条 ≈ 2.4MB，必然击穿 OUTBOX_MAX_CHARS（2MiB）
    const rollout = join(dir, "rollout.jsonl");
    const lines = [];
    for (let i = 0; i < 200; i++) {
      lines.push(JSON.stringify({ type: "event", payload: { n: i, pad: "x".repeat(12000) } }));
    }
    writeFileSync(rollout, lines.join("\n") + "\n");
    const old = (Date.now() - 10 * 60_000) / 1000; // 文件"已结束"（mtime 超 60s）才走回放
    utimesSync(rollout, old, old);

    const config = loadOrCreateConfig(path);
    const { deviceToken } = issueViewerToken(path, config, { sessionId: "thr-1" });
    let buffered = 8 * 1024 * 1024; // 上行饱和：首屏帧在 outbox 积压并溢出
    const h = harness(path, {
      threads: [{ id: "thr-1", path: rollout }],
      bufferedAmount: () => buffered,
    });
    try {
      await h.request("auth", { deviceToken });
      const baseline = h.received.length;
      const watch = await h.request("session.watch", { sessionId: "thr-1", fromStart: true });
      assert.equal(watch.result?.mode, "replay");
      await delay(120);
      assert.equal(h.received.length, baseline + 1, "饱和期间除 RPC 应答外无帧送达");

      buffered = 0; // 水位回落：补发循环应从丢弃点（0）按序补齐整个首屏
      await delay(300);
      const nums = h.received
        .slice(baseline)
        .filter((m) => m.method === "session.snapshot" || m.method === "session.event")
        .flatMap((m) => m.params.items.map((it) => it.payload.n));
      assert.deepEqual(nums, [...Array(200).keys()], "补发后条目连续且不重复");
    } finally {
      h.session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// —— 按浏览器身份（clientId）归并设备：同一微信/浏览器多次扫码只算一台 ——
test("同一浏览器（clientId 相同）重新配对：作废旧凭据，只留最新一条", async () => {
  const { dir, path } = tempConfig();
  try {
    const a = issueDeviceToken(path, loadOrCreateConfig(path));         // 设备 A
    const b = issueDeviceToken(path, loadOrCreateConfig(path));         // 设备 B（同电脑另一次生成）
    const CID = "browser-wx-0001";
    // 同一浏览器先用 A 连
    await harness(path).request("auth", { deviceToken: a.deviceToken, clientId: CID, name: "华为 · 微信" });
    assert.equal(loadOrCreateConfig(path).devices.length, 2, "A 连上后 A、B 都在（B 尚未被扫）");
    // 同一浏览器再用 B 连 → 归并：作废 A，只留 B
    await harness(path).request("auth", { deviceToken: b.deviceToken, clientId: CID, name: "华为 · 微信" });
    const devs = loadOrCreateConfig(path).devices;
    assert.equal(devs.length, 1, "同浏览器归并后只剩一条");
    assert.equal(devs[0].deviceId, b.device.deviceId, "保留最新在用的那条");
    assert.equal(devs[0].clientId, CID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不同浏览器（clientId 不同）：各留一条，不互相归并", async () => {
  const { dir, path } = tempConfig();
  try {
    const a = issueDeviceToken(path, loadOrCreateConfig(path));
    const b = issueDeviceToken(path, loadOrCreateConfig(path));
    await harness(path).request("auth", { deviceToken: a.deviceToken, clientId: "browser-wx", name: "微信" });
    await harness(path).request("auth", { deviceToken: b.deviceToken, clientId: "browser-chrome", name: "Chrome" });
    assert.equal(loadOrCreateConfig(path).devices.length, 2, "微信与 Chrome 各算一台");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("不带 clientId（旧手机端/隐私模式）：行为不变，不归并", async () => {
  const { dir, path } = tempConfig();
  try {
    const a = issueDeviceToken(path, loadOrCreateConfig(path));
    const b = issueDeviceToken(path, loadOrCreateConfig(path));
    await harness(path).request("auth", { deviceToken: a.deviceToken, name: "iPhone" });
    await harness(path).request("auth", { deviceToken: b.deviceToken, name: "iPhone" });
    const devs = loadOrCreateConfig(path).devices;
    assert.equal(devs.length, 2, "无 clientId 不归并，两条都在");
    assert.ok(devs.every((d) => d.clientId === undefined), "不写 clientId");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("围观条目不参与归并：同 clientId 的全权设备重连不会误删围观链接", async () => {
  const { dir, path } = tempConfig();
  try {
    const c = loadOrCreateConfig(path);
    c.webUrl = "https://example/remote/";
    const full = issueDeviceToken(path, c);
    const viewer = issueViewerToken(path, loadOrCreateConfig(path), { sessionId: "thr-1", sessionName: "演示" });
    const CID = "browser-same";
    await harness(path).request("auth", { deviceToken: full.deviceToken, clientId: CID, name: "微信" });
    await harness(path).request("auth", { deviceToken: viewer.deviceToken, clientId: CID, name: "微信" });
    assert.equal(loadOrCreateConfig(path).devices.length, 2, "围观不因同 CID 被全权设备归并掉");
    // 全权设备再次重连（同 CID）：merge 跳过围观，围观条目仍在
    await harness(path).request("auth", { deviceToken: full.deviceToken, clientId: CID, name: "微信" });
    const devs = loadOrCreateConfig(path).devices;
    assert.equal(devs.length, 2, "全权重连不删围观");
    assert.ok(devs.some((d) => d.deviceId === viewer.device.deviceId), "围观条目仍在");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("一次性配对也按 clientId 归并：同浏览器换新码作废旧永久条目", async () => {
  const { dir, path } = tempConfig();
  try {
    const a = issueDeviceToken(path, loadOrCreateConfig(path)); // 永久设备 A
    const CID = "browser-x";
    await harness(path).request("auth", { deviceToken: a.deviceToken, clientId: CID, name: "微信" });
    const { issuePairToken } = await import("../remote/daemon/src/config.mjs");
    const token = issuePairToken(path, loadOrCreateConfig(path));
    await harness(path).request("auth", { pairToken: token, clientId: CID, name: "微信" });
    const devs = loadOrCreateConfig(path).devices;
    assert.equal(devs.length, 1, "配对后归并，只剩新设备");
    assert.equal(devs[0].clientId, CID);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
