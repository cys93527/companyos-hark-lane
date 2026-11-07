/**
 * Live contract-fill run 4 (hark-live-goal 42346111946): screenshots were lost because the
 * evidence artifact hit the GitHub artifact storage quota. The newest key screenshots (small
 * JPEGs, each <= 150 KB, at most 3) now ride in the job log like live-goal.json, and the
 * lane's fetch-live.sh rebuilds them byte-exact with `live-summary.mjs --decode-shots`.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CHUNK_PREFIX, decodeShotsFromLog, KEY_SHOT_LIMIT, KEY_SHOT_MAX_BYTES, keyShotsOf, SHOT_PREFIX, summarize, writeDecodedShots,
} from '../../scripts/hark/live-summary.mjs';

const evidence = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hark-shots-'));
  mkdirSync(join(dir, 'screenshots', 'key'), { recursive: true });
  writeFileSync(join(dir, 'live-goal.json'), JSON.stringify({ result: 'INCOMPLETE', spend: { calls: 1, known: 1, unknown: 0, micros: 1 } }));
  const jpg = (name: string, bytes: number) => {
    const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(Math.max(0, bytes - 3))]);
    writeFileSync(join(dir, 'screenshots', 'key', name), body);
    return body;
  };
  const shots = {
    created: jpg('2026-11-07T06-29-10-000Z-03-goal-created.jpg', 40_000),
    huge: jpg('2026-11-07T06-33-00-000Z-90-final.jpg', KEY_SHOT_MAX_BYTES + 1),
    bottom: jpg('2026-11-07T06-33-05-000Z-91-goal-bottom.jpg', 120_000),
    top: jpg('2026-11-07T06-33-09-000Z-92-goal-top.jpg', 90_000),
    approval: jpg('2026-11-07T06-30-00-000Z-approval-card.jpg', 30_000),
  };
  writeFileSync(join(dir, 'screenshots', 'key', 'notes.txt'), 'ignored');
  return { dir, shots };
};

describe('key screenshots in the job log (artifact quota)', () => {
  it('chooses the newest 3 JPEGs within 150 KB; an oversize shot is skipped and named', () => {
    const { dir } = evidence();
    const { chosen, skipped } = keyShotsOf(dir);
    expect(chosen.map((p: string) => p.split(/[\\/]/u).pop())).toEqual([
      '2026-11-07T06-30-00-000Z-approval-card.jpg', '2026-11-07T06-33-05-000Z-91-goal-bottom.jpg', '2026-11-07T06-33-09-000Z-92-goal-top.jpg',
    ]);
    expect(chosen).toHaveLength(KEY_SHOT_LIMIT);
    expect(skipped).toEqual([`2026-11-07T06-33-00-000Z-90-final.jpg (${String(KEY_SHOT_MAX_BYTES + 1)} B)`]);
  });

  it('emits them after the live-goal.json blob and decodes them byte-exact from a timestamped job log', () => {
    const { dir, shots } = evidence();
    const lines: string[] = [];
    const stepSummary = join(dir, 'summary.md');
    summarize(dir, { log: (l: string) => lines.push(l), stepSummary });
    expect(lines.some((l) => l.startsWith(CHUNK_PREFIX))).toBe(true);
    expect(lines.filter((l) => l.startsWith(SHOT_PREFIX)).every((l) => l.length <= 4000 + SHOT_PREFIX.length)).toBe(true);
    // GitHub prefixes every job-log line with an ISO timestamp
    const log = lines.map((l) => `2026-11-07T06:34:00.1234567Z ${l}`).join('\n');
    const decoded = decodeShotsFromLog(log);
    expect([...decoded.keys()]).toEqual([
      '2026-11-07T06-30-00-000Z-approval-card.jpg', '2026-11-07T06-33-05-000Z-91-goal-bottom.jpg', '2026-11-07T06-33-09-000Z-92-goal-top.jpg',
    ]);
    expect(decoded.get('2026-11-07T06-33-09-000Z-92-goal-top.jpg')!.equals(shots.top)).toBe(true);
    expect(decoded.get('2026-11-07T06-33-05-000Z-91-goal-bottom.jpg')!.equals(shots.bottom)).toBe(true);
    expect(decoded.get('2026-11-07T06-30-00-000Z-approval-card.jpg')!.equals(shots.approval)).toBe(true);
    // the step summary never carries the blobs
    expect(readFileSync(stepSummary, 'utf8')).not.toContain(SHOT_PREFIX);
    // the --decode-shots CLI body used by lane/fetch-live.sh writes the files
    const out = join(dir, 'decoded');
    expect(writeDecodedShots(log, out)).toEqual([...decoded.keys()]);
    expect(readdirSync(out).sort()).toEqual([...decoded.keys()].sort());
    expect(readFileSync(join(out, '2026-11-07T06-33-09-000Z-92-goal-top.jpg')).equals(shots.top)).toBe(true);
  });

  it('a torn blob or a hostile name is never written', () => {
    const bad = ['HARK-LIVE-SHOT-GZB64 BEGIN ../../evil.jpg', 'HLS:H4sIAAAAAAAAA0tMTgYAAAD//w==', 'HARK-LIVE-SHOT-GZB64 END ../../evil.jpg',
      'HARK-LIVE-SHOT-GZB64 BEGIN torn.jpg', 'HLS:notgzip', 'HARK-LIVE-SHOT-GZB64 END torn.jpg'].join('\n');
    expect(decodeShotsFromLog(bad).size).toBe(0);
  });

  it('the driver captures CDP-downscaled JPEG key shots bounded to 150 KB for the final views', () => {
    const driver = readFileSync('scripts/hark/live-goal-gui.mjs', 'utf8');
    expect(driver).toMatch(/format: 'jpeg', quality: step\.quality, clip: \{ x: 0, y: 0, width, height, scale: step\.scale \}/u);
    expect(driver).toMatch(/KEY_SHOT_MAX_BYTES = 150_000/u);
    for (const label of ['90-final', '91-goal-bottom', '92-goal-top', '99-error']) expect(driver).toContain(`shot('${label}', { key: true })`);
  });
});
