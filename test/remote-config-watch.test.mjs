// 配置变更检测与设备表核对：撤销/过期的在线连接必须被立即踢断
//（桌面撤销走独立 CLI 进程写文件，daemon 靠 watch + 轮询发现）。
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { enforceDevices, watchConfig } from "../remote/daemon/src/config-watch.mjs";
import {
  issueDeviceToken,
  issueViewerToken,
  loadOrCreateConfig,
  saveConfig,
} from "../remote/daemon/src/config.mjs";

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "czr-watch-"));
  return { dir, path: join(dir, "daemon.json") };
}

function fakeSession(deviceId) {
  return { deviceId, kicked: false, kick() { this.kicked = true; } };
}

test("watchConfig：文件变更触发回调（防抖合并），close 后不再触发", async () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    let fired = 0;
    const watcher = watchConfig(path, { onChange: () => fired++, pollMs: 50, debounceMs: 20 });
    await delay(120); // 建立基线：初始状态不算变更
    assert.equal(fired, 0);

    config.daemonName = "changed";
    saveConfig(path, config);
    const deadline = Date.now() + 3000;
    while (fired === 0 && Date.now() < deadline) await delay(20);
    assert.ok(fired >= 1, "变更被发现");

    watcher.close();
    const after = fired;
    config.daemonName = "changed-again";
    saveConfig(path, config);
    await delay(200);
    assert.equal(fired, after, "close 后不再触发");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforceDevices：被撤销设备的在线连接被踢，存量设备与未鉴权连接不受影响", () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const full = issueDeviceToken(path, config);
    const viewer = issueViewerToken(path, config, { sessionId: "thr-1" });

    const sessions = [
      fakeSession(full.device.deviceId),
      fakeSession(viewer.device.deviceId),
      fakeSession(null), // 未鉴权连接由 auth 自己把关
    ];

    // 模拟桌面撤销：独立进程从文件中删掉围观条目
    const edited = loadOrCreateConfig(path);
    edited.devices = edited.devices.filter((d) => d.deviceId !== viewer.device.deviceId);
    saveConfig(path, edited);

    let seenConfig = null;
    enforceDevices({
      configPath: path,
      listConnections: () => sessions,
      onConfig: (c) => { seenConfig = c; },
    });
    assert.equal(sessions[0].kicked, false, "全权设备仍在表中，不踢");
    assert.equal(sessions[1].kicked, true, "被撤销的围观连接立即断开");
    assert.equal(sessions[2].kicked, false);
    assert.equal(seenConfig.devices.length, 1, "内存配置同步为盘上最新");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforceDevices：expiresAt 到期的在线连接被踢（限时不是假的）", () => {
  const { dir, path } = tempConfig();
  try {
    const config = loadOrCreateConfig(path);
    const viewer = issueViewerToken(path, config, {
      sessionId: "thr-1",
      ttlMs: 24 * 3600_000,
    });
    const session = fakeSession(viewer.device.deviceId);

    // 未到期：不踢
    enforceDevices({ configPath: path, listConnections: () => [session] });
    assert.equal(session.kicked, false);

    // 把到期时间改到过去（模拟时间流逝）
    const edited = loadOrCreateConfig(path);
    edited.devices.find((d) => d.deviceId === viewer.device.deviceId).expiresAt = Date.now() - 1;
    saveConfig(path, edited);
    enforceDevices({ configPath: path, listConnections: () => [session] });
    assert.equal(session.kicked, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforceDevices：配置文件缺失时跳过本轮（不得重建空白配置踢光设备）", () => {
  const { dir, path } = tempConfig();
  try {
    // 文件从未创建（模拟误删/原子替换的瞬间窗口）
    const session = fakeSession("dev-1");
    let sawConfig = null;
    enforceDevices({
      configPath: path,
      listConnections: () => [session],
      onConfig: (c) => { sawConfig = c; },
    });
    assert.equal(session.kicked, false, "不能因文件缺失误踢在线设备");
    assert.equal(sawConfig, null, "不回写任何配置");
    assert.equal(existsSync(path), false, "不得顺手重建空白配置");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
