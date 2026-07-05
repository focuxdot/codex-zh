#!/usr/bin/env node
// Codex-ZH Remote daemon 入口
// 用法：
//   node remote/daemon/src/main.mjs start [--config <path>] [--relay <wss://...>] [--codex <cmd>]
//   node remote/daemon/src/main.mjs pair  [--config <path>]
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { AppServer } from "./app-server.mjs";
import { ClientSession } from "./client-session.mjs";
import {
  defaultConfigPath,
  isDeviceExpired,
  isViewerDevice,
  issuePairToken,
  loadOrCreateConfig,
  pairUrl,
  saveConfig,
} from "./config.mjs";
import { enforceDevices, watchConfig } from "./config-watch.mjs";
import { privateKeyFromPem } from "./crypto.mjs";
import { writeDesktopRefreshSignal } from "./desktop-signal.mjs";
import { Notifier, redact } from "./notify.mjs";
import { PowerManager } from "./power.mjs";
import { RelayLink } from "./relay-link.mjs";
import { SessionHub } from "./session-hub.mjs";
import { resolve as resolvePath } from "node:path";

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
  // 运行时开关：--no-prevent-sleep 覆盖为不阻止睡眠（不持久化）
  if (overrides.preventSleep === false) config.preventSleep = false;

  const appServer = new AppServer({
    command: config.codexCommand,
    port: config.appServerPort,
    log,
  });
  await appServer.start();
  log(`codex app-server 就绪: ${appServer.url}`);

  const power = new PowerManager({ log });
  const notifier = new Notifier(config.notifiers ?? [], { log });
  // 会话名缓存（通知文案用会话 name，不用 preview，避免泄露首条消息内容）
  const nameCache = new Map();
  async function sessionName(id) {
    if (!nameCache.has(id)) {
      try {
        for (const t of await appServer.listThreads(200)) nameCache.set(t.id, t.name || "");
      } catch {
        // 查询失败则用兜底名
      }
    }
    return nameCache.get(id) || "一个会话";
  }
  // 在线观众数落盘（节流）：桌面设备页是无常驻进程的 CLI，靠读此文件拿"N 人正在围观"。
  // daemon 启动时也写一次，清掉上次异常退出的残留计数。
  const viewerStatusFile = join(dirname(configPath), "viewer-status.json");
  let viewerStatusTimer = null;
  function scheduleViewerStatusWrite() {
    if (viewerStatusTimer) return;
    viewerStatusTimer = setTimeout(() => {
      viewerStatusTimer = null;
      try {
        writeFileSync(viewerStatusFile, JSON.stringify({ ts: Date.now(), byDevice: hub.viewerStats() }));
      } catch {}
    }, 1000);
    viewerStatusTimer.unref?.();
  }

  const hub = new SessionHub(appServer, {
    log,
    onAwakeChange(want) {
      if (config.preventSleep === false) return;
      want ? power.acquire() : power.release();
    },
    onViewersChange: scheduleViewerStatusWrite,
    async onEvent(type, { sessionId, clientsOnline }) {
      const name = await sessionName(sessionId);
      if (type === "turnCompleted") {
        // 通知打了补丁的桌面 Codex：这个会话被手机远程改写了，弹「刷新」横幅。
        // 独立于 webhook 通知（哪怕没配 notifier 也要发），且只在手机驱动的回合触发。
        writeDesktopRefreshSignal({ threadId: sessionId, name });
      }
      if (notifier.count === 0) return;
      // 深链：点通知直达该会话（只含页面地址 + 会话 id，不含内容）
      const link = config.webUrl
        ? `${config.webUrl.replace(/\/+$/, "/")}#s=${encodeURIComponent(sessionId)}`
        : undefined;
      if (type === "approval") {
        // 审批总是推（头号阻塞）
        await notifier.send("Codex 需要审批", `会话「${name}」有操作待你批准，请打开 Codex 远程处理`, link);
      } else if (type === "turnCompleted" && clientsOnline === 0) {
        // 任务完成仅在无设备在线时推，避免用户正在看时打扰
        await notifier.send("Codex 任务完成", `会话「${name}」已完成`, link);
      }
    },
  });
  // 引擎状态变化（崩溃自动重拉期间）推给手机端，供分层连接诊断
  appServer.onStateChange = (healthy) => hub.broadcastEngineState(healthy);
  const sessions = new Map(); // cid -> ClientSession
  const daemonContext = {
    config,
    configPath,
    privateKey: privateKeyFromPem(config.privateKeyPem),
    appServer,
    hub,
    log,
    // relay 上行水位（观众帧低优先级排空的依据）；relay 在下方初始化，运行期才会被调用
    getBufferedAmount: () => relay.bufferedAmount,
    // 按 deviceId 断开全部在线连接（share.revoke 协议路径用）。
    // 连接数百级，O(n) 扫描比维护双写索引简单且不会失同步。
    kickDevice(deviceId) {
      for (const session of sessions.values()) {
        if (session.deviceId === deviceId) session.kick();
      }
    },
    // 新建会话的目录白名单：未配置则允许任意（r0.6 安装器会写入默认白名单）
    isCwdAllowed(cwd) {
      const allow = config.allowedCwds;
      if (!Array.isArray(allow) || allow.length === 0) return true;
      const target = resolvePath(cwd);
      return allow.some((base) => {
        const b = resolvePath(base);
        return target === b || target.startsWith(`${b}/`);
      });
    },
  };

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
  scheduleViewerStatusWrite(); // 启动即写：清掉异常退出残留的观众计数

  // 撤销/过期即踢：配置文件变更（桌面撤销走独立 CLI 进程写盘）与 60s 定时器
  // （覆盖 expiresAt 到期）双路触发设备表核对。
  const enforce = () =>
    enforceDevices({
      configPath,
      listConnections: () => sessions.values(),
      onConfig: (fresh) => {
        daemonContext.config = fresh;
        // 战报对账：桌面端撤销/到期时观众可能早已离线，onKicked 踢不到人；
        // 以「配置中仍存在且未过期的 viewer」为准，孤儿统计也交出战报
        const valid = new Set(
          (fresh.devices ?? [])
            .filter((d) => isViewerDevice(d) && !isDeviceExpired(d))
            .map((d) => d.deviceId),
        );
        hub.reconcileLinks(valid);
      },
      // 围观链接被撤销/过期踢断时交出战报（幂等：首个被踢观众触发，其余空转）
      onKicked: (session) => {
        if (session.isViewer) hub.finishLink(session.deviceId);
      },
      log,
    });
  const configWatcher = watchConfig(configPath, { onChange: enforce });
  const expiryTimer = setInterval(enforce, 60_000);
  expiryTimer.unref?.();

  log(`daemon 已启动: id=${config.daemonId} name=${config.daemonName}`);

  return {
    stop() {
      configWatcher.close();
      clearInterval(expiryTimer);
      relay.stop();
      appServer.stop();
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
      power.release();
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

const NOTIFY_USAGE = `通知渠道管理：
  notify --list                       列出已配置渠道
  notify --add bark --key <key>       添加 Bark（iOS，可加 --server 自托管地址）
  notify --add serverchan --key <key> 添加 Server 酱（微信）
  notify --add wecom --url <url>      添加企业微信群机器人
  notify --add dingtalk --url <url>   添加钉钉群机器人
  notify --add custom --url <url>     添加自定义 webhook
  notify --remove <index>             删除第 N 个渠道
  notify --clear                      清空所有渠道
  notify --test                       向所有渠道发测试通知`;

async function notifyCommand(configPath, values) {
  const config = loadOrCreateConfig(configPath);
  config.notifiers = config.notifiers ?? [];

  if (values.list || (!values.add && !values.remove && !values.clear && !values.test)) {
    if (config.notifiers.length === 0) console.log("尚未配置任何通知渠道。\n");
    else config.notifiers.forEach((n, i) => console.log(`  [${i}] ${redact(n)}`));
    if (!values.list) console.log(`\n${NOTIFY_USAGE}`);
    return;
  }
  if (values.clear) {
    config.notifiers = [];
    saveConfig(configPath, config);
    console.log("已清空所有通知渠道。");
    return;
  }
  if (values.remove !== undefined) {
    const i = Number(values.remove);
    if (!Number.isInteger(i) || i < 0 || i >= config.notifiers.length) {
      console.error("index 越界。用 notify --list 查看。");
      process.exit(1);
    }
    const [removed] = config.notifiers.splice(i, 1);
    saveConfig(configPath, config);
    console.log(`已删除 ${redact(removed)}`);
    return;
  }
  if (values.add) {
    const type = values.add;
    const needKey = ["bark", "serverchan"];
    const needUrl = ["wecom", "dingtalk", "custom"];
    let entry;
    if (needKey.includes(type)) {
      if (!values.key) { console.error(`${type} 需要 --key`); process.exit(1); }
      entry = { type, key: values.key };
      if (type === "bark" && values.server) entry.server = values.server;
    } else if (needUrl.includes(type)) {
      if (!values.url) { console.error(`${type} 需要 --url`); process.exit(1); }
      entry = { type, url: values.url };
    } else {
      console.error(`未知渠道类型: ${type}\n\n${NOTIFY_USAGE}`);
      process.exit(1);
    }
    config.notifiers.push(entry);
    saveConfig(configPath, config);
    console.log(`已添加 ${redact(entry)}（当前 ${config.notifiers.length} 个渠道）`);
    return;
  }
  if (values.test) {
    const notifier = new Notifier(config.notifiers, { log: (m) => console.log(m) });
    if (notifier.count === 0) { console.error("尚未配置通知渠道。"); process.exit(1); }
    console.log(`向 ${notifier.count} 个渠道发送测试通知…`);
    await notifier.send("Codex 远程测试", "如果你收到这条，说明通知渠道配置成功 ✅");
    console.log("已发送（请检查手机是否收到）。");
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      relay: { type: "string" },
      web: { type: "string" },
      codex: { type: "string" },
      "prevent-sleep": { type: "boolean" }, // --no-prevent-sleep 关闭防睡眠
      // notify 命令选项
      list: { type: "boolean" },
      add: { type: "string" },
      key: { type: "string" },
      url: { type: "string" },
      server: { type: "string" },
      remove: { type: "string" },
      clear: { type: "boolean" },
      test: { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "start";
  const configPath = values.config ?? defaultConfigPath();

  if (command === "pair") {
    pairCommand(configPath);
    return;
  }
  if (command === "notify") {
    await notifyCommand(configPath, values);
    return;
  }
  if (command === "start") {
    const daemon = await startDaemon({
      configPath,
      overrides: {
        relayUrl: values.relay,
        webUrl: values.web,
        codexCommand: values.codex,
        preventSleep: values["prevent-sleep"], // undefined 时保持配置默认；--no-prevent-sleep => false
      },
    });
    const shutdown = () => {
      daemon.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  console.error(`未知命令: ${command}（支持 start / pair / notify）`);
  process.exit(1);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
