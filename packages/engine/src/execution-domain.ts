/**
 * AUDIT-E5 — the ONE "execution domain" rule, shared by the engine (EXECUTION.COMPLETE guard) and the
 * autonomous supervisor's EXECUTING gate. They used to answer the same question differently: the supervisor
 * completed a run when every task was terminal and ONE task anywhere was DONE, so a run with a FAILED or
 * never-materialized stage could leave EXECUTING into REVIEWING (and be auto-passed).
 *
 *   complete — every pinned stage has tasks, all terminal, and at least one DONE per stage;
 *   failed   — every pinned stage has tasks and all are terminal, but some stage has no DONE
 *              (terminal without success: nothing can run any more) -> EXECUTION.FAIL;
 *   open     — anything else (a stage without tasks yet, or a task still open).
 */
export type ExecutionDomainVerdict =
  | { readonly kind: 'complete' }
  | { readonly kind: 'failed'; readonly stageIds: readonly string[] }
  | { readonly kind: 'open' };

const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED', 'SKIPPED']);

export const executionDomainVerdict = (
  stageIds: readonly string[],
  tasks: readonly { readonly stageId: unknown; readonly state: string }[],
): ExecutionDomainVerdict => {
  const failed: string[] = [];
  let open = false;
  for (const stageId of stageIds) {
    const stageTasks = tasks.filter((task) => String(task.stageId) === String(stageId));
    if (stageTasks.length === 0 || stageTasks.some((task) => !TERMINAL.has(task.state))) { open = true; continue; }
    if (!stageTasks.some((task) => task.state === 'DONE')) failed.push(String(stageId));
  }
  if (open) return { kind: 'open' };
  if (failed.length > 0) return { kind: 'failed', stageIds: failed };
  return { kind: 'complete' };
};
