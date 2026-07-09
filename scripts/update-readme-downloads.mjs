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

// Discover release assets from a directory of .sha256 files (each "<hash>  <name>").
// Only the small .sha256 files are needed, so a CI job can gather both platforms'
// checksums without downloading the multi-hundred-MB binaries.
export function findReleaseAssets(outputDir) {
  const files = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  let windows = null;
  const macos = { arm64: null, x64: null };
  for (const shaName of files.filter((name) => name.endsWith(".sha256"))) {
    const text = readFileSync(join(outputDir, shaName), "utf8");
    const match = text.match(/([a-f0-9]{64})\s+(\S.*)$/imu);
    const sha256 = match?.[1]?.toLowerCase();
    const assetName = (match?.[2]?.trim()) || shaName.replace(/\.sha256$/u, "");
    if (!sha256) continue;
    const ext = assetName.slice(assetName.lastIndexOf(".")).toLowerCase();
    if (ext === ".exe") {
      windows = { name: assetName, shaName, sha256 };
    } else if (ext === ".dmg") {
      macos[classifyMacDmgArch(assetName)] = { name: assetName, shaName, sha256 };
    }
  }

  // Fall back to a bare .exe with a sibling .sha256 (legacy single-job layout).
  if (!windows) {
    const installerName = files.find((name) => name.endsWith(".exe"));
    const shaName = files.find((name) => name.endsWith(".exe.sha256")) || files.find((name) => name.endsWith(".sha256"));
    if (installerName && shaName) {
      const sha256 = readFileSync(join(outputDir, shaName), "utf8").match(/\b[a-f0-9]{64}\b/iu)?.[0]?.toLowerCase();
      if (sha256) windows = { name: installerName, shaName, sha256 };
    }
  }

  if (!windows && !macos.arm64 && !macos.x64) {
    throw new Error(`Could not find a Windows .exe or macOS .dmg (with .sha256) in ${outputDir}.`);
  }

  return {
    windows,
    macos,
  };
}

function classifyMacDmgArch(assetName) {
  if (/-mac-x64\.dmg$/iu.test(assetName)) return "x64";
  return "arm64";
}

export function generateDownloadBlock({
  repo, tag, version,
  installerName, sha256Name, sha256, // Windows (flat, backwards-compatible)
  dmgName, dmgSha256Name, dmgSha256, // macOS
  dmgX64Name, dmgX64Sha256Name, dmgX64Sha256,
}) {
  const cleanVersion = normalizeVersion(version);

  let windowsRow = "| Windows 10 / Windows 11（64 位） | 暂不提供，敬请等待 |";
  if (installerName) {
    const installerUrl = buildAssetDownloadUrl({ repo, tag, assetName: installerName });
    windowsRow = `| Windows 10 / Windows 11（64 位） | [下载 Codex-ZH 中文版 ${cleanVersion} Windows x64 安装包](${installerUrl}) |`;
  }

  const macRows = [];
  if (dmgName) {
    const dmgUrl = buildAssetDownloadUrl({ repo, tag, assetName: dmgName });
    macRows.push(`| macOS（Apple 芯片 / arm64） | [下载 Codex-ZH 中文版 ${cleanVersion} macOS arm64 安装包](${dmgUrl}) |`);
  }
  if (dmgX64Name) {
    const dmgX64Url = buildAssetDownloadUrl({ repo, tag, assetName: dmgX64Name });
    macRows.push(`| macOS（Intel / x64，macOS 12+） | [下载 Codex-ZH 中文版 ${cleanVersion} macOS Intel x64 安装包](${dmgX64Url}) |`);
  }
  const macRowsText = macRows.length
    ? macRows.join("\n")
    : "| macOS | 暂不提供 Codex-ZH 中文版安装包，不要下载 Windows 版 |";

  return `${DOWNLOADS_START}
当前最新版：v${cleanVersion}

| 你的系统 | 下载哪个版本 |
| --- | --- |
${windowsRow}
${macRowsText}

macOS 版打开时如果提示文件“已损坏”或无法安装，属正常现象，按[常见问题里的说明](#macos-打开时提示已损坏或无法验证开发者)处理即可。
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
    installerName: assets.windows?.name,
    sha256Name: assets.windows?.shaName,
    sha256: assets.windows?.sha256,
    dmgName: assets.macos.arm64?.name,
    dmgSha256Name: assets.macos.arm64?.shaName,
    dmgSha256: assets.macos.arm64?.sha256,
    dmgX64Name: assets.macos.x64?.name,
    dmgX64Sha256Name: assets.macos.x64?.shaName,
    dmgX64Sha256: assets.macos.x64?.sha256,
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
