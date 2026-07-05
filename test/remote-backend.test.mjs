import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DAEMON_LABEL,
  MENU_LABEL,
  buildPlist,
  daemonPlist,
  bundlePaths,
  makeDeps,
  status,
  enable,
  disable,
  pair,
  pairOnce,
  listDevices,
  revokeDevice,
  pruneUnusedDevices,
  notifyAdd,
  notifyList,
  notifyRemove,
} from "../launcher/mac/remote-backend.mjs";
void MENU_LABEL;
import { loadOrCreateConfig, saveConfig } from "../remote/daemon/src/config.mjs";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "czr-be-"));
  const calls = [];
  const deps = makeDeps({
    configPath: join(dir, "daemon.json"),
    launchAgentsDir: join(dir, "LaunchAgents"),
    appRoot: "/Applications/Codex-叉叉.app",
    homeDir: dir,
    uid: 501,
    runLaunchctl: (args) => {
      calls.push(args);
      // 模拟 `launchctl list` 在 enable 后能看到 daemon
      if (args[0] === "list") {
        return { status: 0, stdout: deps.__running ? `123 0 ${DAEMON_LABEL}\n` : "", stderr: "" };
      }
      if (args[0] === "bootstrap") deps.__running = true;
      if (args[0] === "bootout") deps.__running = false;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  return { dir, deps, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("buildPlist 生成合法结构（string/bool/array/dict/integer）", () => {
  const xml = buildPlist({ Label: "x", ProgramArguments: ["a", "b"], RunAtLoad: true, N: 3 });
  assert.match(xml, /<key>Label<\/key>\s*<string>x<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key>\s*<array>/);
  assert.match(xml, /<true\/>/);
  assert.match(xml, /<integer>3<\/integer>/);
  assert.match(xml, /^<\?xml/);
});

test("bundlePaths 指向 bundle 内 node/codex/daemon", () => {
  const b = bundlePaths("/Applications/Codex-叉叉.app");
  assert.equal(b.node, "/Applications/Codex-叉叉.app/Contents/Resources/cua_node/bin/node");
  assert.equal(b.codexCli, "/Applications/Codex-叉叉.app/Contents/Resources/codex");
  assert.ok(b.daemonMain.endsWith("codex-zh/remote/daemon/src/main.mjs"));
  assert.ok(b.menuBin.endsWith("codex-zh/bin/CodexZhRemoteMenu"));
});

test("daemonPlist 含 CODEX_HOME 与 start 参数", () => {
  const xml = daemonPlist({ node: "/n", daemonMain: "/m.mjs", codexHome: "/Users/x/.codex", logPath: "/l.log" });
  assert.match(xml, /CODEX_HOME/);
  assert.match(xml, /\/Users\/x\/\.codex/);
  assert.match(xml, /<string>start<\/string>/);
  assert.match(xml, new RegExp(DAEMON_LABEL));
});

test("enable 只装 daemon plist、设置 codexCommand、bootstrap 一次", () => {
  const h = harness();
  try {
    const res = enable(h.deps);
    assert.equal(res.enabled, true);
    // 只 daemon plist 落盘；不再装菜单 agent
    assert.ok(existsSync(join(h.dir, "LaunchAgents", `${DAEMON_LABEL}.plist`)));
    assert.ok(!existsSync(join(h.dir, "LaunchAgents", `${MENU_LABEL}.plist`)), "不应再装菜单 agent");
    // codexCommand 指向 bundle 内 CLI（根治版本偏差）
    const config = loadOrCreateConfig(h.deps.configPath);
    assert.equal(config.codexCommand, "/Applications/Codex-叉叉.app/Contents/Resources/codex");
    // 只 bootstrap daemon
    const bootstraps = h.calls.filter((c) => c[0] === "bootstrap");
    assert.equal(bootstraps.length, 1);
    assert.ok(bootstraps[0].join(" ").includes(DAEMON_LABEL));
  } finally {
    h.cleanup();
  }
});

test("status 反映启用/运行/设备数", () => {
  const h = harness();
  try {
    assert.deepEqual(
      { enabled: status(h.deps).enabled, running: status(h.deps).running },
      { enabled: false, running: false },
    );
    enable(h.deps);
    const s = status(h.deps);
    assert.equal(s.enabled, true);
    assert.equal(s.running, true);
  } finally {
    h.cleanup();
  }
});

test("disable bootout 两次并删 plist", () => {
  const h = harness();
  try {
    enable(h.deps);
    const res = disable(h.deps);
    assert.equal(res.enabled, false);
    assert.ok(!existsSync(join(h.dir, "LaunchAgents", `${DAEMON_LABEL}.plist`)));
    assert.ok(!existsSync(join(h.dir, "LaunchAgents", `${MENU_LABEL}.plist`)));
    assert.equal(status(h.deps).enabled, false);
  } finally {
    h.cleanup();
  }
});

test("pair 返回永久 #d= URL；pair-once 返回一次性 #p= URL", () => {
  const h = harness();
  try {
    const config = loadOrCreateConfig(h.deps.configPath);
    config.relayUrl = "wss://relay.wokey.ai";
    config.webUrl = "https://example/remote/";
    saveConfig(h.deps.configPath, config);

    const perm = pair(h.deps);
    assert.match(perm.url, /#d=/);
    assert.match(perm.url, /^https:\/\/example\/remote\//);
    // 永久链接对应一个已入库、可撤销的设备条目
    assert.equal(listDevices(h.deps).devices.length, 1);

    const once = pairOnce(h.deps);
    assert.match(once.url, /#p=/);
    assert.match(once.url, /^https:\/\/example\/remote\//);
  } finally {
    h.cleanup();
  }
});

test("devices 列表与 revoke", () => {
  const h = harness();
  try {
    const config = loadOrCreateConfig(h.deps.configPath);
    config.devices = [
      { deviceId: "d1", name: "iPhone", tokenHash: "x", createdAt: 1, lastSeenAt: 2 },
      { deviceId: "d2", name: "", tokenHash: "y", createdAt: 3, lastSeenAt: 4 },
    ];
    saveConfig(h.deps.configPath, config);
    assert.equal(listDevices(h.deps).devices.length, 2);
    // 列表不泄露 tokenHash
    assert.equal(JSON.stringify(listDevices(h.deps)).includes("tokenHash"), false);
    assert.equal(revokeDevice(h.deps, "d1").ok, true);
    assert.equal(listDevices(h.deps).devices.length, 1);
    assert.equal(revokeDevice(h.deps, "nope").ok, false);
  } finally {
    h.cleanup();
  }
});

test("prune-unused 只删从未连接（lastSeenAt 空）的设备", () => {
  const h = harness();
  try {
    const config = loadOrCreateConfig(h.deps.configPath);
    config.devices = [
      { deviceId: "used", tokenHash: "a", createdAt: 1, lastSeenAt: 2 },      // 连过 → 保留
      { deviceId: "orphan1", tokenHash: "b", createdAt: 3, lastSeenAt: null }, // 从未连 → 删
      { deviceId: "orphan2", tokenHash: "c", createdAt: 4 },                   // 无 lastSeenAt → 删
    ];
    saveConfig(h.deps.configPath, config);
    const res = pruneUnusedDevices(h.deps);
    assert.equal(res.ok, true);
    assert.equal(res.removed, 2);
    const left = listDevices(h.deps).devices;
    assert.equal(left.length, 1);
    assert.equal(left[0].deviceId, "used");
    // 再次清理无可删 → removed 0
    assert.equal(pruneUnusedDevices(h.deps).removed, 0);
  } finally {
    h.cleanup();
  }
});

test("围观条目：devices 透传扩展字段与在线观众数；prune 不删围观链接", () => {
  const h = harness();
  try {
    const config = loadOrCreateConfig(h.deps.configPath);
    config.devices = [
      { deviceId: "full1", name: "iPhone", tokenHash: "a", createdAt: 1, lastSeenAt: 2 },
      // 生成后从未有人点开的永久围观链接（作品集场景的合法状态）
      { deviceId: "v1", name: "围观链接 · 重构支付", tokenHash: "b", createdAt: 3, lastSeenAt: null,
        role: "viewer", scope: { sessionId: "thr-1" }, sessionName: "重构支付",
        expiresAt: null, muted: false, url: "https://example/remote/#d=xxx" },
    ];
    saveConfig(h.deps.configPath, config);

    // daemon 落盘的在线观众数（daemon 运行中才作数）
    writeFileSync(
      join(h.dir, "viewer-status.json"),
      JSON.stringify({ ts: Date.now(), byDevice: { v1: 3 } }),
    );

    // daemon 未运行：观众数视为 0
    let viewer = listDevices(h.deps).devices.find((d) => d.deviceId === "v1");
    assert.equal(viewer.role, "viewer");
    assert.equal(viewer.sessionName, "重构支付");
    assert.equal(viewer.expiresAt, null);
    assert.equal(viewer.url.includes("#d="), true);
    assert.equal(viewer.viewers, 0);
    // 全权条目不带围观字段
    const full = listDevices(h.deps).devices.find((d) => d.deviceId === "full1");
    assert.equal("role" in full, false);

    // daemon 运行中：合并 viewer-status 的计数
    h.deps.__running = true;
    viewer = listDevices(h.deps).devices.find((d) => d.deviceId === "v1");
    assert.equal(viewer.viewers, 3);

    // prune：围观链接虽从未被点开也不删（静默 prune 等于暗杀分享链接）
    const res = pruneUnusedDevices(h.deps);
    assert.equal(res.removed, 0);
    assert.equal(listDevices(h.deps).devices.length, 2);
  } finally {
    h.cleanup();
  }
});

test("notify 增删列，label 脱敏", () => {
  const h = harness();
  try {
    notifyAdd(h.deps, { type: "bark", key: "ABCDEFGH" });
    notifyAdd(h.deps, { type: "wecom", url: "https://qyapi.weixin.qq.com/x?key=secret" });
    const list = notifyList(h.deps).notifiers;
    assert.equal(list.length, 2);
    assert.equal(list[0].label, "bark:ABCD…");
    assert.equal(JSON.stringify(list).includes("secret"), false);
    assert.equal(notifyRemove(h.deps, 0).ok, true);
    assert.equal(notifyList(h.deps).notifiers.length, 1);
    assert.equal(notifyRemove(h.deps, 9).ok, false);
  } finally {
    h.cleanup();
  }
});

test("relay-node 对 daemon 与 client 都应答 hb（手机端前台活性探测依赖）", async () => {
  const { createRelayServer } = await import("../remote/relay-node/server.mjs");
  const server = createRelayServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port;
  try {
    for (const role of ["daemon", "client"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/${role}/testdaemon1`);
      await new Promise((ok, bad) => {
        ws.onopen = ok;
        ws.onerror = () => bad(new Error(`${role} 连接失败`));
      });
      const pong = new Promise((ok, bad) => {
        const timer = setTimeout(() => bad(new Error(`${role} 的 hb 无应答`)), 3000);
        ws.onmessage = (e) => {
          const frame = JSON.parse(e.data);
          if (frame.t === "hb") { clearTimeout(timer); ok(); } // client 首帧是 status，跳过
        };
      });
      ws.send('{"t":"hb"}');
      await pong;
      ws.close();
    }
  } finally {
    server.close();
  }
});
