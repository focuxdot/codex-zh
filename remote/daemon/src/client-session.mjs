// 单个远端设备连接的 E2E 会话：握手 -> 鉴权 -> 方法路由（见 PROTOCOL.md §2/§3）
import { consumePairToken, findDeviceByToken, loadOrCreateConfig, saveConfig } from "./config.mjs";
import { deriveSessionKey, open as sealedOpen, seal } from "./crypto.mjs";
import { RolloutTail } from "./rollout-tail.mjs";

export class ClientSession {
  #cid;
  #daemon; // { config, configPath, privateKey, appServer, log }
  #send; // (data) => void  发送 E2E 信封给该 client
  #close; // () => void     要求 relay 断开该 client
  #key = null;
  #device = null;
  #tail = null;

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
        this.#reply(message.id, { sessions: sessions.map(({ path, ...rest }) => rest) });
        return;
      }
      case "session.watch":
        await this.#watch(message);
        return;
      case "session.unwatch":
        this.#tail?.close();
        this.#tail = null;
        this.#reply(message.id, { ok: true });
        return;
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
      });
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
      });
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
    this.#tail?.close();
    this.#tail = new RolloutTail(thread.path, {
      onItems: (items, { snapshot }) => this.#sendItems(sessionId, items, snapshot),
      onError: (err) => this.#daemon.log(`tail ${sessionId} 失败: ${err.message}`),
    });
    this.#reply(message.id, { ok: true });
    await this.#tail.start();
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
    this.#tail?.close();
    this.#tail = null;
  }
}
