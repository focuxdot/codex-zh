// macOS (launchd) backend for the menu-bar Remote controller (CodexZhRemoteMenu.swift).
//
// Swift is a pure view: it shells out to this CLI for every action (argv subcommand
// in, single JSON object out). The cross-platform command surface lives in
// ../remote-backend-core.mjs; this file only supplies the macOS keepalive layer
// (launchd plist + launchctl) and wires it into the core via makeDeps.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defaultConfigPath, loadOrCreateConfig, saveConfig } from "../../remote/daemon/src/config.mjs";
import { resolveOfficialCodexHome } from "../../src/config-merge.mjs";
import { run } from "../remote-backend-core.mjs";

// 跨平台命令处理器从 core 直接透传，Swift/测试的导入契约不变
export {
  status,
  pair,
  pairOnce,
  listDevices,
  revokeDevice,
  pruneUnusedDevices,
  notifyList,
  notifyAdd,
  notifyRemove,
  notifyTest,
} from "../remote-backend-core.mjs";
export { run };

export const DAEMON_LABEL = "ai.wokey.codex-zh.remote";
export const MENU_LABEL = "ai.wokey.codex-zh.remote-menu";

// —— app 内路径解析（backend 位于 <app>/Contents/Resources/codex-zh/launcher/mac）——
export function resolveAppRoot(env = process.env, moduleUrl = import.meta.url) {
  if (env.CODEX_ZH_APP_ROOT) return env.CODEX_ZH_APP_ROOT;
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..", "..", "..", "..");
}

export function bundlePaths(appRoot) {
  // bundle 内路径按定义是 mac 路径，用 posix join 保证跨平台（如 Windows CI 跑单测）输出一致
  const contents = path.posix.join(appRoot, "Contents");
  return {
    node: path.posix.join(contents, "Resources", "cua_node", "bin", "node"),
    codexCli: path.posix.join(contents, "Resources", "codex"),
    daemonMain: path.posix.join(contents, "Resources", "codex-zh", "remote", "daemon", "src", "main.mjs"),
    menuBin: path.posix.join(contents, "Resources", "codex-zh", "bin", "CodexZhRemoteMenu"),
  };
}

// —— plist 序列化（最小子集：string/bool/array/dict）——
function plistValue(v, indent) {
  const pad = "  ".repeat(indent);
  if (typeof v === "boolean") return `${pad}<${v ? "true" : "false"}/>`;
  if (typeof v === "number") return `${pad}<integer>${v}</integer>`;
  if (Array.isArray(v)) {
    const items = v.map((x) => plistValue(x, indent + 1)).join("\n");
    return `${pad}<array>\n${items}\n${pad}</array>`;
  }
  if (v && typeof v === "object") {
    const rows = Object.entries(v)
      .map(([k, val]) => `${"  ".repeat(indent + 1)}<key>${escapeXml(k)}</key>\n${plistValue(val, indent + 1)}`)
      .join("\n");
    return `${pad}<dict>\n${rows}\n${pad}</dict>`;
  }
  return `${pad}<string>${escapeXml(String(v))}</string>`;
}
function escapeXml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
export function buildPlist(dict) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(dict, 0)}
</plist>
`;
}

export function daemonPlist({ node, daemonMain, codexHome, logPath }) {
  return buildPlist({
    Label: DAEMON_LABEL,
    ProgramArguments: [node, daemonMain, "start"],
    EnvironmentVariables: { CODEX_HOME: codexHome },
    RunAtLoad: true,
    KeepAlive: true,
    ProcessType: "Background",
    StandardOutPath: logPath,
    StandardErrorPath: logPath,
  });
}

// 注：不再为菜单程序装 LaunchAgent。菜单是「有人在电脑前」时的控制界面，
// 由 Codex-ZH 启动器在打开 app 时带正确参数拉起（见 codex-zh-launcher.mjs
// 的 spawnRemoteMenu）。常驻 LaunchAgent 既多余、又因参数缺失会 usage 死循环。

// —— makeDeps：core 依赖 + 注入 launchd 版平台钩子（isEnabled/isRunning/enable/disable）——
// deps: { configPath, launchAgentsDir, appRoot, homeDir, uid, runLaunchctl, fetch, log, now,
//         isEnabled, isRunning, enable, disable }
export function makeDeps(overrides = {}) {
  const home = overrides.homeDir || homedir();
  return {
    configPath: overrides.configPath || defaultConfigPath(),
    launchAgentsDir: overrides.launchAgentsDir || path.join(home, "Library", "LaunchAgents"),
    appRoot: overrides.appRoot || resolveAppRoot(),
    homeDir: home,
    uid: overrides.uid ?? (process.getuid ? process.getuid() : 501),
    runLaunchctl: overrides.runLaunchctl || ((args) => spawnSync("launchctl", args, { encoding: "utf8" })),
    fetch: overrides.fetch || globalThis.fetch,
    log: overrides.log || (() => {}),
    now: overrides.now || (() => Date.now()),
    // 平台钩子：core 通过 deps.isEnabled(deps) 等调用，按平台替换即整套换保活层
    isEnabled,
    isRunning,
    enable,
    disable,
    ...overrides,
  };
}

function plistPath(deps, label) {
  return path.join(deps.launchAgentsDir, `${label}.plist`);
}

export function isEnabled(deps) {
  return existsSync(plistPath(deps, DAEMON_LABEL));
}

export function isRunning(deps) {
  const res = deps.runLaunchctl(["list"]);
  return typeof res.stdout === "string" && res.stdout.includes(DAEMON_LABEL);
}

export function enable(deps) {
  const b = bundlePaths(deps.appRoot);
  const codexHome = resolveOfficialCodexHome({ ...process.env, HOME: deps.homeDir });
  const logPath = path.join(deps.homeDir, ".codex-zh", "remote", "daemon.log");
  mkdirSync(path.dirname(logPath), { recursive: true });
  mkdirSync(deps.launchAgentsDir, { recursive: true });

  // 写入 daemon 配置：codexCommand 指向 bundle 内同版本 CLI（根治版本偏差）
  const config = loadOrCreateConfig(deps.configPath);
  config.codexCommand = b.codexCli;
  saveConfig(deps.configPath, config);

  writeFileSync(plistPath(deps, DAEMON_LABEL), daemonPlist({ node: b.node, daemonMain: b.daemonMain, codexHome, logPath }));
  // 只装 daemon agent（网络暴露的部分）。菜单由启动器按需拉起，不常驻。
  deps.runLaunchctl(["bootout", `gui/${deps.uid}/${DAEMON_LABEL}`]); // 清旧实例，忽略失败
  const res = deps.runLaunchctl(["bootstrap", `gui/${deps.uid}`, plistPath(deps, DAEMON_LABEL)]);
  if (res.status !== 0 && res.stderr) deps.log(`bootstrap ${DAEMON_LABEL}: ${res.stderr.trim()}`);
  return { ok: true, enabled: true };
}

export function disable(deps) {
  // 卸 daemon agent；同时清理历史遗留的菜单 agent（旧版本曾安装过）
  for (const label of [DAEMON_LABEL, MENU_LABEL]) {
    deps.runLaunchctl(["bootout", `gui/${deps.uid}/${label}`]);
    rmSync(plistPath(deps, label), { force: true });
  }
  return { ok: true, enabled: false };
}

const isDirectRun = process.argv[1] && path.basename(process.argv[1]) === "remote-backend.mjs";
if (isDirectRun) {
  const [command, ...rest] = process.argv.slice(2);
  run(command, rest, makeDeps())
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((err) => {
      process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
}
