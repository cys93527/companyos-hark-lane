/**
 * STAGE 3 — the readiness projection (Settings / Diagnostics / blocker routing).
 *
 * A DERIVED projection, never a second truth: every field is computed from facts the
 * trusted main process already owns (canonical services, durable stores, the composition
 * route). It exists so the client can render an honest operational state — including the
 * canonical external blocker `EXECUTOR_PROVIDER_UNKNOWN` — instead of an error, `undefined`
 * or a fabricated failure.
 */
export type ReadinessState = 'READY' | 'NOT_CONFIGURED' | 'DEGRADED' | 'REQUIRED' | 'ERROR';

export interface ReadinessRow {
  readonly state: ReadinessState;
  readonly detail: string;
  /** Where the user can act, when action is possible at all. */
  readonly action: 'none' | 'settings' | 'model-selector' | 'workspace-selector';
}

export interface ReadinessProjection {
  readonly provider: ReadinessRow;
  readonly model: ReadinessRow;
  readonly executor: ReadinessRow;
  readonly workspace: ReadinessRow;
  /** The single blocking external precondition, when one exists (canonical reason codes). */
  readonly externalBlock: { readonly code: string; readonly detail: string; readonly action: ReadinessRow['action'] } | null;
}

export interface ReadinessFacts {
  readonly providerRegistered: boolean;
  readonly providerHealthy: boolean;
  readonly providerDetail: string;
  readonly modelSelected: boolean;
  readonly modelDetail: string;
  readonly executorConfigured: boolean;
  readonly executorDetail: string;
  readonly workspaceOpen: boolean;
  readonly workspaceDetail: string;
}

/** Pure: the same fact shape yields the same projection, so it is testable without a host. */
export const projectReadiness = (facts: ReadinessFacts): ReadinessProjection => {
  const provider: ReadinessRow = !facts.providerRegistered
    ? { state: 'NOT_CONFIGURED', detail: facts.providerDetail, action: 'settings' }
    : facts.providerHealthy
      ? { state: 'READY', detail: facts.providerDetail, action: 'none' }
      : { state: 'DEGRADED', detail: facts.providerDetail, action: 'settings' };

  const model: ReadinessRow = facts.modelSelected
    ? { state: 'READY', detail: facts.modelDetail, action: 'none' }
    : { state: 'REQUIRED', detail: facts.modelDetail, action: 'model-selector' };

  const executor: ReadinessRow = facts.executorConfigured
    ? { state: 'READY', detail: facts.executorDetail, action: 'none' }
    : { state: 'NOT_CONFIGURED', detail: facts.executorDetail, action: 'settings' };

  const workspace: ReadinessRow = facts.workspaceOpen
    ? { state: 'READY', detail: facts.workspaceDetail, action: 'none' }
    : { state: 'ERROR', detail: facts.workspaceDetail, action: 'workspace-selector' };

  // The first canonical external precondition, in dependency order — never a UI opinion.
  const externalBlock =
    provider.state === 'NOT_CONFIGURED'
      ? { code: 'PROVIDER_NOT_CONFIGURED', detail: provider.detail, action: provider.action }
      : model.state === 'REQUIRED'
        ? { code: 'MODEL_SELECTION_REQUIRED', detail: model.detail, action: model.action }
        : executor.state === 'NOT_CONFIGURED'
          ? { code: 'EXECUTOR_PROVIDER_UNKNOWN', detail: executor.detail, action: executor.action }
          : workspace.state === 'ERROR'
            ? { code: 'WORKSPACE_NOT_OPEN', detail: workspace.detail, action: workspace.action }
            : null;

  return { provider, model, executor, workspace, externalBlock };
};

/** The user-facing label for an external blocker code (canonical codes only). */
export const BLOCKER_LABELS: Readonly<Record<string, string>> = {
  PROVIDER_NOT_CONFIGURED: '尚未配置模型提供商',
  MODEL_SELECTION_REQUIRED: '尚未选择公司模型',
  EXECUTOR_PROVIDER_UNKNOWN: '执行器尚未配置',
  WORKSPACE_NOT_OPEN: '尚未打开工作空间',
};

export const blockerLabel = (code: string): string => BLOCKER_LABELS[code] ?? '外部前置条件未满足';
