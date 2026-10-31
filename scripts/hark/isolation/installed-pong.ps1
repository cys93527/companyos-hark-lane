# H16b-3b installed-layout isolation smoke (CI ONLY, windows-2022, elevated runner; never on a user's PC).
# Uses the STAGED app's resources (resources/isolation helper + launcher, resources/agent-kernel) in the production
# per-user layout and the production seam (decideIsolation -> planIsolatedLaunch -> companyos-isolated-launch.exe):
#   P1 elevated setup.ps1 install (account, workspace FullControl + state Modify, app dir RX as configure-isolation.ps1 grants it,
#      userData deny, persistent WFP)
#   P2 the app's DPAPI(CurrentUser) credential blob at <userData>/isolation/agent-credential.dpapi
#   P3 packaged kernel PONG turn AS the agent account (kernel-health-smoke --pong --isolation-*): pwsh tool + fs write
#      + model endpoint on the allow-listed broker port; pong.txt owned by the agent account
#   N1 credential blob removed           -> plan refused ISOLATION_DEGRADED credential:missing (no unisolated spawn)
#   N2 workspace grant removed (tamper)  -> decision refuse ISOLATION_DEGRADED acl:missing
#   N3 uninstall                         -> NOT_CONFIGURED -> launch-unisolated (label checked in decide-smoke); account gone
param([Parameter(Mandatory = $true)][string]$OutDir, [Parameter(Mandatory = $true)][string]$StagedApp)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$node = (Get-Command node).Source
$res = Join-Path $StagedApp 'resources'
$isoRes = Join-Path $res 'isolation'
$kernelRoot = Join-Path $res 'agent-kernel'
$kernelDir = @(Get-ChildItem -LiteralPath $kernelRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'manifest.json') })[0].FullName
$tag = ([Guid]::NewGuid().ToString('N')).Substring(0, 6)
$account = "CompanyOSAgent$tag"
$brokerPort = 47831
$userData = Join-Path $env:APPDATA "CompanyOS-H16P"
$stateDir = Join-Path $userData 'agent-kernel-state'
$workspace = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CompanyOS-H16P-workspace'
$statePath = Join-Path $userData 'isolation\state.json'
$credPath = Join-Path $userData 'isolation\agent-credential.dpapi'
foreach ($d in @($userData, $stateDir, $workspace, (Split-Path -Parent $statePath))) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$report = [ordered]@{ schema = 'companyos/h16b3b-installed-pong/1'; startedAt = (Get-Date).ToString('o'); kernelDir = $kernelDir; account = $account; checks = @(); steps = [ordered]@{} }
function Check([string]$id, [bool]$ok, $observed) {
  $o = try { [string]($observed | ConvertTo-Json -Compress -Depth 6) } catch { 'unserializable' }
  if ($o.Length -gt 4000) { $o = $o.Substring(0, 4000) + '...' }
  $script:report.checks += [ordered]@{ id = $id; ok = $ok; observed = $o }
  Add-Content -LiteralPath (Join-Path $OutDir 'installed-pong-progress.ndjson') -Value ([ordered]@{ id = $id; ok = $ok; observed = $o } | ConvertTo-Json -Compress) -Encoding utf8
}
function Quote-Ps([string]$v) { "'" + $v.Replace("'", "''") + "'" }
function Invoke-Setup($named) {
  $parts = @('&', (Quote-Ps (Join-Path $isoRes 'setup.ps1')))
  foreach ($k in $named.Keys) { $parts += "-$k"; $parts += (Quote-Ps ([string]$named[$k])) }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & powershell -NoProfile -ExecutionPolicy Bypass -Command (($parts -join ' ') + '; exit $LASTEXITCODE') 2>&1; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  $lines = @($out | ForEach-Object { "$_" })
  $last = @($lines | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
  $json = $null; if ($last) { try { $json = $last | ConvertFrom-Json } catch {} }
  return [ordered]@{ code = $code; json = $json; raw = ($lines -join "`n") }
}
function Decide {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $o = & $node (Join-Path $PSScriptRoot 'decide-smoke.mjs') $isoRes $userData $workspace 2>&1 | Out-String } finally { $ErrorActionPreference = $prev }
  $line = @($o -split "`r?`n" | Where-Object { $_.TrimStart().StartsWith('{') }) | Select-Object -Last 1
  if ($line) { try { return ($line | ConvertFrom-Json) } catch {} }
  return [pscustomobject]@{ raw = $o }
}
$exit = 0
try {
  # P1
  $rb = New-Object byte[] 24; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($rb); $password = [Convert]::ToBase64String($rb) + 'aA1!'
  $handoff = Join-Path $userData "isolation\handoff-$([Guid]::NewGuid().ToString('N')).txt"
  Set-Content -LiteralPath $handoff -Value $password -NoNewline -Encoding ascii
  $p1 = Invoke-Setup ([ordered]@{ Action = 'install'; StatePath = $statePath; PasswordFile = $handoff; BrokerPort = "$brokerPort"; AccountName = $account
      WorkspaceDirs = $workspace; StateDirs = $stateDir; KernelDirs = $StagedApp; DenyDirs = $userData })
  $report.steps.P1 = [ordered]@{ code = $p1.code; readBack = $p1.json.readBack; raw = $p1.raw.Substring(0, [Math]::Min(3000, $p1.raw.Length)) }
  Check 'P1.install.isolated' ($p1.code -eq 0 -and $p1.json.readBack.state -eq 'ISOLATED') $p1.json
  Check 'P1.install.handoffDeleted' (-not (Test-Path -LiteralPath $handoff)) $handoff
  if ($p1.code -ne 0) { throw "install failed: $($p1.raw)" }
  # P2
  Add-Type -AssemblyName System.Security
  [IO.File]::WriteAllBytes($credPath, [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($password), $null, 'CurrentUser'))
  $password = $null
  $d0 = Decide
  Check 'P2.decision.launchIsolated' ($d0.decision.kind -eq 'launch-isolated' -and $d0.decision.account -eq $account -and $d0.decision.brokerPort -eq $brokerPort -and $d0.plan.kind -eq 'isolated') $d0
  # P3
  $pongJson = Join-Path $OutDir 'isolated-pong.json'
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $node (Join-Path $repo 'scripts\hark\kernel-health-smoke.mjs') $kernelDir $stateDir $pongJson --pong --isolation-resources $isoRes --isolation-userdata $userData --workspace $workspace *> (Join-Path $OutDir 'isolated-pong.log')
  $pongCode = $LASTEXITCODE; $ErrorActionPreference = $prev
  $P = if (Test-Path -LiteralPath $pongJson) { [IO.File]::ReadAllText($pongJson) | ConvertFrom-Json } else { $null }
  Check 'P3.kernel.healthy' ($pongCode -eq 0 -and $P -and $P.status -eq 'HEALTHY') ([ordered]@{ exit = $pongCode; status = $P.status; reasonCode = $P.reasonCode })
  Check 'P3.pong.ok' ($P -and $P.pong.ok -eq $true) ([ordered]@{ exitCode = $P.pong.exitCode; calls = $P.pong.modelCalls; file = $P.pong.fileWritten; final = $P.pong.finalLine; stderr = $P.pong.stderrTail })
  Check 'P3.pong.planIsolated' ($P -and $P.pong.isolation.plan.kind -eq 'isolated' -and $P.pong.isolation.plan.account -eq $account) $P.pong.isolation
  Check 'P3.pong.pwshTool' ($P -and $P.pong.pwsh.ok -eq $true) $P.pong.pwsh.resultLine
  $pongFile = if ($P -and $P.pong.workspace) { Join-Path $P.pong.workspace 'pong.txt' } else { $null }
  $owner = if ($pongFile -and (Test-Path -LiteralPath $pongFile)) { (Get-Acl -LiteralPath $pongFile).Owner } else { $null }
  Check 'P3.pong.fileOwnedByAgent' ($owner -and $owner -like "*\$account") $owner
  # N1
  $credBackup = "$credPath.bak"; Move-Item -LiteralPath $credPath -Destination $credBackup -Force
  $n1 = Decide
  Check 'N1.credentialMissing.refused' ($n1.plan.kind -eq 'refused' -and $n1.plan.reasonCode -eq 'ISOLATION_DEGRADED' -and (@($n1.plan.problems) -contains 'credential:missing')) $n1
  Move-Item -LiteralPath $credBackup -Destination $credPath -Force
  # N2
  $sid = $p1.json.sid
  $acl = Get-Acl -LiteralPath $workspace
  $acl.Access | Where-Object { -not $_.IsInherited -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid } | ForEach-Object { [void]$acl.RemoveAccessRuleSpecific($_) }
  Set-Acl -LiteralPath $workspace -AclObject $acl
  $n2 = Decide
  Check 'N2.aclTamper.refused' ($n2.decision.kind -eq 'refuse' -and $n2.plan.kind -eq 'refused' -and (@($n2.decision.problems) -match '^acl:missing').Count -gt 0) $n2
  # N3
  $n3u = Invoke-Setup ([ordered]@{ Action = 'uninstall'; StatePath = $statePath })
  Check 'N3.uninstall.ok' ($n3u.code -eq 0 -and $n3u.json.ok -eq $true) $n3u.json
  Remove-Item -LiteralPath $credPath -Force -ErrorAction SilentlyContinue
  $n3 = Decide
  Check 'N3.notConfigured.unisolated' ($n3.decision.kind -eq 'launch-unisolated' -and $n3.plan.kind -eq 'unisolated' -and $n3.unisolatedLabelZh -eq $true) $n3
  Check 'N3.account.gone' (-not (Get-LocalUser -Name $account -ErrorAction SilentlyContinue)) $account
}
catch { $report.fatal = ($_ | Out-String); $exit = 1 }
finally {
  if (Test-Path -LiteralPath $statePath) { $report.finalCleanup = (Invoke-Setup ([ordered]@{ Action = 'uninstall'; StatePath = $statePath })).json }
  if (@($report.checks | Where-Object { -not $_.ok }).Count -gt 0 -or $report.checks.Count -lt 13) { $exit = 1 }
  $report.finishedAt = (Get-Date).ToString('o')
  $report.verdict = if ($exit -eq 0) { 'INSTALLED_ISOLATION_PONG_PASS' } else { 'INSTALLED_ISOLATION_PONG_FAIL' }
  ($report | ConvertTo-Json -Depth 6) | Set-Content -Path (Join-Path $OutDir 'installed-pong.json') -Encoding utf8
  Write-Output "verdict $($report.verdict) checks $(@($report.checks | Where-Object { $_.ok }).Count)/$($report.checks.Count)"
  $report.checks | Where-Object { -not $_.ok } | ForEach-Object { Write-Output "FAILED $($_.id): $($_.observed)" }
  if ($report.fatal) { Write-Output "FATAL $($report.fatal)" }
}
exit $exit
