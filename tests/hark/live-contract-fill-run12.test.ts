/**
 * LIVE-CONTRACT-FILL run 12 (hark-live-goal 42577881852): all 7 stages of the resumed project were done,
 * the project's own `npm test` passed in an independent check, yet the goal ended on the corrective cap:
 *   1. `repo.test-check` ran the Python test contract with the machine's ANSI stdio (cp1252 on the runner),
 *      so the tests' Chinese prints raised UnicodeEncodeError and every software stage failed validation;
 *   2. `evidence.grounding-check` failed reports that named .docx archive members (`word/document.xml`,
 *      `_rels/.rels`, `[Content_Types].xml`) as missing workspace files although the source names them;
 *   3. the live-goal step waited for processes the run left behind (`Start-Process -Wait`) for 3 hours.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { runRepoTestContract, UTF8_STDIO_ENV } from '../../apps/desktop/src/repo-test-process.js';
import { classifyPathClaim } from '../../packages/engine/src/validation/evidence-grounding-tool.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) { super(); }
  kill(): boolean { return true; }
}

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'run12-')); dirs.push(d); return d; };

describe('live contract-fill run 12: validator stdio is UTF-8', () => {
  it('the test contract child always gets constant UTF-8 stdio, never the parent values', async () => {
    const saved = { u: process.env.PYTHONUTF8, e: process.env.PYTHONIOENCODING };
    process.env.PYTHONUTF8 = '0';
    process.env.PYTHONIOENCODING = 'cp1252';
    let seenEnv: Record<string, string> | undefined;
    const root = new FakeChild(9);
    const fakeSpawn = ((_cmd: string, _args: readonly string[], opts: { env: Record<string, string> }) => {
      seenEnv = opts.env;
      setTimeout(() => { root.stdout.write('共加载 3 个用例\n'); root.emit('exit', 0, null); }, 5);
      return root;
    }) as never;
    try {
      const result = await runRepoTestContract({ cwd: 'C:\\ws', timeoutMs: 60_000 }, { spawn: fakeSpawn, platform: 'win32', settleGraceMs: 10, killTree: () => undefined });
      expect(result.exitCode).toBe(0);
      expect(result.outputTail).toContain('共加载 3 个用例');
    } finally {
      if (saved.u === undefined) delete process.env.PYTHONUTF8; else process.env.PYTHONUTF8 = saved.u;
      if (saved.e === undefined) delete process.env.PYTHONIOENCODING; else process.env.PYTHONIOENCODING = saved.e;
    }
    expect(UTF8_STDIO_ENV).toEqual({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    expect(seenEnv).toMatchObject({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    expect(seenEnv).not.toHaveProperty('COMPANYOS_MODEL_API_KEY');
  });
});

describe('live contract-fill run 12: names the workspace source mentions are grounded references', () => {
  const workspace = (): { root: string; files: string[]; text: string } => {
    const root = tmp();
    mkdirSync(join(root, 'contractfill'), { recursive: true });
    const src = "PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']\n";
    writeFileSync(join(root, 'contractfill', 'docxexport.py'), src);
    return { root, files: ['contractfill/docxexport.py'], text: src };
  };

  it('archive members named verbatim by the source are grounded', () => {
    const ws = workspace();
    for (const token of ['word/document.xml', '_rels/.rels', '[Content_Types].xml']) {
      expect(classifyPathClaim(token, ws.root, ws.files, ws.text).kind).toBe('grounded');
    }
  });

  it('a name nothing in the workspace mentions stays unsupported', () => {
    const ws = workspace();
    expect(classifyPathClaim('word/styles.xml', ws.root, ws.files, ws.text).kind).toBe('unsupported');
    expect(classifyPathClaim('[Other].xml', ws.root, ws.files, ws.text).kind).toBe('unsupported');
  });

  it('a missing file under an existing workspace directory stays a strict path claim, even when mentioned', () => {
    const ws = workspace();
    const text = `${ws.text}\n# see contractfill/missing.py\n`;
    expect(classifyPathClaim('contractfill/missing.py', ws.root, ws.files, text).kind).toBe('unsupported');
    expect(classifyPathClaim('contractfill/docxexport.py', ws.root, ws.files, text).kind).toBe('grounded');
  });
});

describe('live contract-fill run 12: the live-goal step waits for the driver only', () => {
  it('no Start-Process -Wait on the driver; leftovers are recorded and ended', () => {
    const yml = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'hark-live-goal.yml'), 'utf8');
    const starts = yml.split('\n').filter((l) => l.includes('Start-Process -FilePath "$env:APPDIR\\CompanyOS.exe"'));
    expect(starts.length).toBe(2);
    for (const line of starts) expect(line).not.toMatch(/\s-Wait\b/u);
    expect(yml.match(/\$p\.WaitForExit\(\)/gu)?.length).toBe(2);
    expect(yml.match(/leftover-processes\.txt/gu)?.length).toBe(2);
  });
});
