import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DOWNLOADS_END,
  DOWNLOADS_START,
  buildAssetDownloadUrl,
  findReleaseAssets,
  generateDownloadBlock,
  updateDownloadsSection,
} from "../scripts/update-readme-downloads.mjs";

test("download asset URLs encode installer names for GitHub release links", () => {
  assert.equal(
    buildAssetDownloadUrl({
      repo: "focuxdot/codex-zh",
      tag: "v0.1.1",
      assetName: "OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.1-win-x64.exe",
    }),
    "https://github.com/focuxdot/codex-zh/releases/download/v0.1.1/OpenAI.Codex-26.608.1337.0%2BCodex-ZH-0.1.1-win-x64.exe",
  );
});

test("generateDownloadBlock gives non-technical users a direct Windows installer choice", () => {
  const block = generateDownloadBlock({
    repo: "focuxdot/codex-zh",
    tag: "v0.1.1",
    version: "0.1.1",
    installerName: "OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.1-win-x64.exe",
    sha256Name: "OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.1-win-x64.exe.sha256",
    sha256: "54aadeb761320de0267a5636552ca1df90488b449f5c9a96781c92a8d6114651",
  });

  assert.match(block, /Windows 10 \/ Windows 11（64 位）/u);
  assert.match(block, /下载 Codex-ZH 中文版 0\.1\.1 Windows x64 安装包/u);
  // 下载区已精简（见「docs: 精简下载区」）：不再内联 Source code 警告与 sha256 校验和。
  assert.doesNotMatch(block, /Source code/u);
  assert.doesNotMatch(block, /54aadeb761320de0267a5636552ca1df90488b449f5c9a96781c92a8d6114651/u);
});

test("generateDownloadBlock renders macOS arm64 and Intel x64 dmg rows when dmg assets exist", () => {
  const block = generateDownloadBlock({
    repo: "focuxdot/codex-zh",
    tag: "v0.1.2",
    version: "0.1.2",
    installerName: "OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.2-win-x64.exe",
    sha256Name: "OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.2-win-x64.exe.sha256",
    sha256: "54aadeb761320de0267a5636552ca1df90488b449f5c9a96781c92a8d6114651",
    dmgName: "Codex-ZH-0.1.2-mac-arm64.dmg",
    dmgSha256Name: "Codex-ZH-0.1.2-mac-arm64.dmg.sha256",
    dmgSha256: "97730f8af1815088f88efb9dba009925805c9da8ae92fc54d6bd13f944a538f4",
    dmgX64Name: "Codex-ZH-0.1.2-mac-x64.dmg",
    dmgX64Sha256Name: "Codex-ZH-0.1.2-mac-x64.dmg.sha256",
    dmgX64Sha256: "17730f8af1815088f88efb9dba009925805c9da8ae92fc54d6bd13f944a538f4",
  });

  assert.match(block, /macOS（Apple 芯片 \/ arm64）/u);
  assert.match(block, /下载 Codex-ZH 中文版 0\.1\.2 macOS arm64 安装包/u);
  assert.match(block, /Codex-ZH-0\.1\.2-mac-arm64\.dmg/u);
  assert.match(block, /macOS（Intel \/ x64，macOS 12\+）/u);
  assert.match(block, /下载 Codex-ZH 中文版 0\.1\.2 macOS Intel x64 安装包/u);
  assert.match(block, /Codex-ZH-0\.1\.2-mac-x64\.dmg/u);
  // 精简后下载区不再内联 dmg 的 sha256 校验和。
  assert.doesNotMatch(block, /97730f8af1815088f88efb9dba009925805c9da8ae92fc54d6bd13f944a538f4/u);
  // Both platforms present, so neither should say 暂不提供.
  assert.doesNotMatch(block, /macOS \| 暂不提供/u);
});

test("findReleaseAssets discovers both Windows and macOS assets from .sha256 files", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-zh-assets-"));
  writeFileSync(
    join(dir, "OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.2-win-x64.exe.sha256"),
    "54aadeb761320de0267a5636552ca1df90488b449f5c9a96781c92a8d6114651  OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.2-win-x64.exe\n",
  );
  writeFileSync(
    join(dir, "Codex-ZH-0.1.2-mac-arm64.dmg.sha256"),
    "97730f8af1815088f88efb9dba009925805c9da8ae92fc54d6bd13f944a538f4  Codex-ZH-0.1.2-mac-arm64.dmg\n",
  );
  writeFileSync(
    join(dir, "Codex-ZH-0.1.2-mac-x64.dmg.sha256"),
    "17730f8af1815088f88efb9dba009925805c9da8ae92fc54d6bd13f944a538f4  Codex-ZH-0.1.2-mac-x64.dmg\n",
  );

  const assets = findReleaseAssets(dir);
  assert.equal(assets.windows.name, "OpenAI.Codex-26.608.1337.0+Codex-ZH-0.1.2-win-x64.exe");
  assert.equal(assets.windows.sha256, "54aadeb761320de0267a5636552ca1df90488b449f5c9a96781c92a8d6114651");
  assert.equal(assets.macos.arm64.name, "Codex-ZH-0.1.2-mac-arm64.dmg");
  assert.equal(assets.macos.arm64.sha256, "97730f8af1815088f88efb9dba009925805c9da8ae92fc54d6bd13f944a538f4");
  assert.equal(assets.macos.x64.name, "Codex-ZH-0.1.2-mac-x64.dmg");
  assert.equal(assets.macos.x64.sha256, "17730f8af1815088f88efb9dba009925805c9da8ae92fc54d6bd13f944a538f4");
});

test("updateDownloadsSection replaces only the marked README downloads block", () => {
  const readme = `# Codex-ZH 中文版

## 下载

${DOWNLOADS_START}
旧下载内容
${DOWNLOADS_END}

## 快速开始

1. 打开安装包。
`;
  const block = `${DOWNLOADS_START}
新下载内容
${DOWNLOADS_END}`;

  const updated = updateDownloadsSection(readme, block);

  assert.match(updated, /新下载内容/u);
  assert.doesNotMatch(updated, /旧下载内容/u);
  assert.match(updated, /## 快速开始/u);
  assert.match(updated, /1\. 打开安装包。/u);
});
