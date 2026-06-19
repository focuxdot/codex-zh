#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const CJK_RE = /[\u3400-\u9fff]/u;

const args = process.argv.slice(2);
const errors = [];

if (args.length === 0 || args.includes("--files")) {
  validateChangelog();
  validateReleaseWorkflow();
}

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--commit-file") {
    validateCommitFile(requireValue(args[index + 1], arg));
    index += 1;
  } else if (arg === "--commit-range") {
    validateCommitRange(requireValue(args[index + 1], arg));
    index += 1;
  } else if (arg === "--subject") {
    validateSubject(requireValue(args[index + 1], arg), "provided subject");
    index += 1;
  }
}

if (errors.length > 0) {
  console.error(["Chinese log validation failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  process.exit(1);
}

function validateCommitFile(filePath) {
  const text = readFileSync(filePath, "utf8");
  const subject = text
    .split(/\r?\n/u)
    .find((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#");
    });
  validateSubject(subject ?? "", `commit message ${filePath}`);
}

function validateCommitRange(range) {
  const result = spawnSync("git", ["log", "--format=%s", "--no-merges", range], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    errors.push((result.stderr || result.stdout || `failed to read git log range ${range}`).trim());
    return;
  }
  for (const subject of result.stdout.split(/\r?\n/u).filter(Boolean)) {
    validateSubject(subject, `commit ${range}`);
  }
}

function validateSubject(subject, source) {
  const trimmed = String(subject ?? "").trim();
  if (!trimmed) {
    errors.push(`${source} is empty.`);
    return;
  }
  if (trimmed.startsWith("Merge ") || trimmed.startsWith("Revert ")) {
    return;
  }
  if (!CJK_RE.test(trimmed)) {
    errors.push(`${source} must contain Chinese text: ${trimmed}`);
  }
}

function validateChangelog() {
  const text = readFileSync("CHANGELOG.md", "utf8");
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      continue;
    }
    if (!CJK_RE.test(trimmed)) {
      errors.push(`CHANGELOG bullet must be Chinese: ${trimmed}`);
    }
  }
}

function validateReleaseWorkflow() {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  if (workflow.includes("Automated Windows package build")) {
    errors.push("release workflow still contains the old English release notes.");
  }
  if (!workflow.includes("generate-release-notes.mjs")) {
    errors.push("release workflow must generate user-facing release notes from CHANGELOG.md.");
  }
  if (!/--notes-file\s+\$releaseNotesPath/u.test(workflow)) {
    errors.push("release workflow must publish generated release notes with --notes-file.");
  }
  if (/git commit -m "docs: update README download links/u.test(workflow)) {
    errors.push("release workflow README update commit message must be Chinese.");
  }
}

function requireValue(value, flag) {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}
