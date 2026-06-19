#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CJK_RE = /[\u3400-\u9fff]/u;

export function generateReleaseNotesFromText(changelog, tag) {
  const cleanTag = requireValue(tag, "tag").replace(/^refs\/tags\//u, "");
  const cleanVersion = cleanTag.replace(/^v/u, "");
  const section = findVersionSection(changelog, [`v${cleanVersion}`, cleanVersion, cleanTag]);

  if (!section) {
    throw new Error(`CHANGELOG.md must include a Chinese release section for ${cleanTag}, for example: ## v${cleanVersion}`);
  }

  const bullets = section
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().startsWith("- "));

  if (bullets.length === 0) {
    throw new Error(`CHANGELOG.md section ${cleanTag} must include user-facing bullet points.`);
  }

  for (const bullet of bullets) {
    if (!CJK_RE.test(bullet)) {
      throw new Error(`CHANGELOG.md release bullet must be Chinese: ${bullet}`);
    }
  }

  return ["## 更新内容", "", ...bullets, ""].join("\n");
}

function findVersionSection(changelog, headings) {
  const lines = String(changelog).split(/\r?\n/u);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+(.+?)\s*$/u);
    if (match && headings.includes(match[1].trim())) {
      start = index + 1;
      break;
    }
  }
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tag = args.tag ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME;
  const changelogPath = args.changelog ?? "CHANGELOG.md";
  const notes = generateReleaseNotesFromText(readFileSync(changelogPath, "utf8"), tag);

  if (args.out) {
    writeFileSync(args.out, notes, "utf8");
  } else {
    process.stdout.write(notes);
  }
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

function requireValue(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`${name} is required.`);
  }
  return String(value).trim();
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main();
}
