#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const usage = `Usage:
  node scripts/patch-codex-asar-integrity.mjs --exe <ChatGPT.exe-or-Codex.exe> --asar <app.asar> --old-hash <64-char sha256>
  node scripts/patch-codex-asar-integrity.mjs --exe <ChatGPT.exe-or-Codex.exe> --asar <app.asar> --old-asar <previous-app.asar>
`;

const args = parseArgs(process.argv.slice(2));
const exePath = requiredPath(args.exe, "--exe");
const asarPath = requiredPath(args.asar, "--asar");
const oldHash = args["old-asar"]
  ? asarHeaderHash(requiredPath(args["old-asar"], "--old-asar"))
  : requiredHash(args["old-hash"], "--old-hash");
const nextHash = asarHeaderHash(asarPath);

const exe = readFileSync(exePath);
const oldBytes = Buffer.from(oldHash, "ascii");
const nextBytes = Buffer.from(nextHash, "ascii");
const offsets = [];
let offset = exe.indexOf(oldBytes);
while (offset !== -1) {
  offsets.push(offset);
  offset = exe.indexOf(oldBytes, offset + 1);
}

if (offsets.length === 0) {
  console.log(JSON.stringify({
    asar: asarPath,
    exe: exePath,
    newHash: nextHash,
    oldHash,
    offset: null,
    reason: "old_hash_not_found",
    skipped: true,
  }, null, 2));
  process.exit(0);
}

if (offsets.length !== 1) {
  fail(`Expected at most one old hash occurrence in ${exePath}, found ${offsets.length}.`);
}

nextBytes.copy(exe, offsets[0]);
writeFileSync(exePath, exe);

console.log(JSON.stringify({ asar: asarPath, exe: exePath, newHash: nextHash, oldHash, offset: offsets[0], skipped: false }, null, 2));

function asarHeaderHash(filePath) {
  const data = readFileSync(filePath);
  if (data.length < 16) {
    fail(`ASAR is too small: ${filePath}`);
  }
  const headerSize = data.readUInt32LE(12);
  const headerStart = 16;
  const headerEnd = headerStart + headerSize;
  if (headerEnd > data.length) {
    fail(`Invalid ASAR header size ${headerSize} for ${filePath}`);
  }
  return createHash("sha256").update(data.subarray(headerStart, headerEnd)).digest("hex");
}

function requiredHash(value, flag) {
  if (!/^[a-f0-9]{64}$/iu.test(String(value ?? ""))) {
    fail(`Missing or invalid ${flag}\n\n${usage}`);
  }
  return String(value).toLowerCase();
}

function requiredPath(value, flag) {
  if (!value) {
    fail(`Missing ${flag}\n\n${usage}`);
  }
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    fail(`${flag} does not exist: ${resolved}`);
  }
  return resolved;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      fail(`Unexpected argument: ${key}\n\n${usage}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${key}\n\n${usage}`);
    }
    parsed[key.slice(2)] = value;
    i += 1;
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
