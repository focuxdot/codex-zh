import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const launcher = readFileSync("launcher/CodexZhLauncher.ps1", "utf8");
const staging = readFileSync("scripts/build-codex-zh-staging.ps1", "utf8");
const customizer = readFileSync("scripts/customize-codex-default-zh-cn.mjs", "utf8");
const integrityPatcher = readFileSync("scripts/patch-codex-asar-integrity.mjs", "utf8");
const installerScript = readFileSync("scripts/build-codex-zh-installer.ps1", "utf8");
const installer = readFileSync("installer/CodexZh.iss", "utf8");
const nativeLauncher = readFileSync("native/CodexZhLauncher.cs", "utf8");
const nativeBuild = readFileSync("native/Build-CodexZhLauncher.ps1", "utf8");

test("launcher carries CodeV runtime repairs without taking over user appearance", () => {
  assert.match(launcher, /seen-model-upgrade-list/u);
  assert.match(launcher, /electron:onboarding-hide-first-new-thread-promos/u);
  assert.match(launcher, /TrimStart\(\[char\]0xFEFF\)/u);
  assert.match(launcher, /\[marketplaces\.openai-bundled\]/u);
  assert.match(launcher, /codex-zh\\capabilities\.json/u);
  assert.match(launcher, /Ensure-ComputerUsePluginInstalled/u);
  assert.match(launcher, /"plugin", "add", "computer-use", "--marketplace", "openai-bundled"/u);
  assert.match(launcher, /Ensure-ComputerUsePluginCache/u);
  assert.match(launcher, /Copy-PluginTreeBestEffort/u);
  assert.match(launcher, /RedirectStandardError/u);
  assert.match(launcher, /\[plugins\."computer-use@openai-bundled"\]/u);
  assert.match(launcher, /bin\\open-computer-use\.exe/u);
  assert.match(launcher, /Show-RouterConfigWindow/u);
  assert.match(launcher, /Test-ActiveRouterConfig/u);
  assert.match(launcher, /Save-RouterProfile/u);
  assert.match(launcher, /WindowStyle Hidden/u);
  assert.match(launcher, /Load-SavedRouterProfiles/u);
  assert.match(launcher, /profiles\.json/u);
  assert.match(launcher, /ProfileStore/u);
  assert.match(launcher, /apiKeySource = "config"/u);
  assert.match(launcher, /Test-RouterProviderConnection/u);
  assert.match(launcher, /type = "input_text"; text = "Reply with OK\."/u);
  assert.match(launcher, /stream = \$false/u);
  assert.doesNotMatch(launcher, /max_output_tokens = 8/u);
  assert.match(launcher, /Repair-ActiveRouterConfigWireApi/u);
  assert.match(launcher, /Normalize-WireApi/u);
  assert.doesNotMatch(launcher, /wireApi = "chat"/u);
  assert.doesNotMatch(launcher, /Items\.Add\("chat"\)/u);

  assert.doesNotMatch(launcher, /appearanceTheme/u);
  assert.doesNotMatch(launcher, /\$env:CODEX_ELECTRON_USER_DATA_PATH\s*=/u);
  assert.doesNotMatch(launcher, /--disable-gpu/u);
});

test("staging writes bundled marketplace metadata as UTF-8 without BOM", () => {
  assert.match(staging, /function Write-Utf8NoBom/u);
  assert.match(staging, /Write-Utf8NoBom -Path \$marketplacePath/u);
  assert.doesNotMatch(staging, /Set-Content -LiteralPath \$marketplacePath -Encoding UTF8/u);
});

test("launcher presets default to Wokey before custom and OpenRouter", () => {
  assert.match(
    launcher,
    /\$presets = \[ordered\]@\{\s*"wokey" = \[ordered\]@\{[^}]+baseUrl = "https:\/\/api\.wokey\.ai"[^}]+model = "auto"[^}]+apiKey = "sk-3d6c1264227a52f75af4028bcc3c217b"[^}]+\}\s*"custom" = \[ordered\]@\{[^}]+\}\s*"openrouter" = \[ordered\]@\{/u,
  );
  assert.match(launcher, /Load-SavedRouterProfiles/u);
  assert.match(launcher, /\$presetBox\.SelectedItem = "wokey"/u);
  assert.match(launcher, /Apply-Preset "wokey"/u);
  assert.match(launcher, /\$apiKeyBox = Add-TextBox 170 164 \$false/u);
  assert.doesNotMatch(launcher, /\$apiKeyBox = Add-TextBox 170 164 \$true/u);
  assert.match(launcher, /\$apiKeyBox\.Text = if \(\$preset\.apiKey\) \{ \$preset\.apiKey \} else \{ "" \}/u);
});

