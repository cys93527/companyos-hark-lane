; Hark lane H8 — CompanyOS per-user Windows installer (Inno Setup 6).
; Per-user (no admin, no UAC), x64 only, unsigned. No services, no ACL/firewall changes.
; Build: ISCC /DStageDir=<staged app> /DAppVersion=<ver> /DOutDir=<dir> installer\companyos.iss
#ifndef StageDir
  #error StageDir is required
#endif
#ifndef AppVersion
  #define AppVersion "0.1.1"
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

; AUDIT-S7: uninstalling CompanyOS also removes a configured isolation (account, WFP filters, ACEs). This used to be
; an [UninstallRun] entry whose exit code Inno ignores: a failed or refused (UAC) removal still deleted the app and
; with it the only removal tool, leaving an orphaned hidden account. The removal now runs in InitializeUninstall
; (before anything is deleted); a failure offers Abort / Retry / Ignore and a silent uninstall aborts.
; Without isolation configured the helper does nothing and asks for nothing.

[Run]
Filename: "{app}\CompanyOS.exe"; Description: "{cm:LaunchProgram,CompanyOS}"; Flags: nowait postinstall skipifsilent

[CustomMessages]
chs.IsolationRemoveFailed=移除 CompanyOS 隔离失败（退出码 %1）。若现在继续卸载，隔离账户和防火墙规则会留在这台电脑上，且移除工具会被一并删除。%n%n「中止」保留 CompanyOS（之后可用开始菜单「CompanyOS 移除隔离」重试），「重试」再试一次，「忽略」仍然卸载。
chs.InstallDirTooLong=安装路径太长（%1 个字符）。CompanyOS 自带的文件最深 {#MaxRelPath} 个字符，Windows 路径上限为 260，请选择不超过 %2 个字符的安装位置（例如默认位置）。

[Code]
{ AUDIT-S11: one MAX_PATH rule for the wizard page AND silent installs (/DIR= skips the page). }
function InstallDirTooLongMessage(Dir: String): String;
var
  Limit: Integer;
begin
  Result := '';
  Dir := RemoveBackslashUnlessRoot(Dir);
  Limit := 259 - {#MaxRelPath} - 1;
  if Length(Dir) > Limit then
    Result := FmtMessage(CustomMessage('InstallDirTooLong'), [IntToStr(Length(Dir)), IntToStr(Limit)]);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Msg: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    Msg := InstallDirTooLongMessage(WizardDirValue);
    if Msg <> '' then
    begin
      SuppressibleMsgBox(Msg, mbError, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;

{ Runs for silent installs too: a non-empty result aborts before any file is written (setup exit code 7). }
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := InstallDirTooLongMessage(ExpandConstant('{app}'));
end;

{ AUDIT-S7: remove a configured isolation BEFORE the uninstaller deletes anything; never ignore a failure silently. }
function InitializeUninstall(): Boolean;
var
  Ps, Params: String;
  Code, Choice: Integer;
  Done: Boolean;
begin
  Result := True;
  Ps := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\resources\setup\configure-isolation.ps1') + '" -Remove -IfConfigured -NoPause';
  Done := False;
  repeat
    if not Exec(Ps, Params, '', SW_HIDE, ewWaitUntilTerminated, Code) then
      Code := -1;
    Log('isolation removal exit code ' + IntToStr(Code));
    if Code = 0 then
      Done := True
    else
    begin
      Choice := SuppressibleMsgBox(FmtMessage(CustomMessage('IsolationRemoveFailed'), [IntToStr(Code)]), mbError, MB_ABORTRETRYIGNORE, IDABORT);
      if Choice = IDIGNORE then
        Done := True
      else if Choice <> IDRETRY then
      begin
        Result := False;
        Done := True;
      end;
    end;
  until Done;
end;
