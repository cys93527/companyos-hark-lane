/**
 * V1 EFFICIENCY E1-A — derived latency / critical-path trace (READ-ONLY PROJECTION).
 *
 * Reconstructs, from EXISTING durable truth only (runs / tasks /
 * execution_attempts / provider_dispatches / agent_executions / validations /
 * handoffs / events), an observational interval document for one Goal:
 * phase spans, per-attempt timelines (incl. bounded E1-B activity events when
 * present), a wall-clock partition that never double-counts, dependency-path
 * analysis when the pinned graph is readable, and a truthful usage summary.
 *
 * HARD RULES
 *  - DERIVED / NON-AUTHORITATIVE: nothing in execution, settlement, validation
 *    or planning may read this. It writes nothing.
 *  - DETERMINISTIC: identical durable rows ⇒ identical document (ordering by
 *    stable keys; `now` is injected, never sampled).
 *  - HONEST LABELS: a state the evidence cannot distinguish is UNKNOWN.
 *    `lastObservedActivityAt` is activity, NOT progress — no
 *    lastMeaningfulProgressAt exists here because no defensible canonical
 *    meaningful-progress signal exists yet (repeated tool calls are not
 *    progress).
 */

import {
  classifyUsageRecord,
  summarizeGoalUsage,
  type GoalUsageSummary,
  type UsageLedgerEntry,
  type UsageRecord,
} from './usage-coverage.js';

export const LATENCY_TRACE_SCHEMA = 'companyos/latency-trace/1';

/** Observational time-classification labels (closed, evidence-bound). */
export type TraceClassification =
  | 'PLANNING'
  | 'ATTEMPT'
  | 'TOOL_ACTIVITY'
  | 'MODEL_OR_KERNEL_ACTIVITY'
  | 'VALIDATION'
  | 'HANDOFF'
  | 'RETRY_GAP'
  | 'DEPENDENCY_WAIT'
  | 'SUPERVISION'
  | 'UNKNOWN';

/** Evidence strength behind one classification. */
export type TraceConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface TraceInterval {
  readonly classification: TraceClassification;
  readonly start: string;
  readonly end: string;
  readonly durationS: number;
  readonly parent: { readonly kind: 'Goal' | 'Run' | 'Task' | 'ExecutionAttempt'; readonly id: string } | null;
  readonly refs: { readonly runId?: string; readonly taskId?: string; readonly attemptId?: string };
  readonly evidenceBasis: string;
  readonly confidence: TraceConfidence;
}

export interface AttemptTrace {
  readonly attemptId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly number: number;
  readonly state: string;
  readonly failureCode: string | null;
  readonly start: string;
  readonly end: string;
  readonly durationS: number;
  readonly dispatchOutcome: string | null;
  readonly dispatchDurationMs: number | null;
  readonly toolCalls: number;
  /** Last activity of ANY observed kind (tool call or E1-B activity event). ACTIVITY ≠ PROGRESS. */
  readonly lastObservedActivityAt: string | null;
  /** Seconds between lastObservedActivityAt and attempt end (null when no activity observed). */
  readonly observedSilenceTailS: number | null;
  readonly activityEventCount: number;
  readonly livenessClassification:
    | 'TOOL_ACTIVE_TO_END'
    | 'ACTIVITY_TO_END'
    | 'SILENT_TAIL'
    | 'NO_OBSERVED_ACTIVITY'
    | 'COMPLETED_UNKNOWN_INTERIOR';
  readonly interior: { readonly classification: TraceClassification; readonly confidence: TraceConfidence; readonly note: string };
}

export interface TaskSpanTrace {
  readonly taskId: string;
  readonly kind: string;
  readonly roleId: string;
  readonly state: string;
  readonly attempts: number;
  readonly start: string | null;
  readonly end: string | null;
  readonly durationS: number | null;
  readonly failedAttemptS: number;
  readonly predecessors: readonly string[];
}

