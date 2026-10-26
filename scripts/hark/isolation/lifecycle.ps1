# H16b lifecycle test of the PRODUCTION isolation helper (setup.ps1). CI ONLY (windows-2022, elevated).
# Never run on a user's PC. Steps (each judged; first failures are evidence):
#   L1 install (separate elevated process)            -> exit 0, read-back ISOLATED
#   L2 status from a NEW process                      -> ISOLATED (WFP objects are persistent, not session-bound)
#   L3 agent-account child (CPWL + Job Object)        -> broker port reached; other loopback v4/v6, internet,
#                                                        child pwsh/node/git BLOCKED; workspace + state-in-userData
#                                                        writable; vault/userData listing/kernel write DENIED
#   L4 status as a STANDARD (non-admin) user          -> recorded: can the app's unelevated start check read WFP?
#   L5 tamper WFP (v6 filter deleted)                 -> ISOLATION_DEGRADED naming wfp:filterV6:missing
#   L6 tamper ACL (workspace grant removed)           -> ISOLATION_DEGRADED naming acl:missing
#   L7 repair = install again                         -> ISOLATED, exactly one filter per key
#   L8 uninstall                                      -> ok, NOT_CONFIGURED, no filters/ACEs/account left
param([Parameter(Mandatory = $true)][string]$OutDir)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$report = [ordered]@{ schema = 'companyos/h16-isolation-lifecycle/1'; startedAt = (Get-Date).ToString('o'); steps = [ordered]@{}; checks = @() }
$node = (Get-Command node).Source
$setup = Join-Path $PSScriptRoot 'setup.ps1'
$brokerPort = 47821
$otherPort = 47822
$tag = ([Guid]::NewGuid().ToString('N')).Substring(0, 6)
$account = "CompanyOSAgent-$tag"

# Production-like layout: per-user install, userData with the kernel state root INSIDE it, workspace in Documents.
$kernelDir = Join-Path $env:LOCALAPPDATA "Programs\CompanyOS-H16L\resources\agent-kernel"
$userData = Join-Path $env:APPDATA "CompanyOS-H16L"
$stateDir = Join-Path $userData "agent-kernel-state"
$workspace = Join-Path ([Environment]::GetFolderPath('MyDocuments')) "CompanyOS-H16L-workspace"
$statePath = Join-Path $userData "isolation\isolation-state.json"
foreach ($d in @($kernelDir, $userData, $stateDir, $workspace)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
Copy-Item (Join-Path $PSScriptRoot 'probe-child.cjs') (Join-Path $kernelDir 'probe-child.cjs') -Force
Set-Content -Path (Join-Path $userData 'vault.json') -Value '{"probe":"secret-not-for-agent"}'
Set-Content -Path (Join-Path $workspace 'input.txt') -Value 'workspace input'
Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'cpwl-launch.cs') -Raw)
Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'wfp-persistent.cs') -Raw)

function Check([string]$id, [bool]$ok, $observed) { $script:report.checks += [ordered]@{ id = $id; ok = $ok; observed = $observed } }
function New-Password { $rb = New-Object byte[] 24; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($rb); [Convert]::ToBase64String($rb) + 'aA1!' }
# Run 1 (40339654328): `& powershell -File setup.ps1 @array` died with "Cannot validate argument on parameter"
# and the wrapper's Stop preference turned the child's stderr into a terminating error. The helper is now invoked
# through -Command with every value single-quoted (full PowerShell binding, as the app's launcher will do), and
# native stderr is only recorded.
function Quote-Ps([string]$v) { "'" + $v.Replace("'", "''") + "'" }
function Invoke-Setup($named) {
  $parts = @('&', (Quote-Ps $setup))
  foreach ($k in $named.Keys) { $parts += "-$k"; $parts += (Quote-Ps ([string]$named[$k])) }
  $cmdLine = ($parts -join ' ') + '; exit $LASTEXITCODE'
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -Command $cmdLine 2>&1; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prevEap }
  $lines = @($out | ForEach-Object { "$_" })
  $last = @($lines | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
  $json = $null; if ($last) { try { $json = $last | ConvertFrom-Json } catch {} }
  return [ordered]@{ code = $code; json = $json; raw = ($lines -join "`n") }
}
function Install-Isolation([string]$password) {
  $pw = Join-Path $userData "isolation\handoff-$([Guid]::NewGuid().ToString('N')).txt"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pw) | Out-Null
  Set-Content -LiteralPath $pw -Value $password -NoNewline -Encoding ascii
  $r = Invoke-Setup ([ordered]@{ Action = 'install'; StatePath = $statePath; PasswordFile = $pw; BrokerPort = "$brokerPort";
    AccountName = $account; WorkspaceDirs = $workspace; StateDirs = $stateDir; KernelDirs = $kernelDir; DenyDirs = $userData })
  $r.handoffDeleted = -not (Test-Path -LiteralPath $pw)
  return $r
}
function Get-WfpFilterCount([string]$needle) {
  $f = Join-Path $OutDir "wfp-$([Guid]::NewGuid().ToString('N')).xml"
  & netsh wfp show filters file="$f" | Out-Null
  $n = @(Select-String -Path $f -SimpleMatch $needle).Count
  Remove-Item $f -ErrorAction SilentlyContinue
  return $n
}

