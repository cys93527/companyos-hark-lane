# Hark lane H8: per-user install -> launch -> uninstall smoke on the CI runner.
# Records evidence into $Evidence. Exit 0 only if every check passes.
param([Parameter(Mandatory)] [string]$Setup, [Parameter(Mandatory)] [string]$Evidence)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Evidence | Out-Null
$dir = Join-Path $env:LOCALAPPDATA 'Programs\CompanyOS-HarkSmoke'
$result = [ordered]@{ setup = $Setup; installDir = $dir; checks = [ordered]@{} }
function Check($name, $ok, $detail) { $result.checks[$name] = [ordered]@{ ok = [bool]$ok; detail = "$detail" } }

$p = Start-Process -FilePath $Setup -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER',"/DIR=`"$dir`"","/LOG=`"$Evidence\install-setup.log`"" -PassThru -Wait
Check 'install-exit-0' ($p.ExitCode -eq 0) $p.ExitCode
$exe = Join-Path $dir 'CompanyOS.exe'
Check 'exe-installed' (Test-Path $exe) $exe
Check 'app-payload' (Test-Path (Join-Path $dir 'resources\app\apps\desktop\dist\main.js')) 'resources/app main.js'
# H15: the exact-pinned agent kernel ships as an install resource (manifest + SBOM + licences + pinned node).
$kdir = Join-Path $dir 'resources\agent-kernel\dsh-v0.2.0-rc.2'
Check 'agent-kernel-installed' ((Test-Path (Join-Path $kdir 'manifest.json')) -and (Test-Path (Join-Path $kdir 'sbom.cdx.json')) -and (Test-Path (Join-Path $kdir 'licenses\LICENSE')) -and (Test-Path (Join-Path $kdir 'node\node.exe'))) $kdir
$ndir = Join-Path $dir 'resources\native'
Check 'native-job-installed' ((Test-Path (Join-Path $ndir 'operations.json')) -and (Test-Path (Join-Path $ndir 'koffi-3.3.3\binding-manifest.json')) -and (Test-Path (Join-Path $ndir 'operations\workspace-inventory.cjs'))) $ndir
Check 'uninstaller-present' (Test-Path (Join-Path $dir 'unins000.exe')) 'unins000.exe'
$uninstKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'CompanyOS' }
Check 'hkcu-uninstall-entry' ($null -ne $uninstKey) ($uninstKey.PSChildName)
$wizardLang = if ($uninstKey) { (Get-ItemProperty $uninstKey.PSPath).'Inno Setup: Language' } else { $null }
Check 'wizard-language-zh-cn' ($wizardLang -eq 'chs') "Inno Setup: Language=$wizardLang"
$hklm = Get-ChildItem 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'CompanyOS' }
Check 'no-machine-wide-entry' ($null -eq $hklm) 'per-user only'

$userData = Join-Path $env:APPDATA 'CompanyOS'
$before = Test-Path $userData
$app = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds 25
$alive = -not $app.HasExited
Check 'app-alive-after-25s' $alive ("hasExited=" + $app.HasExited + $(if ($app.HasExited) { " exit=" + $app.ExitCode } else { '' }))
# H15c: first start stages + re-hashes the 4.8k-file kernel closure before the window
# opens (quiescent startup), which took 22.3 s on a runner (hark-installer 40264045794)
# and overran a fixed 25 s sample (40263388350). Wait for the app's OWN startup verdict
# ('window ready', or a startup failure / exit) instead of sampling a fixed instant.
$startupDeadline = (Get-Date).AddSeconds(180)
$startupSeen = $false
while ((Get-Date) -lt $startupDeadline -and -not $app.HasExited) {
  $probe = @(Get-ChildItem (Join-Path $userData 'logs') -File -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName -ErrorAction SilentlyContinue })
  if (@($probe | Where-Object { $_ -match '"msg":"(window ready|startup failed[^"]*)"' }).Count -gt 0) { $startupSeen = $true; break }
  Start-Sleep -Seconds 2
}
$startupSeconds = [math]::Round(((Get-Date) - $app.StartTime).TotalSeconds, 1)
Check 'startup-completed' ($startupSeen -and -not $app.HasExited) "window-ready-after=${startupSeconds}s"
$result.startupSeconds = $startupSeconds
$logs = Get-ChildItem (Join-Path $userData 'logs') -File -ErrorAction SilentlyContinue
Check 'userdata-logs-written' ($logs.Count -gt 0) (($logs | ForEach-Object Name) -join ',')
if ($logs) { $logs | ForEach-Object { Copy-Item $_.FullName (Join-Path $Evidence ("app-" + $_.Name)) } }
$errLines = @($logs | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ -match '"level":"(error|fatal)"' })
Check 'no-error-log-lines' ($errLines.Count -eq 0) (($errLines | Select-Object -First 3) -join ' | ')
$dbReady = @($logs | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ -match 'database bootstrap failed' })
Check 'database-bootstrapped' ($dbReady.Count -eq 0) "bootstrap-failures=$($dbReady.Count)"
# H15: the app's own first-start health check read the kernel version back from the installed resource.
$health = @($logs | ForEach-Object { Get-Content $_.FullName } | Where-Object { $_ -match 'embedded kernel' })
$health | Out-File -Encoding utf8 (Join-Path $Evidence 'kernel-health-log.txt')
$healthy = @($health | Where-Object { $_ -match 'embedded kernel health' -and $_ -match '"status":"HEALTHY"' })
Check 'kernel-first-start-health' ($healthy.Count -ge 1) (($health | Select-Object -First 2) -join ' | ')
$data = Get-ChildItem (Join-Path $userData 'data') -Recurse -File -ErrorAction SilentlyContinue
Check 'userdata-data-created' ($data.Count -gt 0) (($data | ForEach-Object Name) -join ',')
$windows = Get-Process -Id $app.Id -ErrorAction SilentlyContinue | Select-Object -ExpandProperty MainWindowTitle
$result.mainWindowTitle = "$windows"
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  [System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $Evidence 'app-screenshot.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $result.screenshot = 'app-screenshot.png'
} catch { $result.screenshot = "unavailable: $($_.Exception.Message)" }
if (-not $app.HasExited) { & taskkill.exe /PID $app.Id /T /F | Out-File -Append (Join-Path $Evidence 'taskkill.log') }
Start-Sleep -Seconds 3
$left = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) }
Check 'no-app-process-left' ($left.Count -eq 0) (($left | ForEach-Object Id) -join ',')

