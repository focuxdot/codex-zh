// Remote external-session refresh (approach B) — asar injection.
//
// When the phone (via the Remote daemon's separate app-server) writes a turn to
// a shared rollout file, the desktop GUI never re-fetches it: the renderer caches
// conversations in memory and only issues thread/turns/list on first load. But an
// already-loaded app-server DOES return the external turn on a fresh
// thread/turns/list (it reads the shared SQLite store — verified), so a plain
// reload of the renderer surfaces the phone's changes.
//
// Two stable-named injection points (no content hash, same on mac/windows):
//   1. .vite/build/bootstrap.js — the Electron main entry (full Node): fs.watch
//      the sessions dir; on any rollout change, derive the threadId from the file
//      name and broadcast codexzh:session-changed to every window.
//   2. .vite/build/preload.js — the sandboxed renderer bridge (no fs): all
//      app-server JSON-RPC flows through D.sendWorkerMessageFromView /
//      subscribeToWorkerMessages, so wrap them to learn the current threadId and
//      suppress the window's OWN turns (recent turn/ or item/ activity for that
//      thread). On a genuinely external change, show a one-click refresh banner.
//
// Both functions follow the customizer contract: return { name, count }; count 0
// means "did not match" and makes the customizer fail loudly on drift. An
// already-injected file (marker present) returns count 1 (idempotent).
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARKER = "CODEXZH_EXTERNAL_SESSION_REFRESH";

export function patchRemoteExternalSessionRefreshMain(root) {
  const name = "remote external-session refresh (main watcher)";
  const buildDir = path.join(root, ".vite", "build");
  const file = findElectronBuildFile(buildDir, /^bootstrap(?:-[^.]+)?\.js$/u);
  if (!file) {
    return { name, count: 0 };
  }
  const text = readFileSync(file, "utf8");
  if (text.includes(MARKER)) {
    return { name, count: 1 };
  }
  // Drift guard: bootstrap.js is the Electron main entry; it must require electron.
  if (!text.includes("require(`electron`)") && !text.includes('require("electron")')) {
    return { name, count: 0 };
  }
  writeFileSync(file, text + mainSnippet());
  return { name, count: 1 };
}

export function patchRemoteExternalSessionRefreshPreload(root) {
  const name = "remote external-session refresh (preload banner)";
  const file = path.join(root, ".vite", "build", "preload.js");
  if (!existsSync(file)) {
    return { name, count: 0 };
  }
  const text = readFileSync(file, "utf8");
  if (text.includes(MARKER)) {
    return { name, count: 1 };
  }
  const anchorPattern = /([A-Za-z_$][\w$]*\.contextBridge\.exposeInMainWorld\(`electronBridge`,[A-Za-z_$][\w$]*\))/u;
  const anchor = text.match(anchorPattern)?.[1];
  if (!anchor) {
    return { name, count: 0 };
  }
  writeFileSync(file, text.split(anchor).join(preloadSnippet() + anchor));
  return { name, count: 1 };
}

function findElectronBuildFile(buildDir, basenamePattern) {
  if (!existsSync(buildDir)) return "";
  const candidates = readdirSync(buildDir)
    .filter((name) => basenamePattern.test(name))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  for (const basename of candidates) {
    const file = path.join(buildDir, basename);
    const text = readFileSync(file, "utf8");
    if (text.includes("require(`electron`)") || text.includes('require("electron")')) {
      return file;
    }
  }
  return "";
}