test("launcher router config window keeps advanced fields collapsed and API key visible", () => {
  assert.match(launcher, /Q29kZXgtWkgg5Lit6L2s56uZ6K6\+572u/u);
  assert.match(launcher, /6YCJ5oup5Lit6L2s56uZ/u);
  assert.match(launcher, /Add-Label \(ZH "5Lit6L2s56uZ"\) 48 82/u);
  assert.match(launcher, /Add-Label \(ZH "5o6l5Y\+j5Zyw5Z2A"\) 48 124/u);
  assert.match(launcher, /Add-Label \(ZH "5qih5Z6L"\) 48 208/u);
  assert.match(launcher, /\$advancedToggle = New-Object System\.Windows\.Forms\.CheckBox/u);
  assert.match(launcher, /6auY57qn6K6\+572u/u);
  assert.match(launcher, /Set-AdvancedVisible \$false/u);
  assert.match(launcher, /\$advancedControls = @\(\$providerLabel, \$providerBox, \$nameLabel, \$nameBox, \$wireLabel, \$wireBox\)/u);
  assert.match(launcher, /Provider ID/u);
  assert.match(launcher, /5pi\+56S65ZCN56ew/u);
  assert.match(launcher, /5o6l5Y\+j57G75Z6L/u);
  assert.match(launcher, /5L\+d5a2Y5ZCO5Lya5pu05pawIENvZGV4IOmFjee9ru\+8jEFQSSBLZXkg5LuF5L\+d5a2Y5Zyo5pys5py6IGNvbmZpZy50b21s44CC/u);
});

test("launcher keeps connection test separate from primary actions", () => {
  assert.match(launcher, /\$testButton\.Location = New-Object System\.Drawing\.Point\(48, 372\)/u);
  assert.match(launcher, /\$cancelButton\.Location = New-Object System\.Drawing\.Point\(332, 372\)/u);
  assert.match(launcher, /\$saveButton\.Location = New-Object System\.Drawing\.Point\(422, 372\)/u);
  assert.match(launcher, /\$saveLaunchButton\.Location = New-Object System\.Drawing\.Point\(512, 372\)/u);
  assert.match(launcher, /\$testButton\.Location = New-Object System\.Drawing\.Point\(48, \$buttonY\)[\s\S]*\$cancelButton\.Location = New-Object System\.Drawing\.Point\(332, \$buttonY\)/u);
});

test("launcher shows router config before runtime initialization when config is missing", () => {
  const launchFlowStart = launcher.indexOf('throw "Codex.exe not found: $CodexExe"');
  assert.notEqual(launchFlowStart, -1);
  const launchFlow = launcher.slice(launchFlowStart);
  const noLaunchIndex = launchFlow.indexOf("if ($NoLaunch)");
  const noLaunchInitIndex = launchFlow.indexOf("Initialize-CodexZhRuntime", noLaunchIndex);
  const configGateIndex = launchFlow.indexOf("if ($Configure -or !(Test-ActiveRouterConfig))");
  const configDialogIndex = launchFlow.indexOf("Show-RouterConfigWindow", configGateIndex);
  const normalInitIndex = launchFlow.indexOf("Initialize-CodexZhRuntime", configGateIndex);

  assert.ok(noLaunchIndex >= 0);
  assert.ok(noLaunchInitIndex > noLaunchIndex);
  assert.ok(configGateIndex > noLaunchInitIndex);
  assert.ok(configDialogIndex > configGateIndex);
  assert.ok(normalInitIndex > configDialogIndex);
});

test("staging copies the full Windows app with robocopy", () => {
  assert.match(staging, /function Copy-DirectoryRobust/u);
  assert.match(staging, /robocopy \$Source \$Destination \/E \/R:2 \/W:1/u);
  assert.match(staging, /\$copyExitCode -gt 7/u);
  assert.match(staging, /Copy-DirectoryRobust -Source \$SourceAppDir -Destination \$StageApp/u);
});

test("staging cleans long Windows app paths with robocopy mirror", () => {
  assert.match(staging, /function Remove-DirectoryRobust/u);
  assert.match(staging, /robocopy \$empty \$Path \/MIR \/R:2 \/W:1/u);
  assert.match(staging, /\$mirrorExitCode -gt 7/u);
  assert.match(staging, /Remove-DirectoryRobust \$StageRoot/u);
});

