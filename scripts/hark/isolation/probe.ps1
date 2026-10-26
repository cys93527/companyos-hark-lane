# H16 Windows file/network isolation - probe (Hark lane, design lane/H16_DESIGN.md).
# CI ONLY (windows-2022 runner, elevated). Never run on a user's PC: it creates a local account,
# firewall rules and ACL entries, then removes them and reads the removal back.
#
# Passes (each runs scripts/hark/isolation/probe-child.cjs and records reachability):
#   A control      runner identity, no rules            -> proves the targets are reachable at all
#   B account      dedicated account, before any rule   -> proves the account itself has network
#   C isolated     dedicated account, firewall (a)+(b) + workspace/kernel grants + userData DENY,
#                  launched CreateProcessWithLogonW(CREATE_SUSPENDED) -> Job Object (KILL_ON_JOB_CLOSE)
#   D cleanup      rules removed, ACEs revoked, account deleted - all read back
# Verdict in isolation-probe.json; exit 1 when any expectation fails (first failures are evidence).
param([Parameter(Mandatory = $true)][string]$OutDir)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$report = [ordered]@{ schema = 'companyos/h16-isolation-probe/1'; startedAt = (Get-Date).ToString('o'); host = [ordered]@{}; passes = [ordered]@{}; checks = @(); cleanup = [ordered]@{} }
$report.host.os = (Get-CimInstance Win32_OperatingSystem).Caption + ' ' + [Environment]::OSVersion.Version.ToString()
$report.host.runner = $env:USERNAME
$node = (Get-Command node).Source
$report.host.node = $node

$brokerPort = 47811
$otherPort = 47812
$tag = ([Guid]::NewGuid().ToString('N')).Substring(0, 6)
$account = "cosagent-$tag"
$ruleA = "CompanyOS H16 probe $tag (a) block non-loopback"
$ruleB = "CompanyOS H16 probe $tag (b) block loopback except broker"

