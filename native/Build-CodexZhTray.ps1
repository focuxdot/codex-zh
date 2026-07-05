param(
  [string]$SourceRoot = "",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

if (!$SourceRoot) {
  $SourceRoot = Split-Path -Parent $PSScriptRoot
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)

if (!$OutFile) {
  $OutFile = Join-Path $SourceRoot "CodexZhTray.exe"
}

$SourceFile = Join-Path $SourceRoot "native\CodexZhTray.cs"
$IconFile = Join-Path $SourceRoot "app\resources\icon.ico"

if (!(Test-Path $SourceFile)) {
  throw "CodexZhTray.cs not found: $SourceFile"
}

$Candidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)

$Csc = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$Csc) {
  $Command = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($Command) {
    $Csc = $Command.Source
  }
}

if (!$Csc) {
  throw "csc.exe not found. Install .NET Framework developer tools or .NET SDK."
}

# WinForms tray needs explicit refs to System.Windows.Forms/Drawing and
# System.Web.Extensions (JavaScriptSerializer). The Framework 4.x csc does not
# include these by default (CodexZhLauncher.cs only used mscorlib).
$Args = @(
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/reference:System.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Web.Extensions.dll",
  "/out:$OutFile"
)

if (Test-Path $IconFile) {
  $Args += "/win32icon:$IconFile"
}

$Args += $SourceFile

& $Csc @Args

if ($LASTEXITCODE -ne 0) {
  throw "CodexZhTray compile failed with exit code $LASTEXITCODE."
}
if (!(Test-Path $OutFile)) {
  throw "CodexZhTray.exe was not created: $OutFile"
}

Get-Item $OutFile | Select-Object FullName,Length,LastWriteTime
