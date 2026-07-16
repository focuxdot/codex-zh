#define MyAppName "Codex-叉叉"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.1"
#endif
#ifndef SourceRoot
  #define SourceRoot "C:\Codex-ZH\staging\Codex-ZH"
#endif
#ifndef OutputDir
  #define OutputDir "C:\Codex-ZH\installer-output"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "Codex-ZH-{#MyAppVersion}-win-x64"
#endif

[Setup]
AppId={{6C6DA7B7-7837-4875-9EC1-C0B82624D3DF}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Codex-叉叉
DefaultDirName={autopf}\Codex-ZH
DefaultGroupName=Codex-叉叉
DisableProgramGroupPage=yes
SetupIconFile={#SourceRoot}\app\resources\icon.ico
UninstallDisplayIcon={app}\app\resources\icon.ico
OutputBaseFilename={#OutputBaseFilename}
OutputDir={#OutputDir}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
; Disable the built-in Restart Manager "close applications" prompt. codex.exe is a
; console app and the bundled daemon is a background node.exe — neither responds to
; RM's graceful shutdown, so RM either shows a confusing English prompt (listing
; "Node.js JavaScript Runtime") or fails to close them, leaving "DeleteFile failed;
; code 5". We force-close them ourselves in PrepareToInstall instead.
CloseApplications=no

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Codex-叉叉"; Filename: "{app}\CodexZhLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app\resources\icon.ico"
Name: "{group}\Codex 中转站配置"; Filename: "{app}\CodexZhLauncher.exe"; Parameters: "--configure"; WorkingDir: "{app}"; IconFilename: "{app}\app\resources\icon.ico"
Name: "{autodesktop}\Codex-叉叉"; Filename: "{app}\CodexZhLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app\resources\icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[InstallDelete]
Type: files; Name: "{group}\Codex-ZH Config.lnk"
; Remove shortcuts created under the old "Codex-ZH" display name so a rename upgrade
; does not leave duplicate Start Menu / desktop icons.
Type: files; Name: "{autoprograms}\Codex-ZH\Codex-ZH.lnk"
Type: files; Name: "{autoprograms}\Codex-ZH\Codex 中转站配置.lnk"
Type: files; Name: "{autoprograms}\Codex-ZH\手机远程接管.lnk"
Type: filesandordirs; Name: "{autoprograms}\Codex-ZH"
Type: files; Name: "{autodesktop}\Codex-ZH.lnk"
; Remote takeover moved to the standalone CXX project; drop the leftover shortcut on upgrade.
Type: files; Name: "{group}\手机远程接管.lnk"

[Run]
Filename: "{app}\CodexZhLauncher.exe"; Parameters: "--no-launch"; WorkingDir: "{app}"; Flags: runhidden

[UninstallRun]
; Stop holding processes before file removal so uninstall does not hit the same
; "拒绝访问 / DeleteFile failed; code 5" lock on codex.exe / the daemon node.exe.
Filename: "{sys}\schtasks.exe"; Parameters: "/End /TN CodexZhRemote"; Flags: runhidden; RunOnceId: "EndCodexZhRemoteTask"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM codex.exe /T"; Flags: runhidden; RunOnceId: "KillCodexCli"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM CodexZhTray.exe /T"; Flags: runhidden; RunOnceId: "KillCodexTray"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM CodexZhLauncher.exe /T"; Flags: runhidden; RunOnceId: "KillCodexLauncher"
; Remove the Remote keepalive scheduled task (created on demand by "enable"); ignore if absent.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN CodexZhRemote /F"; Flags: runhidden; RunOnceId: "DelCodexZhRemoteTask"

[Code]
// Upgrade installs fail with "DeleteFile failed; code 5 / 拒绝访问" when the old
// app\resources\codex.exe (or the Remote daemon pinned to it) is still running and
// holds a file handle. Windows Restart Manager cannot close these console/tray
// processes because they are not RM-aware, so we stop them ourselves before any
// file is extracted. Runs after the wizard, before [Files] extraction.
procedure StopCodexProcesses;
var
  ResultCode: Integer;
  AppDir, PsCmd: String;
begin
  // End the running Remote keepalive task instance (it respawns codex.exe / node.exe).
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN CodexZhRemote', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Kill the CLI, tray and launcher by image name (/T also drops their children).
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM codex.exe /T', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM CodexZhTray.exe /T', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM CodexZhLauncher.exe /T', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  // Kill only desktop/node processes launched from inside the install dir. The
  // official desktop is now ChatGPT.exe, so a global taskkill would also close the
  // user's stock ChatGPT app; filtering by ExecutablePath avoids that collateral.
  AppDir := ExpandConstant('{app}');
  if AppDir <> '' then
  begin
    // Single quotes only inside -Command so no double quotes nest in the outer "...".
    PsCmd :=
      'Get-CimInstance Win32_Process | Where-Object { ' +
      '$_.Name -in @(''node.exe'',''ChatGPT.exe'',''Codex.exe'') -and $_.ExecutablePath -and ' +
      '$_.ExecutablePath -like ''' + AppDir + '\*'' } | ' +
      'ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }';
    Exec('powershell.exe',
         '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + PsCmd + '"',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopCodexProcesses;
  // Give Windows a moment to release the file handles before extraction begins.
  Sleep(1200);
  Result := '';
end;
