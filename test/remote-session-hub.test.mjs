import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { SessionHub } from "../remote/daemon/src/session-hub.mjs";

// 模拟 app-server：记录请求、可手动触发通知与服务端请求
function mockAppServer() {
  const calls = [];
  const responses = [];
  const server = {
    onNotification: () => {},
    onServerRequest: () => {},
    calls,
    responses,
    resumeThread(threadId) { calls.push(["resume", threadId]); return Promise.resolve({}); },
    startTurn(threadId, text) { calls.push(["turn", threadId, text]); return Promise.resolve({ turnId: "t-1" }); },
    interruptTurn(threadId, turnId) { calls.push(["interrupt", threadId, turnId]); return Promise.resolve({}); },
    startThread(params) { calls.push(["start", params]); return Promise.resolve({ threadId: "new-1" }); },
    respond(id, result) { responses.push(["ok", id, result]); },
    respondError(id, code, msg) { responses.push(["err", id, code, msg]); },
    emitNotification(method, params) { this.onNotification(method, params); },
    emitServerRequest(id, method, params) { this.onServerRequest(id, method, params); },
  };
  return server;
}

function mockClient() {
  return { live: [], approvals: [], resolved: [], board: [], reactions: [], counts: [], summaries: [],
    pushLiveEvent(sessionId, method, params) { this.live.push({ sessionId, method, params }); },
    pushApproval(key, sessionId, method, params) { this.approvals.push({ key, sessionId, method, params }); },
    pushApprovalResolved(key) { this.resolved.push(key); },
    pushBoardChanged(payload) { this.board.push(payload); },
    pushShareReaction(payload) { this.reactions.push(payload); },
    pushViewerCount(payload) { this.counts.push(payload); },
    pushShareSummary(payload) { this.summaries.push(payload); },
  };
}

// 观众连接：isViewer + 单会话 scope（形状同 ClientSession 的 getter）
function mockViewer(sessionId, deviceId) {
  return { ...mockClient(), isViewer: true, scopeSessionId: sessionId, deviceId, congestedSince: 0 };
}

test("发消息：首次 resume + turn/start，重复发不再 resume", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  await hub.sendMessage("thr-1", "你好");
  await hub.sendMessage("thr-1", "再来一句");
  assert.equal(server.calls.filter((c) => c[0] === "resume").length, 1);
  assert.equal(server.calls.filter((c) => c[0] === "turn").length, 2);
});

test("停止：无进行中轮次返回 false；有则 interrupt", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  assert.equal((await hub.interrupt("thr-x")).ok, false);
  await hub.sendMessage("thr-x", "跑");
  const res = await hub.interrupt("thr-x");
  assert.equal(res.ok, true);
  assert.deepEqual(server.calls.at(-1), ["interrupt", "thr-x", "t-1"]);
});

test("事件路由：只推送给订阅该会话的 client", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const a = mockClient(); const b = mockClient();
  hub.subscribe("thr-1", a);
  hub.subscribe("thr-2", b);
  server.emitNotification("turn/started", { threadId: "thr-1", turn: { id: "t9" } });
  assert.equal(a.live.length, 1);
  assert.equal(b.live.length, 0);
});

test("审批广播给所有已注册设备，任一设备决策后其余同步消失", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const a = mockClient(); const b = mockClient();
  hub.registerClient(a);
  hub.registerClient(b);
  server.emitServerRequest(42, "item/commandExecution/requestApproval", {
    threadId: "thr-1", command: ["rm", "-rf", "x"], cwd: "/tmp",
  });
  assert.equal(a.approvals.length, 1, "设备 a 收到审批");
  assert.equal(b.approvals.length, 1, "设备 b 收到审批");
  const key = a.approvals[0].key;
  assert.equal(hub.respondApproval(key, "accept").ok, true);
  assert.deepEqual(server.responses.at(-1), ["ok", 42, { decision: "accept" }]);
  assert.deepEqual(a.resolved, [key], "a 收到已解决通知");
  assert.deepEqual(b.resolved, [key], "b 收到已解决通知");
  // 先到先得：重复决策失败
  assert.equal(hub.respondApproval(key, "accept").ok, false);
});

test("无在线设备时审批挂起，设备注册后补发", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  server.emitServerRequest(7, "execCommandApproval", { threadId: "thr-1", command: ["ls"] });
  const late = mockClient();
  hub.registerClient(late);
  assert.equal(late.approvals.length, 1, "迟到设备补收待决审批");
  assert.equal(hub.respondApproval(late.approvals[0].key, "decline").ok, true);
});

