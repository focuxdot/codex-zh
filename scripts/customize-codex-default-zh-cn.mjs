#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  patchRemoteExternalSessionRefreshMain,
  patchRemoteExternalSessionRefreshPreload,
} from "./lib/remote-refresh-inject.mjs";

const usage = `Usage:
  node scripts/customize-codex-default-zh-cn.mjs --asar-dir <extracted-app-asar-dir> [--asar-unpacked-dir <app.asar.unpacked-dir>] --work-dir <patched-work-dir> --out-asar <output-app.asar> [--platform windows|mac]

Example:
  node scripts/customize-codex-default-zh-cn.mjs \\
    --asar-dir /tmp/codex-win-research/asar-extract \\
    --asar-unpacked-dir /tmp/codex-win-research/app.asar.unpacked \\
    --work-dir /tmp/codex-win-research/asar-zh-cn \\
    --out-asar /tmp/codex-win-research/app.zh-CN.asar

--platform defaults to windows. The macOS Codex bundle uses different Vite chunk
names and minified identifiers, so it needs a separate patch set (--platform mac).
`;

const args = parseArgs(process.argv.slice(2));
const sourceDir = requiredPath(args["asar-dir"], "--asar-dir");
const unpackedDir = args["asar-unpacked-dir"] ? requiredPath(args["asar-unpacked-dir"], "--asar-unpacked-dir") : "";
const workDir = requiredPath(args["work-dir"], "--work-dir");
const outAsar = requiredPath(args["out-asar"], "--out-asar");
const platform = args.platform === "mac" ? "mac" : "windows";

if (!existsSync(sourceDir)) {
  fail(`Source ASAR directory does not exist: ${sourceDir}`);
}

rmSync(workDir, { force: true, recursive: true });
mkdirSync(path.dirname(workDir), { recursive: true });
cpSync(sourceDir, workDir, { recursive: true });
if (unpackedDir) {
  cpSync(unpackedDir, workDir, { recursive: true });
}

const patches = platform === "mac"
  ? [
      patchMacLocaleOverrideDefault(workDir),
      patchMacLocaleResolverDefault(workDir),
      patchMacI18nOfflineDefault(workDir),
      patchMacBrowserAvailability(workDir),
      patchMacComputerUseAvailability(workDir),
      patchMacDefaultFeatureOverrides(workDir),
      patchRemoteExternalSessionRefreshMain(workDir),
      patchRemoteExternalSessionRefreshPreload(workDir),
    ]
  : [
      patchLocaleOverrideDefaults(workDir),
      patchLocaleResolverDefault(workDir),
      patchI18nOfflineDefault(workDir),
      patchCodeVBrowserAvailability(workDir),
      patchCodeVComputerUseAvailability(workDir),
      patchCodeVDefaultFeatureOverrides(workDir),
      patchWindowsMicaBackground(workDir),
      patchStartupLoaderLightTheme(workDir),
    ];

for (const patch of patches) {
  if (patch.count === 0) {
    fail(`Patch did not match: ${patch.name}`);
  }
}

mkdirSync(path.dirname(outAsar), { recursive: true });
rmSync(outAsar, { force: true });

// The unpack layout must match the original app.asar (which files live outside the
// archive in app.asar.unpacked). Windows keeps the default *.{node,dll,exe}; the
// macOS bundle unpacks whole native-module directories, so the staging step passes
// an explicit --unpack-dir glob and disables the default --unpack via "none".
const unpackGlob = args["unpack-glob"] === undefined ? "*.{node,dll,exe}" : args["unpack-glob"];
const unpackDirGlob = args["unpack-dir-glob"];
const packArgv = ["--yes", "@electron/asar", "pack"];
if (unpackGlob && unpackGlob !== "none") {
  packArgv.push("--unpack", unpackGlob);
}
if (unpackDirGlob) {
  packArgv.push("--unpack-dir", unpackDirGlob);
}
packArgv.push(workDir, outAsar);
run(process.platform === "win32" ? "npx.cmd" : "npx", packArgv);

