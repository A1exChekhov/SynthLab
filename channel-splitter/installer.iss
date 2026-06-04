; Inno Setup script — Channel Splitter (Errarium)
; Build:  ISCC installer.iss   ->  installer_out\ChannelSplitter-Setup.exe

#define MyAppName "Channel Splitter"
#define MyAppVersion "2.0"
#define MyAppPublisher "Errarium"
#define MyAppExeName "ChannelSplitter.exe"

[Setup]
AppId={{8F3A1B2C-5D4E-4F6A-9B0C-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppCopyright=Copyright (C) 2026 Errarium
DefaultDirName={autopf}\Errarium\Channel Splitter
DefaultGroupName=Channel Splitter
DisableProgramGroupPage=yes
OutputDir=installer_out
OutputBaseFilename=ChannelSplitter-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
LicenseFile=LICENSE.txt
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName={#MyAppName}
; Автоматически закрывать работающую копию при обновлении.
; AppMutex совпадает с APP_MUTEX_NAME в splitter_gui.py — по нему
; установщик надёжно обнаруживает запущенное приложение.
AppMutex=ChannelSplitterErrariumMutex
CloseApplications=force
RestartApplications=no

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\ChannelSplitter.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
