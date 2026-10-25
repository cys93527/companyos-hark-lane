/**
 * DESKTOP STAGE 1 — the Goal Workspace: the Product Control Plane UI.
 *
 * The renderer is UNTRUSTED: every read and every mutation crosses the ONE typed
 * control-plane bridge (`controlPlaneRequest`) plus the three narrow workspace
 * channels (`workspaceSelect` / `workspaceOpen` / `workspaceCurrent`); nothing here
 * opens SQLite, imports persistence, calls a provider or holds domain truth.
 *
 * Stage-1 status truth: EVERY rendered status is a projection of canonical durable
 * data (run state, run.overview progress/validation/attempts, home.summary). There
 * is NO fake percentage, NO "time remaining", and activity is never rendered as
 * progress. Live state is re-read through BOUNDED polling (renderer-lifecycle-bound,
 * read-only) plus the explicit refresh button — the poll is not workflow authority
 * and a lost tick is recovered by the next one.
 *
 * Components are split PURE VIEW (exported, takes canonical projections as props,
 * deterministically testable via react-dom/server) + thin CONTAINER (fetches through
 * the canonical loaders). The pure loaders are exported too, so tests can assert the
 * canonical reads directly.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isRunEnded, runStateLabel, runStateModifier, terminalOutcomeOf, type RunEndInput } from './run-outcome.js';

/* ------------------------------------------------------------- the bridge --- */

export interface ControlPlaneBridgeRequest {
  readonly operation: string;
  readonly payload?: unknown;
}

export interface ControlPlaneBridge {
  controlPlaneRequest(request: ControlPlaneBridgeRequest): Promise<unknown>;
}

/** STAGE 1 workspace-selection surface (native chooser + trusted open + current). */
export interface WorkspaceSelectionBridge {
  workspaceSelect(): Promise<string | null>;
  workspaceOpen(root: string): Promise<{ readonly ok: boolean; readonly root: string; readonly error?: string }>;
  workspaceCurrent(): Promise<string | null>;
  /** Canonical single-workspace change: trusted close→open, fail-closed (typed refusal). */
  workspaceSwitch(root: string): Promise<{ readonly ok: boolean; readonly root: string; readonly error?: string }>;
}

export interface ControlPlaneEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
}