console.log(JSON.stringify({
  platform, workDir, outAsar, unpackedDir: unpackedDir || null,
  unpackGlob: unpackGlob || null, unpackDirGlob: unpackDirGlob || null, patches,
}, null, 2));

function patchLocaleOverrideDefaults(root) {
  let count = 0;
  for (const file of listFiles(root, ".js")) {
    let text = readFileSync(file, "utf8");
    const pattern =
      /(localeOverride:[A-Za-z_$][\w$]*\(\{agentAccess:`read-write`,default:)null(,description:`Explicit locale override`,key:`localeOverride`)/g;
    const alreadyPatchedPattern =
      /(localeOverride:[A-Za-z_$][\w$]*\(\{agentAccess:`read-write`,default:)`zh-CN`(,description:`Explicit locale override`,key:`localeOverride`)/g;
    const matches = text.match(pattern)?.length ?? 0;
    const next = text.replace(
      pattern,
      "$1`zh-CN`$2",
    );
    if (next !== text) {
      count += matches;
      writeFileSync(file, next);
    } else {
      count += text.match(alreadyPatchedPattern)?.length ?? 0;
    }
  }
  return { name: "localeOverride default zh-CN", count };
}

function patchLocaleResolverDefault(root) {
  let count = 0;
  for (const file of listFiles(path.join(root, "webview", "assets"), ".js")) {
    const name = path.basename(file);
    if (!name.startsWith("locale-resolver-")) {
      continue;
    }
    let text = readFileSync(file, "utf8");
    const next = text.replace("var t=`en-US`,", "var t=`zh-CN`,");
    if (next !== text) {
      count += 1;
      writeFileSync(file, next);
    } else if (text.includes("var t=`zh-CN`,")) {
      count += 1;
    }
  }
  return { name: "locale resolver default zh-CN", count };
}

function patchI18nOfflineDefault(root) {
  let count = 0;
  for (const file of listFiles(path.join(root, "webview", "assets"), ".js")) {
    const name = path.basename(file);
    if (!name.startsWith("app-main-")) {
      continue;
    }
    let text = readFileSync(file, "utf8");
    const enableI18nPattern = /([A-Za-z_$][\w$]*\?\.get\(`enable_i18n`,)!1\)/g;
    const enableI18nPatchedPattern = /[A-Za-z_$][\w$]*\?\.get\(`enable_i18n`,!0\)/g;
    const matches = text.match(enableI18nPattern)?.length ?? 0;
    const next = text.replace(enableI18nPattern, "$1!0)");
    if (next !== text) {
      count += matches;
      writeFileSync(file, next);
    } else {
      count += text.match(enableI18nPatchedPattern)?.length ?? 0;
    }
  }
  return { name: "enable_i18n offline default true", count };
}

function patchCodeVBrowserAvailability(root) {
  let count = 0;
  for (const file of listFiles(path.join(root, "webview", "assets"), ".js")) {
    const name = path.basename(file);
    if (!name.startsWith("use-is-plugins-enabled-")) {
      continue;
    }
    let text = readFileSync(file, "utf8");
    const replacements = [
      [
        "let l=f(s),u=a===`chrome-extension`||o&&l.enabled&&!l.isLoading,p=r&&u,m=a===`chrome-extension`?!1:l.isLoading,h;",
        "let l=f(s),u=a===`chrome-extension`||l.enabled,p=r&&u,m=!1,h;",
      ],
      [
        "let c=u(s),d=i===`chrome-extension`||o&&c.enabled&&!c.isLoading,f=i===`chrome-extension`?!1:c.isLoading,p;",
        "let c=u(s),d=i===`chrome-extension`||c.enabled,f=!1,p;",
      ],
      [
        "let u=f(l),p=o(e.runCodexInWsl),m=u.enabled&&!u.isLoading,h=u.isLoading,g=p===!0,v;",
        "let u=f(l),p=o(e.runCodexInWsl),m=u.enabled,h=!1,g=p===!0,v;",
      ],
      [
        "let p=u(f),m=i(r.runCodexInWsl),h=p.enabled&&!p.isLoading,_=p.isLoading,v=m===!0,y;",
        "let p=u(f),m=i(r.runCodexInWsl),h=p.enabled,_=!1,v=m===!0,y;",
      ],
      [
        "function y({isBrowserAgentGateEnabled:e,isBrowserSidebarEnabled:t,isBrowserUseEnabled:n,isLoading:r,runCodexInWsl:i,windowType:a}){return a===`chrome-extension`?`window-type-disabled`:r?`loading`:t?e?n?i?`wsl-disabled`:`available`:`config-requirement-disabled`:`statsig-disabled`:`browser-pane-disabled`}",
        "function y({isBrowserAgentGateEnabled:e,isBrowserSidebarEnabled:t,isBrowserUseEnabled:n,isLoading:r,runCodexInWsl:i,windowType:a}){return a===`chrome-extension`?`window-type-disabled`:i?`wsl-disabled`:n===!1?`config-requirement-disabled`:`available`}",
      ],
      [
        "function g({isBrowserAgentGateEnabled:e,isBrowserSidebarEnabled:t,isBrowserUseEnabled:n,isLoading:r,runCodexInWsl:i,windowType:a}){return a===`chrome-extension`?`window-type-disabled`:r?`loading`:t?e?n?i?`wsl-disabled`:`available`:`config-requirement-disabled`:`statsig-disabled`:`browser-pane-disabled`}",
        "function g({isBrowserAgentGateEnabled:e,isBrowserSidebarEnabled:t,isBrowserUseEnabled:n,isLoading:r,runCodexInWsl:i,windowType:a}){return a===`chrome-extension`?`window-type-disabled`:i?`wsl-disabled`:n===!1?`config-requirement-disabled`:`available`}",
      ],
    ];
    for (const [target, replacement] of replacements) {
      const matches = text.split(target).length - 1;
      if (matches > 0) {
        text = text.split(target).join(replacement);
        count += matches;
      } else {
        count += text.split(replacement).length - 1;
      }
    }
    writeFileSync(file, text);
  }
  return { name: "CodeV browser availability ignores OAuth Statsig gates", count };
}

function patchCodeVComputerUseAvailability(root) {
  let count = 0;
  for (const file of listFiles(path.join(root, "webview", "assets"), ".js")) {
    const name = path.basename(file);
    if (!name.startsWith("use-is-plugins-enabled-")) {
      continue;
    }
    let text = readFileSync(file, "utf8");
    const replacements = [
      [
        "let _=a&&i&&u&&(o||g),v=_&&!o&&h.enabled&&!h.isLoading,y=_&&h.isLoading,b=_&&(o||h.isLoading),x;",
        "let _=a&&i&&g,v=_&&h.enabled,y=!1,b=!1,x;",
      ],
      [
        "let _=u(g),v=c===`windows`&&!o,y=h.isLoading||v&&_.isLoading,b=h.enabled&&(!v||_.enabled),x;",
        "let _=u(g),v=c===`windows`&&!o,y=!1,b=h.enabled,x;",
      ],
      [
        "function p({areRequiredFeaturesEnabled:e,enabled:t,isAnyFeatureLoading:n,isComputerUseGateEnabled:r,isHostCompatiblePlatform:i,isPlatformLoading:a,windowType:o}){return t?o===`electron`?r?a?`loading`:i?n?`loading`:e?`available`:`config-requirement-disabled`:`unsupported-platform`:`statsig-disabled`:`window-type-disabled`:`disabled`}",
        "function p({areRequiredFeaturesEnabled:e,enabled:t,isAnyFeatureLoading:n,isComputerUseGateEnabled:r,isHostCompatiblePlatform:i,isPlatformLoading:a,windowType:o}){return t?o===`electron`?a?`loading`:i?n?`loading`:e?`available`:`config-requirement-disabled`:`unsupported-platform`:`window-type-disabled`:`disabled`}",
      ],
    ];
    for (const [target, replacement] of replacements) {
      const matches = text.split(target).length - 1;
      if (matches > 0) {
        text = text.split(target).join(replacement);
        count += matches;
      } else {
        count += text.split(replacement).length - 1;
      }
    }
    writeFileSync(file, text);
  }
  return { name: "CodeV computer use availability ignores OAuth Statsig gate", count };
}

function patchCodeVDefaultFeatureOverrides(root) {
  let count = 0;
  for (const file of listFiles(path.join(root, "webview", "assets"), ".js")) {
    const name = path.basename(file);
    if (!name.startsWith("app-main-")) {
      continue;
    }
    let text = readFileSync(file, "utf8");
    const featureListTarget =
      "var fN=[`apps`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,b];";
    const featureListReplacement =
      "var fN=[`apps`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,b,`browser_use`,`browser_use_external`,`in_app_browser`];";
    const featureListTargetV2 =
      "var MB=[`apps_mcp_path_override`,`auth_elicitation`,`memories`,`tool_suggest`],NB=";
    const featureListReplacementV2 =
      "var MB=[`apps`,`apps_mcp_path_override`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,`browser_use`,`browser_use_external`,`in_app_browser`],NB=";
    const defaultOverrides =
      "{apps:!0,auth_elicitation:!0,enable_mcp_apps:!0,plugins:!0,tool_call_mcp_elicitation:!0,tool_search:!0,tool_suggest:!0,browser_use:!0,browser_use_external:!0,in_app_browser:!0}";
    const overrideTarget =
      "if(Xn(`set-default-feature-overrides`,{overrides:n??null}),n==null)return;let r=mN(n),";
    const overrideReplacement =
      `let codevFeatureOverrides=n??${defaultOverrides};Xn(\`set-default-feature-overrides\`,{overrides:codevFeatureOverrides});let r=mN(codevFeatureOverrides),`;
    const overrideTargetV2 =
      "if(Tt(`set-default-feature-overrides`,{overrides:n??null}),n==null)return;let i=IB(n,r),";
    const overrideReplacementV2 =
      `let codevFeatureOverrides=n??${defaultOverrides};Tt(\`set-default-feature-overrides\`,{overrides:codevFeatureOverrides});let i=IB(codevFeatureOverrides,r),`;
    const replacements = [
      [featureListTarget, featureListReplacement],
      [featureListTargetV2, featureListReplacementV2],
      [overrideTarget, overrideReplacement],
      [overrideTargetV2, overrideReplacementV2],
    ];
    for (const [target, replacement] of replacements) {
      const matches = text.split(target).length - 1;
      if (matches > 0) {
        text = text.split(target).join(replacement);
        count += matches;
      } else {
        count += text.split(replacement).length - 1;
      }
    }
    writeFileSync(file, text);
  }
  return { name: "CodeV default desktop experimental feature overrides", count };
}

function patchWindowsMicaBackground(root) {
  let count = 0;
  for (const file of listFiles(path.join(root, ".vite", "build"), ".js")) {
    const name = path.basename(file);
    if (!name.startsWith("main-")) {
      continue;
    }
    let text = readFileSync(file, "utf8");
    const replacements = [
      [
        "function VY({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return e===`win32`&&!LY(t)?{backgroundColor:_Y,backgroundMaterial:`none`}:n&&!LY(t)&&e===`darwin`?{backgroundColor:r?gY:_Y,backgroundMaterial:null}:{backgroundColor:hY,backgroundMaterial:null}}",
        "function VY({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!LY(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?gY:_Y,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!LY(t)?{backgroundColor:hY,backgroundMaterial:`mica`}:{backgroundColor:hY,backgroundMaterial:null}}",
      ],
      [
        "function VY({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!LY(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?gY:_Y,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!LY(t)?{backgroundColor:hY,backgroundMaterial:`mica`}:{backgroundColor:hY,backgroundMaterial:null}}",
        "function VY({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!LY(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?gY:_Y,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!LY(t)?{backgroundColor:hY,backgroundMaterial:`mica`}:{backgroundColor:hY,backgroundMaterial:null}}",
      ],
      [
        "function S3({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return e===`win32`&&!g3(t)?{backgroundColor:K4,backgroundMaterial:`none`}:n&&!g3(t)&&e===`darwin`?{backgroundColor:r?G4:K4,backgroundMaterial:null}:{backgroundColor:W4,backgroundMaterial:null}}",
        "function S3({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?G4:K4,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!g3(t)?{backgroundColor:W4,backgroundMaterial:`mica`}:{backgroundColor:W4,backgroundMaterial:null}}",
      ],
      [
        "function S3({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?G4:K4,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!g3(t)?{backgroundColor:W4,backgroundMaterial:`mica`}:{backgroundColor:W4,backgroundMaterial:null}}",
        "function S3({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?G4:K4,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!g3(t)?{backgroundColor:W4,backgroundMaterial:`mica`}:{backgroundColor:W4,backgroundMaterial:null}}",
      ],
    ];
    for (const [target, replacement] of replacements) {
      const matches = text.split(target).length - 1;
      if (matches > 0) {
        text = text.split(target).join(replacement);
        count += matches;
      } else {
        count += text.split(replacement).length - 1;
      }
    }
    writeFileSync(file, text);
  }
  return { name: "CodeV Windows Mica background preserved", count };
}

function patchStartupLoaderLightTheme(root) {
  const file = path.join(root, "webview", "index.html");
  if (!existsSync(file)) {
    return { name: "Codex-ZH light startup loader", count: 0 };
  }

  let text = readFileSync(file, "utf8");
  let count = 0;
  const replacements = [
    ["--startup-background: transparent;", "--startup-background: #f7f7f4;"],
    ["--startup-logo-base: #adadad;", "--startup-logo-base: #3d3d3a;"],
    ["--startup-logo-shimmer-soft: rgb(255 255 255 / 0.02);", "--startup-logo-shimmer-soft: rgb(255 255 255 / 0.1);"],
    ["--startup-logo-shimmer-peak: rgb(255 255 255 / 0.46);", "--startup-logo-shimmer-peak: rgb(0 0 0 / 0.2);"],
    ["--startup-logo-shimmer-tail: rgb(255 255 255 / 0.06);", "--startup-logo-shimmer-tail: rgb(255 255 255 / 0.16);"],
    ["justify-content: center;\n        background: var(--startup-background);", "justify-content: center;\n        gap: 14px;\n        color: #4b5563;\n        font-family:\n          -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\",\n          sans-serif;\n        background: var(--startup-background);"],
    ["      @media (prefers-reduced-motion: reduce) {", "      .startup-loader__label {\n        font-size: 13px;\n        line-height: 20px;\n        letter-spacing: 0;\n        opacity: 0.82;\n      }\n\n      @media (prefers-reduced-motion: reduce) {"],
  ];

  for (const [target, replacement] of replacements) {
    if (text.includes(replacement)) {
      count += 1;
      continue;
    }
    if (text.includes(target)) {
      text = text.split(target).join(replacement);
      count += 1;
    }
  }

  const startupLabel = '        <div class="startup-loader__label">正在启动 Codex-叉叉...</div>';
  if (text.includes(startupLabel)) {
    count += 1;
  } else {
    const next = text.replace(
      /(<div class="startup-loader__overlay"><\/div>\s*<\/div>)(?!\s*<div class="startup-loader__label">)/u,
      `$1\n${startupLabel}`,
    );
    if (next !== text) {
      text = next;
      count += 1;
    }
  }

  if (count > 0) {
    writeFileSync(file, text);
  }
  return { name: "Codex-ZH light startup loader", count };
}

// ---------------------------------------------------------------------------
// macOS patch set.
//
// The macOS Codex bundle ships the same features as Windows, but Vite emits
// different content-hash chunk names (app-initial~app-main~*, general-settings-*,
// page-*) and different minified identifiers, so the Windows string targets do
// not match. These targets were derived from an official macOS arm64 Codex app.
// Each anchors on stable, human-meaningful tokens (schema keys, string literals,
// destructured parameter names) rather than build-specific outer symbol names,
// so they survive minifier symbol churn but still fail loudly on real drift.
//
// Skipped vs Windows: the Mica background patch is Windows-only, and the startup
// loader light-theme patch is cosmetic; neither is part of the macOS v1 set.

function applyStringReplacements(text, pairs) {
  let count = 0;
  for (const [target, replacement] of pairs) {
    const matches = text.split(target).length - 1;
    if (matches > 0) {
      text = text.split(target).join(replacement);
      count += matches;
    } else {
      count += text.split(replacement).length - 1;
    }
  }
  return { text, count };
}

function patchMacFilesWithReplacements({ root, dirs, pairs, name }) {
  let count = 0;
  const files = [];
  for (const dir of dirs) {
    files.push(...listFiles(path.join(root, ...dir.split("/")), ".js"));
  }
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const result = applyStringReplacements(text, pairs);
    if (result.count > 0 && result.text !== text) {
      writeFileSync(file, result.text);
    }
    count += result.count;
  }
  return { name, count };
}

function patchMacLocaleOverrideDefault(root) {
  // The persisted "Explicit locale override" setting defaults to null; make it zh-CN.
  // Present in a webview chunk and in .vite/build workers, so scan the whole tree.
  return patchMacFilesWithReplacements({
    root,
    dirs: ["."],
    name: "mac localeOverride default zh-CN",
    pairs: [
      [
        "{agentAccess:`read-write`,default:null,description:`Explicit locale override`,key:`localeOverride`",
        "{agentAccess:`read-write`,default:`zh-CN`,description:`Explicit locale override`,key:`localeOverride`",
      ],
    ],
  });
}

function patchMacLocaleResolverDefault(root) {
  // The i18n loaders declare `en-US` as the fallback locale immediately before an
  // Object.assign map of ./locales/*.json chunks. Flip that fallback to zh-CN.
  let count = 0;
  const pattern = /`en-US`(,[A-Za-z0-9_$]{1,5}=Object\.assign\(\{"\.{1,2}\/locales\/)/g;
  const patchedPattern = /`zh-CN`,[A-Za-z0-9_$]{1,5}=Object\.assign\(\{"\.{1,2}\/locales\//g;
  for (const file of listFiles(path.join(root, "webview", "assets"), ".js")) {
    const text = readFileSync(file, "utf8");
    const matches = text.match(pattern)?.length ?? 0;
    if (matches > 0) {
      writeFileSync(file, text.replace(pattern, "`zh-CN`$1"));
      count += matches;
    } else {
      count += text.match(patchedPattern)?.length ?? 0;
    }
  }
  return { name: "mac locale resolver default zh-CN", count };
}

function patchMacI18nOfflineDefault(root) {
  // One offline read of enable_i18n still defaults to false; force it true so the
  // localized UI is used without waiting on a remote flag.
  return patchMacFilesWithReplacements({
    root,
    dirs: ["webview/assets"],
    name: "mac enable_i18n offline default true",
    pairs: [["`enable_i18n`,!1)", "`enable_i18n`,!0)"]],
  });
}

function patchMacBrowserAvailability(root) {
  // Browser availability gate: drop the OAuth/Statsig (`statsig-disabled`) and
  // sidebar/agent-gate branches so an API-key session still reports `available`.
  return patchMacFilesWithReplacements({
    root,
    dirs: ["webview/assets"],
    name: "mac browser availability ignores OAuth Statsig gates",
    pairs: [
      [
        "({isBrowserAgentGateEnabled:e,isBrowserSidebarEnabled:t,isBrowserUseEnabled:n,isLoading:r,runCodexInWsl:i,windowType:a}){return a===`chrome-extension`?`window-type-disabled`:r?`loading`:t?e?n?i?`wsl-disabled`:`available`:`config-requirement-disabled`:`statsig-disabled`:`browser-pane-disabled`}",
        "({isBrowserAgentGateEnabled:e,isBrowserSidebarEnabled:t,isBrowserUseEnabled:n,isLoading:r,runCodexInWsl:i,windowType:a}){return a===`chrome-extension`?`window-type-disabled`:i?`wsl-disabled`:n===!1?`config-requirement-disabled`:`available`}",
      ],
    ],
  });
}

function patchMacComputerUseAvailability(root) {
  // Computer Use availability gate: drop the Statsig gate branch (`r?...:statsig-disabled`)
  // so it reports `available` under an API-key session on a supported platform.
  return patchMacFilesWithReplacements({
    root,
    dirs: ["webview/assets"],
    name: "mac computer use availability ignores OAuth Statsig gate",
    pairs: [
      [
        "({areRequiredFeaturesEnabled:e,enabled:t,isAnyFeatureLoading:n,isComputerUseGateEnabled:r,isHostCompatiblePlatform:i,isPlatformLoading:a,windowType:o}){return t?o===`electron`?r?a?`loading`:i?n?`loading`:e?`available`:`config-requirement-disabled`:`unsupported-platform`:`statsig-disabled`:`window-type-disabled`:`disabled`}",
        "({areRequiredFeaturesEnabled:e,enabled:t,isAnyFeatureLoading:n,isComputerUseGateEnabled:r,isHostCompatiblePlatform:i,isPlatformLoading:a,windowType:o}){return t?o===`electron`?a?`loading`:i?n?`loading`:e?`available`:`config-requirement-disabled`:`unsupported-platform`:`window-type-disabled`:`disabled`}",
      ],
    ],
  });
}

function patchMacDefaultFeatureOverrides(root) {
  // Enable the browser/computer-use experimental features by default: add them to
  // the known-feature list and inject default overrides when none are set.
  const defaultOverrides =
    "{apps:!0,auth_elicitation:!0,enable_mcp_apps:!0,plugins:!0,tool_call_mcp_elicitation:!0,tool_search:!0,tool_suggest:!0,browser_use:!0,browser_use_external:!0,in_app_browser:!0}";
  return patchMacFilesWithReplacements({
    root,
    dirs: ["webview/assets"],
    name: "mac default desktop experimental feature overrides",
    pairs: [
      [
        "A7=[`apps_mcp_path_override`,`auth_elicitation`,`memories`,`tool_suggest`],j7=",
        "A7=[`apps`,`apps_mcp_path_override`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,`browser_use`,`browser_use_external`,`in_app_browser`],j7=",
      ],
      [
        "if(Ts(`set-default-feature-overrides`,{overrides:n??null}),n==null)return;let i=Vue(n,r),",
        `let codevFeatureOverrides=n??${defaultOverrides};Ts(\`set-default-feature-overrides\`,{overrides:codevFeatureOverrides});let i=Vue(codevFeatureOverrides,r),`,
      ],
    ],
  });
}

function listFiles(root, suffix) {
  const results = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function run(command, argv) {
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    fail(`${command} ${argv.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}

function requiredPath(value, flag) {
  if (!value) {
    fail(`Missing ${flag}\n\n${usage}`);
  }
  return path.resolve(value);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      fail(`Unexpected argument: ${key}\n\n${usage}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${key}\n\n${usage}`);
    }
    parsed[key.slice(2)] = value;
    i += 1;
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