export interface LatencyTraceDocument {
  readonly schemaVersion: typeof LATENCY_TRACE_SCHEMA;
  readonly derivedAt: string;
  readonly observationalOnly: true;
  readonly goal: {
    readonly goalRunId: string;
    readonly executionRunId: string | null;
    readonly wallStart: string;
    readonly wallEnd: string;
    readonly wallS: number;
    readonly finalStates: readonly string[];
  };
  readonly partition: {
    readonly buckets: readonly { readonly classification: TraceClassification; readonly durationS: number; readonly pctOfWall: number }[];
    readonly accountedS: number;
    readonly unaccountedS: number;
    readonly disjointAttested: boolean;
  };
  readonly attempts: readonly AttemptTrace[];
  readonly taskSpans: readonly TaskSpanTrace[];
  readonly intervals: readonly TraceInterval[];
  readonly dependencyPath: {
    readonly taskIds: readonly string[];
    readonly pathDurationS: number | null;
    readonly basis: 'pinned-graph' | 'observed-order';
    readonly note: string;
  } | null;
  readonly usageSummary: GoalUsageSummary;
}

/* ------------------------------------------------------------------ reader */

/**
 * Narrow READ-ONLY port over durable truth. Implementations must not write;
 * the SQLite adapter below opens nothing itself (the caller's handle is used
 * with SELECT-only statements).
 */
export interface LatencyTraceReader {
  runs(): readonly {id: string; state: string; created_at: string; updated_at: string}[];
  tasks(): readonly {id: string; run_id: string; stage_id: string; role_id: string; kind: string; state: string; created_at: string; updated_at: string}[];
  attempts(): readonly {id: string; task_id: string; run_id: string; attempt_number: number; state: string; created_at: string; settled_at: string; failure_code: string | null}[];
  dispatches(): readonly {attempt_id: string; state: string; created_at: string; updated_at: string; result_summary: string | null}[];
  agentExecutions(): readonly {execution_id: string; agent_id: string; role_id: string; task_id: string | null; run_id: string; status: string; input_usage: string | null; output_usage: string | null}[];
  validations(): readonly {validation_id: string; run_id: string; task_id: string | null; validator_id: string; status: string; started_at: string; finished_at: string}[];
  handoffs(): readonly {handoff_id: string; run_id: string; task_id: string | null; status: string; created_at: string; updated_at: string}[];
  /** Observation events for attempt interiors, ascending by rowid (stable). */
  attemptEvents(): readonly {type: string; occurred_at: string; aggregate_id: string; payload: string}[];
  /** Pinned graph edges for the execution run (stage-id pairs) when readable. */
  graphEdges(runId: string): readonly {from: string; to: string}[];
}

export const createSqliteLatencyTraceReader = (db: {
  prepare(sql: string): {all(...params: unknown[]): unknown[]};
}): LatencyTraceReader => ({
  runs: () => db.prepare('SELECT id, state, created_at, updated_at FROM runs ORDER BY created_at, id').all() as never,
  tasks: () => db.prepare('SELECT id, run_id, stage_id, role_id, kind, state, created_at, updated_at FROM tasks ORDER BY created_at, id').all() as never,
  attempts: () => db.prepare('SELECT id, task_id, run_id, attempt_number, state, created_at, settled_at, failure_code FROM execution_attempts ORDER BY created_at, id').all() as never,
  dispatches: () => db.prepare('SELECT attempt_id, state, created_at, updated_at, result_summary FROM provider_dispatches ORDER BY created_at, dispatch_id').all() as never,
  agentExecutions: () => db.prepare('SELECT execution_id, agent_id, role_id, task_id, run_id, status, input_usage, output_usage FROM agent_executions ORDER BY created_at, execution_id').all() as never,
  validations: () => db.prepare('SELECT validation_id, run_id, task_id, validator_id, status, started_at, finished_at FROM validations ORDER BY started_at, validation_id').all() as never,
  handoffs: () => db.prepare('SELECT handoff_id, workflow_run_id AS run_id, task_id, status, created_at, updated_at FROM handoffs ORDER BY created_at, handoff_id').all() as never,
  attemptEvents: () => db.prepare("SELECT type, occurred_at, aggregate_id, payload FROM events WHERE type IN ('executor.tool_invocation_requested', 'executor.attempt_activity', 'executor.dispatch_requested', 'executor.dispatch_settled') ORDER BY rowid").all() as never,
  graphEdges: (runId) => {
    const rows = db.prepare(
      'SELECT v.graph_json AS graph_json FROM runs r JOIN workflow_template_versions v ON v.id = r.version_id WHERE r.id = ?',
    ).all(runId) as {graph_json: string}[];
    if (rows.length === 0) return [];
    try {
      const graph = JSON.parse(rows[0]!.graph_json) as {edges?: readonly {from?: unknown; to?: unknown}[]};
      return (graph.edges ?? [])
        .filter((edge) => typeof edge.from === 'string' && typeof edge.to === 'string')
        .map((edge) => ({from: String(edge.from), to: String(edge.to)}));
    } catch {
      return [];
    }
  },
});

