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

$u = Start-Process -FilePath (Join-Path $dir 'unins000.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=`"$Evidence\uninstall.log`"" -PassThru -Wait
Check 'uninstall-exit-0' ($u.ExitCode -eq 0) $u.ExitCode
Start-Sleep -Seconds 3  # the Inno uninstaller deletes itself via a short-lived helper
Check 'install-dir-removed' (-not (Test-Path $exe)) ((Get-ChildItem $dir -Recurse -ErrorAction SilentlyContinue | ForEach-Object FullName) -join ';')
$still = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -eq 'CompanyOS' }
Check 'uninstall-entry-removed' ($null -eq $still) ''
$result.userDataExistedBefore = $before
$result.userDataKeptAfterUninstall = (Test-Path $userData)
$result | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $Evidence 'installer-smoke.json')
Get-Content (Join-Path $Evidence 'installer-smoke.json')
$failed = @($result.checks.GetEnumerator() | Where-Object { -not $_.Value.ok })
if ($failed.Count -gt 0) { Write-Host "FAILED: $(($failed | ForEach-Object Key) -join ', ')"; exit 1 }
Write-Host 'installer smoke: all checks passed'
