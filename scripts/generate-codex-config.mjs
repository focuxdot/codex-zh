#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { buildCodexConfig } from "../src/codex-config.mjs";
import { listProviderPresets, resolveProviderPreset } from "../src/provider-presets.mjs";

const usage = `Usage:
  node scripts/generate-codex-config.mjs \\
    [--preset custom|wokey|openrouter] \\
    --provider <id> \\
    --provider-name <name> \\
    --base-url <url> \\
    [--model <model>] \\
    [--wire-api responses] \\
    [--api-key <key> | --api-key-env <env-name> | --api-key-file <path>] \\
    [--out <config.toml>]
`;

try {
  const args = parseArgs(process.argv.slice(2));
  if (args["list-presets"] === "true") {
    console.log(listProviderPresets().join("\n"));
    process.exit(0);
  }
  const preset = resolveProviderPreset(args.preset);
  const apiKey = resolveApiKey(args, preset);
  const config = buildCodexConfig({
    apiKey,
    baseUrl: args["base-url"] ?? preset.baseUrl,
    conversationDetailMode: args["conversation-detail-mode"],
    model: args.model ?? preset.model,
    provider: args.provider ?? preset.provider,
    providerName: args["provider-name"] ?? preset.providerName,
    reasoningEffort: args["reasoning-effort"],
    wireApi: args["wire-api"] ?? preset.wireApi,
  });

  if (args.out) {
    const outPath = path.resolve(args.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, config, "utf8");
    console.log(`Wrote ${outPath}`);
  } else {
    process.stdout.write(config);
  }
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
    const envName = args["api-key-env"];
    const value = process.env[envName];
    if (!value) {
      throw new Error(`Environment variable is empty or missing: ${envName}`);
    }
    return value;
  }

  const keyFile = path.resolve(args["api-key-file"]);
  if (!existsSync(keyFile)) {
    throw new Error(`API key file does not exist: ${keyFile}`);
  }
  return readFileSync(keyFile, "utf8").trim();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    if (key === "--list-presets") {
      parsed["list-presets"] = "true";
      continue;
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