/* ----------------------------------------------------------------- helpers */

const ts = (iso: string): number => Date.parse(iso);
const durationS = (startIso: string, endIso: string): number => Math.round((ts(endIso) - ts(startIso))) / 1000; // ms precision: fast fixtures must not round to zero
const round1 = (n: number): number => Math.round(n * 1000) / 1000; // ms precision (name kept: one rounding helper)

interface ParsedEvent {
  readonly type: string;
  readonly occurred_at: string;
  readonly aggregate_id: string;
  readonly payload: Record<string, unknown>;
}

const parseEvents = (reader: LatencyTraceReader): readonly ParsedEvent[] =>
  reader.attemptEvents().map((row) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload ?? '{}') as Record<string, unknown>; } catch { payload = {}; }
    return {type: row.type, occurred_at: row.occurred_at, aggregate_id: row.aggregate_id, payload};
  });

const readUsage = (json: string | null): {input: number | null; output: number | null; total: number | null} => {
  try {
    const usage = JSON.parse(json ?? 'null') as {inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown} | null;
    if (usage === null || typeof usage !== 'object') return {input: null, output: null, total: null};
    return {
      input: typeof usage.inputTokens === 'number' ? usage.inputTokens : null,
      output: typeof usage.outputTokens === 'number' ? usage.outputTokens : null,
      total: typeof usage.totalTokens === 'number' ? usage.totalTokens : null,
    };
  } catch {
    return {input: null, output: null, total: null};
  }
};

/** Seat vocabulary derivable from existing agent ids (control-plane turns). */
const seatOfAgent = (agentId: string): string => {
  if (agentId === 'agent.planner') return 'planner';
  if (agentId === 'supervisor-runtime') return 'supervisor';
  if (agentId === 'agent.review') return 'reviewer';
  if (agentId.startsWith('agent.')) return agentId.slice('agent.'.length);
  return agentId;
};

/* ----------------------------------------------------------------- builder */

export interface BuildLatencyTraceInput {
  readonly goalRunId: string;
  readonly now: string;
}

