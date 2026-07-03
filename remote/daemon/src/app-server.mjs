// 拉起并驱动 codex app-server（JSON-RPC over WebSocket）
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export class AppServer {
  #command;
  #port;
  #child = null;
  #ws = null;
  #nextId = 1;
  #pending = new Map();
  #log;
  #closed = false;

  onNotification = () => {}; // (method, params)
  onServerRequest = () => {}; // (id, method, params) —— 审批等，需调用 respond(id, result)

  constructor({ command = "codex", port = 19271, log = () => {} } = {}) {
    this.#command = command;
    this.#port = port;
    this.#log = log;
  }

  get url() {
    return `ws://127.0.0.1:${this.#port}`;
  }

  async start() {
    this.#closed = false;
    await this.#spawnAndConnect();
  }

  async #spawnAndConnect() {
    this.#child = spawn(this.#command, ["app-server", "--listen", this.url], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.#child.stderr.on("data", (chunk) => this.#log(`[app-server] ${chunk}`.trimEnd()));
    this.#child.on("exit", (code) => {
      this.#log(`app-server 退出（code=${code}）`);
      this.#ws = null;
      if (!this.#closed) {
        // 自动重拉，避免引擎崩溃导致远程永久不可用
        delay(2000).then(() => this.#spawnAndConnect().catch((err) => this.#log(String(err))));
      }
    });

    await this.#waitReady();
    await this.#connect();
  }

  async #waitReady() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.#port}/readyz`);
        if (res.ok) return;
      } catch {
        // 尚未就绪
      }
      await delay(200);
    }
    throw new Error("app-server 启动超时");
  }

  async #connect() {
    const ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("无法连接 app-server"));
    });
    ws.onmessage = (event) => this.#onMessage(event.data);
    ws.onclose = () => {
      this.#ws = null;
      for (const [, pending] of this.#pending) {
        pending.reject(new Error("app-server 连接断开"));
      }
      this.#pending.clear();
    };
    this.#ws = ws;
    await this.request("initialize", {
      clientInfo: { name: "codex-zh-remote-daemon", version: "0.1.0" },
    });
    // 握手收尾：app-server 需收到 initialized 通知后才服务会话级方法
    // （thread/resume、thread/start、turn/start）；缺此步这些请求会挂起超时。
    this.notify("initialized", {});
  }

  notify(method, params = {}) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // 我方请求的响应
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? "app-server 错误"));
      else resolve(msg.result);
      return;
    }
    // 服务端主动请求（有 id + method）：审批等，需要我方回 response
    if (msg.id !== undefined && msg.method) {
      try {
        this.onServerRequest(msg.id, msg.method, msg.params ?? {});
      } catch (err) {
        this.#log(`处理服务端请求失败: ${err.message}`);
      }
      return;
    }
    // 通知（有 method 无 id）
    if (msg.method) {
      try {
        this.onNotification(msg.method, msg.params ?? {});
      } catch (err) {
        this.#log(`处理通知失败: ${err.message}`);
      }
    }
  }

  // 应答服务端请求（审批决定）
  respond(id, result) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id, code, message) {
    if (!this.#ws) return;
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  request(method, params = {}, timeoutMs = 15000) {
    if (!this.#ws) return Promise.reject(new Error("app-server 未连接"));
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`app-server 请求超时: ${method}`));
        }
      }, timeoutMs).unref?.();
    });
    this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return promise;
  }

  async listThreads(limit = 50) {
    const result = await this.request("thread/list", { limit });
    const items = result?.data ?? [];
    return items.map((t) => ({
      id: t.id,
      preview: t.preview ?? "",
      name: t.name ?? null,
      cwd: t.cwd ?? "",
      updatedAt: t.updatedAt ?? null,
      source: t.source ?? "",
      status: t.status?.type ?? "unknown",
      path: t.path ?? null,
    }));
  }

  // 会话级方法可能因模型初始化/网络（如国内访问模型列表）而较慢，
  // 用更长的超时；实测 resume 在网络不佳时约 16s。
  #SESSION_TIMEOUT = 90000;

  // 恢复会话到本 app-server 实例（幂等，daemon 侧去重）
  resumeThread(threadId, overrides = {}) {
    return this.request("thread/resume", { threadId, ...overrides }, this.#SESSION_TIMEOUT);
  }

  // 发起一轮对话，返回 { turnId? }
  startTurn(threadId, text, overrides = {}) {
    return this.request(
      "turn/start",
      { threadId, input: [{ type: "text", text }], ...overrides },
      this.#SESSION_TIMEOUT,
    );
  }

  interruptTurn(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  startThread(params = {}) {
    return this.request("thread/start", params, this.#SESSION_TIMEOUT);
  }

  stop() {
    this.#closed = true;
    this.#ws?.close();
    this.#child?.kill();
  }
}
