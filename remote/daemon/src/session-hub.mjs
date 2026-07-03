// 会话驱动中枢：连接 app-server 的事件/审批与各手机端连接。
// - 客户端表：所有已鉴权设备（审批广播、看板变更通知）
// - 订阅表：谁在看某会话（转发流式事件）
// - 审批表：待决策的服务端请求（广播给所有设备，任一设备可决策，先到先得）
// 见 remote/PROTOCOL.md §3。
export class SessionHub {
  #appServer;
  #log;
  #clients = new Set(); // 已鉴权的 ClientSession
  #subscribers = new Map(); // threadId -> Set<ClientSession>
  #resumed = new Set(); // 已 resume 到本 app-server 的 threadId
  #currentTurn = new Map(); // threadId -> turnId（用于 interrupt 与运行状态）
  #approvals = new Map(); // approvalKey -> { requestId, threadId, method, params }
  #nextApproval = 1;

  constructor(appServer, { log = () => {} } = {}) {
    this.#appServer = appServer;
    this.#log = log;
    appServer.onNotification = (method, params) => this.#onNotification(method, params);
    appServer.onServerRequest = (id, method, params) => this.#onServerRequest(id, method, params);
  }

  // —— 设备注册（鉴权成功后调用）——
  registerClient(client) {
    this.#clients.add(client);
    // 新设备上线立即补发所有待决审批，避免"审批在没人看的时候发生"
    for (const [key, entry] of this.#approvals) {
      client.pushApproval(key, entry.threadId, entry.method, entry.params);
    }
  }

  // —— 订阅（查看） ——
  subscribe(threadId, client) {
    if (!this.#subscribers.has(threadId)) this.#subscribers.set(threadId, new Set());
    this.#subscribers.get(threadId).add(client);
  }

  unsubscribe(threadId, client) {
    this.#subscribers.get(threadId)?.delete(client);
    if (this.#subscribers.get(threadId)?.size === 0) this.#subscribers.delete(threadId);
  }

  // —— 看板状态 ——
  isRunning(threadId) {
    return this.#currentTurn.has(threadId);
  }

  approvalCount(threadId) {
    let n = 0;
    for (const entry of this.#approvals.values()) if (entry.threadId === threadId) n++;
    return n;
  }

  // —— 驱动：确保会话已 resume，然后发消息 ——
  async sendMessage(threadId, text) {
    await this.#ensureResumed(threadId);
    const result = await this.#appServer.startTurn(threadId, text);
    const turnId = result?.turnId ?? result?.turn?.id ?? null;
    if (turnId) this.#currentTurn.set(threadId, turnId);
    this.#broadcastBoard(threadId);
    return { turnId };
  }

  async interrupt(threadId) {
    const turnId = this.#currentTurn.get(threadId);
    if (!turnId) return { ok: false, reason: "无进行中的轮次" };
    await this.#appServer.interruptTurn(threadId, turnId);
    return { ok: true };
  }

  async newThread(cwd) {
    const result = await this.#appServer.startThread(cwd ? { cwd } : {});
    const threadId = result?.threadId ?? result?.thread?.id ?? result?.id ?? null;
    if (threadId) this.#resumed.add(threadId);
    return { threadId };
  }

  async #ensureResumed(threadId) {
    if (this.#resumed.has(threadId)) return;
    await this.#appServer.resumeThread(threadId);
    this.#resumed.add(threadId);
  }

  // —— 审批决策（任一已配对设备可决策，先到先得）——
  respondApproval(approvalKey, decision) {
    const entry = this.#approvals.get(approvalKey);
    if (!entry) return { ok: false, reason: "审批不存在或已被处理" };
    this.#approvals.delete(approvalKey);
    this.#appServer.respond(entry.requestId, { decision });
    // 其他设备的审批卡片同步消失
    for (const client of this.#clients) client.pushApprovalResolved(approvalKey);
    this.#broadcastBoard(entry.threadId);
    return { ok: true };
  }

  // —— app-server -> 手机 ——
  #onNotification(method, params) {
    const threadId = params?.threadId;
    if (!threadId) return;
    if (method === "turn/started") {
      const turnId = params?.turn?.id ?? params?.turnId;
      if (turnId) this.#currentTurn.set(threadId, turnId);
      this.#broadcastBoard(threadId);
    }
    if (method === "turn/completed") {
      this.#currentTurn.delete(threadId);
      this.#broadcastBoard(threadId);
    }
    const subs = this.#subscribers.get(threadId);
    if (!subs) return;
    for (const client of subs) {
      client.pushLiveEvent(threadId, method, params);
    }
  }

  #onServerRequest(id, method, params) {
    const threadId = params?.threadId;
    const isApproval = /requestApproval|Approval$/.test(method);
    if (!isApproval || !threadId) {
      // 非审批的服务端请求，daemon 暂不支持，回错误避免 app-server 卡住
      this.#appServer.respondError(id, -32601, `daemon 不处理该请求: ${method}`);
      return;
    }
    const approvalKey = `a${this.#nextApproval++}`;
    this.#approvals.set(approvalKey, { requestId: id, threadId, method, params });
    if (this.#clients.size === 0) {
      this.#log(`审批 ${approvalKey} 暂无在线设备，挂起等待（设备上线后补发）`);
    }
    // 广播给所有设备：审批是头号阻塞，必须在任何页面都能看到
    for (const client of this.#clients) {
      client.pushApproval(approvalKey, threadId, method, params);
    }
    this.#broadcastBoard(threadId);
  }

  // 看板变更（运行状态/审批数变化），客户端据此刷新列表徽标
  #broadcastBoard(threadId) {
    const payload = {
      sessionId: threadId,
      running: this.isRunning(threadId),
      approvals: this.approvalCount(threadId),
    };
    for (const client of this.#clients) client.pushBoardChanged(payload);
  }

  // client 断开时清理
  removeClient(client) {
    this.#clients.delete(client);
    for (const [threadId, subs] of this.#subscribers) {
      subs.delete(client);
      if (subs.size === 0) this.#subscribers.delete(threadId);
    }
  }
}
