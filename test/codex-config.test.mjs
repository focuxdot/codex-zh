import assert from "node:assert/strict";
import test from "node:test";
import { buildCodexConfig, escapeToml, requireBaseUrl } from "../src/codex-config.mjs";
import { listProviderPresets, resolveProviderPreset } from "../src/provider-presets.mjs";

test("buildCodexConfig writes an OpenAI-compatible relay provider", () => {
  const config = buildCodexConfig({
    apiKey: "sk-test",
    baseUrl: "https://relay.example.com/v1/",
    model: "openai/gpt-4.1",
    provider: "relay_1",
    providerName: "Relay 1",
    wireApi: "responses",
  });

  assert.match(config, /model = "openai\/gpt-4\.1"/u);
  assert.match(config, /model_provider = "relay_1"/u);
  assert.match(config, /\[model_providers\.relay_1\]/u);
  assert.match(config, /base_url = "https:\/\/relay\.example\.com\/v1"/u);
  assert.match(config, /wire_api = "responses"/u);
  assert.match(config, /experimental_bearer_token = "sk-test"/u);
});

test("buildCodexConfig rejects unsafe provider ids", () => {
  assert.throws(
    () =>
      buildCodexConfig({
        apiKey: "sk-test",
        baseUrl: "https://relay.example.com/v1",
        model: "gpt-5-codex",
        provider: "relay.one",
      }),
    /provider must contain/u,
  );
});

test("buildCodexConfig rejects unsupported wire APIs", () => {
  assert.throws(
    () =>
      buildCodexConfig({
        apiKey: "sk-test",
        baseUrl: "https://relay.example.com/v1",
        model: "gpt-5-codex",
        provider: "relay",
        wireApi: "chat",
      }),
    /wireApi must be one of/u,
  );
});

test("requireBaseUrl trims trailing slashes and validates protocol", () => {
  assert.equal(requireBaseUrl("https://relay.example.com/v1///"), "https://relay.example.com/v1");
  assert.throws(() => requireBaseUrl("ftp://relay.example.com/v1"), /http or https/u);
});

test("escapeToml escapes strings safely", () => {
  assert.equal(escapeToml('a"b\\c\n'), 'a\\"b\\\\c\\n');
});

test("provider presets include common relay options", () => {
  assert.deepEqual(
    listProviderPresets(),
    ["wokey", "custom", "openrouter"],
  );
  assert.equal(resolveProviderPreset("openrouter").provider, "openrouter");
  assert.equal(resolveProviderPreset("openrouter").wireApi, "responses");
  assert.equal(resolveProviderPreset("wokey").baseUrl, "https://api.wokey.ai");
  assert.equal(resolveProviderPreset("wokey").model, "auto");
  assert.equal(resolveProviderPreset("wokey").apiKey, "sk-3d6c1264227a52f75af4028bcc3c217b");
  for (const name of listProviderPresets()) {
    assert.equal(resolveProviderPreset(name).wireApi, "responses");
  }
});

test("unknown provider preset fails with available presets", () => {
  assert.throws(() => resolveProviderPreset("missing"), /Available presets/u);
});
