// Cross-platform core for the Remote controller backend.
//
// The macOS (launchd) and Windows (Scheduled Task) backends both wrap this core:
// they build a `deps` object — via their own makeDeps — that carries the config
// path, a fetch/log, and the four platform hooks the core dispatches to:
//   deps.isEnabled(deps) / deps.isRunning(deps) / deps.enable(deps) / deps.disable(deps)
// Everything else here (token issuance, device list, notifier CRUD) is pure and
// reuses remote/daemon/src/* — never duplicated per platform.
//
// Protocol (identical on every platform): argv subcommand in → single JSON object out.
//   status        -> { enabled, running, deviceCount, notifierCount, relay }
//   enable        -> { ok, enabled }            (platform hook)
//   disable       -> { ok, enabled }            (platform hook)
//   pair          -> { url }                    (#d= permanent device link)
//   pair-once     -> { url }                    (#p= one-time link, 5-min TTL)
//   devices       -> { devices:[{deviceId,name,createdAt,lastSeenAt, …viewer fields}] }
//   revoke <id>   -> { ok }
//   prune-unused  -> { ok, removed }
//   notify-list   -> { notifiers:[{index,label}] }
//   notify-add <inputFile>  -> { ok, count }    (input {type,key?|url?,server?} via temp file)
//   notify-remove <index>   -> { ok }
//   notify-test             -> { ok, count }
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  deviceUrl,
  issueDeviceToken,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
  saveConfig,
} from "../remote/daemon/src/config.mjs";
import { Notifier, redact } from "../remote/daemon/src/notify.mjs";

export function status(deps) {
  const config = existsSync(deps.configPath) ? loadOrCreateConfig(deps.configPath) : null;
  return {
    enabled: deps.isEnabled(deps),
    running: deps.isRunning(deps),
    deviceCount: config?.devices?.length ?? 0,
    notifierCount: config?.notifiers?.length ?? 0,
    relay: config?.relayUrl ?? "",
  };
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
  if (!deps.isRunning(deps)) return {};
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

// —— CLI 分发 —— enable/disable 走平台钩子（launchd / 计划任务），其余纯逻辑
export async function run(command, rest, deps) {
  switch (command) {
    case "status": return status(deps);
    case "enable": return deps.enable(deps);
    case "disable": return deps.disable(deps);
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
