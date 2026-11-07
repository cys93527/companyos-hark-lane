/**
 * Hark lane (2026-11-07): GitHub Free artifact storage (500 MB) was "hit" and refused uploads.
 * CI must not fail a job whose tests passed because an evidence/installer upload was refused,
 * and the live custom run must not depend on a downloadable installer artifact: it can build
 * the installer inline from the checked-out sha with the SAME steps as hark-installer.yml, and
 * its results stay recoverable from the job log (scripts/hark/live-summary.mjs).
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs operator script, no type declarations
import { summarize } from '../../scripts/hark/live-summary.mjs';

const WF = '.github/workflows';
const read = (f: string) => readFileSync(join(WF, f), 'utf8');

/** Each `uses: actions/upload-artifact` step block (from its `- ` line to the next step). */
function uploadSteps(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/uses: actions\/upload-artifact@/u.test(lines[i]!)) continue;
    let s = i;
    while (s > 0 && !/^\s*- /u.test(lines[s]!)) s -= 1;
    const indent = /^(\s*)- /u.exec(lines[s]!)![1]!;
    let e = s + 1;
    while (e < lines.length && !lines[e]!.startsWith(`${indent}- `) && (lines[e]!.trim() === '' || lines[e]!.startsWith(`${indent} `))) e += 1;
    out.push(lines.slice(s, e).join('\n'));
  }
  return out;
}

describe('artifact storage quota never fails a job whose tests passed', () => {
  const files = readdirSync(WF).filter((f) => f.endsWith('.yml'));
  it('every upload-artifact step is continue-on-error with a short retention', () => {
    let n = 0;
    for (const f of files) {
      for (const step of uploadSteps(read(f))) {
        n += 1;
        expect(step, `${f}: ${step}`).toMatch(/\n\s+continue-on-error: true\n/u);
        const days = Number(/retention-days: (\d+)/u.exec(step)?.[1] ?? 'NaN');
        const installer = /name: hark-installer(-next)?\s*$/mu.test(step);
        expect(days, `${f}: ${step}`).toBe(installer ? 1 : 7);
      }
    }
    expect(n).toBeGreaterThanOrEqual(12);
  });
  it('the test and build steps stay hard gates (no other continue-on-error)', () => {
    for (const f of files) {
      const all = read(f).match(/continue-on-error: true/gu)?.length ?? 0;
      expect(all, f).toBe(uploadSteps(read(f)).length);
    }
  });
});

