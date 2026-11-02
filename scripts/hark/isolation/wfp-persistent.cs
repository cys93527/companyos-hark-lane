// H16b production: PERSISTENT Windows Filtering Platform objects that confine the CompanyOS agent account.
// Proven by the probe (hark-isolation 40334964921): Windows Firewall rules never match loopback, WFP
// ALE_AUTH_CONNECT filters do. The elevated isolation helper (setup.ps1) installs, verifies and removes
// these objects by FIXED keys, so the app's start-time status check and uninstall find them without state.
//   provider  CompanyOS agent isolation           649e0283-b6fd-4309-b881-fb82b67fcea9
//   sublayer  weight 0xFFFF                       60ebdb28-3fae-4291-9bd9-27863ab73a79
//   filter v4 block every account connect (weight 14)      74a06708-c0f7-43ca-867f-02ce2db8e953
//   permit v4 account -> 127.0.0.1:<broker> TCP (weight 15)  0b6b5b1e-6f0f-4d8a-9a43-3c7a2f1d9e51
//   filter v6 block every account connect      50418b8d-e4dd-4ee4-b931-d941f447b4de
// AUDIT-S1: the v4 hole used to be "remote port != broker" on ANY host, so the agent reached <any LAN/internet
// host>:<broker port>. The hole is now a separate hard PERMIT scoped to remote address 127.0.0.1 + the broker
// port + TCP, above a block-all filter for the agent account.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CompanyOSWfp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY { public IntPtr name; public IntPtr description; }
  [StructLayout(LayoutKind.Sequential)]
  public struct BLOB { public uint size; public IntPtr data; }
  [StructLayout(LayoutKind.Sequential)]
  public struct VALUE { public uint type; public IntPtr value; }
  [StructLayout(LayoutKind.Sequential)]
  public struct CONDITION { public Guid fieldKey; public uint matchType; public VALUE conditionValue; }
  [StructLayout(LayoutKind.Sequential)]
  public struct ACTION { public uint type; public Guid filterType; }
  [StructLayout(LayoutKind.Sequential)]
  public struct FILTER {
    public Guid filterKey; public DISPLAY displayData; public uint flags; public IntPtr providerKey; public BLOB providerData;
    public Guid layerKey; public Guid subLayerKey; public VALUE weight; public uint numFilterConditions; public IntPtr filterCondition;
    public ACTION action; public ulong context0; public ulong context1; public IntPtr reserved; public ulong filterId; public VALUE effectiveWeight;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct SUBLAYER { public Guid subLayerKey; public DISPLAY displayData; public uint flags; public IntPtr providerKey; public BLOB providerData; public ushort weight; }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROVIDER { public Guid providerKey; public DISPLAY displayData; public uint flags; public BLOB providerData; public IntPtr serviceName; }
  [StructLayout(LayoutKind.Sequential)]
  public struct SESSION { public Guid sessionKey; public DISPLAY displayData; public uint flags; public uint txnWaitTimeoutInMSec; public uint processId; public IntPtr sid; public IntPtr username; public int kernelMode; }

  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(string server, uint authn, IntPtr authId, ref SESSION session, out IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine, uint flags);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderAdd0(IntPtr engine, ref PROVIDER provider, IntPtr sd);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderDeleteByKey0(IntPtr engine, ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmProviderGetByKey0(IntPtr engine, ref Guid key, out IntPtr provider);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine, ref SUBLAYER subLayer, IntPtr sd);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine, ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerGetByKey0(IntPtr engine, ref Guid key, out IntPtr subLayer);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine, ref FILTER filter, IntPtr sd, out ulong id);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine, ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterGetByKey0(IntPtr engine, ref Guid key, out IntPtr filter);
  [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr p);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr sd, out uint size);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr sddl, out uint len);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

  public static readonly Guid PROVIDER_KEY = new Guid("649e0283-b6fd-4309-b881-fb82b67fcea9");
  public static readonly Guid SUBLAYER_KEY = new Guid("60ebdb28-3fae-4291-9bd9-27863ab73a79");
  public static readonly Guid FILTER_V4_KEY = new Guid("74a06708-c0f7-43ca-867f-02ce2db8e953");
  public static readonly Guid FILTER_V6_KEY = new Guid("50418b8d-e4dd-4ee4-b931-d941f447b4de");
  public static readonly Guid PERMIT_V4_KEY = new Guid("0b6b5b1e-6f0f-4d8a-9a43-3c7a2f1d9e51");
  public static readonly Guid LAYER_CONNECT_V4 = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
  public static readonly Guid LAYER_CONNECT_V6 = new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
  static readonly Guid COND_USER = new Guid("af043a0a-b34d-4f86-979c-c90371af6e66");
  static readonly Guid COND_REMOTE_PORT = new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b");
  static readonly Guid COND_REMOTE_ADDRESS = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045");
  static readonly Guid COND_PROTOCOL = new Guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");
  const uint LOOPBACK_V4 = 0x7F000001, IPPROTO_TCP = 6, FWP_UINT32 = 3, ACTION_PERMIT = 0x1002;
  const byte WEIGHT_BLOCK = 14, WEIGHT_PERMIT = 15;
  const uint FWP_UINT8 = 1, FWP_UINT16 = 2, FWP_SD = 14, MATCH_EQUAL = 0, MATCH_NOT_EQUAL = 10;
  const uint ACTION_BLOCK = 0x1001, FILTER_FLAG_PERSISTENT = 0x1, FILTER_FLAG_CLEAR_ACTION_RIGHT = 0x8;
  const uint PROVIDER_FLAG_PERSISTENT = 0x1, SUBLAYER_FLAG_PERSISTENT = 0x1, RPC_C_AUTHN_WINNT = 10;
  public const uint E_FILTER_NOT_FOUND = 0x80320003, E_PROVIDER_NOT_FOUND = 0x80320005, E_SUBLAYER_NOT_FOUND = 0x80320007;

  public static readonly List<string> Log = new List<string>();
  static IntPtr engine = IntPtr.Zero;
  static readonly List<IntPtr> allocs = new List<IntPtr>();

  static IntPtr Str(string s) { IntPtr p = Marshal.StringToHGlobalUni(s); allocs.Add(p); return p; }
  static IntPtr GuidPtr(Guid g) { IntPtr p = Marshal.AllocHGlobal(16); allocs.Add(p); Marshal.Copy(g.ToByteArray(), 0, p, 16); return p; }
  static void FreeAll() { foreach (var p in allocs) Marshal.FreeHGlobal(p); allocs.Clear(); }
  static string Hex(uint rc) { return "0x" + rc.ToString("x"); }

  // Non-dynamic session: objects added with the PERSISTENT flags outlive the session and reboots.
  public static uint Open() {
    var s = new SESSION(); s.displayData.name = Str("CompanyOS isolation helper");
    return FwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, IntPtr.Zero, ref s, out engine);
  }
  public static void Close() { if (engine != IntPtr.Zero) { FwpmEngineClose0(engine); engine = IntPtr.Zero; } FreeAll(); }

  static uint DeleteObjects() {
    Guid k;
    k = FILTER_V4_KEY; uint a = FwpmFilterDeleteByKey0(engine, ref k);
    k = FILTER_V6_KEY; uint b = FwpmFilterDeleteByKey0(engine, ref k);
    k = PERMIT_V4_KEY; uint e = FwpmFilterDeleteByKey0(engine, ref k);
    k = SUBLAYER_KEY; uint c = FwpmSubLayerDeleteByKey0(engine, ref k);
    k = PROVIDER_KEY; uint d = FwpmProviderDeleteByKey0(engine, ref k);
    Log.Add("delete v4=" + Hex(a) + " v6=" + Hex(b) + " permitV4=" + Hex(e) + " sublayer=" + Hex(c) + " provider=" + Hex(d));
    foreach (var rc in new[] { a, b, e }) if (rc != 0 && rc != E_FILTER_NOT_FOUND) return rc;
    if (c != 0 && c != E_SUBLAYER_NOT_FOUND) return c;
    if (d != 0 && d != E_PROVIDER_NOT_FOUND) return d;
    return 0;
  }

  // Lifecycle run 6 (40346676658, L4b): the installing user's UNELEVATED status check got 0x5 (ACCESS_DENIED) on
  // provider/sublayer/both filters - the default WFP object SD only lets administrators read. Every object is now added
  // with an explicit SD: administrators + SYSTEM full control, the installing (reader) user GENERIC_READ, nobody else.
  static IntPtr ObjectSd(string readerSid) {
    IntPtr sd; uint size;
    string sddl = "O:BAG:BAD:(A;;GA;;;BA)(A;;GA;;;SY)" + (string.IsNullOrEmpty(readerSid) ? "" : "(A;;GR;;;" + readerSid + ")");
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) return IntPtr.Zero;
    return sd;
  }

  // block: user only (weight 14). permit: user + 127.0.0.1 + broker port + TCP (weight 15, hard).
  static uint AddFilter(Guid key, Guid layer, string sid, ushort permitPort, string name, IntPtr objSd) {
    IntPtr sd; uint sdSize;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:LSD:(A;;CC;;;" + sid + ")", 1, out sd, out sdSize))
      return (uint)Marshal.GetLastWin32Error();
    try {
      IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BLOB))); allocs.Add(blob);
      var b = new BLOB(); b.size = sdSize; b.data = sd; Marshal.StructureToPtr(b, blob, false);
      bool permit = permitPort > 0;
      int n = permit ? 4 : 1;
      int csize = Marshal.SizeOf(typeof(CONDITION));
      IntPtr conds = Marshal.AllocHGlobal(csize * n); allocs.Add(conds);
      var c0 = new CONDITION(); c0.fieldKey = COND_USER; c0.matchType = MATCH_EQUAL; c0.conditionValue.type = FWP_SD; c0.conditionValue.value = blob;
      Marshal.StructureToPtr(c0, conds, false);
      if (permit) {
        var c1 = new CONDITION(); c1.fieldKey = COND_REMOTE_ADDRESS; c1.matchType = MATCH_EQUAL; c1.conditionValue.type = FWP_UINT32; c1.conditionValue.value = (IntPtr)(long)LOOPBACK_V4;
        Marshal.StructureToPtr(c1, IntPtr.Add(conds, csize), false);
        var c2 = new CONDITION(); c2.fieldKey = COND_REMOTE_PORT; c2.matchType = MATCH_EQUAL; c2.conditionValue.type = FWP_UINT16; c2.conditionValue.value = (IntPtr)permitPort;
        Marshal.StructureToPtr(c2, IntPtr.Add(conds, csize * 2), false);
        var c3 = new CONDITION(); c3.fieldKey = COND_PROTOCOL; c3.matchType = MATCH_EQUAL; c3.conditionValue.type = FWP_UINT8; c3.conditionValue.value = (IntPtr)(long)IPPROTO_TCP;
        Marshal.StructureToPtr(c3, IntPtr.Add(conds, csize * 3), false);
      }
      var f = new FILTER(); f.filterKey = key; f.displayData.name = Str(name); f.flags = FILTER_FLAG_PERSISTENT | FILTER_FLAG_CLEAR_ACTION_RIGHT;
      f.providerKey = GuidPtr(PROVIDER_KEY);
      f.layerKey = layer; f.subLayerKey = SUBLAYER_KEY; f.weight.type = FWP_UINT8; f.weight.value = (IntPtr)(permit ? WEIGHT_PERMIT : WEIGHT_BLOCK);
      f.numFilterConditions = (uint)n; f.filterCondition = conds; f.action.type = permit ? ACTION_PERMIT : ACTION_BLOCK;
      ulong id; uint rc = FwpmFilterAdd0(engine, ref f, objSd, out id);
      Log.Add("add " + name + " rc=" + Hex(rc) + " id=" + id);
      return rc;
    } finally { LocalFree(sd); }
  }

  // Idempotent (re)install in ONE transaction: stale objects with our keys are replaced, never duplicated.
  public static uint Install(string sid, ushort brokerPort, string readerSid) {
    if (brokerPort == 0) return 0x80070057;
    IntPtr objSd = ObjectSd(readerSid);
    if (objSd == IntPtr.Zero) return (uint)Marshal.GetLastWin32Error();
    try { return InstallWith(sid, brokerPort, objSd); } finally { LocalFree(objSd); }
  }

  static uint InstallWith(string sid, ushort brokerPort, IntPtr objSd) {
    uint rc = FwpmTransactionBegin0(engine, 0);
    if (rc != 0) return rc;
    rc = DeleteObjects();
    if (rc == 0) {
      var p = new PROVIDER(); p.providerKey = PROVIDER_KEY; p.displayData.name = Str("CompanyOS agent isolation"); p.flags = PROVIDER_FLAG_PERSISTENT;
      rc = FwpmProviderAdd0(engine, ref p, objSd); Log.Add("add provider rc=" + Hex(rc));
    }
    if (rc == 0) {
      var sl = new SUBLAYER(); sl.subLayerKey = SUBLAYER_KEY; sl.displayData.name = Str("CompanyOS agent isolation"); sl.flags = SUBLAYER_FLAG_PERSISTENT;
      sl.providerKey = GuidPtr(PROVIDER_KEY); sl.weight = 0xFFFF;
      rc = FwpmSubLayerAdd0(engine, ref sl, objSd); Log.Add("add sublayer rc=" + Hex(rc));
    }
    if (rc == 0) rc = AddFilter(FILTER_V4_KEY, LAYER_CONNECT_V4, sid, 0, "CompanyOS agent v4: block all", objSd);
    if (rc == 0) rc = AddFilter(PERMIT_V4_KEY, LAYER_CONNECT_V4, sid, brokerPort, "CompanyOS agent broker permit 127.0.0.1:" + brokerPort + " tcp", objSd);
    if (rc == 0) rc = AddFilter(FILTER_V6_KEY, LAYER_CONNECT_V6, sid, 0, "CompanyOS agent v6: block all", objSd);
    if (rc == 0) { rc = FwpmTransactionCommit0(engine); Log.Add("commit rc=" + Hex(rc)); }
    else { FwpmTransactionAbort0(engine); Log.Add("abort after rc=" + Hex(rc)); }
    return rc;
  }

  public static uint Uninstall() {
    uint rc = FwpmTransactionBegin0(engine, 0);
    if (rc != 0) return rc;
    rc = DeleteObjects();
    if (rc == 0) rc = FwpmTransactionCommit0(engine); else FwpmTransactionAbort0(engine);
    return rc;
  }

  static string SddlOf(IntPtr blobPtr) {
    if (blobPtr == IntPtr.Zero) return null;
    var b = (BLOB)Marshal.PtrToStructure(blobPtr, typeof(BLOB));
    IntPtr s; uint len;
    if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(b.data, 1, 0x4 | 0x1, out s, out len)) return null;
    string r = Marshal.PtrToStringUni(s); LocalFree(s); return r;
  }

  // One problem string per deviation; an empty list means the object set is exactly what Install wrote.
  // permitPort == 0: block-all for the user; > 0: the 127.0.0.1:<port>/TCP permit.
  static void CheckFilter(Guid key, Guid layer, string sid, ushort permitPort, string label, List<string> problems) {
    IntPtr p; Guid k = key;
    uint rc = FwpmFilterGetByKey0(engine, ref k, out p);
    if (rc != 0) { problems.Add(label + ":missing(" + Hex(rc) + ")"); return; }
    try {
      bool permit = permitPort > 0;
      var f = (FILTER)Marshal.PtrToStructure(p, typeof(FILTER));
      if (f.layerKey != layer) problems.Add(label + ":layer");
      if (f.subLayerKey != SUBLAYER_KEY) problems.Add(label + ":sublayer");
      if (f.action.type != (permit ? ACTION_PERMIT : ACTION_BLOCK)) problems.Add(label + ":action");
      if ((f.flags & FILTER_FLAG_CLEAR_ACTION_RIGHT) == 0) problems.Add(label + ":notHard");
      if ((f.flags & FILTER_FLAG_PERSISTENT) == 0) problems.Add(label + ":notPersistent");
      if (f.weight.type != FWP_UINT8 || (f.weight.value.ToInt64() & 0xFF) != (permit ? WEIGHT_PERMIT : WEIGHT_BLOCK)) problems.Add(label + ":weight");
      uint want = permit ? 4u : 1u;
      if (f.numFilterConditions != want) { problems.Add(label + ":conditions=" + f.numFilterConditions); return; }
      int csize = Marshal.SizeOf(typeof(CONDITION));
      bool userOk = false, addrOk = !permit, portOk = !permit, protoOk = !permit;
      for (int i = 0; i < f.numFilterConditions; i++) {
        var c = (CONDITION)Marshal.PtrToStructure(IntPtr.Add(f.filterCondition, i * csize), typeof(CONDITION));
        if (c.fieldKey == COND_USER && c.matchType == MATCH_EQUAL && c.conditionValue.type == FWP_SD) {
          string sddl = SddlOf(c.conditionValue.value);
          userOk = sddl != null && sddl.IndexOf(";" + sid + ")", StringComparison.OrdinalIgnoreCase) >= 0;
          if (!userOk) problems.Add(label + ":user=" + (sddl ?? "?"));
        } else if (permit && c.fieldKey == COND_REMOTE_ADDRESS && c.matchType == MATCH_EQUAL && c.conditionValue.type == FWP_UINT32) {
          uint addr = (uint)(c.conditionValue.value.ToInt64() & 0xFFFFFFFF);
          addrOk = addr == LOOPBACK_V4;
          if (!addrOk) problems.Add(label + ":address=0x" + addr.ToString("x"));
        } else if (permit && c.fieldKey == COND_REMOTE_PORT && c.matchType == MATCH_EQUAL && c.conditionValue.type == FWP_UINT16) {
          ushort port = (ushort)(c.conditionValue.value.ToInt64() & 0xFFFF);
          portOk = port == permitPort;
          if (!portOk) problems.Add(label + ":port=" + port);
        } else if (permit && c.fieldKey == COND_PROTOCOL && c.matchType == MATCH_EQUAL && c.conditionValue.type == FWP_UINT8) {
          protoOk = (c.conditionValue.value.ToInt64() & 0xFF) == IPPROTO_TCP;
          if (!protoOk) problems.Add(label + ":protocol");
        } else problems.Add(label + ":unexpectedCondition");
      }
      if (!userOk && !problems.Exists(x => x.StartsWith(label + ":user"))) problems.Add(label + ":userMissing");
      if (!addrOk && !problems.Exists(x => x.StartsWith(label + ":address"))) problems.Add(label + ":addressMissing");
      if (!portOk && !problems.Exists(x => x.StartsWith(label + ":port"))) problems.Add(label + ":portMissing");
      if (!protoOk && !problems.Exists(x => x.StartsWith(label + ":protocol"))) problems.Add(label + ":protocolMissing");
    } finally { FwpmFreeMemory0(ref p); }
  }

  public static string[] Status(string sid, ushort brokerPort) {
    var problems = new List<string>();
    IntPtr p; Guid k;
    k = PROVIDER_KEY; uint rc = FwpmProviderGetByKey0(engine, ref k, out p);
    if (rc != 0) problems.Add("provider:missing(" + Hex(rc) + ")"); else FwpmFreeMemory0(ref p);
    k = SUBLAYER_KEY; rc = FwpmSubLayerGetByKey0(engine, ref k, out p);
    if (rc != 0) problems.Add("sublayer:missing(" + Hex(rc) + ")");
    else {
      var sl = (SUBLAYER)Marshal.PtrToStructure(p, typeof(SUBLAYER));
      if (sl.weight != 0xFFFF) problems.Add("sublayer:weight=" + sl.weight);
      FwpmFreeMemory0(ref p);
    }
    CheckFilter(FILTER_V4_KEY, LAYER_CONNECT_V4, sid, 0, "filterV4", problems);
    CheckFilter(PERMIT_V4_KEY, LAYER_CONNECT_V4, sid, brokerPort, "permitV4", problems);
    CheckFilter(FILTER_V6_KEY, LAYER_CONNECT_V6, sid, 0, "filterV6", problems);
    return problems.ToArray();
  }

  // Test hook for the lifecycle CI job: simulate tampering by removing one filter outside the helper.
  public static uint DeleteV6ForTamperTest() { Guid k = FILTER_V6_KEY; return FwpmFilterDeleteByKey0(engine, ref k); }
}
