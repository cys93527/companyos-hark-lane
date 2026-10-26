# H16b CompanyOS agent isolation helper (production; design lane/H16_DESIGN.md, probe hark-isolation 40334964921).
#
#   -Action install    ELEVATED. Creates/reuses the dedicated local account, sets its password from a one-time
#                      handoff file (the non-elevated app generated it and keeps it DPAPI-protected itself; this
#                      helper deletes the handoff file after reading and never logs the password), grants
#                      workspace/state Modify + kernel ReadAndExecute + userData Deny, this-folder-only
#                      ReadAttributes on every ancestor of a granted dir (probe F1), and installs PERSISTENT WFP
#                      filters (probe F3) under fixed keys. Writes the state file, then reads everything back.
#   -Action status     Verifies account, SID, every recorded ACE and the WFP object set against the state file.
#                      Prints one JSON line {state: ISOLATED | ISOLATION_DEGRADED | NOT_CONFIGURED, problems[]}.
#   -Action uninstall  ELEVATED. Removes filters, ACEs (incl. ancestors), the account and the state file; reads back.
#
# Exit codes: 0 = action succeeded (status: ISOLATED), 2 = status not ISOLATED, 1 = failure.
# This script never runs on a user's PC by itself: the app starts it only after the user chose isolation setup.
param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'status', 'uninstall')][string]$Action,
  [Parameter(Mandatory = $true)][string]$StatePath,
  [string]$PasswordFile,
  [int]$BrokerPort = 0,
  [string[]]$WorkspaceDirs = @(),
  [string[]]$StateDirs = @(),
  [string[]]$KernelDirs = @(),
  [string[]]$DenyDirs = @(),
  [string]$AccountName,
  # The user whose UNELEVATED app checks status (default: the identity running setup = the installing user under UAC
  # same-user elevation; the app passes its own SID explicitly for over-the-shoulder elevation).
  [string]$ReaderSid
)

$ErrorActionPreference = 'Stop'
# powershell -File passes each value as ONE string: several dirs travel '|'-separated ('|' is illegal in paths).
function Split-Dirs([string[]]$v) { @($v | ForEach-Object { $_ -split '\|' } | Where-Object { $_ -and $_.Trim() } | ForEach-Object { [IO.Path]::GetFullPath($_.Trim()) }) }
$WorkspaceDirs = Split-Dirs $WorkspaceDirs; $StateDirs = Split-Dirs $StateDirs; $KernelDirs = Split-Dirs $KernelDirs; $DenyDirs = Split-Dirs $DenyDirs
$SCHEMA = 'companyos/isolation-state/1'
$HIDE_KEY = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList'

