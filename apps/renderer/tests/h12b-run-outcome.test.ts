/**
 * H12b — the renderer never shows a cancelled Goal as 失败 and never relies on a
 * non-existent `CANCELLED` run state.
 */
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { isRunEnded, runStateLabel, terminalOutcomeOf } from '../src/run-outcome.js';
import { PHASE_LABELS, projectRuntimePhase } from '../src/runtime-panel.js';
import { GoalListView, GoalWorkspaceView } from '../src/workspace.js';

describe('H12b run outcome (renderer)', () => {
  it('prefers the main-process terminalOutcome and derives the same rule for older payloads', () => {
    expect(terminalOutcomeOf({ state: 'FAILED', failureReason: 'cancelled', terminalOutcome: 'CANCELLED' })).toBe('CANCELLED');
    expect(terminalOutcomeOf({ state: 'FAILED', failureReason: 'cancelled' })).toBe('CANCELLED');
    expect(terminalOutcomeOf({ state: 'FAILED', failureReason: 'timed_out' })).toBe('TIMED_OUT');
    expect(terminalOutcomeOf({ state: 'FAILED', failureReason: 'execution_failed' })).toBe('FAILED');
    expect(terminalOutcomeOf({ state: 'PLANNING', failureReason: null, terminalOutcome: null })).toBeNull();
    expect(terminalOutcomeOf({ state: 'CANCELLED' })).toBeNull(); // not an L1 state: never "ended"
    expect(isRunEnded({ state: 'COMPLETED' })).toBe(true);
    expect(runStateLabel({ state: 'FAILED', failureReason: 'cancelled' })).toBe('已取消');
    expect(runStateLabel({ state: 'PLANNING' })).toBe('PLANNING');
  });

  it('phase: cancelled / timed-out are their own phases, not failed', () => {
    expect(projectRuntimePhase({ runState: 'FAILED', blockers: [], failureReason: 'cancelled' })).toBe('cancelled');
    expect(projectRuntimePhase({ runState: 'FAILED', blockers: [], terminalOutcome: 'TIMED_OUT' })).toBe('timed-out');
    expect(projectRuntimePhase({ runState: 'FAILED', blockers: [], failureReason: 'execution_failed' })).toBe('failed');
    expect(PHASE_LABELS.cancelled).toBe('已取消');
  });

  it('goal list and workspace render 已取消 for a cancelled Goal, without the failure banner', () => {
    const list = renderToString(h(GoalListView, { goals: [{ runId: 'run_c', state: 'FAILED', terminalOutcome: 'CANCELLED', objective: 'cancelled goal' }], failure: null, onOpen: () => undefined }));
    expect(list).toContain('已取消');
    expect(list).not.toContain('>失败<');
    const ws = renderToString(h(GoalWorkspaceView, {
      goalObjective: 'cancelled goal', planningRunState: 'FAILED', planningRunId: 'run_c',
      overview: { state: 'FAILED', failureReason: 'cancelled', terminalOutcome: 'CANCELLED' },
      blockers: [], executionRuns: [], deliverableArtifacts: [],
    }));
    expect(ws).toContain('已取消');
    expect(ws).not.toContain('该目标已失败');
    expect(ws).not.toContain('失败原因');
  });

  it('a pending cancellation (intent durable, runs not yet settled) is shown', () => {
    const ws = renderToString(h(GoalWorkspaceView, {
      goalObjective: 'g', planningRunState: 'PLANNING', planningRunId: 'run_p',
      overview: { state: 'PLANNING', failureReason: null, terminalOutcome: null },
      blockers: [], executionRuns: [], deliverableArtifacts: [], cancellationRequested: true,
    }));
    expect(ws).toContain('已请求取消');
  });

  it('no renderer source compares a run state with a CANCELLED string', () => {
    for (const file of ['App.tsx', 'chat.tsx', 'runtime-panel.tsx', 'workspace.tsx']) {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/state\s*===\s*'CANCELLED'|\['FAILED',\s*'CANCELLED'\]|'COMPLETED',\s*'FAILED',\s*'CANCELLED'/);
    }
  });
});
