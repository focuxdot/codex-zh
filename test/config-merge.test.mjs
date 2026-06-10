import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexConfig } from "../src/codex-config.mjs";
import { mergeCodexConfig, writeMergedCodexConfig } from "../src/config-merge.mjs";
import { loadProfiles, profileFromProviderInput, saveActiveProfile } from "../src/profile-store.mjs";

test("mergeCodexConfig updates managed provider fields and preserves unrelated settings", () => {
  const existing = [
    "# user setting",
    'approval_policy = "on-request"',
    'model = "old-model"',
    'model_provider = "old"',
    "",
    "[model_providers.old]",
    'name = "Old"',
    'base_url = "https://old.example.com/v1"',
    'wire_api = "chat"',
    'experimental_bearer_token = "old-key"',
    'extra = "keep"',
    "",
    "[tools]",
    "web_search = true",
    "",
  ].join("\n");
  const desired = buildCodexConfig({
    apiKey: "sk-new",
    baseUrl: "https://relay.example.com/v1",
    model: "new-model",
    provider: "relay",
    providerName: "Relay",
    wireApi: "responses",
  });

  const merged = mergeCodexConfig(existing, desired);

  assert.match(merged, /# user setting/u);
  assert.match(merged, /approval_policy = "on-request"/u);
  assert.match(merged, /model = "new-model"/u);
  assert.match(merged, /model_provider = "relay"/u);
  assert.match(merged, /\[model_providers\.old\][\s\S]*extra = "keep"/u);
  assert.match(merged, /\[model_providers\.relay\][\s\S]*base_url = "https:\/\/relay\.example\.com\/v1"/u);
  assert.match(merged, /\[tools\][\s\S]*web_search = true/u);
  assert.match(merged, /\[desktop\][\s\S]*conversationDetailMode = "STEPS_COMMANDS"/u);
});

test("writeMergedCodexConfig backs up existing config before writing", () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-zh-config-"));
  const configPath = path.join(codexHome, "config.toml");
  writeFileSync(configPath, 'model = "old"\ncustom = true\n', "utf8");
  const desired = buildCodexConfig({
    apiKey: "sk-new",
    baseUrl: "https://relay.example.com/v1",
    model: "new-model",
    provider: "relay",
    providerName: "Relay",
    wireApi: "responses",
  });

  const result = writeMergedCodexConfig({
    codexHome,
    desiredConfig: desired,
    now: new Date(2026, 4, 28, 9, 7, 6),
  });

  assert.equal(result.configPath, configPath);
  assert.equal(result.backupPath, path.join(codexHome, "config.toml.bak-20260528-090706"));
  assert.equal(readFileSync(result.backupPath, "utf8"), 'model = "old"\ncustom = true\n');
  const written = readFileSync(configPath, "utf8");
  assert.match(written, /model = "new-model"/u);
  assert.match(written, /custom = true/u);
});

test("profile store writes switchable metadata under codex-zh without duplicating the API key", () => {
  const codexHome = mkdtempSync(path.join(tmpdir(), "codex-zh-profile-"));
  const input = {
    apiKey: "sk-secret",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4.1",
    provider: "openrouter",
    providerName: "OpenRouter",
    wireApi: "responses",
  };
  const profile = {
    ...profileFromProviderInput(input),
    apiKeySource: "config",
    lastTest: { checkedAt: "2026-05-28T00:00:00Z", ok: true },
  };

  const result = saveActiveProfile({
    codexHome,
    now: new Date("2026-05-28T00:00:00Z"),
    profile,
  });
  const saved = loadProfiles(codexHome);
  const raw = readFileSync(result.path, "utf8");

  assert.equal(saved.activeProfileId, "openrouter");
  assert.equal(saved.profiles[0].name, "OpenRouter");
  assert.equal(saved.profiles[0].baseUrl, "https://openrouter.ai/api/v1");
  assert.doesNotMatch(raw, /sk-secret/u);
});
