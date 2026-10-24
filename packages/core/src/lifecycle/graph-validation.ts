/**
 * Graph validation (Sprint 5 §四) — the gate in front of Publish.
 *
 * Pure and IO-free: it reads a graph (plus optional catalogues the caller resolved) and
 * reports every problem it finds, so the UI can show them all at once while the actual
 * Publish decision stays in the lifecycle service.
 */
import { err, ok, type Result } from '../kernel/result.js';
import { domainError, type DomainError } from '../kernel/errors.js';
import {
  APPROVAL_MODES,
  RISK_LEVELS,
  approvalOf,
  isEditableLifecycleState,
  riskLevelOf,
  roleIdOf,
  validatorIdsOf,
} from './change-ops.js';
import type { LifecycleState } from './machine.js';
import type { WorkflowGraph } from './version.js';

export interface GraphValidationIssue {
  readonly code:
    | 'NO_STAGES'
    | 'DUPLICATE_STAGE_ID'
    | 'DANGLING_EDGE'
    | 'SELF_LOOP'
    | 'NO_ENTRY_STAGE'
    | 'NO_TERMINAL_STAGE'
    | 'UNREACHABLE_STAGE'
    | 'MISSING_ROLE'
    | 'UNKNOWN_ROLE'
    | 'UNKNOWN_VALIDATOR'
    | 'INVALID_RISK'
    | 'TASK_PROFILE_INVALID'
    | 'INVALID_APPROVAL'
    | 'LIFECYCLE_READONLY';
  readonly message: string;
  readonly subject: string | null;
}

export interface GraphValidationReport {
  readonly valid: boolean;
  readonly issues: readonly GraphValidationIssue[];
  readonly entryStageIds: readonly string[];
  readonly terminalStageIds: readonly string[];
  readonly unreachableStageIds: readonly string[];
}

export interface GraphValidationOptions {
  /** Roles that exist in this workspace; omitted ⇒ role references are not resolved. */
  readonly roleIds?: readonly string[];
  /** Validators the system knows; omitted ⇒ validator references are not resolved. */
  readonly validatorIds?: readonly string[];
  /** Current template state; when not editable, editing is flagged. */
  readonly lifecycleState?: LifecycleState;
  /** Require every stage to bind a role (the Designer default). */
  readonly requireRole?: boolean;
}

const issue = (
  code: GraphValidationIssue['code'],
  message: string,
  subject: string | null = null,
): GraphValidationIssue => ({ code, message, subject });

