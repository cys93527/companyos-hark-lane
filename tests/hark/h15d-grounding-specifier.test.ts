// H15d acceptance run 4 (hark-live-goal 40345609717): evidence.grounding-check failed two correct
// work artifacts because `node:assert/strict` (a Node builtin module specifier) was treated as a
// workspace-relative path -> corrective rework spent the 120-call runaway guard. Scheme-qualified
// specifiers are not workspace paths; real missing paths (incl. drive-letter paths) still fail.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createEvidenceGroundingPort,
  EVIDENCE_GROUNDING_SPEC,
} from '../../packages/engine/src/validation/evidence-grounding-tool.js';

const verdictOf = async (artifact: string): Promise<{ verdict: string; unsupported: string[] }> => {
  const root = mkdtempSync(join(tmpdir(), 'h15d-ground-'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'reorder.test.js'), "const assert = require('node:assert/strict');\n");
  const port = createEvidenceGroundingPort(EVIDENCE_GROUNDING_SPEC, {
    workspace: () => ({ canonicalRoot: root }),
    artifactContent: async () => new TextEncoder().encode(artifact),
    clock: { nowIso: () => '2026-10-26T16:00:00.000Z' },
  });
  const r = await port.invoke({
    toolId: EVIDENCE_GROUNDING_SPEC.toolId,
    input: { targetRef: 'artifact:a1', artifactId: 'a1', runId: 'run_1', contentRef: 'sha256:x' },
  } as never);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const out = r.value.output as { verdict: string; unsupported: string[] };
  return { verdict: out.verdict, unsupported: out.unsupported };
};

describe('H15d evidence grounding: module specifiers are not workspace paths', () => {
  it('passes an artifact citing `node:assert/strict` and an existing file', async () => {
    const r = await verdictOf('Tests in `test/reorder.test.js` use `node:assert/strict` and `node:test`.');
    expect(r).toEqual({ verdict: 'pass', unsupported: [] });
  });
  it('still fails a genuinely missing workspace path', async () => {
    const r = await verdictOf('See `test/missing.test.js` and `node:assert/strict`.');
    expect(r.verdict).toBe('fail');
    expect(r.unsupported).toEqual(['named path not found in workspace: test/missing.test.js']);
  });
  it('still checks drive-letter paths (one-letter scheme)', async () => {
    const r = await verdictOf('Wrote `C:/nowhere/x.js`.');
    expect(r.verdict).toBe('fail');
  });
});
