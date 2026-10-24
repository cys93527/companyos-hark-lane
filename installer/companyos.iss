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

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\CompanyOS"; Filename: "{app}\CompanyOS.exe"
Name: "{autodesktop}\CompanyOS"; Filename: "{app}\CompanyOS.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\CompanyOS.exe"; Description: "{cm:LaunchProgram,CompanyOS}"; Flags: nowait postinstall skipifsilent
