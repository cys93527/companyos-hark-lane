# Hark lane H17a - "CompanyOS 首次配置": ordinary-user DeepSeek setup for the INSTALLED app.
# Runs as the signed-in user (no elevation). Start menu shortcut:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<install>\resources\setup\configure-deepseek.ps1"
# What it does:
#   1. reads the DeepSeek API key with Read-Host -AsSecureString (or one line on stdin with -KeyFromStdin,
#      for the installer smoke), checks its shape, and protects it with DPAPI (CurrentUser) into
#      %APPDATA%\CompanyOS\provider\model-api-key.dpapi. The key never appears on a command line, in an
#      environment block, in a log, or in any file in plain form.
#   2. runs configure-provider.mjs under the app's own runtime (ELECTRON_RUN_AS_NODE) to write the NON-secret
#      provider\model.json and the user's per-Goal budget approval (budget\approvals.json + price proof).
#   -Remove deletes the key file, model.json and the approval this helper wrote.
# Exit codes: 0 configured/removed, 2 bad input, 3 write failed, 5 app not found.
param(
  [double]$CapCny = 0,
  [switch]$KeyFromStdin,
  [switch]$Remove,
  [switch]$NoPause,
  [string]$UserData = (Join-Path $env:APPDATA 'CompanyOS'),
  [string]$AppExe = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'CompanyOS.exe')
)
# Windows PowerShell 5.1 started by a non-PowerShell parent that itself runs inside PowerShell 7 (e.g. the uninstaller
# launched from a pwsh window) inherits pwsh's PSModulePath and then autoloads the PowerShell 7 editions of
# Microsoft.PowerShell.Security/Utility, which 5.1 cannot load ('Get-Acl ... module could not be loaded'; hark-installer
# 41195872992 uninstall). pwsh only repairs this for powershell.exe it starts itself, so every shipped 5.1 script
# restores the Windows PowerShell module path before its first module command; children inherit the repaired value.
function Repair-WindowsPowerShellModulePath {
  if ($PSVersionTable.PSEdition -eq 'Core') { return }
  $wps = @()
  $docs = [Environment]::GetFolderPath('MyDocuments')
  if ($docs) { $wps += [IO.Path]::Combine($docs, 'WindowsPowerShell', 'Modules') }
  if ($env:ProgramFiles) { $wps += [IO.Path]::Combine($env:ProgramFiles, 'WindowsPowerShell', 'Modules') }
  $wps += [IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  $rest = @(([string]$env:PSModulePath) -split ';' | Where-Object { $_ -and ($_ -notmatch '(^|\\)PowerShell(\\|$)') })
  $seen = @{}; $out = @()
  foreach ($p in ($wps + $rest)) { $k = $p.TrimEnd('\').ToLowerInvariant(); if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $out += $p } }
  $env:PSModulePath = $out -join ';'
}
Repair-WindowsPowerShellModulePath
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName System.Security

function Finish([int]$code, [string]$message) {
  Write-Host $message
  if (-not $NoPause -and -not $KeyFromStdin) { [void](Read-Host '按回车键关闭') }
  exit $code
}

# Never exits the script itself: the caller must be able to restore the previous key on any failure (AUDIT-S9).
function Invoke-SetupNode([string[]]$arguments) {
  if (-not (Test-Path -LiteralPath $AppExe)) { return [pscustomobject]@{ exit = 5; result = $null; raw = "找不到 CompanyOS 程序：$AppExe" } }
  $script = Join-Path $PSScriptRoot 'configure-provider.mjs'
  $out = [IO.Path]::GetTempFileName(); $err = [IO.Path]::GetTempFileName()
  $quoted = @("`"$script`"") + ($arguments | ForEach-Object { "`"$_`"" })
  $prev = $env:ELECTRON_RUN_AS_NODE
  $env:ELECTRON_RUN_AS_NODE = '1'
  try {
    $p = Start-Process -FilePath $AppExe -ArgumentList $quoted -Wait -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
    $text = [IO.File]::ReadAllText($out, (New-Object Text.UTF8Encoding($false)))
    # AUDIT-S13: node's stderr (an import failure, a crash) is part of the message; it never carries the key.
    $errText = ([IO.File]::ReadAllText($err, (New-Object Text.UTF8Encoding($false)))).Trim()
    if ($errText.Length -gt 2000) { $errText = $errText.Substring(0, 2000) + ' ...' }
    $raw = $text.Trim()
    if ($errText) { $raw = ($raw + [Environment]::NewLine + $errText).Trim() }
    # an empty stdout (the module never loaded) must not throw a binding error that would hide $errText
    $parsed = $null
    if (-not [string]::IsNullOrWhiteSpace($text)) { try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null } }
    return [pscustomobject]@{ exit = $p.ExitCode; result = $parsed; raw = $raw }
  } catch {
    return [pscustomobject]@{ exit = -1; result = $null; raw = "无法启动 CompanyOS 程序：$($_.Exception.Message)" }
  } finally {
    $env:ELECTRON_RUN_AS_NODE = $prev
    Remove-Item -LiteralPath $out, $err -Force -ErrorAction SilentlyContinue
  }
}

$providerDir = Join-Path $UserData 'provider'
$keyFile = Join-Path $providerDir 'model-api-key.dpapi'

if ($Remove) {
  $r = Invoke-SetupNode @('remove', '--user-data', $UserData)
  if ($r.exit -eq 5) { Finish 5 $r.raw }
  if ($r.exit -ne 0) { Finish 3 "移除失败：$($r.raw)" }
  Finish 0 '已移除 CompanyOS 的模型配置（API Key、模型设置和预算批准）。重新启动 CompanyOS 后生效。'
}

# AUDIT-S9: the app must exist BEFORE anything is asked or written (it used to be checked after the key was replaced).
if (-not (Test-Path -LiteralPath $AppExe)) { Finish 5 "找不到 CompanyOS 程序：$AppExe" }
Write-Host 'CompanyOS 首次配置（DeepSeek）'
Write-Host 'API Key 只保存在本机，用当前 Windows 用户的 DPAPI 加密；CompanyOS 界面不会读取或显示它。'

# 1. the key
$plain = $null
if ($KeyFromStdin) {
  $plain = [Console]::In.ReadLine()
} else {
  $secure = Read-Host -AsSecureString '请粘贴 DeepSeek API Key（输入时不显示）'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if ($null -eq $plain) { $plain = '' }
$plain = $plain.Trim()
if ($plain -notmatch '^[\x21-\x7e]{8,512}$') { $plain = $null; Finish 2 'API Key 格式不对（应为 8 到 512 个可见字符，不能有空格）。没有保存任何内容。' }

# 2. the per-Goal cap
if ($CapCny -le 0) {
  if ($KeyFromStdin) { $CapCny = 5 } else {
    $answer = Read-Host '每个目标最多花多少钱（人民币元，0.1 到 100，直接回车 = 5）'
    if ([string]::IsNullOrWhiteSpace($answer)) { $CapCny = 5 } else {
      $parsed = 0.0
      if (-not [double]::TryParse($answer.Trim(), [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) { $plain = $null; Finish 2 '金额格式不对。没有保存任何内容。' }
      $CapCny = $parsed
    }
  }
}
if ($CapCny -lt 0.1 -or $CapCny -gt 100) { $plain = $null; Finish 2 '金额必须在 0.1 到 100 元之间。没有保存任何内容。' }

# 3. protect + write the key (DPAPI CurrentUser); plaintext bytes are zeroed right after
New-Item -ItemType Directory -Force -Path $providerDir | Out-Null
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$plain = $null
try {
  $blob = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
} finally { [Array]::Clear($bytes, 0, $bytes.Length) }
# AUDIT-S9: a re-run must never lose the previously working key. The new blob goes to .new, the old key is kept as
# .bak while the app writes and verifies the rest, and is put back on ANY failure; .bak is deleted only on success.
$newKey = "$keyFile.new"
$bakKey = "$keyFile.bak"
if (Test-Path -LiteralPath $bakKey) {
  # left by an interrupted earlier run: the .bak is the last working key unless a key file exists again
  if (Test-Path -LiteralPath $keyFile) { Remove-Item -LiteralPath $bakKey -Force } else { Move-Item -LiteralPath $bakKey -Destination $keyFile -Force }
}
[IO.File]::WriteAllBytes($newKey, $blob)
$hadOld = Test-Path -LiteralPath $keyFile
function Restore-PreviousKey {
  Remove-Item -LiteralPath $newKey -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
  if ($hadOld -and (Test-Path -LiteralPath $bakKey)) { Move-Item -LiteralPath $bakKey -Destination $keyFile -Force; return '已恢复原来保存的 API Key' }
  return '没有保存新的 API Key'
}
try {
  if ($hadOld) { Move-Item -LiteralPath $keyFile -Destination $bakKey -Force }
  Move-Item -LiteralPath $newKey -Destination $keyFile -Force
} catch {
  $restored = Restore-PreviousKey
  Finish 3 "保存 API Key 失败（$restored）：$($_.Exception.Message)"
}

# 4. non-secret model settings + budget approval through the app's own parsers
$cap = $CapCny.ToString([Globalization.CultureInfo]::InvariantCulture)
$r = Invoke-SetupNode @('write', '--user-data', $UserData, '--cap-cny', $cap, '--approved-by', $env:USERNAME)
if ($r.exit -ne 0 -or $null -eq $r.result -or -not $r.result.ok) {
  $restored = Restore-PreviousKey
  Finish 3 "配置写入失败（$restored）：$($r.raw)"
}
Remove-Item -LiteralPath $bakKey -Force -ErrorAction SilentlyContinue
Finish 0 "已配置：DeepSeek（deepseek-flash），每个目标花费上限 $cap 元。请重新启动 CompanyOS 后生效；要修改或移除，重新运行「CompanyOS 首次配置」（移除：加 -Remove）。"
