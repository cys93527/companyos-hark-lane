// H15d acceptance run 5 (hark-live-goal 40359081704): after the run-4 fix for `node:assert/strict`,
// evidence.grounding-check STILL failed all four correct work artifacts, now on `Inventory.removeItem`
// and `Inventory.totalValue` (code member references read as file names) -> corrective rework ->
// AUTONOMY_STALLED with every work check passing. The root defect was the path classifier itself
// ("contains '/' or '.' => workspace path"); classifyPathClaim now separates file names, code
// references, module specifiers, prose slashes and location suffixes. This test replays the four real
// run-5 artifacts against the real acceptance fixture (+ the files the run wrote) and pins the
// classifier's decisions, including that genuinely missing files still fail. The overlay holds the
// files the run had written when validation ran (validations ran after all four tasks, 00:35 CST).
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyPathClaim,
  createEvidenceGroundingPort,
  EVIDENCE_GROUNDING_SPEC,
} from '../../packages/engine/src/validation/evidence-grounding-tool.js';

const repoRoot = join(__dirname, '..', '..');
const fixtures = join(__dirname, 'fixtures', 'h15d-run5');

const runWorkspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'h15d-run5-'));
  cpSync(join(repoRoot, 'scripts', 'hark', 'acceptance-fixture'), root, { recursive: true });
  cpSync(join(fixtures, 'overlay'), root, { recursive: true });
  return root;
};

const verdict = async (root: string, artifact: string): Promise<{ verdict: string; unsupported: string[] }> => {
  const port = createEvidenceGroundingPort(EVIDENCE_GROUNDING_SPEC, {
    workspace: () => ({ canonicalRoot: root }),
    artifactContent: async () => new TextEncoder().encode(artifact),
    clock: { nowIso: () => '2026-10-27T00:00:00.000Z' },
  });
  const r = await port.invoke({
    toolId: EVIDENCE_GROUNDING_SPEC.toolId,
    input: { targetRef: 'artifact:a1', artifactId: 'a1', runId: 'run_1', contentRef: 'sha256:x' },
  } as never);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const out = r.value.output as { verdict: string; unsupported: string[] };
  return { verdict: out.verdict, unsupported: out.unsupported };
};

describe('H15d grounding classifier (acceptance run 5 replay)', () => {
  for (const name of ['da896325', 'fd7fe073', '8a06cfa9', '61226da5']) {
    it(`passes the real run-5 work artifact ${name}`, async () => {
      const artifact = readFileSync(join(fixtures, 'artifacts', `${name}.txt`), 'utf8');
      expect(await verdict(runWorkspace(), artifact)).toEqual({ verdict: 'pass', unsupported: [] });
    });
  }

  it('classifies tokens', () => {
    const root = runWorkspace();
    const text = readFileSync(join(root, 'src', 'inventory.js'), 'utf8');
    const files = ['src/inventory.js', 'test/inventory.test.js', 'docs/DOMAIN.md', 'package.json', 'README.md'];
    const c = (t: string): string => classifyPathClaim(t, root, files, text).kind;
    expect(c('Inventory.removeItem')).toBe('grounded');
    expect(c('Inventory.totalValue()')).toBe('grounded');
    expect(c('node:assert/strict')).toBe('not-a-path');
    expect(c('https://example.com/a.js')).toBe('not-a-path');
    expect(c('R2/R3')).toBe('not-a-path');
    expect(c('and/or')).toBe('not-a-path');
    expect(c('inventory.js')).toBe('grounded'); // basename of src/inventory.js
    expect(c('src/inventory.js:42')).toBe('grounded');
    expect(c('src/inventory.js#L10-L20')).toBe('grounded');
    expect(c('src/')).toBe('grounded');
    expect(c('src/missing.js')).toBe('unsupported');
    expect(c('src/nothing')).toBe('unsupported'); // first segment is a real directory
    expect(c('docs/NOPE.md')).toBe('unsupported');
    expect(c('NOPE.md')).toBe('unsupported');
    expect(c('Inventory.flyAway')).toBe('unsupported'); // a member the workspace never mentions
    expect(c('C:/nowhere/x.js')).toBe('unsupported');
  });

  it('still fails an artifact that cites a missing file', async () => {
    const root = runWorkspace();
    mkdirSync(join(root, 'extra'), { recursive: true });
    writeFileSync(join(root, 'extra', 'x.txt'), 'x\n');
    const r = await verdict(root, 'Changed `src/inventory.js` and `test/ghost.test.js`; see `Inventory.removeItem`.');
    expect(r).toEqual({ verdict: 'fail', unsupported: ['named path not found in workspace: test/ghost.test.js'] });
  });
});
