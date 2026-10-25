# Hark lane H13: upgrade / downgrade / uninstall data retention on the INSTALLED app.
#   base = the push-built installer (vN), next = the probe-newer installer (vN+1, one extra
#   probe migration). Real GUI launches against the real per-user userData (%APPDATA%\CompanyOS).
# Sequence (one install dir, one userData):
#   1 install base -> launch -> DB created            -> snapshot S1
#   2 install next over it (upgrade)  -> launch -> DB ready, probe migration applied,
#     every S1 migration + owner role row kept          -> snapshot S2
#   3 install base over it (downgrade) -> launch -> typed refusal SCHEMA_FROM_NEWER_VERSION
#     logged, shell still alive, data logically unchanged -> snapshot S3 == S2
#   4 uninstall -> install dir removed, userData DB kept
#   5 install next again (recovery) -> snapshot before launch == S2 -> launch -> DB ready
# Exit 0 only if every check passes. No network, no Provider, no secrets, nothing machine-wide.
param([Parameter(Mandatory)] [string]$Base, [Parameter(Mandatory)] [string]$Next, [Parameter(Mandatory)] [string]$Evidence)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Evidence | Out-Null
$dir = Join-Path $env:LOCALAPPDATA 'Programs\CompanyOS-H13'
$userData = Join-Path $env:APPDATA 'CompanyOS'
$db = Join-Path $userData 'data\companyos.sqlite'
$probe = Join-Path $PWD 'scripts\hark\h13-data-probe.mjs'
$result = [ordered]@{ base = $Base; next = $Next; installDir = $dir; userData = $userData; checks = [ordered]@{} }
function Check($name, $ok, $detail) { $result.checks[$name] = [ordered]@{ ok = [bool]$ok; detail = "$detail" }; Write-Host "$(if ($ok) {'PASS'} else {'FAIL'}) $name $detail" }

function Install($setup, $tag) {
  $p = Start-Process -FilePath $setup -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER',"/DIR=`"$dir`"","/LOG=`"$Evidence\$tag-setup.log`"" -PassThru -Wait
  Check "$tag-install-exit-0" ($p.ExitCode -eq 0) $p.ExitCode
  $key = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'CompanyOS' } | Select-Object -First 1
  return (Get-ItemProperty $key.PSPath).DisplayVersion
}
function AppVersion() { (Get-Content (Join-Path $dir 'resources\app\package.json') -Raw | ConvertFrom-Json).version }
function Snapshot($tag) {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $p = Start-Process -FilePath (Join-Path $dir 'CompanyOS.exe') -ArgumentList @("`"$probe`"", "`"$db`"", "`"$Evidence\$tag-snapshot.json`"") -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$Evidence\$tag-snapshot.out.txt" -RedirectStandardError "$Evidence\$tag-snapshot.err.txt"
  Remove-Item Env:ELECTRON_RUN_AS_NODE
  Check "$tag-snapshot-ok" ($p.ExitCode -eq 0) $p.ExitCode
  if (Test-Path "$Evidence\$tag-snapshot.json") { return (Get-Content "$Evidence\$tag-snapshot.json" -Raw | ConvertFrom-Json) }
  return $null
}
function Launch($tag, $seconds = 25) {
  $logDir = Join-Path $userData 'logs'
  # The app APPENDS to its log files across launches, so a phase reads only the lines this
  # launch added (per-file line count taken before start), never an earlier phase's lines.
  $before = @{}
  Get-ChildItem $logDir -File -ErrorAction SilentlyContinue | ForEach-Object { $before[$_.FullName] = @(Get-Content $_.FullName).Count }
  $app = Start-Process -FilePath (Join-Path $dir 'CompanyOS.exe') -PassThru
  Start-Sleep -Seconds $seconds
  Check "$tag-app-alive" (-not $app.HasExited) ("hasExited=" + $app.HasExited)
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save("$Evidence\$tag-screenshot.png", [System.Drawing.Imaging.ImageFormat]::Png)
  } catch { }
  if (-not $app.HasExited) { & taskkill.exe /PID $app.Id /T /F | Out-File -Append "$Evidence\taskkill.log" }
  Start-Sleep -Seconds 3
  $lines = @(Get-ChildItem $logDir -File -ErrorAction SilentlyContinue | ForEach-Object {
    $all = @(Get-Content $_.FullName)
    $skip = if ($before.ContainsKey($_.FullName)) { $before[$_.FullName] } else { 0 }
    if ($all.Count -gt $skip) { $all[$skip..($all.Count - 1)] }
  })
  $lines | Out-File -Encoding utf8 "$Evidence\$tag-app-log.txt"
  return ,$lines
}

# 1 base install + first launch
$v1 = Install $Base 'p1-base'
$lines = Launch 'p1-base'
Check 'p1-database-ready' (@($lines | Where-Object { $_ -match 'database ready' }).Count -gt 0) ''
Check 'p1-no-bootstrap-failure' (@($lines | Where-Object { $_ -match 'database bootstrap failed' }).Count -eq 0) ''
$s1 = Snapshot 'p1'
Check 'p1-owner-role-row' ($null -ne $s1 -and @($s1.roleAssignments).Count -gt 0) (@($s1.roleAssignments) -join ',')
Check 'p1-no-probe-table' ($null -ne $s1 -and -not $s1.probeTable) ''

