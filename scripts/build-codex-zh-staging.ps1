param(
  [Parameter(Mandatory = $true)]
  [string]$SourceAppDir,

  [string]$ProjectRoot = (Resolve-Path ".").Path,
  [string]$OutputRoot = "C:\Codex-ZH\staging",
  [string]$ComputerUsePluginDir = "",
  [string]$BuildStamp = (Get-Date -Format "yyyyMMdd-HHmmss"),
  [switch]$SkipAsarCustomization
)

$ErrorActionPreference = "Stop"

# Silence Node deprecation/experimental warnings (e.g. DEP0190 from npx/@electron/asar
# spawning with shell:true). On newer Node these go to stderr, which under
# ErrorActionPreference=Stop would abort the build mid-way (customize done but the
# integrity-patched asar not yet copied back). Harmless for a trusted build.
$env:NODE_NO_WARNINGS = "1"

$SourceAppDir = [System.IO.Path]::GetFullPath($SourceAppDir)
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$StageRoot = Join-Path $OutputRoot "Codex-ZH-$BuildStamp"
$StageApp = Join-Path $StageRoot "app"
$LauncherDir = Join-Path $StageRoot "launcher"

function Require-Path {
  param([string]$Path, [string]$Message)
  if (!(Test-Path $Path)) {
    throw "$Message`: $Path"
  }
}

function Get-DesktopExecutable {
  param([string]$AppDir)
  foreach ($name in @("ChatGPT.exe", "Codex.exe")) {
    $candidate = Join-Path $AppDir $name
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }
  throw "ChatGPT.exe or Codex.exe not found under source app directory: $AppDir"
}

function Get-NodeCommand {
  $bundled = Join-Path $StageApp "resources\node.exe"
  if (Test-Path $bundled) {
    return $bundled
  }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  throw "node.exe not found. Install Node.js or provide a Codex app with app\resources\node.exe."
}

function Remove-AppleDoubleFiles {
  param([string]$Path)
  Get-ChildItem -LiteralPath $Path -Recurse -Force -File -Filter "._*" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Value)
  [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Copy-DirectoryRobust {
  param([string]$Source, [string]$Destination)

  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy $Source $Destination /E /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) {
      throw "Robocopy failed with exit code $copyExitCode."
    }
    return
  }

  Copy-Item -Recurse -Force $Source $Destination
}

function Remove-DirectoryRobust {
  param([string]$Path)

  if (!(Test-Path -LiteralPath $Path)) {
    return
  }

  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    $empty = Join-Path $env:TEMP "codex-zh-empty-$([System.Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    & robocopy $empty $Path /MIR /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    $mirrorExitCode = $LASTEXITCODE
    Remove-Item -LiteralPath $empty -Force -Recurse
    if ($mirrorExitCode -gt 7) {
      throw "Robocopy cleanup failed with exit code $mirrorExitCode."
    }
  }

  Remove-Item -LiteralPath $Path -Force -Recurse
}

function Add-ComputerUsePlugin {
  param([string]$PluginDir, [string]$StageApp)

  if (!$PluginDir) { return }

  $PluginDir = [System.IO.Path]::GetFullPath($PluginDir)
  Require-Path $PluginDir "Computer Use plugin directory not found"
  Require-Path (Join-Path $PluginDir ".codex-plugin\plugin.json") "Computer Use plugin manifest not found"
  Require-Path (Join-Path $PluginDir ".mcp.json") "Computer Use MCP config not found"

  $bundledRoot = Join-Path $StageApp "resources\plugins\openai-bundled"
  $pluginsRoot = Join-Path $bundledRoot "plugins"
  $destination = Join-Path $pluginsRoot "computer-use"
  $marketplacePath = Join-Path $bundledRoot ".agents\plugins\marketplace.json"

  Require-Path $pluginsRoot "Bundled plugins root not found"
  Require-Path $marketplacePath "Bundled marketplace metadata not found"

  if (Test-Path $destination) {
    Remove-Item -Force -Recurse $destination
  }
  Copy-Item -Recurse -Force $PluginDir $destination

  $marketplace = Get-Content -Raw -LiteralPath $marketplacePath | ConvertFrom-Json
  $existing = @($marketplace.plugins | Where-Object { $_.name -ne "computer-use" })
  $computerUse = [pscustomobject]@{
    name = "computer-use"
    source = [pscustomobject]@{
      source = "local"
      path = "./plugins/computer-use"
    }
    policy = [pscustomobject]@{
      installation = "AVAILABLE"
      authentication = "ON_INSTALL"
    }
    category = "Productivity"
  }
  $marketplace.plugins = @($existing + $computerUse)
  Write-Utf8NoBom -Path $marketplacePath -Value (($marketplace | ConvertTo-Json -Depth 16) + "`n")
}

Require-Path $SourceAppDir "Source app directory not found"
$sourceDesktopExe = Get-DesktopExecutable $SourceAppDir
Require-Path (Join-Path $SourceAppDir "resources\app.asar") "app.asar not found"
Require-Path (Join-Path $ProjectRoot "scripts\customize-codex-default-zh-cn.mjs") "ASAR customizer not found"
Require-Path (Join-Path $ProjectRoot "scripts\patch-codex-asar-integrity.mjs") "ASAR integrity patcher not found"
Require-Path (Join-Path $ProjectRoot "launcher\CodexZhLauncher.ps1") "launcher not found"
Require-Path (Join-Path $ProjectRoot "native\Build-CodexZhLauncher.ps1") "native launcher build script not found"
Require-Path (Join-Path $ProjectRoot "native\CodexZhLauncher.cs") "native launcher source not found"
Require-Path (Join-Path $ProjectRoot "remote\daemon\src\main.mjs") "remote daemon not found"
Require-Path (Join-Path $ProjectRoot "launcher\remote-backend-core.mjs") "remote backend core not found"
Require-Path (Join-Path $ProjectRoot "launcher\win\remote-backend.mjs") "windows remote backend not found"
Require-Path (Join-Path $ProjectRoot "native\Build-CodexZhTray.ps1") "native tray build script not found"
Require-Path (Join-Path $ProjectRoot "native\CodexZhTray.cs") "native tray source not found"

