import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const siteRoot = path.join("site", "office-tutorials");
const tutorialPages = [
  "index.html",
  "01-folder-cleanup.html",
  "02-proposal-from-materials.html",
  "03-data-cleaning.html",
  "04-ppt-first-draft.html",
  "05-format-converter.html",
  "06-batch-images.html",
  "07-knowledge-to-short-video.html",
  "08-long-material-to-highlights.html",
];

const publicPageForbiddenTerms = [
  "/tmp",
  "real-windows-216",
  "AppData",
  "C:\\Users",
  "prompt",
  "Prompt",
  "小白",
  "新手",
  "固定三轮",
  "三次交互",
  "最多三次",
  "临时试制",
  "临时试读",
  "临时目录",
  "看文字稿",
];

const publicArtifactForbiddenTerms = [
  "/tmp",
  "real-windows-216",
  "AppData",
  "C:\\Users",
  "prompt",
  "Prompt",
  "小白",
  "新手",
  "固定三轮",
  "临时试读",
  "临时目录",
];

test("tutorial site exposes the expected pages", () => {
  for (const page of tutorialPages) {
    const file = path.join(siteRoot, page);
    assert.equal(existsSync(file), true, `${file} should exist`);
    const html = readFileSync(file, "utf8");
    assert.match(html, /^<!doctype html>/iu, `${page} should declare doctype`);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/u);
    assert.match(html, /<title>[^<]+<\/title>/u, `${page} should have a title`);
  }
});

test("tutorial site local references resolve inside the site", () => {
  for (const page of tutorialPages) {
    const file = path.join(siteRoot, page);
    const html = readFileSync(file, "utf8");
    const references = [...html.matchAll(/\b(?:href|src)="([^"]+)"/gu)].map((match) => match[1]);

    for (const reference of references) {
      if (isExternalOrAnchor(reference)) {
        continue;
      }
      assert.equal(reference.startsWith("../"), false, `${page} should not link outside the Pages root`);
      assert.equal(reference.startsWith("/"), false, `${page} should use relative links`);
      const target = path.normalize(path.join(path.dirname(file), reference));
      assert.equal(target.startsWith(path.normalize(siteRoot)), true, `${page} links outside site: ${reference}`);
      assert.equal(existsSync(target), true, `${page} missing local reference: ${reference}`);
    }
  }
});

test("tutorial site does not expose internal production notes or local paths", () => {
  for (const page of tutorialPages) {
    const file = path.join(siteRoot, page);
    const html = readFileSync(file, "utf8");
    for (const term of publicPageForbiddenTerms) {
      assert.equal(html.includes(term), false, `${page} should not contain ${term}`);
    }
  }

  for (const file of listFiles(siteRoot)) {
    if (isLikelyBinary(file)) {
      continue;
    }
    const content = readFileSync(file, "utf8");
    for (const term of publicArtifactForbiddenTerms) {
      assert.equal(content.includes(term), false, `${file} should not contain ${term}`);
    }
  }
});

test("README links to the tutorial landing page and all tutorial pages", () => {
  const readme = readFileSync("README.md", "utf8");
  const baseUrl = "https://focuxdot.github.io/codex-zh/office-tutorials/";

  assert.match(readme, /Codex 高效办公实战课，原创“问补做”套路 · 真实办公案例。/u);
  assert.match(readme, /\[Codex-ZH 中文版办公实战教程第一季\]\(https:\/\/focuxdot\.github\.io\/codex-zh\/office-tutorials\/\)/u);

  for (const page of tutorialPages.filter((name) => name !== "index.html")) {
    assert.equal(readme.includes(`${baseUrl}${page}`), true, `README should link to ${page}`);
  }
  assert.equal(readme.includes("/tmp"), false);
  assert.equal(readme.includes("site/office-tutorials"), false);
});

function isExternalOrAnchor(reference) {
  return (
    reference.startsWith("#") ||
    reference.startsWith("http://") ||
    reference.startsWith("https://") ||
    reference.startsWith("mailto:")
  );
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    if (statSync(file).isDirectory()) {
      files.push(...listFiles(file));
    } else {
      files.push(file);
    }
  }
  return files;
}

function isLikelyBinary(file) {
  return /\.(?:png|jpg|jpeg|gif|webp|ico|xlsx|pptx|docx|pdf|mp4|ai)$/iu.test(file);
}
