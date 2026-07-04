import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  patchRemoteExternalSessionRefreshMain,
  patchRemoteExternalSessionRefreshPreload,
} from "../scripts/lib/remote-refresh-inject.mjs";

const MARKER = "CODEXZH_EXTERNAL_SESSION_REFRESH";

// Minimal stand-ins for the real .vite/build files: they carry exactly the
// tokens the injectors anchor on (the electron require in bootstrap, the
// exposeInMainWorld(`electronBridge`,D) call in preload) plus the D worker
// bridge the preload sniffer wraps.
const FIXTURE_BOOTSTRAP =
  "const i=require(`electron`),a=require(`node:path`);let s=require(`node:fs`);\n" +
  "//# sourceMappingURL=bootstrap.js.map\n";

const FIXTURE_PRELOAD = [
  "let e=require(`electron`);",
  "var D={",
  "  windowType:`electron`,",
  "  sendWorkerMessageFromView:function(t,n){globalThis.__sendCalls.push([t,n]);return `sent`;},",
  "  subscribeToWorkerMessages:function(t,cb){globalThis.__subCb=cb;return function(){globalThis.__unsub=true;};},",
  "};",
  "e.ipcRenderer.on(`codex_desktop:message-for-view`,function(){});",
  "e.contextBridge.exposeInMainWorld(`codexWindowType`,`electron`),e.contextBridge.exposeInMainWorld(`electronBridge`,D);",
].join("\n");

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "cz-refresh-"));
  const build = join(root, ".vite", "build");
  mkdirSync(build, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(build, name), content);
  }
  return root;
}

function nodeCheck(file) {
  const res = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  return { ok: res.status === 0, stderr: res.stderr };
}

