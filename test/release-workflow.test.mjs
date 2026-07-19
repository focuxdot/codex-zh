import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const readiness = readFileSync("OPEN_SOURCE_READINESS.md", "utf8");
const contributing = readFileSync("CONTRIBUTING.md", "utf8");
const maintainerPush = readFileSync("scripts/git-push-maintainer.mjs", "utf8");
const chineseLogs = readFileSync("scripts/validate-chinese-logs.mjs", "utf8");
const releaseNotes = readFileSync("scripts/generate-release-notes.mjs", "utf8");
const macDmgBuilder = readFileSync("scripts/build-codex-zh-dmg-mac.mjs", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const releaseSources = JSON.parse(readFileSync("release-sources.json", "utf8"));

test("release workflow packages Windows installer after GitHub Release publish", () => {
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/u);
  assert.match(workflow, /release:\s*\n\s+types:\s*\n\s+- published/u);
  assert.match(workflow, /if: startsWith\(github\.event\.release\.tag_name \|\| github\.ref_name, 'v'\)/u);
  assert.match(workflow, /runs-on: windows-2022/u);
  assert.match(workflow, /vars\.CODEX_ZH_BUILD_WINDOWS == 'true'/u);
  assert.match(workflow, /needs: release-metadata/u);
  assert.match(workflow, /actions\/checkout@v6/u);
  assert.match(workflow, /actions\/setup-node@v6/u);
  assert.match(workflow, /node-version: "24"/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /CODEX_WINDOWS_APP_ZIP_URL/u);
  assert.match(workflow, /CODEX_WINDOWS_APP_ZIP_SHA256/u);
  assert.match(workflow, /pinned official ChatGPT\/Codex Windows source archive/u);
  assert.match(workflow, /Set CODEX_WINDOWS_APP_ZIP_SHA256 so release builds are pinned/u);
  assert.match(workflow, /Source archive SHA-256 mismatch/u);
  assert.match(workflow, /PINNED_SOURCE_MANIFEST'\)\.windows\.x64\.sha256/u);
  assert.match(workflow, /ChatGPT desktop kernel version mismatch/u);
  assert.match(workflow, /"@electron\/asar" extract-file/u);
  assert.doesNotMatch(workflow, /winget\.exe/u);
  assert.doesNotMatch(workflow, /install Codex -s msstore/u);
  assert.match(workflow, /scripts\\build-codex-zh-staging\.ps1/u);
  assert.match(workflow, /scripts\\build-codex-zh-installer\.ps1/u);
  assert.match(workflow, /\$installerArgs = @\{/u);
  assert.doesNotMatch(workflow, /\$installerArgs = @\(/u);
  assert.match(workflow, /Start-Process -FilePath \$launcher -ArgumentList @\("--no-launch"\) -Wait -PassThru/u);
  assert.match(workflow, /\$launcherProcess\.ExitCode/u);
  assert.match(workflow, /\$codexCli --version/u);
  assert.match(workflow, /\$codexCli doctor --summary --ascii --no-color/u);
  assert.match(workflow, /install\\s\+consistent/u);
  assert.match(workflow, /no Codex credentials were found/u);
  assert.match(workflow, /missing credentials in CI; install consistency checks passed/u);
  assert.match(workflow, /\$global:LASTEXITCODE = 0/u);
  assert.match(workflow, /\$releaseViewOutput = & gh release view \$env:RELEASE_TAG/u);
  assert.match(workflow, /release not found/u);
  assert.match(workflow, /Failed to inspect release \$env:RELEASE_TAG/u);
  assert.match(workflow, /generate-release-notes\.mjs/u);
  assert.match(workflow, /\$releaseNotesPath = Join-Path \$env:RUNNER_TEMP "codex-zh-release-notes\.md"/u);
  assert.match(workflow, /gh release create \$env:RELEASE_TAG/u);
  assert.match(workflow, /--notes-file \$releaseNotesPath/u);
  assert.doesNotMatch(workflow, /Automated Windows package build/u);
  assert.doesNotMatch(workflow, /安装包已自动构建完成/u);
  assert.match(workflow, /gh release upload \$env:RELEASE_TAG @assets --clobber/u);
  // README download links are updated in a shared job (bash), gathering both platforms' checksums.
  assert.match(workflow, /node \.\/scripts\/update-readme-downloads\.mjs/u);
  assert.match(workflow, /git checkout -B main origin\/main/u);
  assert.match(workflow, /docs: 更新 \$RELEASE_TAG 下载链接/u);
  assert.doesNotMatch(workflow, /docs: update README download links/u);
  assert.match(workflow, /git push origin HEAD:main/u);
});

test("release workflow builds macOS arm64 and Intel x64 dmgs alongside the Windows installer", () => {
  assert.match(workflow, /release-metadata:/u);
  assert.match(workflow, /macos-installer:/u);
  assert.match(workflow, /matrix:\s*\n\s+arch: \[arm64, x64\]/u);
  assert.match(workflow, /runs-on: macos-14/u);
  assert.match(workflow, /CODEX_MACOS_APP_DMG_URL/u);
  assert.match(workflow, /CODEX_MACOS_APP_DMG_SHA256/u);
  assert.match(workflow, /CODEX_MACOS_X64_APP_DMG_URL/u);
  assert.match(workflow, /CODEX_MACOS_X64_APP_DMG_SHA256/u);
  assert.match(workflow, /source_codex_macos_x64_dmg_url/u);
  assert.match(workflow, /PINNED_SOURCE_MANIFEST: release-sources\.json/u);
  assert.match(workflow, /official ChatGPT\/Codex macOS \$MAC_ARCH archive/u);
  assert.match(workflow, /Source archive SHA-256 mismatch/u);
  assert.match(workflow, /ChatGPT\.app' -o -name 'Codex\.app'/u);
  assert.match(workflow, /scripts\/build-codex-zh-staging-mac\.mjs/u);
  assert.match(workflow, /scripts\/build-codex-zh-dmg-mac\.mjs/u);
  assert.match(workflow, /--arch "\$MAC_ARCH"/u);
  assert.match(workflow, /source_executable=/u);
  assert.match(workflow, /lipo -info "\$APP\/Contents\/MacOS\/\$source_executable" \| grep -q "\$expected_arch"/u);
  assert.match(workflow, /codex-zh-macos-\$\{\{ matrix\.arch \}\}-dmg/u);
  assert.match(workflow, /codex-zh-launcher\.mjs" --self-test --print-result/u);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG" "\$RELEASE_OUTPUT_DIR"\/\*\.dmg/u);
  assert.match(workflow, /needs: \[release-metadata, macos-installer\]/u);
  // The dmg job must pin the source like the Windows job (no unpinned downloads).
  assert.match(workflow, /unzip -tq "\$SOURCE_ARCHIVE"/u);
  assert.equal(releaseSources.desktopVersion, "26.715.31925");
  assert.equal(releaseSources.codexCliVersion, "0.145.0-alpha.18");
  assert.equal(releaseSources.windows.x64.storeProductId, "9PLM9XGG6VKS");
  assert.equal(releaseSources.windows.x64.packageVersion, "26.715.4045.0");
  assert.equal(releaseSources.windows.x64.sha256, "5608f294ba95e6205123973b35717ee261c5fcbb9ee6411968f4ec31b866e90a");
  assert.equal(releaseSources.windows.x64.size, 734845070);
  for (const arch of ["arm64", "x64"]) {
    assert.match(releaseSources.macos[arch].url, /ChatGPT-darwin-(?:arm64|x64)-26\.715\.31925\.zip$/u);
    assert.match(releaseSources.macos[arch].sha256, /^[a-f0-9]{64}$/u);
  }
  assert.match(macDmgBuilder, /xattr -d com\.apple\.quarantine "\/Applications\/Codex-叉叉\.app"/u);
  assert.doesNotMatch(macDmgBuilder, /xattr -dr/u);
});

test("release workflow keeps source app binary out of the repository", () => {
  assert.match(workflow, /Invoke-WebRequest -Uri \$sourceUrl -OutFile \$env:SOURCE_ARCHIVE/u);
  assert.match(workflow, /Expand-Archive -LiteralPath \$env:SOURCE_ARCHIVE/u);
  assert.match(workflow, /Raw Microsoft Store MSIX archives percent-encode scoped package/u);
  assert.match(workflow, /\$decoded = \$_.Name -replace '%40', '@'/u);
  assert.doesNotMatch(workflow, /git add .*SOURCE_ARCHIVE/u);
  assert.doesNotMatch(workflow, /git add .*RELEASE_OUTPUT_DIR/u);
  assert.match(workflow, /git add README\.md/u);
});

test("maintainer push docs require the checked SSH wrapper", () => {
  assert.match(packageJson, /"push:check": "node scripts\/git-push-maintainer\.mjs --check"/u);
  assert.match(packageJson, /"push:maintainer": "node scripts\/git-push-maintainer\.mjs"/u);
  assert.match(maintainerPush, /codex-zh\.githubSshKey/u);
  assert.match(maintainerPush, /CODEX_ZH_GITHUB_SSH_KEY/u);
  assert.match(maintainerPush, /Hi \$\{expectedAccount\}!/u);
  assert.match(maintainerPush, /Refusing to push: GitHub SSH identity did not match/u);
  assert.match(maintainerPush, /validate-chinese-logs\.mjs", "--commit-range", "origin\/main\.\.HEAD"/u);
  assert.match(maintainerPush, /GIT_SSH_COMMAND/u);
  assert.match(readiness, /Do not run a plain `git push origin main`/u);
  assert.match(readiness, /codex-zh\.githubSshKey/u);
  assert.match(readiness, /This must stay repository-local/u);
  assert.match(readiness, /Do not use `git config --global`/u);
  assert.match(readiness, /git config --local user\.name/u);
  assert.match(readiness, /git config --local user\.email/u);
  assert.match(readiness, /do not change other projects/u);
  assert.match(readiness, /npm run push:check/u);
  assert.match(readiness, /npm run push:maintainer -- origin main/u);
  assert.match(readiness, /npm run push:maintainer -- origin v0\.1\.2/u);
  assert.match(readiness, /gh auth status` alone is not enough/u);
  assert.match(contributing, /Do not use plain `git push` from a workstation/u);
  assert.match(contributing, /must be configured with `git config --local`, never `git config --global`/u);
  assert.doesNotMatch(readiness, /github_[a-z0-9_]+_account/u);
  assert.doesNotMatch(maintainerPush, /github_[a-z0-9_]+_account/u);
});

test("logs and release-facing copy default to Chinese", () => {
  assert.match(packageJson, /"hooks:install": "git config core\.hooksPath \.githooks"/u);
  assert.match(packageJson, /"logs:check": "node scripts\/validate-chinese-logs\.mjs --files"/u);
  assert.match(chineseLogs, /CHANGELOG bullet must be Chinese/u);
  assert.match(chineseLogs, /release workflow must generate user-facing release notes from CHANGELOG\.md/u);
  assert.match(releaseNotes, /CHANGELOG\.md must include a Chinese release section/u);
  assert.match(contributing, /Commit subjects[\s\S]+must be Chinese/u);
  assert.match(contributing, /CHANGELOG entries, GitHub Release notes, README release sections, and new-feature descriptions must be Chinese/u);
  assert.match(contributing, /GitHub Release notes are generated from the matching `CHANGELOG\.md` version section/u);
  assert.match(readiness, /GitHub Release notes must describe user-visible features and fixes, not build status/u);
  for (const line of changelog.split(/\r?\n/u).filter((entry) => entry.trim().startsWith("- "))) {
    assert.match(line, /[\u3400-\u9fff]/u);
  }
});
