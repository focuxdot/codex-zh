import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { PowerManager } from "../remote/daemon/src/power.mjs";
import { SessionHub } from "../remote/daemon/src/session-hub.mjs";

// 假 spawn：记录调用，返回可 kill 的假进程
function fakeSpawner() {
  const spawned = [];
  const spawn = (cmd, args) => {
    const proc = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.emit("exit", 0); };
    proc.cmd = cmd;
    proc.args = args;
    spawned.push(proc);
    return proc;
  };
  return { spawn, spawned };
}

test("PowerManager 各平台选对命令", () => {
  const win = new PowerManager({ platform: "win32" });
  assert.equal(win.inhibitorCommand()[0], "powershell");
  assert.match(win.inhibitorCommand()[1].join(" "), /SetThreadExecutionState/);
  const mac = new PowerManager({ platform: "darwin" });
  assert.deepEqual(mac.inhibitorCommand(), ["caffeinate", ["-i"]]);
  const linux = new PowerManager({ platform: "linux" });
  assert.equal(linux.inhibitorCommand()[0], "systemd-inhibit");
  const other = new PowerManager({ platform: "aix" });
  assert.equal(other.inhibitorCommand(), null);
});

test("acquire 幂等，release 结束子进程", () => {
  const { spawn, spawned } = fakeSpawner();
  const pm = new PowerManager({ platform: "darwin", spawn });
  pm.acquire();
  pm.acquire(); // 重复不应再 spawn
  assert.equal(spawned.length, 1);
  assert.equal(pm.active, true);
  pm.release();
  assert.equal(spawned[0].killed, true);
  assert.equal(pm.active, false);
  pm.release(); // 重复 release 安全
});

test("不支持的平台不 spawn，不抛错", () => {
  const { spawn, spawned } = fakeSpawner();
  const pm = new PowerManager({ platform: "aix", spawn });
  pm.acquire();
  assert.equal(spawned.length, 0);
  assert.equal(pm.active, false);
});

test("子进程意外退出后可再次 acquire", () => {
  const { spawn, spawned } = fakeSpawner();
  const pm = new PowerManager({ platform: "darwin", spawn });
  pm.acquire();
  spawned[0].emit("exit", 1); // 模拟命令不存在而退出
  assert.equal(pm.active, false);
  pm.acquire();
  assert.equal(spawned.length, 2);
});

// —— hub 唤醒状态切换 ——
function mockAppServer() {
  return {
    onNotification: () => {}, onServerRequest: () => {},
    resumeThread: () => Promise.resolve({}),
    startTurn: () => Promise.resolve({ turnId: "t-1" }),
    respond() {}, respondError() {},
    emit(m, p) { this.onNotification(m, p); },
  };
}
function mockClient() {
  return { pushApproval() {}, pushLiveEvent() {}, pushBoardChanged() {} };
}

test("有设备在线即保持清醒，全部离线则释放", () => {
  const changes = [];
  const hub = new SessionHub(mockAppServer(), { onAwakeChange: (w) => changes.push(w) });
  assert.equal(hub.shouldStayAwake(), false);
  const a = mockClient();
  hub.registerClient(a);
  assert.equal(hub.shouldStayAwake(), true);
  assert.deepEqual(changes, [true]);
  hub.removeClient(a);
  assert.deepEqual(changes, [true, false]);
});

test("无设备但有会话运行仍保持清醒", async () => {
  const server = mockAppServer();
  const changes = [];
  const hub = new SessionHub(server, { onAwakeChange: (w) => changes.push(w) });
  await hub.sendMessage("thr-1", "跑个任务"); // 无设备，但 turn 开始
  assert.equal(hub.shouldStayAwake(), true);
  assert.deepEqual(changes, [true]);
  server.emit("turn/completed", { threadId: "thr-1" });
  assert.equal(hub.shouldStayAwake(), false);
  assert.deepEqual(changes, [true, false]);
});

test("状态无变化不重复回调", () => {
  const changes = [];
  const hub = new SessionHub(mockAppServer(), { onAwakeChange: (w) => changes.push(w) });
  const a = mockClient(); const b = mockClient();
  hub.registerClient(a);
  hub.registerClient(b); // 仍是 awake，不应再回调
  assert.deepEqual(changes, [true]);
  hub.removeClient(a); // 还有 b，仍 awake
  assert.deepEqual(changes, [true]);
  hub.removeClient(b); // 全部离线
  assert.deepEqual(changes, [true, false]);
});