$srvFile = Join-Path $OutDir 'loopback-server.cjs'
Set-Content -Path $srvFile -Encoding ascii -Value 'const h=require("http");const p=+process.argv[2];h.createServer((q,r)=>{r.end("ok "+p)}).listen({port:p,host:process.argv[3],ipv6Only:false});'
$s1 = Start-Process -FilePath $node -ArgumentList @("`"$srvFile`"", $brokerPort, '127.0.0.1') -PassThru -WindowStyle Hidden
$s2 = Start-Process -FilePath $node -ArgumentList @("`"$srvFile`"", $otherPort, '::') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$stdUser = "cosstd-$tag"
$exit = 0
try {
  # L1
  $password = New-Password
  $l1 = Install-Isolation $password
  $report.steps.L1_install = $l1
  Check 'L1.install.exit0' ($l1.code -eq 0) $l1.code
  Check 'L1.install.readBackIsolated' ($l1.json -and $l1.json.readBack.state -eq 'ISOLATED') $l1.json.readBack
  Check 'L1.install.handoffDeleted' $l1.handoffDeleted $l1.handoffDeleted
  $sid = if ($l1.json) { $l1.json.sid } else { $null }

  # L2
  $l2 = Invoke-Setup ([ordered]@{ Action = 'status'; StatePath = $statePath })
  $report.steps.L2_status = $l2
  Check 'L2.status.isolatedFromNewProcess' ($l2.code -eq 0 -and $l2.json.state -eq 'ISOLATED') $l2.json

  # L3
  $spec = [ordered]@{
    out = (Join-Path $workspace 'child-L3.json'); brokerPort = $brokerPort; otherPort = $otherPort; children = $true
    reads = [ordered]@{ workspaceInput = (Join-Path $workspace 'input.txt'); kernelFile = (Join-Path $kernelDir 'probe-child.cjs');
      userDataVault = (Join-Path $userData 'vault.json'); userDataDir = $userData }
    writes = [ordered]@{ workspace = (Join-Path $workspace 'w-L3.txt'); stateDir = (Join-Path $stateDir 'w-L3.txt');
      kernelDir = (Join-Path $kernelDir 'w-L3.txt'); userData = (Join-Path $userData 'w-L3.txt') }
  }
  $specPath = Join-Path $workspace 'spec-L3.json'
  ($spec | ConvertTo-Json -Depth 5) | Set-Content -Path $specPath -Encoding utf8
  $log = Join-Path $workspace 'child-L3.log'
  $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
  $cmd = "`"$cmdExe`" /d /s /c `"`"$node`" `"$(Join-Path $kernelDir 'probe-child.cjs')`" `"$specPath`" > `"$log`" 2>&1`""
  $launch = [CompanyOSCpwl]::RunInJob($account, $password, $cmdExe, $cmd, $workspace, 180000)
  $report.steps.L3_launch = $launch
  $C = if (Test-Path $spec.out) { Get-Content $spec.out -Raw | ConvertFrom-Json } else { $null }
  $report.steps.L3_child = $C
  if (Test-Path $log) { $report.steps.L3_log = (Get-Content $log -Raw) }
  $notReached = { param($o) $null -ne $o -and $o.outcome -ne 'REACHED' }
  Check 'L3.launch.inJob' ($launch -match 'inJob=True') $launch
  Check 'L3.identity' ($C -and $C.identity -eq $account) $C.identity
  Check 'L3.net.broker.reached' ($C -and $C.net.brokerLoopback.outcome -eq 'REACHED') $C.net.brokerLoopback
  Check 'L3.net.otherLoopback.blocked' ($C -and (& $notReached $C.net.otherLoopback)) $C.net.otherLoopback
  Check 'L3.net.otherLoopbackV6.blocked' ($C -and (& $notReached $C.net.otherLoopbackV6)) $C.net.otherLoopbackV6
  Check 'L3.net.tcp_1_1_1_1.blocked' ($C -and (& $notReached $C.net.tcp_1_1_1_1_443)) $C.net.tcp_1_1_1_1_443
  Check 'L3.net.deepseek.blocked' ($C -and (& $notReached $C.net.https_deepseek)) $C.net.https_deepseek
  Check 'L3.child.pwshWeb.blocked' ($C -and $C.children.pwshWeb.stdout -notmatch '^\s*\d*\s*REACHED') $C.children.pwshWeb
  Check 'L3.child.nodeHttp.blocked' ($C -and $C.children.nodeHttp.stdout -notmatch 'REACHED') $C.children.nodeHttp
  Check 'L3.child.git.blocked' ($C -and $C.children.git.status -ne 0) $C.children.git
  Check 'L3.file.workspace.read' ($C -and $C.files.'read:workspaceInput'.outcome -eq 'READ') $C.files.'read:workspaceInput'
  Check 'L3.file.workspace.write' ($C -and $C.files.'write:workspace'.outcome -eq 'WRITTEN') $C.files.'write:workspace'
  Check 'L3.file.stateInUserData.write' ($C -and $C.files.'write:stateDir'.outcome -eq 'WRITTEN') $C.files.'write:stateDir'
  Check 'L3.file.kernel.read' ($C -and $C.files.'read:kernelFile'.outcome -eq 'READ') $C.files.'read:kernelFile'
  Check 'L3.file.kernel.writeDenied' ($C -and $C.files.'write:kernelDir'.outcome -eq 'DENIED') $C.files.'write:kernelDir'
  Check 'L3.file.vault.denied' ($C -and $C.files.'read:userDataVault'.outcome -eq 'DENIED') $C.files.'read:userDataVault'
  Check 'L3.file.userDataList.denied' ($C -and $C.files.'read:userDataDir'.outcome -eq 'DENIED') $C.files.'read:userDataDir'
  Check 'L3.file.userDataWrite.denied' ($C -and $C.files.'write:userData'.outcome -eq 'DENIED') $C.files.'write:userData'
  $report.residuals = [ordered]@{ dns = $C.net.dns }

  # L4 - observation only (decides whether the start check needs a readable WFP SD or an elevated broker).
  $pub = Join-Path $env:ProgramData "cos-h16l-$tag"
  New-Item -ItemType Directory -Force -Path $pub | Out-Null
  Copy-Item $statePath (Join-Path $pub 'state.json')
  Copy-Item $setup (Join-Path $pub 'setup.ps1'); Copy-Item (Join-Path $PSScriptRoot 'wfp-persistent.cs') (Join-Path $pub 'wfp-persistent.cs')
  $acl = Get-Acl $pub; $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('Users', 'Modify', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))); Set-Acl $pub $acl
  $stdPw = New-Password
  New-LocalUser -Name $stdUser -Password (ConvertTo-SecureString $stdPw -AsPlainText -Force) -AccountNeverExpires -PasswordNeverExpires | Out-Null
  Add-LocalGroupMember -Group 'Users' -Member $stdUser
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $stdOut = Join-Path $pub 'status-std.txt'
  $stdCmd = "`"$cmdExe`" /d /s /c `"`"$ps`" -NoProfile -ExecutionPolicy Bypass -Command `"& '$pub\setup.ps1' -Action status -StatePath '$pub\state.json'; exit `$LASTEXITCODE`" > `"$stdOut`" 2>&1`""
  $report.steps.L4_launch = [CompanyOSCpwl]::RunInJob($stdUser, $stdPw, $cmdExe, $stdCmd, $pub, 120000)
  $report.steps.L4_standardUserStatus = if (Test-Path $stdOut) { Get-Content $stdOut -Raw } else { $null }

  # L5
  [CompanyOSWfp]::Open() | Out-Null
  $report.steps.L5_tamper = ('0x{0:x}' -f [CompanyOSWfp]::DeleteV6ForTamperTest())
  [CompanyOSWfp]::Close()
  $l5 = Invoke-Setup ([ordered]@{ Action = 'status'; StatePath = $statePath })
  $report.steps.L5_status = $l5.json
  Check 'L5.wfpTamper.degraded' ($l5.code -eq 2 -and $l5.json.state -eq 'ISOLATION_DEGRADED' -and (@($l5.json.problems) -match 'wfp:filterV6:missing').Count -gt 0) $l5.json

  # L6
  $acl = Get-Acl -LiteralPath $workspace
  $acl.Access | Where-Object { -not $_.IsInherited -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid } | ForEach-Object { $acl.RemoveAccessRuleSpecific($_) }
  Set-Acl -LiteralPath $workspace -AclObject $acl
  $l6 = Invoke-Setup ([ordered]@{ Action = 'status'; StatePath = $statePath })
  $report.steps.L6_status = $l6.json
  Check 'L6.aclTamper.degraded' ($l6.code -eq 2 -and (@($l6.json.problems) -match '^acl:missing:Allow:Modify').Count -gt 0) $l6.json

  # L7
  $password = New-Password
  $l7 = Install-Isolation $password
  $report.steps.L7_repair = $l7
  Check 'L7.repair.isolated' ($l7.code -eq 0 -and $l7.json.readBack.state -eq 'ISOLATED' -and $l7.json.sid -eq $sid) $l7.json.readBack
  $report.steps.L7_filterCounts = [ordered]@{ v4 = (Get-WfpFilterCount 'CompanyOS agent v4'); v6 = (Get-WfpFilterCount 'CompanyOS agent v6') }
  Check 'L7.repair.noDuplicates' ($report.steps.L7_filterCounts.v4 -eq 1 -and $report.steps.L7_filterCounts.v6 -eq 1) $report.steps.L7_filterCounts

  # L8
  $l8 = Invoke-Setup ([ordered]@{ Action = 'uninstall'; StatePath = $statePath })
  $report.steps.L8_uninstall = $l8
  Check 'L8.uninstall.ok' ($l8.code -eq 0 -and $l8.json.ok -eq $true) $l8.json
  $l8s = Invoke-Setup ([ordered]@{ Action = 'status'; StatePath = $statePath })
  Check 'L8.status.notConfigured' ($l8s.json.state -eq 'NOT_CONFIGURED') $l8s.json
  $left = Get-WfpFilterCount 'CompanyOS agent'
  Check 'L8.wfp.noneLeft' ($left -eq 0) $left
  Check 'L8.account.gone' (-not (Get-LocalUser -Name $account -ErrorAction SilentlyContinue)) $account
}
catch {
  $report.fatal = ($_ | Out-String)
  $exit = 1
}
finally {
  if (Test-Path -LiteralPath $statePath) { $report.finalCleanup = (Invoke-Setup ([ordered]@{ Action = 'uninstall'; StatePath = $statePath })).json }
  Remove-LocalUser -Name $stdUser -ErrorAction SilentlyContinue
  foreach ($p in @($s1, $s2)) { if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
  if (@($report.checks | Where-Object { -not $_.ok }).Count -gt 0 -or $report.checks.Count -lt 25) { $exit = 1 }
  $report.finishedAt = (Get-Date).ToString('o')
  $report.verdict = if ($exit -eq 0) { 'ISOLATION_LIFECYCLE_PASS' } else { 'ISOLATION_LIFECYCLE_FAIL' }
  ($report | ConvertTo-Json -Depth 8) | Set-Content -Path (Join-Path $OutDir 'isolation-lifecycle.json') -Encoding utf8
  Write-Output "verdict $($report.verdict) checks $(@($report.checks | Where-Object { $_.ok }).Count)/$($report.checks.Count)"
  $report.checks | Where-Object { -not $_.ok } | ForEach-Object { Write-Output "FAILED $($_.id): $($_.observed | ConvertTo-Json -Compress -Depth 4)" }
  Write-Output "L4 standard-user status: $($report.steps.L4_standardUserStatus)"
}
exit $exit
