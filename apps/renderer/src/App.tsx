/**
 * STAGE 2 — the desktop shell container.
 *
 * Three areas, conversation-first: LEFT navigation + history + (bottom-left) settings,
 * CENTRE the conversation with the composer, RIGHT the collapsible CompanyOS runtime
 * panel. Every read and every write crosses the typed preload bridge; this component
 * holds presentation state only (which view, which goal, which popover) and never any
 * Goal/Run/Task/model truth of its own.
 *
 * Autonomy is NOT driven from here: the main process owns the canonical autonomy driver,
 * so after Send the user never clicks 继续 again. This component only re-reads canonical
 * state through bounded, lifecycle-bound polling.
 */
import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';

import {
  FALLBACK_APP_VERSION,
  bridgeAvailability,
  IPC_FAILED,
  safeRequest,
  getBridge,
  resolveAppVersion,
  resolveDatabaseStatus,
  type DatabaseStatus,
} from './bridge.js';
import { ChatView, projectConversation } from './chat.js';
import {
  AuthorityPopover,
  ACCESS_POLICY_OPTIONS,
  ComposerView,
  ModelSelectorView,
} from './composer.js';
import type { WorkflowBridge } from './designer.js';
import {
  establishCompanySelection,
  loadModelCatalogue,
  loadRegisteredModels,
  projectModelSelection,
  toModelOptionRows,
  ModelOnboardingView,
  type ModelOptionRow,
  type ModelSelectionStatus,
  type SelectionExplanation,
} from './models.js';
import { createSubmissionController, type SubmissionController, type SubmissionResult } from './submission-intent.js';
import { createSubmissionIntentStore } from './intent-store.js';
import { LocalDraftControls } from './local-draft-controls.js';
import { browserDraftStorage, createLocalDraftStore } from './local-draft-store.js';
import { fileDeliveryConstraints } from './file-delivery-input.js';
import {
  RuntimePanelView,
  projectRuntimeLifecycle,
  type CanonicalGoalWorkspace,
  type CanonicalTaskObservation,
  type CanonicalTimelineEntry,
  type RuntimeTab,
} from './runtime-panel.js';
import {
  AgentsSurfaceView,
  KnowledgeSurfaceView,
  ToolsSurfaceView,
  loadAgents,
  loadKnowledge,
  loadTools,
  resolveSurfaceCompany,
  type AgentRow,
  type KnowledgeRow,
  type ToolRow,
} from './surfaces.js';
import {
  AppShellView,
  SettingsView,
  SHELL_NAV,
  TopBarView,
  type RecentGoalRow,
  type ReadinessRow,
  type ShellView,
} from './shell.js';
import {
  ApprovalCardView,
  loadPendingDecisions,
  pendingApprovalOf,
  projectAuthorityMode,
  respondToApproval,
  type ApprovalDecision,
  type PendingDecision,
} from './approvals.js';
import { runArtifactAction } from './artifacts-view.js';
import { loadGoalUsage, projectTelemetry } from './usage.js';
import { loadGoalBudget } from './budget.js';
import { projectModelRuntime, type ModelRuntimeSnapshot } from './telemetry.js';
import { GoalList, WorkspaceSelector, type ControlPlaneBridge, type WorkspaceSelectionBridge } from './workspace.js';
import { createRuntimeReadBudget, RuntimeReadError } from './runtime-read-budget.js';
import { isRunEnded, terminalOutcomeOf } from './run-outcome.js';
import { GoalCancelControl } from './cancel-control.js';
import { DatabaseFailureBanner, readDatabaseFailure } from './database-failure.js';
import { goalTitleOf } from './chat.js';
import { elapsedText, goalStateWord, sessionCostText, startedAtText } from './format.js';
import { projectPlanSteps, type ExecutionOverviewInput } from './plan-steps.js';
import { PHASE_LABELS } from './runtime-panel.js';

/** Bounded, read-only, lifecycle-bound polling — never workflow authority. */
const GOAL_POLL_INTERVAL_MS = 4_000;
const COMPANY_ID = 'company_default';

interface BridgeEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * AUDIT R3: the typed failure of the last ACTION (submit, workspace change, model choice),
 * rendered in the composer dock so it is visible on every view (Home with no Goal open,
 * Settings, Tools, …) and independent of the open Goal's read failures.
 */
function ActionFailureLine(props: {
  readonly failures: readonly ({ readonly code: string; readonly message: string } | null)[];
}) {
  const shown = props.failures.filter((entry): entry is { code: string; message: string } => entry !== null);
  if (shown.length === 0) return null;
  return h(
    'div',
    { className: 'typed-error action-failure', role: 'alert', 'data-testid': 'action-failure' },
    shown.map((failure) =>
      h('p', { key: failure.code, className: 'typed-error__message' }, `${failure.code} ${failure.message}`),
    ),
  );
}

/**
 * UI-PAPER-INK: measured wall time since the Goal's canonical start, ticking only while the
 * Goal is live and its start is known (its own 1 s timer, so the App does not re-render).
 */
function GoalElapsed(props: { readonly since: string | null; readonly live: boolean }): JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!props.live || props.since === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [props.live, props.since]);
  if (!props.live) return null;
  const text = elapsedText(props.since, now);
  return text === null ? null : h('span', { className: 'topbar__elapsed num' }, `已运行 ${text}`);
}

