param(
  [Parameter(Mandatory = $true)]
  [string]$Installer
)

$ErrorActionPreference = "Stop"

$Installer = [System.IO.Path]::GetFullPath($Installer)
if (!(Test-Path $Installer)) {
  throw "Installer not found: $Installer"
}

Get-Process Codex, powershell -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "*\Codex-ZH\*" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

$uninstallRoots = @(
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)
foreach ($root in $uninstallRoots) {
  if (!(Test-Path $root)) { continue }
  Get-ChildItem $root | ForEach-Object {
    $item = Get-ItemProperty $_.PSPath
    if ($item.DisplayName -eq "Codex-ZH" -and $item.UninstallString) {
      $uninstaller = $item.UninstallString.Trim('"')
      if (Test-Path $uninstaller) {
        $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -Wait -PassThru
        if ($uninstallProcess.ExitCode -ne 0) {
          throw "Uninstaller failed with exit code $($uninstallProcess.ExitCode)."
        }
      }
    }
  }
}

$installDir = "C:\Program Files\Codex-ZH"
if (Test-Path $installDir) {
  Remove-Item -Force -Recurse $installDir
}

$installProcess = Start-Process -FilePath $Installer -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -Wait -PassThru
if ($installProcess.ExitCode -ne 0) {
  throw "Installer failed with exit code $($installProcess.ExitCode)."
}

[ordered]@{
  installDir = $installDir
  launcher = Join-Path $installDir "launcher\CodexZhLauncher.ps1"
  codexExe = Join-Path $installDir "app\Codex.exe"
} | ConvertTo-Json -Depth 6
