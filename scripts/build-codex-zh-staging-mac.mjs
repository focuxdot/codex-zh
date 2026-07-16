#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const usage = `Usage:
  node scripts/build-codex-zh-staging-mac.mjs --source-app <official ChatGPT.app or Codex.app> --out-dir <staging dir> [options]

Options:
  --project-root <dir>     Repo root (default: cwd)
  --version <x.y.z>        Codex-叉叉 version for the outer bundle (default: package.json)
  --arch <arm64|x64>       Target macOS architecture (default: arm64)
  --sign-identity <id>     codesign identity (default: "-" ad-hoc)
  --skip-asar              Copy + sign without patching the asar (debug)
  --skip-sign              Patch without re-signing (debug)

Produces <out-dir>/Codex-叉叉.app from the official ChatGPT/Codex desktop bundle,
with the Codex-叉叉 zh-CN + capability patches applied, Info.plist
ElectronAsarIntegrity updated, and the bundle re-signed (ad-hoc by default).
macOS arm64 and x64 are supported.
`;

const args = parseArgs(process.argv.slice(2));
const sourceApp = requiredPath(args["source-app"], "--source-app");
const outDir = path.resolve(requiredValue(args["out-dir"], "--out-dir"));
const projectRoot = path.resolve(args["project-root"] || process.cwd());
const arch = normalizeArch(args.arch || "arm64");
const swiftTarget = arch === "x64" ? "x86_64-apple-macos12.0" : "arm64-apple-macos11.0";
const signIdentity = args["sign-identity"] || "-";
const skipAsar = "skip-asar" in args;
const skipSign = "skip-sign" in args;
const version = String(args.version || readPackageVersion(projectRoot));

if (process.platform !== "darwin") {
  fail("This staging script must run on macOS (needs codesign/ditto).");
}

const customizer = path.join(projectRoot, "scripts", "customize-codex-default-zh-cn.mjs");
const integrityPatcher = path.join(projectRoot, "scripts", "patch-codex-asar-integrity-mac.mjs");
const macLauncherDir = path.join(projectRoot, "launcher", "mac");
const srcDir = path.join(projectRoot, "src");
requirePath(customizer, "customizer script");
requirePath(integrityPatcher, "integrity patcher script");
requirePath(path.join(macLauncherDir, "Codex-ZH"), "mac launcher entry (launcher/mac/Codex-ZH)");
requirePath(path.join(macLauncherDir, "codex-zh-launcher.mjs"), "mac launcher orchestrator");

// Validate the source bundle shape.
const srcAsar = path.join(sourceApp, "Contents", "Resources", "app.asar");
const srcPlist = path.join(sourceApp, "Contents", "Info.plist");
const sourceExecutable = readPlistKey(srcPlist, "CFBundleExecutable");
const srcMain = path.join(sourceApp, "Contents", "MacOS", sourceExecutable);
requirePath(srcAsar, "source app.asar");
requirePath(srcPlist, "source Info.plist");
requirePath(srcMain, `source Contents/MacOS/${sourceExecutable}`);
const sourceMainArch = assertMachOArch(srcMain, arch, `source Contents/MacOS/${sourceExecutable}`);

// Single bundle: Codex-叉叉.app IS the patched official desktop app (with our launcher
// inserted as CFBundleExecutable). Nesting it inside another .app breaks Electron's
// app-path resolution, so there is no separate outer/inner bundle.
const stagedApp = path.join(outDir, "Codex-叉叉.app");
const workRoot = path.join(outDir, ".work");

mkdirSync(outDir, { recursive: true });
rmSync(stagedApp, { force: true, recursive: true });
rmSync(workRoot, { force: true, recursive: true });
mkdirSync(workRoot, { recursive: true });

// 1) Copy the bundle with ditto to preserve symlinks / bundle metadata.
log(`Copying ${path.basename(sourceApp)} -> Codex-叉叉.app with ditto ...`);
runOrThrow("ditto", [sourceApp, stagedApp]);

const stagedAsar = path.join(stagedApp, "Contents", "Resources", "app.asar");
const stagedUnpacked = path.join(stagedApp, "Contents", "Resources", "app.asar.unpacked");
const stagedPlist = path.join(stagedApp, "Contents", "Info.plist");

let patchSummary = { skipped: true };
if (!skipAsar) {
  // 2) Extract, patch (zh-CN + capability bypass), repack.
  const extractDir = path.join(workRoot, "extract");
  const patchWorkDir = path.join(workRoot, "patched");
  const patchedAsar = path.join(workRoot, "app.zh-CN.asar");

  log("Extracting app.asar ...");
  runOrThrow("npx", ["--yes", "@electron/asar", "extract", stagedAsar, extractDir]);

  const customizerArgs = [
    customizer,
    "--asar-dir", extractDir,
    "--work-dir", patchWorkDir,
    "--out-asar", patchedAsar,
    "--platform", "mac",
  ];
  // Reproduce the original unpack layout exactly: the macOS bundle unpacks whole
  // native-module directories (not just *.node), so disable the default --unpack
  // glob and unpack precisely the packages that are unpacked in the source bundle.
  if (existsSync(stagedUnpacked)) {
    customizerArgs.push("--asar-unpacked-dir", stagedUnpacked);
    const unpackDirGlob = computeUnpackDirGlob(stagedUnpacked);
    if (unpackDirGlob) {
      customizerArgs.push("--unpack-glob", "none", "--unpack-dir-glob", unpackDirGlob);
    }
  }
  log("Applying macOS zh-CN + capability patches ...");
  const custOut = runOrThrow(process.execPath, customizerArgs);
  patchSummary = JSON.parse(custOut.trim());

  // The repacked unpack set must be a SUPERSET of the original: every file the
  // source bundle kept in app.asar.unpacked must still be on disk, or the app would
  // try to load a native module from an archive path that isn't there. Extra
  // unpacked files (whole-package unpack vs the source's finer split) are safe as
  // long as we ship them on disk, which we do by replacing app.asar.unpacked below.
  const originalUnpackedSet = existsSync(stagedUnpacked) ? relFileSet(stagedUnpacked) : [];
  const repackedUnpacked = `${patchedAsar}.unpacked`;
  const repackedUnpackedSet = existsSync(repackedUnpacked) ? relFileSet(repackedUnpacked) : [];
  const missing = originalUnpackedSet.filter((f) => !repackedUnpackedSet.includes(f));
  if (missing.length) {
    fail(
      `Repacked app.asar.unpacked is missing ${missing.length} file(s) the source unpacked, ` +
      `e.g. ${missing.slice(0, 10).join(", ")}`,
    );
  }
  patchSummary.unpackedFiles = { original: originalUnpackedSet.length, repacked: repackedUnpackedSet.length };

  // Replace both Resources/app.asar and Resources/app.asar.unpacked so the header's
  // unpacked flags and the on-disk unpacked files stay consistent.
  cpSync(patchedAsar, stagedAsar);
  if (existsSync(repackedUnpacked)) {
    rmSync(stagedUnpacked, { force: true, recursive: true });
    cpSync(repackedUnpacked, stagedUnpacked, { recursive: true });
  }

  // 3) Update Info.plist ElectronAsarIntegrity to the new asar header hash.
  log("Updating Info.plist ElectronAsarIntegrity ...");
  const integOut = runOrThrow(process.execPath, [
    integrityPatcher, "--plist", stagedPlist, "--asar", stagedAsar,
  ]);
  patchSummary.integrity = JSON.parse(integOut.trim());
}

// 4) Insert the Codex-ZH launcher into the bundle and make it CFBundleExecutable.
log("Inserting Codex-ZH launcher into the bundle ...");
assembleLauncher();

// 5) Re-sign the bundle once (ad-hoc by default) so all modified resources verify.
let signSummary = { skipped: true };
if (!skipSign) {
  const signIdentityLabel = signIdentity === "-" ? "ad-hoc" : "custom";
  log(`Re-signing Codex-叉叉.app (identity: ${signIdentityLabel}) ...`);
  runOrThrow("codesign", ["--remove-signature", stagedApp]);
  runOrThrow("codesign", ["--force", "--deep", "--sign", signIdentity, stagedApp]);
  const verify = runOrThrow("codesign", ["--verify", "--deep", "--strict", "--verbose=2", stagedApp], { allowStderr: true });
  signSummary = { skipped: false, identity: signIdentityLabel, verify: verify.trim() || "ok" };
}

const asarHash = existsSync(stagedAsar) ? asarHeaderHash(stagedAsar) : null;
const manifest = {
  builtOn: "macos",
  version,
  arch,
  sourceAppName: path.basename(sourceApp),
  sourceExecutable,
  appName: path.basename(stagedApp),
  sourceMainArch,
  asarHeaderHash: asarHash,
  patches: patchSummary,
  sign: signSummary,
};
const manifestPath = path.join(outDir, "codex-zh-build-mac.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

rmSync(workRoot, { force: true, recursive: true });

console.log(JSON.stringify(manifest, null, 2));

function assembleLauncher() {
  const contents = path.join(stagedApp, "Contents");
  const macOSDir = path.join(contents, "MacOS");
  const codexZhDir = path.join(contents, "Resources", "codex-zh");

  // Bundle a mini repo tree so launcher modules resolve ../../src/*.mjs the same
  // way in the repo and inside the bundle.
  cpSync(srcDir, path.join(codexZhDir, "src"), { recursive: true });
  cpSync(macLauncherDir, path.join(codexZhDir, "launcher", "mac"), { recursive: true });

  // Compile the native windows into Contents/Resources/codex-zh/bin.
  const binDir = path.join(codexZhDir, "bin");
  mkdirSync(binDir, { recursive: true });
  for (const [name, out] of [["CodexZhConfig", "CodexZhConfig"]]) {
    const swiftSrc = path.join(macLauncherDir, `${name}.swift`);
    requirePath(swiftSrc, `swift source (launcher/mac/${name}.swift)`);
    log(`Compiling ${name}.swift ...`);
    runOrThrow("swiftc", ["-swift-version", "5", "-target", swiftTarget, "-O", "-o", path.join(binDir, out), swiftSrc]);
  }

  // Install the bash entry alongside the original ChatGPT/Codex binary,
  // then make it the bundle's CFBundleExecutable so LaunchServices runs it first.
  const entryDest = path.join(macOSDir, "Codex-ZH");
  cpSync(path.join(macLauncherDir, "Codex-ZH"), entryDest);
  runOrThrow("chmod", ["755", entryDest]);
  const infoPlist = path.join(contents, "Info.plist");
  runOrThrow("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleExecutable Codex-ZH", infoPlist]);
  // Give Codex-ZH its own bundle identity. The stock app still ships as
  // com.openai.codex, now with CFBundleDisplayName "ChatGPT"; if we keep it, macOS
  // LaunchServices treats Codex-ZH and an installed official Codex as the SAME
  // app — clicking the icon can open the wrong one, the Dock label flips to
  // "Codex", and the official Sparkle feed could "update" us back to stock.
  // A distinct identifier fixes all three. CFBundleDisplayName must equal the
  // on-disk base name ("Codex-叉叉") or macOS ignores it for anti-spoofing.
  setPlistKey(infoPlist, "CFBundleIdentifier", "ai.wokey.codex-zh", "string");
  setPlistKey(infoPlist, "CFBundleDisplayName", "Codex-叉叉", "string");
  // Keep the source CFBundleName so the Electron app's existing userData path and
  // login/session storage continue to follow the official desktop runtime.
}

function readPlistKey(plist, key) {
  requirePath(plist, "source Info.plist");
  const value = runOrThrow("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]).trim();
  if (!value || value.includes("/") || value.includes("\\")) {
    fail(`Invalid ${key} in source Info.plist: ${value || "<empty>"}`);
  }
  return value;
}

// PlistBuddy "Set" fails if the key is absent; fall back to "Add".
function setPlistKey(plist, key, value, type) {
  const set = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist], { encoding: "utf8" });
  if (set.status === 0) return;
  runOrThrow("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, plist]);
}

function readPackageVersion(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function computeUnpackDirGlob(unpackedRoot) {
  // The macOS bundle unpacks whole native-module directories under node_modules.
  // Derive the top-level unpacked package names (scoped packages counted as their
  // scope dir) and build an @electron/asar --unpack-dir brace glob covering them.
  const nodeModules = path.join(unpackedRoot, "node_modules");
  if (!existsSync(nodeModules)) {
    return "";
  }
  const names = new Set();
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    names.add(entry.name); // e.g. better-sqlite3, node-pty, @worklouder
  }
  const list = [...names].sort();
  if (list.length === 0) {
    return "";
  }
  return `**/{${list.join(",")}}`;
}

function relFileSet(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const fp = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(fp);
      else out.push(path.relative(root, fp));
    }
  }
  return out.sort();
}

function asarHeaderHash(filePath) {
  const data = readFileSync(filePath);
  const headerSize = data.readUInt32LE(12);
  return createHash("sha256").update(data.subarray(16, 16 + headerSize)).digest("hex");
}

function runOrThrow(command, argv, opts = {}) {
  const result = spawnSync(command, argv, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    fail(`${command} ${argv.join(" ")} failed (exit ${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "") + (opts.allowStderr ? (result.stderr ?? "") : "");
}

