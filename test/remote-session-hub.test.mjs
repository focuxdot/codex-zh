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

// 模拟 client
function mockClient() {
  return { live: [], approvals: [],
    pushLiveEvent(sessionId, method, params) { this.live.push({ sessionId, method, params }); },
    pushApproval(key, sessionId, method, params) { this.approvals.push({ key, sessionId, method, params }); },
  };
}

test("发消息：首次 resume + turn/start，重复发不再 resume", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const client = mockClient();
  await hub.sendMessage("thr-1", "你好", client);
  await hub.sendMessage("thr-1", "再来一句", client);
  const resumes = server.calls.filter((c) => c[0] === "resume");
  const turns = server.calls.filter((c) => c[0] === "turn");
  assert.equal(resumes.length, 1, "只 resume 一次");
  assert.equal(turns.length, 2, "两次都发 turn");
});

test("停止：无进行中轮次返回 false；有则 interrupt", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  assert.equal((await hub.interrupt("thr-x")).ok, false);
  await hub.sendMessage("thr-x", "跑", mockClient()); // turnId=t-1
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
  assert.equal(a.live[0].method, "turn/started");
});

test("审批路由到操作权持有者，决策回传 app-server", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const owner = mockClient();
  hub.subscribe("thr-1", owner);
  await hub.sendMessage("thr-1", "做事", owner); // owner 取得操作权
  server.emitServerRequest(42, "item/commandExecution/requestApproval", {
    threadId: "thr-1", command: ["rm", "-rf", "x"], cwd: "/tmp",
  });
  assert.equal(owner.approvals.length, 1);
  const key = owner.approvals[0].key;
  const res = hub.respondApproval(key, "accept", owner);
  assert.equal(res.ok, true);
  assert.deepEqual(server.responses.at(-1), ["ok", 42, { decision: "accept" }]);
  // 重复决策失败
  assert.equal(hub.respondApproval(key, "accept", owner).ok, false);
});

test("非操作权设备不能决策审批", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const owner = mockClient(); const other = mockClient();
  hub.subscribe("thr-1", owner);
  hub.subscribe("thr-1", other);
  await hub.sendMessage("thr-1", "做事", owner);
  server.emitServerRequest(7, "execCommandApproval", { threadId: "thr-1", command: ["ls"] });
  const key = owner.approvals[0].key;
  assert.equal(hub.respondApproval(key, "accept", other).ok, false, "他人不能决策");
  assert.equal(hub.respondApproval(key, "accept", owner).ok, true);
});

test("非审批服务端请求回默认错误，避免 app-server 卡死", () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  server.emitServerRequest(99, "some/otherRequest", { threadId: "thr-1" });
  assert.equal(server.responses.at(-1)[0], "err");
  assert.equal(server.responses.at(-1)[1], 99);
});

test("client 断开清理订阅与操作权", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const client = mockClient();
  hub.subscribe("thr-1", client);
  await hub.sendMessage("thr-1", "x", client);
  hub.removeClient(client);
  // 断开后事件不再推送
  server.emitNotification("turn/started", { threadId: "thr-1", turn: { id: "t" } });
  assert.equal(client.live.length, 0);
});

test("新建会话透传 cwd 并返回 threadId", async () => {
  const server = mockAppServer();
  const hub = new SessionHub(server);
  const res = await hub.newThread("/Users/me/proj");
  assert.equal(res.threadId, "new-1");
  assert.deepEqual(server.calls.at(-1), ["start", { cwd: "/Users/me/proj" }]);
});
