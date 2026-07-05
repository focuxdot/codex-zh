#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const usage = `Usage:
  node scripts/build-codex-zh-dmg-mac.mjs --app <Codex-叉叉.app> --out-dir <dir> [--version x.y.z] [--volname name]

Packages the outer Codex-叉叉.app into a compressed .dmg with an /Applications
symlink and Chinese de-quarantine instructions. Outputs:
  Codex-ZH-<version>-mac-arm64.dmg
  Codex-ZH-<version>-mac-arm64.dmg.sha256
  codex-zh-dmg-mac.json
macOS only (needs hdiutil).
`;

const FIRST_RUN_TXT = `Codex-叉叉（macOS）首次打开说明
==============================

第 1 步　安装
  把左边的 Codex-叉叉 图标，拖到右边的“应用程序 / Applications”文件夹里。

第 2 步　第一次打开会被系统拦住，这是正常的
  这个软件没有花钱买 Apple 的“公证”，所以第一次打开时，
  系统会弹窗说“无法验证开发者”或“已损坏”。不是坏了，按下面做一次就好。
  （做过一次以后，以后每次打开都不会再拦。）

  —— 办法 A：终端一行命令（最稳，推荐）——
  1) 打开“终端”这个 App
     （在“启动台”里搜“终端”，或按 Command+空格 输入“终端”回车）。
  2) 把下面这一整行复制进终端，按回车：

     xattr -dr com.apple.quarantine /Applications/Codex-叉叉.app

  3) 回到“应用程序”，双击 Codex-叉叉 就能打开了。

  —— 办法 B：在“系统设置”里点“仍要打开”——
  1) 先到“应用程序”里双击一次 Codex-叉叉（会被拦住，先点“完成”关掉弹窗）。
  2) 打开“系统设置” → “隐私与安全性”，一直往下拉。
  3) 会看到一行“已阻止 Codex-叉叉…”，点它右边的“仍要打开”，
     再按提示点一次“打开”即可。

第 3 步　配置中转站
  第一次启动会进入配置向导：选模板、填地址 / Key / 模型、测试连接、保存并启动。

小提示
  如果“应用程序”里找不到 Codex-叉叉，说明第 1 步没拖成功，回到第 1 步再拖一次。
`;

const args = parseArgs(process.argv.slice(2));
const app = requiredPath(args.app, "--app");
const outDir = path.resolve(requiredValue(args["out-dir"], "--out-dir"));
const version = String(args.version || readPackageVersion());
const volName = String(args.volname || "Codex-叉叉");

if (process.platform !== "darwin") {
  fail("This packaging script must run on macOS (needs hdiutil).");
}
if (path.basename(app) !== "Codex-叉叉.app") {
  fail(`Expected the outer bundle Codex-叉叉.app, got ${path.basename(app)}`);
}

const baseName = `Codex-ZH-${version}-mac-arm64`;
const dmgPath = path.join(outDir, `${baseName}.dmg`);
const shaPath = `${dmgPath}.sha256`;
const stageDir = path.join(outDir, ".dmg-stage");

mkdirSync(outDir, { recursive: true });
rmSync(stageDir, { force: true, recursive: true });
mkdirSync(stageDir, { recursive: true });

// Lay out the DMG contents: the app, an Applications symlink, and instructions.
run("ditto", [app, path.join(stageDir, "Codex-叉叉.app")]);
run("ln", ["-s", "/Applications", path.join(stageDir, "Applications")]);
writeFileSync(path.join(stageDir, "首次打开必读.txt"), FIRST_RUN_TXT);

rmSync(dmgPath, { force: true });
run("hdiutil", [
  "create",
  "-volname", volName,
  "-srcfolder", stageDir,
  "-fs", "HFS+",
  "-format", "UDZO",
  "-ov",
  dmgPath,
]);

const buffer = readFileSync(dmgPath);
const sha256 = createHash("sha256").update(buffer).digest("hex");
writeFileSync(shaPath, `${sha256}  ${path.basename(dmgPath)}\n`, "ascii");

rmSync(stageDir, { force: true, recursive: true });

const manifest = {
  builtOn: "macos",
  version,
  dmgName: path.basename(dmgPath),
  sha256,
  sha256File: path.basename(shaPath),
  sizeBytes: statSync(dmgPath).size,
};
writeFileSync(path.join(outDir, "codex-zh-dmg-mac.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest, null, 2));

function run(command, argv) {
  const result = spawnSync(command, argv, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    fail(`${command} ${argv.join(" ")} failed (exit ${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout ?? "";
}

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function requiredValue(value, flag) {
  if (!value) fail(`Missing ${flag}\n\n${usage}`);
  return value;
}

function requiredPath(value, flag) {
  const resolved = path.resolve(requiredValue(value, flag));
  if (!existsSync(resolved)) fail(`${flag} does not exist: ${resolved}`);
  return resolved;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}\n\n${usage}`);
    const name = key.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      parsed[name] = true;
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
