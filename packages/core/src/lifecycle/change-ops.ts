/**
 * `applyChangeOps` — the pure graph transformation behind the Workflow Designer
 * (Sprint 5 §三).
 *
 * Properties (all enforced by tests):
 *   - `oldGraph` is never mutated: every result is a fresh object graph;
 *   - deterministic: the same input always yields the same output (no clocks, no ids,
 *     no randomness, no IO, no database, no React/Electron);
 *   - invalid operations fail with an explicit DomainError instead of half-applying.
 *
 * Stage-level attributes (role / validators / risk / approval) live in the node's
 * opaque `config` map, exactly like every other pack-defined setting — Core never
 * interprets them, it only stores what the caller sets.
 */
import { err, ok, type Result } from '../kernel/result.js';
import { domainError, type DomainError } from '../kernel/errors.js';
import { LIFECYCLE_STATES, type LifecycleState } from './machine.js';
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from './version.js';

export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const APPROVAL_MODES = ['auto', 'owner', 'authority'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export interface ApprovalConfig {
  readonly required: boolean;
  readonly mode: ApprovalMode;
  /** Required when `mode === 'authority'`. */
  readonly authority?: string;
}

/** Config keys the Designer owns (kept in the node's opaque config). */
export const STAGE_CONFIG_KEYS = ['roleId', 'validatorIds', 'riskLevel', 'approval'] as const;

export type StageOp =
  | { readonly op: 'ADD_STAGE'; readonly stage: WorkflowNode }
  | { readonly op: 'REMOVE_STAGE'; readonly stageId: string }
  | {
      readonly op: 'UPDATE_STAGE';
      readonly stageId: string;
      readonly kind?: string;
      readonly title?: string;
      readonly config?: Readonly<Record<string, unknown>>;
    }
  | { readonly op: 'CONNECT_STAGE'; readonly from: string; readonly to: string; readonly condition?: string }
  | { readonly op: 'DISCONNECT_STAGE'; readonly from: string; readonly to: string }
  | { readonly op: 'SET_ROLE'; readonly stageId: string; readonly roleId: string | null }
  | { readonly op: 'SET_VALIDATOR'; readonly stageId: string; readonly validatorIds: readonly string[] }
  | { readonly op: 'SET_RISK'; readonly stageId: string; readonly riskLevel: RiskLevel }
  | { readonly op: 'SET_APPROVAL'; readonly stageId: string; readonly approval: ApprovalConfig };

export type StageOpKind = StageOp['op'];

const notFound = (message: string, details: Record<string, unknown>): DomainError =>
  domainError('NOT_FOUND', message, details);
const conflict = (message: string, details: Record<string, unknown>): DomainError =>
  domainError('CONFLICT', message, details);
const invalid = (message: string, details: Record<string, unknown>): DomainError =>
  domainError('VALIDATION_FAILED', message, details);

const withStage = (
  graph: WorkflowGraph,
  stageId: string,
  update: (node: WorkflowNode) => WorkflowNode,
): Result<WorkflowGraph, DomainError> => {
  const index = graph.nodes.findIndex((node) => node.id === stageId);
  if (index < 0) return err(notFound(`Stage ${stageId} does not exist.`, { stageId }));
  const nodes = graph.nodes.map((node, position) => (position === index ? update(node) : node));
  return ok({ nodes, edges: graph.edges });
};

const sameEdge = (edge: WorkflowEdge, from: string, to: string): boolean =>
  edge.from === from && edge.to === to;

/** Apply ONE op; returns the new graph or the reason it is illegal. */
export function applyChangeOp(graph: WorkflowGraph, change: StageOp): Result<WorkflowGraph, DomainError> {
  switch (change.op) {
    case 'ADD_STAGE': {
      const stage = change.stage;
      if (typeof stage.id !== 'string' || stage.id.trim().length === 0) {
        return err(invalid('A stage needs a non-empty id.', { stage }));
      }
      if (graph.nodes.some((node) => node.id === stage.id)) {
        return err(conflict(`Stage ${stage.id} already exists.`, { stageId: stage.id }));
      }
      return ok({ nodes: [...graph.nodes, stage], edges: graph.edges });
    }

    case 'REMOVE_STAGE': {
      if (!graph.nodes.some((node) => node.id === change.stageId)) {
        return err(notFound(`Stage ${change.stageId} does not exist.`, { stageId: change.stageId }));
      }
      return ok({
        nodes: graph.nodes.filter((node) => node.id !== change.stageId),
        // Removing a stage removes its edges too — no dangling references are created.
        edges: graph.edges.filter((edge) => edge.from !== change.stageId && edge.to !== change.stageId),
      });
    }

    case 'UPDATE_STAGE': {
      if (change.title === undefined && change.kind === undefined && change.config === undefined) {
        return err(invalid('UPDATE_STAGE needs at least one field to change.', { stageId: change.stageId }));
      }
      return withStage(graph, change.stageId, (node) => ({
        ...node,
        ...(change.kind === undefined ? {} : { kind: change.kind }),
        ...(change.title === undefined ? {} : { title: change.title }),
        ...(change.config === undefined ? {} : { config: { ...node.config, ...change.config } }),
      }));
    }

    case 'CONNECT_STAGE': {
      if (change.from === change.to) {
        return err(invalid('A stage cannot be connected to itself.', { stageId: change.from }));
      }
      for (const endpoint of [change.from, change.to]) {
        if (!graph.nodes.some((node) => node.id === endpoint)) {
          return err(notFound(`Stage ${endpoint} does not exist.`, { stageId: endpoint }));
        }
      }
      if (graph.edges.some((edge) => sameEdge(edge, change.from, change.to))) {
        return err(
          conflict(`Edge ${change.from} → ${change.to} already exists.`, {
            from: change.from,
            to: change.to,
          }),
        );
      }
      const edge: WorkflowEdge = {
        from: change.from,
        to: change.to,
        ...(change.condition === undefined ? {} : { condition: change.condition }),
      };
      return ok({ nodes: graph.nodes, edges: [...graph.edges, edge] });
    }

    case 'DISCONNECT_STAGE': {
      if (!graph.edges.some((edge) => sameEdge(edge, change.from, change.to))) {
        return err(
          notFound(`Edge ${change.from} → ${change.to} does not exist.`, { from: change.from, to: change.to }),
        );
      }
      return ok({
        nodes: graph.nodes,
        edges: graph.edges.filter((edge) => !sameEdge(edge, change.from, change.to)),
      });
    }

    case 'SET_ROLE':
      if (change.roleId !== null && change.roleId.trim().length === 0) {
        return err(invalid('A role binding needs a non-empty roleId or null.', { stageId: change.stageId }));
      }
      return withStage(graph, change.stageId, (node) => ({
        ...node,
        config: { ...node.config, roleId: change.roleId },
      }));

    case 'SET_VALIDATOR':
      if (change.validatorIds.some((id) => id.trim().length === 0)) {
        return err(invalid('Validator ids must be non-empty.', { stageId: change.stageId }));
      }
      if (new Set(change.validatorIds).size !== change.validatorIds.length) {
        return err(invalid('Validator ids must be unique per stage.', { stageId: change.stageId }));
      }
      return withStage(graph, change.stageId, (node) => ({
        ...node,
        config: { ...node.config, validatorIds: [...change.validatorIds] },
      }));

    case 'SET_RISK':
      if (!RISK_LEVELS.includes(change.riskLevel)) {
        return err(invalid(`Unknown risk level "${String(change.riskLevel)}".`, { stageId: change.stageId }));
      }
      return withStage(graph, change.stageId, (node) => ({
        ...node,
        config: { ...node.config, riskLevel: change.riskLevel },
      }));

    case 'SET_APPROVAL': {
      const approval = change.approval;
      if (!APPROVAL_MODES.includes(approval.mode)) {
        return err(invalid(`Unknown approval mode "${String(approval.mode)}".`, { stageId: change.stageId }));
      }
      if (approval.required && approval.mode === 'authority' && (approval.authority ?? '').trim().length === 0) {
        return err(
          invalid('An "authority" approval needs a non-empty authority.', { stageId: change.stageId }),
        );
      }
      return withStage(graph, change.stageId, (node) => ({
        ...node,
        config: {
          ...node.config,
          approval: {
            required: approval.required,
            mode: approval.mode,
            ...(approval.authority === undefined ? {} : { authority: approval.authority }),
          },
        },
      }));
    }

    default: {
      // Exhaustiveness: an unknown op is a programming error, not a silent no-op.
      const unknown = change as { readonly op?: unknown };
      return err(invalid(`Unknown change operation "${String(unknown.op)}".`, { op: unknown.op }));
    }
  }
}

/**
 * Apply a sequence atomically: the first illegal op aborts the whole batch and NO
 * partial graph is returned.
 */
export function applyChangeOps(
  graph: WorkflowGraph,
  ops: readonly StageOp[],
): Result<WorkflowGraph, DomainError> {
  let current = graph;
  for (const [index, change] of ops.entries()) {
    const applied = applyChangeOp(current, change);
    if (!applied.ok) {
      return err(
        domainError(applied.error.code, applied.error.message, {
          ...applied.error.details,
          opIndex: index,
          op: change.op,
        }),
      );
    }
    current = applied.value;
  }
  return ok(current);
}

/* ------------------------------------------------------------ read helpers --- */

export const roleIdOf = (node: WorkflowNode): string | null => {
  const value = node.config['roleId'];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * The PINNED task materialization profile (T20-03B corrective): the trusted, Pack-owned
 * creation facts a WorkflowVersion node freezes in its immutable config — exactly the same
 * durable-with-the-version convention as `roleId`/`validatorIds`. A COMPLETE profile
 * (roleId + taskKind + maxAttempts) is what makes a stage materializable; anything else is
 * not (Core never guesses, and industry meaning lives in the Pack, not Core).
 */
export interface PinnedTaskProfile {
  readonly roleId: string;
  readonly taskKind: string;
  readonly maxAttempts: number;
}

const MAX_ATTEMPTS_PATTERN = /^\d+$/;

export const taskProfileOf = (node: WorkflowNode): PinnedTaskProfile | null => {
  const value = node.config['taskProfile'];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const roleId = typeof record['roleId'] === 'string' ? record['roleId'].trim() : '';
  const taskKind = typeof record['taskKind'] === 'string' ? record['taskKind'].trim() : '';
  const maxAttemptsRaw = record['maxAttempts'];
  const maxAttempts =
    (typeof maxAttemptsRaw === 'number' && Number.isInteger(maxAttemptsRaw)) ||
    (typeof maxAttemptsRaw === 'string' && MAX_ATTEMPTS_PATTERN.test(maxAttemptsRaw))
      ? Number(maxAttemptsRaw)
      : Number.NaN;
  if (roleId === '' || taskKind === '' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return null;
  }
  return { roleId, taskKind, maxAttempts };
};

export const validatorIdsOf = (node: WorkflowNode): readonly string[] => {
  const value = node.config['validatorIds'];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
};

export const riskLevelOf = (node: WorkflowNode): RiskLevel | null => {
  const value = node.config['riskLevel'];
  return typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)
    ? (value as RiskLevel)
    : null;
};

export const approvalOf = (node: WorkflowNode): ApprovalConfig | null => {
  const value = node.config['approval'];
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { required?: unknown; mode?: unknown; authority?: unknown };
  if (typeof candidate.required !== 'boolean') return null;
  if (typeof candidate.mode !== 'string' || !(APPROVAL_MODES as readonly string[]).includes(candidate.mode)) {
    return null;
  }
  return {
    required: candidate.required,
    mode: candidate.mode as ApprovalMode,
    ...(typeof candidate.authority === 'string' ? { authority: candidate.authority } : {}),
  };
};

/** Lifecycle guard reused by UI and IPC: only a `draft` template is editable. */
export const isEditableLifecycleState = (state: LifecycleState): boolean => state === 'draft';

export const assertEditable = (state: LifecycleState): Result<true, DomainError> => {
  if (isEditableLifecycleState(state)) return ok(true);
  const code =
    state === 'archived'
      ? 'ARCHIVED_READONLY'
      : state === 'deprecated'
        ? 'DEPRECATED_TEMPLATE'
        : 'ILLEGAL_TRANSITION';
  return err(
    domainError(code, `Template is "${state}"; the designer only edits a draft.`, {
      state,
      editableStates: LIFECYCLE_STATES.filter(isEditableLifecycleState),
    }),
  );
};
