; Hark lane H8 — CompanyOS per-user Windows installer (Inno Setup 6).
; Per-user (no admin, no UAC), x64 only, unsigned. No services, no ACL/firewall changes.
; Build: ISCC /DStageDir=<staged app> /DAppVersion=<ver> /DOutDir=<dir> installer\companyos.iss
#ifndef StageDir
  #error StageDir is required
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef OutDir
  #define OutDir "out"
#endif
; H15: longest file path inside StageDir, relative to {app} (the workflow measures it).
; Windows MAX_PATH is 260 (incl. NUL); an install dir longer than 259 - MaxRelPath - 1
; would make Setup abort mid-copy (hark-installer 40257828899), so it is refused up front.
#ifndef MaxRelPath
  #error MaxRelPath is required (longest path below StageDir, measured by the workflow)
#endif
; H12c: Simplified Chinese wizard, always. The workflow passes /DZhCnMessages=<path> when the
; runner's Inno Setup ships Languages\ChineseSimplified.isl; otherwise the in-repo
; installer\ChineseSimplified.isl is layered over Default.isl (untranslated messages fall
; back to English). Nothing is downloaded.

[Setup]
AppId={{6B0E7C4A-3D1F-4E8B-9A62-C0A5E1F7D2B9}
AppName=CompanyOS
AppVersion={#AppVersion}
AppPublisher=CompanyOS (Hark lane build)
DefaultDirName={localappdata}\Programs\CompanyOS
DefaultGroupName=CompanyOS
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=CompanyOS-Hark-Setup-{#AppVersion}-x64
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\CompanyOS.exe
UninstallDisplayName=CompanyOS
CloseApplications=yes
ShowLanguageDialog=no
LanguageDetectionMethod=none

[Languages]
#ifdef ZhCnMessages
Name: "chs"; MessagesFile: "{#ZhCnMessages}"
#else
Name: "chs"; MessagesFile: "compiler:Default.isl,ChineseSimplified.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[InstallDelete]
; H13: every install (upgrade, downgrade, reinstall) replaces the app payload WHOLE. Inno
; never removes files a previous version shipped, so without this a downgrade would keep the
; newer build's files (e.g. a newer migration) and mix two versions. userData is untouched.
Type: filesandordirs; Name: "{app}\resources"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\CompanyOS"; Filename: "{app}\CompanyOS.exe"
Name: "{autodesktop}\CompanyOS"; Filename: "{app}\CompanyOS.exe"; Tasks: desktopicon
; H17a: ordinary-user provider setup (DeepSeek key via DPAPI + per-Goal budget), runs as the user, no elevation.
Name: "{autoprograms}\CompanyOS 首次配置"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\resources\setup\configure-deepseek.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\CompanyOS.exe"

; H16b-3b: optional Windows isolation of the agent (dedicated account, workspace-only writes, broker-only network);
; asks for administrator rights once per change (UAC). -Status/-Remove are offered by the same helper.
Name: "{autoprograms}\CompanyOS 隔离设置"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\resources\setup\configure-isolation.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\CompanyOS.exe"
Name: "{autoprograms}\CompanyOS 隔离状态"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\resources\setup\configure-isolation.ps1"" -Status"; WorkingDir: "{app}"; IconFilename: "{app}\CompanyOS.exe"
Name: "{autoprograms}\CompanyOS 移除隔离"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\resources\setup\configure-isolation.ps1"" -Remove"; WorkingDir: "{app}"; IconFilename: "{app}\CompanyOS.exe"

[UninstallRun]
; H16b-3b: uninstalling CompanyOS also removes a configured isolation (account, WFP filters, ACEs) - no leftovers.
; Without isolation configured this does nothing and asks for nothing.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\resources\setup\configure-isolation.ps1"" -Remove -IfConfigured -NoPause"; Flags: runhidden waituntilterminated; RunOnceId: "CompanyOSRemoveIsolation"

[Run]
Filename: "{app}\CompanyOS.exe"; Description: "{cm:LaunchProgram,CompanyOS}"; Flags: nowait postinstall skipifsilent

[CustomMessages]
chs.InstallDirTooLong=安装路径太长（%1 个字符）。CompanyOS 自带的文件最深 {#MaxRelPath} 个字符，Windows 路径上限为 260，请选择不超过 %2 个字符的安装位置（例如默认位置）。

[Code]
function NextButtonClick(CurPageID: Integer): Boolean;
var
  Dir: String;
  Limit: Integer;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Dir := RemoveBackslashUnlessRoot(WizardDirValue);
    Limit := 259 - {#MaxRelPath} - 1;
    if Length(Dir) > Limit then
    begin
      SuppressibleMsgBox(FmtMessage(CustomMessage('InstallDirTooLong'), [IntToStr(Length(Dir)), IntToStr(Limit)]), mbError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;
