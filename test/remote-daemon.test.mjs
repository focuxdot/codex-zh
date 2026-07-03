import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  buildPairPayload,
  consumePairToken,
  findDeviceByToken,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
} from "../remote/daemon/src/config.mjs";
import { parseJsonlChunk, RolloutTail } from "../remote/daemon/src/rollout-tail.mjs";

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

test("parseJsonlChunk：完整行解析、半行缓冲、坏行跳过", () => {
  const { items, rest } = parseJsonlChunk('{"a":1}\n{"b":2}\nnot-json\n{"c":');
  assert.deepEqual(items, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":');
  const cont = parseJsonlChunk(`${rest}3}\n`);
  assert.deepEqual(cont.items, [{ c: 3 }]);
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
