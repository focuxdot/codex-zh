// 单个远端设备连接的 E2E 会话：握手 -> 鉴权 -> 方法路由（见 PROTOCOL.md §2/§3）
import { statSync } from "node:fs";

import {
  APP_PROTOCOL,
  consumePairToken,
  findDeviceByToken,
  loadOrCreateConfig,
  saveConfig,
} from "./config.mjs";
import { deriveSessionKey, open as sealedOpen, seal } from "./crypto.mjs";
import { RolloutTail } from "./rollout-tail.mjs";

export class ClientSession {
  #cid;
  #daemon; // { config, configPath, privateKey, appServer, hub, log }
  #send; // (data) => void  发送 E2E 信封给该 client
  #close; // () => void     要求 relay 断开该 client
  #key = null;
  #device = null;
  #tail = null;
  #watchedThreadId = null;

  constructor(cid, daemon, { send, close }) {
    this.#cid = cid;
    this.#daemon = daemon;
    this.#send = send;
    this.#close = close;
  }

  // 收到该 client 的一帧信封
  async onEnvelope(envelope) {
    try {
      if (!this.#key) {
        if (envelope.v !== 1 || typeof envelope.k !== "string") {
          this.#close();
          return;
        }
        this.#key = deriveSessionKey(
          this.#daemon.privateKey,
          Buffer.from(envelope.k, "base64"),
          this.#daemon.config.daemonId,
        );
      }
      const message = sealedOpen(this.#key, "c2d", envelope);
      await this.#onMessage(message);
    } catch (err) {
      // 解密失败 = 非法对端，直接断开
      this.#daemon.log(`client ${this.#cid} 消息处理失败: ${err.message}`);
      this.#close();
    }
  }

