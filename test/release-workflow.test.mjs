import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(".github/workflows/release.yml", "utf8");

test("release workflow packages Windows installer after GitHub Release publish", () => {
  assert.match(workflow, /push:\s*\n\s+tags:\s*\n\s+- "v\*"/u);
  assert.match(workflow, /release:\s*\n\s+types:\s*\n\s+- published/u);
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
  assert.match(workflow, /\$codexCli doctor --summary --ascii --no-color/u);
  assert.match(workflow, /gh release create \$env:RELEASE_TAG/u);
  assert.match(workflow, /gh release upload \$env:RELEASE_TAG @assets --clobber/u);
});

test("release workflow keeps source app binary out of the repository", () => {
  assert.match(workflow, /Invoke-WebRequest -Uri \$sourceUrl -OutFile \$env:SOURCE_ARCHIVE/u);
  assert.match(workflow, /Expand-Archive -LiteralPath \$env:SOURCE_ARCHIVE/u);
  assert.doesNotMatch(workflow, /git add/u);
  assert.doesNotMatch(workflow, /git commit/u);
});
