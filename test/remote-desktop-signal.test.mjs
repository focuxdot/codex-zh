import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  desktopSignalPath,
  writeDesktopRefreshSignal,
  readDesktopRefreshSignal,
} from "../remote/daemon/src/desktop-signal.mjs";

function tmpHome() {
  return mkdtempSync(join(tmpdir(), "cz-signal-"));
}

test("writes the signal under ~/.codex-zh/remote/desktop-refresh.json", () => {
  const home = tmpHome();
  try {
    const file = writeDesktopRefreshSignal(
      { threadId: "019f-abc", name: "重构登录" },
      { home, now: () => 1234 },
    );
    assert.equal(file, desktopSignalPath(home));
    assert.ok(existsSync(file));
    const sig = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(sig, { threadId: "019f-abc", name: "重构登录", at: 1234 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readDesktopRefreshSignal round-trips; missing file -> null", () => {
  const home = tmpHome();
  try {
    assert.equal(readDesktopRefreshSignal({ home }), null);
    writeDesktopRefreshSignal({ threadId: "t1", name: "" }, { home, now: () => 7 });
    assert.deepEqual(readDesktopRefreshSignal({ home }), { threadId: "t1", name: "", at: 7 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("no threadId -> no write, returns null", () => {
  const home = tmpHome();
  try {
    assert.equal(writeDesktopRefreshSignal({ threadId: "" }, { home }), null);
    assert.equal(writeDesktopRefreshSignal({}, { home }), null);
    assert.equal(existsSync(desktopSignalPath(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("each write advances 'at' so the desktop watcher dedupes correctly", () => {
  const home = tmpHome();
  try {
    let t = 100;
    writeDesktopRefreshSignal({ threadId: "a" }, { home, now: () => (t += 5) });
    const first = readDesktopRefreshSignal({ home }).at;
    writeDesktopRefreshSignal({ threadId: "a" }, { home, now: () => (t += 5) });
    const second = readDesktopRefreshSignal({ home }).at;
    assert.ok(second > first);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