/** Never throws: the caller decides whether to block on `valid === false`. */
export function validateWorkflowGraph(
  graph: WorkflowGraph,
  options: GraphValidationOptions = {},
): GraphValidationReport {
  const issues: GraphValidationIssue[] = [];

  if (graph.nodes.length === 0) {
    issues.push(issue('NO_STAGES', 'A workflow needs at least one stage.'));
  }

  // Unique stage ids.
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) {
      issues.push(issue('DUPLICATE_STAGE_ID', `Stage id "${node.id}" is used more than once.`, node.id));
    }
    seen.add(node.id);
  }

  // Edges reference existing stages, no self-loop, no duplicates.
  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    const key = `${edge.from}->${edge.to}`;
    if (!seen.has(edge.from) || !seen.has(edge.to)) {
      issues.push(
        issue('DANGLING_EDGE', `Edge ${key} references a stage that does not exist.`, key),
      );
    } else if (edge.from === edge.to) {
      issues.push(issue('SELF_LOOP', `Edge ${key} connects a stage to itself.`, key));
    } else if (edgeKeys.has(key)) {
      issues.push(issue('DANGLING_EDGE', `Edge ${key} is declared twice.`, key));
    }
    edgeKeys.add(key);
  }

  // Entry / terminal / reachability.
  const hasIncoming = new Set(graph.edges.map((edge) => edge.to));
  const hasOutgoing = new Set(graph.edges.map((edge) => edge.from));
  const entryStageIds = graph.nodes.filter((node) => !hasIncoming.has(node.id)).map((node) => node.id);
  const terminalStageIds = graph.nodes.filter((node) => !hasOutgoing.has(node.id)).map((node) => node.id);

  if (graph.nodes.length > 0 && entryStageIds.length === 0) {
    issues.push(issue('NO_ENTRY_STAGE', 'The workflow has no start stage (every stage has an incoming edge).'));
  }
  if (graph.nodes.length > 0 && terminalStageIds.length === 0) {
    issues.push(
      issue('NO_TERMINAL_STAGE', 'The workflow has no terminal path (every stage has an outgoing edge).'),
    );
  }

  const reachable = new Set<string>();
  const queue = [...entryStageIds];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of graph.edges) {
      if (edge.from === current && !reachable.has(edge.to)) queue.push(edge.to);
    }
  }
  const unreachableStageIds = graph.nodes
    .filter((node) => !reachable.has(node.id))
    .map((node) => node.id);
  for (const stageId of unreachableStageIds) {
    issues.push(issue('UNREACHABLE_STAGE', `Stage ${stageId} cannot be reached from the start stage.`, stageId));
  }

  // Stage-level configuration.
  const knownRoles = options.roleIds === undefined ? null : new Set(options.roleIds);
  const knownValidators = options.validatorIds === undefined ? null : new Set(options.validatorIds);
  for (const node of graph.nodes) {
    const roleId = roleIdOf(node);
    if (roleId === null) {
      if (options.requireRole === true) {
        issues.push(issue('MISSING_ROLE', `Stage ${node.id} has no role bound.`, node.id));
      }
    } else if (knownRoles !== null && !knownRoles.has(roleId)) {
      issues.push(issue('UNKNOWN_ROLE', `Stage ${node.id} binds unknown role "${roleId}".`, node.id));
    }

    if (knownValidators !== null) {
      for (const validatorId of validatorIdsOf(node)) {
        if (!knownValidators.has(validatorId)) {
          issues.push(
            issue('UNKNOWN_VALIDATOR', `Stage ${node.id} references unknown validator "${validatorId}".`, node.id),
          );
        }
      }
    }

    /*
       * T20-03B corrective: a node that DECLARES a taskProfile must declare a COMPLETE,
       * well-formed one — a partial or malformed profile is rejected at PUBLISH time, never
       * discovered at Task creation.
       */
      if (Object.prototype.hasOwnProperty.call(node.config, 'taskProfile')) {
        const raw = node.config['taskProfile'];
        const wellFormed =
          (typeof raw === 'object' && raw !== null && !Array.isArray(raw));
        if (!wellFormed) {
          issues.push(
            issue('TASK_PROFILE_INVALID', `Stage ${node.id}: taskProfile must be an object.`, node.id),
          );
        } else {
          const record = raw as Record<string, unknown>;
          const hasRole = typeof record['roleId'] === 'string' && String(record['roleId']).trim() !== '';
          const hasKind = typeof record['taskKind'] === 'string' && String(record['taskKind']).trim() !== '';
          const attempts = Number(record['maxAttempts']);
          const hasAttempts =
            Number.isInteger(attempts) && attempts >= 1 && attempts <= 100;
          if (!hasRole || !hasKind || !hasAttempts) {
            issues.push(
              issue(
                'TASK_PROFILE_INVALID',
                `Stage ${node.id}: taskProfile needs roleId, taskKind and an integer maxAttempts (1..100).`,
                node.id,
              ),
            );
          }
        }
      }
      const riskValue = node.config['riskLevel'];
    if (riskValue !== undefined && !(RISK_LEVELS as readonly string[]).includes(String(riskValue))) {
      issues.push(issue('INVALID_RISK', `Stage ${node.id} has an unknown risk level.`, node.id));
    }

    const approvalValue = node.config['approval'];
    if (approvalValue !== undefined) {
      const approval = approvalOf(node);
      if (approval === null) {
        issues.push(issue('INVALID_APPROVAL', `Stage ${node.id} has a malformed approval config.`, node.id));
      } else if (
        approval.required &&
        approval.mode === 'authority' &&
        (approval.authority ?? '').trim().length === 0
      ) {
        issues.push(
          issue('INVALID_APPROVAL', `Stage ${node.id} needs an authority for its approval.`, node.id),
        );
      } else if (!(APPROVAL_MODES as readonly string[]).includes(approval.mode)) {
        issues.push(issue('INVALID_APPROVAL', `Stage ${node.id} has an unknown approval mode.`, node.id));
      }
    }

    // HIGH/CRITICAL work must be approved before it runs (规划书 §三十七).
    const risk = riskLevelOf(node);
    if ((risk === 'HIGH' || risk === 'CRITICAL') && (approvalOf(node)?.required ?? false) === false) {
      issues.push(
        issue('INVALID_APPROVAL', `Stage ${node.id} is ${risk} risk but has no required approval.`, node.id),
      );
    }
  }

  if (options.lifecycleState !== undefined && !isEditableLifecycleState(options.lifecycleState)) {
    issues.push(
      issue(
        'LIFECYCLE_READONLY',
        `The template is "${options.lifecycleState}"; published versions are immutable by design.`,
        null,
      ),
    );
  }

  return {
    valid: issues.length === 0,
    issues,
    entryStageIds,
    terminalStageIds,
    unreachableStageIds,
  };
}

/** Publish gate: an invalid graph must be refused with a DomainError listing the issues. */
export function assertPublishable(
  graph: WorkflowGraph,
  options: GraphValidationOptions = {},
): Result<WorkflowGraph, DomainError> {
  const report = validateWorkflowGraph(graph, options);
  if (report.valid) return ok(graph);
  return err(
    domainError('VALIDATION_FAILED', `The workflow has ${report.issues.length} problem(s) and cannot be published.`, {
      issueCodes: report.issues.map((entry) => entry.code),
      issues: report.issues,
    }),
  );
}
