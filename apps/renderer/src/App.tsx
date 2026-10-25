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
import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  FALLBACK_APP_VERSION,
  bridgeAvailability,
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
  ModelRuntimePopover,
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
import { createSubmissionController, type SubmissionController } from './submission-intent.js';
import { createSubmissionIntentStore } from './intent-store.js';
import { LocalDraftControls } from './local-draft-controls.js';
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
import type { ModelRuntimeSnapshot } from './telemetry.js';
import { GoalList, WorkspaceSelector, type ControlPlaneBridge, type WorkspaceSelectionBridge } from './workspace.js';
import { createRuntimeReadBudget, RuntimeReadError } from './runtime-read-budget.js';

/** Bounded, read-only, lifecycle-bound polling — never workflow authority. */
const GOAL_POLL_INTERVAL_MS = 4_000;
const COMPANY_ID = 'company_default';
const TERMINAL_RUN_STATES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

interface BridgeEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code?: string; readonly message?: string };
}

export function App() {
  const [version, setVersion] = useState<string>(FALLBACK_APP_VERSION);
  const [database, setDatabase] = useState<DatabaseStatus | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
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
  const [catalogueCount, setCatalogueCount] = useState(0);
  const [pendingIntent, setPendingIntent] = useState(false);
  const [popover, setPopover] = useState<'model' | 'authority' | 'runtime' | null>(null);
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);
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
        ? { workflowRequest: (request) => (bridge.workflowRequest as NonNullable<typeof bridge.workflowRequest>)(request) }
        : null,
    [bridge],
  );
  const controlPlane: ControlPlaneBridge | null = useMemo(
    () =>
      bridge !== null && typeof bridge.controlPlaneRequest === 'function'
        ? { controlPlaneRequest: (request) => (bridge.controlPlaneRequest as NonNullable<typeof bridge.controlPlaneRequest>)(request) }
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
            workspaceOpen: (root) => (bridge.workspaceOpen as NonNullable<typeof bridge.workspaceOpen>)(root),
            workspaceCurrent: () => (bridge.workspaceCurrent as NonNullable<typeof bridge.workspaceCurrent>)(),
            workspaceSwitch: (root) => (bridge.workspaceSwitch as NonNullable<typeof bridge.workspaceSwitch>)(root),
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
    void refreshModels();
  }, [refreshModels]);

  const chooseModel = useCallback(
    async (option: ModelOptionRow) => {
      if (workflow === null) return;
      setModelBusy(true);
      setModelExplanation(null);
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
        setSubmissionFailure({ code: result.code, message: result.message });
      }
      setModelBusy(false);
      setPopover(null);
      await refreshModels();
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
      const picked = await workspaceSelection.workspaceSelect().catch(() => null);
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
    async (input: { intentId: string; objective: string; workspaceRoot: string; structured?: Readonly<Record<string, unknown>> }): Promise<{ runId: string } | { error: string }> => {
      if (controlPlane === null) return { error: 'CONTROL_PLANE_UNAVAILABLE' };
      const response = (await controlPlane.controlPlaneRequest({
        operation: 'goal.create',
        payload: {
          companyId: COMPANY_ID,
          objective: input.objective,
          ...(input.structured === undefined ? {} : { structured: input.structured }),
          commandId: input.intentId,
          accessPolicy: selectedAccessPolicy,
        },
      })) as BridgeEnvelope<{ readonly runId: string }>;
      if (!response.ok || response.value === undefined) {
        return { error: response.error?.message ?? 'goal.create failed' };
      }
      return { runId: response.value.runId };
    },
    [controlPlane, selectedAccessPolicy],
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
    setPendingIntent(controllerRef.current?.pending() !== null && controllerRef.current?.pending() !== undefined);
  }, []);

  // STAGE 2 case C: resolve an intent that survived a remount/reload BEFORE any new
  // submission is accepted, so an unacknowledged submission replays instead of duplicating.
  useEffect(() => {
    syncPending();
    const active = controllerRef.current;
    if (active === null) return;
    void (async () => {
      const result = await active.resolvePending();
      if (result !== null && (result.status === 'created' || result.status === 'replayed')) {
        setOpenGoalRunId(result.runId);
        setRefreshKey((key) => key + 1);
      }
      syncPending();
    })();
    // Mount-only on purpose: resolving an unacknowledged intent is a STARTUP action, so it
    // must never re-run because some unrelated state changed (that was the hot-replay loop
    // the real-boot smoke caught: 4095 replays of one submission intent).
  }, []);

  const sendGoal = useCallback(async () => {
    const active = controllerRef.current;
    if (active === null || workspaceRoot === null || submissionInFlight.current) return;
    submissionInFlight.current = true;
    setSubmissionBusy(true);
    setSubmissionFailure(null);
    try {
      const structured = await fileDeliveryConstraints(deliveryPath, deliveryText);
      if (workspaceIdentity.current !== workspaceRoot) throw new Error('WORKSPACE_CHANGED_BEFORE_SUBMIT');
      const result = await active.submitObjective(draft, workspaceRoot, structured);
      syncPending();
      if (result.status === 'created' || result.status === 'replayed') {
        setDraft('');
        setOpenGoalRunId(result.runId);
        setRefreshKey((key) => key + 1);
        // Autonomy continues in the main process; the client only observes canonical state.
      } else if (result.status === 'failed') {
        setSubmissionFailure({ code: 'GOAL_CREATE_FAILED', message: result.error });
      } else if (result.status === 'blocked' && result.reason === 'pending') {
        setSubmissionFailure({ code: 'SUBMISSION_PENDING', message: '上一次提交尚未确认，请稍候。' });
      }
    } catch {
      setSubmissionFailure({ code: 'DELIVERY_INPUT_INVALID', message: '文件要求或本地提交存储不可用；请检查相对路径与期望内容。未确认提交。' });
    } finally {
      submissionInFlight.current = false;
      setSubmissionBusy(false);
    }
  }, [draft, workspaceRoot, syncPending, deliveryPath, deliveryText]);

  /* ------------------------------------------------- canonical projections --- */
  const loadRecent = useCallback(async () => {
    if (controlPlane === null) return;
    const response = (await controlPlane.controlPlaneRequest({
      operation: 'home.summary',
      payload: { companyId: COMPANY_ID },
    })) as BridgeEnvelope<{ readonly goals: readonly { runId: string; state: string; objective: string | null }[] }>;
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
    setRuntimeReadFailure(null);
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
      return;
    }
    const goalRunId = openGoalRunId;
    const observed = currentWorkspace.current;
    if (observed?.runId === goalRunId && observed.overview !== null &&
        TERMINAL_RUN_STATES.includes(observed.overview.state as never)) return;
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
    void loadRecent();
  }, [loadRecent, refreshKey]);

  // The current Goal's runtime projections ride the SAME controlled refresh as every
  // other projection (DRA-05): a tick re-reads goal.workspace / run.timeline /
  // run.artifacts for the Goal that is open NOW.
  useEffect(() => {
    void loadRuntime();
  }, [loadRuntime, refreshKey]);

  const hasLiveRun =
    openGoalRunId !== null &&
    (runtimeWorkspace?.overview == null || !TERMINAL_RUN_STATES.includes(runtimeWorkspace.overview.state as never));
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
  const pendingApprovalDecision = useMemo(
    () => pendingDecisions.find((decision) => pendingApprovalOf(decision) !== null) ?? null,
    [pendingDecisions],
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
    void loadPendingDecisionsNow();
  }, [loadPendingDecisionsNow, refreshKey]);

  // The Goal usage projection (E1 semantics) for the selected Goal.
  useEffect(() => {
    if (controlPlane === null || openGoalRunId === null) {
      setUsageProjection(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const projection = await loadGoalUsage(controlPlane, openGoalRunId);
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
      const response = (await workflow.workflowRequest({ operation: 'runtime.readiness' })) as {
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
      const info = await bridge?.platformInfo?.();
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
      if (controlPlane === null || pendingApprovalDecision === null) return;
      const approval = pendingApprovalOf(pendingApprovalDecision);
      if (approval === null) return;
      setApprovalBusy(true);
      setApprovalFailure(null);
      const result = await respondToApproval(controlPlane, {
        runId: approval.runId,
        decision,
      });
      if (!result.ok) setApprovalFailure({ code: 'APPROVAL_RESPOND_FAILED', message: result.message ?? '审批提交失败。' });
      setApprovalBusy(false);
      await loadPendingDecisionsNow();
      setRefreshKey((key) => key + 1);
    },
    [controlPlane, pendingApprovalDecision, loadPendingDecisionsNow],
  );

  /** Bounded artifact actions: the renderer names a canonical artifact id only. */
  const runArtifact = useCallback(
    async (operation: 'preview' | 'open' | 'reveal', artifactId: string, kind: string) => {
      if (bridge === null || typeof bridge.artifactAction !== 'function') {
        setArtifactFailure({ code: 'ARTIFACT_SURFACE_UNAVAILABLE', message: '产物表面需要桌面外壳。' });
        return;
      }
      setArtifactFailure(null);
      const result = await runArtifactAction(
        { artifactAction: (request) => bridge.artifactAction!(request) },
        operation,
        { artifactId, kind },
      );
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


  const selectedObjective = useMemo(
    () => recent.find((goal) => goal.runId === openGoalRunId)?.objective ?? null,
    [recent, openGoalRunId],
  );

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
      };
    }, [modelOptions, modelStatus, usageProjection]);

  // STAGE 3: the honest usage note under the popover (coverage truth, never a false total).
  const telemetryNote = useMemo(() => projectTelemetry(usageProjection, null).note, [usageProjection]);

  const modelLabel = modelStatus.kind === 'selected' ? (modelStatus.displayName ?? modelStatus.modelKey) : '选择模型';
  const modelReady = modelStatus.kind === 'selected';

  /* --------------------------------------------------------------- render --- */
  if (controlPlane === null || workspaceSelection === null || workflow === null) {
    return h(
      'main',
      { className: 'shell' },
      h(
        'section',
        { className: 'card' },
        h('h2', null, 'Desktop Bridge'),
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
        { className: 'card' },
        h('h1', null, 'CompanyOS'),
        h('p', { className: 'shell__tagline' }, '选择一个工作空间目录后开始你的第一个目标。'),
        h(WorkspaceSelector, { selection: workspaceSelection, onWorkspaceOpened: setWorkspaceRoot }),
      ),
    );
  }

  const onboarding = h(ModelOnboardingView, {
    status: modelStatus,
    options: modelOptions,
    selectedProviderModelId: null,
    busy: modelBusy,
    failure: null,
    explanation: modelExplanation,
    onSelect: (option: ModelOptionRow) => void chooseModel(option),
    onOpenSettings: () => setView('settings'),
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
          onOpenModelSelector: () => {
            setView('home');
            setPopover('model');
          },
          onChangeWorkspace: changeWorkspace,
        })
      : view === 'tools'
        ? h(ToolsSurfaceView, { rows: toolRows, failure: surfaceFailure })
        : view === 'knowledge'
          ? h(KnowledgeSurfaceView, { rows: knowledgeRows, failure: surfaceFailure })
          : view === 'agents'
            ? h(AgentsSurfaceView, { rows: agentRows, failure: surfaceFailure })
            : h(
                'div',
                { className: 'chat-column' },
                onboarding,
                pendingApprovalDecision === null
                  ? null
                  : h(ApprovalCardView, {
                      decision: pendingApprovalDecision,
                      busy: approvalBusy,
                      failure: approvalFailure,
                      onDecide: (decision: ApprovalDecision) => void decideApproval(decision),
                    }),
                h(ChatView, {
                  objective: selectedObjective,
                  entries: conversation,
                  loading: runtimeWorkspace === null && openGoalRunId !== null && runtimeReadFailure === null,
                  failure: submissionFailure ?? runtimeReadFailure,
                }),
                h(GoalList, {
                  bridge: controlPlane,
                  onOpen: (runId: string) => {
                    setOpenGoalRunId(runId);
                    setView('chat');
                  },
                  refreshKey,
                  onRefreshTick: () => setRefreshKey((key) => key + 1),
                }),
              );

  return h(AppShellView, {
    view,
    sidebar: {
      view,
      recent,
      activeGoalRunId: openGoalRunId,
      busy: submissionBusy,
      onNewGoal: () => {
        setOpenGoalRunId(null);
        setView('home');
        setDraft('');
        controllerRef.current?.discard();
        syncPending();
      },
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
      h(AuthorityPopover, {
        authority,
        open: popover === 'authority',
        selectedPolicy: selectedAccessPolicy,
        onSelectPolicy: (policy) => {
          setSelectedAccessPolicy(policy);
          setPopover(null);
        },
        effectiveGoalPolicy:
          ACCESS_POLICY_OPTIONS.find((option) => option.value === (runtimeWorkspace?.accessPolicy ?? 'ASK_PERMISSION'))
            ?.label ?? null,
      }),
      h(ModelSelectorView, {
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
      h(ModelRuntimePopover, {
        snapshot: modelSnapshot,
        open: popover === 'runtime',
        onToggle: () => setPopover(popover === 'runtime' ? null : 'runtime'),
        usageNote: telemetryNote,
      }),
      h('fieldset', { disabled: submissionBusy, 'aria-label': 'file-delivery-requirement' },
        h('legend', null, '文件交付要求（可选）'),
        h('label', null, '相对文件路径', h('input', { value: deliveryPath, 'aria-label': 'delivery-path', onChange: (e: { target: { value: string } }) => setDeliveryPath(e.target.value) })),
        h('label', null, '期望内容（UTF-8，逐字匹配）', h('textarea', { value: deliveryText, 'aria-label': 'delivery-content', onChange: (e: { target: { value: string } }) => setDeliveryText(e.target.value) })),
        h('p', null, '文件要求仅随明确提交发送，不包含在本地文字草稿中。')),
      h(LocalDraftControls, { companyId: COMPANY_ID, workspaceRoot, objective: draft, busy: submissionBusy, onRestore: setDraft }),
      h(ComposerView, {
        draft,
        ready: modelReady && workspaceRoot !== null && !pendingIntent,
        busy: submissionBusy,
        authority,
        modelLabel,
        workspaceLabel: workspaceRoot,
        pendingIntent,
        onDraftChange: setDraft,
        onSubmit: () => void sendGoal(),
        onChangeWorkspace: changeWorkspace,
        onOpenTools: () => setView('tools'),
        onOpenAuthority: () => setPopover(popover === 'authority' ? null : 'authority'),
        onOpenModel: () => setPopover(popover === 'model' ? null : 'model'),
        authorityOpen: popover === 'authority',
        modelOpen: popover === 'model',
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
