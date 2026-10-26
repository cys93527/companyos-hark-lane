// H16 probe: Windows Filtering Platform filters scoped to one account SID.
// Run 5 (40334451567) proved Windows Firewall rules never match loopback traffic, so a local proxy or any
// other loopback service stays reachable for the agent account. WFP filters at ALE_AUTH_CONNECT do see
// loopback connects; a hard block in a CompanyOS sublayer of maximum weight closes that path.
using System;
using System.Runtime.InteropServices;

public static class H16Wfp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY { public string name; public string description; }
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
  public struct SESSION { public Guid sessionKey; public DISPLAY displayData; public uint flags; public uint txnWaitTimeoutInMSec; public uint processId; public IntPtr sid; public IntPtr username; public int kernelMode; }

  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineOpen0(string server, uint authn, IntPtr authId, ref SESSION session, out IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine, ref SUBLAYER subLayer, IntPtr sd);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine, ref FILTER filter, IntPtr sd, out ulong id);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint rev, out IntPtr sd, out uint size);

  public static readonly Guid LAYER_CONNECT_V4 = new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82");
  public static readonly Guid LAYER_CONNECT_V6 = new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
  static readonly Guid COND_USER = new Guid("af043a0a-b34d-4f86-979c-c90371af6e66");
  static readonly Guid COND_REMOTE_PORT = new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b");
  const uint FWP_UINT8 = 1, FWP_UINT16 = 2, FWP_SD = 14, MATCH_EQUAL = 0, MATCH_NOT_EQUAL = 10;
  const uint ACTION_BLOCK = 0x1001, FILTER_FLAG_CLEAR_ACTION_RIGHT = 0x8, SESSION_FLAG_DYNAMIC = 0x1, RPC_C_AUTHN_WINNT = 10;

  static IntPtr engine = IntPtr.Zero;
  public static readonly System.Collections.Generic.List<string> Log = new System.Collections.Generic.List<string>();

  // Dynamic session: every object vanishes when the session closes (probe). Production adds the same
  // filters persistently from the elevated setup helper.
  public static uint Open() {
    var s = new SESSION(); s.flags = SESSION_FLAG_DYNAMIC; s.displayData.name = "CompanyOS H16 probe";
    return FwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, IntPtr.Zero, ref s, out engine);
  }
  public static void Close() { if (engine != IntPtr.Zero) { FwpmEngineClose0(engine); engine = IntPtr.Zero; } }

  public static uint AddSubLayer(Guid key) {
    var sl = new SUBLAYER(); sl.subLayerKey = key; sl.displayData.name = "CompanyOS agent isolation"; sl.weight = 0xFFFF;
    return FwpmSubLayerAdd0(engine, ref sl, IntPtr.Zero);
  }

  // Hard block of every connect by the account at the layer, except (V4 only) remote port allowPort when > 0.
  public static uint AddBlock(Guid subLayer, Guid layer, string sid, ushort allowPort, string name) {
    IntPtr sd; uint sdSize;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:LSD:(A;;CC;;;" + sid + ")", 1, out sd, out sdSize))
      return (uint)Marshal.GetLastWin32Error();
    IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(BLOB)));
    var b = new BLOB(); b.size = sdSize; b.data = sd; Marshal.StructureToPtr(b, blob, false);
    int n = allowPort > 0 ? 2 : 1;
    int csize = Marshal.SizeOf(typeof(CONDITION));
    IntPtr conds = Marshal.AllocHGlobal(csize * n);
    var c0 = new CONDITION(); c0.fieldKey = COND_USER; c0.matchType = MATCH_EQUAL; c0.conditionValue.type = FWP_SD; c0.conditionValue.value = blob;
    Marshal.StructureToPtr(c0, conds, false);
    if (n == 2) {
      var c1 = new CONDITION(); c1.fieldKey = COND_REMOTE_PORT; c1.matchType = MATCH_NOT_EQUAL; c1.conditionValue.type = FWP_UINT16; c1.conditionValue.value = (IntPtr)allowPort;
      Marshal.StructureToPtr(c1, IntPtr.Add(conds, csize), false);
    }
    var f = new FILTER(); f.filterKey = Guid.NewGuid(); f.displayData.name = name; f.flags = FILTER_FLAG_CLEAR_ACTION_RIGHT;
    f.layerKey = layer; f.subLayerKey = subLayer; f.weight.type = FWP_UINT8; f.weight.value = (IntPtr)15;
    f.numFilterConditions = (uint)n; f.filterCondition = conds; f.action.type = ACTION_BLOCK;
    ulong id; uint rc = FwpmFilterAdd0(engine, ref f, IntPtr.Zero, out id);
    Log.Add(name + " rc=0x" + rc.ToString("x") + " id=" + id + " filterSize=" + Marshal.SizeOf(typeof(FILTER)) + " condSize=" + csize);
    return rc;
  }
}
