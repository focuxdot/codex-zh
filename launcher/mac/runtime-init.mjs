// macOS runtime initialization for the Codex-ZH launcher.
//
// Port of the Windows launcher's Initialize-CodexZhRuntime: seed Codex desktop
// defaults, stage the bundled plugin marketplace into the Codex home, register it
// in config.toml, enable the bundled Computer Use plugin, and clear stale Electron
// renderer caches so a freshly patched app.asar takes effect.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveOfficialCodexHome } from "../../src/config-merge.mjs";

export function macCodexPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const codexHome = resolveOfficialCodexHome(env);
  const appSupport = path.join(home, "Library", "Application Support", "Codex");
  return {
    home,
    codexHome,
    codexZhDir: path.join(codexHome, "codex-zh"),
    capabilitiesFile: path.join(codexHome, "codex-zh", "capabilities.json"),
    globalStateFile: path.join(codexHome, ".codex-global-state.json"),
    configPath: path.join(codexHome, "config.toml"),
    runtimeMarketplace: path.join(codexHome, ".tmp", "bundled-marketplaces", "openai-bundled"),
    electronUserData: appSupport,
    electronCacheRoots: [appSupport, path.join(home, "Library", "Caches", "Codex")],
  };
}

const RENDERER_CACHE_DIRS = [
  "Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache", "Service Worker",
];

function writeFileUtf8(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value, "utf8");
}

function isValidJson(text) {
  try { JSON.parse(text); return true; } catch { return false; }
}

function defaultGlobalStateJson() {
  const state = {
    "electron-persisted-atom-state": {
      "seen-model-upgrade-list": ["gpt-5.5"],
      "electron:onboarding-hide-first-new-thread-promos": true,
    },
  };
  return JSON.stringify(state) + "\n";
}

export function saveCodexDesktopDefaults(paths, now = new Date()) {
  mkdirSync(paths.codexHome, { recursive: true });
  const file = paths.globalStateFile;
  if (!existsSync(file)) {
    writeFileUtf8(file, defaultGlobalStateJson());
    return;
  }
  const text = readFileSync(file, "utf8");
  if (!isValidJson(text)) {
    const stamp = now.toISOString().replace(/[:.]/gu, "-");
    cpSync(file, `${file}.invalid-json-${stamp}.bak`);
    writeFileUtf8(file, defaultGlobalStateJson());
    return;
  }
  const state = JSON.parse(text);
  const atom = state["electron-persisted-atom-state"] ?? {};
  atom["seen-model-upgrade-list"] = ["gpt-5.5"];
  atom["electron:onboarding-hide-first-new-thread-promos"] = true;
  state["electron-persisted-atom-state"] = atom;
  writeFileUtf8(file, JSON.stringify(state) + "\n");
}

export function ensureBundledMarketplace(paths, sourceMarketplace) {
  if (!sourceMarketplace || !existsSync(sourceMarketplace)) {
    return { browser: false, chrome: false, computerUse: false, plugins: [] };
  }
  const runtimePlugins = path.join(paths.runtimeMarketplace, "plugins");
  const runtimeAgents = path.join(paths.runtimeMarketplace, ".agents", "plugins");
  mkdirSync(runtimePlugins, { recursive: true });
  mkdirSync(runtimeAgents, { recursive: true });

  const sourcePlugins = path.join(sourceMarketplace, "plugins");
  if (existsSync(sourcePlugins)) {
    for (const entry of readdirSync(sourcePlugins, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = path.join(runtimePlugins, entry.name);
      rmSync(target, { force: true, recursive: true });
      cpSync(path.join(sourcePlugins, entry.name), target, { recursive: true });
    }
  }

  const sourceMarketplaceFile = path.join(sourceMarketplace, ".agents", "plugins", "marketplace.json");
  if (existsSync(sourceMarketplaceFile)) {
    const text = readFileSync(sourceMarketplaceFile, "utf8").replace(/^﻿/u, "");
    writeFileUtf8(path.join(runtimeAgents, "marketplace.json"), text);
  }

  const plugins = existsSync(runtimePlugins)
    ? readdirSync(runtimePlugins, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const capabilities = {
    authMode: "codex-zh-profile",
    browser: plugins.includes("browser"),
    chrome: plugins.includes("chrome"),
    computerUse: plugins.includes("computer-use") || plugins.includes("computer_use"),
    marketplace: { plugins, runtime: paths.runtimeMarketplace, source: sourceMarketplace },
    network: true,
    source: "codex-zh-bundled",
    version: 1,
  };
  writeFileUtf8(paths.capabilitiesFile, JSON.stringify(capabilities, null, 2) + "\n");
  return capabilities;
}

function tomlLiteral(value) {
  return "'" + String(value).replace(/'/gu, "''") + "'";
}

// Replace an existing [section] block or append it, without touching other sections.
// Index-based (not regex) so section names with quotes/dots are handled literally.
export function upsertTomlSection(configPath, sectionName, body) {
  const header = `[${sectionName}]`;
  const block = `${header}\n${body}`.trimEnd();
  if (!existsSync(configPath)) {
    writeFileUtf8(configPath, block + "\n");
    return;
  }
  const lines = readFileSync(configPath, "utf8").split(/\r?\n/u);
  const headerIdx = lines.findIndex((line) => line.trim() === header);
  if (headerIdx === -1) {
    writeFileUtf8(configPath, readFileSync(configPath, "utf8").trimEnd() + "\n\n" + block + "\n");
    return;
  }
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^\s*\[/u.test(lines[i])) { endIdx = i; break; }
  }
  const before = lines.slice(0, headerIdx).join("\n").trimEnd();
  const after = lines.slice(endIdx).join("\n").trim();
  const parts = [];
  if (before) parts.push(before);
  parts.push(block);
  if (after) parts.push(after);
  writeFileUtf8(configPath, parts.join("\n\n") + "\n");
}

export function ensureMarketplaceConfig(paths, now = new Date()) {
  const body = [
    `last_updated = "${now.toISOString().replace(/\.\d+Z$/u, "Z")}"`,
    'source_type = "local"',
    `source = ${tomlLiteral(paths.runtimeMarketplace)}`,
  ].join("\n");
  upsertTomlSection(paths.configPath, "marketplaces.openai-bundled", body);
}

export function ensureComputerUsePluginConfig(paths) {
  upsertTomlSection(paths.configPath, 'plugins."computer-use@openai-bundled"', "enabled = true");
}

export function clearElectronRendererCache(paths) {
  for (const root of paths.electronCacheRoots) {
    for (const name of RENDERER_CACHE_DIRS) {
      rmSync(path.join(root, name), { force: true, recursive: true });
    }
  }
}

// Run the full runtime init. sourceMarketplace is the inner Codex.app's bundled
// marketplace: <inner>/Contents/Resources/plugins/openai-bundled.
export function initializeRuntime({ paths, sourceMarketplace, now = new Date() }) {
  saveCodexDesktopDefaults(paths, now);
  const capabilities = ensureBundledMarketplace(paths, sourceMarketplace);
  ensureMarketplaceConfig(paths, now);
  if (capabilities.computerUse) {
    ensureComputerUsePluginConfig(paths);
  }
  clearElectronRendererCache(paths);
  return capabilities;
}
