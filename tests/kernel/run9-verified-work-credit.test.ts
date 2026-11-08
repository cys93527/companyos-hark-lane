/**
 * Live contract-fill run 9 (hark-live-goal 42429421366) — fix 3 end to end through the EMBEDDED
 * provider (kernel gate: the staged kernel copy lives under .dsh-stages, which the offline guard of
 * the parallel suite never spawns). A fixture kernel runs its tests (passing), then keeps working
 * until the attempt deadline kills it: with every criterion proven the attempt is credited as done
 * (files kept); without that proof it stays a resumable timeout. Unit coverage of the decision is in
 * tests/hark/live-contract-fill-run9.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync as mkdirSyncE2E, mkdtempSync as mkdtempE2E, rmSync as rmE2E, writeFileSync as writeE2E } from 'node:fs';
import { tmpdir as tmpdirE2E } from 'node:os';
import { join as joinE2E } from 'node:path';
import { resolveExecutorConfig, type ExecutorExecutionRequest } from '@companyos/engine';
import { createDshProvider, DSH_PROVIDER_KEY } from '../../apps/desktop/src/executor/dsh-executor-provider.js';
import { resolveEmbeddedDshRuntime } from '../../apps/desktop/src/executor/embedded-dsh-runtime.js';
import { writeFixtureExecutionClosure } from './support/fixture-closure.js';

const RUN9_NODE_TEST_OUTPUT = [
  '> contract-fill-core@0.1.0 test',
  '> node --test --test-isolation=none test/engine.test.js test/pdf.test.js',
  '',
  '✔ [docx-import-fields] 识别正文、页眉与表格中的可填字段 (96.4425ms)',
  '✔ [docx-import-fields] 结构化数据匹配字段且不串填甲乙方 (39.5109ms)',
  '✔ [fill-preserves-layout] 填充后保留段落、样式、表格与页面设置 (91.1467ms)',
  '✔ [pdf-export-available] LIBREOFFICE_PATH 可指向安装目录 (11.2097ms)',
  '﹣ [pdf-export-available] 导出 PDF 且中文内容与页面设置正确 (0.2321ms) # 未检测到 LibreOffice',
  'ℹ tests 5', 'ℹ suites 0', 'ℹ pass 4', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0', 'ℹ duration_ms 372.1205',
].join('\r\n');
const WITH_SOFFICE = RUN9_NODE_TEST_OUTPUT.replace('﹣ [pdf-export-available] 导出 PDF 且中文内容与页面设置正确 (0.2321ms) # 未检测到 LibreOffice', '✔ [pdf-export-available] 导出 PDF 且中文内容与页面设置正确 (812ms)')
  .replace('ℹ pass 4', 'ℹ pass 5').replace('ℹ skipped 1', 'ℹ skipped 0');
const criteria = [
  { criterionId: 'docx-import-fields', requirement: '识别字段' },
  { criterionId: 'fill-preserves-layout', requirement: '保留排版' },
  { criterionId: 'pdf-export-available', requirement: '导出 PDF' },
];

const e2eScraps: string[] = [];
afterEach(() => { while (e2eScraps.length > 0) rmE2E(e2eScraps.pop() as string, { recursive: true, force: true }); });

/** A fixture kernel that runs its tests (passing), then keeps working until the deadline kills it. */
const fixtureKernelProvider = (testOutput: string) => {
  const root = mkdtempE2E(joinE2E(tmpdirE2E(), 'companyos-run9-kernel-'));
  e2eScraps.push(root);
  const runtimeDir = joinE2E(root, 'runtime');
  mkdirSyncE2E(joinE2E(runtimeDir, 'apps', 'cli', 'lib'), { recursive: true });
  const lines = [
    { type: 'session', sessionId: 'session-run9-fixture' },
    { type: 'tool_call', callId: 'c1', tool: 'write', input: { file_path: 'src/fill.js' } },
    { type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' },
    { type: 'tool_call', callId: 'c2', tool: 'pwsh', input: { command: 'npm test' } },
    { type: 'tool_result', callId: 'c2', status: 'completed', result: testOutput },
  ];
  writeE2E(joinE2E(runtimeDir, 'apps', 'cli', 'lib', 'bin.js'), [
    `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l);`,
    "require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'fill.js'), 'module.exports = 1;\\n');",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), 'utf8');
  const homeTemplate = joinE2E(root, 'home-template', 'profiles', 'run9');
  mkdirSyncE2E(homeTemplate, { recursive: true });
  writeE2E(joinE2E(homeTemplate, 'package.json'), '{"name":"dsh-profile-run9","private":true,"dependencies":{},"dsh":{"profile":{"bundles":[]}}}', 'utf8');
  const patch = joinE2E(root, 'patch-template.yml');
  writeE2E(patch, '- id: nothing\n  disabled: true\n', 'utf8');
  writeFixtureExecutionClosure(root, {
    kernelId: 'run9-fixture', upstreamRepo: 'fixture', upstreamSha: 'c'.repeat(40), upstreamTag: 'fixture',
    runtimeRoot: runtimeDir, cliEntry: 'apps/cli/lib/bin.js', nodeRange: '*', packageManager: '',
    profileName: 'run9', dshHomeTemplateDir: joinE2E(root, 'home-template'), profilePatchTemplate: patch,
    transport: 'one-shot-ndjson', protocolVersion: 's24-ndjson/1', license: 'fixture', checksums: {}, createdAt: new Date().toISOString(),
  });
  const rt = resolveEmbeddedDshRuntime({ managedRoot: root });
  if (!rt.ok) throw new Error(rt.error.message);
  const cfg = resolveExecutorConfig({ providerKey: DSH_PROVIDER_KEY, schema: { kernelId: { name: 'kernelId', kind: 'string', required: true } }, envNames: {}, composition: { kernelId: 'run9' } });
  if (!cfg.ok) throw new Error(cfg.error.message);
  return createDshProvider({
    nodeExecutable: '', runtimeDir: '', profileName: 'run9', fallbackCwd: null, config: cfg.value,
    timer: (ms, cb) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); },
    embedded: {
      runtime: rt.value,
      detectExternalTools: () => [],
      modelRoute: { providerId: 'p', modelId: 'm', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'COMPANYOS_MODEL_ROUTE_ACCESS', apiKeyValue: 'x', contextWindow: 128_000, maxTokens: 8192 },
    },
  });
};
const e2eRequest = (ws: string, crit: { criterionId: string; requirement: string }[]): ExecutorExecutionRequest => ({
  companyId: 'c', runId: 'r', taskId: 't', attemptId: `att_${Math.random().toString(36).slice(2, 10)}`, attemptNumber: 1,
  roleId: 'rol', taskKind: 'companyos:software-work', work: { objective: '实现合同模板解析核心库', acceptanceCriteria: crit },
  workspace: { cwd: ws, root: ws }, requiredCapabilities: [], dispatchKey: `dsp_${Math.random().toString(36).slice(2, 10)}`,
  taskText: 'x', structured: false, timeoutMs: 5_000,
});

