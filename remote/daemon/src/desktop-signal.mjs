// Desktop refresh signal.
//
// The desktop Codex GUI can't see turns the phone drove, because those run
// through the daemon's *separate* app-server and the GUI caches conversations in
// memory (it only re-fetches thread/turns/list on first load). The daemon is the
// one process that knows, unambiguously, when a remote-driven turn completed and
// on which thread — the desktop's own turns never touch the daemon's app-server.
//
// So on every turn/completed the daemon writes this tiny signal file. The patched
// desktop bundle (see scripts/lib/remote-refresh-inject.mjs) watches it and shows
// a one-click "refresh" banner. This avoids sniffing the desktop app-server's
// MessagePort transport entirely, and can't fire for the user's own desktop turns.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function desktopSignalPath(home = homedir()) {
  return path.join(home, ".codex-zh", "remote", "desktop-refresh.json");
}

// Writes { threadId, name, at }. Best-effort: never throws (a signal-write
// failure must not break turn handling). Returns the path on success, else null.
export function writeDesktopRefreshSignal({ threadId, name = "" } = {}, { home = homedir(), now = Date.now } = {}) {
  if (!threadId) return null;
  const file = desktopSignalPath(home);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ threadId, name: name || "", at: now() }));
    return file;
  } catch {
    return null;
  }
}

// Reads the signal back (used by tests / diagnostics). Returns null if absent/invalid.
export function readDesktopRefreshSignal({ home = homedir() } = {}) {
  try {
    return JSON.parse(readFileSync(desktopSignalPath(home), "utf8"));
  } catch {
    return null;
  }
}