# 2 upgrade
$v2 = Install $Next 'p2-upgrade'
$result.versions = [ordered]@{ base = $v1; next = $v2; baseApp = $null; nextApp = (AppVersion) }
Check 'p2-version-increased' ([version]$v2 -gt [version]$v1) "$v1 -> $v2"
$lines = Launch 'p2-upgrade'
Check 'p2-database-ready' (@($lines | Where-Object { $_ -match 'database ready' }).Count -gt 0) ''
Check 'p2-no-bootstrap-failure' (@($lines | Where-Object { $_ -match 'database bootstrap failed' }).Count -eq 0) ''
$s2 = Snapshot 'p2'
$kept = @($s1.migrations | Where-Object { $s2.migrations -notcontains $_ })
Check 'p2-all-prior-migrations-kept' ($kept.Count -eq 0) ($kept -join ',')
Check 'p2-probe-migration-applied' ($s2.migrations -contains '0010_h13_upgrade_probe' -and $s2.probeTable) ''
Check 'p2-owner-role-row-kept' ((@($s2.roleAssignments) -join ',') -eq (@($s1.roleAssignments) -join ',')) ''

# 3 downgrade
$v3 = Install $Base 'p3-downgrade'
$result.versions.baseApp = (AppVersion)
Check 'p3-older-version-installed' ($v3 -eq $v1) "$v3"
Check 'p3-no-stale-newer-payload' (-not (Test-Path (Join-Path $dir 'resources\app\node_modules\@companyos\persistence\migrations\engine\0010_h13_upgrade_probe.sql'))) 'InstallDelete replaced resources'
$lines = Launch 'p3-downgrade'
$refusal = @($lines | Where-Object { $_ -match 'database bootstrap failed' -and $_ -match 'SCHEMA_FROM_NEWER_VERSION' })
Check 'p3-typed-refusal-logged' ($refusal.Count -gt 0) (($refusal | Select-Object -First 1))
# The refusal is terminal: the app must not re-open (and re-log) the newer database on every
# renderer call. One bootstrap attempt, one refusal line, for the whole launch.
Check 'p3-refusal-not-retried' (@($lines | Where-Object { $_ -match 'database bootstrap failed' }).Count -eq 1) "bootstrap-failure-lines=$(@($lines | Where-Object { $_ -match 'database bootstrap failed' }).Count)"
Check 'p3-names-unknown-migration' (@($lines | Where-Object { $_ -match '0010_h13_upgrade_probe' }).Count -gt 0) ''
$s3 = Snapshot 'p3'
Check 'p3-data-logically-unchanged' (($s3.migrations -join ',') -eq ($s2.migrations -join ',') -and (($s3.tables | ConvertTo-Json -Compress) -eq ($s2.tables | ConvertTo-Json -Compress)) -and ((@($s3.roleAssignments) -join ',') -eq (@($s2.roleAssignments) -join ','))) ''

# 4 uninstall keeps userData
$u = Start-Process -FilePath (Join-Path $dir 'unins000.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=`"$Evidence\p4-uninstall.log`"" -PassThru -Wait
Check 'p4-uninstall-exit-0' ($u.ExitCode -eq 0) $u.ExitCode
Start-Sleep -Seconds 3
Check 'p4-install-dir-removed' (-not (Test-Path (Join-Path $dir 'CompanyOS.exe'))) ''
Check 'p4-userdata-db-kept' (Test-Path $db) $db

# 5 reinstall newer: same data, opens again
$v5 = Install $Next 'p5-reinstall'
$s5 = Snapshot 'p5-before-launch'
Check 'p5-data-survived-uninstall' (($s5.migrations -join ',') -eq ($s2.migrations -join ',') -and (($s5.tables | ConvertTo-Json -Compress) -eq ($s2.tables | ConvertTo-Json -Compress)) -and ((@($s5.roleAssignments) -join ',') -eq (@($s2.roleAssignments) -join ','))) ''
$lines = Launch 'p5-reinstall'
Check 'p5-database-ready' (@($lines | Where-Object { $_ -match 'database ready' }).Count -gt 0) ''
Check 'p5-no-bootstrap-failure' (@($lines | Where-Object { $_ -match 'database bootstrap failed' }).Count -eq 0) ''
$u = Start-Process -FilePath (Join-Path $dir 'unins000.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -PassThru -Wait

$result | ConvertTo-Json -Depth 6 | Out-File -Encoding utf8 "$Evidence\upgrade-retention.json"
$failed = @($result.checks.GetEnumerator() | Where-Object { -not $_.Value.ok })
if ($failed.Count -gt 0) { Write-Host "FAILED: $(($failed | ForEach-Object Key) -join ', ')"; exit 1 }
Write-Host 'upgrade retention: all checks passed'
