// Node backend for the native macOS config window (CodexZhConfig.swift).
//
// The Swift window is a pure view: it shells out to this CLI for the preset list,
// the live connection test, and the save, so all provider/config logic stays in
// the shared src/* modules and never gets duplicated in Swift.
//
// Subcommands (all read/write JSON):
//   presets <codexHome>            -> { presets:[...], current:{...}|null, defaultId }
//   test    <inputFile>            -> { ok, message }
//   save    <inputFile> <codexHome>-> { ok, message }

import { readFileSync } from "node:fs";
import process from "node:process";
import { PROVIDER_PRESETS } from "../../src/provider-presets.mjs";
import { testProviderConnection } from "../../src/provider-test.mjs";
import { buildCodexConfig } from "../../src/codex-config.mjs";
import { writeMergedCodexConfig, parseTomlSections } from "../../src/config-merge.mjs";
import { saveActiveProfile, profileFromProviderInput, loadProfiles } from "../../src/profile-store.mjs";
import path from "node:path";

const [command, ...rest] = process.argv.slice(2);

function out(value) {
  process.stdout.write(JSON.stringify(value));
}

function tomlValue(lines, key) {
  for (const line of lines) {
    const m = String(line).match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "u"));
    if (m) return m[1];
  }
  return "";
}

function currentConfig(codexHome) {
  const configPath = path.join(path.resolve(codexHome), "config.toml");
  let text = "";
  try { text = readFileSync(configPath, "utf8"); } catch { return null; }
  const sections = parseTomlSections(text);
  const root = sections.find((s) => s.name === "");
  if (!root) return null;
  const provider = tomlValue(root.lines, "model_provider");
  const model = tomlValue(root.lines, "model");
  if (!provider) return null;
  const ps = sections.find((s) => s.name === `model_providers.${provider}`);
  if (!ps) return null;
  const baseUrl = tomlValue(ps.lines, "base_url");
  const apiKey = tomlValue(ps.lines, "experimental_bearer_token");
  const wireApi = tomlValue(ps.lines, "wire_api") || "responses";
  const providerName = tomlValue(ps.lines, "name") || provider;
  if (!baseUrl || !apiKey || !model || wireApi !== "responses") return null;
  return { provider, providerName, baseUrl, model, wireApi, apiKey };
}

function buildPresets(codexHome) {
  const presets = [];
  const seen = new Set();
  for (const [id, p] of Object.entries(PROVIDER_PRESETS)) {
    presets.push({
      id,
      provider: p.provider,
      providerName: p.providerName ?? p.provider,
      baseUrl: p.baseUrl ?? "",
      model: p.model ?? "",
      wireApi: p.wireApi ?? "responses",
      apiKey: p.apiKey ?? "",
    });
    seen.add(id);
  }
  try {
    for (const profile of loadProfiles(codexHome).profiles) {
      if (!profile?.id || seen.has(profile.id)) continue;
      presets.push({
        id: profile.id,
        provider: profile.provider ?? profile.id,
        providerName: profile.name ?? profile.id,
        baseUrl: profile.baseUrl ?? "",
        model: profile.model ?? "",
        wireApi: profile.wireApi ?? "responses",
        apiKey: "",
      });
      seen.add(profile.id);
    }
  } catch {
    // ignore malformed profile store
  }
  return presets;
}

async function main() {
  if (command === "presets") {
    const codexHome = rest[0] || process.env.CODEX_HOME || "";
    out({ presets: buildPresets(codexHome), current: currentConfig(codexHome), defaultId: "wokey" });
    return;
  }

  if (command === "test") {
    const input = JSON.parse(readFileSync(rest[0], "utf8"));
    try {
      const result = await testProviderConnection({
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        model: input.model,
        wireApi: input.wireApi || "responses",
      });
      if (result.ok) {
        out({ ok: true, message: "连接测试通过。" });
      } else {
        const detail = [result.error, result.suggestion].filter(Boolean).join("　");
        out({ ok: false, message: `连接测试失败：${detail}` });
      }
    } catch (error) {
      out({ ok: false, message: `连接测试失败：${error instanceof Error ? error.message : String(error)}` });
    }
    return;
  }

  if (command === "save") {
    const input = JSON.parse(readFileSync(rest[0], "utf8"));
    const codexHome = rest[1] || process.env.CODEX_HOME || "";
    try {
      const desiredConfig = buildCodexConfig(input); // validates all fields
      writeMergedCodexConfig({ codexHome, desiredConfig });
      saveActiveProfile({ codexHome, profile: profileFromProviderInput(input) });
      out({ ok: true, message: "已保存配置。" });
    } catch (error) {
      out({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  out({ ok: false, message: `unknown command: ${command}` });
  process.exit(2);
}

main().catch((error) => {
  out({ ok: false, message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