test("installer mirrors long staging paths before invoking Inno Setup", () => {
  assert.match(installerScript, /\[string\]\$OutputDir = "C:\\Codex-ZH\\installer-output"/u);
  assert.match(installerScript, /\[string\]\$InnoStageRoot = ""/u);
  assert.match(installerScript, /function Copy-DirectoryRobust/u);
  assert.match(installerScript, /robocopy \$Source \$Destination \/MIR \/R:2 \/W:1/u);
  assert.match(installerScript, /Codex-ZH\\inno-stage-\$Version/u);
  assert.match(installerScript, /\/DSourceRoot=\$EffectiveStageRoot/u);
});

test("installer filename includes the source Codex app label", () => {
  assert.match(installer, /#define OutputBaseFilename "Codex-ZH-\{#MyAppVersion\}-win-x64"/u);
  assert.match(installer, /OutputBaseFilename=\{#OutputBaseFilename\}/u);
  assert.match(installerScript, /\[string\]\$SourceCodexLabel = ""/u);
  assert.match(installerScript, /function Get-SourceCodexFileLabel/u);
  assert.match(installerScript, /OpenAI\.Codex-\$\(\$Matches\[1\]\)/u);
  assert.match(installerScript, /OpenAI\.Codex-\$major\.\$minor\.\$patch\.0/u);
  assert.match(installerScript, /\$outputBaseFilename = "\$sourceCodexFileLabel\+Codex-ZH-\$Version-win-x64"/u);
  assert.match(installerScript, /\/DOutputBaseFilename=\$outputBaseFilename/u);
  assert.match(installerScript, /\$installer = Join-Path \$OutputDir "\$outputBaseFilename\.exe"/u);
});

test("installed shortcuts use native GUI launcher instead of PowerShell", () => {
  assert.match(staging, /Build-CodexZhLauncher\.ps1/u);
  assert.match(staging, /CodexZhLauncher\.exe/u);
  assert.match(nativeBuild, /\/target:winexe/u);
  assert.match(nativeLauncher, /CreateNoWindow\s*=\s*true/u);
  assert.match(nativeLauncher, /ProcessWindowStyle\.Hidden/u);
  assert.match(nativeLauncher, /"--configure"/u);
  assert.match(nativeLauncher, /"-Configure"/u);
  assert.match(installer, /Filename: "\{app\}\\CodexZhLauncher\.exe"/u);
  assert.match(installer, /Codex 中转站配置"; Filename: "\{app\}\\CodexZhLauncher\.exe"; Parameters: "--configure"/u);
  assert.match(installer, /Codex-ZH Config\.lnk/u);
  assert.doesNotMatch(installer, /\[Icons\][\s\S]*Filename: "\{sys\}\\WindowsPowerShell\\v1\.0\\powershell\.exe"/u);
});

test("ASAR customization replaces the transparent black startup loader", () => {
  assert.match(customizer, /patchStartupLoaderLightTheme/u);
  assert.match(customizer, /--startup-background: #f7f7f4;/u);
  assert.match(customizer, /正在启动 Codex-ZH\.\.\./u);
  assert.match(customizer, /startup-loader__overlay[\s\S]+startup-loader__label/u);
});

test("ASAR customization tolerates minified enable_i18n variable changes", () => {
  assert.match(customizer, /enableI18nPattern/u);
  assert.match(customizer, /enable_i18n`,\)!1/u);
  assert.doesNotMatch(customizer, /const target = "n\?\.get\(`enable_i18n`,!1\)"/u);
});

test("ASAR customization preserves the Windows Mica background", () => {
  assert.match(customizer, /patchWindowsMicaBackground/u);
  assert.match(customizer, /backgroundMaterial:`mica`/u);
  assert.match(customizer, /CodeV Windows Mica background preserved/u);
  assert.match(customizer, /backgroundColor:_Y,backgroundMaterial:`none`[\s\S]+backgroundMaterial:`mica`/u);
  assert.match(customizer, /backgroundColor:K4,backgroundMaterial:`none`[\s\S]+backgroundMaterial:`mica`/u);
  assert.doesNotMatch(customizer, /CodeV Windows opaque light background and Mica disable/u);
});

test("ASAR integrity patcher can skip newer executables without embedded old hash", () => {
  assert.match(integrityPatcher, /old_hash_not_found/u);
  assert.match(integrityPatcher, /skipped: true/u);
  assert.match(integrityPatcher, /Expected at most one old hash occurrence/u);
});
