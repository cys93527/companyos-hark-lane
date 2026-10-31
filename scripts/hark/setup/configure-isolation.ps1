# Hark lane H16b-3b - "CompanyOS 隔离设置": ordinary-user Windows isolation setup for the INSTALLED app.
# Start menu shortcut (runs as the signed-in user; asks Windows for administrator rights ONCE per change via UAC):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<install>\resources\setup\configure-isolation.ps1"
# What it does (design lane/H16_DESIGN.md; helper resources\isolation\setup.ps1, proved by hark-isolation lifecycle):
#   1. reads the workspace the user selected in CompanyOS (%APPDATA%\CompanyOS\workspace-selection.json);
#   2. generates a random password for the dedicated local agent account and protects it with DPAPI (CurrentUser)
#      into %APPDATA%\CompanyOS\isolation\agent-credential.dpapi (the app's launcher decrypts it as this user);
#   3. starts the ELEVATED helper once (setup.ps1 -Action install): account, workspace + kernel-state Modify, kernel
#      ReadAndExecute, CompanyOS data Deny, persistent WFP filters (only the app's broker port on 127.0.0.1 reachable);
#      the password travels in a one-time handoff file the helper deletes; it is never on a command line or logged;
#   4. reads the status back as this (unelevated) user - exactly what the app checks before every goal.
# -Remove           elevated uninstall (filters, ACEs, account, profile) + deletes the credential.
# -IfConfigured     with -Remove: do nothing (no UAC prompt) when isolation was never configured (used by the uninstaller).
# -Status           prints the current state (no elevation).
# The renderer never starts this helper (V1 boundary: no renderer path to accounts or credentials).
# Exit codes: 0 done, 2 not possible yet (no workspace selected / not Windows resources), 3 helper failed,
#             4 administrator rights refused, 5 app resources missing.
param(
  [switch]$Remove,
  [switch]$IfConfigured,
  [switch]$Status,
  [switch]$NoPause,
  [string]$UserData = (Join-Path $env:APPDATA 'CompanyOS'),
  [string]$AppDir = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$Workspace
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

# The app's broker binds exactly this loopback port when isolation is ISOLATED (dsh-executor-provider listenPort).
$BrokerPort = 47811
$isoRes = Join-Path $AppDir 'resources\isolation'
$helper = Join-Path $isoRes 'setup.ps1'
# Kernel ReadAndExecute is granted on the install dir itself, not on resources\agent-kernel: every install/upgrade
# deletes and recreates {app}\resources (companyos.iss [InstallDelete]), which would drop a grant placed there and
# turn the next status check into ISOLATION_DEGRADED; the recreated tree inherits the grant from {app}.
$kernelRoot = $AppDir
$isoDir = Join-Path $UserData 'isolation'
$statePath = Join-Path $isoDir 'state.json'
$credPath = Join-Path $isoDir 'agent-credential.dpapi'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# Every outcome (with the helper's raw output on failure) is appended to %APPDATA%\CompanyOS\isolation-setup.log:
# the uninstaller runs -Remove hidden, so without this a failed removal would leave no trace for the user or support.
$setupLog = Join-Path $UserData 'isolation-setup.log'
$mode = if ($Remove) { 'remove' + $(if ($IfConfigured) { ' -IfConfigured' } else { '' }) } elseif ($Status) { 'status' } else { 'install' }
function Finish([int]$code, [string]$message) {
  Write-Host $message
  try {
    New-Item -ItemType Directory -Force -Path $UserData | Out-Null
    [IO.File]::AppendAllText($setupLog, ((Get-Date).ToString('o') + " [$mode] exit=$code " + $message + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
  } catch { }
  if (-not $NoPause) { [void](Read-Host '按回车键关闭') }
  exit $code
}
function Quote-Ps([string]$v) { "'" + $v.Replace("'", "''") + "'" }
function Last-Json([string]$text) {
  $line = @($text -split "`r?`n" | Where-Object { $_.TrimStart([char]0xFEFF, ' ').StartsWith('{') }) | Select-Object -Last 1
  if ($line) { try { return ($line.TrimStart([char]0xFEFF, ' ') | ConvertFrom-Json) } catch { } }
  return $null
}
function Get-IsolationStatus {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $o = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Action status -StatePath $statePath 2>&1 | Out-String } finally { $ErrorActionPreference = $prev }
  return (Last-Json $o)
}
# One elevated helper run; its single JSON line comes back through a result file (an elevated child's stdout cannot
# be piped to this unelevated process).
function Invoke-Elevated($named) {
  New-Item -ItemType Directory -Force -Path $isoDir | Out-Null
  $result = Join-Path $isoDir ("helper-result-" + [Guid]::NewGuid().ToString('N') + '.txt')
  $parts = @('&', (Quote-Ps $helper))
  foreach ($k in $named.Keys) { $parts += "-$k"; $parts += (Quote-Ps ([string]$named[$k])) }
  $cmd = ($parts -join ' ') + ' *> ' + (Quote-Ps $result) + '; exit $LASTEXITCODE'
  try {
    $p = Start-Process -FilePath $ps -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ('"' + $cmd.Replace('"', '\"') + '"'))
  } catch {
    return [pscustomobject]@{ refused = $true; exit = $null; json = $null; raw = $_.Exception.Message }
  }
  $raw = if (Test-Path -LiteralPath $result) { Get-Content -LiteralPath $result -Raw } else { '' }
  Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
  return [pscustomobject]@{ refused = $false; exit = $p.ExitCode; json = (Last-Json $raw); raw = $raw }
}

if (-not (Test-Path -LiteralPath $helper) -or -not (Test-Path -LiteralPath (Join-Path $isoRes 'companyos-isolated-launch.exe'))) {
  Finish 5 "找不到 CompanyOS 隔离组件：$isoRes"
}

if ($Status) {
  $s = Get-IsolationStatus
  if ($null -eq $s) { Finish 3 '无法读取隔离状态。' }
  switch ($s.state) {
    'ISOLATED' { Finish 0 "已隔离：智能体以专用账户 $($s.account) 运行，只能写入已授权的工作区，只能访问 CompanyOS 的本机模型代理。" }
    'NOT_CONFIGURED' { Finish 0 '未隔离：智能体以你的 Windows 账户运行（尚未启用隔离）。' }
    default { Finish 2 ("隔离已配置但不完整（CompanyOS 会拒绝派发目标）：" + (@($s.problems) -join '; ') + "`n请重新运行 CompanyOS 隔离设置，或选择移除隔离。") }
  }
}

if ($Remove) {
  if ($IfConfigured -and -not (Test-Path -LiteralPath $statePath)) {
    Remove-Item -LiteralPath $credPath -Force -ErrorAction SilentlyContinue
    Finish 0 '未配置隔离，无需移除。'
  }
  $r = Invoke-Elevated ([ordered]@{ Action = 'uninstall'; StatePath = $statePath })
  if ($r.refused) { Finish 4 '已取消：移除隔离需要管理员权限。' }
  if ($r.exit -ne 0 -or $null -eq $r.json -or $r.json.ok -ne $true) { Finish 3 "移除隔离失败：$($r.raw)" }
  Remove-Item -LiteralPath $credPath -Force -ErrorAction SilentlyContinue
  Finish 0 '已移除隔离：专用账户、防火墙过滤器和文件权限均已删除。之后智能体会以你的账户运行，并标注「未隔离」。'
}

Write-Host 'CompanyOS 隔离设置'
Write-Host '启用后，智能体在专用的本机账户下运行：只能写入你选定的工作区，读不到 CompanyOS 数据和你的个人文件，'
Write-Host '网络只能连到 CompanyOS 的本机模型代理（由它代你访问模型服务商）。需要一次管理员授权。'
if (-not $Workspace) {
  $sel = Join-Path $UserData 'workspace-selection.json'
  if (Test-Path -LiteralPath $sel) { try { $Workspace = (Get-Content -LiteralPath $sel -Raw | ConvertFrom-Json).root } catch { } }
}
if (-not $Workspace -or -not (Test-Path -LiteralPath $Workspace -PathType Container)) {
  Finish 2 '请先打开 CompanyOS 选择工作区，然后再运行隔离设置。'
}
$Workspace = [IO.Path]::GetFullPath($Workspace)
$stateDir = Join-Path $UserData 'agent-kernel-state'
New-Item -ItemType Directory -Force -Path $isoDir, $stateDir | Out-Null

Add-Type -AssemblyName System.Security
$rb = New-Object byte[] 24
(New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($rb)
$password = [Convert]::ToBase64String($rb) + 'aA1!'
$newCred = "$credPath.new"
[IO.File]::WriteAllBytes($newCred, [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($password), $null, 'CurrentUser'))
$handoff = Join-Path $isoDir ("handoff-" + [Guid]::NewGuid().ToString('N') + '.txt')
[IO.File]::WriteAllText($handoff, $password, [Text.Encoding]::ASCII)
$password = $null
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$r = Invoke-Elevated ([ordered]@{ Action = 'install'; StatePath = $statePath; PasswordFile = $handoff; BrokerPort = "$BrokerPort"
    WorkspaceDirs = $Workspace; StateDirs = $stateDir; KernelDirs = $kernelRoot; DenyDirs = $UserData; ReaderSid = $me })
Remove-Item -LiteralPath $handoff -Force -ErrorAction SilentlyContinue
if ($r.refused) { Remove-Item -LiteralPath $newCred -Force -ErrorAction SilentlyContinue; Finish 4 '已取消：启用隔离需要管理员权限。' }
if ($r.exit -ne 0 -or $null -eq $r.json -or $r.json.ok -ne $true) {
  Remove-Item -LiteralPath $newCred -Force -ErrorAction SilentlyContinue
  Finish 3 "启用隔离失败：$($r.raw)"
}
Move-Item -LiteralPath $newCred -Destination $credPath -Force
$s = Get-IsolationStatus
if ($null -eq $s -or $s.state -ne 'ISOLATED') { Finish 3 ("隔离已安装但本用户读回的状态不是「已隔离」：" + ($s | ConvertTo-Json -Compress)) }
Finish 0 "已启用隔离（专用账户 $($s.account)，工作区 $Workspace）。下一次派发目标即生效；更换工作区后请重新运行本设置。"
