// 会话驱动中枢：连接 app-server 的事件/审批与各手机端连接。
// - 订阅表：谁在看某会话（转发流式事件）
// - 占用表：谁持有某会话的操作权（接收审批、发消息）
// - 审批表：待手机决策的服务端请求
// 见 remote/PROTOCOL.md §3。
export class SessionHub {
  #appServer;
  #log;
  #subscribers = new Map(); // threadId -> Set<ClientSession>
  #owner = new Map(); // threadId -> ClientSession
  #resumed = new Set(); // 已 resume 到本 app-server 的 threadId
  #currentTurn = new Map(); // threadId -> turnId（用于 interrupt）
  #approvals = new Map(); // approvalKey -> { requestId, threadId }
  #nextApproval = 1;

  constructor(appServer, { log = () => {} } = {}) {
    this.#appServer = appServer;
    this.#log = log;
    appServer.onNotification = (method, params) => this.#onNotification(method, params);
    appServer.onServerRequest = (id, method, params) => this.#onServerRequest(id, method, params);
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

  // —— 驱动：确保会话已 resume，然后发消息 ——
  async sendMessage(threadId, text, client) {
    await this.#ensureResumed(threadId);
    this.#owner.set(threadId, client); // 谁最后发消息谁持有操作权
    const result = await this.#appServer.startTurn(threadId, text);
    const turnId = result?.turnId ?? result?.turn?.id ?? null;
    if (turnId) this.#currentTurn.set(threadId, turnId);
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

  // —— 审批决策回传 ——
  respondApproval(approvalKey, decision, client) {
    const entry = this.#approvals.get(approvalKey);
    if (!entry) return { ok: false, reason: "审批不存在或已处理" };
    // 仅持有该会话操作权的设备可决策
    if (this.#owner.get(entry.threadId) && this.#owner.get(entry.threadId) !== client) {
      return { ok: false, reason: "该会话由其他设备操作中" };
    }
    this.#approvals.delete(approvalKey);
    this.#appServer.respond(entry.requestId, { decision });
    return { ok: true };
  }

  // —— app-server -> 手机 ——
  #onNotification(method, params) {
    const threadId = params?.threadId;
    if (!threadId) return;
    if (method === "turn/started") {
      const turnId = params?.turn?.id ?? params?.turnId;
      if (turnId) this.#currentTurn.set(threadId, turnId);
    }
    if (method === "turn/completed") this.#currentTurn.delete(threadId);
    const subs = this.#subscribers.get(threadId);
    if (!subs) return;
    for (const client of subs) {
      client.pushLiveEvent(threadId, method, params);
    }
  }

  #onServerRequest(id, method, params) {
    const threadId = params?.threadId;
    // 审批类服务端请求（v1/v2 两种命名都接受）
    const isApproval = /requestApproval|Approval$/.test(method);
    if (!isApproval || !threadId) {
      // 非审批的服务端请求，daemon 暂不支持，回默认拒绝避免 app-server 卡住
      this.#appServer.respondError(id, -32601, `daemon 不处理该请求: ${method}`);
      return;
    }
    const approvalKey = `a${this.#nextApproval++}`;
    this.#approvals.set(approvalKey, { requestId: id, threadId });
    const target = this.#owner.get(threadId) ?? this.#firstSubscriber(threadId);
    if (!target) {
      // 无人接收：保持挂起，记录日志（PRD：审批不自动决策）
      this.#log(`审批 ${approvalKey} 无在线设备接收，挂起等待`);
      return;
    }
    target.pushApproval(approvalKey, threadId, method, params);
  }

  #firstSubscriber(threadId) {
    const subs = this.#subscribers.get(threadId);
    if (!subs) return null;
    for (const client of subs) return client;
    return null;
  }

  // client 断开时清理其占用与待审批
  removeClient(client) {
    for (const [threadId, subs] of this.#subscribers) {
      subs.delete(client);
      if (subs.size === 0) this.#subscribers.delete(threadId);
    }
    for (const [threadId, owner] of this.#owner) {
      if (owner === client) this.#owner.delete(threadId);
    }
  }
}
