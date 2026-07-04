// macOS Codex-ZH launcher orchestrator.
//
// Invoked by the outer Codex-ZH.app's Contents/MacOS/Codex-ZH bash entry. Mirrors
// the tail of the Windows launcher: optionally run the relay config wizard, run the
// runtime init, then launch the inner (patched) Codex.app with CODEX_HOME set.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseTomlSections } from "../../src/config-merge.mjs";
import { macCodexPaths, initializeRuntime } from "./runtime-init.mjs";
import { runWizard } from "./wizard.mjs";

const args = new Set(process.argv.slice(2));
const has = (...names) => names.some((n) => args.has(n));
const printResult = has("--print-result");

// This bundle IS the patched Codex.app. The app root is passed via env by the bash
// entry; fall back to resolving it from this file's location
// (<app>/Contents/Resources/codex-zh/launcher/mac).
const appRoot = process.env.CODEX_ZH_APP_ROOT
  || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..", "..");
const codexMain = path.join(appRoot, "Contents", "MacOS", "Codex");
const codexCli = path.join(appRoot, "Contents", "Resources", "codex");
const sourceMarketplace = path.join(appRoot, "Contents", "Resources", "plugins", "openai-bundled");

const paths = macCodexPaths(process.env);

function emit(result) {
  if (printResult) process.stdout.write(JSON.stringify(result) + "\n");
  return result;
}

function tomlValue(lines, key) {
  for (const line of lines) {
    const m = String(line).match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "u"));
    if (m) return m[1];
  }
  return "";
}

function hasValidRouterConfig() {
  if (!existsSync(paths.configPath)) return false;
  const sections = parseTomlSections(readFileSync(paths.configPath, "utf8"));
  const root = sections.find((s) => s.name === "");
  if (!root) return false;
  const provider = tomlValue(root.lines, "model_provider");
  const model = tomlValue(root.lines, "model");
  if (!provider || !model) return false;
  const providerSection = sections.find((s) => s.name === `model_providers.${provider}`);
  if (!providerSection) return false;
  const baseUrl = tomlValue(providerSection.lines, "base_url");
  const apiKey = tomlValue(providerSection.lines, "experimental_bearer_token");
  const wireApi = tomlValue(providerSection.lines, "wire_api") || "responses";
  return Boolean(baseUrl && apiKey && model && wireApi === "responses");
}

function isPromptDisabled() {
  const file = path.join(paths.codexZhDir, "launcher-settings.json");
  if (!existsSync(file)) return false;
  try {
    return JSON.parse(readFileSync(file, "utf8")).routerConfigPromptDisabled === true;
  } catch {
    return false;
  }
}

function launchCodex() {
  const env = { ...process.env, CODEX_HOME: paths.codexHome };
  delete env.CODEX_ELECTRON_USER_DATA_PATH;
  const child = spawn(codexMain, [], {
    cwd: path.dirname(codexMain),
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

// 每次启动 Codex 时顺带拉起菜单栏「远程接管」控制程序，作为不依赖配置窗口的
// 入口（已配置过中转站的用户不会再看到配置窗口，否则就够不到远程设置）。
// 菜单程序自带单实例锁，与启用后常驻的 LaunchAgent 版本不会重复。可选、不阻塞。
function spawnRemoteMenu() {
  try {
    const menuBin = path.join(appRoot, "Contents", "Resources", "codex-zh", "bin", "CodexZhRemoteMenu");
    const remoteBackend = path.join(appRoot, "Contents", "Resources", "codex-zh", "launcher", "mac", "remote-backend.mjs");
    if (!existsSync(menuBin)) return;
    const child = spawn(menuBin, [process.execPath, remoteBackend], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // 远程菜单是可选功能，绝不阻塞 Codex 启动
  }
}

async function main() {
  // Self-test: verify the in-bundle Codex is present and runnable, no launch.
  if (has("--self-test")) {
    let status = "ok";
    let reason = "";
    if (!existsSync(codexMain)) { status = "error"; reason = "codex_missing"; }
    else if (!existsSync(codexCli)) { status = "error"; reason = "codex_cli_missing"; }
    emit({ status, reason, appRoot, codexHome: paths.codexHome });
    process.exit(status === "ok" ? 0 : 1);
  }

  if (!existsSync(codexMain)) {
    emit({ status: "error", reason: "codex_missing", appRoot });
    process.exit(1);
  }

  // Prepare-only: init runtime without launching.
  if (has("--no-launch")) {
    initializeRuntime({ paths, sourceMarketplace });
    emit({ status: "ready", reason: "no_launch", codexHome: paths.codexHome });
    return;
  }

  const configure = has("--configure");
  const needWizard = configure
    || (!hasValidRouterConfig() && !has("--skip-config") && !isPromptDisabled());

  if (needWizard) {
    const outcome = await runWizard({ codexHome: paths.codexHome });
    // Launch only when the wizard saved+verified, or when the user chose to skip a
    // non-forced prompt. Cancel (or any other outcome) exits without launching.
    const shouldLaunch = outcome === "launch" || (!configure && outcome === "skip");
    if (!shouldLaunch) {
      emit({ status: "ready", reason: `configured_${outcome}`, codexHome: paths.codexHome });
      return;
    }
  }

  initializeRuntime({ paths, sourceMarketplace });
  launchCodex();
  spawnRemoteMenu();
  emit({ status: "launched", launched: true, codexHome: paths.codexHome, appRoot });
}

main().catch((error) => {
  emit({ status: "error", reason: "exception", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
