// H16b-2 production launcher: companyos-isolated-launch.exe (built at packaging time with the .NET Framework csc that
// ships with Windows; no new dependency). Runs a command AS the CompanyOS agent account inside a Job Object and is a
// transparent stdio/exit-code proxy, so the app spawns it exactly like the kernel today (Node pipes, kill on timeout).
//
//   companyos-isolated-launch.exe --account <name> --credential <file.dpapi> --cwd <dir> -- <app> [args...]
//
// Sequence (proved by hark-isolation 40334964921 / lifecycle 40346061564): CreateProcessWithLogonW(LOGON_WITH_PROFILE,
// CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, STARTF_USESTDHANDLES with THIS process's std
// handles - seclogon duplicates them into the child) -> Job Object KILL_ON_JOB_CLOSE (+ DIE_ON_UNHANDLED_EXCEPTION)
// -> assign -> verify IsProcessInJob -> resume -> wait -> exit with the child's code.
// Fail closed: any step that fails exits 120..126 with one typed line on stderr and the child (if any) is killed:
//   120 ISOLATED_LAUNCH_USAGE  121 ISOLATED_LAUNCH_CREDENTIAL_UNREADABLE  122 ISOLATED_LAUNCH_LOGON_FAILED
//   123 ISOLATED_LAUNCH_JOB_FAILED  124 ISOLATED_LAUNCH_NOT_IN_JOB  125 ISOLATED_LAUNCH_PROFILE_MISSING
// Profile (lifecycle run 7, 40347340358): with logon flags 0 the agent's profile is never loaded, so anything that
// asks Windows for the account's profile (Node os.userInfo -> GetUserProfileDirectoryW, git, pwsh) fails, and the
// inherited environment pointed HOME/TEMP/APPDATA into the INSTALLING user's profile, which the agent cannot use.
// Now: setup.ps1 creates the agent profile (elevated, CreateProfile); the launcher loads it (LOGON_WITH_PROFILE) and
// rewrites every identity-bound variable (USERPROFILE, HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA, TEMP/TMP, USERNAME,
// USERDOMAIN; OneDrive* removed) to the agent profile; a missing profile fails closed with 125.
// The launcher's own death (the app kills it on timeout/abort) closes the only Job handle -> the agent tree dies.
// The password is the DPAPI (CurrentUser) blob the app wrote when it handed the password to the elevated setup helper;
// it is never on a command line and never in the child's environment.
using System;
using System.Collections;
using System.Collections.Generic;
using Microsoft.Win32;
using System.Security.Principal;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