describe('run 9 fix 3 end to end: the embedded provider credits a timed-out attempt with verified work', () => {
  it('a deadline-killed attempt whose tests passed and prove every criterion succeeds with the credit (files kept)', async () => {
    const ws = mkdtempE2E(joinE2E(tmpdirE2E(), 'companyos-run9-ws-'));
    e2eScraps.push(ws);
    const outcome = await fixtureKernelProvider(WITH_SOFFICE).start(e2eRequest(ws, criteria));
    expect(outcome.kind).toBe('succeeded');
    const structured = (outcome as { structured?: Record<string, unknown> }).structured!;
    expect(String(structured['finalText'])).toMatch(/^CompanyOS credited this step's verified work: the attempt ended because its time budget ran out/u);
    expect(String(structured['finalText'])).toContain('fill.js');
    expect(structured['verifiedWorkCredit']).toMatchObject({ endedAs: 'timeout', criteria: ['docx-import-fields', 'fill-preserves-layout', 'pdf-export-available'] });
    expect((outcome as { providerSessionId?: string }).providerSessionId).toBe('session-run9-fixture');
  }, 60_000);

  it('the same attempt without proof of every criterion stays a resumable timeout', async () => {
    const ws = mkdtempE2E(joinE2E(tmpdirE2E(), 'companyos-run9-ws-'));
    e2eScraps.push(ws);
    const outcome = await fixtureKernelProvider(RUN9_NODE_TEST_OUTPUT).start(e2eRequest(ws, criteria));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'timeout' });
  }, 60_000);
});
