; ============================================================================
;  Light — Inno Setup script
;  Builds a Windows installer from the staged app folder (release\Light).
;
;  Prerequisites:
;    1) npm run dist          (= npm run build && npm run stage)
;                             → produces ..\release\Light\
;    2) Open this file in Inno Setup 6 and click "Compile" (or:
;       iscc installer\light.iss)
;
;  Output:  ..\release\Light-Setup-1.0.0.exe   (per-user, no admin needed)
; ============================================================================

#define MyAppName "Light"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Light"
#define MyAppExeName "Light.exe"

[Setup]
; A unique, stable identity for this app (do NOT reuse for other apps).
AppId={{B7E6B9A2-2D4C-4E1F-9C3A-7A1F2E5D8C40}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName={#MyAppName}

; Per-user install → no UAC prompt, lands in %LocalAppData%\Programs\Light.
; (The app stores its data in %AppData%\light, never in the install folder,
;  so Program Files is unnecessary.)
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes

; Branding & chrome.
SetupIconFile=light.ico
UninstallDisplayIcon={app}\light.ico
UninstallDisplayName={#MyAppName}
WizardStyle=modern
MinVersion=10.0

; Output.
OutputDir=..\release
OutputBaseFilename=Light-Setup-{#MyAppVersion}
Compression=lzma2/ultra
SolidCompression=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
; 想要中文安装界面？取消下一行注释（需要 Inno Setup 的简体中文语言包
; ChineseSimplified.isl，放在 Inno 安装目录的 Languages 文件夹里）：
; Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："
Name: "autostart"; Description: "开机时自动启动 Light（推荐）"; GroupDescription: "附加任务："

[Files]
; The entire staged app tree → install folder.
Source: "..\release\Light\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\light.ico"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\light.ico"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "立即启动 Light"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Make sure a running instance is closed before removing files.
Filename: "{cmd}"; Parameters: "/C taskkill /IM {#MyAppExeName} /F"; Flags: runhidden; RunOnceId: "KillLight"

[Code]
// Close any running Light.exe before overwriting files (smooth upgrades).
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /IM {#MyAppExeName} /F', '',
       SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
