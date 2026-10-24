/**
 * F1 closure (release-blocker re-audit) + F5-A (exact identity) — the DURABLE
 * illegal-proposal budget (pure rule).
 *
 * The budget that bounds consecutive illegal supervisor proposals must be canonical (derived
 * from durable rows) so it survives restarts and CANNOT reset between autonomy calls. The
 * standalone rule: a supervisor turn that ended in an illegal proposal left a FAILED
 * AgentExecution (INVALID_OUTPUT) of the supervisor identity; a legal turn's execution either
 * COMPLETED or is proven decision-bearing BY EXACT IDENTITY (the Decision payload carries its
 * own executionId). The budget is the TRAILING run of such failures — a legal turn resets it.
 *
 * F5-A: a Decision's TRACE proves nothing — one autonomy call shares ONE traceId across ALL
 * of its turns — so a different turn's Decision must never reset this budget, and a FAILED
 * row never becomes legal because another execution sharing its traceId had one.
 */
import { describe, expect, it } from 'vitest';

import type { AgentExecution } from '@companyos/core';
import { MAX_CONSECUTIVE_INVALID_TURNS, consecutiveIllegalProposalCount } from '@companyos/engine';

const RUN = 'run_budget';
const AGENT = 'supervisor-runtime';

const execution = (
  input: Partial<AgentExecution> & { readonly createdAt: string; readonly traceId: string },
): AgentExecution =>
  ({
    executionId: input.executionId ?? `exec_${input.traceId}`,
    agentId: input.agentId ?? AGENT,
    roleId: AGENT,
    taskId: 'tsk_1',
    runId: input.runId ?? RUN,
    status: input.status ?? 'FAILED',
    errorKind: input.errorKind ?? 'INVALID_OUTPUT',
    traceId: input.traceId,
    createdAt: input.createdAt,
    ...{},
  }) as unknown as AgentExecution;