test("main watcher patch injects, is idempotent, and stays valid JS", () => {
  const root = makeRoot({ "bootstrap.js": FIXTURE_BOOTSTRAP });
  try {
    const first = patchRemoteExternalSessionRefreshMain(root);
    assert.equal(first.count, 1);
    const file = join(root, ".vite", "build", "bootstrap.js");
    const patched = readFileSync(file, "utf8");
    assert.ok(patched.includes(MARKER));
    assert.ok(patched.includes("codexzh:session-changed"));
    assert.ok(patched.includes("fs.watch"));
    const chk = nodeCheck(file);
    assert.ok(chk.ok, `bootstrap.js should be valid JS: ${chk.stderr}`);
    // Re-running must not double-inject.
    const second = patchRemoteExternalSessionRefreshMain(root);
    assert.equal(second.count, 1);
    assert.equal(readFileSync(file, "utf8"), patched);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main watcher patch fails loudly (count 0) when electron require is absent", () => {
  const root = makeRoot({ "bootstrap.js": "console.log('unexpected build');\n" });
  try {
    assert.equal(patchRemoteExternalSessionRefreshMain(root).count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preload patch injects before exposeInMainWorld and stays valid JS", () => {
  const root = makeRoot({ "preload.js": FIXTURE_PRELOAD });
  try {
    const res = patchRemoteExternalSessionRefreshPreload(root);
    assert.equal(res.count, 1);
    const file = join(root, ".vite", "build", "preload.js");
    const patched = readFileSync(file, "utf8");
    assert.ok(patched.includes(MARKER));
    // The sniffer IIFE must sit BEFORE the electronBridge exposure so the wrapped
    // D methods are the ones handed to the renderer.
    assert.ok(
      patched.indexOf("data-codexzh-refresh") <
        patched.indexOf("exposeInMainWorld(`electronBridge`,D)"),
    );
    const chk = nodeCheck(file);
    assert.ok(chk.ok, `preload.js should be valid JS: ${chk.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preload patch fails loudly (count 0) when the anchor is absent", () => {
  const root = makeRoot({ "preload.js": "let e=require(`electron`);var D={};\n" });
  try {
    assert.equal(patchRemoteExternalSessionRefreshPreload(root).count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Runtime behaviour of the injected preload sniffer/banner ----------------
//
// Execute the *patched* preload in a sandbox with fake electron + DOM, capture
// the exposed (wrapped) electronBridge, then drive app-server traffic + the
// session-changed IPC and assert when the refresh banner appears.

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.style = { cssText: "" };
    this.attrs = {};
    this.textContent = "";
    this.onclick = null;
    this.type = "";
    this.listeners = {};
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(n) { n.__parent = this; this.children.push(n); return n; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatch(type) {
    const ev = { preventDefault() {}, stopPropagation() {} };
    (this.listeners[type] || []).forEach((fn) => fn(ev));
    if (type === "click" && typeof this.onclick === "function") this.onclick(ev);
  }
  remove() {
    const p = this.__parent;
    if (p) { p.children = p.children.filter((c) => c !== this); this.__parent = null; }
  }
  // Only the [data-codexzh-refresh='1'] selector is ever used.
  querySelectorAll() {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (c.getAttribute && c.getAttribute("data-codexzh-refresh") === "1") out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

function runPatchedPreload() {
  const root = makeRoot({ "preload.js": FIXTURE_PRELOAD });
  try {
    assert.equal(patchRemoteExternalSessionRefreshPreload(root).count, 1);
    const src = readFileSync(join(root, ".vite", "build", "preload.js"), "utf8");

    const handlers = {};
    const exposed = {};
    const sent = [];
    const electron = {
      ipcRenderer: {
        on: (ch, fn) => { handlers[ch] = fn; },
        send: (ch, ...a) => { sent.push([ch, ...a]); },
        sendSync: () => ({}),
        invoke: async () => {},
        removeListener: () => {},
        postMessage: () => {},
      },
      contextBridge: { exposeInMainWorld: (name, obj) => { exposed[name] = obj; } },
      webUtils: { getPathForFile: () => null },
    };
    const body = new FakeNode("body");
    const documentFake = {
      body,
      createElement: (tag) => new FakeNode(tag),
      querySelectorAll: (sel) => body.querySelectorAll(sel),
    };
    const sandbox = {
      require: (id) => {
        if (id === "electron") return electron;
        throw new Error(`unexpected require(${id})`);
      },
      process: { platform: "darwin", arch: "arm64" },
      window: { addEventListener: () => {}, location: { reload: () => {} } },
      document: documentFake,
      location: { reload: () => {} },
      MessageEvent: class {},
      globalThis: {},
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(src, sandbox);

    assert.ok(exposed.electronBridge, "electronBridge must be exposed (anchor intact)");
    assert.ok(handlers["codexzh:session-changed"], "preload must register the session-changed listener");
    return {
      // Deliver a daemon desktop-refresh signal to the renderer.
      fireSignal: (sig) => handlers["codexzh:session-changed"]({}, sig),
      banner: () => body.children.find((c) => c.getAttribute("data-codexzh-refresh") === "1"),
      bannerText: () => {
        const bar = body.children.find((c) => c.getAttribute("data-codexzh-refresh") === "1");
        return bar ? bar.children.map((c) => c.textContent).join(" ") : null;
      },
      sent,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

test("a daemon signal shows the refresh banner, naming the thread", () => {
  const h = runPatchedPreload();
  try {
    assert.equal(h.banner(), undefined);
    h.fireSignal({ threadId: "abc", name: "重构登录流程", at: 1000 });
    const text = h.bannerText();
    assert.ok(text.includes("重构登录流程"), `banner should name the thread: ${text}`);
    assert.ok(text.includes("刷新查看"));
    // The bar must opt out of the window drag region or macOS eats button clicks.
    assert.ok(
      h.banner().style.cssText.includes("-webkit-app-region:no-drag"),
      "banner must set -webkit-app-region:no-drag",
    );
  } finally {
    h.cleanup();
  }
});

test("clicking 刷新查看 asks the main process to reload (not a bare location.reload)", () => {
  const h = runPatchedPreload();
  try {
    h.fireSignal({ threadId: "abc", name: "x", at: 1000 });
    h.banner().children.find((c) => c.textContent === "刷新查看").dispatch("click");
    assert.ok(
      h.sent.some((m) => m[0] === "codexzh:do-reload"),
      "refresh must send codexzh:do-reload IPC to main",
    );
  } finally {
    h.cleanup();
  }
});

test("a signal without a name falls back to a generic banner", () => {
  const h = runPatchedPreload();
  try {
    h.fireSignal({ threadId: "abc", name: "", at: 1000 });
    assert.ok(h.bannerText().includes("手机远程更新"));
  } finally {
    h.cleanup();
  }
});

test("the same signal 'at' does not re-show the banner (dedupe)", () => {
  const h = runPatchedPreload();
  try {
    h.fireSignal({ threadId: "abc", name: "x", at: 1000 });
    // dismiss it (click the × button)
    h.banner().children.find((c) => c.textContent === "×").dispatch("click");
    // a duplicate delivery of the SAME at must not re-open the banner
    h.fireSignal({ threadId: "abc", name: "x", at: 1000 });
    assert.equal(h.banner(), undefined);
    // but a NEW at (a later phone turn) shows it again
    h.fireSignal({ threadId: "abc", name: "x", at: 2000 });
    assert.ok(h.banner());
  } finally {
    h.cleanup();
  }
});
