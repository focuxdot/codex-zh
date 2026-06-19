#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SSH_ARGS_BASE = ["-o", "IdentitiesOnly=yes"];

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const pushArgs = checkOnly ? args.slice(1) : args;

try {
  const remote = readRemote();
  const repo = parseGitHubSshRemote(remote);
  const expectedAccount = readConfig("codex-zh.githubAccount") || process.env.CODEX_ZH_GITHUB_ACCOUNT || repo.owner;
  const keyPath = readConfig("codex-zh.githubSshKey") || process.env.CODEX_ZH_GITHUB_SSH_KEY;

  verifyKeyFile(keyPath);
  verifySshAccount({ expectedAccount, keyPath });

  if (checkOnly) {
    console.log("OK: GitHub SSH identity verified for maintainer push.");
    process.exit(0);
  }

  if (pushArgs.length === 0) {
    throw new Error("Usage: npm run push:maintainer -- origin main");
  }

  validateChineseCommitSubjects();

  const result = spawnSync("git", ["push", ...pushArgs], {
    env: {
      ...process.env,
      GIT_SSH_COMMAND: buildSshCommand(keyPath),
    },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function validateChineseCommitSubjects() {
  const result = spawnSync(process.execPath, ["scripts/validate-chinese-logs.mjs", "--commit-range", "origin/main..HEAD"], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("Refusing to push: commit subjects must use Chinese descriptions.");
  }
}

function verifyKeyFile(keyPath) {
  if (!keyPath) {
    throw new Error(
      "Maintainer SSH key is not configured. Set git config codex-zh.githubSshKey or CODEX_ZH_GITHUB_SSH_KEY.",
    );
  }
  if (!existsSync(keyPath)) {
    throw new Error("Configured maintainer SSH key file does not exist.");
  }
}

function verifySshAccount({ expectedAccount, keyPath }) {
  const result = spawnSync("ssh", ["-i", keyPath, ...SSH_ARGS_BASE, "-T", "git@github.com"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!output.includes(`Hi ${expectedAccount}!`)) {
    throw new Error("Refusing to push: GitHub SSH identity did not match the expected maintainer account.");
  }
}

function readRemote() {
  return run("git", ["remote", "get-url", "origin"]).trim();
}

function parseGitHubSshRemote(remote) {
  const match = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u);
  if (!match) {
    throw new Error(`Unexpected origin SSH remote: ${remote}`);
  }
  return { owner: match[1], repo: match[2] };
}

function readConfig(name) {
  const result = spawnSync("git", ["config", "--get", name], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout ?? "";
}

function buildSshCommand(keyPath) {
  return `ssh -i ${shellQuote(keyPath)} -o IdentitiesOnly=yes`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