  async #onMessage(message) {
    if (!this.#device) {
      if (message.method !== "auth") {
        this.#reply(message.id, null, { code: 401, message: "未鉴权" });
        this.#close();
        return;
      }
      await this.#auth(message);
      return;
    }
    switch (message.method) {
      case "ping":
        this.#notify("pong", {});
        return;
      case "sessions.list": {
        const sessions = await this.#daemon.appServer.listThreads(message.params?.limit ?? 50);
        const hub = this.#daemon.hub;
        const now = Date.now();
        this.#reply(message.id, {
          sessions: sessions.map(({ path, ...rest }) => ({
            ...rest,
            // 看板状态：running=本 daemon 正在驱动；active=会话文件近 60s 有写入
            // （覆盖桌面 GUI 正在跑的会话）；approvals=待决审批数
            running: hub.isRunning(rest.id),
            active: path ? this.#isFileActive(path, now) : false,
            approvals: hub.approvalCount(rest.id),
          })),
        });
        return;
      }
      case "session.watch":
        await this.#watch(message);
        return;
      case "session.unwatch":
        this.#stopWatch();
        this.#reply(message.id, { ok: true });
        return;
      case "session.send": {
        const { sessionId, text } = message.params ?? {};
        if (!sessionId || !text?.trim()) {
          this.#reply(message.id, null, { code: 400, message: "缺少 sessionId 或 text" });
          return;
        }
        try {
          const res = await this.#daemon.hub.sendMessage(sessionId, text);
          this.#reply(message.id, res);
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `发送失败: ${err.message}` });
        }
        return;
      }
      case "turn.interrupt": {
        const { sessionId } = message.params ?? {};
        try {
          this.#reply(message.id, await this.#daemon.hub.interrupt(sessionId));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: err.message });
        }
        return;
      }
      case "session.new": {
        const cwd = message.params?.cwd;
        if (cwd && !this.#daemon.isCwdAllowed(cwd)) {
          this.#reply(message.id, null, { code: 403, message: "该目录不在允许列表中" });
          return;
        }
        try {
          this.#reply(message.id, await this.#daemon.hub.newThread(cwd));
        } catch (err) {
          this.#reply(message.id, null, { code: 500, message: `新建失败: ${err.message}` });
        }
        return;
      }
      case "approval.respond": {
        const { approvalKey, decision } = message.params ?? {};
        const allowed = ["accept", "acceptForSession", "decline", "cancel"];
        if (!allowed.includes(decision)) {
          this.#reply(message.id, null, { code: 400, message: "非法审批决定" });
          return;
        }
        this.#reply(message.id, this.#daemon.hub.respondApproval(approvalKey, decision));
        return;
      }
      default:
        this.#reply(message.id, null, { code: 400, message: `未知方法: ${message.method}` });
    }
  }

  async #auth(message) {
    const params = message.params ?? {};
    if (params.pairToken) {
      const paired = consumePairToken(this.#daemon.configPath, params.pairToken);
      if (!paired) {
        this.#reply(message.id, null, { code: 403, message: "配对码无效或已过期" });
        this.#close();
        return;
      }
      this.#daemon.config = paired.config;
      this.#device = paired.device;
      this.#reply(message.id, {
        deviceId: paired.device.deviceId,
        deviceToken: paired.deviceToken,
        daemonName: paired.config.daemonName,
        protocol: APP_PROTOCOL,
      });
      this.#daemon.hub.registerClient(this);
      this.#daemon.log(`新设备配对成功: ${paired.device.deviceId}`);
      return;
    }
    if (params.deviceToken) {
      // 重读配置，保证撤销立即生效
      this.#daemon.config = loadOrCreateConfig(this.#daemon.configPath);
      const device = findDeviceByToken(this.#daemon.config, params.deviceToken);
      if (!device) {
        this.#reply(message.id, null, { code: 403, message: "设备令牌无效（可能已被撤销）" });
        this.#close();
        return;
      }
      device.lastSeenAt = Date.now();
      saveConfig(this.#daemon.configPath, this.#daemon.config);
      this.#device = device;
      this.#reply(message.id, {
        deviceId: device.deviceId,
        deviceToken: params.deviceToken,
        daemonName: this.#daemon.config.daemonName,
        protocol: APP_PROTOCOL,
      });
      this.#daemon.hub.registerClient(this);
      return;
    }
    this.#reply(message.id, null, { code: 400, message: "缺少配对码或设备令牌" });
    this.#close();
  }

  async #watch(message) {
    const sessionId = message.params?.sessionId;
    const threads = await this.#daemon.appServer.listThreads(200);
    const thread = threads.find((t) => t.id === sessionId);
    if (!thread?.path) {
      this.#reply(message.id, null, { code: 404, message: "会话不存在" });
      return;
    }
    this.#stopWatch();
    this.#watchedThreadId = sessionId;
    // 历史与增量走 rollout 文件 tail；实时流式事件（发消息后的增量输出、
    // 审批）走 app-server 事件，由 hub 推送。二者互补。
    this.#daemon.hub.subscribe(sessionId, this);
    this.#tail = new RolloutTail(thread.path, {
      onItems: (items, { snapshot }) => this.#sendItems(sessionId, items, snapshot),
      onError: (err) => this.#daemon.log(`tail ${sessionId} 失败: ${err.message}`),
    });
    this.#reply(message.id, { ok: true });
    await this.#tail.start();
  }

  #stopWatch() {
    this.#tail?.close();
    this.#tail = null;
    if (this.#watchedThreadId) {
      this.#daemon.hub.unsubscribe(this.#watchedThreadId, this);
      this.#watchedThreadId = null;
    }
  }

  #isFileActive(path, now) {
    try {
      return now - statSync(path).mtimeMs < 60_000;
    } catch {
      return false;
    }
  }

  // —— hub 推送入口 ——
  pushLiveEvent(sessionId, method, params) {
    this.#notify("session.live", { sessionId, event: method, params });
  }

  pushApproval(approvalKey, sessionId, method, params) {
    this.#notify("approval.request", {
      approvalKey,
      sessionId,
      kind: /fileChange|Patch/.test(method) ? "fileChange" : "command",
      command: params?.command ?? null,
      cwd: params?.cwd ?? null,
      reason: params?.reason ?? null,
    });
  }

  pushApprovalResolved(approvalKey) {
    this.#notify("approval.resolved", { approvalKey });
  }

  pushBoardChanged(payload) {
    this.#notify("board.changed", payload);
  }

  // 分块发送，保证每帧不超过 relay 的 256KiB 上限：
  // 首块用 session.snapshot（客户端清屏），后续块一律 session.event（追加）
  #sendItems(sessionId, items, snapshot) {
    const MAX_CHUNK_CHARS = 64_000;
    const MAX_ITEM_CHARS = 48_000;
    let chunk = [];
    let size = 0;
    let first = snapshot;
    const flush = () => {
      if (chunk.length === 0 && !first) return;
      this.#notify(first ? "session.snapshot" : "session.event", { sessionId, items: chunk });
      first = false;
      chunk = [];
      size = 0;
    };
    for (const item of items) {
      let serialized = JSON.stringify(item);
      let entry = item;
      if (serialized.length > MAX_ITEM_CHARS) {
        entry = {
          timestamp: item.timestamp,
          type: item.type,
          payload: { type: item.payload?.type ?? item.type, truncated: true },
        };
        serialized = JSON.stringify(entry);
      }
      if (size + serialized.length > MAX_CHUNK_CHARS && chunk.length > 0) flush();
      chunk.push(entry);
      size += serialized.length;
    }
    flush();
  }

  #reply(id, result, error = null) {
    if (id === undefined) return;
    this.#sendMessage(error ? { id, error } : { id, result });
  }

  #notify(method, params) {
    this.#sendMessage({ method, params });
  }

  #sendMessage(message) {
    if (!this.#key) return;
    this.#send(seal(this.#key, "d2c", message));
  }

  dispose() {
    this.#stopWatch();
    this.#daemon.hub?.removeClient(this);
  }
}