function log(message) {
  console.error(`[staging-mac] ${message}`);
}

function normalizeArch(value) {
  if (value === "arm64" || value === "x64") return value;
  fail(`Invalid --arch: ${value}. Expected arm64 or x64.`);
}

function expectedMachOArch(value) {
  return value === "x64" ? "x86_64" : "arm64";
}

function assertMachOArch(filePath, targetArch, label) {
  const expected = expectedMachOArch(targetArch);
  const info = runOrThrow("lipo", ["-info", filePath], { allowStderr: true }).trim();
  const arches = info.includes(" are: ")
    ? info.split(" are: ").pop().trim().split(/\s+/)
    : [info.split(" architecture: ").pop().trim()];
  if (!arches.includes(expected)) {
    fail(`${label} architecture mismatch for --arch ${targetArch}. Expected ${expected}; lipo says: ${info}`);
  }
  return info;
}

function requiredValue(value, flag) {
  if (!value) {
    fail(`Missing ${flag}\n\n${usage}`);
  }
  return value;
}

function requiredPath(value, flag) {
  const resolved = path.resolve(requiredValue(value, flag));
  if (!existsSync(resolved)) {
    fail(`${flag} does not exist: ${resolved}`);
  }
  return resolved;
}

function requirePath(p, label) {
  if (!existsSync(p)) {
    fail(`${label} not found: ${p}`);
  }
  return p;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      fail(`Unexpected argument: ${key}\n\n${usage}`);
    }
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed[name] = true; // boolean flag
    } else {
      parsed[name] = value;
      i += 1;
    }
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