test("审批与运行状态计入看板并广播 board.changed", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const c = mockClient();
  hub.registerClient(c);
  server.emitServerRequest(9, "execCommandApproval", { threadId: "thr-1", command: ["x"] });
  assert.equal(hub.approvalCount("thr-1"), 1);
  assert.equal(c.board.at(-1).approvals, 1);
  await hub.sendMessage("thr-2", "开跑");
  assert.equal(hub.isRunning("thr-2"), true);
  assert.equal(c.board.at(-1).sessionId, "thr-2");
  assert.equal(c.board.at(-1).running, true);
  server.emitNotification("turn/completed", { threadId: "thr-2" });
  assert.equal(hub.isRunning("thr-2"), false);
  assert.equal(c.board.at(-1).running, false);
});

test("非审批服务端请求回默认错误，避免 app-server 卡死", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  server.emitServerRequest(99, "some/otherRequest", { threadId: "thr-1" });
  assert.equal(server.responses.at(-1)[0], "err");
});

test("client 断开后不再收到事件与审批", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const client = mockClient();
  hub.registerClient(client);
  hub.subscribe("thr-1", client);
  hub.removeClient(client);
  server.emitNotification("turn/started", { threadId: "thr-1", turn: { id: "t" } });
  server.emitServerRequest(1, "execCommandApproval", { threadId: "thr-1" });
  assert.equal(client.live.length, 0);
  assert.equal(client.approvals.length, 0);
});

test("数据级过滤：审批（补发+实时+resolved）与 board.changed 不达观众", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  // 待决审批存在时观众上线：不补发
  server.emitServerRequest(1, "execCommandApproval", { threadId: "thr-1", command: ["ls"] });
  const viewer = mockViewer("thr-1");
  const full = mockClient();
  hub.registerClient(viewer);
  hub.registerClient(full);
  assert.equal(viewer.approvals.length, 0, "观众不补收待决审批");
  assert.equal(full.approvals.length, 1, "全权设备补收");
  // 实时审批广播：观众收不到
  server.emitServerRequest(2, "execCommandApproval", { threadId: "thr-1", command: ["rm"] });
  assert.equal(viewer.approvals.length, 0);
  assert.equal(full.approvals.length, 2);
  // 决策后 resolved 与 board.changed 同样不达观众
  hub.respondApproval(full.approvals[1].key, "accept");
  assert.equal(viewer.resolved.length, 0);
  assert.equal(full.resolved.length, 1);
  assert.equal(viewer.board.length, 0, "board.changed 携带其他会话状态，不发观众");
  assert.ok(full.board.length > 0);
});

test("观众订阅会话后仍收到实时流事件（阅读本体不受过滤影响）", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const viewer = mockViewer("thr-1");
  hub.registerClient(viewer);
  hub.subscribe("thr-1", viewer);
  server.emitNotification("turn/started", { threadId: "thr-1", turn: { id: "t1" } });
  assert.equal(viewer.live.length, 1);
});

test("viewerCount：按 scope.sessionId 聚合（跨链接），全权设备不计入", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  hub.registerClient(mockViewer("thr-1"));
  hub.registerClient(mockViewer("thr-1")); // 同会话另一条围观链接的观众
  hub.registerClient(mockViewer("thr-2"));
  hub.registerClient(mockClient());
  assert.equal(hub.viewerCount("thr-1"), 2);
  assert.equal(hub.viewerCount("thr-2"), 1);
  assert.equal(hub.viewerCount("thr-9"), 0);
  assert.equal(hub.viewerCount(undefined), 0);
  const gone = mockViewer("thr-1");
  hub.registerClient(gone);
  hub.removeClient(gone);
  assert.equal(hub.viewerCount("thr-1"), 2);
});

test("喝彩聚合：窗口内合并计数，只达该会话的观众面", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server, { reactionWindowMs: 10 });
  const full = mockClient();
  const v1 = mockViewer("thr-1", "dv1");
  const v2 = mockViewer("thr-2", "dv2");
  hub.registerClient(full);
  hub.registerClient(v1);
  hub.registerClient(v2);
  hub.addReaction("thr-1", "👏", "dv1");
  hub.addReaction("thr-1", "👏", "dv1");
  hub.addReaction("thr-1", "🔥", "dv1");
  await delay(60);
  const claps = full.reactions.find((r) => r.emoji === "👏");
  assert.equal(claps.count, 2, "窗口内合并计数");
  assert.equal(claps.sessionId, "thr-1");
  assert.equal(full.reactions.find((r) => r.emoji === "🔥").count, 1);
  assert.equal(v1.reactions.length, 2, "同会话观众收到");
  assert.equal(v2.reactions.length, 0, "其他会话的观众收不到");
});

