#!/usr/bin/env node
// Codex-ZH Remote daemon 入口
// 用法：
//   node remote/daemon/src/main.mjs start [--config <path>] [--relay <wss://...>] [--codex <cmd>]
//   node remote/daemon/src/main.mjs pair  [--config <path>]
import { parseArgs } from "node:util";

import { AppServer } from "./app-server.mjs";
import { ClientSession } from "./client-session.mjs";
import {
  defaultConfigPath,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
  saveConfig,
} from "./config.mjs";
import { privateKeyFromPem } from "./crypto.mjs";
import { RelayLink } from "./relay-link.mjs";

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

export async function startDaemon({ configPath, overrides = {} }) {
  const config = loadOrCreateConfig(configPath);
  let changed = false;
  for (const key of ["relayUrl", "webUrl", "codexCommand"]) {
    if (overrides[key] && overrides[key] !== config[key]) {
      config[key] = overrides[key];
      changed = true;
    }
  }
  if (changed) saveConfig(configPath, config);
  if (!config.relayUrl) {
    throw new Error("未配置 relay 地址：用 --relay wss://... 指定（会持久化到配置文件）");
  }

  const appServer = new AppServer({
    command: config.codexCommand,
    port: config.appServerPort,
    log,
  });
  await appServer.start();
  log(`codex app-server 就绪: ${appServer.url}`);

  const daemonContext = {
    config,
    configPath,
    privateKey: privateKeyFromPem(config.privateKeyPem),
    appServer,
    log,
  };

  const sessions = new Map(); // cid -> ClientSession
  const relay = new RelayLink(config.relayUrl, config.daemonId, {
    log,
    onOpen(cid) {
      sessions.get(cid)?.dispose(); // relay 重连补发 open 时清掉旧会话状态
      sessions.set(
        cid,
        new ClientSession(cid, daemonContext, {
          send: (data) => relay.send(cid, data),
          close: () => {
            relay.closeClient(cid);
            sessions.get(cid)?.dispose();
            sessions.delete(cid);
          },
        }),
      );
      log(`client 接入: ${cid}（当前 ${sessions.size} 个连接）`);
    },
    onMessage(cid, data) {
      sessions.get(cid)?.onEnvelope(data);
    },
    onClose(cid) {
      sessions.get(cid)?.dispose();
      sessions.delete(cid);
      log(`client 断开: ${cid}`);
    },
  });
  relay.start();
  log(`daemon 已启动: id=${config.daemonId} name=${config.daemonName}`);

  return {
    stop() {
      relay.stop();
      appServer.stop();
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
    },
  };
}

function pairCommand(configPath) {
  const config = loadOrCreateConfig(configPath);
  if (!config.relayUrl) {
    console.error("请先用 start --relay 配置 relay 地址，再生成配对码。");
    process.exit(1);
  }
  const token = issuePairToken(configPath, config);
  console.log("配对链接（5 分钟内有效，仅可用一次）：\n");
  console.log(`  ${pairUrl(config, token)}\n`);
  console.log("在手机浏览器中打开该链接完成配对。");
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      relay: { type: "string" },
      web: { type: "string" },
      codex: { type: "string" },
    },
  });
  const command = positionals[0] ?? "start";
  const configPath = values.config ?? defaultConfigPath();

  if (command === "pair") {
    pairCommand(configPath);
    return;
  }
  if (command === "start") {
    const daemon = await startDaemon({
      configPath,
      overrides: { relayUrl: values.relay, webUrl: values.web, codexCommand: values.codex },
    });
    const shutdown = () => {
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  console.error(`未知命令: ${command}（支持 start / pair）`);
  process.exit(1);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
