import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOWNLOADS_END,
  DOWNLOADS_START,
  buildAssetDownloadUrl,
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
  assert.match(block, /下载 Codex-ZH 0\.1\.1 Windows x64 安装包/u);
  assert.match(block, /不要下载 GitHub 页面里的 `Source code`/u);
  assert.match(block, /54aadeb761320de0267a5636552ca1df90488b449f5c9a96781c92a8d6114651/u);
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
