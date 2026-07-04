#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const usage = `Usage:
  node scripts/patch-codex-asar-integrity-mac.mjs --plist <Info.plist> --asar <app.asar> [--asar-key Resources/app.asar]
  node scripts/patch-codex-asar-integrity-mac.mjs --plist <Info.plist> --new-hash <64-char sha256> [--asar-key Resources/app.asar]

macOS Electron validates the packed asar against the ElectronAsarIntegrity dict in
the app bundle's Info.plist (an XML plist). After repacking app.asar, update the
hash for the matching asar key so the integrity check passes, then re-sign the app.
`;

const args = parseArgs(process.argv.slice(2));
const plistPath = requiredPath(args.plist, "--plist");
const asarKey = args["asar-key"] || "Resources/app.asar";
const newHash = args["new-hash"]
  ? requireHash(args["new-hash"], "--new-hash")
  : asarHeaderHash(requiredPath(args.asar, "--asar"));

const plist = readFileSync(plistPath, "utf8");

// If integrity is not enforced (no ElectronAsarIntegrity dict), skip gracefully.
if (!plist.includes("<key>ElectronAsarIntegrity</key>")) {
  console.log(JSON.stringify({
    plist: plistPath, asarKey, newHash, patched: false, reason: "no_electron_asar_integrity",
  }, null, 2));
  process.exit(0);
}

// Locate the hash string for the requested asar key and replace exactly one 64-hex value.
const keyEscaped = asarKey.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const pattern = new RegExp(
  `(<key>${keyEscaped}</key>\\s*<dict>[\\s\\S]*?<key>hash</key>\\s*<string>)([a-f0-9]{64})(</string>)`,
  "u",
);

const matches = [...plist.matchAll(new RegExp(pattern, "gu"))];
if (matches.length === 0) {
  fail(`Could not find an integrity hash for asar key "${asarKey}" in ${plistPath}.`);
}
if (matches.length !== 1) {
  fail(`Expected exactly one integrity hash for "${asarKey}" in ${plistPath}, found ${matches.length}.`);
}

const oldHash = matches[0][2];
if (oldHash === newHash) {
  console.log(JSON.stringify({
    plist: plistPath, asarKey, oldHash, newHash, patched: false, reason: "already_current",
  }, null, 2));
  process.exit(0);
}

const next = plist.replace(pattern, `$1${newHash}$3`);
writeFileSync(plistPath, next);

console.log(JSON.stringify({ plist: plistPath, asarKey, oldHash, newHash, patched: true }, null, 2));

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

function requireHash(value, flag) {
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