export function App() {
  const [version, setVersion] = useState<string>(FALLBACK_APP_VERSION);
  const [database, setDatabase] = useState<DatabaseStatus | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  // AUDIT-R5: the current workspace for the submit seam (a stable callback must not read a stale closure).
  const workspaceRootRef = useRef<string | null>(null);
  workspaceRootRef.current = workspaceRoot;
  const workspaceIdentity = useRef(workspaceRoot);
  workspaceIdentity.current = workspaceRoot;
  const [view, setView] = useState<ShellView>('home');
  const [openGoalRunId, setOpenGoalRunId] = useState<string | null>(null);
  const [recent, setRecent] = useState<readonly RecentGoalRow[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [draft, setDraft] = useState('');
  const [deliveryPath, setDeliveryPath] = useState('');
  const [deliveryText, setDeliveryText] = useState('');
  useLayoutEffect(() => { setDeliveryPath(''); setDeliveryText(''); }, [workspaceRoot]);
  const [submissionBusy, setSubmissionBusy] = useState(false);
  const submissionInFlight = useRef(false);
  const [submissionFailure, setSubmissionFailure] = useState<{ code: string; message: string } | null>(null);
  const [modelOptions, setModelOptions] = useState<readonly ModelOptionRow[]>([]);
  const [modelStatus, setModelStatus] = useState<ModelSelectionStatus>({ kind: 'no-models' });
  const [modelExplanation, setModelExplanation] = useState<SelectionExplanation | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  // AUDIT R3: model-selection failures have their own surface (onboarding card + dock).
  const [modelFailure, setModelFailure] = useState<{ code: string; message: string } | null>(null);
  const [catalogueCount, setCatalogueCount] = useState(0);
  const [pendingIntent, setPendingIntent] = useState(false);
  const [pendingObjective, setPendingObjective] = useState<string | null>(null);
  const [popover, setPopover] = useState<'model' | 'authority' | 'runtime' | null>(null);
  // UI-AUDIT-15: the runtime view is part of the goal page (open by default); 收起 keeps working.
  const [runtimeExpanded, setRuntimeExpanded] = useState(true);
  // UI-PAPER-INK: the newest execution run's overview (plan step states, stage progress).
  const [executionOverview, setExecutionOverview] = useState<ExecutionOverviewInput | null>(null);
  const [runtimeTab, setRuntimeTab] = useState<RuntimeTab>('run');
  const [runtimeWorkspace, setRuntimeWorkspace] = useState<CanonicalGoalWorkspace | null>(null);
  const [runtimeTimeline, setRuntimeTimeline] = useState<readonly CanonicalTimelineEntry[]>([]);
  const [runtimeTask, setRuntimeTask] = useState<CanonicalTaskObservation | null>(null);
  const [runtimeArtifacts, setRuntimeArtifacts] = useState<readonly { artifactId: string; kind: string }[]>([]);
  const [runtimeReadFailure, setRuntimeReadFailure] = useState<{ code: string; message: string } | null>(null);
  const [surfaceFailure, setSurfaceFailure] = useState<{ code: string; message: string } | null>(null);
  const [toolRows, setToolRows] = useState<readonly ToolRow[] | null>(null);
  const [knowledgeRows, setKnowledgeRows] = useState<readonly KnowledgeRow[] | null>(null);
  const [agentRows, setAgentRows] = useState<readonly AgentRow[] | null>(null);
  // STAGE 3 — canonical pending approvals / decisions, the usage projection, the derived
  // readiness rows, and the bounded artifact actions.
  // STAGE 4 — the user's access-policy selection for the NEXT goal. Display state only:
  // the authoritative value is bound canonically at goal.create and read back through
  // goal.workspace. Nothing is persisted in the renderer.
  const [selectedAccessPolicy, setSelectedAccessPolicy] = useState<
    'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS'
  >('ASK_PERMISSION');
  const [pendingDecisions, setPendingDecisions] = useState<readonly PendingDecision[]>([]);
  const [approvalBusy, setApprovalBusy] = useState(false);
  // UI-AUDIT-06: single-flight approval decision (two quick clicks never send two decisions).
  const approvalInFlight = useRef(false);
  // AUDIT-R1: cancel control state of the OPEN Goal (reset on Goal switch).
  const [cancelConfirming, setCancelConfirming] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelRequestedFor, setCancelRequestedFor] = useState<string | null>(null);
  const [cancelFailure, setCancelFailure] = useState<{ code: string; message: string } | null>(null);
  const cancelInFlight = useRef(false);
  const [approvalFailure, setApprovalFailure] = useState<{ code: string; message: string } | null>(null);
  const [usageProjection, setUsageProjection] = useState<Awaited<ReturnType<typeof loadGoalUsage>>>(null);
  // H11: the boss's budget/spend + previewed-plan projection for the selected Goal.
  const [budgetRead, setBudgetRead] = useState<Awaited<ReturnType<typeof loadGoalBudget>>>(null);
  const [readinessRows, setReadinessRows] = useState<readonly ReadinessRow[] | null>(null);
  const [platformInfo, setPlatformInfo] = useState<{ electron: string; nodeVersion: string } | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<{
    readonly artifactId: string;
    readonly text: string;
    readonly truncated: boolean;
    readonly kind: string;
  } | null>(null);
  const [artifactFailure, setArtifactFailure] = useState<{ code: string; message: string } | null>(null);

  const bridge = getBridge();
  const availability = bridgeAvailability();
  // STAGE 2: the bridges are memoised on the preload object so their identity is STABLE
  // across renders. A fresh object every render would rebuild the submission controller on
  // every render and re-run its mount effect — which replays the unacknowledged submission
  // intent in a hot loop (the real-boot smoke caught exactly this: 4095 replays).
  const workflow: WorkflowBridge | null = useMemo(
    () =>
      bridge !== null && typeof bridge.workflowRequest === 'function'
        ? { workflowRequest: (request) => safeRequest(() => (bridge.workflowRequest as NonNullable<typeof bridge.workflowRequest>)(request)) }
        : null,
    [bridge],
  );
  const controlPlane: ControlPlaneBridge | null = useMemo(
    () =>
      bridge !== null && typeof bridge.controlPlaneRequest === 'function'
        ? { controlPlaneRequest: (request) => safeRequest(() => (bridge.controlPlaneRequest as NonNullable<typeof bridge.controlPlaneRequest>)(request)) }
        : null,
    [bridge],
  );
  const workspaceSelection: WorkspaceSelectionBridge | null = useMemo(
    () =>
      bridge !== null &&
      typeof bridge.workspaceSelect === 'function' &&
      typeof bridge.workspaceOpen === 'function' &&
      typeof bridge.workspaceCurrent === 'function' &&
      typeof bridge.workspaceSwitch === 'function'
        ? {
            workspaceSelect: () => (bridge.workspaceSelect as NonNullable<typeof bridge.workspaceSelect>)(),
            // AUDIT R7: a rejected open/switch is a typed refusal ({ok:false, error:IPC_FAILED}),
            // never an unhandled rejection; a rejected current-read means "nothing open".
            workspaceOpen: (root) =>
              (bridge.workspaceOpen as NonNullable<typeof bridge.workspaceOpen>)(root).catch(
                () => ({ ok: false, root, error: IPC_FAILED }) as const,
              ),
            workspaceCurrent: () =>
              (bridge.workspaceCurrent as NonNullable<typeof bridge.workspaceCurrent>)().catch(() => null),
            workspaceSwitch: (root) =>
              (bridge.workspaceSwitch as NonNullable<typeof bridge.workspaceSwitch>)(root).catch(
                () => ({ ok: false, root, error: IPC_FAILED }) as const,
              ),
          }
        : null,
    [bridge],
  );

  /* ------------------------------------------------------ app diagnostics --- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const nextVersion = await resolveAppVersion(getBridge());
      const nextDatabase = await resolveDatabaseStatus(getBridge());
      if (cancelled) return;
      setVersion(nextVersion);
      setDatabase(nextDatabase);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------------------------------------- model onboarding state --- */
  const refreshModels = useCallback(async () => {
    if (workflow === null) return;
    const [catalogue, registered] = await Promise.all([loadModelCatalogue(workflow), loadRegisteredModels(workflow)]);
    const options = toModelOptionRows(catalogue, registered);
    setModelOptions(options);
    setCatalogueCount(catalogue.length);
    const selection = (await workflow.workflowRequest({ operation: 'models.selection' })) as BridgeEnvelope<{
      readonly resolvedModelKey?: string | null;
    }>;
    const companyKey =
      selection.ok === true && typeof selection.value?.resolvedModelKey === 'string'
        ? selection.value.resolvedModelKey
        : null;
    setModelStatus(projectModelSelection(options, companyKey));
  }, [workflow]);

  useEffect(() => {
    void refreshModels().catch(() => undefined);
  }, [refreshModels]);

  const chooseModel = useCallback(
    async (option: ModelOptionRow) => {
      if (workflow === null) return;
      setModelBusy(true);
      setModelExplanation(null);
      setModelFailure(null);
      try {
        const result = await establishCompanySelection(workflow, {
          providerId: option.providerId,
          providerModelId: option.providerModelId,
          modelKey: option.modelKey,
        });
        if (result.ok) {
          setModelExplanation(result.explanation);
          setModelStatus({ kind: 'selected', modelKey: result.modelKey, displayName: option.displayName });
          setSubmissionFailure(null);
        } else {
          setModelFailure({ code: result.code, message: result.message });
        }
      } catch {
        setModelFailure({ code: 'MODEL_SELECTION_FAILED', message: '模型选择未完成（读取或保存失败），请重试。' });
      } finally {
        // AUDIT R7: the busy flag is released on EVERY path, so a throw can never leave
        // the model buttons disabled forever.
        setModelBusy(false);
        setPopover(null);
      }
      await refreshModels().catch(() => undefined);
    },
    [workflow, refreshModels],
  );

  /* ----------------------------------------------- canonical workspace change --- */
  // BUG BASH closure: the ONE shared change-workspace flow (Settings + composer chip).
  // The trusted main-process switch owns the lifecycle; this display only ever updates
  // from the CANONICAL result, and a refusal surfaces typed with A remaining active.
  const changeWorkspace = useCallback(() => {
    if (workspaceSelection === null) return;
    void (async () => {
      let picked: string | null;
      try {
        picked = await workspaceSelection.workspaceSelect();
      } catch {
        setSubmissionFailure({ code: 'WORKSPACE_SELECT_FAILED', message: '无法打开目录选择器。已保持在当前工作空间。' });
        return;
      }
      if (picked === null) return; // user cancelled the chooser — not an error
      const switched = await workspaceSelection.workspaceSwitch(picked).catch(
        (error: unknown) =>
          ({ ok: false, root: picked, error: String((error as Error)?.message ?? error) }) as const,
      );
      if (switched.ok) {
        setWorkspaceRoot(switched.root);
        setSubmissionFailure(null);
      } else {
        setSubmissionFailure({
          code: 'WORKSPACE_SWITCH_REFUSED',
          message: `无法切换到所选工作空间（${switched.error ?? 'UNKNOWN'}）。已保持在当前工作空间。`,
        });
      }
    })();
  }, [workspaceSelection]);

  /* ------------------------------------------------- submission intents --- */
  const submitGoal = useCallback(
    async (input: { intentId: string; objective: string; workspaceRoot: string; structured?: Readonly<Record<string, unknown>>; accessPolicy?: 'ASK_PERMISSION' | 'READ_ONLY' | 'WORKSPACE_OPERATIONS' }): Promise<{ runId: string } | { error: string; code?: string }> => {
      if (controlPlane === null) return { error: 'CONTROL_PLANE_UNAVAILABLE' };
      // AUDIT-R5: a submission replays with the policy and workspace it was made with - never the current
      // chip or another workspace. A record without its policy (older build) or for another workspace is
      // refused here (typed, so the outbox is cleared and nothing reaches main) and the user resubmits.
      if (input.accessPolicy === undefined) {
        return { code: 'INTENT_POLICY_MISSING', error: '上一次未确认的提交缺少访问策略记录，已放弃；请重新提交。' };
      }
      if (workspaceRootRef.current !== null && input.workspaceRoot !== workspaceRootRef.current) {
        return { code: 'INTENT_WORKSPACE_MISMATCH', error: `上一次未确认的提交属于另一个工作空间（${input.workspaceRoot}），已放弃；请在当前工作空间重新提交。` };
      }
      const response = (await controlPlane.controlPlaneRequest({
        operation: 'goal.create',
        payload: {
          companyId: COMPANY_ID,
          objective: input.objective,
          ...(input.structured === undefined ? {} : { structured: input.structured }),
          commandId: input.intentId,
          accessPolicy: input.accessPolicy,
        },
      })) as BridgeEnvelope<{ readonly runId: string }>;
      if (!response.ok || response.value === undefined) {
        // AUDIT R2: pass main's typed code through, so the controller can tell a canonical
        // refusal (cleared) from an unknown outcome (kept pending for an explicit retry).
        return {
          error: response.error?.message ?? 'goal.create failed',
          ...(typeof response.error?.code === 'string' ? { code: response.error.code } : {}),
        };
      }
      return { runId: response.value.runId };
    },
    [controlPlane],
  );

  const controller: SubmissionController | null = useMemo(
    () =>
      controlPlane === null
        ? null
        : createSubmissionController({
            store: createSubmissionIntentStore(),
            submit: submitGoal,
            now: () => new Date().toISOString(),
            newIntentId: () => `si-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          }),
    [controlPlane, submitGoal],
  );

  const controllerRef = useRef<SubmissionController | null>(null);
  controllerRef.current = controller;

  const syncPending = useCallback(() => {
    let record: ReturnType<SubmissionController['pending']> = null;
    try {
      record = controllerRef.current?.pending() ?? null;
    } catch {
      record = null;
    }
    setPendingIntent(record !== null);
    setPendingObjective(record === null ? null : record.objective);
  }, []);

  // STAGE 2 case C / AUDIT R2: an intent that survived a remount/reload still owns the next
  // submission (so it can never be duplicated), but it is NOT replayed silently any more:
  // the composer shows it with explicit 重试 (same intent id) / 放弃 actions.
  useEffect(() => {
    syncPending();
  }, [syncPending, controller]);

  /** One place that turns a submission result into UI state (send + explicit retry). */
  const draftStore = useMemo(() => createLocalDraftStore(browserDraftStorage()), []);
  const applySubmissionResult = useCallback((
    result: SubmissionResult,
    submitted: { readonly objective: string; readonly workspaceRoot: string } | null,
  ) => {
    if (result.status === 'created' || result.status === 'replayed') {
      // AUDIT R6: the submitted text is no longer an unsubmitted draft.
      if (submitted !== null) {
        try {
          draftStore.clearIfSubmitted(COMPANY_ID, submitted.workspaceRoot, submitted.objective);
        } catch {
          // Storage unavailable: nothing was persisted that could be restored either.
        }
      }
      setDraft('');
      // AUDIT R12: the file-delivery requirement belongs to the submitted Goal only.
      setDeliveryPath('');
      setDeliveryText('');
      setOpenGoalRunId(result.runId);
      // UI-AUDIT-11: a created Goal opens in 对话与任务 (sending from 首页 lands on the Goal).
      setView('chat');
      setRefreshKey((key) => key + 1);
      // Autonomy continues in the main process; the client only observes canonical state.
    } else if (result.status === 'refused') {
      setSubmissionFailure({ code: result.code, message: result.error });
    } else if (result.status === 'failed') {
      setSubmissionFailure({
        code: 'SUBMISSION_UNCONFIRMED',
        message: `提交结果未确认（${result.error}）。可点击「重试」以同一提交标识重试，或「放弃」。`,
      });
    } else if (result.status === 'blocked' && result.reason === 'pending') {
      setSubmissionFailure({ code: 'SUBMISSION_PENDING', message: '上一次提交尚未确认：请先「重试」或「放弃」。' });
    }
  }, [draftStore]);

  const retryPending = useCallback(async () => {
    const active = controllerRef.current;
    if (active === null || submissionInFlight.current) return;
    submissionInFlight.current = true;
    setSubmissionBusy(true);
    setSubmissionFailure(null);
    try {
      const intent = active.pending();
      const result = await active.retry();
      if (result !== null) {
        applySubmissionResult(
          result,
          intent === null ? null : { objective: intent.objective, workspaceRoot: intent.workspaceRoot },
        );
      }
    } catch {
      setSubmissionFailure({ code: 'SUBMISSION_UNCONFIRMED', message: '本地提交存储或主进程通信失败，提交结果未确认。' });
    } finally {
      syncPending();
      submissionInFlight.current = false;
      setSubmissionBusy(false);
    }
  }, [applySubmissionResult, syncPending]);

  const discardPending = useCallback(() => {
    if (submissionInFlight.current) return;
    // The editor text is the user's; it is kept.
    setSubmissionFailure(null);
    try {
      controllerRef.current?.discard();
    } catch {
      setSubmissionFailure({ code: 'SUBMISSION_STORE_UNAVAILABLE', message: '本地提交存储不可用，无法放弃该提交。' });
    }
    syncPending();
  }, [syncPending]);

  const sendGoal = useCallback(async () => {
    const active = controllerRef.current;
    if (active === null || workspaceRoot === null || submissionInFlight.current) return;
    submissionInFlight.current = true;
    setSubmissionBusy(true);
    setSubmissionFailure(null);
    try {
      // AUDIT R7: only a failure to BUILD the file-delivery requirement is a delivery-input
      // error; a store/IPC failure of the submission itself is reported as what it is.
      let structured: Awaited<ReturnType<typeof fileDeliveryConstraints>>;
      try {
        structured = await fileDeliveryConstraints(deliveryPath, deliveryText);
      } catch {
        setSubmissionFailure({ code: 'DELIVERY_INPUT_INVALID', message: '文件要求无效；请检查相对路径与期望内容。未提交。' });
        return;
      }
      if (workspaceIdentity.current !== workspaceRoot) {
        setSubmissionFailure({ code: 'WORKSPACE_CHANGED_BEFORE_SUBMIT', message: '提交前工作空间已变化，未提交。' });
        return;
      }
      let result: Awaited<ReturnType<SubmissionController['submitObjective']>>;
      try {
        result = await active.submitObjective(draft, workspaceRoot, structured, selectedAccessPolicy);
      } catch {
        setSubmissionFailure({ code: 'SUBMISSION_UNCONFIRMED', message: '本地提交存储或主进程通信失败，提交结果未确认。' });
        return;
      } finally {
        syncPending();
      }
      applySubmissionResult(result, { objective: draft, workspaceRoot });
    } finally {
      submissionInFlight.current = false;
      setSubmissionBusy(false);
    }
  }, [draft, workspaceRoot, syncPending, deliveryPath, deliveryText, applySubmissionResult, selectedAccessPolicy]);

  /* ------------------------------------------------- canonical projections --- */
  const loadRecent = useCallback(async () => {
    if (controlPlane === null) return;
    const response = (await controlPlane.controlPlaneRequest({
      operation: 'home.summary',
      payload: { companyId: COMPANY_ID },
    })) as BridgeEnvelope<{ readonly goals: readonly { runId: string; state: string; terminalOutcome?: string | null; objective: string | null }[] }>;
    if (response.ok && response.value !== undefined) setRecent(response.value.goals);
  }, [controlPlane]);

  /*
   * DRA-05 — the current Goal's runtime read chain. Every tick of the SAME
   * controlled refresh (`refreshKey`) re-reads this Goal's canonical projections:
   * goal.workspace / run.timeline / run.artifacts. Each read carries its own
   * generation, so a slow response can never land on a newer view — a Goal switch
   * or an unmount invalidates every in-flight read (a late Goal-A response never
   * pollutes Goal B), and at most ONE read per Goal is in flight (a tick during a
   * pending read is coalesced, never piled up). All requests are READS through the
   * canonical control-plane surface; polling never mutates anything.
   */
  const runtimeReadEpoch = useRef(0);
  const runtimeReadInFlight = useRef<{ goalRunId: string; epoch: number } | null>(null);
  const runtimeReadBudget = useRef<ReturnType<typeof createRuntimeReadBudget> | null>(null);
  if (runtimeReadBudget.current === null) runtimeReadBudget.current = createRuntimeReadBudget();
  const taskReadEpoch = useRef(0);
  const selectedGoal = useRef<string | null>(openGoalRunId);
  const currentWorkspace = useRef<CanonicalGoalWorkspace | null>(null);
  // Clear the old Goal's actionable projections before the new selection can be
  // clicked. Goal IDs and execution Run IDs remain distinct canonical identities.
  useLayoutEffect(() => {
    selectedGoal.current = openGoalRunId;
    runtimeReadEpoch.current += 1;
    runtimeReadInFlight.current = null;
    runtimeReadBudget.current?.cancelWaits();
    taskReadEpoch.current += 1;
    setRuntimeWorkspace(null);
    setRuntimeTask(null);
    setRuntimeTimeline([]);
    setRuntimeArtifacts([]);
    setExecutionOverview(null);
    setRuntimeReadFailure(null);
    // AUDIT R8: every other Goal-scoped projection belongs to the Goal it was read for,
    // so it is cleared before the new selection paints (no Goal-A preview/spend on B).
    setArtifactPreview(null);
    setArtifactFailure(null);
    setBudgetRead(null);
    setUsageProjection(null);
    setApprovalFailure(null);
    setCancelConfirming(false);
    setCancelFailure(null);
  }, [openGoalRunId]);
  useLayoutEffect(() => {
    currentWorkspace.current = runtimeWorkspace?.runId === openGoalRunId ? runtimeWorkspace : null;
    taskReadEpoch.current += 1;
    setRuntimeTask(null);
  }, [openGoalRunId, runtimeWorkspace?.overview?.runId]);
  useLayoutEffect(() => {
    currentWorkspace.current = runtimeWorkspace?.runId === openGoalRunId ? runtimeWorkspace : null;
  }, [openGoalRunId, runtimeWorkspace]);

  const loadRuntime = useCallback(async () => {
    if (controlPlane === null || openGoalRunId === null) {
      runtimeReadEpoch.current += 1;
      runtimeReadInFlight.current = null;
      setRuntimeWorkspace(null);
      setRuntimeTask(null);
      setRuntimeArtifacts([]);
      setRuntimeTimeline([]);
      setExecutionOverview(null);
      return;
    }
    const goalRunId = openGoalRunId;
    const observed = currentWorkspace.current;
    if (observed?.runId === goalRunId && observed.overview !== null &&
        isRunEnded(observed.overview)) return;
    // Bounded: one read in flight per Goal; repeated ticks are coalesced.
    if (runtimeReadInFlight.current !== null && runtimeReadInFlight.current.goalRunId === goalRunId) return;
    const epoch = (runtimeReadEpoch.current += 1);
    runtimeReadInFlight.current = { goalRunId, epoch };
    const isCurrent = (): boolean => runtimeReadEpoch.current === epoch && selectedGoal.current === goalRunId;
    try {
      const workspace = (await runtimeReadBudget.current!.read(() => controlPlane.controlPlaneRequest({
        operation: 'goal.workspace',
        payload: { companyId: COMPANY_ID, runId: goalRunId },
      }))) as BridgeEnvelope<CanonicalGoalWorkspace>;
      if (!isCurrent()) return;
      if (workspace.ok !== true || workspace.value === undefined || workspace.value.runId !== goalRunId) {
        setRuntimeWorkspace(null);
        throw new Error('Invalid workspace response');
      }
      const timeline = (await runtimeReadBudget.current!.read(() => controlPlane.controlPlaneRequest({
        operation: 'run.timeline',
        payload: { companyId: COMPANY_ID, runId: goalRunId, limit: 8 },
      }))) as BridgeEnvelope<{ readonly entries: readonly CanonicalTimelineEntry[] }>;
      if (!isCurrent()) return;
      if (timeline.ok !== true || timeline.value === undefined) throw new Error('Invalid timeline response');
      const artifacts = (await runtimeReadBudget.current!.read(() => controlPlane.controlPlaneRequest({
        operation: 'run.artifacts',
        payload: { companyId: COMPANY_ID, runId: goalRunId },
      }))) as BridgeEnvelope<{ readonly artifacts: readonly { artifactId: string; kind: string }[] }>;
      if (!isCurrent()) return;
      if (artifacts.ok !== true || artifacts.value === undefined) throw new Error('Invalid artifacts response');
      // UI-PAPER-INK: the newest execution run's overview (stage states for the plan steps).
      // Optional: a missing/invalid answer only means the steps show without stage truth.
      const executionRunId = workspace.value.executionRuns?.at(-1)?.runId ?? null;
      let execution: ExecutionOverviewInput | null = null;
      if (executionRunId !== null) {
        const read = (await runtimeReadBudget.current!.read(() => controlPlane.controlPlaneRequest({
          operation: 'run.overview',
          payload: { companyId: COMPANY_ID, runId: executionRunId },
        }))) as BridgeEnvelope<ExecutionOverviewInput>;
        if (!isCurrent()) return;
        const value = read.ok === true ? read.value : undefined;
        execution = value !== undefined && value !== null && value.runId === executionRunId &&
          Array.isArray(value.stages) && Array.isArray(value.executing) ? value : null;
      }
      setExecutionOverview(execution);
      setRuntimeTimeline(timeline.value.entries);
      setRuntimeArtifacts(artifacts.value.artifacts);
      // Commit the complete projection together; a terminal workspace must not
      // stop recovery while its timeline/artifact read is still pending.
      setRuntimeWorkspace(workspace.value);
      setRuntimeReadFailure(null);
    } catch (error) {
      if (!isCurrent()) return;
      runtimeReadEpoch.current += 1;
      const code = error instanceof RuntimeReadError ? error.code : 'RUNTIME_READ_FAILED';
      setRuntimeReadFailure({ code, message: code === 'RUNTIME_READ_BLOCKED'
        ? '运行状态读取暂不可用，等待未完成的读取返回后恢复。'
        : '运行状态读取失败或超时，将在下一次刷新时尝试恢复。' });
    } finally {
      if (runtimeReadInFlight.current !== null && runtimeReadInFlight.current.epoch === epoch) {
        runtimeReadInFlight.current = null;
      }
    }
  }, [controlPlane, openGoalRunId]);

  useEffect(() => {
    void loadRecent().catch(() => undefined);
  }, [loadRecent, refreshKey]);

  // The current Goal's runtime projections ride the SAME controlled refresh as every
  // other projection (DRA-05): a tick re-reads goal.workspace / run.timeline /
  // run.artifacts for the Goal that is open NOW.
  useEffect(() => {
    void loadRuntime();
  }, [loadRuntime, refreshKey]);

  const hasLiveRun =
    openGoalRunId !== null &&
    (runtimeWorkspace?.overview == null || !isRunEnded(runtimeWorkspace.overview));
  useEffect(() => {
    if (!hasLiveRun) return;
    const timer = window.setInterval(() => setRefreshKey((key) => key + 1), GOAL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasLiveRun]);

  /*
   * The selected task detail belongs to ONE Goal: a Goal switch clears it and
   * invalidates any in-flight detail read, and selecting another task supersedes
   * the older read — no response can land on a view it does not belong to.
   */
  useEffect(
    () => () => {
      runtimeReadEpoch.current += 1;
      runtimeReadInFlight.current = null;
      runtimeReadBudget.current?.cancelWaits();
      taskReadEpoch.current += 1;
    },
    [],
  );

  const loadTaskDetail = useCallback(
    async (taskId: string) => {
      const owner = currentWorkspace.current;
      const goalRunId = openGoalRunId;
      const runId = owner?.overview?.runId;
      const task = owner?.overview?.executing.find((entry) => entry.taskId === taskId);
      if (controlPlane === null || goalRunId === null || selectedGoal.current !== goalRunId ||
          owner?.runId !== goalRunId || runId === undefined || task === undefined) return;
      const epoch = (taskReadEpoch.current += 1);
      setRuntimeTask(null);
      const isCurrent = () => taskReadEpoch.current === epoch && selectedGoal.current === goalRunId &&
        currentWorkspace.current?.runId === goalRunId && currentWorkspace.current.overview?.runId === runId &&
        currentWorkspace.current.overview.executing.some((entry) => entry.taskId === taskId && entry.stageId === task.stageId);
      try {
        const response = (await controlPlane.controlPlaneRequest({
          operation: 'run.task',
          payload: { companyId: COMPANY_ID, taskId },
        })) as BridgeEnvelope<CanonicalTaskObservation>;
        if (!isCurrent()) return;
        if (response.ok === true && response.value?.taskId === taskId && response.value.stageId === task.stageId) {
          setRuntimeTask(response.value);
        }
      } catch {
        if (isCurrent()) setRuntimeTask(null);
      }
    },
    [controlPlane, openGoalRunId],
  );

  useEffect(() => {
    let cancelled = false;
    setSurfaceFailure(null);
    if (view !== 'tools' && view !== 'knowledge' && view !== 'agents') return;
    if (view === 'tools') setToolRows(null);
    if (view === 'knowledge') setKnowledgeRows(null);
    if (view === 'agents') setAgentRows(null);
    void (async () => {
      try {
        if (workflow === null) throw new Error('SURFACE_BRIDGE_UNAVAILABLE');
        if (view === 'tools') {
          const rows = await loadTools(workflow);
          if (!cancelled) setToolRows(rows);
        }
        if (view === 'knowledge') {
          if (controlPlane === null) throw new Error('KNOWLEDGE_CONTEXT_UNAVAILABLE');
          const companyId = await resolveSurfaceCompany(controlPlane, COMPANY_ID);
          if (cancelled) return;
          const rows = await loadKnowledge(workflow, companyId);
          if (!cancelled) setKnowledgeRows(rows);
        }
        if (view === 'agents') {
          const rows = await loadAgents(workflow);
          if (!cancelled) setAgentRows(rows);
        }
      } catch {
        if (!cancelled) {
          setSurfaceFailure({ code: 'SURFACE_UNAVAILABLE', message: '无法读取 canonical 数据，请稍后重试。' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, workflow, controlPlane]);

  /* -------------------------------------------------------------- derived --- */
  // STAGE 3 — the effective authority presentation. The MODE is display-only (no canonical
  // per-Goal access-mode write seam exists, so the renderer must not invent one), but the
  // pending canonical approval behind it IS actionable through approval.respond.
  // AUDIT-R9: the approval card / badge / authority of the OPEN Goal only show that Goal's own runs
  // (the goal run, its overview run and its execution runs). Another Goal's pending approval used to land
  // on whatever Goal was open, and 批准 approved B's action while the user looked at A.
  const ownRunIds = useMemo(() => {
    const owned = new Set<string>();
    if (runtimeWorkspace === null || openGoalRunId === null || runtimeWorkspace.runId !== openGoalRunId) return owned;
    owned.add(runtimeWorkspace.runId);
    if (typeof runtimeWorkspace.overview?.runId === 'string') owned.add(runtimeWorkspace.overview.runId);
    for (const run of runtimeWorkspace.executionRuns ?? []) owned.add(run.runId);
    return owned;
  }, [runtimeWorkspace, openGoalRunId]);
  const pendingApprovalDecision = useMemo(
    () => pendingDecisions.find((decision) => ownRunIds.has(decision.runId) && pendingApprovalOf(decision) !== null) ?? null,
    [pendingDecisions, ownRunIds],
  );
  const otherPendingApprovals = useMemo(
    () => pendingDecisions.filter((decision) => !ownRunIds.has(decision.runId) && pendingApprovalOf(decision) !== null),
    [pendingDecisions, ownRunIds],
  );
  const authorityMode = useMemo(
    () =>
      projectAuthorityMode({
        runState: runtimeWorkspace?.overview?.state ?? null,
        approvalPending: pendingApprovalDecision !== null,
      }),
    [runtimeWorkspace, pendingApprovalDecision],
  );
  const authority = useMemo(
    () => ({ ...authorityMode, mutable: false as const }),
    [authorityMode],
  );


  /* ------------------------------------------- STAGE 3 canonical projections --- */

  // Canonical pending decisions/approvals: read-only, and refreshed while a run may be
  // waiting for a human decision.
  const loadPendingDecisionsNow = useCallback(async () => {
    if (controlPlane === null) return;
    const decisions = await loadPendingDecisions(controlPlane);
    setPendingDecisions(decisions);
  }, [controlPlane]);

  useEffect(() => {
    void loadPendingDecisionsNow().catch(() => undefined);
  }, [loadPendingDecisionsNow, refreshKey]);

  // The Goal usage projection (E1 semantics) for the selected Goal.
  useEffect(() => {
    if (controlPlane === null || openGoalRunId === null) {
      setUsageProjection(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const projection = await loadGoalUsage(controlPlane, openGoalRunId).catch(() => null);
      if (!cancelled) setUsageProjection(projection);
    })();
    return () => {
      cancelled = true;
    };
  }, [controlPlane, openGoalRunId, refreshKey]);

  // H11: the budget/spend projection (read-only; a failure renders nothing, never a guess).
  useEffect(() => {
    if (controlPlane === null || openGoalRunId === null) {
      setBudgetRead(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const read = await loadGoalBudget(controlPlane, openGoalRunId).catch(() => null);
      if (!cancelled) setBudgetRead(read);
    })();
    return () => {
      cancelled = true;
    };
  }, [controlPlane, openGoalRunId, refreshKey]);

  // The derived readiness projection (Settings / Diagnostics / blocker routing).
  useEffect(() => {
    if (workflow === null || view !== 'settings') return;
    let cancelled = false;
    void (async () => {
      const response = (await workflow
        .workflowRequest({ operation: 'runtime.readiness' })
        .catch(() => ({ ok: false }))) as {
        readonly ok: boolean;
        readonly value?: unknown;
      };
      if (cancelled || response.ok !== true || response.value === undefined) {
        if (!cancelled) setReadinessRows(null);
        return;
      }
      const value = response.value as Record<string, unknown>;
      const row = (key: string, label: string): ReadinessRow | null => {
        const entry = value[key];
        if (typeof entry !== 'object' || entry === null) return null;
        const record = entry as Record<string, unknown>;
        return {
          label,
          state: (record['state'] as ReadinessRow['state']) ?? 'NOT_CONFIGURED',
          detail: typeof record['detail'] === 'string' ? (record['detail'] as string) : '',
        };
      };
      const rows = [
        row('provider', '模型提供商'),
        row('model', '模型选择'),
        row('executor', '执行器'),
        row('workspace', '工作空间'),
      ].filter((entry): entry is ReadinessRow => entry !== null);
      setReadinessRows(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [workflow, view, refreshKey]);

  // Platform facts for the About section (Electron / Node versions).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await bridge?.platformInfo?.().catch(() => undefined);
      if (cancelled || info === undefined || info === null) return;
      setPlatformInfo({ electron: info.electron, nodeVersion: info.node });
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  /** The ONE canonical approval command. The renderer never resumes the run itself. */
  const decideApproval = useCallback(
    async (decision: ApprovalDecision) => {
      if (controlPlane === null || pendingApprovalDecision === null || approvalInFlight.current) return;
      const approval = pendingApprovalOf(pendingApprovalDecision);
      if (approval === null) return;
      approvalInFlight.current = true;
      setApprovalBusy(true);
      setApprovalFailure(null);
      try {
        // UI-AUDIT-04: name the approval row the user saw; main refuses a stale one typed.
        const result = await respondToApproval(controlPlane, {
          runId: approval.runId,
          decision,
          approvalId: approval.id,
        });
        if (!result.ok) setApprovalFailure({ code: result.code ?? 'APPROVAL_RESPOND_FAILED', message: result.message ?? '审批提交失败。' });
      } catch {
        setApprovalFailure({ code: 'APPROVAL_RESPOND_FAILED', message: '审批提交结果未确认（通信失败），请刷新后重试。' });
      } finally {
        // AUDIT R7: never leave 批准/拒绝 disabled forever.
        approvalInFlight.current = false;
        setApprovalBusy(false);
      }
      await loadPendingDecisionsNow().catch(() => undefined);
      setRefreshKey((key) => key + 1);
    },
    [controlPlane, pendingApprovalDecision, loadPendingDecisionsNow],
  );

  /** AUDIT-R1: the ONE cancel command for the open Goal (single-flight; main records the durable intent). */
  const cancelGoal = useCallback(async () => {
    const goalRunId = openGoalRunId;
    if (controlPlane === null || goalRunId === null || cancelInFlight.current) return;
    cancelInFlight.current = true;
    setCancelBusy(true);
    setCancelFailure(null);
    try {
      const response = (await controlPlane.controlPlaneRequest({
        operation: 'goal.cancel',
        payload: { companyId: COMPANY_ID, runId: goalRunId },
      })) as BridgeEnvelope<{ readonly accepted?: boolean }>;
      if (selectedGoal.current !== goalRunId) return;
      if (response.ok === true) {
        setCancelRequestedFor(goalRunId);
        setCancelConfirming(false);
      } else {
        setCancelFailure({ code: response.error?.code ?? 'GOAL_CANCEL_FAILED', message: response.error?.message ?? '取消请求未被接受。' });
      }
    } catch {
      if (selectedGoal.current === goalRunId) setCancelFailure({ code: 'IPC_FAILED', message: '取消请求结果未确认（通信失败），请刷新后查看。' });
    } finally {
      cancelInFlight.current = false;
      setCancelBusy(false);
      setRefreshKey((key) => key + 1);
    }
  }, [controlPlane, openGoalRunId]);

  /** Bounded artifact actions: the renderer names a canonical artifact id only. */
  const runArtifact = useCallback(
    async (operation: 'preview' | 'open' | 'reveal', artifactId: string, kind: string) => {
      if (bridge === null || typeof bridge.artifactAction !== 'function') {
        setArtifactFailure({ code: 'ARTIFACT_SURFACE_UNAVAILABLE', message: '产物表面需要桌面外壳。' });
        return;
      }
      setArtifactFailure(null);
      // AUDIT R8: a response that returns after the user opened another Goal is dropped.
      const owner = selectedGoal.current;
      const result = await runArtifactAction(
        {
          artifactAction: (request) =>
            bridge.artifactAction!(request).catch((error: unknown) => ({
              ok: false,
              code: IPC_FAILED,
              message: `与主进程通信失败（${error instanceof Error ? error.message : 'UNKNOWN'}），操作结果未确认。`,
            })),
        },
        operation,
        { artifactId, kind },
      );
      if (selectedGoal.current !== owner) return;
      if (!result.ok) {
        setArtifactPreview(null);
        setArtifactFailure({ code: result.code ?? 'ARTIFACT_ACTION_FAILED', message: result.message ?? '操作失败。' });
        return;
      }
      if (operation === 'preview' && result.value !== undefined) {
        setArtifactPreview({
          artifactId,
          kind: result.value.kind,
          text: result.value.text,
          truncated: result.value.truncated,
        });
      }
    },
    [bridge],
  );


  // UI-AUDIT-10: the open Goal's own canonical objective wins; the recent list (which may
  // not have caught up yet, e.g. right after creation) is only a fallback.
  const selectedRecent = useMemo(
    () => recent.find((goal) => goal.runId === openGoalRunId) ?? null,
    [recent, openGoalRunId],
  );
  const selectedObjective = useMemo(() => {
    if (openGoalRunId === null) return null;
    const own = runtimeWorkspace?.runId === openGoalRunId ? runtimeWorkspace.goal?.objective ?? null : null;
    return own ?? selectedRecent?.objective ?? null;
  }, [openGoalRunId, runtimeWorkspace, selectedRecent]);

  const conversation = useMemo(
    () =>
      runtimeWorkspace === null || selectedObjective === null
        ? []
        : projectConversation(runtimeWorkspace, selectedObjective, runtimeTimeline),
    [runtimeWorkspace, selectedObjective, runtimeTimeline],
  );

  const lifecycle = useMemo(
    () => (runtimeWorkspace === null ? null : projectRuntimeLifecycle(runtimeWorkspace)),
    [runtimeWorkspace],
  );

  // STAGE 3: the canonical `run.usage` projection feeds the popover. Anything it does
  // not prove stays null/empty, so the popover renders "--" instead of an invention.
  const usage = usageProjection;
  const knownInput = usage === null ? null : usage.usage.knownInputTokens;
  const knownOutput = usage === null ? null : usage.usage.knownOutputTokens;
  const modelSnapshot: ModelRuntimeSnapshot = useMemo(() => {
    const selectedKey = modelStatus.kind === 'selected' ? modelStatus.modelKey : null;
    const selected = modelOptions.find((option) => option.modelKey === selectedKey) ?? null;
    return {
        model:
          selected === null
            ? null
            : {
                modelKey: selected.modelKey ?? `${selected.providerId}/${selected.providerModelId}`,
                displayName: selected.displayName,
                providerId: selected.providerId,
                contextWindow: selected.contextWindow,
                price:
                  selected.priceInput === null && selected.priceOutput === null
                    ? null
                    : { inputPerMillion: selected.priceInput, outputPerMillion: selected.priceOutput },
                availability: 'available',
              },
        // KNOWN Goal usage only: an observed true zero stays 0 (never "--"), a missing
        // projection stays null (UNKNOWN → "--").
        usedTokens: knownInput === null || knownOutput === null ? null : knownInput + knownOutput,
        // Current-context occupancy is NOT provable from cumulative Goal usage (S3-27): it
        // stays null so the popover renders "--" instead of an invented percentage.
        contextUsedTokens: null,
        // No authoritative cached-token source exists anywhere → always null.
        cachedTokens: null,
        speedSamples: usage === null ? [] : usage.speed.samples,
        inputTokens: knownInput,
        outputTokens: knownOutput,
        // AUDIT session cost: a cost is only computed over complete usage coverage.
        usageComplete: usage !== null && usage.usage.complete,
      };
    }, [modelOptions, modelStatus, usageProjection]);

  // STAGE 3: the honest usage note under the popover (coverage truth, never a false total).
  const telemetry = useMemo(() => projectTelemetry(usageProjection, null), [usageProjection]);
  const telemetryNote = telemetry.note;
  // UI-AUDIT-26: the session cost is main's canonical usage cost (format.ts sessionCostText).
  const sessionCost = useMemo(() => sessionCostText(usageProjection), [usageProjection]);

  const modelLabel = modelStatus.kind === 'selected' ? (modelStatus.displayName ?? modelStatus.modelKey) : '选择模型';
  const modelReady = modelStatus.kind === 'selected';
  const modelView = useMemo(() => ({ ...projectModelRuntime(modelSnapshot), cost: sessionCost }), [modelSnapshot, sessionCost]);
  const databaseFailure = readDatabaseFailure(database?.failure);

  /* ------------------------------------------------------- goal page facts --- */
  const openWorkspace = runtimeWorkspace !== null && runtimeWorkspace.runId === openGoalRunId ? runtimeWorkspace : null;
  const goalOutcome = openWorkspace === null ? null : terminalOutcomeOf(openWorkspace.overview);
  const goalLive = openWorkspace !== null && openWorkspace.overview != null && goalOutcome === null;
  const cancelRequested = openWorkspace?.cancellationRequested === true || (openGoalRunId !== null && cancelRequestedFor === openGoalRunId);
  const planSteps = useMemo(
    () =>
      budgetRead?.plan == null || lifecycle === null
        ? null
        : projectPlanSteps({ items: budgetRead.plan.items, execution: executionOverview, phase: lifecycle.phase, outcome: goalOutcome }),
    [budgetRead, executionOverview, lifecycle, goalOutcome],
  );
  const progress = executionOverview?.progress ?? openWorkspace?.overview?.progress ?? null;
  const stageProgress = executionOverview?.progress?.stagesTotal === undefined
    ? null
    : { done: executionOverview.progress.stagesTerminalSuccessful ?? 0, total: executionOverview.progress.stagesTotal };
  const goalHeader = openWorkspace === null || lifecycle === null
    ? null
    : {
        stateWord: lifecycle.phase === 'idle' ? goalStateWord({ state: openWorkspace.planningRun?.state ?? '' }) : PHASE_LABELS[lifecycle.phase],
        live: goalLive,
        runId: openWorkspace.runId,
        tasksText: progress === null || progress.tasksTotal === 0 ? null : `任务 ${String(progress.tasksDone)}/${String(progress.tasksTotal)} 完成`,
        startedText: startedAtText(selectedRecent?.createdAt ?? null),
      };
  const liveLine = (() => {
    if (!goalLive || lifecycle === null || pendingApprovalDecision !== null || cancelRequested) return null;
    if (lifecycle.phase === 'planning') return '正在规划…';
    const running = executionOverview?.executing[0] ?? null;
    if (running === null) return null;
    const step = budgetRead?.plan?.items.find((item) => item.stageId !== null && item.stageId === running.stageId) ?? null;
    return `正在执行 · ${step === null ? `任务 ${running.taskId}` : goalTitleOf(step.objective === '' ? step.planItemId : step.objective).title}${running.attempt === null ? '' : ` · 尝试 ${String(running.attempt.attemptNumber)}`}`;
  })();

  // UI-AUDIT-07: a NEW pending request takes focus once (announced; no button pre-focused) and
  // a stale failure of the previous request is cleared.
  const pendingApprovalId = pendingApprovalDecision === null ? null : pendingApprovalOf(pendingApprovalDecision)?.id ?? null;
  const focusedApproval = useRef<string | null>(null);
  useEffect(() => {
    if (pendingApprovalId === null || focusedApproval.current === pendingApprovalId) return;
    if (focusedApproval.current !== null) setApprovalFailure(null);
    focusedApproval.current = pendingApprovalId;
    const doc = (globalThis as { document?: { querySelector?: (selector: string) => { focus?: () => void } | null } }).document;
    const card = typeof doc?.querySelector === 'function' ? doc.querySelector(`[data-approval-id="${pendingApprovalId}"]`) : null;
    if (card !== null && typeof card?.focus === 'function') card.focus();
  }, [pendingApprovalId]);

  /* ---------------------------------------------------------- new goal --- */
  // UI-AUDIT-03: 新建目标 never discards an unconfirmed submission (a later resubmission could
  // duplicate a Goal main already created) and never throws away the user's typed text.
  const startNewGoal = useCallback(() => {
    if (submissionInFlight.current) return;
    setOpenGoalRunId(null);
    setView('chat');
    setPopover(null);
    const doc = (globalThis as { document?: { querySelector?: (selector: string) => { focus?: () => void } | null } }).document;
    const field = typeof doc?.querySelector === 'function' ? doc.querySelector('[data-testid="goal-objective"]') : null;
    if (field !== null && typeof field?.focus === 'function') field.focus();
  }, []);
  // UI-AUDIT-23: Ctrl+N (⌘N) is the shortcut the sidebar button advertises; never during IME composition.
  useEffect(() => {
    type KeyTarget = { addEventListener?: (type: string, fn: (event: KeyboardEventLike) => void) => void; removeEventListener?: (type: string, fn: (event: KeyboardEventLike) => void) => void };
    const target = ((globalThis as { window?: KeyTarget }).window ?? globalThis) as KeyTarget;
    if (typeof target.addEventListener !== 'function') return;
    const onKey = (event: KeyboardEventLike): void => {
      if (event.isComposing === true || event.altKey === true || event.shiftKey === true) return;
      if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault?.();
        startNewGoal();
      }
    };
    target.addEventListener('keydown', onKey);
    return () => target.removeEventListener?.('keydown', onKey);
  }, [startNewGoal]);

  /* --------------------------------------------------------------- render --- */
  if (controlPlane === null || workspaceSelection === null || workflow === null) {
    return h(
      'main',
      { className: 'shell shell--onboarding' },
      h(
        'section',
        { className: 'card onboarding-card' },
        h('h1', null, 'CompanyOS'),
        h('p', null, `bridge ${availability} · appVersion ${version}`),
        h('p', { className: 'muted' }, '目标工作区需要桌面外壳（此处无 preload bridge）。'),
      ),
    );
  }

  if (workspaceRoot === null) {
    return h(
      'main',
      { className: 'shell shell--onboarding' },
      h(
        'section',
        { className: 'card onboarding-card' },
        h('h1', null, 'CompanyOS'),
        h('p', { className: 'shell__tagline' }, '选择一个工作空间目录后开始你的第一个目标。'),
        h(WorkspaceSelector, { selection: workspaceSelection, onWorkspaceOpened: setWorkspaceRoot }),
      ),
    );
  }

  // UI-AUDIT-13: the model card is shown only when it needs the user (nothing selected, or the
  // feedback of a choice just made) — not as a permanent block on every Goal.
  const onboarding = modelStatus.kind !== 'selected' || modelFailure !== null || modelExplanation !== null
    ? h(ModelOnboardingView, {
        status: modelStatus,
        options: modelOptions,
        selectedProviderModelId: null,
        busy: modelBusy,
        failure: modelFailure,
        explanation: modelExplanation,
        onSelect: (option: ModelOptionRow) => void chooseModel(option),
        onOpenSettings: () => setView('settings'),
      })
    : null;

  const approvalBlock = pendingApprovalDecision === null
    ? null
    : h(ApprovalCardView, {
        decision: pendingApprovalDecision,
        busy: approvalBusy,
        failure: approvalFailure,
        cancelRequested,
        scopeNote: ACCESS_POLICY_OPTIONS.find((option) => option.value === openWorkspace?.accessPolicy)?.label === undefined
          ? null
          : `策略 ${ACCESS_POLICY_OPTIONS.find((option) => option.value === openWorkspace?.accessPolicy)!.label}`,
        onDecide: (decision: ApprovalDecision) => void decideApproval(decision),
      });

  const otherApprovals = otherPendingApprovals.length === 0
    ? null
    : h(
        'div',
        { className: 'other-approvals', role: 'status', 'data-testid': 'other-goal-approvals' },
        h('p', null, `其他目标待批准 · ${otherPendingApprovals.length} 项（在左侧打开对应目标后处理）`),
        h('ul', null, otherPendingApprovals.map((decision) => h('li', { key: decision.runId }, `${pendingApprovalOf(decision)?.reason ?? '需要批准'} · 范围 Run ${decision.runId}`))),
      );

  const goalList = h(GoalList, {
    bridge: controlPlane,
    onOpen: (runId: string) => {
      setOpenGoalRunId(runId);
      setView('chat');
    },
    refreshKey,
    onRefreshTick: () => setRefreshKey((key) => key + 1),
  });

  const reuseObjective = goalOutcome !== null && selectedObjective !== null
    ? () => {
        if (draft.trim() !== '') return;
        setDraft(selectedObjective);
        setView('chat');
      }
    : null;

  const conversationView = h(ChatView, {
    objective: selectedObjective,
    entries: conversation,
    loading: runtimeWorkspace === null && openGoalRunId !== null && runtimeReadFailure === null,
    // AUDIT R3: only the open Goal's read failure here; action failures
    // (submission / workspace / model) have their own line in the dock.
    failure: runtimeReadFailure,
    header: goalHeader,
    createdAt: selectedRecent?.createdAt ?? null,
    planSteps,
    criteria: budgetRead?.plan?.criteria ?? null,
    approval: approvalBlock,
    liveLine,
    onReuseObjective: reuseObjective,
    reuseDisabledReason: reuseObjective !== null && draft.trim() !== '' ? '输入框里已有内容' : null,
  });

  const center =
    view === 'settings'
      ? h(SettingsView, {
          workspaceRoot,
          modelStatus,
          catalogueCount,
          registeredCount: modelOptions.filter((option) => option.registered).length,
          appVersion: version,
          databasePath: database?.path ?? null,
          schemaVersion: database?.schemaVersion ?? null,
          allowedChannels: bridge === null ? [] : bridge.channels(),
          readiness: readinessRows,
          authority,
          electronVersion: platformInfo?.electron ?? null,
          nodeVersion: platformInfo?.nodeVersion ?? null,
          // The model selector is the composer's popover; it opens where the user is.
          onOpenModelSelector: () => setPopover('model'),
          onChangeWorkspace: changeWorkspace,
        })
      : view === 'tools'
        ? h(ToolsSurfaceView, { rows: toolRows, failure: surfaceFailure })
        : view === 'knowledge'
          ? h(KnowledgeSurfaceView, { rows: knowledgeRows, failure: surfaceFailure })
          : view === 'agents'
            ? h(AgentsSurfaceView, { rows: agentRows, failure: surfaceFailure })
            : view === 'home'
              // UI-AUDIT-11: 首页 = the start prompt + every Goal; it never re-renders the open Goal.
              ? h(
                  'div',
                  { className: 'chat-column home' },
                  onboarding,
                  otherApprovals,
                  h(ChatView, { objective: null, entries: [], loading: false, failure: null }),
                  goalList,
                )
              : h(
                  'div',
                  { className: 'chat-column' },
                  onboarding,
                  otherApprovals,
                  conversationView,
                );

  const viewLabel = SHELL_NAV.find((item) => item.id === view)?.label ?? (view === 'settings' ? '设置' : '');
  const crumbs = view === 'chat'
    ? (selectedObjective === null ? ['对话与任务', openGoalRunId === null ? '新目标' : '读取中…'] : ['对话与任务', goalTitleOf(selectedObjective).title])
    : [viewLabel];
  const topbar = h(TopBarView, {
    crumbs,
    actions: view !== 'chat' || openWorkspace === null
      ? null
      : [
          h(GoalElapsed, { key: 'elapsed', since: selectedRecent?.createdAt ?? null, live: goalLive }),
          h(GoalCancelControl, {
            key: 'cancel',
            visible: goalLive,
            requested: cancelRequested,
            confirming: cancelConfirming,
            busy: cancelBusy,
            failure: cancelFailure,
            approvalPending: pendingApprovalDecision !== null,
            onRequest: () => setCancelConfirming(true),
            onConfirm: () => void cancelGoal(),
            onDismiss: () => setCancelConfirming(false),
          }),
        ],
  });

  const blockedReason = databaseFailure !== null
    ? '本地数据库不可用，暂时不能创建目标（见上方说明）。'
    : modelStatus.kind === 'provider-not-configured'
      ? '尚未配置模型提供商：请在开始菜单运行「CompanyOS 首次配置」，完成后重新打开 CompanyOS。'
      : !modelReady
        ? '先选择公司模型（输入框右下角）后才能发送。'
        : null;

  return h(AppShellView, {
    view,
    runtimeCollapsed: !runtimeExpanded,
    topbar,
    // UI-AUDIT-09: the database failure is visible on every view, not only on 首页.
    banner: h(DatabaseFailureBanner, { failure: databaseFailure }),
    sidebar: {
      view,
      recent,
      activeGoalRunId: openGoalRunId,
      busy: submissionBusy,
      appVersion: version,
      workspaceRoot,
      approvalPendingRunIds: pendingApprovalDecision === null || openGoalRunId === null ? new Set<string>() : new Set([openGoalRunId]),
      onNewGoal: startNewGoal,
      onNavigate: (next: ShellView) => setView(next),
      onOpenGoal: (runId: string) => {
        setOpenGoalRunId(runId);
        setView('chat');
      },
    },
    center,
    composer: h(
      'div',
      { className: 'composer-dock' },
      h(ActionFailureLine, {
        failures: [
          submissionFailure,
          // The chat column already shows the model failure in the onboarding card.
          view === 'home' || view === 'chat' ? null : modelFailure,
        ],
      }),
      h(ComposerView, {
        draft,
        ready: modelReady && workspaceRoot !== null && !pendingIntent && databaseFailure === null,
        busy: submissionBusy,
        authority,
        nextPolicy: selectedAccessPolicy,
        modelLabel,
        workspaceLabel: workspaceRoot,
        pendingIntent,
        pendingObjective,
        onRetryPending: () => void retryPending(),
        onDiscardPending: discardPending,
        onDraftChange: setDraft,
        onSubmit: () => void sendGoal(),
        onChangeWorkspace: changeWorkspace,
        onOpenTools: () => setView('tools'),
        onOpenAuthority: () => setPopover(popover === 'authority' ? null : 'authority'),
        onOpenModel: () => setPopover(popover === 'model' ? null : 'model'),
        authorityOpen: popover === 'authority',
        modelOpen: popover === 'model',
        blockedReason,
        footHint: openGoalRunId !== null && view === 'chat'
          ? '发送会创建一个新目标，当前目标不受影响；高风险操作会停在批准边界，由你决定'
          : '高风险操作会停在批准边界，由你决定',
        sessionCost: openGoalRunId === null ? null : modelView.cost,
        popovers: [
          h(AuthorityPopover, {
            key: 'authority',
            authority,
            open: popover === 'authority',
            selectedPolicy: selectedAccessPolicy,
            onSelectPolicy: (policy) => {
              setSelectedAccessPolicy(policy);
              setPopover(null);
            },
            onClose: () => setPopover(null),
            // AUDIT-R4: only the open Goal's canonical read-back - never a default when it is unknown.
            effectiveGoalPolicy:
              ACCESS_POLICY_OPTIONS.find((option) => option.value === runtimeWorkspace?.accessPolicy)?.label ?? null,
          }),
          h(ModelSelectorView, {
            key: 'model',
            triggerless: true,
            options: modelOptions,
            selectedModelKey: modelStatus.kind === 'selected' ? modelStatus.modelKey : null,
            open: popover === 'model',
            busy: modelBusy,
            onToggle: () => setPopover(popover === 'model' ? null : 'model'),
            onChoose: (option: ModelOptionRow) => void chooseModel(option),
            onOpenSettings: () => {
              setPopover(null);
              setView('settings');
            },
            providerConfigured: modelOptions.length > 0,
          }),
        ],
        extras: h(
          'div',
          { className: 'composer__extras' },
          h(
            'details',
            { className: 'composer__details' },
            h('summary', null, deliveryPath.trim() === '' && deliveryText === '' ? '文件交付要求（可选）' : '文件交付要求（已填写）'),
            h('fieldset', { disabled: submissionBusy, 'data-testid': 'file-delivery-requirement', 'aria-label': '文件交付要求' },
              h('legend', { className: 'sr-only' }, '文件交付要求（可选）'),
              h('label', null, '相对文件路径', h('input', { value: deliveryPath, 'data-testid': 'delivery-path', onChange: (e: { target: { value: string } }) => setDeliveryPath(e.target.value) })),
              h('label', null, '期望内容（UTF-8，逐字匹配）', h('textarea', { value: deliveryText, 'data-testid': 'delivery-content', onChange: (e: { target: { value: string } }) => setDeliveryText(e.target.value) })),
              h('p', { className: 'muted' }, '文件要求仅随明确提交发送，不包含在本地文字草稿中。')),
          ),
          h(LocalDraftControls, { companyId: COMPANY_ID, workspaceRoot, objective: draft, busy: submissionBusy, onRestore: setDraft }),
        ),
      }),
    ),
    runtime: h(RuntimePanelView, {
      open: true,
      expanded: runtimeExpanded,
      tab: runtimeTab,
      lifecycle,
      artifacts: runtimeArtifacts,
      timeline: runtimeTimeline,
      taskDetail: runtimeTask,
      budget: budgetRead,
      model: openGoalRunId === null ? null : modelView,
      usageNote: telemetryNote,
      stageProgress,
      // STAGE 3 — canonical blockers + the pending approval behind them.
      blockers: runtimeWorkspace?.blockers ?? [],
      pendingApproval:
        pendingApprovalDecision === null
          ? null
          : (() => {
              const approval = pendingApprovalOf(pendingApprovalDecision);
              return approval === null
                ? null
                : { riskLevel: approval.riskLevel, reason: approval.reason, runId: approval.runId };
            })(),
      onToggleExpanded: () => setRuntimeExpanded((value) => !value),
      onSelectTab: (tab: RuntimeTab) => setRuntimeTab(tab),
      onSelectTask: (taskId: string) => {
        setRuntimeTab('detail');
        void loadTaskDetail(taskId);
      },
      // STAGE 3 — bounded artifact actions (canonical artifact id only).
      onArtifactPreview: (artifactId: string, kind: string) => void runArtifact('preview', artifactId, kind),
      onArtifactOpen: (artifactId: string, kind: string) => void runArtifact('open', artifactId, kind),
      onArtifactReveal: (artifactId: string, kind: string) => void runArtifact('reveal', artifactId, kind),
      artifactPreview,
      artifactFailure,
    }),
  });
}

interface KeyboardEventLike {
  readonly key?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly preventDefault?: () => void;
}
