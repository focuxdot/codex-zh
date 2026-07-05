import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TASK_NAME,
  buildTaskXml,
  installPaths,
  makeDeps,
  isEnabled,
  isRunning,
  enable,
  disable,
  run,
} from "../launcher/win/remote-backend.mjs";
import { qrMatrix, bmpFromMatrix } from "../launcher/win/qr-bmp.mjs";
import { loadOrCreateConfig, saveConfig } from "../remote/daemon/src/config.mjs";

function harness(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "czr-be-win-"));
  const calls = [];
  const state = { taskExists: false, portOpen: false };
  const deps = makeDeps({
    configPath: join(dir, "daemon.json"),
    installRoot: "C:\\Program Files\\Codex-ZH",
    homeDir: dir,
    userId: "TESTPC\\Tester",
    runSchtasks: (args) => {
      calls.push(args);
      if (args[0] === "/Create") state.taskExists = true;
      if (args[0] === "/Delete") state.taskExists = false;
      if (args[0] === "/Query") return { status: state.taskExists ? 0 : 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    probePort: () => state.portOpen,
    ...overrides,
  });
  return { dir, deps, calls, state, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("installPaths 指向 install 内 node/codex/daemon", () => {
  const p = installPaths("C:\\Program Files\\Codex-ZH");
  assert.ok(p.node.endsWith("app\\resources\\cua_node\\bin\\node.exe"));
  assert.ok(p.codexExe.endsWith("app\\resources\\codex.exe"));
  assert.ok(p.daemonMain.endsWith("remote\\daemon\\src\\main.mjs"));
  assert.ok(p.hiddenLauncher.endsWith("launcher\\win\\run-hidden.vbs"));
  assert.equal(p.workingDir, "C:\\Program Files\\Codex-ZH");
});

test("buildTaskXml：登录触发 + 失败重启 + 无时限 + 动作＝wscript 隐藏跑 daemon", () => {
  const xml = buildTaskXml({
    node: "C:\\a b\\node.exe",
    daemonMain: "C:\\a b\\main.mjs",
    workingDir: "C:\\a b",
    userId: "PC\\User",
    vbs: "C:\\a b\\run-hidden.vbs",
  });
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<UserId>PC\\User<\/UserId>/);
  assert.match(xml, /<RestartOnFailure>[\s\S]*<Interval>PT1M<\/Interval>[\s\S]*<Count>999<\/Count>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  // 动作＝无窗口 wscript 承载 vbs，参数带 vbs/node/main
  assert.match(xml, /<Command>wscript\.exe<\/Command>/);
  assert.match(xml, /<Arguments>"C:\\a b\\run-hidden\.vbs" "C:\\a b\\node\.exe" "C:\\a b\\main\.mjs" "C:\\a b"<\/Arguments>/);
});

test("enable：钉 codexCommand、写 UTF-16 BOM 的任务 XML、Create 后 Run", () => {
  const h = harness();
  try {
    const res = enable(h.deps);
    assert.equal(res.enabled, true);
    // codexCommand 钉到 install 内 codex.exe
    const config = loadOrCreateConfig(h.deps.configPath);
    assert.ok(config.codexCommand.endsWith("app\\resources\\codex.exe"));
    // 任务 XML 与 daemon.json 同目录，且是 UTF-16LE BOM
    const xmlAt = join(h.dir, "remote-task.xml");
    assert.ok(existsSync(xmlAt), "task xml 应写在 config 同目录");
    const bytes = readFileSync(xmlAt);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xfe); // UTF-16LE BOM
    // 调用顺序：Create 再 Run
    const kinds = h.calls.map((c) => c[0]);
    assert.ok(kinds.includes("/Create"));
    assert.ok(kinds.includes("/Run"));
    assert.ok(kinds.indexOf("/Create") < kinds.indexOf("/Run"));
    const create = h.calls.find((c) => c[0] === "/Create");
    assert.ok(create.includes("/TN") && create.includes(TASK_NAME) && create.includes("/XML") && create.includes("/F"));
  } finally {
    h.cleanup();
  }
});

test("disable：End 再 Delete /F", () => {
  const h = harness();
  try {
    enable(h.deps);
    const res = disable(h.deps);
    assert.equal(res.enabled, false);
    const kinds = h.calls.map((c) => c[0]);
    assert.ok(kinds.includes("/End"));
    assert.ok(kinds.includes("/Delete"));
    const del = h.calls.find((c) => c[0] === "/Delete");
    assert.ok(del.includes(TASK_NAME) && del.includes("/F"));
  } finally {
    h.cleanup();
  }
});

test("isEnabled 跟随任务存在；isRunning 跟随端口探测", () => {
  const h = harness();
  try {
    assert.equal(isEnabled(h.deps), false);
    assert.equal(isRunning(h.deps), false);
    enable(h.deps);
    assert.equal(isEnabled(h.deps), true); // Create 后 Query 命中
    h.state.portOpen = true;
    assert.equal(isRunning(h.deps), true);
    disable(h.deps);
    assert.equal(isEnabled(h.deps), false);
  } finally {
    h.cleanup();
  }
});

test("run pair：走 core 并附二维码 BMP 路径", async () => {
  const h = harness();
  try {
    const config = loadOrCreateConfig(h.deps.configPath);
    config.relayUrl = "wss://relay.wokey.ai";
    config.webUrl = "https://example/remote/";
    saveConfig(h.deps.configPath, config);

    const r = await run("pair", [], h.deps);
    assert.match(r.url, /#d=/);
    assert.ok(r.qrPath && existsSync(r.qrPath), "应生成二维码 BMP");
    const bmp = readFileSync(r.qrPath);
    assert.equal(bmp.toString("ascii", 0, 2), "BM"); // BMP 魔数
    rmSync(r.qrPath, { force: true });
  } finally {
    h.cleanup();
  }
});

test("QR BMP 编码：长 URL 自动选版本，产出合法 BMP 头与方形尺寸", () => {
  const url = "https://focuxdot.github.io/codex-zh/remote/#d=" + "A".repeat(220);
  const m = qrMatrix(url, "M");
  assert.ok(m.length >= 33, "长 URL 应选较高版本"); // n 随数据增大
  const bmp = bmpFromMatrix(m, { quiet: 4, targetPx: 480 });
  assert.equal(bmp.toString("ascii", 0, 2), "BM");
  const width = bmp.readInt32LE(18);
  const height = bmp.readInt32LE(22);
  assert.equal(width, height); // 正方形
  assert.equal(bmp.readUInt16LE(28), 24); // 24-bit
});