describe('F1+F5-A — durable consecutive-illegal-proposal budget (pure rule, exact identity)', () => {
  it('counts the TRAILING run of illegal failures and is bounded by the frozen N', () => {
    const rows = [
      execution({ createdAt: '2026-10-06T00:00:01.000Z', traceId: 'trace_a' }),
      execution({ createdAt: '2026-10-06T00:00:02.000Z', traceId: 'trace_b' }),
      execution({ createdAt: '2026-10-06T00:00:03.000Z', traceId: 'trace_c' }),
    ];
    expect(
      consecutiveIllegalProposalCount({
        executions: rows,
        decisionExecutionIds: [],
        runId: RUN,
        supervisorAgentId: AGENT,
      }),
    ).toBe(MAX_CONSECUTIVE_INVALID_TURNS);
  });

  it('a LEGAL turn durably RESETS the budget (its execution completed or its OWN Decision exists)', () => {
    const rows = [
      execution({ createdAt: '2026-10-06T00:00:01.000Z', traceId: 'trace_a' }),
      execution({ createdAt: '2026-10-06T00:00:02.000Z', traceId: 'trace_b' }),
      execution({
        createdAt: '2026-10-06T00:00:03.000Z',
        traceId: 'trace_legal',
        status: 'COMPLETED',
        errorKind: null,
      }),
      execution({ createdAt: '2026-10-06T00:00:04.000Z', traceId: 'trace_c' }),
    ];
    expect(
      consecutiveIllegalProposalCount({
        executions: rows,
        decisionExecutionIds: ['exec_trace_legal'],
        runId: RUN,
        supervisorAgentId: AGENT,
      }),
    ).toBe(1);
    // A crash between the Decision commit and the execution completion must ALSO reset: the
    // Decision payload's OWN executionId proves the turn was legal even while the row is
    // unsettled (the frozen Task-18-08 window).
    expect(
      consecutiveIllegalProposalCount({
        executions: [
          rows[0]!,
          rows[1]!,
          execution({
            createdAt: '2026-10-06T00:00:03.000Z',
            traceId: 'trace_legal',
            status: 'INTERRUPTED',
            errorKind: null,
            executionId: 'exec_window',
          }),
          rows[3]!,
        ],
        decisionExecutionIds: ['exec_window'],
        runId: RUN,
        supervisorAgentId: AGENT,
      }),
    ).toBe(1);
  });

  it('F5-A: a SHARED traceId resets NOTHING — only the exact execution identity is legality', () => {
    // The under-count shape: a refused turn whose trace equals an earlier legal decision's
    // trace must still COUNT (the walk stops only at an exact-identity legal row).
    expect(
      consecutiveIllegalProposalCount({
        executions: [
          execution({ createdAt: '2026-10-06T00:00:01.000Z', traceId: 'trace_a' }),
          execution({ createdAt: '2026-10-06T00:00:02.000Z', traceId: 'trace_b' }),
          execution({
            createdAt: '2026-10-06T00:00:03.000Z',
            traceId: 'trace_legal',
            status: 'COMPLETED',
            errorKind: null,
            executionId: 'exec_decided',
          }),
          execution({ createdAt: '2026-10-06T00:00:04.000Z', traceId: 'trace_legal', executionId: 'exec_refused' }),
          execution({ createdAt: '2026-10-06T00:00:05.000Z', traceId: 'trace_c' }),
        ],
        // The Decision belongs to the COMPLETED turn (exec_decided), NOT to exec_refused,
        // even though both carry trace_legal.
        decisionExecutionIds: ['exec_decided'],
        runId: RUN,
        supervisorAgentId: AGENT,
      }),
    ).toBe(2);
    // The mirrored shape: the trace_shared Decision belongs to an OLDER turn — the newer
    // INTERRUPTED row shares the trace but its OWN identity is not decision-bearing, so the
    // walk must NOT stop there (the trace-era rule did: it reset the budget to 0) and the
    // trailing refusal still counts.
    expect(
      consecutiveIllegalProposalCount({
        executions: [
          execution({ createdAt: '2026-10-06T00:00:01.000Z', traceId: 'trace_shared' }),
          execution({
            createdAt: '2026-10-06T00:00:02.000Z',
            traceId: 'trace_shared',
            status: 'INTERRUPTED',
            errorKind: null,
            executionId: 'exec_newer_round',
          }),
        ],
        decisionExecutionIds: ['exec_from_an_older_turn'],
        runId: RUN,
        supervisorAgentId: AGENT,
      }),
    ).toBe(1);
  });

  it('counts only the supervisor identity, only INVALID_OUTPUT failures, and only this run', () => {
    const rows = [
      // Another agent's failure never counts (a pinned unit's invalid output is not an
      // illegal supervisor proposal).
      execution({ createdAt: '2026-10-06T00:00:01.000Z', traceId: 'trace_pinned', agentId: 'review-round' }),
      // A provider failure (not the model's proposal) neither counts NOR resets.
      execution({ createdAt: '2026-10-06T00:00:02.000Z', traceId: 'trace_lost', errorKind: 'PROVIDER_UNAVAILABLE' }),
      execution({ createdAt: '2026-10-06T00:00:03.000Z', traceId: 'trace_b' }),
      // Another run's rows are never mixed in.
      execution({ createdAt: '2026-10-06T00:00:04.000Z', traceId: 'trace_other', runId: 'run_other' }),
    ];
    expect(
      consecutiveIllegalProposalCount({
        executions: rows,
        decisionExecutionIds: [],
        runId: RUN,
        supervisorAgentId: AGENT,
      }),
    ).toBe(1);
  });

  it('an empty history is zero (no illegal proposals yet)', () => {
    expect(
      consecutiveIllegalProposalCount({
        executions: [],
        decisionExecutionIds: [],
        runId: RUN,
        supervisorAgentId: AGENT,
      }),
    ).toBe(0);
  });
});