# H17a: ordinary-user first-run setup on the INSTALLED app (fake key; no model call is made by setup).
$setupPs1 = Join-Path $dir 'resources\setup\configure-deepseek.ps1'
Check 'h17a-setup-helper-installed' ((Test-Path $setupPs1) -and (Test-Path (Join-Path $dir 'resources\setup\configure-provider.mjs'))) $setupPs1
$lnk = @(Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Filter 'CompanyOS *.lnk' -ErrorAction SilentlyContinue)
Check 'h17a-start-menu-shortcut' ($lnk.Count -ge 1) (($lnk | ForEach-Object Name) -join ',')
$fakeKey = 'sk-harksmoke-' + [Guid]::NewGuid().ToString('N')
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$ErrorActionPreference = 'Continue'  # native stderr must not throw under Stop (PS 5.1 NativeCommandError)
$fakeKey | & $ps -NoProfile -ExecutionPolicy Bypass -File $setupPs1 -KeyFromStdin -CapCny 1 -NoPause *> (Join-Path $Evidence 'h17a-setup.txt')
$setupExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$approval = Join-Path $userData 'budget\approvals.json'
Check 'h17a-setup-exit-0' ($setupExit -eq 0) "exit=$setupExit"
Check 'h17a-setup-files' ((Test-Path (Join-Path $userData 'provider\model-api-key.dpapi')) -and (Test-Path (Join-Path $userData 'provider\model.json')) -and (Test-Path $approval)) 'provider/model-api-key.dpapi, provider/model.json, budget/approvals.json'
$capOk = $false; try { $capOk = ((Get-Content $approval -Raw | ConvertFrom-Json).cap.maxCostMicros -eq 1000000) } catch { }
Check 'h17a-approval-cap-1-cny' $capOk 'maxCostMicros=1000000'
$app2 = Start-Process -FilePath $exe -PassThru
$deadline2 = (Get-Date).AddSeconds(180); $setupLine = $null
while ((Get-Date) -lt $deadline2 -and -not $app2.HasExited -and $null -eq $setupLine) {
  $setupLine = @(Get-ChildItem (Join-Path $userData 'logs') -File -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_.FullName -ErrorAction SilentlyContinue } | Where-Object { $_ -match '"msg":"provider setup"' -and $_ -match '"setupState":"CONFIGURED"' }) | Select-Object -Last 1
  if ($null -eq $setupLine) { Start-Sleep -Seconds 2 }
}
"$setupLine" | Out-File -Encoding utf8 (Join-Path $Evidence 'h17a-provider-setup-log.txt')
Check 'h17a-app-reads-setup' ("$setupLine" -match '"source":"provider-setup"') "$setupLine"
if (-not $app2.HasExited) { & taskkill.exe /PID $app2.Id /T /F | Out-File -Append (Join-Path $Evidence 'taskkill.log') }
Start-Sleep -Seconds 3
$leakFiles = @(Get-ChildItem $userData -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -ne '.dpapi' -and (Select-String -LiteralPath $_.FullName -SimpleMatch $fakeKey -Quiet -ErrorAction SilentlyContinue) })
Check 'h17a-key-not-in-plain-files' ($leakFiles.Count -eq 0) (($leakFiles | ForEach-Object Name) -join ',')
$ErrorActionPreference = 'Continue'
& $ps -NoProfile -ExecutionPolicy Bypass -File $setupPs1 -Remove -NoPause *> (Join-Path $Evidence 'h17a-remove.txt')
$removeExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
Check 'h17a-remove' (($removeExit -eq 0) -and -not (Test-Path (Join-Path $userData 'provider\model-api-key.dpapi')) -and -not (Test-Path $approval)) "exit=$removeExit"
if ($logs) { Get-ChildItem (Join-Path $userData 'logs') -File -ErrorAction SilentlyContinue | ForEach-Object { Copy-Item $_.FullName (Join-Path $Evidence ("app-after-h17a-" + $_.Name)) } }

