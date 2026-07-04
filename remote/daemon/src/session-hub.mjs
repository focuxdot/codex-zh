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
  #onAwakeChange;
  #awake = false;
  #onEvent;

  constructor(appServer, { log = () => {}, onAwakeChange = () => {}, onEvent = () => {} } = {}) {
    this.#appServer = appServer;
    this.#log = log;
    this.#onAwakeChange = onAwakeChange;
    this.#onEvent = onEvent; // (type, {sessionId, clientsOnline}) —— webhook 通知用
    appServer.onNotification = (method, params) => this.#onNotification(method, params);
    appServer.onServerRequest = (id, method, params) => this.#onServerRequest(id, method, params);
  }

  // 需要保持清醒：有设备在线（用户可能随时操作）或有会话运行中（任务不能被睡眠打断）
  shouldStayAwake() {
    return this.#clients.size > 0 || this.#currentTurn.size > 0;
  }

  #updateAwake() {
    const want = this.shouldStayAwake();
    if (want === this.#awake) return;
    this.#awake = want;
    this.#onAwakeChange(want);
  }

  // —— 设备注册（鉴权成功后调用）——
  registerClient(client) {
    this.#clients.add(client);
    // 新设备上线立即补发所有待决审批，避免"审批在没人看的时候发生"
    for (const [key, entry] of this.#approvals) {
      client.pushApproval(key, entry.threadId, entry.method, entry.params);
    }
    this.#updateAwake();
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

  // 引擎（app-server）掉线/恢复时广播给所有设备（连接状态分层诊断用）
  broadcastEngineState(healthy) {
    for (const client of this.#clients) client.pushEngineState(healthy);
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
  // imageUrls：data: URL 数组（手机上传的附图）。桌面端对 data URL 同样走
  // {type:"image",url} 输入项，这是已验证的路径，不需要落临时文件。
  // overrides：按轮 override（model/effort/approvalPolicy/sandboxPolicy/plan，
  // 已在 client-session 白名单过滤）。plan 展开为 collaborationMode（实测形状：
  // {mode:"plan",settings:{model}}，settings.model 必填，缺省用引擎默认模型）
  async sendMessage(threadId, text, imageUrls = [], overrides) {
    await this.#ensureResumed(threadId);
    const input = [
      ...imageUrls.map((url) => ({ type: "image", url })),
      ...(text ? [{ type: "text", text }] : []),
    ];
    const { plan, ...rest } = overrides ?? {};
    if (plan) {
      const model = rest.model ?? (await this.#defaultModel());
      rest.collaborationMode = {
        mode: "plan",
        settings: { model, ...(rest.effort ? { effort: rest.effort } : {}) },
      };
    }
    const result = await this.#appServer.startTurn(threadId, input, rest);
    const turnId = result?.turnId ?? result?.turn?.id ?? null;
    if (turnId) this.#currentTurn.set(threadId, turnId);
    this.#updateAwake();
    this.#broadcastBoard(threadId);
    return { turnId };
  }

  async interrupt(threadId) {
    const turnId = this.#currentTurn.get(threadId);
    if (!turnId) return { ok: false, reason: "无进行中的轮次" };
    await this.#appServer.interruptTurn(threadId, turnId);
    return { ok: true };
  }

  // —— 会话目标（官方 App 的 Pursue goal）——
  async setGoal(threadId, goal) {
    await this.#ensureResumed(threadId);
    if (goal) {
      await this.#appServer.request("thread/goal/set", { threadId, goal });
    } else {
      await this.#appServer.request("thread/goal/clear", { threadId });
    }
    return { ok: true };
  }

  async getGoal(threadId) {
    await this.#ensureResumed(threadId);
    try {
      const r = await this.#appServer.request("thread/goal/get", { threadId });
      // 响应形状未定稿（experimental）：兼容 {goal} / {data:{goal}} / {data:"..."}
      const goal = r?.goal ?? r?.data?.goal ?? (typeof r?.data === "string" ? r.data : null);
      return { goal: typeof goal === "string" ? goal : null };
    } catch {
      return { goal: null };
    }
  }

  // 引擎默认模型（计划模式 settings.model 必填时的兜底），进程内缓存一次
  #modelDefault = null;
  async #defaultModel() {
    if (this.#modelDefault) return this.#modelDefault;
    const r = await this.#appServer.request("model/list", {});
    const models = r?.data ?? [];
    this.#modelDefault = (models.find((m) => m.isDefault) ?? models[0])?.model ?? "gpt-5.5";
    return this.#modelDefault;
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
      this.#updateAwake();
      this.#broadcastBoard(threadId);
    }
    // failed/aborted 同样要清运行状态，否则看板"运行中"永远卡住
    if (method === "turn/completed" || method === "turn/failed" || method === "turn/aborted") {
      this.#currentTurn.delete(threadId);
      this.#updateAwake();
      this.#broadcastBoard(threadId);
      if (method === "turn/completed") {
        this.#onEvent("turnCompleted", { sessionId: threadId, clientsOnline: this.#clients.size });
      }
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
    // webhook：审批是头号阻塞，总是推（无论是否有设备在线）
    this.#onEvent("approval", { sessionId: threadId, clientsOnline: this.#clients.size });
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
    this.#updateAwake();
  }
}