# Realistic layout: per-user install + userData live in the runner's profile; workspace in Documents.
$kernelDir = Join-Path $env:LOCALAPPDATA "Programs\CompanyOS-H16-probe\kernel"
$userData = Join-Path $env:APPDATA "CompanyOS-H16-probe"
$workspace = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "CompanyOS-H16-workspace"
foreach ($d in @($kernelDir, $userData, $workspace)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Copy-Item (Join-Path $PSScriptRoot 'probe-child.cjs') (Join-Path $kernelDir 'probe-child.cjs') -Force
Set-Content -Path (Join-Path $userData 'vault.json') -Value '{"probe":"secret-not-for-agent"}'
Set-Content -Path (Join-Path $env:USERPROFILE 'h16-profile-secret.txt') -Value 'profile secret'
Set-Content -Path (Join-Path $workspace 'input.txt') -Value 'workspace input'
$otherVolume = if (Test-Path 'D:\') { 'D:\' } else { $null }

function New-ChildSpec([string]$name) {
  $spec = [ordered]@{
    out = (Join-Path $workspace "child-$name.json"); brokerPort = $brokerPort; otherPort = $otherPort; children = $true
    reads = [ordered]@{ workspaceInput = (Join-Path $workspace 'input.txt'); kernelFile = (Join-Path $kernelDir 'probe-child.cjs');
      userDataVault = (Join-Path $userData 'vault.json'); userDataDir = $userData; profileSecret = (Join-Path $env:USERPROFILE 'h16-profile-secret.txt') }
    writes = [ordered]@{ workspace = (Join-Path $workspace "w-$name.txt"); kernelDir = (Join-Path $kernelDir "w-$name.txt"); userData = (Join-Path $userData "w-$name.txt") }
  }
  if ($otherVolume) { $spec.reads.otherVolumeRoot = $otherVolume }
  $path = Join-Path $workspace "spec-$name.json"
  ($spec | ConvertTo-Json -Depth 5) | Set-Content -Path $path -Encoding utf8
  return @{ path = $path; out = $spec.out }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class H16Launch {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcessWithLogonW(string user, string domain, string password, uint logonFlags,
    string app, string cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr j, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int s);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint c);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr j, uint c);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFOW {
    public uint cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
}
"@

function Invoke-AsAccount([string]$user, [string]$password, [string]$specPath) {
  $r = [ordered]@{}
  $si = New-Object H16Launch+STARTUPINFOW
  $si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
  $pi = New-Object H16Launch+PROCESS_INFORMATION
  # cmd.exe (running as the account) captures the child's stdout/stderr into the workspace log.
  $log = [IO.Path]::ChangeExtension($specPath, '.log')
  $r.log = $log
  $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $cmd = "`"$cmdExe`" /d /s /c `"`"$node`" `"$(Join-Path $kernelDir 'probe-child.cjs')`" `"$specPath`" > `"$log`" 2>&1`""
  # CREATE_SUSPENDED 0x4 | CREATE_UNICODE_ENVIRONMENT 0x400 | CREATE_NO_WINDOW 0x08000000; logon flags 0 (no profile load)
  $ok = [H16Launch]::CreateProcessWithLogonW($user, '.', $password, 0, $cmdExe, $cmd, 0x08000404, [IntPtr]::Zero, $workspace, [ref]$si, [ref]$pi)
  if (-not $ok) { $r.launch = "CPWL failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; return $r }
  $r.launch = 'CPWL ok'
  $job = [H16Launch]::CreateJobObjectW([IntPtr]::Zero, "companyos.h16.$tag.$([Guid]::NewGuid().ToString('N').Substring(0, 6))")
  $info = New-Object H16Launch+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
  $info.BasicLimitInformation.LimitFlags = 0x2000
  $r.jobLimits = [H16Launch]::SetInformationJobObject($job, 9, [ref]$info, [Runtime.InteropServices.Marshal]::SizeOf($info))
  $r.jobAssign = [H16Launch]::AssignProcessToJobObject($job, $pi.hProcess)
  if (-not $r.jobAssign) { $r.jobAssignError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  $inJob = $false; [H16Launch]::IsProcessInJob($pi.hProcess, $job, [ref]$inJob) | Out-Null; $r.inJob = $inJob
  [H16Launch]::ResumeThread($pi.hThread) | Out-Null
  $w = [H16Launch]::WaitForSingleObject($pi.hProcess, 180000)
  $r.timedOut = ($w -eq 0x102)
  if ($r.timedOut) { [H16Launch]::TerminateJobObject($job, 124) | Out-Null; [H16Launch]::WaitForSingleObject($pi.hProcess, 10000) | Out-Null }
  $code = [uint32]0; [H16Launch]::GetExitCodeProcess($pi.hProcess, [ref]$code) | Out-Null; $r.exitCode = $code
  # KILL_ON_JOB_CLOSE: closing the last job handle must leave no survivor of the tree.
  [H16Launch]::CloseHandle($job) | Out-Null
  [H16Launch]::CloseHandle($pi.hThread) | Out-Null; [H16Launch]::CloseHandle($pi.hProcess) | Out-Null
  Start-Sleep -Milliseconds 500
  $r.survivors = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $pi.dwProcessId } | ForEach-Object { $_.Name })
  if (Test-Path $log) { $r.output = (Get-Content $log -Raw -ErrorAction SilentlyContinue); if ($r.output) { $r.output = $r.output.Substring([Math]::Max(0, $r.output.Length - 1500)) } }
  return $r
}

function Read-Child([string]$out) { if (Test-Path $out) { Get-Content $out -Raw | ConvertFrom-Json } else { $null } }

function Set-Ace([string]$path, [string]$sid, [string]$rights, [string]$type, [bool]$container) {
  $acl = Get-Acl $path
  $id = New-Object Security.Principal.SecurityIdentifier($sid)
  $inherit = if ($container) { 'ContainerInherit, ObjectInherit' } else { 'None' }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($id, $rights, $inherit, 'None', $type)
  $acl.AddAccessRule($rule); Set-Acl -Path $path -AclObject $acl
}
function Remove-Aces([string]$path, [string]$sid) {
  $acl = Get-Acl $path; $id = New-Object Security.Principal.SecurityIdentifier($sid)
  $acl.PurgeAccessRules($id); Set-Acl -Path $path -AclObject $acl
  $left = @((Get-Acl $path).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid }).Count
  return $left
}

# Loopback "broker" (allowed port) and "other service" (must be blocked) - runner identity.
$srvFile = Join-Path $OutDir 'loopback-server.cjs'
Set-Content -Path $srvFile -Encoding ascii -Value 'const h=require("http");const p=+process.argv[2];h.createServer((q,r)=>{r.end("ok "+p)}).listen({port:p,host:"::",ipv6Only:false});'
$s1 = Start-Process -FilePath $node -ArgumentList @("`"$srvFile`"", $brokerPort) -PassThru -WindowStyle Hidden
$s2 = Start-Process -FilePath $node -ArgumentList @("`"$srvFile`"", $otherPort) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2

$exit = 0
try {
  # Pass A - control, runner identity.
  $a = New-ChildSpec 'A'
  & $node (Join-Path $kernelDir 'probe-child.cjs') $a.path | Out-Null
  $report.passes.A_control = Read-Child $a.out

  # Account (install-level; password random, never logged).
  $rb = New-Object byte[] 24; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($rb)
  $password = [Convert]::ToBase64String($rb) + 'aA1!'
  $sec = ConvertTo-SecureString $password -AsPlainText -Force
  New-LocalUser -Name $account -Password $sec -Description 'CompanyOS H16 probe agent account' -AccountNeverExpires -PasswordNeverExpires | Out-Null
  $sid = (New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value
  $report.host.accountSid = $sid

  # Grants: workspace Modify, kernel install ReadAndExecute, userData explicit Deny.
  Set-Ace $workspace $sid 'Modify' 'Allow' $true
  Set-Ace $kernelDir $sid 'ReadAndExecute' 'Allow' $true
  Set-Ace $userData $sid 'FullControl' 'Deny' $true

  # Pass B - account, before firewall rules.
  $b = New-ChildSpec 'B'
  $report.passes.B_account_launch = Invoke-AsAccount $account $password $b.path
  $report.passes.B_account = Read-Child $b.out

  # Firewall rules scoped to the account SID.
  $sddl = "D:(A;;CC;;;$sid)"
  # (a) every non-loopback IPv4 destination; (a6) ALL of IPv6 incl. ::1 (the broker listens on 127.0.0.1 only).
  # Windows Firewall refuses ::1 as a single RemoteAddress (run 2, 40333707301), so IPv6 is covered by ranges;
  # each accepted form is recorded.
  New-NetFirewallRule -DisplayName $ruleA -Direction Outbound -Action Block -LocalUser $sddl `
    -RemoteAddress @('0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255') | Out-Null
  $report.host.ipv6RuleForm = $null
  foreach ($form in @(@('::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), @('::', '::1-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), @('::/0'))) {
    try {
      New-NetFirewallRule -DisplayName "$ruleA v6" -Direction Outbound -Action Block -LocalUser $sddl -RemoteAddress $form -ErrorAction Stop | Out-Null
      $report.host.ipv6RuleForm = ($form -join ','); break
    } catch { $report.host.ipv6RuleErrors += @("$($form -join ','): $($_.Exception.Message)") }
  }
  if (-not $report.host.ipv6RuleForm) { throw 'no IPv6 block rule form accepted' }
  # (b) IPv4 loopback except the fixed broker port (TCP), and all IPv4 loopback UDP.
  New-NetFirewallRule -DisplayName $ruleB -Direction Outbound -Action Block -LocalUser $sddl -Protocol TCP `
    -RemoteAddress @('127.0.0.0/8') -RemotePort @("1-$($brokerPort - 1)", "$($brokerPort + 1)-65535") | Out-Null
  New-NetFirewallRule -DisplayName "$ruleB udp" -Direction Outbound -Action Block -LocalUser $sddl -Protocol UDP `
    -RemoteAddress @('127.0.0.0/8') | Out-Null
  Start-Sleep -Seconds 2

  # Pass C - isolated.
  $c = New-ChildSpec 'C'
  $report.passes.C_isolated_launch = Invoke-AsAccount $account $password $c.path
  $report.passes.C_isolated = Read-Child $c.out

  # Expectations.
  $A = $report.passes.A_control; $B = $report.passes.B_account; $C = $report.passes.C_isolated; $L = $report.passes.C_isolated_launch
  function Check([string]$id, [bool]$ok, $observed) { $script:report.checks += [ordered]@{ id = $id; ok = $ok; observed = $observed }; if (-not $ok) { $script:exit = 1 } }
  $notReached = { param($o) $null -ne $o -and $o.outcome -ne 'REACHED' }
  Check 'A.control.https_deepseek.reached' ($A -and $A.net.https_deepseek.outcome -eq 'REACHED') $A.net.https_deepseek
  Check 'A.control.otherLoopback.reached' ($A -and $A.net.otherLoopback.outcome -eq 'REACHED') $A.net.otherLoopback
  Check 'B.account.launched' ($B -ne $null) $report.passes.B_account_launch
  Check 'B.account.https_deepseek.reached' ($B -and $B.net.https_deepseek.outcome -eq 'REACHED') $B.net.https_deepseek
  Check 'C.launched.cpwl' ($C -ne $null -and $C.identity -eq $account) @{ identity = $C.identity; launch = $L.launch }
  Check 'C.job.assigned' ($L.jobAssign -eq $true -and $L.inJob -eq $true) @{ assign = $L.jobAssign; inJob = $L.inJob; err = $L.jobAssignError }
  Check 'C.job.noSurvivors' ($L.survivors.Count -eq 0) $L.survivors
  Check 'C.net.brokerLoopback.reached' ($C -and $C.net.brokerLoopback.outcome -eq 'REACHED') $C.net.brokerLoopback
  Check 'C.net.brokerLoopbackV6.blocked' ($C -and (& $notReached $C.net.brokerLoopbackV6)) $C.net.brokerLoopbackV6
  Check 'C.net.otherLoopback.blocked' ($C -and (& $notReached $C.net.otherLoopback)) $C.net.otherLoopback
  Check 'C.net.tcp_1_1_1_1_443.blocked' ($C -and (& $notReached $C.net.tcp_1_1_1_1_443)) $C.net.tcp_1_1_1_1_443
  Check 'C.net.https_deepseek.blocked' ($C -and (& $notReached $C.net.https_deepseek)) $C.net.https_deepseek
  Check 'C.net.https_github.blocked' ($C -and (& $notReached $C.net.https_github)) $C.net.https_github
  Check 'C.child.pwshWeb.blocked' ($C -and $C.children.pwshWeb.stdout -notmatch '^\s*\d*\s*REACHED') $C.children.pwshWeb
  Check 'C.child.nodeHttp.blocked' ($C -and $C.children.nodeHttp.stdout -notmatch 'REACHED') $C.children.nodeHttp
  Check 'C.child.git.blocked' ($C -and $C.children.git.status -ne 0) $C.children.git
  Check 'C.file.workspace.read' ($C -and $C.files.'read:workspaceInput'.outcome -eq 'READ') $C.files.'read:workspaceInput'
  Check 'C.file.workspace.write' ($C -and $C.files.'write:workspace'.outcome -eq 'WRITTEN') $C.files.'write:workspace'
  Check 'C.file.kernel.read' ($C -and $C.files.'read:kernelFile'.outcome -eq 'READ') $C.files.'read:kernelFile'
  Check 'C.file.kernel.writeDenied' ($C -and $C.files.'write:kernelDir'.outcome -eq 'DENIED') $C.files.'write:kernelDir'
  Check 'C.file.userData.vaultDenied' ($C -and $C.files.'read:userDataVault'.outcome -eq 'DENIED') $C.files.'read:userDataVault'
  Check 'C.file.userData.listDenied' ($C -and $C.files.'read:userDataDir'.outcome -eq 'DENIED') $C.files.'read:userDataDir'
  Check 'C.file.userData.writeDenied' ($C -and $C.files.'write:userData'.outcome -eq 'DENIED') $C.files.'write:userData'
  Check 'C.file.profileSecret.denied' ($C -and $C.files.'read:profileSecret'.outcome -eq 'DENIED') $C.files.'read:profileSecret'
  # Recorded residuals (documented, not claimed closed): DNS via DNS Client service; other volume roots.
  $report.residuals = [ordered]@{ dns = $C.net.dns; otherVolumeRoot = $C.files.'read:otherVolumeRoot' }
}
catch {
  $report.fatal = ($_ | Out-String)
  $exit = 1
}
finally {
  # Pass D - cleanup with read-back.
  foreach ($r in @($ruleA, "$ruleA v6", $ruleB, "$ruleB udp")) { Remove-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue }
  $report.cleanup.rulesLeft = @(Get-NetFirewallRule -DisplayName "CompanyOS H16 probe $tag*" -ErrorAction SilentlyContinue).Count
  if ($report.host.accountSid) {
    $s = $report.host.accountSid
    $report.cleanup.acesLeft = (Remove-Aces $workspace $s) + (Remove-Aces $kernelDir $s) + (Remove-Aces $userData $s)
  }
  Remove-LocalUser -Name $account -ErrorAction SilentlyContinue
  $report.cleanup.accountLeft = [bool](Get-LocalUser -Name $account -ErrorAction SilentlyContinue)
  if ($report.cleanup.rulesLeft -ne 0 -or $report.cleanup.acesLeft -ne 0 -or $report.cleanup.accountLeft) { $exit = 1 }
  foreach ($p in @($s1, $s2)) { if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
  Get-ChildItem $workspace -Filter 'child-*.json' -ErrorAction SilentlyContinue | Copy-Item -Destination $OutDir
  $report.finishedAt = (Get-Date).ToString('o')
  $report.verdict = if ($exit -eq 0) { 'ISOLATION_PROBE_PASS' } else { 'ISOLATION_PROBE_FAIL' }
  ($report | ConvertTo-Json -Depth 8) | Set-Content -Path (Join-Path $OutDir 'isolation-probe.json') -Encoding utf8
  Write-Output "verdict $($report.verdict)"
  $report.checks | Where-Object { -not $_.ok } | ForEach-Object { Write-Output "FAILED $($_.id): $($_.observed | ConvertTo-Json -Compress -Depth 4)" }
}
exit $exit
