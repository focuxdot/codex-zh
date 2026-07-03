import assert from "node:assert/strict";
import test from "node:test";

import { buildRequest, Notifier, redact } from "../remote/daemon/src/notify.mjs";
import { SessionHub } from "../remote/daemon/src/session-hub.mjs";

test("buildRequest：各 provider 的 URL 与载荷", () => {
  const bark = buildRequest({ type: "bark", key: "ABC123" }, "标题", "正文");
  assert.equal(bark.url, "https://api.day.app/ABC123");
  assert.deepEqual(JSON.parse(bark.init.body), { title: "标题", body: "正文", group: "Codex-ZH" });

  const barkSelf = buildRequest({ type: "bark", key: "K", server: "https://bark.me/" }, "t", "b");
  assert.equal(barkSelf.url, "https://bark.me/K");

  const sc = buildRequest({ type: "serverchan", key: "SCT9" }, "标题", "正文");
  assert.equal(sc.url, "https://sctapi.ftqq.com/SCT9.send");
  assert.deepEqual(JSON.parse(sc.init.body), { title: "标题", desp: "正文" });

  const wecom = buildRequest({ type: "wecom", url: "https://qyapi/x" }, "标题", "正文");
  assert.equal(wecom.url, "https://qyapi/x");
  assert.deepEqual(JSON.parse(wecom.init.body), { msgtype: "text", text: { content: "标题\n正文" } });

  const dingtalk = buildRequest({ type: "dingtalk", url: "https://oapi/x" }, "标题", "正文");
  assert.deepEqual(JSON.parse(dingtalk.init.body), { msgtype: "text", text: { content: "标题\n正文" } });

  const custom = buildRequest({ type: "custom", url: "https://h/x" }, "标题", "正文");
  assert.deepEqual(JSON.parse(custom.init.body), { title: "标题", body: "正文", source: "codex-zh-remote" });

  assert.equal(buildRequest({ type: "unknown" }, "t", "b"), null);
});

test("redact 不暴露完整 key/url", () => {
  assert.equal(redact({ type: "bark", key: "ABCDEFGH" }), "bark:ABCD…");
  assert.equal(redact({ type: "wecom", url: "https://qyapi.weixin.qq.com/x?key=secret" }), "wecom:qyapi.weixin.qq.com");
});

test("Notifier.send 向所有渠道发送，单个失败不影响其他", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.includes("fail")) throw new Error("network");
    return { ok: true, status: 200 };
  };
  const notifier = new Notifier(
    [{ type: "bark", key: "ok" }, { type: "custom", url: "https://fail/x" }, { type: "wecom", url: "https://w/x" }],
    { fetch, log: () => {} },
  );
  await notifier.send("标题", "正文");
  assert.equal(calls.length, 3);
  assert.ok(calls.some((c) => c.url.includes("api.day.app")));
});

test("Notifier 空配置不发送", async () => {
  let called = 0;
  const notifier = new Notifier([], { fetch: async () => (called++, { ok: true }) });
  await notifier.send("t", "b");
  assert.equal(called, 0);
});

test("通知内容脱敏：只含事件与会话名，不含命令原文", async () => {
  // 端到端：hub 审批事件 -> onEvent -> 构造的通知文案不含命令
  const server = {
    onNotification: () => {}, onServerRequest: () => {},
    respond() {}, respondError() {},
    emitServerRequest(id, m, p) { this.onServerRequest(id, m, p); },
  };
  const events = [];
  const hub = new SessionHub(server, { onEvent: (type, info) => events.push({ type, info }) });
  const secretCommand = ["rm", "-rf", "/secret/path"];
  server.emitServerRequest(1, "item/commandExecution/requestApproval", {
    threadId: "thr-1", command: secretCommand, cwd: "/secret",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "approval");
  assert.equal(events[0].info.sessionId, "thr-1");
  // hub 只传 sessionId，不传 command——通知层拿不到命令原文
  assert.equal(JSON.stringify(events[0]).includes("secret"), false);
});

test("hub 事件：审批总触发、任务完成带 clientsOnline", async () => {
  const server = {
    onNotification: () => {}, onServerRequest: () => {},
    resumeThread: () => Promise.resolve({}), startTurn: () => Promise.resolve({ turnId: "t" }),
    respond() {}, respondError() {},
    emit(m, p) { this.onNotification(m, p); },
    emitReq(id, m, p) { this.onServerRequest(id, m, p); },
  };
  const events = [];
  const hub = new SessionHub(server, { onEvent: (t, i) => events.push({ t, ...i }) });
  const client = { pushApproval() {}, pushLiveEvent() {}, pushBoardChanged() {} };
  hub.registerClient(client);
  server.emitReq(1, "execCommandApproval", { threadId: "s1" });
  server.emit("turn/completed", { threadId: "s1" });
  const approval = events.find((e) => e.t === "approval");
  const done = events.find((e) => e.t === "turnCompleted");
  assert.equal(approval.clientsOnline, 1);
  assert.equal(done.clientsOnline, 1);
});
