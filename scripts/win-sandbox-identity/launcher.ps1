# STAGE 5D-B — Restricted token launcher (runs in a PS context with
# SeImpersonatePrivilege available; Git Bash->node strips it).
#
# Reads a JSON spec, performs:
#   LogonUser(sandbox account) ->
#   CreateRestrictedToken(add per-attempt restricting SID) ->
#   CreateProcessWithTokenW(CREATE_SUSPENDED) ->
#   AssignProcessToJobObject(KILL_ON_JOB_CLOSE) ->
#   ResumeThread -> WaitForSingleObject -> report exit/stdout/stderr
param([string]$SpecPath)

$ErrorActionPreference = 'Stop'
$spec = Get-Content $SpecPath -Raw | ConvertFrom-Json

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class Win32Launcher {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool LogonUserW(string user, string domain, string password, uint logonType, uint provider, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool CreateRestrictedToken(IntPtr existing, uint flags,
        uint disableSidCount, IntPtr sidsToDisable,
        uint deletePrivCount, IntPtr privsToDelete,
        uint restrictSidCount, IntPtr[] sidsToRestrict, out IntPtr newToken);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessWithTokenW(IntPtr token, uint logonFlags,
        string app, string cmd, uint flags, IntPtr env, string cwd,
        ref STARTUPINFOW si, ref PROCESS_INFORMATION pi);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool ConvertStringSidToSidW(string sid, out IntPtr sidPtr);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr handle, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOW {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize;
        public uint dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
}
"@

# 1. LogonUser
$logonToken = [IntPtr]::Zero
if (-not [Win32Launcher]::LogonUserW($spec.account, ".", $spec.password, 2, 0, [ref]$logonToken)) {
    Write-Output (ConvertTo-Json @{error = "LogonUserW failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"})
    exit 1
}

# 2. CreateRestrictedToken (restricting SID = per-attempt SID)
$sidPtr = [IntPtr]::Zero
if (-not [Win32Launcher]::ConvertStringSidToSidW($spec.restrictingSid, [ref]$sidPtr)) {
    Write-Output (ConvertTo-Json @{error = "ConvertStringSidToSidW failed"})
    [Win32Launcher]::CloseHandle($logonToken) | Out-Null
    exit 1
}
$sidArray = @($sidPtr)
$restrictedToken = [IntPtr]::Zero
if (-not [Win32Launcher]::CreateRestrictedToken($logonToken, 1, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero, 1, $sidArray, [ref]$restrictedToken)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Output (ConvertTo-Json @{error = "CreateRestrictedToken failed: $err"})
    [Win32Launcher]::CloseHandle($logonToken) | Out-Null
    exit 1
}

# 3. Job Object (KILL_ON_JOB_CLOSE, no breakaway)
$job = [Win32Launcher]::CreateJobObjectW([IntPtr]::Zero, "companyos.sbx.$([Guid]::NewGuid().ToString('N').Substring(0,8))")
$jobInfo = New-Object Win32Launcher+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
$jobInfo.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
[Win32Launcher]::SetInformationJobObject($job, 9, [ref]$jobInfo, [System.Runtime.InteropServices.Marshal]::SizeOf($jobInfo)) | Out-Null

# 4. CreateProcessWithTokenW (CREATE_SUSPENDED = 0x4)
$si = New-Object Win32Launcher+STARTUPINFOW
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$pi = New-Object Win32Launcher+PROCESS_INFORMATION
$cmdLine = "C:\Windows\System32\cmd.exe /d /c `"`"$($spec.batch)`"`""
if (-not [Win32Launcher]::CreateProcessWithTokenW($restrictedToken, 0, "C:\Windows\System32\cmd.exe", $cmdLine, 0, [IntPtr]::Zero, $spec.cwd, [ref]$si, [ref]$pi)) {
    $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Output (ConvertTo-Json @{error = "CreateProcessWithTokenW failed: $err"; lastErr = $err})
    [Win32Launcher]::CloseHandle($job) | Out-Null
    [Win32Launcher]::CloseHandle($restrictedToken) | Out-Null
    [Win32Launcher]::CloseHandle($logonToken) | Out-Null
    exit 1
}

# 5. Assign to Job (no Resume — flags=0, process starts running immediately)
[Win32Launcher]::AssignProcessToJobObject($job, $pi.hProcess) | Out-Null

# 6. Wait
$timeoutMs = [uint32]$spec.timeoutMs
$waitResult = [Win32Launcher]::WaitForSingleObject($pi.hProcess, $timeoutMs)
$timedOut = $false
if ($waitResult -eq 0x102) {  # WAIT_TIMEOUT
    $timedOut = $true
    [Win32Launcher]::TerminateJobObject($job, 124) | Out-Null
    [Win32Launcher]::WaitForSingleObject($pi.hProcess, 10000) | Out-Null
}

# 7. Get exit code
$exitCode = [uint32]0
[Win32Launcher]::GetExitCodeProcess($pi.hProcess, [ref]$exitCode) | Out-Null

# 8. Read stdout/stderr from redirect files
$stdoutText = ""
$stderrText = ""
try { $stdoutText = Get-Content $spec.stdoutFile -Raw -ErrorAction SilentlyContinue } catch {}
try { $stderrText = Get-Content $spec.stderrFile -Raw -ErrorAction SilentlyContinue } catch {}

# 9. Cleanup
[Win32Launcher]::CloseHandle($pi.hProcess) | Out-Null
[Win32Launcher]::CloseHandle($pi.hThread) | Out-Null
[Win32Launcher]::CloseHandle($job) | Out-Null
[Win32Launcher]::CloseHandle($restrictedToken) | Out-Null
[Win32Launcher]::CloseHandle($logonToken) | Out-Null

Write-Output (ConvertTo-Json @{
    exitCode = $exitCode
    pid = $pi.dwProcessId
    timedOut = $timedOut
    stdout = $stdoutText
    stderr = $stderrText
})
