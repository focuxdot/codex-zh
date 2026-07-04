#!/usr/bin/env node
// 浏览器端 e2e 后端：本地拉起 relay-node + daemon（真实 codex app-server）+ 手机页静态服务，
// 输出一行 JSON（含配对 URL）后常驻，退出时清理临时配置。
// 用途：
//   1. Playwright 全链路自检（配对→加密→hb 活性→僵尸重建→断线重连）
//   2. 单独运行后用浏览器打开 url，即可在本机调试手机页（127.0.0.1 是安全上下文）
// 用法：node remote/scripts/web-e2e-backend.mjs [--codex <cmd>]
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";

import { createRelayServer } from "../relay-node/server.mjs";
import {
  buildPairPayload,
  issuePairToken,
  loadOrCreateConfig,
  saveConfig,
} from "../daemon/src/config.mjs";
import { startDaemon } from "../daemon/src/main.mjs";

const { values } = parseArgs({ options: { codex: { type: "string" } } });

const relay = createRelayServer();
relay.listen(0, "127.0.0.1");
await once(relay, "listening");
const relayUrl = `ws://127.0.0.1:${relay.address().port}`;

const dir = mkdtempSync(join(tmpdir(), "czr-web-e2e-"));
const configPath = join(dir, "daemon.json");
const config = loadOrCreateConfig(configPath);
config.relayUrl = relayUrl;
config.appServerPort = 20000 + Math.floor(Math.random() * 20000);
if (values.codex) config.codexCommand = values.codex;
saveConfig(configPath, config);
const daemon = await startDaemon({ configPath });
const pairToken = issuePairToken(configPath, loadOrCreateConfig(configPath));

const webRoot = new URL("../web/", import.meta.url).pathname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
const web = createServer((req, res) => {
  const path = normalize(new URL(req.url, "http://x").pathname).replace(/^[/\\]+/, "") || "index.html";
  try {
    const body = readFileSync(join(webRoot, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
web.listen(0, "127.0.0.1");
await once(web, "listening");

const payload = Buffer.from(
  JSON.stringify(buildPairPayload(loadOrCreateConfig(configPath), pairToken)),
).toString("base64url");
console.log(
  JSON.stringify({ url: `http://127.0.0.1:${web.address().port}/index.html#p=${payload}` }),
);

function shutdown() {
  daemon.stop();
  relay.close();
  web.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
process.stdin.resume();
