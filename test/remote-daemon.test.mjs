import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildDevicePayload,
  buildPairPayload,
  consumePairToken,
  deviceUrl,
  findDeviceByToken,
  isDeviceExpired,
  isViewerDevice,
  issueDeviceToken,
  issuePairToken,
  issueViewerToken,
  loadOrCreateConfig,
  pairUrl,
} from "../remote/daemon/src/config.mjs";
import { parseJsonlChunk, readRolloutWindow, RolloutTail } from "../remote/daemon/src/rollout-tail.mjs";

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "czr-test-"));
  return { dir, path: join(dir, "daemon.json") };
}

test("配置初始化：生成密钥与 daemonId 并持久化", () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    assert.ok(config.daemonId.length >= 8);
    assert.ok(config.publicKey);
    assert.ok(config.privateKeyPem.includes("PRIVATE KEY"));
    const again = loadOrCreateConfig(path);
    assert.equal(again.daemonId, config.daemonId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配对令牌：一次性消费，签发设备令牌", () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    config.relayUrl = "wss://relay.example";
    const token = issuePairToken(path, config);
    assert.ok(pairUrl(config, token).includes("#p="));
    assert.ok(buildPairPayload(config, token).tok === token);

    const paired = consumePairToken(path, token);
    assert.ok(paired);
    assert.ok(paired.deviceToken.length > 30);
    assert.ok(findDeviceByToken(paired.config, paired.deviceToken));
    // 令牌不可重复使用
    assert.equal(consumePairToken(path, token), null);
    // 错误令牌被拒绝
    assert.equal(consumePairToken(path, "wrong-token"), null);
    // 配置中只存哈希，不存明文
    const rawConfig = JSON.stringify(loadOrCreateConfig(path));
    assert.ok(!rawConfig.includes(paired.deviceToken));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("永久设备令牌：直接签发、可查、只存哈希、生成 #d= 链接", () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    config.relayUrl = "wss://relay.example";
    config.webUrl = "https://example/remote/";

    const { device, deviceToken } = issueDeviceToken(path, config);
    assert.ok(deviceToken.length > 30);
    // 载荷内嵌 dtok（区别于一次性的 tok），链接是 #d=
    assert.equal(buildDevicePayload(config, deviceToken).dtok, deviceToken);
    const url = deviceUrl(config, deviceToken);
    assert.ok(url.includes("#d="));
    assert.ok(url.startsWith("https://example/remote/"));

    // 令牌可被设备认证查到（重读磁盘，模拟独立进程签发→运行中 daemon 认证）
    const fresh = loadOrCreateConfig(path);
    const found = findDeviceByToken(fresh, deviceToken);
    assert.ok(found);
    assert.equal(found.deviceId, device.deviceId);
    // 永久令牌可重复使用（非一次性）
    assert.ok(findDeviceByToken(loadOrCreateConfig(path), deviceToken));
    // 配置落盘只存哈希，不含明文
    assert.ok(!JSON.stringify(fresh).includes(deviceToken));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("围观令牌：条目形状、载荷提示字段、明文 url 可复制", () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    config.relayUrl = "wss://relay.example";
    config.webUrl = "https://example/remote/";

    const { device, deviceToken } = issueViewerToken(path, config, {
      sessionId: "thr-1",
      sessionName: "重构支付模块的一段非常长的会话名称超过二十个字",
      ttlMs: 24 * 60 * 60 * 1000,
    });
    assert.equal(device.role, "viewer");
    assert.deepEqual(device.scope, { sessionId: "thr-1" });
    assert.equal(device.muted, false);
    assert.ok(device.name.startsWith("围观链接 · "));
    assert.equal(device.sessionName.length, 20, "会话名截断控制载荷体积");
    assert.ok(Math.abs(device.expiresAt - Date.now() - 24 * 3600_000) < 5000);
    assert.ok(isViewerDevice(device));

    // 载荷沿用 #d= 机制 + ro/sid/sname 显示提示（判定一律以 daemon 条目为准）
    assert.ok(device.url.includes("#d="));
    const payload = JSON.parse(
      Buffer.from(device.url.split("#d=")[1], "base64url").toString(),
    );
    assert.equal(payload.ro, 1);
    assert.equal(payload.sid, "thr-1");
    assert.equal(payload.dtok, deviceToken);
    assert.equal(payload.sname.length, 20);

    // 明文 url 落盘（分享弹窗对已有链接提供"复制"——令牌仅授权单会话只读）；
    // 令牌可被鉴权查到（重读磁盘，模拟运行中 daemon 认证）
    const fresh = loadOrCreateConfig(path);
    const found = findDeviceByToken(fresh, deviceToken);
    assert.equal(found.deviceId, device.deviceId);
    assert.equal(found.url, device.url);

    // 永久档：expiresAt 为 null
    const forever = issueViewerToken(path, config, { sessionId: "thr-2", sessionName: "x" });
    assert.equal(forever.device.expiresAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("过期判定：永久/未到期/已到期；全权设备无 role 字段", () => {
  assert.equal(isDeviceExpired({ expiresAt: null }), false);
  assert.equal(isDeviceExpired({}), false);
  assert.equal(isDeviceExpired({ expiresAt: Date.now() + 60_000 }), false);
  assert.equal(isDeviceExpired({ expiresAt: Date.now() - 1 }), true);
  assert.equal(isViewerDevice({ deviceId: "a", tokenHash: "h" }), false);
  assert.equal(isViewerDevice(null), false);
});

test("parseJsonlChunk：完整行解析、半行缓冲、坏行跳过", () => {
  const { items, rest } = parseJsonlChunk('{"a":1}\n{"b":2}\nnot-json\n{"c":');
  assert.deepEqual(items, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":');
  const cont = parseJsonlChunk(`${rest}3}\n`);
  assert.deepEqual(cont.items, [{ c: 3 }]);
});

test("readRolloutWindow：头部锚定窗口读取（观众回放从头读的数据源）", async () => {
  const { dir } = tempConfig();
  const file = join(dir, "rollout.jsonl");
  try {
    writeFileSync(
      file,
      [1, 2, 3, 4, 5].map((n) => JSON.stringify({ type: "event", payload: { n } })).join("\n") + "\n",
    );
    const head = await readRolloutWindow(file, 0, 2);
    assert.equal(head.total, 5);
    assert.deepEqual(head.items.map((i) => i.payload.n), [1, 2]);
    const mid = await readRolloutWindow(file, 2, 2);
    assert.deepEqual(mid.items.map((i) => i.payload.n), [3, 4]);
    const tail = await readRolloutWindow(file, 4, 10);
    assert.deepEqual(tail.items.map((i) => i.payload.n), [5]);
    const past = await readRolloutWindow(file, 10, 5);
    assert.deepEqual(past.items, []);
    assert.equal(past.total, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RolloutTail：回填快照后持续推送追加内容", async () => {
  const { dir } = tempConfig();
  const file = join(dir, "rollout.jsonl");
  writeFileSync(file, '{"type":"session_meta","payload":{"id":"x"}}\n{"type":"event","payload":{"n":1}}\n');
  const batches = [];
  const tail = new RolloutTail(file, {
    onItems: (items, meta) => batches.push({ items, snapshot: meta.snapshot }),
  });
  try {
    await tail.start();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].snapshot, true);
    assert.equal(batches[0].items.length, 2);

    appendFileSync(file, '{"type":"event","payload":{"n":2}}\n');
    const deadline = Date.now() + 5000;
    while (batches.length < 2 && Date.now() < deadline) await delay(50);
    assert.equal(batches.length >= 2, true);
    assert.equal(batches[1].snapshot, false);
    assert.deepEqual(batches[1].items[0].payload, { n: 2 });
  } finally {
    tail.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