function mainSnippet() {
  return `
;/* ${MARKER} main: 手机 daemon 写 desktop-refresh.json 时，通知渲染进程弹「刷新」横幅 */
(function () {
  try {
    var electron = require("electron");
    var app = electron.app;
    var BrowserWindow = electron.BrowserWindow;
    if (!app || !BrowserWindow) return;
    var fs = require("node:fs");
    var nodePath = require("node:path");
    var os = require("node:os");
    var dir = nodePath.join(os.homedir(), ".codex-zh", "remote");
    var signalFile = nodePath.join(dir, "desktop-refresh.json");
    // Opt-in debug: writes nothing unless ~/.codex-zh/remote/refresh-debug.on exists.
    function dbgOn() { try { return fs.existsSync(nodePath.join(dir, "refresh-debug.on")); } catch (e) { return false; } }
    function dlog(s) {
      if (!dbgOn()) return;
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      try { fs.appendFileSync(nodePath.join(dir, "refresh-debug.log"), "[" + new Date().toISOString() + "][main] " + s + "\\n"); } catch (e) {}
    }
    try {
      electron.ipcMain.on("codexzh:refresh-debug", function (_e, line) {
        if (!dbgOn()) return;
        try { fs.appendFileSync(nodePath.join(dir, "refresh-debug.log"), "[" + new Date().toISOString() + "][preload] " + String(line) + "\\n"); } catch (e) {}
      });
    } catch (e) {}
    // location.reload() from the sandboxed preload world is unreliable; the
    // renderer asks the main process to reload its own webContents instead.
    // The renderer registers a beforeunload listener that cancels navigation,
    // which silently blocks reload() AND a main-world location.reload() (observed:
    // do-reload + execJS both report ok, yet the page never re-mounts). Electron
    // surfaces that veto as 'will-prevent-unload'; calling preventDefault() on it
    // lets the reload proceed. Patch each webContents once.
    var unloadOverridden = (typeof WeakSet !== "undefined") ? new WeakSet() : null;
    function allowUnload(wc) {
      try {
        if (unloadOverridden) { if (unloadOverridden.has(wc)) return; unloadOverridden.add(wc); }
        wc.on("will-prevent-unload", function (e) { try { e.preventDefault(); dlog("do-reload allow unload"); } catch (x) {} });
      } catch (x) {}
    }
    function reloadAll(reason) {
      try {
        var all = electron.webContents.getAllWebContents();
        dlog("reloadAll(" + reason + ") count=" + all.length);
        for (var i = 0; i < all.length; i++) {
          var w = all[i];
          try {
            var t = w.getType();
            var u = String(w.getURL());
            // Reload only content webContents; never devtools/background hosts.
            if (t === "backgroundPage" || t === "remote" || t === "offscreen" || u.indexOf("devtools://") === 0) continue;
            allowUnload(w);
            w.reload();
            dlog("  reloaded id=" + w.id + " type=" + t + " isLoading=" + w.isLoading());
          } catch (e) { dlog("  wc err " + (e && e.message)); }
        }
      } catch (e) { dlog("reloadAll err " + (e && e.message)); }
    }
    try {
      electron.ipcMain.on("codexzh:do-reload", function (ev) {
        dlog("do-reload");
        // Defer off the IPC dispatch tick: reloading synchronously while handling
        // a message FROM this webContents races with the renderer's in-flight
        // click handling and the reload gets cancelled. A 0ms hop fixes it.
        setTimeout(function () { reloadAll("ipc"); }, 0);
      });
    } catch (e) {}
    var lastAt = 0;
    var startAt = 0;
    function readSignal() { try { return JSON.parse(fs.readFileSync(signalFile, "utf8")); } catch (e) { return null; } }
    function onChange(ev, filename) {
      if (filename && String(filename).indexOf("desktop-refresh.json") === -1) return;
      var sig = readSignal();
      if (!sig || !sig.threadId || !sig.at || sig.at === lastAt) return;
      lastAt = sig.at;
      // Diagnostic hook: a signal with this threadId reloads every webContents
      // directly (no button click) so we can inspect the reload topology.
      if (sig.threadId === "__reloadtest__") { reloadAll("signal"); return; }
      // The banner is only meaningful while Codex is already running with stale
      // in-memory data. A change whose timestamp predates this launch is already
      // in the fresh page load, so never nag about it on startup.
      if (sig.at <= startAt) { dlog("ignore pre-startup signal at=" + sig.at + " startAt=" + startAt); return; }
      var wins = BrowserWindow.getAllWindows();
      dlog("signal thread=" + sig.threadId + " at=" + sig.at + " -> " + wins.length + " win");
      for (var i = 0; i < wins.length; i++) {
        try { wins[i].webContents.send("codexzh:session-changed", { threadId: sig.threadId, name: sig.name || "", at: sig.at }); } catch (e) {}
      }
    }
    function markFresh(reason) { startAt = Date.now(); dlog("baseline advanced (" + reason + ") startAt=" + startAt); }
    function watchWindowLoad(win) {
      try { win.webContents.on("did-finish-load", function () { markFresh("did-finish-load"); }); } catch (e) {}
    }
    function start() {
      startAt = Date.now();
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      // Ignore a signal written before this launch, so opening the app doesn't nag.
      var s0 = readSignal(); if (s0 && s0.at) lastAt = s0.at;
      // Anchor "data is fresh" to the renderer's actual load (initial + every
      // reload), so a change is only surfaced if it post-dates what's on screen.
      try {
        app.on("browser-window-created", function (_e, win) { watchWindowLoad(win); });
        var ws0 = BrowserWindow.getAllWindows();
        for (var j = 0; j < ws0.length; j++) watchWindowLoad(ws0[j]);
      } catch (e) {}
      try { fs.watch(dir, { persistent: true }, onChange); dlog("watch started: " + dir + " baseline=" + lastAt); }
      catch (e) { dlog("watch FAILED: " + (e && e.message)); }
    }
    if (app.isReady && app.isReady()) start();
    else app.whenReady().then(start).catch(function () {});
  } catch (e) {}
})();
`;
}

