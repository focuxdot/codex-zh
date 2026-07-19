import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const LEGACY_REMOTE_LABELS = [
  "ai.wokey.codex-zh.remote",
  "ai.wokey.codex-zh.remote-menu",
];

export function cleanupLegacyRemote(overrides = {}) {
  const homeDir = overrides.homeDir || homedir();
  const uid = overrides.uid ?? (process.getuid ? process.getuid() : 501);
  const run = overrides.run || ((command, args) => spawnSync(command, args, { encoding: "utf8" }));
  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const removedPlists = [];
  const failedPlists = [];

  for (const label of LEGACY_REMOTE_LABELS) {
    // bootout stops the daemon/menu if loaded. remove is a harmless compatibility
    // fallback for older launchctl state where the domain-targeted call misses it.
    run("launchctl", ["bootout", `gui/${uid}/${label}`]);
    run("launchctl", ["remove", label]);

    const plist = path.join(launchAgentsDir, `${label}.plist`);
    if (existsSync(plist)) {
      try {
        rmSync(plist, { force: true });
        removedPlists.push(plist);
      } catch {
        // Legacy cleanup must never make the main desktop app unlaunchable.
        failedPlists.push(plist);
      }
    }
  }

  // v0.5.1 launched this menu directly rather than through launchd.
  run("pkill", ["-x", "CodexZhRemoteMenu"]);

  // Deliberately preserve ~/.codex-zh/remote: it is user-owned pairing/config
  // data and must not be destroyed automatically during an application upgrade.
  return { labels: [...LEGACY_REMOTE_LABELS], removedPlists, failedPlists };
}
