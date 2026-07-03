// daemon 与 relay 的出站长连接：注册、心跳、指数退避重连、按 cid 路由
const HEARTBEAT_MS = 25000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000;

export class RelayLink {
  #url;
  #handlers; // { onOpen(cid), onMessage(cid, data), onClose(cid), log }
  #ws = null;
  #attempt = 0;
  #heartbeat = null;
  #closed = false;

  constructor(relayUrl, daemonId, handlers) {
    this.#url = `${relayUrl.replace(/\/$/, "")}/v1/daemon/${daemonId}`;
    this.#handlers = handlers;
  }

  start() {
    this.#connect();
  }

  #connect() {
    if (this.#closed) return;
    const ws = new WebSocket(this.#url);
    ws.onopen = () => {
      this.#attempt = 0;
      this.#ws = ws;
      this.#handlers.log(`已连接 relay: ${this.#url}`);
      this.#heartbeat = setInterval(() => this.#sendRaw({ t: "hb" }), HEARTBEAT_MS);
      this.#heartbeat.unref?.();
    };
    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      switch (frame.t) {
        case "open":
          this.#handlers.onOpen(frame.cid);
          break;
        case "msg":
          this.#handlers.onMessage(frame.cid, frame.data);
          break;
        case "close":
          this.#handlers.onClose(frame.cid);
          break;
        case "hb":
          break;
        default:
          break; // 未知帧忽略，保证向前兼容
      }
    };
    ws.onclose = () => this.#onDisconnect();
    ws.onerror = () => {};
  }

  #onDisconnect() {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#ws = null;
    if (this.#closed) return;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
    this.#attempt += 1;
    this.#handlers.log(`relay 连接断开，${Math.round(delay / 1000)}s 后重连`);
    setTimeout(() => this.#connect(), delay).unref?.();
  }

  send(cid, data) {
    this.#sendRaw({ t: "msg", cid, data });
  }

  closeClient(cid) {
    this.#sendRaw({ t: "close", cid });
  }

  #sendRaw(frame) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(frame));
    }
  }

  stop() {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#ws?.close();
  }
}
