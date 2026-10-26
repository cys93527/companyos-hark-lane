// H16b test launcher: CreateProcessWithLogonW(CREATE_SUSPENDED) -> Job Object (KILL_ON_JOB_CLOSE) -> resume -> wait.
// Same sequence the probe proved (hark-isolation 40334964921); used by lifecycle.ps1 to run as the agent account.
using System;
using System.Runtime.InteropServices;

public static class CompanyOSCpwl {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessWithLogonW(string user, string domain, string password, uint logonFlags,
    string app, string cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int s);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint c);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint c);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFOW {
    public uint cb; public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

  public static string RunInJob(string user, string password, string app, string cmd, string cwd, uint timeoutMs) {
    var si = new STARTUPINFOW(); si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOW));
    PROCESS_INFORMATION pi;
    // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW; logon flags 0 (no profile load).
    if (!CreateProcessWithLogonW(user, ".", password, 0, app, cmd, 0x08000404, IntPtr.Zero, cwd, ref si, out pi))
      return "launch=failed err=" + Marshal.GetLastWin32Error();
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); info.BasicLimitInformation.LimitFlags = 0x2000;
    bool limits = SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
    bool assigned = AssignProcessToJobObject(job, pi.hProcess);
    int assignErr = assigned ? 0 : Marshal.GetLastWin32Error();
    bool inJob; IsProcessInJob(pi.hProcess, job, out inJob);
    ResumeThread(pi.hThread);
    uint w = WaitForSingleObject(pi.hProcess, timeoutMs);
    bool timedOut = w == 0x102;
    if (timedOut) { TerminateJobObject(job, 124); WaitForSingleObject(pi.hProcess, 10000); }
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(job); CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return "launch=ok limits=" + limits + " assigned=" + assigned + " assignErr=" + assignErr + " inJob=" + inJob + " timedOut=" + timedOut + " exit=" + code + " pid=" + pi.dwProcessId;
  }
}