test("viewer.count 防抖广播：观众收 count，congested 字段仅发全权", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server, { viewerCountDebounceMs: 10 });
  const full = mockClient();
  hub.registerClient(full);
  const a = mockViewer("thr-1", "dv1");
  const b = mockViewer("thr-1", "dv1"); // 同一条链接的第二个观众
  hub.registerClient(a);
  hub.registerClient(b);
  await delay(60);
  const last = full.counts.at(-1);
  assert.equal(last.sessionId, "thr-1");
  assert.equal(last.count, 2);
  assert.equal(last.congested, false, "全权带 congested 字段");
  assert.equal("congested" in a.counts.at(-1), false, "观众不带 congested");
  assert.equal(a.counts.at(-1).count, 2);
  // 观众离开后再广播
  hub.removeClient(b);
  await delay(60);
  assert.equal(full.counts.at(-1).count, 1);
});

test("围观战报：finishLink 汇总 visitors/peak/reactions，只发全权、只发一次、无访客不发", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server, { reactionWindowMs: 10, viewerCountDebounceMs: 10 });
  const full = mockClient();
  const viewer = mockViewer("thr-1", "dv1");
  hub.registerClient(full);
  hub.registerClient(viewer);
  hub.addReaction("thr-1", "👏", "dv1");
  hub.finishLink("dv1");
  assert.equal(full.summaries.length, 1);
  assert.deepEqual(full.summaries[0], {
    sessionId: "thr-1", deviceId: "dv1", visitors: 1, peak: 1, reactions: 1,
  });
  assert.equal(viewer.summaries.length, 0, "战报不发观众");
  hub.finishLink("dv1");
  assert.equal(full.summaries.length, 1, "重复 finishLink 幂等");
  hub.finishLink("dv-nobody");
  assert.equal(full.summaries.length, 1, "没人来过的链接没有战报");
});

test("拥塞观众全部离开后向全权设备补发 congested:false（横幅不悬挂）", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server, {
    viewerCountDebounceMs: 5,
    congestionTickMs: 10,
    congestionAfterMs: 10,
  });
  const full = mockClient();
  hub.registerClient(full);
  const jammed = mockViewer("thr-1", "dv1");
  jammed.congestedSince = Date.now() - 1000; // 帧积压已久
  hub.registerClient(jammed);
  await delay(60);
  assert.equal(full.counts.at(-1)?.congested, true, "拥塞翻转已广播");
  hub.removeClient(jammed);
  await delay(60);
  const last = full.counts.at(-1);
  assert.equal(last.count, 0);
  assert.equal(last.congested, false, "观众走光时清除标志并广播翻转");
});

test("reconcileLinks：配置里消失的链接即使无在线观众也交战报，幂等且不误伤有效链接", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server, { viewerCountDebounceMs: 5 });
  const full = mockClient();
  hub.registerClient(full);
  const a = mockViewer("thr-1", "dv-gone");
  const b = mockViewer("thr-1", "dv-alive");
  hub.registerClient(a);
  hub.registerClient(b);
  hub.removeClient(a); // 观众早已离线，桌面端此后才撤销链接
  hub.removeClient(b);
  hub.reconcileLinks(new Set(["dv-alive"]));
  assert.equal(full.summaries.length, 1, "孤儿统计也交出战报");
  assert.equal(full.summaries[0].deviceId, "dv-gone");
  hub.reconcileLinks(new Set(["dv-alive"]));
  assert.equal(full.summaries.length, 1, "重复对账幂等");
  hub.reconcileLinks(new Set([]));
  assert.equal(full.summaries.at(-1).deviceId, "dv-alive", "链接真被撤销后才交");
});

test("新建会话透传 cwd 并返回 threadId", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const res = await hub.newThread("/Users/me/proj");
  assert.equal(res.threadId, "new-1");
  assert.deepEqual(server.calls.at(-1), ["start", { cwd: "/Users/me/proj" }]);
});
