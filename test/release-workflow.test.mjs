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
const changelog = readFileSync("CHANGELOG.md", "utf8");

test("release workflow packages Windows installer after GitHub Release publish", () => {
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/u);
  assert.match(workflow, /release:\s*\n\s+types:\s*\n\s+- published/u);
  assert.match(workflow, /if: startsWith\(github\.event\.release\.tag_name \|\| github\.ref_name, 'v'\)/u);
  assert.match(workflow, /runs-on: windows-2022/u);
  assert.match(workflow, /actions\/checkout@v6/u);
  assert.match(workflow, /actions\/setup-node@v6/u);
  assert.match(workflow, /node-version: "24"/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /CODEX_WINDOWS_APP_ZIP_URL/u);
  assert.match(workflow, /CODEX_WINDOWS_APP_ZIP_SHA256/u);
  assert.match(workflow, /Set CODEX_WINDOWS_APP_ZIP_URL to a pinned official Codex app source zip/u);
  assert.match(workflow, /Set CODEX_WINDOWS_APP_ZIP_SHA256 so release builds are pinned/u);
  assert.match(workflow, /Source archive SHA-256 mismatch/u);
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
  assert.match(workflow, /node \.\\scripts\\update-readme-downloads\.mjs/u);
  assert.match(workflow, /git checkout -B main origin\/main/u);
  assert.match(workflow, /docs: 更新 \$env:RELEASE_TAG 下载链接/u);
  assert.doesNotMatch(workflow, /docs: update README download links/u);
  assert.match(workflow, /git push origin HEAD:main/u);
});

test("release workflow keeps source app binary out of the repository", () => {
  assert.match(workflow, /Invoke-WebRequest -Uri \$sourceUrl -OutFile \$env:SOURCE_ARCHIVE/u);
  assert.match(workflow, /Expand-Archive -LiteralPath \$env:SOURCE_ARCHIVE/u);
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
  assert.match(readiness, /npm run push:check/u);
  assert.match(readiness, /npm run push:maintainer -- origin main/u);
  assert.match(readiness, /npm run push:maintainer -- origin v0\.1\.2/u);
  assert.match(readiness, /gh auth status` alone is not enough/u);
  assert.match(contributing, /Do not use plain `git push` from a workstation/u);
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
