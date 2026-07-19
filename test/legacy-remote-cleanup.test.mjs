import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupLegacyRemote, LEGACY_REMOTE_LABELS } from "../launcher/mac/legacy-remote-cleanup.mjs";

const macLauncher = readFileSync("launcher/mac/codex-zh-launcher.mjs", "utf8");
const macStaging = readFileSync("scripts/build-codex-zh-staging-mac.mjs", "utf8");

test("macOS launcher runs legacy Remote cleanup before runtime initialization", () => {
  const cleanupIndex = macLauncher.indexOf("cleanupLegacyRemote();");
  const initializeIndex = macLauncher.indexOf("initializeRuntime({ paths, sourceMarketplace });", cleanupIndex);
  assert.ok(cleanupIndex >= 0);
  assert.ok(initializeIndex > cleanupIndex);
});

test("macOS staging no longer bundles the legacy Remote daemon or menu", () => {
  assert.doesNotMatch(macStaging, /remoteSrc/u);
  assert.doesNotMatch(macStaging, /remote-backend/u);
  assert.doesNotMatch(macStaging, /CodexZhRemoteMenu/u);
  assert.match(macStaging, /\[\["CodexZhConfig", "CodexZhConfig"\]\]/u);
});

test("macOS launch cleanup unloads legacy Codex-ZH agents without deleting user data", () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "codex-zh-legacy-remote-"));
  const launchAgents = path.join(homeDir, "Library", "LaunchAgents");
  const remoteData = path.join(homeDir, ".codex-zh", "remote");
  mkdirSync(launchAgents, { recursive: true });
  mkdirSync(remoteData, { recursive: true });
  for (const label of LEGACY_REMOTE_LABELS) {
    writeFileSync(path.join(launchAgents, `${label}.plist`), label);
  }
  const configPath = path.join(remoteData, "daemon.json");
  writeFileSync(configPath, '{"preserve":true}\n');

  const calls = [];
  const result = cleanupLegacyRemote({
    homeDir,
    uid: 502,
    run: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(result.labels, LEGACY_REMOTE_LABELS);
  assert.equal(result.removedPlists.length, 2);
  assert.deepEqual(result.failedPlists, []);
  for (const label of LEGACY_REMOTE_LABELS) {
    assert.ok(calls.some((call) => call.join(" ") === `launchctl bootout gui/502/${label}`));
    assert.ok(calls.some((call) => call.join(" ") === `launchctl remove ${label}`));
  }
  assert.ok(calls.some((call) => call.join(" ") === "pkill -x CodexZhRemoteMenu"));
  assert.equal(readFileSync(configPath, "utf8"), '{"preserve":true}\n');
});
