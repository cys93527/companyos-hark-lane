#!/usr/bin/env node
/** Guard the small set of architecture/status truths that must not drift. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const read = (path) => readFileSync(root(path), 'utf8');

test('Sprint 0-16 are all closed, no sprint is active, and frozen handoff semantics stay explicit', () => {
  const agents = read('AGENTS.md');
  const roadmap = read('docs/EXECUTION_ROADMAP.md');
  const matrix = read('docs/SPRINT12_COVERAGE_MATRIX.md');
  const handoff = read('PROJECT_HANDOFF.md');

  // Current truth (post-Sprint-16 closeout): Sprint 0-16 are CLOSED and NO sprint
  // is active. Sprint 17 (Repository Runtime) is next, pending explicit approval.
  assert.match(agents, /Sprint 0–16 已关闭/);
  assert.match(agents, /Sprint 12 Memory \+ Decision 亦为 \*\*CLOSED\*\*/);
  assert.match(agents, /当前\*\*没有 active sprint\*\*/);
  assert.match(agents, /Sprint 16（DevCompany Pack，tag `sprint-16`）亦为[\s\S]*\*\*CLOSED\*\*/);
  // Regression: a CLOSED sprint must never be (re)declared active.
  assert.doesNotMatch(agents, /当前 active sprint 是/);
  assert.match(agents, /Sprint 11 Structured Handoff 为 \*\*CLOSED\*\*/);
  assert.match(agents, /\*\*Router 主线 CLOSED\*\*/);
  assert.match(agents, /禁止提前进入 Sprint 17\+/);
  // The roadmap tail table must state the same truth.
  assert.match(roadmap, /已关闭范围 \| Sprint 0–16/);
  assert.match(roadmap, /当前 active sprint \| 无（None）/);
  assert.doesNotMatch(roadmap, /当前 active sprint \| Sprint \d/);
  // Frozen semantics stay explicit.
  assert.match(roadmap, /Sprint 11（CLOSED，tag `sprint-11\.0\.0`）/);
  assert.match(roadmap, /Handoff ACCEPTED 只表示目标角色正式接收结构化交接/);
  for (const phrase of ['select next role', 'select model', 'invoke Router', 'start Agent', 'advance Workflow', 'continue Stage']) {
    assert.match(roadmap, new RegExp(`- ${phrase}`));
  }
  assert.match(matrix, /\| Y–AD \|[\s\S]*\| PASS/);
  assert.match(handoff, /Sprint 12/);
});
