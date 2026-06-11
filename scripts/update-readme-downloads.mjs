import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DOWNLOADS_START = "<!-- codex-zh-downloads:start -->";
export const DOWNLOADS_END = "<!-- codex-zh-downloads:end -->";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) {
      throw new Error(`Unexpected argument: ${name}`);
    }
    const key = name.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(`Missing required ${name}.`);
  }
  return value;
}

function normalizeVersion(versionOrTag) {
  return requireValue(versionOrTag, "version").replace(/^v/u, "");
}

export function buildAssetDownloadUrl({ repo, tag, assetName }) {
  requireValue(repo, "repo");
  requireValue(tag, "tag");
  requireValue(assetName, "assetName");
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export function findReleaseAssets(outputDir) {
  const files = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const installerName = files.find((name) => name.endsWith(".exe"));
  if (!installerName) {
    throw new Error(`Could not find a Windows installer exe in ${outputDir}.`);
  }

  const expectedShaName = `${installerName}.sha256`;
  const sha256Name = files.includes(expectedShaName)
    ? expectedShaName
    : files.find((name) => name.endsWith(".sha256"));
  if (!sha256Name) {
    throw new Error(`Could not find a sha256 file in ${outputDir}.`);
  }

  const sha256Text = readFileSync(join(outputDir, sha256Name), "utf8");
  const sha256 = sha256Text.match(/\b[a-f0-9]{64}\b/iu)?.[0].toLowerCase();
  if (!sha256) {
    throw new Error(`Could not find a SHA-256 hash in ${join(outputDir, sha256Name)}.`);
  }

  return { installerName, sha256Name, sha256 };
}

export function generateDownloadBlock({ repo, tag, version, installerName, sha256Name, sha256 }) {
  const cleanVersion = normalizeVersion(version);
  const installerUrl = buildAssetDownloadUrl({ repo, tag, assetName: installerName });
  const sha256Url = buildAssetDownloadUrl({ repo, tag, assetName: sha256Name });

  return `${DOWNLOADS_START}
当前最新版：v${cleanVersion}

| 你的系统 | 下载哪个版本 |
| --- | --- |
| Windows 10 / Windows 11（64 位） | [下载 Codex-ZH ${cleanVersion} Windows x64 安装包](${installerUrl}) |
| macOS | 暂不提供 Codex-ZH 安装包，不要下载 Windows 版 |
| Linux | 暂不提供 Codex-ZH 安装包，不要下载 Windows 版 |

普通用户只需要下载上面的 \`.exe\` 文件。不要下载 GitHub 页面里的 \`Source code\`，那是源码，不是安装包。

校验文件：[\`${sha256Name}\`](${sha256Url})  
SHA256：\`${sha256}\`
${DOWNLOADS_END}`;
}

export function updateDownloadsSection(readme, block) {
  const markedSection = new RegExp(`${DOWNLOADS_START}[\\s\\S]*?${DOWNLOADS_END}`, "u");
  if (markedSection.test(readme)) {
    return readme.replace(markedSection, block);
  }

  const headingMatch = readme.match(/^## 下载\s*$/mu);
  if (!headingMatch || headingMatch.index === undefined) {
    throw new Error("Could not find README section: ## 下载");
  }

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const nextHeadingMatch = readme.slice(sectionStart).match(/\n## /u);
  if (!nextHeadingMatch || nextHeadingMatch.index === undefined) {
    throw new Error("Could not find the section after README downloads.");
  }

  const sectionEnd = sectionStart + nextHeadingMatch.index;
  return `${readme.slice(0, sectionStart)}\n\n${block}\n${readme.slice(sectionEnd)}`;
}

export function updateReadmeDownloads({
  readmePath = "README.md",
  outputDir,
  repo,
  tag,
  version,
}) {
  const assets = findReleaseAssets(requireValue(outputDir, "outputDir"));
  const block = generateDownloadBlock({
    repo: requireValue(repo, "repo"),
    tag: requireValue(tag, "tag"),
    version: requireValue(version, "version"),
    ...assets,
  });
  const original = readFileSync(readmePath, "utf8");
  const updated = updateDownloadsSection(original, block);
  if (updated !== original) {
    writeFileSync(readmePath, updated, "utf8");
    return true;
  }
  return false;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const changed = updateReadmeDownloads({
    readmePath: args.readme ?? "README.md",
    outputDir: args["release-output-dir"] ?? process.env.RELEASE_OUTPUT_DIR,
    repo: args.repo ?? process.env.GITHUB_REPOSITORY,
    tag: args.tag ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
    version: args.version ?? process.env.CODEX_ZH_VERSION ?? process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
  });
  console.log(changed ? "README downloads updated." : "README downloads already up to date.");
}
