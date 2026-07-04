// Relay configuration wizard entry point.
//
// Shows the native macOS config window (CodexZhConfig, compiled from
// CodexZhConfig.swift) and returns its outcome. The window is a pure view; it
// calls back into wizard-backend.mjs (which reuses src/*) for the preset list,
// connection test, and save. Returns "launch" | "saved" | "skip" | "cancel".

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveWizardBinary() {
  if (process.env.CODEX_ZH_WIZARD_BIN) return process.env.CODEX_ZH_WIZARD_BIN;
  // In the bundle: Contents/Resources/codex-zh/{launcher/mac, bin/CodexZhConfig}
  return path.resolve(here, "..", "..", "bin", "CodexZhConfig");
}

export async function runWizard({ codexHome }) {
  const wizardBin = resolveWizardBinary();
  const backend = path.join(here, "wizard-backend.mjs");
  if (!existsSync(wizardBin)) {
    // Without the compiled window there is nothing to prompt with; skip so a valid
    // existing config can still launch, rather than blocking the user.
    return "skip";
  }
  try {
    const stdout = execFileSync(wizardBin, [process.execPath, backend, codexHome], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const outcome = stdout.trim().split(/\r?\n/u).pop();
    return ["launch", "saved", "skip", "cancel"].includes(outcome) ? outcome : "cancel";
  } catch {
    return "cancel";
  }
}
