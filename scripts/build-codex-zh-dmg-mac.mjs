#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const usage = `Usage:
  node scripts/build-codex-zh-dmg-mac.mjs --app <Codex-ZH.app> --out-dir <dir> [--version x.y.z] [--volname name]

Packages the outer Codex-ZH.app into a compressed .dmg with an /Applications
symlink and Chinese de-quarantine instructions. Outputs:
  Codex-ZH-<version>-mac-arm64.dmg
  Codex-ZH-<version>-mac-arm64.dmg.sha256
  codex-zh-dmg-mac.json
macOS only (needs hdiutil).
`;

const FIRST_RUN_TXT = `Codex-ZH（macOS）首次打开说明

1. 把 Codex-ZH 拖到左边的“应用程序 / Applications”文件夹。
2. 这个安装包没有经过 Apple 公证，首次打开会被系统拦住（提示“已损坏”或“无法验证开发者”）。
   这是正常的，按下面任一方式解除即可：

   方式一（推荐，最省事）：
   - 双击本磁盘里的“允许运行 Codex-ZH.command”，按提示输入开机密码。
   - 完成后到“应用程序”里打开 Codex-ZH。

   方式二（手动）：
   - 打开“终端”，粘贴并回车：
     xattr -dr com.apple.quarantine /Applications/Codex-ZH.app
   - 然后到“应用程序”里打开 Codex-ZH。

3. 首次启动会进入中转站配置向导：选模板、填地址/Key/模型、测试连接、保存并启动。

如果“应用程序”里没有 Codex-ZH，请确认已经把它拖进了 Applications 文件夹。
`;

const DEQUARANTINE_COMMAND = `#!/bin/bash
# Remove the download quarantine flag from an installed Codex-ZH so it can open.
APP="/Applications/Codex-ZH.app"
if [ ! -d "$APP" ]; then
  echo "还没有在“应用程序”里找到 Codex-ZH。请先把 Codex-ZH 拖到 Applications 文件夹，再运行本工具。"
  read -r -p "按回车关闭…" _
  exit 1
fi
echo "正在解除 Codex-ZH 的下载隔离（可能需要输入开机密码）…"
sudo xattr -dr com.apple.quarantine "$APP"
echo "完成。正在打开 Codex-ZH…"
open "$APP"
`;

const args = parseArgs(process.argv.slice(2));
const app = requiredPath(args.app, "--app");
const outDir = path.resolve(requiredValue(args["out-dir"], "--out-dir"));
const version = String(args.version || readPackageVersion());
const volName = String(args.volname || "Codex-ZH");

if (process.platform !== "darwin") {
  fail("This packaging script must run on macOS (needs hdiutil).");
}
if (path.basename(app) !== "Codex-ZH.app") {
  fail(`Expected the outer bundle Codex-ZH.app, got ${path.basename(app)}`);
}

const baseName = `Codex-ZH-${version}-mac-arm64`;
const dmgPath = path.join(outDir, `${baseName}.dmg`);
const shaPath = `${dmgPath}.sha256`;
const stageDir = path.join(outDir, ".dmg-stage");

mkdirSync(outDir, { recursive: true });
rmSync(stageDir, { force: true, recursive: true });
mkdirSync(stageDir, { recursive: true });

// Lay out the DMG contents: the app, an Applications symlink, and instructions.
run("ditto", [app, path.join(stageDir, "Codex-ZH.app")]);
run("ln", ["-s", "/Applications", path.join(stageDir, "Applications")]);
writeFileSync(path.join(stageDir, "首次打开必读.txt"), FIRST_RUN_TXT);
const helper = path.join(stageDir, "允许运行 Codex-ZH.command");
writeFileSync(helper, DEQUARANTINE_COMMAND);
run("chmod", ["755", helper]);

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
