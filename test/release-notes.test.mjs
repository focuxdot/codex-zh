import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateReleaseNotesFromText } from "../scripts/generate-release-notes.mjs";

const changelog = readFileSync("CHANGELOG.md", "utf8");

test("release notes describe user-visible changes from the matching changelog section", () => {
  const notes = generateReleaseNotesFromText(changelog, "v0.1.2");

  assert.match(notes, /^## 更新内容/u);
  assert.match(notes, /跳过本次/u);
  assert.match(notes, /以后不再显示/u);
  assert.match(notes, /--skip-config/u);
  assert.doesNotMatch(notes, /自动构建完成/u);
  assert.doesNotMatch(notes, /Automated Windows package build/u);
});

test("release notes require a versioned changelog section", () => {
  assert.throws(
    () => generateReleaseNotesFromText("## Unreleased\n\n- 测试内容\n", "v9.9.9"),
    /CHANGELOG\.md must include a Chinese release section/u,
  );
});
