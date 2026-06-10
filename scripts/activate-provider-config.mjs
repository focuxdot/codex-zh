#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildCodexConfig } from "../src/codex-config.mjs";
import { writeMergedCodexConfig, resolveOfficialCodexHome } from "../src/config-merge.mjs";
import { profileFromProviderInput, saveActiveProfile } from "../src/profile-store.mjs";
import { resolveProviderPreset } from "../src/provider-presets.mjs";

const usage = `Usage:
  node scripts/activate-provider-config.mjs \\
    [--codex-home <path>] \\
    [--preset custom|wokey|openrouter] \\
    [--provider <id>] \\
    [--provider-name <name>] \\
    [--base-url <url>] \\
    [--model <model>] \\
    [--wire-api responses] \\
    [--api-key <key> | --api-key-env <env-name> | --api-key-file <path>]
`;

try {
  const args = parseArgs(process.argv.slice(2));
  const preset = resolveProviderPreset(args.preset);
  const input = {
    apiKey: resolveApiKey(args, preset),
    baseUrl: args["base-url"] ?? preset.baseUrl,
    conversationDetailMode: args["conversation-detail-mode"],
    model: args.model ?? preset.model,
    provider: args.provider ?? preset.provider,
    providerName: args["provider-name"] ?? preset.providerName,
    reasoningEffort: args["reasoning-effort"],
    wireApi: args["wire-api"] ?? preset.wireApi,
  };
  const desiredConfig = buildCodexConfig(input);
  const codexHome = args["codex-home"]
    ? path.resolve(args["codex-home"])
    : resolveOfficialCodexHome();
  const writeResult = writeMergedCodexConfig({ codexHome, desiredConfig });
  const profileResult = saveActiveProfile({
    codexHome,
    profile: {
      ...profileFromProviderInput(input),
      apiKeySource: "config",
      lastTest: null,
    },
  });

  console.log(JSON.stringify({
    backupPath: writeResult.backupPath,
    codexHome: writeResult.codexHome,
    configPath: writeResult.configPath,
    profilePath: profileResult.path,
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(usage);
  process.exit(1);
}

function resolveApiKey(args, preset = {}) {
  const sources = ["api-key", "api-key-env", "api-key-file"].filter((key) => args[key]);
  if (sources.length === 0 && preset.apiKey) {
    return preset.apiKey;
  }
  if (sources.length !== 1) {
    throw new Error("Provide exactly one API key source");
  }
  if (args["api-key"]) {
    return args["api-key"];
  }
  if (args["api-key-env"]) {
    const value = process.env[args["api-key-env"]];
    if (!value) {
      throw new Error(`Environment variable is empty or missing: ${args["api-key-env"]}`);
    }
    return value;
  }
  return readFileSync(path.resolve(args["api-key-file"]), "utf8").trim();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}