export const buildLatencyTrace = (
  reader: LatencyTraceReader,
  input: BuildLatencyTraceInput,
): LatencyTraceDocument => {
  const runs = reader.runs();
  const goalRun = runs.find((run) => run.id === input.goalRunId) ?? null;
  if (goalRun === null) throw new Error(`goal run ${input.goalRunId} not found`);

  const allTasks = reader.tasks();
  const planningTask = allTasks.find((task) => task.run_id === input.goalRunId && task.kind === 'companyos:planning') ?? null;
  const execRunId = (() => {
    const withWork = allTasks.filter((task) => task.kind !== 'companyos:planning');
    if (withWork.length > 0) return withWork[0]!.run_id;
    return planningTask === null ? null : (runs.find((run) => run.id !== input.goalRunId) ?? null)?.id ?? null;
  })();

  const wallStart = goalRun.created_at;
  const wallEnd = goalRun.updated_at;
  const wallS = durationS(wallStart, wallEnd);
  const events = parseEvents(reader);
  const intervals: TraceInterval[] = [];

  /* ---- planning (MEDIUM: planning task window; planner agent_execution row present) ---- */
  for (const exec of reader.agentExecutions().filter((x) => x.agent_id === 'agent.planner' && x.run_id === input.goalRunId)) {
    // per-turn start/end are not selected in the reader port; the planning TASK window bounds the turn
    const task = allTasks.find((x) => x.id === exec.task_id) ?? null;
    const start = task === null ? wallStart : task.created_at;
    const end = task === null ? wallStart : task.updated_at;
    intervals.push({
      classification: 'PLANNING', start, end, durationS: durationS(start, end),
      parent: {kind: 'Task', id: exec.task_id ?? input.goalRunId}, refs: {runId: input.goalRunId, taskId: exec.task_id ?? undefined},
      evidenceBasis: 'planning task window (agent_execution row present)', confidence: 'MEDIUM',
    });
  }

  /* ---- attempts + interiors ---- */
  const attempts = reader.attempts().filter((attempt) => execRunId === null ? false : attempt.run_id === execRunId);
  const dispatchesByAttempt = new Map<string, {state: string; created_at: string; updated_at: string; result_summary: string | null}>();
  for (const dispatch of reader.dispatches()) dispatchesByAttempt.set(dispatch.attempt_id, dispatch);
  const settledByAttempt = new Map<string, {outcome: unknown; durationMs: unknown}>();
  for (const event of events) {
    if (event.type !== 'executor.dispatch_settled') continue;
    const attemptId = typeof event.payload.attemptId === 'string' ? event.payload.attemptId : null;
    if (attemptId !== null) settledByAttempt.set(attemptId, {outcome: event.payload.outcome ?? null, durationMs: event.payload.durationMs ?? null});
  }
  const toolEventsByAttempt = new Map<string, ParsedEvent[]>();
  const activityEventsByAttempt = new Map<string, ParsedEvent[]>();
  for (const event of events) {
    const attemptId = typeof event.payload.attemptId === 'string' ? event.payload.attemptId : event.aggregate_id;
    if (event.type === 'executor.tool_invocation_requested') {
      const list = toolEventsByAttempt.get(attemptId) ?? [];
      list.push(event);
      toolEventsByAttempt.set(attemptId, list);
    }
    if (event.type === 'executor.attempt_activity') {
      const list = activityEventsByAttempt.get(attemptId) ?? [];
      list.push(event);
      activityEventsByAttempt.set(attemptId, list);
    }
  }

  const attemptTraces: AttemptTrace[] = attempts.map((attempt) => {
    const tools = toolEventsByAttempt.get(attempt.id) ?? [];
    const activities = activityEventsByAttempt.get(attempt.id) ?? [];
    const lastActivityTs = [
      ...tools.map((event) => ts(event.occurred_at)),
      ...activities.map((event) => ts(event.occurred_at)),
    ];
    const lastActivityAt = lastActivityTs.length === 0 ? null : new Date(Math.max(...lastActivityTs)).toISOString();
    const silenceTail = lastActivityAt === null ? null : durationS(lastActivityAt, attempt.settled_at);
    const dispatch = dispatchesByAttempt.get(attempt.id) ?? null;
    const settled = settledByAttempt.get(attempt.id) ?? null;
    const dispatchDurationMs = typeof settled?.durationMs === 'number' ? settled.durationMs : null;
    const dispatchOutcome = typeof settled?.outcome === 'string' ? settled.outcome : dispatch === null ? null : dispatch.state;

    let liveness: AttemptTrace['livenessClassification'];
    let interior: AttemptTrace['interior'];
    if (tools.length > 0 && silenceTail !== null && silenceTail <= 90) {
      liveness = 'TOOL_ACTIVE_TO_END';
      interior = {classification: 'TOOL_ACTIVITY', confidence: 'MEDIUM', note: 'tool calls observed up to ~90s of settle; interior model turns are NOT decomposable from current evidence'};
    } else if (activities.length > 0 && silenceTail !== null && silenceTail <= 90) {
      liveness = 'ACTIVITY_TO_END';
      interior = {classification: 'MODEL_OR_KERNEL_ACTIVITY', confidence: 'LOW', note: 'kernel-observed activity (E1-B events) to end; model-internal activity is not observable'};
    } else if (lastActivityAt !== null) {
      liveness = 'SILENT_TAIL';
      interior = {classification: 'UNKNOWN', confidence: 'LOW', note: `no observed activity for ${String(silenceTail)}s before settle; cause (provider wait vs kernel silence vs model stall) is NOT distinguishable from current evidence`};
    } else if (attempt.state === 'COMPLETED') {
      liveness = 'COMPLETED_UNKNOWN_INTERIOR';
      interior = {classification: 'UNKNOWN', confidence: 'LOW', note: 'no interior events observed for this attempt'};
    } else {
      liveness = 'NO_OBSERVED_ACTIVITY';
      interior = {classification: 'UNKNOWN', confidence: 'LOW', note: 'failed with zero observed interior activity'};
    }

    intervals.push({
      classification: 'ATTEMPT', start: attempt.created_at, end: attempt.settled_at, durationS: durationS(attempt.created_at, attempt.settled_at),
      parent: {kind: 'ExecutionAttempt', id: attempt.id}, refs: {runId: attempt.run_id, attemptId: attempt.id},
      evidenceBasis: 'execution_attempt row (created_at..settled_at)', confidence: 'HIGH',
    });
    return {
      attemptId: attempt.id, taskId: attempt.task_id, runId: attempt.run_id, number: attempt.attempt_number,
      state: attempt.state, failureCode: attempt.failure_code,
      start: attempt.created_at, end: attempt.settled_at, durationS: durationS(attempt.created_at, attempt.settled_at),
      dispatchOutcome, dispatchDurationMs,
      toolCalls: tools.length, lastObservedActivityAt: lastActivityAt, observedSilenceTailS: silenceTail,
      activityEventCount: activities.length,
      livenessClassification: liveness, interior,
    };
  });

  /* ---- task spans (observed) + predecessors (pinned graph when readable) ---- */
  const execTasks = allTasks.filter((task) => task.run_id === execRunId && task.kind !== 'companyos:planning');
  const graphEdges = execRunId === null ? [] : reader.graphEdges(execRunId);
  const taskByStage = new Map(execTasks.map((task) => [task.stage_id, task]));
  const predecessorsOf = new Map<string, string[]>();
  for (const task of execTasks) {
    const preds: string[] = [];
    for (const edge of graphEdges) {
      if (edge.to === task.stage_id) {
        const predecessorTask = taskByStage.get(edge.from);
        if (predecessorTask !== undefined) preds.push(predecessorTask.id);
      }
    }
    preds.sort();
    predecessorsOf.set(task.id, preds);
  }
  const taskSpans: TaskSpanTrace[] = execTasks.map((task) => {
    const taskAttempts = attemptTraces.filter((attempt) => attempt.taskId === task.id);
    const start = taskAttempts.length === 0 ? null : taskAttempts[0]!.start;
    const end = taskAttempts.length === 0 ? null : taskAttempts[taskAttempts.length - 1]!.end;
    return {
      taskId: task.id, kind: task.kind, roleId: task.role_id, state: task.state,
      attempts: taskAttempts.length, start, end,
      durationS: start !== null && end !== null ? durationS(start, end) : null,
      failedAttemptS: round1(taskAttempts.filter((attempt) => attempt.state !== 'COMPLETED').reduce((acc, attempt) => acc + attempt.durationS, 0)),
      predecessors: predecessorsOf.get(task.id) ?? [],
    };
  });

  /* ---- validation / handoff intervals ---- */
  for (const validation of reader.validations()) {
    if (validation.run_id !== execRunId && validation.run_id !== input.goalRunId) continue;
    intervals.push({
      classification: 'VALIDATION', start: validation.started_at, end: validation.finished_at, durationS: durationS(validation.started_at, validation.finished_at),
      parent: {kind: 'Run', id: validation.run_id}, refs: {runId: validation.run_id, taskId: validation.task_id ?? undefined},
      evidenceBasis: 'validation row (started_at..finished_at)', confidence: 'HIGH',
    });
  }
  for (const handoff of reader.handoffs()) {
    if (handoff.run_id !== execRunId) continue;
    intervals.push({
      classification: 'HANDOFF', start: handoff.created_at, end: handoff.updated_at, durationS: durationS(handoff.created_at, handoff.updated_at),
      parent: {kind: 'Run', id: handoff.run_id}, refs: {runId: handoff.run_id, taskId: handoff.task_id ?? undefined},
      evidenceBasis: 'handoff row (created_at..updated_at)', confidence: 'MEDIUM',
    });
  }

  /* ---- gaps: retry gaps vs dependency/orchestration wait (attempt-disjoint partition) ---- */
  const sortedAttempts = [...attemptTraces].sort((a, b) => ts(a.start) - ts(b.start) || (a.attemptId < b.attemptId ? -1 : 1));
  let disjoint = true;
  for (let i = 1; i < sortedAttempts.length; i += 1) {
    const previous = sortedAttempts[i - 1]!;
    const current = sortedAttempts[i]!;
    if (ts(current.start) < ts(previous.end)) disjoint = false;
    const isRetry = current.taskId === previous.taskId;
    intervals.push({
      classification: isRetry ? 'RETRY_GAP' : 'DEPENDENCY_WAIT',
      start: previous.end, end: current.start,
      durationS: durationS(previous.end, current.start),
      parent: {kind: 'Run', id: execRunId ?? input.goalRunId},
      refs: {runId: execRunId ?? input.goalRunId, attemptId: current.attemptId},
      evidenceBasis: isRetry ? 'same-task consecutive attempts' : 'consecutive attempts of different tasks (dependency wait and orchestration/supervision are NOT separable at this evidence level)',
      confidence: isRetry ? 'HIGH' : 'LOW',
    });
  }

  /* ---- wall-clock partition (no double counting: attempts are disjoint; overlapping observation intervals are excluded) ---- */
  const bucketOrder: readonly TraceClassification[] = ['PLANNING', 'ATTEMPT', 'VALIDATION', 'HANDOFF', 'RETRY_GAP', 'DEPENDENCY_WAIT', 'UNKNOWN'];
  const attemptTotal = round1(attemptTraces.reduce((acc, attempt) => acc + attempt.durationS, 0));
  const buckets = new Map<TraceClassification, number>();
  for (const interval of intervals) {
    if (interval.classification === 'ATTEMPT') continue; // accounted once below
    buckets.set(interval.classification, round1((buckets.get(interval.classification) ?? 0) + interval.durationS));
  }
  buckets.set('ATTEMPT', attemptTotal);
  // validation/handoff/supervision overlap attempt gaps by construction — to keep the
  // partition disjoint, VALIDATION and HANDOFF are reported but excluded from the
  // accounted sum when they fall inside RETRY_GAP/DEPENDENCY_WAIT spans (they always do here);
  // the accounted sum uses the disjoint spine: planning + attempts + gaps + endpiece.
  const disjointSpine = new Set<TraceClassification>(['PLANNING', 'ATTEMPT', 'RETRY_GAP', 'DEPENDENCY_WAIT']);
  const accountedS = round1([...buckets.entries()].filter(([kind]) => disjointSpine.has(kind)).reduce((acc, [, seconds]) => acc + seconds, 0));
  const leading = sortedAttempts.length === 0 ? wallS : Math.max(0, durationS(wallStart, sortedAttempts[0]!.start));
  const trailing = sortedAttempts.length === 0 ? 0 : Math.max(0, durationS(sortedAttempts[sortedAttempts.length - 1]!.end, wallEnd));
  if (leading > 0) buckets.set('PLANNING', round1((buckets.get('PLANNING') ?? 0) + leading));
  const accountedWithEnds = round1(accountedS + leading + trailing);
  const unaccounted = round1(wallS - accountedWithEnds);
  if (unaccounted > 0 || trailing > 0) {
    buckets.set('UNKNOWN', round1((buckets.get('UNKNOWN') ?? 0) + Math.max(0, unaccounted)));
  }
  const partition = {
    buckets: bucketOrder
      .filter((kind) => (buckets.get(kind) ?? 0) > 0)
      .map((kind) => ({classification: kind, durationS: buckets.get(kind)!, pctOfWall: round1(((buckets.get(kind) ?? 0) / wallS) * 100)})),
    accountedS: accountedWithEnds,
    unaccountedS: Math.max(0, unaccounted),
    disjointAttested: disjoint,
  };

  /* ---- dependency path ---- */
  const chainByObserved = [...taskSpans].filter((span) => span.start !== null).sort((a, b) => ts(a.start!) - ts(b.start!) || (a.taskId < b.taskId ? -1 : 1));
  let dependencyPath: LatencyTraceDocument['dependencyPath'] = null;
  if (chainByObserved.length > 0) {
    const basis: 'pinned-graph' | 'observed-order' = graphEdges.length > 0 ? 'pinned-graph' : 'observed-order';
    // longest path over the pinned DAG when readable; otherwise the observed order is the chain
    const pathDuration = basis === 'observed-order'
      ? round1(durationS(chainByObserved[0]!.start!, chainByObserved[chainByObserved.length - 1]!.end!))
      : round1(longestPathDuration(taskSpans, predecessorsOf));
    dependencyPath = {
      taskIds: chainByObserved.map((span) => span.taskId),
      pathDurationS: pathDuration,
      basis,
      note: basis === 'pinned-graph'
        ? 'longest path over the pinned workflow graph edges (stage ids)'
        : 'pinned graph unreadable; observed task order used — dependency wait and true parallelism are NOT distinguishable',
    };
  }

  /* ---- usage ledger (E1-C) over existing lineage ---- */
  const usageEntries: UsageLedgerEntry[] = [];
  const goalRuns = new Set([input.goalRunId, ...(execRunId === null ? [] : [execRunId])]);
  for (const exec of reader.agentExecutions()) {
    if (!goalRuns.has(exec.run_id)) continue;
    const usage = readUsage(exec.output_usage);
    const supplied: UsageRecord = {provenance: 'provider-reported', inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.total};
    const state = classifyUsageRecord(supplied);
    usageEntries.push({
      goalRunId: input.goalRunId, runId: exec.run_id, taskId: exec.task_id, roleId: exec.role_id,
      attemptId: null, seat: seatOfAgent(exec.agent_id), providerId: null, modelId: null,
      state,
      record: state === 'UNKNOWN' ? null : supplied,
    });
  }
  // work dispatches: a dispatch whose attempt has no usage-bearing agent_execution is UNKNOWN
  for (const dispatch of reader.dispatches()) {
    if (execRunId === null || dispatch.attempt_id === '' || !dispatch.attempt_id.startsWith('exa_')) continue;
    const attempt = attempts.find((x) => x.id === dispatch.attempt_id);
    if (attempt === undefined || attempt.run_id !== execRunId) continue;
    const covered = usageEntries.some((entry) => entry.attemptId === dispatch.attempt_id);
    if (covered) continue;
    usageEntries.push({
      goalRunId: input.goalRunId, runId: execRunId, taskId: attempt.task_id, roleId: null,
      attemptId: dispatch.attempt_id, seat: 'work', providerId: null, modelId: null,
      state: 'UNKNOWN', record: null,
    });
  }

  intervals.sort((a, b) => ts(a.start) - ts(b.start) || (a.classification < b.classification ? -1 : 1));

  return {
    schemaVersion: LATENCY_TRACE_SCHEMA,
    derivedAt: input.now,
    observationalOnly: true,
    goal: {
      goalRunId: input.goalRunId, executionRunId: execRunId,
      wallStart, wallEnd, wallS, finalStates: runs.filter((run) => goalRuns.has(run.id)).map((run) => run.state).sort(),
    },
    partition,
    attempts: attemptTraces,
    taskSpans,
    intervals,
    dependencyPath,
    usageSummary: summarizeGoalUsage(input.goalRunId, usageEntries),
  };
};

/** Longest path (by span duration) over the DAG; deterministic tie-break by task id. */
const longestPathDuration = (
  spans: readonly TaskSpanTrace[],
  predecessorsOf: Map<string, readonly string[]>,
): number => {
  const memo = new Map<string, number>();
  const spanOf = new Map(spans.map((span) => [span.taskId, span]));
  const depth = (taskId: string): number => {
    if (memo.has(taskId)) return memo.get(taskId)!;
    memo.set(taskId, 0);
    const span = spanOf.get(taskId);
    const own = span?.durationS ?? 0;
    const preds = predecessorsOf.get(taskId) ?? [];
    const best = preds.length === 0 ? 0 : Math.max(...preds.map((pred) => depth(pred)));
    const value = round1(own + best);
    memo.set(taskId, value);
    return value;
  };
  return round1(Math.max(0, ...spans.map((span) => depth(span.taskId))));
};
