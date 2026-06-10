param(
  [Parameter(Mandatory = $true)]
  [string]$StageRoot,

  [string]$ProjectRoot = (Resolve-Path ".").Path,
  [string]$OutputDir = "C:\Codex-ZH\installer-output",
  [string]$Version = "0.1.1",
  [string]$InnoStageRoot = "",
  [string]$SourceCodexLabel = ""
)

$ErrorActionPreference = "Stop"

$StageRoot = [System.IO.Path]::GetFullPath($StageRoot)
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$IssPath = Join-Path $ProjectRoot "installer\CodexZh.iss"

if (!(Test-Path $StageRoot)) {
  throw "StageRoot not found: $StageRoot"
}
if (!(Test-Path (Join-Path $StageRoot "app\Codex.exe"))) {
  throw "Staged app\Codex.exe not found under StageRoot."
}
if (!(Test-Path $IssPath)) {
  throw "ISS file not found: $IssPath"
}

function Copy-DirectoryRobust {
  param([string]$Source, [string]$Destination)

  if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy $Source $Destination /MIR /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -gt 7) {
      throw "Robocopy failed with exit code $copyExitCode."
    }
    return
  }

  if (Test-Path -LiteralPath $Destination) {
    Remove-Item -LiteralPath $Destination -Force -Recurse
  }
  Copy-Item -Recurse -Force $Source $Destination
}

function ConvertTo-SafeFileLabel {
  param([string]$Label)

  $safe = $Label.Trim()
  $safe = $safe -replace '[\\/:*?"<>|]+', '-'
  $safe = $safe -replace '\s+', '-'
  $safe = $safe -replace '-+', '-'
  return $safe.Trim(".", "-")
}

function Get-StageManifest {
  $manifestPath = Join-Path $StageRoot "codex-zh-build.json"
  if (!(Test-Path -LiteralPath $manifestPath)) {
    return $null
  }

  return Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
}

function Get-SourceCodexFileLabel {
  if ($SourceCodexLabel) {
    return ConvertTo-SafeFileLabel $SourceCodexLabel
  }

  $manifest = Get-StageManifest
  if ($manifest) {
    $sourceAppDir = [string]$manifest.sourceAppDir
    if ($sourceAppDir -match 'OpenAI\.Codex[_\s-]+(\d+\.\d+\.\d+\.\d+)') {
      return ConvertTo-SafeFileLabel "OpenAI.Codex-$($Matches[1])"
    }

    $buildStamp = [string]$manifest.buildStamp
    if ($buildStamp -match '^(\d{2})(\d{4})(\d{4})$') {
      $major = [int]$Matches[1]
      $minor = [int]$Matches[2]
      $patch = [int]$Matches[3]
      return ConvertTo-SafeFileLabel "OpenAI.Codex-$major.$minor.$patch.0"
    }
  }

  $getAppxPackage = Get-Command Get-AppxPackage -ErrorAction SilentlyContinue
  if ($getAppxPackage) {
    $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
      Sort-Object { [version]$_.Version } -Descending |
      Select-Object -First 1
    if ($package) {
      return ConvertTo-SafeFileLabel "$($package.Name)-$($package.Version)"
    }
  }

  return "OpenAI.Codex-unknown"
}

$Candidates = @(
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$Iscc = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$Iscc) {
  $Command = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($Command) {
    $Iscc = $Command.Source
  }
}
if (!$Iscc) {
  throw "ISCC.exe not found. Install Inno Setup 6 first."
}

$sourceCodexFileLabel = Get-SourceCodexFileLabel
$outputBaseFilename = "$sourceCodexFileLabel+Codex-ZH-$Version-win-x64"

$EffectiveStageRoot = $StageRoot
if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
  if (!$InnoStageRoot) {
    $driveRoot = [System.IO.Path]::GetPathRoot($StageRoot)
    $InnoStageRoot = Join-Path $driveRoot "Codex-ZH\inno-stage-$Version"
  }
  $InnoStageRoot = [System.IO.Path]::GetFullPath($InnoStageRoot)
  if ($InnoStageRoot -ne $StageRoot) {
    Copy-DirectoryRobust -Source $StageRoot -Destination $InnoStageRoot
    $EffectiveStageRoot = $InnoStageRoot
  }
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
& $Iscc "/DSourceRoot=$EffectiveStageRoot" "/DOutputDir=$OutputDir" "/DMyAppVersion=$Version" "/DOutputBaseFilename=$outputBaseFilename" $IssPath
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE."
}

$installer = Join-Path $OutputDir "$outputBaseFilename.exe"
if (!(Test-Path $installer)) {
  throw "Installer was not created: $installer"
}
$hash = (Get-FileHash -Algorithm SHA256 $installer).Hash.ToLowerInvariant()
$shaPath = "$installer.sha256"
"$hash  $(Split-Path -Leaf $installer)" | Set-Content -LiteralPath $shaPath -Encoding ASCII

[ordered]@{
  installer = $installer
  sha256 = $hash
  sha256File = $shaPath
  signatureStatus = (Get-AuthenticodeSignature $installer).Status.ToString()
  sourceCodexLabel = $sourceCodexFileLabel
  outputBaseFilename = $outputBaseFilename
  sourceStageRoot = $StageRoot
  innoSourceRoot = $EffectiveStageRoot
} | ConvertTo-Json -Depth 6