describe('live custom goal can build its installer inline', () => {
  const installer = read('hark-installer.yml');
  const live = read('hark-live-goal.yml');
  const custom = live.slice(live.indexOf('  live-goal-custom:'));
  const GUARD = "        if: env.HARK_INLINE_INSTALLER == 'true'\n";
  const seg = (a: string, b: string) => installer.slice(installer.indexOf(a), installer.indexOf(b, installer.indexOf(a)));

  it('the inline build is a byte-identical copy of hark-installer.yml build steps (only the guard added)', () => {
    const build = seg('      - uses: pnpm/action-setup@v4\n', '      - name: native.job smoke on the staged app');
    const pack = seg('      - name: Package installer (Inno Setup', '      - name: Package probe-newer');
    expect(build).toMatch(/pnpm run build/u);
    expect(build).toMatch(/Stage app/u);
    expect(pack).toMatch(/OutDir=\$env:GITHUB_WORKSPACE\\hark-installer"/u);
    const stripped = custom.split(GUARD).join('');
    expect(stripped).toContain(build);
    expect(stripped).toContain(pack);
    // every copied step is guarded, so an artifact-based run does not rebuild
    const steps = (build + pack).split('\n').filter((l) => l.startsWith('      - ')).length;
    expect(custom.split(GUARD).length - 1).toBe(steps);
  });

  it('inline is chosen by build_installer or an empty installer_run_id; the artifact path keeps its AUDIT-S12 check', () => {
    expect(live).toMatch(/build_installer:\n(\s+.*\n)*?\s+type: boolean/u);
    expect(live).toMatch(/installer_run_id:\n(\s+.*\n)*?\s+required: false\n\s+default: ''/u);
    expect(custom).toContain("HARK_INLINE_INSTALLER: ${{ (inputs.build_installer || inputs.installer_run_id == '') && 'true' || 'false' }}");
    expect(custom).toMatch(/- name: verify the installer run belongs to this commit \(AUDIT-S12\)\n\s+if: env\.HARK_INLINE_INSTALLER != 'true'/u);
    expect(custom).toMatch(/- uses: actions\/download-artifact@v4\n\s+if: env\.HARK_INLINE_INSTALLER != 'true'/u);
    expect(custom).toMatch(/installer-source\.txt/u);
    // the inline build precedes the install, which reads the same output path
    expect(custom.indexOf('Package installer (Inno Setup')).toBeLessThan(custom.indexOf('Install (per-user, silent)'));
    expect(custom).toMatch(/Get-ChildItem hark-installer\\\*\.exe/u);
  });

  it('the model key is never job-wide in the custom job (the build steps never see it)', () => {
    const jobEnv = custom.slice(custom.indexOf('    env:'), custom.indexOf('    steps:'));
    expect(jobEnv).not.toMatch(/COMPANYOS_MODEL_API_KEY:/u);
    const keyed = custom.match(/COMPANYOS_MODEL_API_KEY: \$\{\{ secrets\.COMPANYOS_MODEL_API_KEY \}\}/gu)?.length ?? 0;
    expect(keyed).toBe(3); // install check, driver, summary redaction
  });

  it('a summary always reaches the job log and step summary before the (optional) upload', () => {
    expect(custom).toMatch(/- name: Summary to the job log[^\n]*\n\s+if: always\(\)/u);
    expect(custom.indexOf('live-summary.mjs')).toBeLessThan(custom.indexOf('upload-artifact'));
  });
});

describe('live-summary.mjs makes the run recoverable from the log', () => {
  it('prints outcome, spend, files, and a decodable live-goal.json; never the key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hark-live-summary-'));
    const key = 'fixture-model-key-not-real-123456';
    const g = { result: 'INCOMPLETE', monitorEnd: 'TERMINAL_FAILED', goalRun: { id: 'run_x', state: 'FAILED' }, spend: { calls: 1, known: 1, unknown: 0, micros: 35854 }, spendCny: 0.035854, budget: { reservations: [{ callId: 'c1', status: 'KNOWN', usage: { costMicros: 35854 } }] }, checks: { goalCompleted: false }, workspaceFiles: ['src/app.ts'], tasks: [{ kind: 'companyos:planning', state: 'FAILED' }] };
    writeFileSync(join(dir, 'live-goal.json'), JSON.stringify(g));
    mkdirSync(join(dir, 'app-logs'));
    writeFileSync(join(dir, 'app-logs', 'desktop.log'), `line1\nleaky ${key}\nlast line\n`);
    const stepSummary = join(dir, 'summary.md');
    const out = (summarize(dir, { key, stepSummary, log: () => {} }) as string[]).join('\n');
    expect(out).not.toContain(key);
    expect(out).toContain('[REDACTED]');
    expect(out).toMatch(/result: INCOMPLETE/u);
    expect(out).toMatch(/spendCny: 0\.035854/u);
    expect(out).toContain('src/app.ts');
    expect(out).toContain('last line');
    const lines = out.split('\n');
    const b = lines.indexOf('HARK-LIVE-GOAL-JSON-GZB64 BEGIN');
    const e = lines.indexOf('HARK-LIVE-GOAL-JSON-GZB64 END');
    expect(b).toBeGreaterThan(-1);
    const b64 = lines.slice(b + 1, e).map((l: string) => l.replace(/^HLG:/u, '')).join('');
    expect(JSON.parse(gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'))).toEqual(g);
    const md = readFileSync(stepSummary, 'utf8');
    expect(md).toMatch(/hark-live-goal summary/u);
    expect(md).not.toContain(key);
    expect(md).not.toMatch(/^HLG:/mu);
  });
});