if (Test-Path $StageRoot) {
  Remove-DirectoryRobust $StageRoot
}
New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
Copy-DirectoryRobust -Source $SourceAppDir -Destination $StageApp
Remove-AppleDoubleFiles $StageApp
Add-ComputerUsePlugin $ComputerUsePluginDir $StageApp
Remove-AppleDoubleFiles $StageApp
New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null
Copy-Item -Force (Join-Path $ProjectRoot "launcher\CodexZhLauncher.ps1") $LauncherDir
New-Item -ItemType Directory -Force -Path (Join-Path $StageRoot "native") | Out-Null
Copy-Item -Force (Join-Path $ProjectRoot "native\CodexZhLauncher.cs") (Join-Path $StageRoot "native")
& (Join-Path $ProjectRoot "native\Build-CodexZhLauncher.ps1") -SourceRoot $StageRoot -OutFile (Join-Path $StageRoot "CodexZhLauncher.exe")
if ($LASTEXITCODE -ne 0) {
  throw "Native launcher build failed with exit code $LASTEXITCODE."
}

# Remote subsystem: daemon source + Windows backend/core + tray exe.
# Layout mirrors macOS: <root>\remote\daemon\src\main.mjs (keepalive target),
# <root>\launcher\{remote-backend-core.mjs, win\remote-backend.mjs} (tray backend).
Copy-DirectoryRobust -Source (Join-Path $ProjectRoot "remote") -Destination (Join-Path $StageRoot "remote")
Remove-AppleDoubleFiles (Join-Path $StageRoot "remote")
Copy-Item -Force (Join-Path $ProjectRoot "launcher\remote-backend-core.mjs") $LauncherDir
Copy-DirectoryRobust -Source (Join-Path $ProjectRoot "launcher\win") -Destination (Join-Path $LauncherDir "win")
Copy-Item -Force (Join-Path $ProjectRoot "native\CodexZhTray.cs") (Join-Path $StageRoot "native")
& (Join-Path $ProjectRoot "native\Build-CodexZhTray.ps1") -SourceRoot $StageRoot -OutFile (Join-Path $StageRoot "CodexZhTray.exe")
if ($LASTEXITCODE -ne 0) {
  throw "Native tray build failed with exit code $LASTEXITCODE."
}

if (!$SkipAsarCustomization) {
  $node = Get-NodeCommand
  $workRoot = Join-Path $env:TEMP "codex-zh-asar-$BuildStamp"
  $extractDir = Join-Path $workRoot "extract"
  $patchWorkDir = Join-Path $workRoot "patched"
  $patchedAsar = Join-Path $workRoot "app.patched.asar"
  $oldAsar = Join-Path $workRoot "app.old.asar"
  $appAsar = Join-Path $StageApp "resources\app.asar"
  $appAsarUnpacked = Join-Path $StageApp "resources\app.asar.unpacked"
  $codexExe = Join-Path $StageApp (Split-Path -Leaf $sourceDesktopExe)

  if (Test-Path $workRoot) {
    Remove-DirectoryRobust $workRoot
  }
  New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
  Copy-Item -Force $appAsar $oldAsar

  & npx --yes "@electron/asar" extract $appAsar $extractDir
  if ($LASTEXITCODE -ne 0) {
    throw "ASAR extraction failed with exit code $LASTEXITCODE."
  }

  $customizerArgs = @(
    (Join-Path $ProjectRoot "scripts\customize-codex-default-zh-cn.mjs"),
    "--asar-dir", $extractDir,
    "--work-dir", $patchWorkDir,
    "--out-asar", $patchedAsar
  )
  if (Test-Path $appAsarUnpacked) {
    $customizerArgs += @("--asar-unpacked-dir", $appAsarUnpacked)
  }
  & $node @customizerArgs
  if ($LASTEXITCODE -ne 0) {
    throw "ASAR customization failed with exit code $LASTEXITCODE."
  }

  & $node (Join-Path $ProjectRoot "scripts\patch-codex-asar-integrity.mjs") `
    --exe $codexExe `
    --asar $patchedAsar `
    --old-asar $oldAsar
  if ($LASTEXITCODE -ne 0) {
    throw "ASAR integrity patch failed with exit code $LASTEXITCODE."
  }

  Copy-Item -Force $patchedAsar $appAsar
}

$manifest = [ordered]@{
  buildStamp = $BuildStamp
  sourceAppDir = $SourceAppDir
  sourceExecutable = (Split-Path -Leaf $sourceDesktopExe)
  stageRoot = $StageRoot
  stageApp = $StageApp
}
$manifestPath = Join-Path $StageRoot "codex-zh-build.json"
Write-Utf8NoBom -Path $manifestPath -Value (($manifest | ConvertTo-Json -Depth 8) + "`n")

$manifest | ConvertTo-Json -Depth 8