# H16b-3b: ordinary-user isolation setup on the INSTALLED app (Start menu 'CompanyOS 隔离设置'), then the
# uninstaller must remove it (no account / WFP filter / ACE left behind).
$isoPs1 = Join-Path $dir 'resources\setup\configure-isolation.ps1'
Check 'h16-isolation-helper-installed' ((Test-Path $isoPs1) -and (Test-Path (Join-Path $dir 'resources\isolation\setup.ps1')) -and (Test-Path (Join-Path $dir 'resources\isolation\companyos-isolated-launch.exe'))) $isoPs1
$isoLnk = @(Get-ChildItem (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') -Filter 'CompanyOS *.lnk' -ErrorAction SilentlyContinue)
Check 'h16-isolation-shortcuts' ($isoLnk.Count -ge 3) (($isoLnk | ForEach-Object Name) -join ',')
$smokeWs = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'CompanyOS-HarkSmoke-workspace'
New-Item -ItemType Directory -Force -Path $smokeWs | Out-Null
# What the app writes when the user picks a workspace (workspace-selection.ts).
[IO.File]::WriteAllText((Join-Path $userData 'workspace-selection.json'), (([ordered]@{ root = $smokeWs; selectedAt = (Get-Date).ToString('o') }) | ConvertTo-Json))
$ErrorActionPreference = 'Continue'
& $ps -NoProfile -ExecutionPolicy Bypass -File $isoPs1 -NoPause *> (Join-Path $Evidence 'h16-isolation-setup.txt')
$isoExit = $LASTEXITCODE
& $ps -NoProfile -ExecutionPolicy Bypass -File $isoPs1 -Status -NoPause *> (Join-Path $Evidence 'h16-isolation-status.txt')
$isoStatusExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$isoState = Join-Path $userData 'isolation\state.json'
$isoAccount = $null; $isoWs = $null
try { $st = Get-Content -LiteralPath $isoState -Raw | ConvertFrom-Json; $isoAccount = $st.account; $isoWs = @($st.workspaceDirs) } catch { }
Check 'h16-isolation-setup-exit-0' ($isoExit -eq 0) "exit=$isoExit"
Check 'h16-isolation-state' (($null -ne $isoAccount) -and (Test-Path (Join-Path $userData 'isolation\agent-credential.dpapi')) -and ($isoWs -contains $smokeWs)) "account=$isoAccount workspaceDirs=$($isoWs -join ';')"
Check 'h16-isolation-account-exists' ($isoAccount -and (Get-LocalUser -Name $isoAccount -ErrorAction SilentlyContinue)) "$isoAccount"
Check 'h16-isolation-status-isolated' ($isoStatusExit -eq 0) "exit=$isoStatusExit"
Check 'h16-isolation-no-handoff-left' (@(Get-ChildItem (Join-Path $userData 'isolation') -Filter 'handoff-*' -ErrorAction SilentlyContinue).Count -eq 0) ''

$u = Start-Process -FilePath (Join-Path $dir 'unins000.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=`"$Evidence\uninstall.log`"" -PassThru -Wait
Check 'uninstall-exit-0' ($u.ExitCode -eq 0) $u.ExitCode
Start-Sleep -Seconds 3  # the Inno uninstaller deletes itself via a short-lived helper
Check 'install-dir-removed' (-not (Test-Path $exe)) ((Get-ChildItem $dir -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName) -join ';')
Check 'h16-uninstall-removed-isolation' ((-not (Test-Path $isoState)) -and (-not (Test-Path (Join-Path $userData 'isolation\agent-credential.dpapi'))) -and -not ($isoAccount -and (Get-LocalUser -Name $isoAccount -ErrorAction SilentlyContinue))) "account=$isoAccount"
$still = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'CompanyOS' }
Check 'uninstall-entry-removed' ($null -eq $still) ''
$result.userDataExistedBefore = $before
$result.userDataKeptAfterUninstall = (Test-Path $userData)
$result | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $Evidence 'installer-smoke.json')
Get-Content (Join-Path $Evidence 'installer-smoke.json')
$failed = @($result.checks.GetEnumerator() | Where-Object { -not $_.Value.ok })
if ($failed.Count -gt 0) { Write-Host "FAILED: $(($failed | ForEach-Object Key) -join ', ')"; exit 1 }
Write-Host 'installer smoke: all checks passed'