public static class CompanyOSIsolatedLaunch {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessWithLogonW(string user, string domain, string password, uint logonFlags,
    string app, StringBuilder cmd, uint flags, IntPtr env, string cwd, ref STARTUPINFOW si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int s);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint c);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint c);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
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

  static int Fail(int code, string reason, string detail) {
    Console.Error.WriteLine("{\"schema\":\"companyos/isolated-launch-error/1\",\"reasonCode\":\"" + reason + "\",\"detail\":\"" + detail.Replace("\\", "\\\\").Replace("\"", "'") + "\"}");
    return code;
  }

  // Windows command-line quoting (CommandLineToArgvW rules), so argv reaches the child byte-for-byte.
  public static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    for (int i = 0; ; i++) {
      int bs = 0; while (i < a.Length && a[i] == '\\') { bs++; i++; }
      if (i == a.Length) { sb.Append('\\', bs * 2); break; }
      if (a[i] == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); } else { sb.Append('\\', bs); sb.Append(a[i]); }
    }
    return sb.Append('"').ToString();
  }

  static readonly string[] IdentityKeys = { "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "ONEDRIVE", "ONEDRIVECONSUMER", "ONEDRIVECOMMERCIAL" };

  // The agent account's profile directory as Windows registered it (ProfileList is readable by every user).
  public static string ProfileOf(string account, out string sid) {
    sid = null;
    try { sid = new NTAccount(Environment.MachineName, account).Translate(typeof(SecurityIdentifier)).Value; } catch { return null; }
    using (var k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid)) {
      var v = k == null ? null : k.GetValue("ProfileImagePath") as string;
      if (string.IsNullOrEmpty(v)) return null;
      v = Environment.ExpandEnvironmentVariables(v);
      return Directory.Exists(v) ? v : null;
    }
  }

  public static SortedDictionary<string, string> AgentEnvironment(IDictionary inherited, string account, string profile) {
    var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (DictionaryEntry e in inherited) {
      var k = (string)e.Key;
      if (Array.IndexOf(IdentityKeys, k.ToUpperInvariant()) >= 0) continue;
      env[k] = (string)e.Value;
    }
    string full = Path.GetFullPath(profile);
    env["USERPROFILE"] = full;
    env["HOMEDRIVE"] = full.Substring(0, 2);
    env["HOMEPATH"] = full.Substring(2);
    env["APPDATA"] = Path.Combine(full, @"AppData\Roaming");
    env["LOCALAPPDATA"] = Path.Combine(full, @"AppData\Local");
    env["TEMP"] = env["TMP"] = Path.Combine(full, @"AppData\Local\Temp");
    env["USERNAME"] = account;
    env["USERDOMAIN"] = Environment.MachineName;
    return env;
  }

  static IntPtr EnvBlock(SortedDictionary<string, string> env) {
    var sb = new StringBuilder();
    foreach (var kv in env) sb.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
    sb.Append('\0');
    return Marshal.StringToHGlobalUni(sb.ToString());
  }

  public static int Main(string[] args) {
    string account = null, credential = null, cwd = null; int sep = -1;
    for (int i = 0; i < args.Length; i++) {
      if (args[i] == "--") { sep = i; break; }
      if (i + 1 >= args.Length) return Fail(120, "ISOLATED_LAUNCH_USAGE", "missing value for " + args[i]);
      if (args[i] == "--account") account = args[++i];
      else if (args[i] == "--credential") credential = args[++i];
      else if (args[i] == "--cwd") cwd = args[++i];
      else return Fail(120, "ISOLATED_LAUNCH_USAGE", "unknown option " + args[i]);
    }
    if (account == null || credential == null || cwd == null || sep < 0 || sep + 1 >= args.Length)
      return Fail(120, "ISOLATED_LAUNCH_USAGE", "--account --credential --cwd -- <app> [args] required");
    string password;
    try { password = Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(credential), null, DataProtectionScope.CurrentUser)); }
    catch (Exception e) { return Fail(121, "ISOLATED_LAUNCH_CREDENTIAL_UNREADABLE", e.GetType().Name); }
    string app = args[sep + 1];
    var cmd = new StringBuilder(Quote(app));
    for (int i = sep + 2; i < args.Length; i++) cmd.Append(' ').Append(Quote(args[i]));

    var si = new STARTUPINFOW(); si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOW));
    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    string agentSid; string profile = ProfileOf(account, out agentSid);
    if (profile == null) { password = null; return Fail(125, "ISOLATED_LAUNCH_PROFILE_MISSING", "sid=" + (agentSid ?? "unresolved")); }
    IntPtr env = EnvBlock(AgentEnvironment(Environment.GetEnvironmentVariables(), account, profile));
    PROCESS_INFORMATION pi;
    bool ok = CreateProcessWithLogonW(account, ".", password, 1 /* LOGON_WITH_PROFILE */, app, cmd, 0x08000404, env, cwd, ref si, out pi);
    int err = ok ? 0 : Marshal.GetLastWin32Error();
    password = null; Marshal.FreeHGlobal(env);
    if (!ok) return Fail(122, "ISOLATED_LAUNCH_LOGON_FAILED", "win32=" + err);

    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000 | 0x400; // KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))
        || !AssignProcessToJobObject(job, pi.hProcess)) {
      int jerr = Marshal.GetLastWin32Error();
      TerminateProcess(pi.hProcess, 123);
      return Fail(123, "ISOLATED_LAUNCH_JOB_FAILED", "win32=" + jerr);
    }
    bool inJob; if (!IsProcessInJob(pi.hProcess, job, out inJob) || !inJob) { TerminateProcess(pi.hProcess, 124); return Fail(124, "ISOLATED_LAUNCH_NOT_IN_JOB", "pid=" + pi.dwProcessId); }
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code; GetExitCodeProcess(pi.hProcess, out code);
    // The Job handle is deliberately never closed before exit: process exit closes it and KILL_ON_JOB_CLOSE reaps any
    // grandchild the agent left behind.
    return (int)code;
  }
}
