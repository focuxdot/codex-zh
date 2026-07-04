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
  listDevices,
  revokeDevice,
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
    appRoot: "/Applications/Codex-ZH.app",
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
  const b = bundlePaths("/Applications/Codex-ZH.app");
  assert.equal(b.node, "/Applications/Codex-ZH.app/Contents/Resources/cua_node/bin/node");
  assert.equal(b.codexCli, "/Applications/Codex-ZH.app/Contents/Resources/codex");
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
    assert.equal(config.codexCommand, "/Applications/Codex-ZH.app/Contents/Resources/codex");
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

test("pair 返回配对 URL", () => {
  const h = harness();
  try {
    const config = loadOrCreateConfig(h.deps.configPath);
    config.relayUrl = "wss://relay.wokey.ai";
    config.webUrl = "https://example/remote/";
    saveConfig(h.deps.configPath, config);
    const res = pair(h.deps);
    assert.match(res.url, /#p=/);
    assert.match(res.url, /^https:\/\/example\/remote\//);
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