/** Typed read: a failed call surfaces the TYPED error, never a silent collapse. */
export async function controlPlaneRead<T>(
  bridge: ControlPlaneBridge,
  operation: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<ControlPlaneEnvelope<T>> {
  return (await bridge.controlPlaneRequest({ operation, payload })) as ControlPlaneEnvelope<T>;
}

/* --------------------------------------------------- pure canonical loaders --- */

/** Load the durable recent-goal projection (home.summary). Sorting happens in the view. */
export const loadHomeSummary = async (
  bridge: ControlPlaneBridge,
  companyId: string,
): Promise<ControlPlaneEnvelope<{ readonly goals: readonly GoalSummary[] }>> =>
  controlPlaneRead(bridge, 'home.summary', { companyId });

/** Load ONE goal's workspace projection (goal + planning run + overview + blockers + execution runs). */
export const loadGoalWorkspace = async (
  bridge: ControlPlaneBridge,
  companyId: string,
  runId: string,
): Promise<ControlPlaneEnvelope<WorkspaceView>> =>
  controlPlaneRead(bridge, 'goal.workspace', { companyId, runId });

/** Load the canonical deliverable artifact references for a run (run.artifacts). */
export const loadRunArtifacts = async (
  bridge: ControlPlaneBridge,
  companyId: string,
  runId: string,
): Promise<ControlPlaneEnvelope<{ readonly artifacts: readonly { artifactId: string; kind: string }[] }>> =>
  controlPlaneRead(bridge, 'run.artifacts', { companyId, runId });

/** Bounded Stage-1 poll interval (ms). Read-only; renderer-lifecycle-bound. */
export const GOAL_POLL_INTERVAL_MS = 4_000;

/* ------------------------------------------------------------------ types --- */

export interface GoalSummary {
  readonly runId: string;
  readonly state: string;
  /** H12b: typed terminal outcome from home.summary (absent on older payloads). */
  readonly terminalOutcome?: string | null;
  readonly objective: string | null;
  readonly createdAt?: string;
}

export interface WorkspaceView {
  readonly runId: string;
  readonly goal: { readonly objective: string } | null;
  readonly planningRun: { readonly state: string; readonly revision: number; readonly terminalOutcome?: string | null };
  /** H12b: a durable Goal cancellation intent exists (visible before the runs settle). */
  readonly cancellationRequested?: boolean;
  readonly overview: unknown;
  readonly blockers: readonly unknown[];
  readonly executionRuns: readonly { readonly runId: string; readonly state: string }[];
}

export interface AttemptSummaryView {
  readonly active?: number;
  readonly interrupted?: number;
  readonly completed?: number;
  readonly failed?: number;
}

export interface ValidationSummaryView {
  readonly requiredValidatorIds?: readonly string[];
  readonly completed?: readonly { readonly validatorId: string; readonly status: string }[];
  readonly failed?: boolean;
  readonly missing?: readonly string[];
}

export interface RunOverviewView {
  readonly runId?: string;
  readonly state?: string;
  readonly failureReason?: string | null;
  readonly terminalOutcome?: string | null;
  readonly taskSummary?: { readonly total?: number; readonly done?: number };
  readonly currentPhase?: string;
  readonly provider?: unknown;
  readonly attempts?: AttemptSummaryView;
  readonly validation?: ValidationSummaryView;
  readonly progress?: { readonly tasksTotal?: number; readonly tasksDone?: number; readonly stagesTotal?: number; readonly stagesTerminalSuccessful?: number };
  readonly artifacts?: readonly { readonly id: string; readonly kind: string }[];
  readonly handoffCount?: number;
}

/* ------------------------------------------------- workspace selector (NEW) --- */

/**
 * STAGE 1 workspace selection: ONE explicit directory, chosen through the native
 * chooser, opened through the trusted main-process seam, persisted there for
 * restart rehydration. Goal submission stays DISABLED until a workspace is opened —
 * there is no hidden fallback to any other directory.
 */
export function WorkspaceSelector({
  selection,
  onWorkspaceOpened,
}: {
  readonly selection: WorkspaceSelectionBridge | null;
  readonly onWorkspaceOpened: (root: string) => void;
}) {
  const [current, setCurrent] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = ControlPlaneFailure();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (selection === null) {
        setLoaded(true);
        return;
      }
      const currentRoot = await selection.workspaceCurrent().catch(() => null);
      if (!cancelled) {
        setCurrent(currentRoot);
        setLoaded(true);
        if (currentRoot !== null) onWorkspaceOpened(currentRoot);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selection, onWorkspaceOpened]);

  const choose = useCallback(async () => {
    if (selection === null || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const picked = await selection.workspaceSelect();
      if (picked === null) {
        setPending(false);
        return; // user cancelled the chooser — not an error
      }
      const opened = await selection.workspaceOpen(picked);
      if (opened.ok) {
        setCurrent(opened.root);
        onWorkspaceOpened(opened.root);
      } else {
        setFailure({ code: opened.error ?? 'WORKSPACE_OPEN_FAILED', message: '该目录无法作为工作空间打开。' });
      }
    } catch (error) {
      setFailure({ code: 'WORKSPACE_SELECT_FAILED', message: String((error as Error)?.message ?? error) });
    }
    setPending(false);
  }, [selection, pending, setFailure, onWorkspaceOpened]);

  return (
    <section className="card" aria-label="workspace-selector">
      <h2>工作空间</h2>
      {failure !== null ? <ControlPlaneErrorView failure={failure} /> : null}
      {loaded ? (
        current === null ? (
          <p className="muted">尚未选择工作空间。请先选择一个目录，目标将在其中执行。</p>
        ) : (
          <p className="workspace-current" title={current}>
            <span className="workspace-current__label">当前工作空间：</span>
            <span className="workspace-current__path">{current}</span>
          </p>
        )
      ) : (
        <p className="muted">加载中…</p>
      )}
      <div className="workspace-selector__actions">
        <button onClick={() => void choose()} disabled={pending || selection === null}>
          {pending ? '打开中…' : current === null ? '选择工作空间目录…' : '更换工作空间…'}
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- Home view --- */

/**
 * The Goal-first entry: natural-language input (multi-line). One canonical command;
 * the command id is stable for the entered text, so a double click replays the SAME
 * canonical run instead of creating two goals. Submission requires an opened
 * workspace — there is no hidden fallback.
 */
export function GoalEntry({
  bridge,
  onGoalCreated,
  workspaceReady,
}: {
  readonly bridge: ControlPlaneBridge;
  readonly onGoalCreated: (runId: string) => void;
  readonly workspaceReady: boolean;
}) {
  const [objective, setObjective] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = ControlPlaneFailure();
  const commandIdRef = useRef<string | null>(null);

  const submit = useCallback(async () => {
    const text = objective.trim();
    if (text === '' || pending || !workspaceReady) return;
    setPending(true);
    setFailure(null);
    if (commandIdRef.current === null) {
      commandIdRef.current = `ui-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
    }
    const envelope = await controlPlaneRead<{ readonly runId: string }>(bridge, 'goal.create', {
      companyId: 'company_default',
      objective: text,
      commandId: commandIdRef.current,
    });
    setPending(false);
    if (envelope.ok && envelope.value !== undefined) {
      onGoalCreated(envelope.value.runId);
      return;
    }
    setFailure(envelope.error ?? { code: 'UNKNOWN', message: 'The goal could not be created.' });
  }, [objective, onGoalCreated, pending, workspaceReady, setFailure]);

  return (
    <section className="card" aria-label="goal-entry">
      <h2>你想把什么事情变成现实？</h2>
      <textarea
        aria-label="goal-objective"
        className="goal-entry__textarea"
        placeholder="用自然语言描述你想达成的目标…"
        rows={4}
        value={objective}
        onChange={(event) => setObjective(event.target.value)}
        disabled={pending}
      />
      <div className="goal-entry__actions">
        <button onClick={() => void submit()} disabled={pending || objective.trim() === '' || !workspaceReady}>
          {pending ? '创建中…' : '开始目标'}
        </button>
        {!workspaceReady ? <span className="muted">先选择工作空间，再开始目标。</span> : null}
      </div>
      <ControlPlaneErrorView failure={failure} />
    </section>
  );
}

/* ------------------------------------------------------------- polling hook --- */

/** Bounded read-only poll: re-reads while `enabled`, cleaned up on unmount/view change. */
const usePolling = (enabled: boolean, refresh: () => void): void => {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => refreshRef.current(), GOAL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);
};

/** H12b: the canonical end of a run record (state + failureReason + typed outcome). */
const runEndOf = (record: Record<string, unknown> | null, fallbackState: string): RunEndInput => ({
  state: typeof record?.['state'] === 'string' ? record['state'] : fallbackState,
  failureReason: typeof record?.['failureReason'] === 'string' ? record['failureReason'] : null,
  ...(record !== null && 'terminalOutcome' in record
    ? { terminalOutcome: typeof record['terminalOutcome'] === 'string' ? record['terminalOutcome'] : null }
    : {}),
});

/** Deterministic newest-first ordering over the canonical projection. */
export const sortGoalsNewestFirst = (goals: readonly GoalSummary[]): readonly GoalSummary[] =>
  [...goals].sort((a, b) => {
    const at = a.createdAt ?? '';
    const bt = b.createdAt ?? '';
    if (at !== bt) return at < bt ? 1 : -1;
    return a.runId < b.runId ? 1 : -1;
  });

/** Pure goal-list view: renders the canonical projection exactly as given. */
export function GoalListView({
  goals,
  failure,
  onOpen,
}: {
  readonly goals: readonly GoalSummary[] | null;
  readonly failure: ControlPlaneFailureState | null;
  readonly onOpen: (runId: string) => void;
}) {
  return (
    <section className="card" aria-label="goal-list">
      <h2>目标</h2>
      {failure !== null ? <ControlPlaneErrorView failure={failure} /> : null}
      {goals === null ? (
        <p className="muted">加载中…</p>
      ) : goals.length === 0 ? (
        <p className="muted">还没有目标。在上面输入第一个目标。</p>
      ) : (
        <ul className="goal-list">
          {sortGoalsNewestFirst(goals).map((goal) => (
            <li key={goal.runId}>
              <button className="goal-list__open" onClick={() => onOpen(goal.runId)}>
                <span className="goal-list__objective">{goal.objective ?? '(未命名目标)'}</span>
                <span className={`goal-list__state goal-list__state--${runStateModifier(goal)}`} title={goal.state}>{runStateLabel(goal)}</span>
                <span className="goal-list__meta">
                  <span className="goal-list__runid">{goal.runId.slice(0, 14)}</span>
                  {goal.createdAt !== undefined ? new Date(goal.createdAt).toLocaleString() : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Home goal-list container: fetches via loadHomeSummary + bounded poll while live. */
export function GoalList({
  bridge,
  onOpen,
  refreshKey,
  onRefreshTick,
}: {
  readonly bridge: ControlPlaneBridge;
  readonly onOpen: (runId: string) => void;
  readonly refreshKey: number;
  readonly onRefreshTick?: () => void;
}) {
  const [goals, setGoals] = useState<readonly GoalSummary[] | null>(null);
  const [failure, setFailure] = ControlPlaneFailure();
  // local poll key: bumping it re-triggers the read effect below (bounded, view-lifetime only)
  const [localKey, setLocalKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadHomeSummary(bridge, 'company_default').then((envelope) => {
      if (cancelled) return;
      if (envelope.ok && envelope.value !== undefined) {
        setGoals(envelope.value.goals);
        setFailure(null);
      } else {
        setGoals([]);
        setFailure(envelope.error ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, refreshKey, localKey, setFailure]);

  // bounded poll only while a goal may still be moving (non-terminal present)
  const hasLive = goals !== null && goals.some((goal) => !isRunEnded(goal));
  usePolling(hasLive, () => {
    setLocalKey((key) => key + 1);
    onRefreshTick?.();
  });

  return <GoalListView goals={goals} failure={failure} onOpen={onOpen} />;
}

/* ------------------------------------------------------ Goal Workspace view --- */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Pure goal-workspace view: renders the canonical projections exactly as given. */
export function GoalWorkspaceView({
  goalObjective,
  planningRunState,
  planningRunId,
  overview,
  blockers,
  executionRuns,
  deliverableArtifacts,
  onAdvance,
  advancing,
  onBack,
  cancellationRequested,
}: {
  readonly goalObjective: string | null;
  readonly planningRunState: string;
  readonly planningRunId: string;
  readonly overview: unknown;
  readonly blockers: readonly unknown[];
  readonly executionRuns: readonly { readonly runId: string; readonly state: string }[];
  readonly deliverableArtifacts: readonly { readonly artifactId: string; readonly kind: string }[];
  readonly onAdvance?: () => void;
  readonly advancing?: boolean;
  readonly onBack?: () => void;
  readonly cancellationRequested?: boolean;
}) {
  const overviewRecord = asRecord(overview);
  const runState = String(overviewRecord?.['state'] ?? planningRunState ?? '');
  const runEnd = runEndOf(overviewRecord, runState);
  const outcome = terminalOutcomeOf(runEnd);
  const terminal = outcome !== null;
  const overviewView = (overview ?? null) as RunOverviewView | null;
  const progress = overviewView?.progress;
  const attempts = overviewView?.attempts;
  const validation = overviewView?.validation;
  const failed = outcome === 'FAILED' || outcome === 'TIMED_OUT' || validation?.failed === true;

  return (
    <section className="card" aria-label="goal-workspace">
      <h2>目标工作区</h2>
      <p className="goal-workspace__objective">{goalObjective ?? '(未命名目标)'}</p>
      <dl className="kv">
        <dt>状态</dt>
        <dd>
          <span className={`goal-list__state goal-list__state--${runStateModifier(runEnd)}`} title={`${runEnd.state ?? ''}${runEnd.failureReason ? ` · ${runEnd.failureReason}` : ''}`}>{runStateLabel(runEnd)}</span>
        </dd>
        {cancellationRequested === true && !terminal ? (
          <>
            <dt>取消</dt>
            <dd>已请求取消，不再启动新的工作；正在收尾。</dd>
          </>
        ) : null}
        <dt>规划 Run</dt>
        <dd>
          {planningRunId} · {planningRunState}
        </dd>
        {outcome !== 'CANCELLED' && overviewView?.failureReason !== undefined && overviewView.failureReason !== null ? (
          <>
            <dt>失败原因</dt>
            <dd className="typed-error__message">{overviewView.failureReason}</dd>
          </>
        ) : null}
      </dl>

      <h3>任务进度</h3>
      <p className="muted">
        {progress !== undefined
          ? `任务 ${String(progress.tasksDone ?? 0)}/${String(progress.tasksTotal ?? 0)} 完成 · 阶段 ${String(progress.stagesTerminalSuccessful ?? 0)}/${String(progress.stagesTotal ?? 0)} 终态成功`
          : '任务信息尚不可用。'}
        {attempts !== undefined
          ? ` · 尝试：完成 ${String(attempts.completed ?? 0)} · 失败 ${String(attempts.failed ?? 0)} · 活跃 ${String(attempts.active ?? 0)}`
          : ''}
      </p>

      <h3>验证</h3>
      <ValidationSummaryViewBlock validation={validation} />

      {failed ? (
        <div className="goal-failure" role="alert">
          <p>{outcome === 'TIMED_OUT' ? '该目标已超时。' : '该目标已失败。'}失败原因如上，历史不会自动重跑。</p>
        </div>
      ) : null}

      {terminal ? (
        <>
          <h3>交付物</h3>
          {deliverableArtifacts.length === 0 ? (
            <p className="muted">无交付物引用。</p>
          ) : (
            <ul className="artifact-list">
              {deliverableArtifacts.map((artifact) => (
                <li key={artifact.artifactId}>
                  <span className="artifact-list__kind">{artifact.kind}</span>
                  <span className="artifact-list__id">{artifact.artifactId}</span>
                </li>
              ))}
            </ul>
          )}
          {typeof overviewView?.handoffCount === 'number' ? (
            <p className="muted">移交记录：{String(overviewView.handoffCount)}</p>
          ) : null}
        </>
      ) : null}

      <div className="goal-workspace__actions">
        {!terminal && onAdvance !== undefined ? (
          <button onClick={onAdvance} disabled={advancing === true}>
            {advancing === true ? '推进中…' : '继续推进'}
          </button>
        ) : null}
        {onBack !== undefined ? (
          <button className="goal-back" onClick={onBack}>← 返回目标列表</button>
        ) : null}
      </div>

      <h3>执行 Run</h3>
      {executionRuns.length === 0 ? (
        <p className="muted">尚未编译出执行 Run（先推进一次规划）。</p>
      ) : (
        <ul className="run-list">
          {executionRuns.map((run) => (
            <li key={run.runId}>
              <span className="run-view__id">{run.runId}</span>
              <span className="run-view__state">{run.state}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>阻塞与待决策</h3>
      <BlockerList blockers={blockers} />
    </section>
  );
}

/** Goal-workspace container: fetches via the canonical loaders + bounded poll while live. */
export function GoalWorkspace({ bridge, runId, onBack }: { readonly bridge: ControlPlaneBridge; readonly runId: string; readonly onBack?: () => void }) {
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [failure, setFailure] = ControlPlaneFailure();
  const [advancing, setAdvancing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [deliverableArtifacts, setDeliverableArtifacts] = useState<readonly { artifactId: string; kind: string }[]>([]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadGoalWorkspace(bridge, 'company_default', runId).then((envelope) => {
      if (cancelled) return;
      if (envelope.ok && envelope.value !== undefined) {
        setWorkspace(envelope.value);
        setFailure(null);
      } else {
        setWorkspace(null);
        setFailure(envelope.error ?? null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, runId, refreshKey, setFailure]);

  const overviewRecord = asRecord(workspace?.overview);
  const runState = String(overviewRecord?.['state'] ?? workspace?.planningRun.state ?? '');
  const terminal = isRunEnded(runEndOf(overviewRecord, runState));

  // Outcome/artifact references: canonical refs only (run.artifacts), read when terminal.
  useEffect(() => {
    if (!terminal) return;
    let cancelled = false;
    void loadRunArtifacts(bridge, 'company_default', runId).then((envelope) => {
      if (cancelled) return;
      if (envelope.ok && envelope.value !== undefined) setDeliverableArtifacts(envelope.value.artifacts);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, runId, terminal]);

  usePolling(!terminal, refresh);

  const advance = useCallback(async () => {
    if (advancing) return;
    setAdvancing(true);
    const envelope = await controlPlaneRead<unknown>(bridge, 'goal.advance', {
      companyId: 'company_default',
      runId,
    });
    setAdvancing(false);
    if (!envelope.ok) {
      setFailure(envelope.error ?? { code: 'UNKNOWN', message: '推进失败。' });
      return;
    }
    refresh();
  }, [bridge, runId, advancing, refresh, setFailure]);

  if (failure !== null && workspace === null) {
    return (
      <section className="card" aria-label="goal-workspace">
        <h2>目标工作区</h2>
        <ControlPlaneErrorView failure={failure} />
        {onBack !== undefined ? <button className="goal-back" onClick={onBack}>← 返回目标列表</button> : null}
      </section>
    );
  }
  if (workspace === null) {
    return (
      <section className="card" aria-label="goal-workspace">
        <h2>目标工作区</h2>
        <p className="muted">加载中…</p>
      </section>
    );
  }

  return (
    <GoalWorkspaceView
      goalObjective={workspace.goal?.objective ?? null}
      planningRunState={workspace.planningRun.state}
      planningRunId={workspace.runId}
      overview={workspace.overview}
      blockers={workspace.blockers}
      executionRuns={workspace.executionRuns}
      deliverableArtifacts={deliverableArtifacts}
      onAdvance={advance}
      advancing={advancing}
      onBack={onBack}
      cancellationRequested={workspace.cancellationRequested === true}
    />
  );
}

/* --------------------------------------------------------- validation block --- */

export function ValidationSummaryViewBlock({
  validation,
}: {
  readonly validation?: ValidationSummaryView;
}) {
  if (validation === undefined || validation === null) return <p className="muted">验证信息尚不可用。</p>;
  const completed = validation.completed ?? [];
  const missing = validation.missing ?? [];
  return (
    <div>
      {completed.length === 0 && missing.length === 0 ? <p className="muted">尚无验证记录。</p> : null}
      <ul className="validation-list">
        {completed.map((entry, index) => (
          <li key={`${entry.validatorId ?? 'validator'}-${String(index)}`}>
            <span className="validation-list__validator">{entry.validatorId ?? 'validator'}</span>
            <span className={`validation-list__status validation-list__status--${entry.status ?? 'unknown'}`}>{entry.status ?? 'unknown'}</span>
          </li>
        ))}
        {missing.map((validatorId) => (
          <li key={`missing-${validatorId}`}>
            <span className="validation-list__validator">{validatorId}</span>
            <span className="validation-list__status validation-list__status--missing">missing</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------- Run view --- */

export function RunView({
  bridge,
  runId,
  refreshKey,
}: {
  readonly bridge: ControlPlaneBridge;
  readonly runId: string;
  readonly refreshKey: number;
}) {
  const [overview, setOverview] = useState<RunOverviewView | null>(null);
  const [blockers, setBlockers] = useState<readonly unknown[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [failure, setFailure] = ControlPlaneFailure();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [overviewEnvelope, blockerEnvelope] = await Promise.all([
        controlPlaneRead<RunOverviewView>(bridge, 'run.overview', { companyId: 'company_default', runId }),
        controlPlaneRead<readonly unknown[]>(bridge, 'run.blockers', { companyId: 'company_default', runId }),
      ]);
      if (cancelled) return;
      if (overviewEnvelope.ok && overviewEnvelope.value !== undefined) {
        setOverview(overviewEnvelope.value);
        setFailure(null);
      } else {
        setFailure(overviewEnvelope.error ?? null);
      }
      setBlockers(blockerEnvelope.ok && blockerEnvelope.value !== undefined ? blockerEnvelope.value : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, runId, refreshKey, setFailure]);

  return (
    <div className="run-view">
      <button className="run-view__head" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="run-view__id">{runId}</span>
        <span className="run-view__state">{overview?.state ?? '…'}</span>
        <span className="run-view__count">
          {overview?.taskSummary ? `${String(overview.taskSummary.done ?? 0)}/${String(overview.taskSummary.total ?? 0)}` : ''}
        </span>
      </button>
      {expanded ? (
        <div className="run-view__detail">
          <ControlPlaneErrorView failure={failure} />
          {overview?.failureReason !== undefined && overview.failureReason !== null ? (
            <p className="typed-error__message">{overview.failureReason}</p>
          ) : null}
          <h4>阻塞</h4>
          <BlockerList blockers={blockers} />
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------- blocker list --- */

interface BlockerShape {
  readonly code?: string;
  readonly reason?: string;
  readonly message?: string;
  readonly runId?: string;
}

/**
 * Truthful blocker rendering: every canonical blocker is listed in the durable
 * order, one never hides another, and an older unresolved anchor stays visible
 * even when a newer clean report exists (the D1 law is in the projection; the UI
 * only renders it).
 */
export function BlockerList({ blockers }: { readonly blockers: readonly unknown[] }) {
  if (blockers.length === 0) {
    return <p className="muted">无阻塞。</p>;
  }
  return (
    <ul className="blocker-list">
      {blockers.map((blocker, index) => {
        const shape = (typeof blocker === 'object' && blocker !== null ? blocker : {}) as BlockerShape;
        return (
          <li key={`${String(shape.code ?? 'blocker')}-${String(index)}`} className="blocker-list__item">
            <span className="blocker-list__code">{shape.code ?? shape.reason ?? 'BLOCKED'}</span>
            <span className="blocker-list__message">{shape.message ?? ''}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* --------------------------------------------------------------- failures --- */

export interface ControlPlaneFailureState {
  readonly code: string;
  readonly message: string;
}

/**
 * Typed-error state hook: the renderer keeps the code and message EXACTLY as the
 * canonical service produced them ("Something went wrong" is forbidden).
 */
function ControlPlaneFailure(): [
  ControlPlaneFailureState | null,
  (value: ControlPlaneFailureState | null) => void,
] {
  return useState<ControlPlaneFailureState | null>(null);
}

export function ControlPlaneErrorView({ failure }: { readonly failure: ControlPlaneFailureState | null }) {
  if (failure === null) return null;
  return (
    <p className="typed-error" role="alert">
      <span className="typed-error__code">{failure.code}</span>
      <span className="typed-error__message">{failure.message}</span>
    </p>
  );
}