function preloadSnippet() {
  return `(function () {
    /* ${MARKER} preload: 收到 daemon 的会话更新信号时弹「刷新」横幅 */
    try {
      var lastAt = 0;
      var visible = false;
      function dlog(s) { try { e.ipcRenderer.send("codexzh:refresh-debug", s); } catch (ex) {} }
      e.ipcRenderer.on("codexzh:session-changed", function (_e, d) {
        try {
          if (!d || !d.at || d.at === lastAt) return;
          lastAt = d.at;
          dlog("recv session-changed thread=" + d.threadId + " at=" + d.at);
          queueBanner(d.name || "");
        } catch (ex) {}
      });
      dlog("banner listener installed");
      function queueBanner(name) {
        if (visible) return;
        if (typeof document !== "undefined" && document.body) showBanner(name);
        else if (typeof window !== "undefined") window.addEventListener("DOMContentLoaded", function () { showBanner(name); }, { once: true });
      }
      function removeAllBanners() {
        try {
          var nodes = document.querySelectorAll("[data-codexzh-refresh='1']");
          for (var i = 0; i < nodes.length; i++) { try { nodes[i].remove(); } catch (e) {} }
        } catch (e) {}
      }
      function dismiss() { removeAllBanners(); visible = false; dlog("banner dismissed"); }
      function doReload() {
        dlog("refresh clicked");
        // Primary: ask main to reload this webContents (works from the sandbox).
        try { e.ipcRenderer.send("codexzh:do-reload"); } catch (ex) {}
        // Fallbacks in case IPC is unavailable.
        try { window.location.reload(); return; } catch (ex) {}
        try { location.reload(); } catch (ex) {}
      }
      function showBanner(name) {
        if (typeof document === "undefined" || !document.body) return;
        // Guard against a stale/duplicate bar hiding under a new one.
        removeAllBanners();
        visible = true;
        dlog("banner shown");
        // Adapt to the system appearance (dark vs light). Amber accent works on
        // both; only the surface/text/border colors flip.
        var dark = true;
        try { dark = (typeof window === "undefined" || !window.matchMedia) ? true : window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) {}
        var P = dark
          ? { bg: "rgba(30,30,34,0.94)", fg: "#f9fafb", border: "rgba(255,255,255,.10)", shadow: "0 6px 24px rgba(0,0,0,.34)", close: "#9ca3af" }
          : { bg: "rgba(255,255,255,0.97)", fg: "#1f2937", border: "rgba(0,0,0,.08)", shadow: "0 8px 26px rgba(0,0,0,.16)", close: "#6b7280" };
        var bar = document.createElement("div");
        bar.setAttribute("data-codexzh-refresh", "1");
        // A compact top-center toast (not a full-width top:0 bar, which would sit
        // over the macOS traffic-light buttons). -webkit-app-region:no-drag is
        // CRITICAL on the bar and buttons: otherwise macOS eats clicks over the
        // draggable title-bar strip as window-drag gestures.
        bar.style.cssText = "-webkit-app-region:no-drag;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;max-width:92vw;padding:8px 10px 8px 14px;border-radius:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:13px;line-height:18px;color:" + P.fg + ";background:" + P.bg + ";box-shadow:" + P.shadow + ";border:1px solid " + P.border + "";
        var dot = document.createElement("span");
        dot.style.cssText = "flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.18)";
        var msg = document.createElement("span");
        msg.style.cssText = "flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        msg.textContent = name ? ("会话「" + name + "」已被手机远程更新") : "有会话已被手机远程更新";
        var refresh = document.createElement("button");
        refresh.type = "button";
        refresh.textContent = "刷新查看";
        refresh.style.cssText = "-webkit-app-region:no-drag;flex:0 0 auto;cursor:pointer;border:0;border-radius:8px;padding:5px 12px;font-size:13px;font-weight:600;background:#f59e0b;color:#1c1c20";
        refresh.addEventListener("click", function (ev) {
          try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
          // Brief feedback so the reload flash reads as intentional.
          try { msg.textContent = "正在刷新…"; refresh.disabled = true; refresh.style.opacity = "0.6"; refresh.style.cursor = "default"; } catch (e) {}
          doReload();
        }, true);
        var close = document.createElement("button");
        close.type = "button";
        close.textContent = "\\u00d7";
        close.style.cssText = "-webkit-app-region:no-drag;flex:0 0 auto;cursor:pointer;border:0;background:transparent;font-size:16px;line-height:1;color:" + P.close + ";padding:2px 6px";
        close.addEventListener("click", function (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {} dismiss(); }, true);
        bar.appendChild(dot); bar.appendChild(msg); bar.appendChild(refresh); bar.appendChild(close);
        document.body.appendChild(bar);
      }
    } catch (e) {}
  })(),`;
}
