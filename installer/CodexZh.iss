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

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Codex-叉叉"; Filename: "{app}\CodexZhLauncher.exe"; WorkingDir: "{app}"; IconFilename: "{app}\app\resources\icon.ico"
Name: "{group}\Codex 中转站配置"; Filename: "{app}\CodexZhLauncher.exe"; Parameters: "--configure"; WorkingDir: "{app}"; IconFilename: "{app}\app\resources\icon.ico"
Name: "{group}\手机远程接管"; Filename: "{app}\CodexZhTray.exe"; Parameters: """{app}\app\resources\cua_node\bin\node.exe"" ""{app}\launcher\win\remote-backend.mjs"""; WorkingDir: "{app}"; IconFilename: "{app}\app\resources\icon.ico"
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

[Run]
Filename: "{app}\CodexZhLauncher.exe"; Parameters: "--no-launch"; WorkingDir: "{app}"; Flags: runhidden

[UninstallRun]
; Remove the Remote keepalive scheduled task (created on demand by "enable"); ignore if absent.
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN CodexZhRemote /F"; Flags: runhidden; RunOnceId: "DelCodexZhRemoteTask"
