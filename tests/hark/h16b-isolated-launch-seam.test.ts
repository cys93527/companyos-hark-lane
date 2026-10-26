import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';

import { planIsolatedLaunch } from '../../apps/desktop/src/executor/isolation/isolated-launch-seam.js';
import { startModelBroker } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';

/*
 * H16b-3: the kernel launch seam. ISOLATED → launcher + typed argv prefix (child argv verbatim after `--`);
 * NOT_CONFIGURED → unchanged ("未隔离"); DEGRADED or missing launch prerequisites → refused, never unisolated.
 */
const config = {
  launcherPath: 'C:\\Program Files\\CompanyOS\\resources\\isolation\\companyos-isolated-launch.exe',
  credentialPath: 'C:\\Users\\u\\AppData\\Roaming\\CompanyOS\\isolation\\agent-credential.dpapi',
  fileExists: () => true,
};
const isolated = { kind: 'launch-isolated', account: 'companyos-agent', sid: 'S-1-5-21-1-2-3-1001', brokerPort: 47811 } as const;
const base = {
  workspaceRoot: '/ws/goal',
  childExecutable: '/state/.dsh-stages/stage-x/node/node.exe',
  childArgv: ['/state/.dsh-stages/stage-x/cli.js', 'companyos-headless', '--json'],
};

describe('H16b-3 isolated launch seam', () => {
  it('ISOLATED wraps the kernel command in the launcher with the child argv verbatim after --', () => {
    const plan = planIsolatedLaunch({ decision: isolated, config, ...base });
    expect(plan).toEqual({
      kind: 'isolated',
      executable: config.launcherPath,
      argvPrefix: [
        '--account', 'companyos-agent',
        '--credential', config.credentialPath,
        '--cwd', '/ws/goal',
        '--',
        base.childExecutable,
        ...base.childArgv,
      ],
      brokerPort: 47811,
      account: 'companyos-agent',
    });
  });

  it('NOT_CONFIGURED launches unchanged and labelled 未隔离', () => {
    expect(planIsolatedLaunch({ decision: { kind: 'launch-unisolated', label: '未隔离' }, config, ...base }))
      .toEqual({ kind: 'unisolated', label: '未隔离' });
  });

  it('DEGRADED is refused with its problems', () => {
    const plan = planIsolatedLaunch({
      decision: { kind: 'refuse', reasonCode: 'ISOLATION_DEGRADED', problems: ['wfp:v4:missing'] },
      config,
      ...base,
    });
    expect(plan).toEqual({ kind: 'refused', reasonCode: 'ISOLATION_DEGRADED', problems: ['wfp:v4:missing'] });
  });

  it('ISOLATED with a missing launcher or credential fails closed instead of launching unisolated', () => {
    const plan = planIsolatedLaunch({ decision: isolated, config: { ...config, fileExists: () => false }, ...base });
    expect(plan).toEqual({ kind: 'refused', reasonCode: 'ISOLATION_DEGRADED', problems: ['launcher:missing', 'credential:missing'] });
    const relative = planIsolatedLaunch({ decision: isolated, config, ...base, workspaceRoot: 'ws', childExecutable: 'node' });
    expect(relative.kind).toBe('refused');
  });
});

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    server.close(() => resolve(port));
  });
});

describe('H16b-3 broker on the allow-listed port', () => {
  it('listens on 127.0.0.1:<listenPort> exactly', async () => {
    const port = await freePort();
    const broker = await startModelBroker({ upstreamBaseURL: 'http://127.0.0.1:9/v1', bearer: '', listenPort: port });
    expect(broker.ok).toBe(true);
    if (!broker.ok) return;
    try {
      expect(new URL(broker.value.url).port).toBe(String(port));
      expect(new URL(broker.value.url).hostname).toBe('127.0.0.1');
      const status = await new Promise<number>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', () => resolve(-1));
        req.end();
      });
      expect(status).toBeGreaterThan(0);
    } finally {
      broker.value.close();
    }
  });

  it('a busy allow-listed port fails closed (no silent re-bind elsewhere)', async () => {
    const holder = createServer();
    const port = await new Promise<number>((resolve) => holder.listen(0, '127.0.0.1', () => resolve((holder.address() as AddressInfo).port)));
    try {
      const broker = await startModelBroker({ upstreamBaseURL: 'http://127.0.0.1:9/v1', bearer: '', listenPort: port });
      expect(broker.ok).toBe(false);
      if (!broker.ok) expect(broker.error.details['reason']).toBe('EXECUTOR_EMBEDDED_BROKER_LISTEN_FAILED');
      else broker.value.close();
    } finally {
      holder.close();
    }
  });
});

describe('H16b-3 start-time status runner', () => {
  const layout = { resourcesDir: 'C:\\app\\resources\\isolation', userDataDir: 'C:\\Users\\u\\AppData\\Roaming\\CompanyOS' };
  const neverExec = async () => { throw new Error('helper must not run'); };

  it('no state file → NOT_CONFIGURED without starting the helper', async () => {
    const { decideIsolation } = await import('../../apps/desktop/src/executor/isolation/isolation-status-runner.js');
    await expect(decideIsolation({ layout, platform: 'win32', fileExists: () => false, exec: neverExec }))
      .resolves.toEqual({ kind: 'launch-unisolated', label: '未隔离' });
  });

  it('state file on a non-Windows host or without the helper → DEGRADED', async () => {
    const { decideIsolation } = await import('../../apps/desktop/src/executor/isolation/isolation-status-runner.js');
    await expect(decideIsolation({ layout, platform: 'linux', fileExists: () => true, exec: neverExec }))
      .resolves.toMatchObject({ kind: 'refuse', problems: ['host:notWindows'] });
    await expect(decideIsolation({ layout, platform: 'win32', fileExists: (p) => p.endsWith('state.json'), exec: neverExec }))
      .resolves.toMatchObject({ kind: 'refuse', problems: ['helper:missing'] });
  });

  it('runs setup.ps1 -Action status unelevated and maps its report', async () => {
    const { decideIsolation } = await import('../../apps/desktop/src/executor/isolation/isolation-status-runner.js');
    const calls: string[][] = [];
    const ok = await decideIsolation({
      layout, platform: 'win32', fileExists: () => true, powershell: 'powershell.exe',
      exec: async (file, args) => {
        calls.push([file, ...args]);
        return { code: 0, stdout: '{"state":"ISOLATED","account":"companyos-agent","sid":"S-1-5-21-1-2-3-1001","brokerPort":47811,"problems":[]}\r\n' };
      },
    });
    expect(ok).toEqual({ kind: 'launch-isolated', account: 'companyos-agent', sid: 'S-1-5-21-1-2-3-1001', brokerPort: 47811 });
    expect(calls[0]).toContain('-File');
    expect(calls[0]).toContain('status');
    expect(calls[0]?.some((a) => a.endsWith('setup.ps1'))).toBe(true);
    const timedOut = await decideIsolation({ layout, platform: 'win32', fileExists: () => true, exec: async () => ({ code: null, stdout: '' }) });
    expect(timedOut.kind).toBe('refuse');
  });
});
