/**
 * Core Domain bounded-context models (Sprint 1: CompanyOS Core Domain, P0).
 *
 * Vocabulary is FROZEN at 23 concepts (`catalog.ts`, ADR-0002). Nothing here may
 * name an Industry-Pack concept: those belong to `@companyos/pack-*`
 * (AGENTS.md §1.1, enforced by `scripts/check-boundaries.mjs`).
 *
 * Layering (ADR-0003):
 *   L1 execution state → `run-state.ts`
 *   L2 template lifecycle → `../lifecycle/machine.ts`
 *   L3 task/stage local state → `stage.ts`, `task.ts`
 */
export * from './agent.js';
export * from './approval.js';
export * from './artifact.js';
export * from './branch.js';
export * from './catalog.js';
export * from './commands.js';
export * from './company.js';
export * from './event.js';
export * from './pack.js';
export * from './role.js';
export * from './run-state.js';
export * from './stage.js';
export * from './task.js';
export * from './validation.js';
export * from './workflow.js';
export * from './workflow-run.js';
export * from './memory.js';
export * from './decision.js';
