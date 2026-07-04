// Codex-ZH Remote relay —— Cloudflare Worker + Durable Objects 变体
// 与 remote/relay-node/server.mjs 实现相同的转发协议（见 remote/PROTOCOL.md §1）。
// 使用 WebSocket Hibernation API：空闲连接不产生 duration 计费。

const PATH_RE = /^\/v1\/(daemon|client)\/([A-Za-z0-9_-]{8,64})$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = PATH_RE.exec(url.pathname);
    if (!match) {
      return new Response("codex-zh relay ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const [, , daemonId] = match;
    const stub = env.ROOM.get(env.ROOM.idFromName(daemonId));
    return stub.fetch(request); // 原样透传，保留 Upgrade 语义；角色由 DO 从 URL 解析
  },
};

export class RelayRoom {
  #state;

  constructor(state) {
    this.#state = state;
    // hb 在边缘自动应答：不唤醒 DO（省 duration 计费），daemon 与手机端通用。
    // 匹配是逐字符的，两端发送串必须与这里完全一致。
    this.#state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"t":"hb"}', '{"t":"hb"}'),
    );
  }

  async fetch(request) {
    const role = PATH_RE.exec(new URL(request.url).pathname)?.[1];
    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = [pair[0], pair[1]];

    if (role === "daemon") {
      for (const old of this.#state.getWebSockets("daemon")) {
        old.close(1000, "replaced");
      }
      this.#state.acceptWebSocket(serverEnd, ["daemon"]);
      this.#broadcastToClients({ t: "status", online: true });
      for (const client of this.#state.getWebSockets("client")) {
        const cid = client.deserializeAttachment()?.cid;
        if (cid) serverEnd.send(JSON.stringify({ t: "open", cid })); // 补发已在线 client 的 open
      }
    } else {
      const cid = `c${crypto.randomUUID().slice(0, 8)}`;
      this.#state.acceptWebSocket(serverEnd, ["client", `cid:${cid}`]);
      serverEnd.serializeAttachment({ cid });
      const online = this.#daemon() !== null;
      // lastSeen 存 DO storage，跨 hibernation/迁移仍可用
      const lastSeen = online ? null : ((await this.#state.storage.get("lastSeen")) ?? null);
      serverEnd.send(JSON.stringify({ t: "status", online, lastSeen }));
      this.#daemon()?.send(JSON.stringify({ t: "open", cid }));
    }
    return new Response(null, { status: 101, webSocket: clientEnd });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 256 * 1024) {
      ws.close(1009, "frame too large");
      return;
    }
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const tags = this.#state.getTags(ws);
    if (tags.includes("daemon")) {
      this.#fromDaemon(ws, frame);
    } else {
      this.#fromClient(ws, frame);
    }
  }

  async webSocketClose(ws) {
    const tags = this.#state.getTags(ws);
    if (tags.includes("daemon")) {
      // 仅当没有其他 daemon 连接（如顶替的新连接）时才广播下线；
      // 关闭回调执行时自身可能仍在 getWebSockets 列表里，须按身份排除
      const others = this.#state.getWebSockets("daemon").filter((s) => s !== ws);
      if (others.length === 0) {
        const lastSeen = Date.now();
        await this.#state.storage.put("lastSeen", lastSeen);
        this.#broadcastToClients({ t: "status", online: false, lastSeen });
      }
      return;
    }
    const cid = ws.deserializeAttachment()?.cid;
    if (cid) this.#daemon()?.send(JSON.stringify({ t: "close", cid }));
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  #fromDaemon(ws, frame) {
    if (frame.t === "hb") {
      ws.send(JSON.stringify({ t: "hb" }));
      return;
    }
    if (typeof frame.cid !== "string") return;
    const client = this.#clientByCid(frame.cid);
    if (!client) return;
    if (frame.t === "msg") {
      client.send(JSON.stringify({ t: "msg", data: frame.data }));
    } else if (frame.t === "close") {
      client.close(1000, "closed by daemon");
    }
  }

  #fromClient(ws, frame) {
    if (frame.t === "hb") {
      ws.send('{"t":"hb"}'); // 兜底：auto-response 未生效（非休眠路径）时仍应答
      return;
    }
    if (frame.t !== "msg") return;
    const cid = ws.deserializeAttachment()?.cid;
    if (!cid) return;
    this.#daemon()?.send(JSON.stringify({ t: "msg", cid, data: frame.data }));
  }

  #daemon() {
    const sockets = this.#state.getWebSockets("daemon");
    return sockets.length > 0 ? sockets[0] : null;
  }

  #clientByCid(cid) {
    const sockets = this.#state.getWebSockets(`cid:${cid}`);
    return sockets.length > 0 ? sockets[0] : null;
  }

  #broadcastToClients(frame) {
    const text = JSON.stringify(frame);
    for (const ws of this.#state.getWebSockets("client")) {
      try {
        ws.send(text);
      } catch {
        // 连接已失效，忽略
      }
    }
  }
}
