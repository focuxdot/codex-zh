#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { testProviderConnection } from "../src/provider-test.mjs";
import { resolveProviderPreset } from "../src/provider-presets.mjs";

const usage = `Usage:
  node scripts/test-provider.mjs \\
    [--preset custom|wokey|openrouter] \\
    [--base-url <url>] \\
    [--model <model>] \\
    [--wire-api responses] \\
    [--api-key <key> | --api-key-env <env-name> | --api-key-file <path>]
`;

try {
  const args = parseArgs(process.argv.slice(2));
  const preset = resolveProviderPreset(args.preset);
  const result = await testProviderConnection({
    apiKey: resolveApiKey(args, preset),
    baseUrl: args["base-url"] ?? preset.baseUrl,
    model: args.model ?? preset.model,
    wireApi: args["wire-api"] ?? preset.wireApi,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 2);
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
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    parsed[key.slice(2)] = value;
    index += 1;
  }
  return parsed;
}
