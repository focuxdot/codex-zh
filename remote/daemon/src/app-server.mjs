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
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.#pending.has(msg.id)) {
      const { resolve, reject } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? "app-server 错误"));
      else resolve(msg.result);
    }
    // 服务端主动请求（审批等）与通知在 r0.4 处理
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

  stop() {
    this.#closed = true;
    this.#ws?.close();
    this.#child?.kill();
  }
}
