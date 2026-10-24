/**
 * TemplateLock — the mutex that keeps in-flight runs reproducible (ADR-0008).
 *
 * Scope semantics:
 *   - `run`    : blocks structural mutation (publish_revision) while a run is live.
 *   - `global` : additionally blocks `fork`.
 * A lock is its own aggregate and never changes the template's state.
 */
import type { IdFactory } from '../ports/id-factory.js';
import { LifecycleError } from '../kernel/errors.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { WorkflowTemplate } from './template.js';

export const LOCK_SCOPES = ['run', 'global'] as const;
export type LockScope = (typeof LOCK_SCOPES)[number];

export interface TemplateLock {
  readonly id: string;
  readonly templateId: string;
  readonly versionId: string;
  readonly scope: LockScope;
  readonly reason: string;
  readonly lockedBy: string;
  readonly lockedAt: string;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
}

export interface CreateLockInput {
  readonly templateId: string;
  readonly versionId: string;
  readonly scope: LockScope;
  readonly reason: string;
  readonly lockedBy: string;
  readonly lockedAt: string;
  readonly ids: IdFactory;
}

export function createTemplateLock(input: CreateLockInput): Result<TemplateLock, LifecycleError> {
  if (input.reason.trim().length === 0) {
    return err(new LifecycleError('VALIDATION_FAILED', 'A lock requires a non-empty reason.', { templateId: input.templateId }));
  }
  if (input.versionId.trim().length === 0) {
    return err(new LifecycleError('VALIDATION_FAILED', 'A lock must pin a version.', { templateId: input.templateId }));
  }
  return ok({
    id: input.ids.id('lck'),
    templateId: input.templateId,
    versionId: input.versionId,
    scope: input.scope,
    reason: input.reason,
    lockedBy: input.lockedBy,
    lockedAt: input.lockedAt,
    releasedAt: null,
    releasedBy: null,
  });
}

export const isLockActive = (lock: TemplateLock): boolean => lock.releasedAt === null;

export function releaseTemplateLock(
  lock: TemplateLock,
  input: { readonly releasedBy: string; readonly releasedAt: string },
): Result<TemplateLock, LifecycleError> {
  if (!isLockActive(lock)) {
    return err(new LifecycleError('CONFLICT', `Lock ${lock.id} was already released.`, { lockId: lock.id }));
  }
  return ok({ ...lock, releasedAt: input.releasedAt, releasedBy: input.releasedBy });
}

export const activeLocksFor = (
  locks: readonly TemplateLock[],
  templateId: string,
): readonly TemplateLock[] => locks.filter((lock) => lock.templateId === templateId && isLockActive(lock));

const lockedError = (locks: readonly TemplateLock[], operation: string): LifecycleError =>
  new LifecycleError('LOCKED_TEMPLATE', `Template is locked; "${operation}" is refused.`, {
    operation,
    lockIds: locks.map((lock) => lock.id),
    scopes: locks.map((lock) => lock.scope),
  });

/** Publish/revise is refused while ANY lock is active. */
export function assertMutable(
  locks: readonly TemplateLock[],
  templateId: string,
  operation = 'mutate',
): Result<true, LifecycleError> {
  const active = activeLocksFor(locks, templateId);
  return active.length === 0 ? ok(true) : err(lockedError(active, operation));
}

/** Fork is refused only by a `global` lock. */
export function assertForkable(
  locks: readonly TemplateLock[],
  templateId: string,
): Result<true, LifecycleError> {
  const active = activeLocksFor(locks, templateId).filter((lock) => lock.scope === 'global');
  return active.length === 0 ? ok(true) : err(lockedError(active, 'fork'));
}

/**
 * A template is writable when it is not archived and not locked. Deprecated
 * templates remain forkable but not publishable.
 */
export function lockPolicyFor(
  template: WorkflowTemplate,
  locks: readonly TemplateLock[],
): { readonly mutable: boolean; readonly forkable: boolean; readonly reason: string | null } {
  const active = activeLocksFor(locks, template.id);
  return {
    mutable: template.state !== 'archived' && active.length === 0,
    forkable: (template.state === 'published' || template.state === 'deprecated') && !active.some((l) => l.scope === 'global'),
    reason: active.length === 0 ? null : `locked by ${active.map((l) => l.id).join(', ')}`,
  };
}
