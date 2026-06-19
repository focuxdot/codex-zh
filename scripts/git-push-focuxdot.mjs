#!/usr/bin/env node
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = "focuxdot/codex-zh";
const EXPECTED_ACCOUNT = "focuxdot";
const KEY_PATH = path.join(os.homedir(), ".ssh", "github_focuxdot_account");
const SSH_ARGS = ["-i", KEY_PATH, "-o", "IdentitiesOnly=yes"];
const GIT_SSH_COMMAND = `ssh -i ${shellQuote(KEY_PATH)} -o IdentitiesOnly=yes`;

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const pushArgs = checkOnly ? args.slice(1) : args;

try {
  verifyKeyFile();
  verifyRemote();
  verifySshAccount();

  if (checkOnly) {
    console.log(`OK: GitHub SSH identity verified as ${EXPECTED_ACCOUNT}.`);
    process.exit(0);
  }

  if (pushArgs.length === 0) {
    throw new Error("Usage: npm run push:focuxdot -- origin main");
  }

  const result = spawnSync("git", ["push", ...pushArgs], {
    env: {
      ...process.env,
      GIT_SSH_COMMAND,
    },
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function verifyKeyFile() {
  if (!existsSync(KEY_PATH)) {
    throw new Error(`Required GitHub SSH key is missing: ${KEY_PATH}`);
  }
}

function verifyRemote() {
  const remote = run("git", ["remote", "get-url", "origin"], { allowFailure: false }).trim();
  const sshPattern = /^git@github\.com:focuxdot\/codex-zh(?:\.git)?$/u;
  if (!sshPattern.test(remote)) {
    throw new Error(`Unexpected origin SSH remote for ${REPO}: ${remote}`);
  }
}

function verifySshAccount() {
  const result = spawnSync("ssh", [...SSH_ARGS, "-T", "git@github.com"], {
    encoding: "utf8",
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (!output.includes(`Hi ${EXPECTED_ACCOUNT}!`)) {
    throw new Error(
      [
        `Refusing to push: GitHub SSH identity is not ${EXPECTED_ACCOUNT}.`,
        "Expected:",
        `  Hi ${EXPECTED_ACCOUNT}! You've successfully authenticated, but GitHub does not provide shell access.`,
        "Actual:",
        indent(output.trim() || `(ssh exited with ${result.status ?? "unknown"})`),
      ].join("\n"),
    );
  }
}

function run(command, commandArgs, { allowFailure }) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  }
  return result.stdout ?? "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function indent(value) {
  return String(value)
    .split(/\r?\n/u)
    .map((line) => `  ${line}`)
    .join("\n");
}
