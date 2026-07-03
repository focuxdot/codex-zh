import assert from "node:assert/strict";
import test from "node:test";

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
  return { live: [], approvals: [], resolved: [], board: [],
    pushLiveEvent(sessionId, method, params) { this.live.push({ sessionId, method, params }); },
    pushApproval(key, sessionId, method, params) { this.approvals.push({ key, sessionId, method, params }); },
    pushApprovalResolved(key) { this.resolved.push(key); },
    pushBoardChanged(payload) { this.board.push(payload); },
  };
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

test("新建会话透传 cwd 并返回 threadId", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const res = await hub.newThread("/Users/me/proj");
  assert.equal(res.threadId, "new-1");
  assert.deepEqual(server.calls.at(-1), ["start", { cwd: "/Users/me/proj" }]);
});
