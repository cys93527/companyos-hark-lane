import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * AUDIT-S1: the agent's v4 WFP filter blocked "remote port != broker" on ANY host, so the agent reached
 * <any host>:<broker port> (LAN or internet). The v4 filter now blocks everything for the agent (weight 14) and a
 * separate hard PERMIT (weight 15) allows only 127.0.0.1:<broker>/TCP. Status verifies all three filters, so an
 * old two-filter install reads ISOLATION_DEGRADED; the CI lifecycle proves LAN-IP:<broker> is blocked.
 */
const root = join(__dirname, '..', '..');
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf8');
const cs = read('scripts', 'hark', 'isolation', 'wfp-persistent.cs');
const setup = read('scripts', 'hark', 'isolation', 'setup.ps1');
const lifecycle = read('scripts', 'hark', 'isolation', 'lifecycle.ps1');
const child = read('scripts', 'hark', 'isolation', 'probe-child.cjs');

describe('AUDIT-S1 broker hole is loopback-only', () => {
  it('no port-only exception remains; block-all + scoped permit are installed', () => {
    expect(cs).not.toContain('MATCH_NOT_EQUAL; c1');
    expect(cs).not.toContain('block all except broker port');
    expect(cs).toContain('AddFilter(FILTER_V4_KEY, LAYER_CONNECT_V4, sid, 0, "CompanyOS agent v4: block all", objSd)');
    expect(cs).toContain('AddFilter(PERMIT_V4_KEY, LAYER_CONNECT_V4, sid, brokerPort, "CompanyOS agent broker permit 127.0.0.1:" + brokerPort + " tcp", objSd)');
    expect(cs).toContain('COND_REMOTE_ADDRESS = new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045")');
    expect(cs).toContain('COND_PROTOCOL = new Guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7")');
    expect(cs).toContain('LOOPBACK_V4 = 0x7F000001, IPPROTO_TCP = 6, FWP_UINT32 = 3, ACTION_PERMIT = 0x1002');
    expect(cs).toContain('WEIGHT_BLOCK = 14, WEIGHT_PERMIT = 15');
    // the permit's display name must not be counted as a v4 block duplicate by the lifecycle L7 check
    expect('CompanyOS agent broker permit 127.0.0.1:47811 tcp').not.toContain('CompanyOS agent v4');
  });

  it('delete, status and the state file cover the permit', () => {
    expect(cs).toContain('k = PERMIT_V4_KEY; uint e = FwpmFilterDeleteByKey0(engine, ref k);');
    expect(cs).toContain('foreach (var rc in new[] { a, b, e })');
    expect(cs).toContain('CheckFilter(FILTER_V4_KEY, LAYER_CONNECT_V4, sid, 0, "filterV4", problems);');
    expect(cs).toContain('CheckFilter(PERMIT_V4_KEY, LAYER_CONNECT_V4, sid, brokerPort, "permitV4", problems);');
    expect(cs).toContain('if (!addrOk && !problems.Exists(x => x.StartsWith(label + ":address"))) problems.Add(label + ":addressMissing");');
    expect(setup).toContain('permitV4 = [CompanyOSWfp]::PERMIT_V4_KEY.ToString()');
  });

  it('the CI lifecycle proves LAN-IP:<broker> blocked for the agent and reachable for the runner', () => {
    expect(lifecycle).toContain("$brokerPort, '0.0.0.0') -PassThru");
    expect(lifecycle).toContain('brokerLanHost = "$lanIp"');
    expect(lifecycle).toContain("Check 'L3.net.brokerPortOnLan.blocked'");
    expect(lifecycle).toContain("Check 'L3.control.runnerReachesBrokerOnLan' ($ctl -eq 200)");
    expect(lifecycle).toContain('$report.steps.L7_filterCounts.permit -eq 1');
    expect(lifecycle).toContain('$report.checks.Count -lt 47');
    expect(child).toContain('if (spec.brokerLanHost) result.net.brokerLan = await get(http, `http://${spec.brokerLanHost}:${spec.brokerPort}/probe`);');
  });
});
