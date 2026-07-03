// daemon 配置与状态：~/.codex-zh/remote/daemon.json
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { generateKeyPair, randomId, randomToken } from "./crypto.mjs";

export const PAIR_TOKEN_TTL_MS = 5 * 60 * 1000;

export function defaultConfigPath() {
  return join(homedir(), ".codex-zh", "remote", "daemon.json");
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function loadOrCreateConfig(path = defaultConfigPath()) {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const keys = generateKeyPair();
  const config = {
    v: 1,
    daemonId: randomId(),
    daemonName: hostname(),
    publicKey: keys.publicKeyRaw.toString("base64"),
    privateKeyPem: keys.privateKeyPem,
    relayUrl: "wss://relay.wokey.ai", // 官方 relay；可用 start --relay 覆盖为自建实例
    webUrl: "https://focuxdot.github.io/codex-zh/remote/", // 配对链接指向的手机端页面

    codexCommand: "codex",
    appServerPort: 19271,
    preventSleep: true, // 有设备在线或任务运行时阻止系统睡眠（允许关屏）
    notifiers: [], // webhook 通知渠道 [{type:"bark",key} | {type:"wecom",url} ...]
    devices: [],
    pairTokens: [],
  };
  saveConfig(path, config);
  return config;
}

export function saveConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// 生成一次性配对令牌（只存哈希），返回明文
export function issuePairToken(path, config) {
  const token = randomToken();
  const now = Date.now();
  config.pairTokens = (config.pairTokens ?? []).filter((t) => t.expiresAt > now);
  config.pairTokens.push({ hash: sha256(token), expiresAt: now + PAIR_TOKEN_TTL_MS });
  saveConfig(path, config);
  return token;
}

// 校验并消费配对令牌；daemon 进程在每次配对尝试时重读配置，
// 使 `pair` 命令在独立进程中签发的令牌立即生效。
export function consumePairToken(path, token) {
  const config = loadOrCreateConfig(path);
  const now = Date.now();
  const hash = sha256(token);
  const found = (config.pairTokens ?? []).find((t) => t.hash === hash && t.expiresAt > now);
  if (!found) return null;
  config.pairTokens = config.pairTokens.filter((t) => t !== found && t.expiresAt > now);
  const device = {
    deviceId: randomId(8),
    tokenHash: null,
    name: "",
    createdAt: now,
    lastSeenAt: now,
  };
  const deviceToken = randomToken();
  device.tokenHash = sha256(deviceToken);
  config.devices.push(device);
  saveConfig(path, config);
  return { config, device, deviceToken };
}

export function findDeviceByToken(config, deviceToken) {
  const hash = sha256(deviceToken);
  return (config.devices ?? []).find((d) => d.tokenHash === hash) ?? null;
}

export function buildPairPayload(config, pairToken) {
  return {
    v: 1,
    relay: config.relayUrl,
    id: config.daemonId,
    pk: config.publicKey,
    name: config.daemonName,
    tok: pairToken,
  };
}

export function pairUrl(config, pairToken) {
  const payload = Buffer.from(JSON.stringify(buildPairPayload(config, pairToken))).toString(
    "base64url",
  );
  const base = config.webUrl || "https://example.invalid/remote";
  return `${base}#p=${payload}`;
}
