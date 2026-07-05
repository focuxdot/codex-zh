// Node backend for the macOS menu-bar Remote controller (CodexZhRemoteMenu.swift).
//
// Swift is a pure view: it shells out to this CLI for every action. Same protocol
// as wizard-backend.mjs — argv subcommand in, single JSON object out.
//
// Subcommands:
//   status                       -> { enabled, running, deviceCount, notifierCount, relay }
//   enable                       -> { ok, enabled } —— 装/加载 daemon+menu LaunchAgent
//   disable                      -> { ok, enabled } —— bootout + 移除 plist
//   pair                         -> { url } —— 签发永久设备令牌，返回 #d= URL 供 Swift 渲染 QR
//   pair-once                    -> { url } —— 签发一次性配对令牌（5 分钟），返回 #p= URL
//   devices                      -> { devices:[{deviceId,name,createdAt,lastSeenAt}] }
//   revoke   <deviceId>          -> { ok }
//   prune-unused                 -> { ok, removed } —— 删除所有从未连接的设备（作废悬空/外泄链接）
//   notify-list                  -> { notifiers:[{index,label}] }
//   notify-add  <inputFile>      -> { ok } （输入 {type,key?|url?,server?}，走临时文件）
//   notify-remove <index>        -> { ok }
//   notify-test                  -> { ok, count }
//
// 所有 daemon 逻辑复用 remote/daemon/src/*，绝不在此重复。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  defaultConfigPath,
  deviceUrl,
  issueDeviceToken,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
  saveConfig,
} from "../../remote/daemon/src/config.mjs";
import { Notifier, redact } from "../../remote/daemon/src/notify.mjs";
import { resolveOfficialCodexHome } from "../../src/config-merge.mjs";

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

// —— 核心逻辑（deps 可注入以便测试）——
// deps: { configPath, launchAgentsDir, appRoot, homeDir, uid, runLaunchctl, fetch, log, now }
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

export function status(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : null;
  return {
    enabled: isEnabled(deps),
    running: isRunning(deps),
    deviceCount: config?.devices?.length ?? 0,
    notifierCount: config?.notifiers?.length ?? 0,
    relay: config?.relayUrl ?? "",
  };
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

// 永久链接：内嵌长期设备令牌，扫码/点击即永久连接（可在「已配对设备」撤销）
export function pair(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  if (!config.relayUrl) return { error: "未配置 relay" };
  const { deviceToken } = issueDeviceToken(deps.configPath, config);
  return { url: deviceUrl(loadOrCreateConfig(deps.configPath), deviceToken) };
}

// 一次性链接：5 分钟内有效、仅可用一次（适合临时发出去的场景）
export function pairOnce(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  if (!config.relayUrl) return { error: "未配置 relay" };
  const token = issuePairToken(deps.configPath, config);
  return { url: pairUrl(loadOrCreateConfig(deps.configPath), token) };
}

// 在线观众数：daemon 在观众上下线时把按 deviceId 聚合的计数节流写入 viewer-status.json
//（本 CLI 无常驻进程，这是唯一不引协议通道的取数路径）。daemon 没在跑则视为无人围观。
function readViewerStatus(deps) {
  if (!isRunning(deps)) return {};
  try {
    const p = path.join(path.dirname(deps.configPath), "viewer-status.json");
    return JSON.parse(readFileSync(p, "utf8"))?.byDevice ?? {};
  } catch {
    return {};
  }
}

export function listDevices(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { devices: [] };
  const viewers = readViewerStatus(deps);
  return {
    devices: (config.devices ?? []).map((d) => ({
      deviceId: d.deviceId, name: d.name || "", createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
      // 围观链接扩展字段（全权设备缺省）：桌面设备页渲染只读徽标/会话名/时效/观众数
      ...(d.role === "viewer"
        ? {
            role: "viewer",
            sessionName: d.sessionName ?? "",
            expiresAt: d.expiresAt ?? null,
            muted: d.muted === true,
            url: d.url ?? null,
            viewers: viewers[d.deviceId] ?? 0,
          }
        : {}),
    })),
  };
}

export function revokeDevice(deps, deviceId) {
  const config = loadOrCreateConfig(deps.configPath);
  const before = (config.devices ?? []).length;
  config.devices = (config.devices ?? []).filter((d) => d.deviceId !== deviceId);
  saveConfig(deps.configPath, config);
  return { ok: config.devices.length < before };
}

// 清理"从未连接"的设备（lastSeenAt 空）——即生成过但没人扫过的链接。移除它们等于
// 作废这些悬空令牌：以前若有外泄/转发但没被使用的链接会随即失效（撤销即时生效，
// 因 daemon 每次鉴权重读配置）。不影响任何已连过的设备。
// 围观链接除外：作品集永久链接"生成后长期无人点开"是合法状态，静默 prune 等于暗杀分享链接。
export function pruneUnusedDevices(deps) {
  const config = loadOrCreateConfig(deps.configPath);
  const before = (config.devices ?? []).length;
  config.devices = (config.devices ?? []).filter((d) => d.lastSeenAt || d.role === "viewer");
  const removed = before - config.devices.length;
  saveConfig(deps.configPath, config);
  return { ok: true, removed };
}

export function notifyList(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { notifiers: [] };
  return { notifiers: (config.notifiers ?? []).map((n, index) => ({ index, label: redact(n) })) };
}

export function notifyAdd(deps, entry) {
  const config = loadOrCreateConfig(deps.configPath);
  config.notifiers = config.notifiers ?? [];
  config.notifiers.push(entry);
  saveConfig(deps.configPath, config);
  return { ok: true, count: config.notifiers.length };
}

export function notifyRemove(deps, index) {
  const config = loadOrCreateConfig(deps.configPath);
  config.notifiers = config.notifiers ?? [];
  if (index < 0 || index >= config.notifiers.length) return { ok: false };
  config.notifiers.splice(index, 1);
  saveConfig(deps.configPath, config);
  return { ok: true };
}

export async function notifyTest(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : { notifiers: [] };
  const notifier = new Notifier(config.notifiers ?? [], { fetch: deps.fetch, log: deps.log });
  await notifier.send("Codex 远程测试", "如果你收到这条，说明通知渠道配置成功 ✅");
  return { ok: true, count: notifier.count };
}

// —— CLI 分发 ——
export async function run(command, rest, deps = makeDeps()) {
  switch (command) {
    case "status": return status(deps);
    case "enable": return enable(deps);
    case "disable": return disable(deps);
    case "pair": return pair(deps);
    case "pair-once": return pairOnce(deps);
    case "devices": return listDevices(deps);
    case "revoke": return revokeDevice(deps, rest[0]);
    case "prune-unused": return pruneUnusedDevices(deps);
    case "notify-list": return notifyList(deps);
    case "notify-add": return notifyAdd(deps, JSON.parse(readFileSync(rest[0], "utf8")));
    case "notify-remove": return notifyRemove(deps, Number(rest[0]));
    case "notify-test": return notifyTest(deps);
    default: return { error: `未知子命令: ${command}` };
  }
}

const isDirectRun = process.argv[1] && path.basename(process.argv[1]) === "remote-backend.mjs";
if (isDirectRun) {
  const [command, ...rest] = process.argv.slice(2);
  run(command, rest)
    .then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((err) => {
      process.stdout.write(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
}