function Out-Result($obj, [int]$code) { ($obj | ConvertTo-Json -Compress -Depth 6) | Write-Output; exit $code }
function Load-Wfp { if (-not ('CompanyOSWfp' -as [type])) { Add-Type -TypeDefinition (Get-Content (Join-Path $PSScriptRoot 'wfp-persistent.cs') -Raw) } }
function Test-Elevated { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Sid-Of($identity) { try { $identity.Translate([Security.Principal.SecurityIdentifier]).Value } catch { $identity.Value } }

function Grant([string]$path, [string]$sid, [string]$rights, [string]$type, [bool]$inherit, $grants) {
  $acl = Get-Acl -LiteralPath $path
  $id = New-Object Security.Principal.SecurityIdentifier($sid)
  $flags = if ($inherit) { 'ContainerInherit, ObjectInherit' } else { 'None' }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($id, $rights, $flags, 'None', $type)
  $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl
  $grants.Add([ordered]@{ path = $path; rights = $rights; type = $type; inherit = $inherit }) | Out-Null
}

function Test-Grant($g, [string]$sid) {
  if (-not (Test-Path -LiteralPath $g.path)) { return "acl:pathMissing:$($g.path)" }
  $want = [Security.AccessControl.FileSystemRights]$g.rights
  $hit = @((Get-Acl -LiteralPath $g.path).Access | Where-Object {
      -not $_.IsInherited -and (Sid-Of $_.IdentityReference) -eq $sid -and $_.AccessControlType.ToString() -eq $g.type -and
      (($_.FileSystemRights -band $want) -eq $want) })
  if ($hit.Count -eq 0) { return "acl:missing:$($g.type):$($g.rights):$($g.path)" }
  return $null
}

function Get-Status {
  if (-not (Test-Path -LiteralPath $StatePath)) { return [ordered]@{ state = 'NOT_CONFIGURED'; problems = @() } }
  $problems = New-Object System.Collections.ArrayList
  $st = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  if ($st.schema -ne $SCHEMA) { return [ordered]@{ state = 'ISOLATION_DEGRADED'; problems = @("state:schema:$($st.schema)") } }
  $user = Get-LocalUser -Name $st.account -ErrorAction SilentlyContinue
  if (-not $user) { $problems.Add("account:missing:$($st.account)") | Out-Null }
  else {
    if ($user.SID.Value -ne $st.sid) { $problems.Add('account:sidChanged') | Out-Null }
    if (-not $user.Enabled) { $problems.Add('account:disabled') | Out-Null }
  }
  foreach ($g in @($st.grants) + @($st.ancestorGrants)) { if ($g) { $p = Test-Grant $g $st.sid; if ($p) { $problems.Add($p) | Out-Null } } }
  try {
    Load-Wfp
    $rc = [CompanyOSWfp]::Open()
    if ($rc -ne 0) { $problems.Add(('wfp:open:0x{0:x}' -f $rc)) | Out-Null }
    else { foreach ($p in [CompanyOSWfp]::Status($st.sid, [uint16]$st.brokerPort)) { $problems.Add("wfp:$p") | Out-Null } }
  } catch { $problems.Add("wfp:error:$($_.Exception.Message)") | Out-Null }
  finally { try { [CompanyOSWfp]::Close() } catch {} }
  $state = if ($problems.Count -eq 0) { 'ISOLATED' } else { 'ISOLATION_DEGRADED' }
  return [ordered]@{ state = $state; account = $st.account; sid = $st.sid; brokerPort = $st.brokerPort; problems = @($problems) }
}

function Remove-AllAces([string]$path, [string]$sid) {
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  $acl = Get-Acl -LiteralPath $path; $acl.PurgeAccessRules((New-Object Security.Principal.SecurityIdentifier($sid))); Set-Acl -LiteralPath $path -AclObject $acl
  return @((Get-Acl -LiteralPath $path).Access | Where-Object { -not $_.IsInherited -and (Sid-Of $_.IdentityReference) -eq $sid }).Count
}

switch ($Action) {
  'status' {
    $s = Get-Status
    Out-Result $s ($(if ($s.state -eq 'ISOLATED') { 0 } else { 2 }))
  }

  'install' {
    if (-not (Test-Elevated)) { Out-Result ([ordered]@{ ok = $false; error = 'NOT_ELEVATED' }) 1 }
    if ($BrokerPort -lt 1024 -or $BrokerPort -gt 65535) { Out-Result ([ordered]@{ ok = $false; error = 'BROKER_PORT_INVALID' }) 1 }
    if (-not $PasswordFile -or -not (Test-Path -LiteralPath $PasswordFile)) { Out-Result ([ordered]@{ ok = $false; error = 'PASSWORD_HANDOFF_MISSING' }) 1 }
    if ($WorkspaceDirs.Count -eq 0 -or $KernelDirs.Count -eq 0) { Out-Result ([ordered]@{ ok = $false; error = 'DIRS_MISSING' }) 1 }
    $password = (Get-Content -LiteralPath $PasswordFile -Raw).Trim()
    Remove-Item -LiteralPath $PasswordFile -Force
    if ($password.Length -lt 20) { Out-Result ([ordered]@{ ok = $false; error = 'PASSWORD_TOO_SHORT' }) 1 }
    $sec = ConvertTo-SecureString $password -AsPlainText -Force
    $password = $null

    $prev = $null
    if (Test-Path -LiteralPath $StatePath) { $prev = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json }
    if (-not $AccountName) { $AccountName = if ($prev) { $prev.account } else { 'CompanyOSAgent' + ([Guid]::NewGuid().ToString('N')).Substring(0, 6) } }
    # Local account names are limited to 20 characters (lifecycle run 2, 40340473413: 'CompanyOSAgent-xxxxxx' = 21).
    if ($AccountName.Length -gt 20 -or $AccountName -notmatch '^[A-Za-z0-9-]+$') { Out-Result ([ordered]@{ ok = $false; error = 'ACCOUNT_NAME_INVALID' }) 1 }
    $existing = Get-LocalUser -Name $AccountName -ErrorAction SilentlyContinue
    if ($existing) { Set-LocalUser -Name $AccountName -Password $sec -PasswordNeverExpires $true; Enable-LocalUser -Name $AccountName }
    else { New-LocalUser -Name $AccountName -Password $sec -Description 'CompanyOS agent (isolated runtime)' -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword | Out-Null }
    $sid = (Get-LocalUser -Name $AccountName).SID.Value
    # Not offered on the sign-in screen (the account is a service identity for the agent runtime only).
    if (-not (Test-Path $HIDE_KEY)) { New-Item -Path $HIDE_KEY -Force | Out-Null }
    New-ItemProperty -Path $HIDE_KEY -Name $AccountName -PropertyType DWord -Value 0 -Force | Out-Null

    # Re-install replaces earlier grants of this account (no stale paths left behind).
    if ($prev -and $prev.sid -eq $sid) { foreach ($g in @($prev.grants) + @($prev.ancestorGrants)) { if ($g) { Remove-AllAces $g.path $sid | Out-Null } } }
    $grants = New-Object System.Collections.ArrayList
    $ancestorGrants = New-Object System.Collections.ArrayList
    foreach ($d in $WorkspaceDirs + $StateDirs) { New-Item -ItemType Directory -Force -Path $d | Out-Null; Grant $d $sid 'Modify' 'Allow' $true $grants }
    foreach ($d in $KernelDirs) { Grant $d $sid 'ReadAndExecute' 'Allow' $true $grants }
    # Explicit Allow on a child (e.g. a kernel state root inside userData) is evaluated before the inherited Deny.
    foreach ($d in $DenyDirs) { New-Item -ItemType Directory -Force -Path $d | Out-Null; Grant $d $sid 'FullControl' 'Deny' $true $grants }
    $seen = @{}
    foreach ($d in $WorkspaceDirs + $StateDirs + $KernelDirs) {
      $parent = Split-Path -Parent $d
      while ($parent -and (Split-Path -Parent $parent)) {
        if (-not $seen.ContainsKey($parent)) { $seen[$parent] = $true; Grant $parent $sid 'ReadAttributes, Synchronize' 'Allow' $false $ancestorGrants }
        $parent = Split-Path -Parent $parent
      }
    }

    Load-Wfp
    $rc = [CompanyOSWfp]::Open()
    $reader = if ($ReaderSid) { $ReaderSid } else { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    if ($reader -notmatch '^S-1-5-21-[0-9-]+$') { Out-Result ([ordered]@{ ok = $false; error = 'READER_SID_INVALID' }) 1 }
    if ($rc -eq 0) { $rc = [CompanyOSWfp]::Install($sid, [uint16]$BrokerPort, $reader) }
    $wfpLog = @([CompanyOSWfp]::Log)
    [CompanyOSWfp]::Close()
    if ($rc -ne 0) { Out-Result ([ordered]@{ ok = $false; error = ('WFP_INSTALL_FAILED 0x{0:x}' -f $rc); wfpLog = $wfpLog }) 1 }

    $state = [ordered]@{
      schema = $SCHEMA; account = $AccountName; sid = $sid; brokerPort = $BrokerPort; installedAt = (Get-Date).ToString('o')
      grants = @($grants); ancestorGrants = @($ancestorGrants)
      wfp = [ordered]@{ provider = [CompanyOSWfp]::PROVIDER_KEY.ToString(); sublayer = [CompanyOSWfp]::SUBLAYER_KEY.ToString(); v4 = [CompanyOSWfp]::FILTER_V4_KEY.ToString(); v6 = [CompanyOSWfp]::FILTER_V6_KEY.ToString() }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StatePath) | Out-Null
    ($state | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $StatePath -Encoding utf8
    $readBack = Get-Status
    Out-Result ([ordered]@{ ok = ($readBack.state -eq 'ISOLATED'); account = $AccountName; sid = $sid; readBack = $readBack; wfpLog = $wfpLog }) ($(if ($readBack.state -eq 'ISOLATED') { 0 } else { 1 }))
  }

  'uninstall' {
    if (-not (Test-Elevated)) { Out-Result ([ordered]@{ ok = $false; error = 'NOT_ELEVATED' }) 1 }
    $r = [ordered]@{ ok = $true }
    Load-Wfp
    $rc = [CompanyOSWfp]::Open()
    if ($rc -eq 0) { $rc = [CompanyOSWfp]::Uninstall() }
    $r.wfp = ('0x{0:x}' -f $rc)
    $left = [CompanyOSWfp]::Status('S-1-0-0', [uint16]1)
    [CompanyOSWfp]::Close()
    $r.wfpObjectsLeft = @($left | Where-Object { $_ -notmatch ':missing' }).Count
    if (Test-Path -LiteralPath $StatePath) {
      $st = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
      $acesLeft = 0
      foreach ($g in @($st.grants) + @($st.ancestorGrants)) { if ($g) { $acesLeft += (Remove-AllAces $g.path $st.sid) } }
      $r.acesLeft = $acesLeft
      Remove-LocalUser -Name $st.account -ErrorAction SilentlyContinue
      Remove-ItemProperty -Path $HIDE_KEY -Name $st.account -ErrorAction SilentlyContinue
      $r.accountLeft = [bool](Get-LocalUser -Name $st.account -ErrorAction SilentlyContinue)
      Remove-Item -LiteralPath $StatePath -Force
    } else { $r.acesLeft = 0; $r.accountLeft = $false }
    if ($rc -ne 0 -or $r.wfpObjectsLeft -ne 0 -or $r.acesLeft -ne 0 -or $r.accountLeft) { $r.ok = $false }
    Out-Result $r ($(if ($r.ok) { 0 } else { 1 }))
  }
}
