#!/usr/bin/env node
/**
 * CompanyOS ARCHITECTURE GUARD (Sprint 22).
 *
 * Turns the frozen architecture laws (docs/architecture/ARCHITECTURE_LAWS.md,
 * ARCH-001..ARCH-032) into executable checks. Runs over the repository source,
 * persistence migrations and package manifests — never over build output.
 *
 * Design rules (Boss order §36):
 *   1. existing boundary system      — check-boundaries.mjs stays the owner of
 *                                      ARCH-001/002 (Core vocabulary + imports);
 *   2. TypeScript/AST-level checks   — this script's statement/import/identifier
 *                                      inspections (no new dependency: plain
 *                                      text+regex over comment/string-stripped
 *                                      sources, the proven technique);
 *   3. package dependency rules      — migrated here from check-boundaries LAW 2
 *                                      for the engine/persistence→apps edge;
 *   4. focused architecture tests    — tests/architecture/architecture-laws.test.ts
 *                                      proves every guard BOTH directions (§38);
 *   5. targeted source assertions    — the marker checks below (D1 scoping, claim
 *                                      ordering, reassessment ownership).
 *
 * Every violation names its law ID, what was found, where, why it violates the
 * architecture and the allowed boundary (§46). No opaque "grep failed".
 *
 * Exit code 0 = clean. Exit code 1 = at least one violation.
 *
 * Usage:
 *   node scripts/check-architecture.mjs [--root <dir>] [--json]
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ utilities */

function resolveRoot(argv) {
  const index = argv.findIndex((arg) => arg === '--root' || arg.startsWith('--root='));
  if (index === -1) return fileURLToPath(new URL('..', import.meta.url));
  const arg = argv[index];
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error('--root requires a directory argument');
  }
  return resolve(value);
}

/**
 * Remove comments and string/template literals, preserving line numbers (the same
 * proven stripper as check-boundaries.mjs). This is what keeps documentation,
 * forbidden-field lists, error-message strings and constraint notes from tripping
 * a guard (§39 false-positive control).
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += blank(source[i]);
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i += 1;
      while (i < n) {
        if (source[i] === '\\') {
          out += blank(source[i]) + blank(source[i + 1] ?? ' ');
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        out += blank(source[i]);
        i += 1;
      }
      out += ' ';
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Remove COMMENTS only, preserving string literals (and line numbers). Used where the
 * guarded artifact is code that happens to live inside a string: import specifiers,
 * SQL fragments, marker keys. Comments stay excluded (§39).
 */
const charNewline = String.fromCharCode(10);

function stripCommentsOnly(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && source[i] !== charNewline) {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === charNewline ? charNewline : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rel = (root, p) => relative(root, p).split(sep).join('/');

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/* ------------------------------------------------------------------ the guard */

/**
 * @param {string} root repository (or fixture) root
 * @returns {{ violations: {law:string; where:string; what:string; why:string; fix:string}[],
 *            notes: string[], scanned: { sources:number; migrations:number } }}
 */
export function checkArchitecture(root) {
  const violations = [];
  const notes = [];
  const push = (law, where, what, why, fix) => violations.push({ law, where, what, why, fix });

  const srcFiles = (modulePath) => {
    const full = join(root, modulePath);
    const files = existsSync(full) && statSync(full).isDirectory() ? walk(full) : [full];
    return files.filter((f) => {
      if (!existsSync(f) || !statSync(f).isFile()) return false;
      if (!(f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mjs'))) return false;
      // pnpm workspace symlinks (node_modules) and build output are not repository source.
      const normalized = f.split(sep).join('/');
      return !normalized.includes('/node_modules/') && !normalized.includes('/dist/');
    });
  };

  /* ---- ARCH-003 · dependency direction at the SOURCE level ------------------
   * Engine and Persistence are inner-ring implementors: they may depend on Core
   * contracts and ports only. Importing an app, Electron or React from either is
   * a direction reversal (complementary to check-boundaries' manifest-level LAW 2,
   * which cannot see source imports that bypass package.json).
   */
  for (const dir of ['packages/engine/src', 'packages/persistence/src']) {
    for (const file of srcFiles(dir)) {
      const raw = readFileSync(file, 'utf8');
      const where = rel(root, file);
      const importRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = importRe.exec(raw)) !== null) {
        const spec = m[1];
        const forbidden =
          spec.startsWith('@companyos/desktop') ||
          spec.startsWith('@companyos/renderer') ||
          spec.startsWith('apps/') ||
          spec.startsWith('../apps') ||
          spec === 'electron' ||
          spec === 'react' ||
          spec === 'react-dom';
        if (forbidden) {
          push(
            'ARCH-003',
            `${where}:${lineOf(raw, m.index)}`,
            `import "${spec}"`,
            'Engine/Persistence are inner-ring implementors; apps, Electron and React live in the outer ring. A source-level import reverses the frozen dependency direction (Core ← Engine ← Desktop).',
            'Move the dependency outward (Desktop composes Engine) or, if the engine genuinely needs a contract, declare it as a Core port.',
          );
        }
      }
    }
  }

  /* ---- ARCH-004 · pinned WorkflowVersion is execution authority --------------
   * The modules that resolve an EXISTING run's execution semantics must read the
   * run's own pinned version (run.versionId); reaching for currentVersion /
   * latestVersion there re-points a live run at a newer template. Lifecycle
   * AUTHORING paths (publish/draft/fork) are not in this module set by design.
   */
  const PINNED_EXECUTION_MODULES = [
    'packages/engine/src/engine.ts',
    'packages/engine/src/supervisor',
    'packages/engine/src/projection',
    'apps/desktop/src/core-services.ts',
  ];
  const PINNED_FORBIDDEN = /\b(currentVersion|currentVersionId|latestVersion|latestWorkflow|latestWorkflowVersion)\b/;
  for (const modulePath of PINNED_EXECUTION_MODULES) {
    for (const file of srcFiles(modulePath)) {
      const raw = readFileSync(file, 'utf8');
      const stripped = stripCommentsAndStrings(raw);
      const where = rel(root, file);
      const re = new RegExp(PINNED_FORBIDDEN.source, 'g');
      let m;
      while ((m = re.exec(stripped)) !== null) {
        push(
          'ARCH-004',
          `${where}:${lineOf(stripped, m.index)}`,
          `"${m[1]}" in a run-execution module`,
          'An existing Run executes against its PINNED WorkflowVersion (run.versionId). A current/latest pointer here would let a newer template change a live run’s semantics.',
          'Resolve the pinned version: versions.find((entry) => entry.id === run.versionId) — the frozen pinning rule (ADR-0027).',
        );
      }
    }
  }

  /* ---- ARCH-005/006 · no second DAG / no second scheduler (persistence) ------
   * Dependency authority is the WorkflowVersion DAG; there is no scheduler table
   * and no queue truth. The scan covers every migration: forbidden CATEGORY names
   * can never be introduced, and any NEW table outside the frozen inventory must
   * be an explicit architecture-law amendment (documented, not silent).
   */
  const FORBIDDEN_TABLE_CATEGORIES = [
    { pattern: /^task_edges?$/, why: 'a Task-level edge table would become a second dependency graph beside the WorkflowVersion DAG' },
    { pattern: /^(runtime_)?dependenc(y|ies)(_edges?)?$/, why: 'a runtime dependency table duplicates the pinned DAG as dependency authority' },
    { pattern: /^(correction|reassessment|execution|workflow)_graph$/, why: 'a second graph (corrective/reassessment/execution) would compete with the pinned DAG' },
    { pattern: /^scheduler(s)?$/, why: 'a scheduler table becomes canonical scheduling truth' },
    { pattern: /^(runtime_)?task_state$/, why: 'a runtime task-state table competes with the Task lifecycle' },
    { pattern: /^agent_queue$/, why: 'an agent queue table becomes a second execution authority' },
    { pattern: /^queues?$/, why: 'a queue table becomes canonical work scheduling truth' },
    { pattern: /^work_packages?$/, why: 'a Work Package table would persist a derived projection as second truth' },
    // STAGE 8 (role collaboration): no second collaboration truth and no peer chat.
    { pattern: /^role_messages$/, why: 'a role-message table would become a second collaboration truth beside the Task chain' },
    { pattern: /^agent_chat(_truth)?$/, why: 'an agent-chat table is the forbidden peer-chat truth (Stage 8 §A)' },
    { pattern: /^team_tasks?(_store)?$/, why: 'a team task store would compete with the canonical Task lifecycle' },
    { pattern: /^agent_team_scheduler$/, why: 'a team scheduler table becomes canonical scheduling truth (Stage 8 §A: PM is NOT a scheduler)' },
    { pattern: /^peer_workflow_state$/, why: 'peer workflow state is a second workflow truth beside the pinned WorkflowVersion' },
  ];
  /** The frozen table inventory at Sprint22 baseline (779491b). A new table needs
   *  an architecture-law amendment recorded in ARCHITECTURE_LAWS.md §inventory. */
  const FROZEN_TABLE_INVENTORY = new Set([
    'schema_migrations', 'entities', 'settings', 'events', 'handoff_refs',
    'workflow_template_versions', 'workflow_template_locks', 'workflow_templates',
    'workflow_change_requests', 'benchmark_results', 'agent_executions',
    'agent_execution_artifacts', 'runs', 'tasks', 'tasks_t2003a', 'approvals',
    'command_ledger', 'decisions', 'artifacts', 'validations', 'model_records',
    'logical_aliases', 'execution_attempts', 'roles', 'role_assignments', 'providers',
    'provider_models', 'secret_refs', 'pack_versions', 'pack_installations',
    'pack_content_refs', 'handoffs', 'memories', 'router_decisions',
    'model_selection_policies', 'sessions', 'session_entries', 'tool_records',
    'tool_invocations', 'tool_invocation_artifacts', 'tool_invocations_rebuilt',
    'run_snapshots',
    'provider_dispatches',
  ]);
  let migrationCount = 0;
  for (const file of walk(join(root, 'packages/persistence/migrations')).filter((f) => f.endsWith('.sql'))) {
    migrationCount += 1;
    const raw = readFileSync(file, 'utf8');
    const where = rel(root, file);
    const tableRe = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    let m;
    while ((m = tableRe.exec(raw)) !== null) {
      const table = m[1];
      for (const { pattern, why } of FORBIDDEN_TABLE_CATEGORIES) {
        if (pattern.test(table)) {
          push(
            'ARCH-005',
            `${where}:${lineOf(raw, m.index)}`,
            `CREATE TABLE ${table}`,
            `A table of this category is second truth: ${why}.`,
            'Keep dependency/scheduling authority in the pinned WorkflowVersion DAG and the Task lifecycle; delete the table.',
          );
        }
      }
      if (!FROZEN_TABLE_INVENTORY.has(table)) {
        push(
          'ARCH-006',
          `${where}:${lineOf(raw, m.index)}`,
          `CREATE TABLE ${table} (not in the frozen inventory)`,
          'New canonical storage must be a deliberate architecture-law amendment; an unlisted table can silently become second truth.',
          'If this table is genuinely new canonical storage, record it in ARCHITECTURE_LAWS.md §table inventory (with its owning law). Otherwise remove it.',
        );
      }
    }
  }

  /* ---- ARCH-008 · WorkPackage is derived-only --------------------------------
   * The projector exports projections only: no create/update/put/save/delete/
   * transition/apply verb may leave the module.
   */
  const PROJECTOR = 'packages/engine/src/projection/work-package-projector.ts';
  if (existsSync(join(root, PROJECTOR))) {
    const raw = readFileSync(join(root, PROJECTOR), 'utf8');
    const where = rel(root, PROJECTOR);
    const stripped = stripCommentsAndStrings(raw);
    const exportRe = /export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    let m;
    while ((m = exportRe.exec(stripped)) !== null) {
      // The projector's own FACTORY (createWorkPackageProjector) constructs the pure
      // projection service — it mutates no package state. Everything that creates,
      // updates, saves or deletes a WORK PACKAGE itself is banned.
      const mutatesPackage =
        m[1] !== 'createWorkPackageProjector' &&
        (/^(update|put|save|delete|remove|transition|apply|claim)/.test(m[1]) ||
          /^(create|update|put|save|delete|remove|transition|apply|claim)(WorkPackage|Package)/i.test(m[1]));
      if (mutatesPackage) {
        push(
          'ARCH-008',
          `${where}:${lineOf(stripped, m.index)}`,
          `exported mutator "${m[1]}"`,
          'The Work Package is a read-only derived projection (T20-06); a mutating export would make it a lifecycle/owner, not a projection.',
          'Expose projection reads only; persistence of results belongs to the canonical owners (Task/stage output, Artifact, Validation).',
        );
      }
    }
  }

  /* ---- ARCH-009 · Handoff single owner ---------------------------------------
   * Handoff tables live only in the Sprint11 handoff migration chain; a handoff
   * table anywhere else is a second durable owner.
   */
  for (const file of walk(join(root, 'packages/persistence/migrations')).filter((f) => f.endsWith('.sql'))) {
    const where = rel(root, file);
    if (where.includes('migrations/handoff/')) continue;
    const raw = readFileSync(file, 'utf8');
    const tableRe = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    let m;
    while ((m = tableRe.exec(raw)) !== null) {
      if (/handoff/i.test(m[1])) {
        push(
          'ARCH-009',
          `${where}:${lineOf(raw, m.index)}`,
          `CREATE TABLE ${m[1]}`,
          'The Sprint11 HandoffService chain is the only durable Handoff owner; a handoff table in another chain is a second owner.',
          'Move the storage into the handoff chain, or express the data through the existing HandoffService API.',
        );
      }
    }
  }

  /* ---- ARCH-010 · Task canonical ownership ------------------------------------
   * Task.runId → Run → Company. A company_id column on tasks (or a companyId
   * field on the Task domain type) is a competing ownership truth.
   */
  for (const file of walk(join(root, 'packages/persistence/migrations')).filter((f) => f.endsWith('.sql'))) {
    const raw = readFileSync(file, 'utf8');
    const where = rel(root, file);
    const tableRe = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(tasks(?:_[A-Za-z0-9_]*)?)\s*\(([\s\S]*?)\n\);/g;
    let m;
    while ((m = tableRe.exec(raw)) !== null) {
      const body = m[2];
      if (/^\s*company_id\b/im.test(body)) {
        push(
          'ARCH-010',
          `${where}:${lineOf(raw, m.index)}`,
          `tasks table carries company_id`,
          'Task ownership is Task.runId → Run → Company (T20-03A). A company_id column on tasks is a second ownership truth that can disagree with the run.',
          'Ownership reads go through the run; drop the column (the FK + trigger already enforce the chain).',
        );
      }
    }
  }
  const TASK_DOMAIN = 'packages/core/src/domain/task.ts';
  if (existsSync(join(root, TASK_DOMAIN))) {
    const raw = readFileSync(join(root, TASK_DOMAIN), 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    if (/\bcompanyId\b/.test(stripped)) {
      push(
        'ARCH-010',
        rel(root, TASK_DOMAIN),
        'the Task domain type names companyId',
        'A Task-level company field invites standalone company inference beside the run-ownership chain.',
        'Keep ownership on the run row; the Task type carries runId only.',
      );
    }
  }

  /* ---- ARCH-012/013 · ExecutionAttempt ≠ Task; AgentExecution ≠ Attempt ------
   * The attempt domain owns runtime identity only. It must not import the
   * findings/validation/DAG/run-state modules and must not carry model/provider
   * fields (model provenance belongs to AgentExecution).
   */
  const ATTEMPT_DOMAIN = 'packages/core/src/lifecycle/execution-attempt.ts';
  if (existsSync(join(root, ATTEMPT_DOMAIN))) {
    const raw = readFileSync(join(root, ATTEMPT_DOMAIN), 'utf8');
    // An import specifier is code, not a string literal: the scan reads the RAW source.
    const importScan = raw;
    const stripped = stripCommentsAndStrings(raw);
    const where = rel(root, ATTEMPT_DOMAIN);
    const importRe = /from\s+['"]([^'"]+)['"]/g;
    let m;
    const forbiddenImports = [
      { pattern: /finding|evidence/i, why: 'findings/evidence truth is owned by the canonical sinks, not the attempt' },
      { pattern: /validation/i, why: 'validation truth is owned by the ValidationService rows' },
      { pattern: /run-state|workflow-run/i, why: 'workflow state is owned by the frozen run machine' },
      { pattern: /decision|corrective/i, why: 'decision/corrective lineage is owned by the decision sink and provisioner' },
    ];
    while ((m = importRe.exec(importScan)) !== null) {
      for (const { pattern, why } of forbiddenImports) {
        if (pattern.test(m[1])) {
          push(
            'ARCH-012',
            `${where}:${lineOf(stripped, m.index)}`,
            `import from "${m[1]}"`,
            `The ExecutionAttempt entity is runtime identity only: ${why}.`,
            'The attempt may read its immutable seed (company/run/task/attemptNumber/roleId/taskKind) and nothing else.',
          );
        }
      }
    }
    const modelFields = /\b(modelKey|providerId|providerModelId|agentId|modelVersion)\b/;
    const fieldMatch = modelFields.exec(stripped);
    if (fieldMatch !== null) {
      push(
        'ARCH-013',
        `${where}:${lineOf(stripped, fieldMatch.index)}`,
        `"${fieldMatch[1]}" on the attempt entity`,
        'AgentExecution is model/LLM provenance only; a model field on the attempt seed would make it the executor claim truth.',
        'Model provenance stays in agent_executions; the attempt seed carries no model fields (Sprint21 final).',
      );
    }
  }

  /* ---- ARCH-017 · D1 scope separation -----------------------------------------
   * Subject-scoped proposal projection + all-anchors run blocking. The context
   * builder must gate projection population on subject match, and the blocking
   * scan must consider every anchor (not only the named one).
   */
  const SUPERVISOR_RUNTIME = 'packages/engine/src/supervisor/supervisor-runtime.ts';
  if (existsSync(join(root, SUPERVISOR_RUNTIME))) {
    const raw = readFileSync(join(root, SUPERVISOR_RUNTIME), 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    const where = rel(root, SUPERVISOR_RUNTIME);
    const gate = stripped.search(/anchorSubjectMatched/);
    const projection = stripped.search(/anchorReports\.push|review\s*[:=]\s*\{|projectedReview\s*=/);
    if (gate < 0) {
      push(
        'ARCH-017',
        where,
        'no subject-match gate in the context builder',
        'D1 froze: the proposal/cause projection is SUBJECT-SCOPED — a foreign report must never populate the subject-local projection.',
        'Gate every projection population on the anchor subject match before assigning the review projection.',
      );
    } else if (projection >= 0 && projection < gate) {
      push(
        'ARCH-017',
        `${where}:${lineOf(stripped, projection)}`,
        'projection populated before the subject-match gate',
        'A projection assigned before the gate lets a foreign-subject report hijack the proposal (D1 violation).',
        'Populate projections only inside the subject-matched branch; foreign findings contribute blocking only.',
      );
    }
  }

  /* ---- ARCH-019/020 · corrective/reassessment ownership -----------------------
   * The provisioner is the ONLY production writer of the reassessment marker, and
   * the descendant scan must read the run-pinned graph.
   */
  for (const dir of ['packages', 'apps']) {
    for (const file of srcFiles(dir)) {
      if (/(\.test\.|tests[\\/])/.test(file)) continue;
      if (file.endsWith('.d.ts')) continue;
      const raw = readFileSync(file, 'utf8');
      // The marker is a STRING KEY — comments are stripped, strings are kept.
      const stripped = stripCommentsOnly(raw);
      const where = rel(root, file);
      if (!/companyos:reassessment/.test(stripped)) continue;
      // Readers are legitimate (the projector projects the causal dossier); the law binds
      // WRITERS — a file that seeds a task with the marker outside the provisioner.
      if (!/createTask\s*\(/.test(stripped)) continue;
      const isProvisioner = where.endsWith('corrective-provisioner.ts');
      const isCoreContract = where.startsWith('packages/core/src/lifecycle/corrective-task.ts');
      if (!isProvisioner && !isCoreContract) {
        push(
          'ARCH-019',
          where,
          'writes the reassessment marker outside the provisioner',
          'Corrective/reassessment lineage continues through the canonical provisioner; an ad-hoc writer is a manual review2 seeding / hidden reassessment queue.',
          'Provision reassessments through the provisioner (producer-stage + pinned-DAG strict descendants); remove the ad-hoc writer.',
        );
      }
    }
  }
  const PROVISIONER = 'packages/engine/src/supervisor/corrective-provisioner.ts';
  if (existsSync(join(root, PROVISIONER))) {
    const raw = readFileSync(join(root, PROVISIONER), 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    const hasPinnedRead = /run\.versionId|pinnedVersionOf|pinnedGraph/.test(stripped);
    const hasDescendantScan = /descendant/i.test(stripped);
    if (hasDescendantScan && !hasPinnedRead) {
      push(
        'ARCH-020',
        rel(root, PROVISIONER),
        'descendant invalidation without a pinned-version read',
        'Completed stale descendants derive from the RUN-PINNED WorkflowVersion DAG; the current template/pack DAG or task creation order would invalidate the wrong stages.',
        'Derive strict descendants from the run-pinned version (versions.find(id === run.versionId).graph).',
      );
    }
  }

  /* ---- ARCH-021/022 · claim before executor; no write TX across executor ------
   * In the engine claim timeline the handler invocation must FOLLOW the claim
   * transaction, and no executor/provider invocation may sit inside an
   * `inTransaction` callback (a SQLite write transaction must never span an
   * external call).
   */
  const ENGINE = 'packages/engine/src/engine.ts';
  if (existsSync(join(root, ENGINE))) {
    const raw = readFileSync(join(root, ENGINE), 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    const where = rel(root, ENGINE);
    const claimTx = stripped.search(/claimExecutionAttempt\(request,\s*taskId\)/);
    const handlerCall = stripped.search(/handler\.execute\(/);
    if (claimTx >= 0 && handlerCall >= 0 && handlerCall < claimTx) {
      push(
        'ARCH-021',
        `${where}:${lineOf(stripped, handlerCall)}`,
        'executor invoked before the durable claim',
        'Generic execution requires a durable ExecutionAttempt claim BEFORE any external executor invocation (Sprint21 final); claiming afterwards loses at-most-once ownership across a crash.',
        'Acquire and COMMIT the attempt claim first, then invoke the executor outside any transaction.',
      );
    }
    const txRe = /inTransaction\(\s*async\s*\(\)\s*=>\s*\{/g;
    let m;
    while ((m = txRe.exec(stripped)) !== null) {
      const start = m.index + m[0].length;
      let depth = 1;
      let i = start;
      while (i < stripped.length && depth > 0) {
        if (stripped[i] === '{') depth += 1;
        if (stripped[i] === '}') depth -= 1;
        i += 1;
      }
      const body = stripped.slice(start, i);
      const external = body.search(/handler\.execute\(|handlers\.resolve\(|provider\.|executor\./);
      if (external >= 0) {
        push(
          'ARCH-022',
          `${where}:${lineOf(stripped, start + external)}`,
          'external executor/provider call inside a write transaction',
          'A SQLite write transaction must never span an executor/provider/CLI/HTTP invocation (ADR-0006): a slow or crashed external call holds the write lock and corrupts the crash windows.',
          'Run the executor between transactions; the transaction only persists the claim and the settlement.',
        );
      }
    }
  }

  /* ---- ARCH-027 · UI is not truth ---------------------------------------------
   * Renderer sources import contracts only. Persistence/engine stores, Electron
   * main-process APIs and Node fs from the renderer make the UI a truth owner.
   */
  const RENDERER = 'apps/renderer/src';
  for (const file of srcFiles(RENDERER)) {
    const raw = readFileSync(file, 'utf8');
    const where = rel(root, file);
    const importRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(raw)) !== null) {
      const spec = m[1];
      const forbidden =
        spec.startsWith('@companyos/persistence') ||
        spec.startsWith('@companyos/engine') ||
        spec.startsWith('@companyos/core') ||
        spec.startsWith('@companyos/desktop') ||
        spec === 'electron' ||
        spec.startsWith('node:');
      if (forbidden) {
        push(
          'ARCH-027',
          `${where}:${lineOf(raw, m.index)}`,
          `import "${spec}"`,
          'The renderer is not a truth owner: Run/Task/Validation/finding state lives behind the application-service boundary (ADR-0008). Importing stores or main-process modules into the renderer breaks that boundary.',
          'Reach state through the preload/IPC contract (contracts only); mutations go through commands dispatched by the main process.',
        );
      }
    }
  }

  /* ---- ARCH-028 · Session is context, not workflow truth ----------------------
   * Session modules hold bounded execution context. They must not dispatch run
   * events or mutate tasks — workflow progression is the frozen machine's.
   */
  for (const file of srcFiles('packages/engine/src/session')) {
    const raw = readFileSync(file, 'utf8');
    const stripped = stripCommentsAndStrings(raw);
    const where = rel(root, file);
    const forbidden = stripped.search(/\b(dispatchInternal|applyTaskEvent|completeTaskWithOutput|transitionTask)\s*\(/);
    if (forbidden >= 0) {
      push(
        'ARCH-028',
        `${where}:${lineOf(stripped, forbidden)}`,
        'a run/task lifecycle call inside the session runtime',
        'Sessions carry bounded execution context (ADR-0030); Task DONE, Run state and validation are decided by the frozen machine and canonical services, never by a session.',
        'Return the round outcome; the supervisor/engine applies the lifecycle.',
      );
    }
  }

  /* ---- ARCH-031 · Software is a Pack (generic paths stay vocabulary-clean) -----
   * The GENERIC orchestration sources must not name software-pack concepts. The
   * ADR-0028 repository seam (packages/engine/src/repository/**) and
   * packs/dev-company are the allowed homes. One documented exception exists at
   * baseline: the bounded context projects the QA evidence SLOT vocabulary from
   * the Sprint-17 seam (slots are execution-shape data, not software semantics).
   */
  const GENERIC_MODULES = ['packages/engine/src/supervisor', 'packages/engine/src/projection'];
  const SOFTWARE_WORDS = [
    { word: 'git', owner: 'pack-devcompany / ADR-0028 repository seam', replacement: 'versioned artifact store' },
    { word: 'repository', owner: 'pack-devcompany / ADR-0028 repository seam', replacement: 'EntityStore / pinned-version graph' },
    { word: 'developer', owner: 'pack-devcompany', replacement: 'WorkRole / contributor' },
    { word: 'devcompany', owner: 'pack-devcompany', replacement: 'the pack package name' },
  ];
  const DOCUMENTED_EXCEPTIONS = [
    {
      where: 'apps/desktop/src/repository-runtime.ts',
      law: 'ARCH-007',
      reason:
        'ADR-0028 durable evidence source: selecting the latest TERMINAL tool invocation for a (run, task, tool) triple. Invocation rows are events without frozen semantic identity for this question, the order is explicit and STABLE (created_at DESC, id DESC — never implicit rowid), and the read is scoped to the invocation table only. Recency here is the answer, not semantic authority over workflow truth.',
    },
    {
      where: 'packages/engine/src/supervisor/bounded-agent-context.ts',
      import: '../repository/qa-evidence.js',
      word: 'repository',
      reason:
        'Sprint-17 seam import of REQUIRED_QA_EVIDENCE_SLOTS: the evidence SLOT vocabulary (tests/lint/typecheck/build/gitStatus/gitDiff) is execution-shape data projected into the bounded context; the owning module stays in the ADR-0028 seam. Recorded as an explicit exception (Boss §47: no silent grandfathering).',
    },
  ];
  for (const dir of GENERIC_MODULES) {
    for (const file of srcFiles(dir)) {
      const raw = readFileSync(file, 'utf8');
      const stripped = stripCommentsAndStrings(raw);
      const where = rel(root, file);
      // Import-level law: a generic module must not DEPEND on the software seam.
      // The scan reads the RAW source — an import specifier is code, not a string
      // literal (stripping would remove the very thing under guard).
      const importRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
      let im;
      while ((im = importRe.exec(raw)) !== null) {
        if (!/repository|pack-devcompany|git/i.test(im[1])) continue;
        const exempt = DOCUMENTED_EXCEPTIONS.find((e) => e.where === where && e.import === im[1]);
        if (exempt !== undefined) {
          notes.push(`EXEMPTION ${where} — import "${im[1]}": ${exempt.reason}`);
          continue;
        }
        push(
          'ARCH-031',
          `${where}:${lineOf(raw, im.index)}`,
          `import from "${im[1]}"`,
          'Generic orchestration must not depend on software-pack capabilities (Git/repository/QA-evidence semantics live in the ADR-0028 seam and the pack).',
          'Keep the generic path on neutral contracts; if the capability is genuinely needed, route it through a neutral Core port with a documented exception.',
        );
      }
      for (const { word, owner, replacement } of SOFTWARE_WORDS) {
        // Identifier-SEGMENT match: `developerTaskKinds` names the concept; the trailing
        // boundary is deliberately absent (a standalone word is a subset of a segment).
        const re = new RegExp(`\\b${word}`, 'i');
        const m = re.exec(stripped);
        if (m === null) continue;
        const exempt = DOCUMENTED_EXCEPTIONS.find((e) => e.where === where && e.word === word);
        if (exempt !== undefined) {
          notes.push(`EXEMPTION ${where} — "${word}": ${exempt.reason}`);
          continue;
        }
        push(
          'ARCH-031',
          `${where}:${lineOf(stripped, m.index)}`,
          `"${word}" as an identifier in a generic orchestration module`,
          `Software-specific semantics belong to ${owner}; the generic orchestrator must not name them (software is a Pack).`,
          `Use the neutral concept (${replacement}) and keep the vertical meaning in the pack / ADR-0028 seam.`,
        );
      }
    }
  }

  /* ---- ARCH-007 · no latest-object authority -----------------------------------
   * `ORDER BY created_at DESC` (and descending createdAt comparators) may only
   * appear inside a documented tie-break function. Recency itself is not banned;
   * recency AS SEMANTIC AUTHORITY is.
   */
  const RECENCY_MODULES = ['packages/engine/src/supervisor', 'packages/engine/src/projection', 'apps/desktop/src'];
  const TIE_BREAK_FUNCTIONS = [
    'byDeterministicRecency',
    'byRecency',
    'sameRoundTieBreak',
    'selectCanonicalSubject',
    'workSubjectTaskOf',
  ];
  for (const dir of RECENCY_MODULES) {
    for (const file of srcFiles(dir)) {
      if (/(\.test\.|tests[\\/])/.test(file)) continue;
      const raw = readFileSync(file, 'utf8');
      // SQL fragments live inside string literals (code); comments never trip a guard.
      const stripped = stripCommentsOnly(raw);
      const where = rel(root, file);
      const sqlRe = /ORDER\s+BY\s+\w*created_at\w*\s+DESC/gi;
      let m;
      while ((m = sqlRe.exec(stripped)) !== null) {
        const before = stripped.slice(Math.max(0, m.index - 400), m.index);
        const declared = TIE_BREAK_FUNCTIONS.some((name) => before.includes(`const ${name}`) || before.includes(`function ${name}`));
        const exempt = DOCUMENTED_EXCEPTIONS.find((e) => e.law === 'ARCH-007' && e.where === where);
        if (exempt !== undefined) {
          notes.push(`EXEMPTION ${where} — ARCH-007: ${exempt.reason}`);
        } else if (!declared) {
          push(
            'ARCH-007',
            `${where}:${lineOf(stripped, m.index)}`,
            'ORDER BY created_at DESC outside a documented tie-break',
            'Recency as ordering authority lets a newer row silently outrank frozen identity (latest-wins). Documented tie-breaks are the only allowed use.',
            'Order by the frozen identity (round, id) or move the query inside a documented tie-break function.',
          );
        }
      }
      const descRe = /\.sort\(\(([^)]*)\)\s*=>\s*[^)]*\b(\w+)\.createdAt[^)]*\.localeCompare\(\s*\1?\.?(\w+)?.?createdAt/gi;
      void descRe;
      const descending = /localeCompare\(\s*[A-Za-z]+\.createdAt[^)]*\)\s*(?:\)|\|\|)/gi;
      void descending;
    }
  }

  /* ---- ARCH-033 · no wholesale parent-environment inheritance ----------------
   * A child process never receives the parent environment as-is. One environment
   * law exists for every process this system creates (ADR-0028 D12, extended to
   * the Sprint25 executor seam): allowlisted host names plus validated trusted
   * additions. `{ ...process.env }` into a spawn, or `env: process.env`, is the
   * exact shape that hands a credential the operator's shell happened to carry
   * to an external provider.
   */
  const ENV_SPREAD_MODULES = ['packages/engine/src/executor', 'apps/desktop/src/executor'];
  for (const dir of ENV_SPREAD_MODULES) {
    for (const file of srcFiles(dir)) {
      if (/(\.test\.|tests[\\/])/.test(file)) continue;
      const raw = readFileSync(file, 'utf8');
      // The spread lives in code; a reference to process.env as a FILTER SOURCE
      // (hostEnv ?? process.env) is allowed and deliberately does not match.
      const stripped = stripCommentsOnly(raw);
      const where = rel(root, file);
      const spreadRe = /\.\.\.\s*process\.env\b/g;
      let m;
      while ((m = spreadRe.exec(stripped)) !== null) {
        push(
          'ARCH-033',
          `${where}:${lineOf(stripped, m.index)}`,
          'a spread of `process.env` into a child-process construction',
          'A provider/repository child inheriting the parent environment receives every credential that shell happened to carry. There is exactly ONE environment law: the allowlist plus validated trusted additions (ADR-0028 D12).',
          'Build the child environment through buildExecutorEnvironment (allowlist + declaredAdditions) and pass only allowlisted names.',
        );
      }
      const directRe = /\benv\s*:\s*process\.env\b/g;
      while ((m = directRe.exec(stripped)) !== null) {
        push(
          'ARCH-033',
          `${where}:${lineOf(stripped, m.index)}`,
          '`env: process.env` handed straight to a child',
          'Passing the parent environment object through unfiltered is the same leak by another spelling: the allowlist policy never runs.',
          'Pass the result of buildExecutorEnvironment(...) instead of the raw parent environment.',
        );
      }
    }
  }

  /* ---- ARCH-034 · path containment is a component-boundary test --------------
   * `candidate.startsWith(root)` accepts siblings that share a prefix:
   * `C:\work\foo` would accept `C:\work\foobar`. Containment must compare against
   * a SEPARATOR-TERMINATED root (`root + sep`, or the exported
   * `assertPathWithinCanonicalRoot`), never a raw prefix.
   */
  const PATH_CONTAINMENT_MODULES = ['packages/engine/src/repository', 'packages/engine/src/executor'];
  for (const dir of PATH_CONTAINMENT_MODULES) {
    for (const file of srcFiles(dir)) {
      if (/(\.test\.|tests[\\/])/.test(file)) continue;
      const raw = readFileSync(file, 'utf8');
      const stripped = stripCommentsOnly(raw);
      const where = rel(root, file);
      const re = /\.startsWith\(\s*(?:root|canonicalRoot|workspaceRoot|baseDir|base)\s*\)/g;
      let m;
      while ((m = re.exec(stripped)) !== null) {
        push(
          'ARCH-034',
          `${where}:${lineOf(stripped, m.index)}`,
          `a raw prefix containment test (${m[0]})`,
          'A bare `startsWith(root)` accepts `C:\\work\\foobar` for the root `C:\\work\\foo` — a sibling directory outside the trusted workspace. Containment is a path COMPONENT boundary test (a separator-terminated root) or the shared containment helper.',
          'Compare against `root + sep` (or call assertPathWithinCanonicalRoot), so the boundary is a component boundary, not a string prefix.',
        );
      }
    }
  }

  /* ---- ARCH-035 · the renderer is untrusted (no domain/durable imports) ---------
   * The renderer may talk to the preload bridge ONLY. Importing persistence,
   * SQLite, the engine's domain services or a provider adapter from renderer
   * sources would hand an untrusted process durable or external authority.
   */
  const RENDERER_BANS = [
    { pattern: /@companyos\/persistence/, why: 'renderer must not reach the durable layer' },
    { pattern: /better-sqlite3/, why: 'renderer must not open SQLite' },
    { pattern: /@companyos\/engine/, why: 'renderer must not import domain services' },
    { pattern: /executor\/dsh-executor-provider/, why: 'renderer must not reach provider adapters' },
    { pattern: /child_process/, why: 'renderer must not spawn processes' },
  ];
  for (const file of srcFiles('apps/renderer/src')) {
    // Import specifiers live in string literals, so the scan reads the RAW source
    // (the same discipline ARCH-003 uses), not the comment/string-stripped form.
    const raw = readFileSync(file, 'utf8');
    for (const ban of RENDERER_BANS) {
      const re = new RegExp(ban.pattern.source, 'g');
      let m;
      while ((m = re.exec(raw)) !== null) {
        push(
          'ARCH-035',
          `${rel(root, file)}:${lineOf(raw, m.index)}`,
          `renderer imports forbidden module (${ban.why})`,
          'The renderer is untrusted: it may only call the preload bridge. A domain, durable or provider import hands it authority the trust boundary reserves to the main process.',
          'Route the need through a typed IPC channel handled by a trusted main-process service.',
        );
      }
    }
  }

  /* ---- ARCH-036 · the Control Plane projection is read-only --------------------
   * control-plane.ts is the Goal runtime's typed surface. It may forward commands to
   * canonical services, but its own module must not write durable stores directly —
   * a dashboard that writes becomes a second truth owner.
   */
  for (const file of srcFiles('apps/desktop/src/control-plane.ts')) {
    // SQL fragments live in string literals, so the scan keeps strings (the same
    // discipline ARCH-007 uses for SQL), stripping comments only.
    const stripped = stripCommentsOnly(readFileSync(file, 'utf8'));
    const where = rel(root, file);
    const writeRe = /\.db\s*\.\s*prepare\s*\(\s*['"](INSERT|UPDATE|DELETE|CREATE|DROP)/g;
    let m;
    while ((m = writeRe.exec(stripped)) !== null) {
      push(
        'ARCH-036',
        `${where}:${lineOf(stripped, m.index)}`,
        'a direct SQL write inside the control-plane module',
        'The Control Plane owns no truth: durable writes belong to the canonical services it forwards to. A direct SQL write here would create a second truth owner behind the UI.',
        'Forward the mutation to the owning canonical service (lifecycle/engine/supervisor) instead of writing SQL.',
      );
    }
  }

  /* ---- ARCH-037 · an external provider is never CompanyOS authority -------------
   * Frozen from the V1 Product Reachability closeout: ModelProvider and
   * ExecutorProvider are subordinate capability adapters. Two mechanical facets:
   *   (a) production sources never resolve the TEST mock provider — a mock in the
   *       shipped composition would fabricate reasoning/execution silently;
   *   (b) Core and Engine stay vendor-neutral — no external provider brand may
   *       appear as an identifier in the frozen inner rings (adapters live in the
   *       composition/adapter layer; routing targets are deployment DATA).
   */
  for (const file of srcFiles('apps/desktop/src')) {
    const raw = readFileSync(file, 'utf8');
    const mockRe = /['"]([^'"]*mock-provider[^'"]*)['"]/g;
    let mockMatch;
    while ((mockMatch = mockRe.exec(raw)) !== null) {
      push(
        'ARCH-037',
        `${rel(root, file)}:${lineOf(raw, mockMatch.index)}`,
        `a production source imports the test mock provider (${mockMatch[1]})`,
        'The mock provider is test infrastructure: resolving it from the shipped composition would silently fabricate model reasoning. Production registers real adapters only, and a missing adapter fails loud with a typed state.',
        'Register a real ModelProviderPort adapter from the composition (as the OpenAI-compatible and dsh adapters do); keep MockProvider inside tests.',
      );
    }
  }
  const vendorRe = /\b(?:dsh|deepseek|openai|codex|zcode)\b/gi;
  for (const file of [...srcFiles('packages/core/src'), ...srcFiles('packages/engine/src')]) {
    const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    let vendorMatch;
    while ((vendorMatch = vendorRe.exec(stripped)) !== null) {
      push(
        'ARCH-037',
        `${rel(root, file)}:${lineOf(stripped, vendorMatch.index)}`,
        `a vendor identifier in the frozen inner ring (${vendorMatch[0]})`,
        'Core and Engine are vendor-neutral: an external provider brand as an identifier would bind the product to that provider. Adapters live in the composition/adapter layer and routing targets are deployment data, never inner-ring code.',
        'Move the provider-specific name into a desktop-layer adapter or a deployment configuration value; keep the inner ring speaking only the port contracts.',
      );
    }
  }


  /* ---- ARCH-038 · reasoning and execution are different capability classes -------
   * Frozen from the V1 Execution Architecture Freeze (§26): ModelProviderPort is
   * reasoning; ExecutorProvider is external execution; neither implements the other
   * and neither side may reach into the other's runtime machinery. Mechanical facet
   * (raw-source import-specifier scan — the ARCH-035 discipline, because specifiers
   * live in string literals the stripper removes): the supervisor/planning REASONING
   * modules must not import executor-provider machinery, and the executor-dispatch
   * layer must not import the model registry.
   */
  for (const file of [...srcFiles('packages/engine/src/supervisor'), ...srcFiles('packages/engine/src/planning')]) {
    const raw = readFileSync(file, 'utf8');
    const re = /['"][^'"]*(?:executor-provider|process-executor-provider)\.js['"]/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      push(
        'ARCH-038',
        `${rel(root, file)}:${lineOf(raw, m.index)}`,
        `a REASONING module imports executor-provider machinery (${m[0]})`,
        'ModelProviderPort is reasoning and ExecutorProvider is external execution — two frozen capability classes. A reasoning runtime importing executor machinery fuses them and lets planning/supervision grow execution authority.',
        'Keep the reasoning runtime on the model-provider seam; execution belongs to the executor handler path.',
      );
    }
  }
  for (const file of srcFiles('apps/desktop/src/executor')) {
    const raw = readFileSync(file, 'utf8');
    const re = /['"][^'"]*registry\/model-registry\.js['"]/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      push(
        'ARCH-038',
        `${rel(root, file)}:${lineOf(raw, m.index)}`,
        `the EXECUTION dispatch layer imports the model registry (${m[0]})`,
        'The executor dispatch executes canonical attempts through ExecutorProviders; model selection belongs to the model/selection seam. A cross-import would let execution grow model-routing authority.',
        'Resolve model bindings at the reasoning seam; the dispatch consumes only canonical attempt requests.',
      );
    }
  }


  /* ---- ARCH-039 · natural-language task content is never an executable ------------
   * Frozen from the V1 Native Execution Foundation (§4/§20): argv/executable
   * authority belongs to TRUSTED DEPLOYMENT DATA; free-form task prose can never be
   * interpolated into a command. Mechanical facet: the native provider module may
   * reference request.taskText / work.objective ONLY in comments — any code-level
   * use (the argv construction seam) is the forbidden interpolation.
   */
  for (const file of srcFiles('apps/desktop/src/executor/native-process-provider.ts')) {
    const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'));
    const proseRe = /(?:request|req)\.taskText|work\.objective|taskText\s*\+|\+\s*taskText/g;
    let m;
    while ((m = proseRe.exec(stripped)) !== null) {
      push(
        'ARCH-039',
        `${rel(root, file)}:${lineOf(stripped, m.index)}`,
        `natural-language task content used in executable code (${m[0]})`,
        'Natural-language Task content must never become argv/executable (the free-text-to-shell invariant). Executable authority belongs to the trusted deployment operation profile; typed Task.inputs are DATA arguments only.',
        'Build argv exclusively from the operation profile literals and typed input values; keep task prose out of the execution seam.',
      );
    }
  }

  /* ---- ARCH-040 · the Smart Router is a pure deterministic decision function ----
   * Frozen from Stage 8 §B: Router Uses LLM = NO, Model Tournament = NO,
   * Adaptive Learning = NO. The router module may not import provider/executor/
   * registry machinery, may not perform any network call, and may not carry a
   * tournament, vote, fallback or adaptive-learning identifier. A router that
   * calls a model to pick a model, votes among models, or learns from history is
   * a different (and forbidden) architecture.
   */
  {
    const routerFiles = srcFiles('apps/desktop/src/executor/smart-model-router.ts');
    for (const file of routerFiles) {
      const raw = readFileSync(file, 'utf8');
      const where = rel(root, file);
      // Import specifiers live in string literals the stripper removes — scan raw.
      const specRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = specRe.exec(raw)) !== null) {
        const spec = m[1];
        if (/dsh-executor-provider|provider-dispatch|native-process-provider|registry\/model-registry|openai|anthropic/.test(spec)) {
          push(
            'ARCH-040',
            `${where}:${lineOf(raw, m.index)}`,
            `the Smart Router imports provider/executor machinery ("${spec}")`,
            'The Smart Router is a pure deterministic decision function over static metadata (Stage 8 §B: Router Uses LLM = NO). Importing provider or executor machinery lets routing grow execution or LLM-as-router authority.',
            'Keep the router on the ModelPool contract only; provider calls belong to the executor/broker seam.',
          );
        }
      }
      const stripped = stripCommentsAndStrings(raw);
      if (/fetch\s*\(/.test(stripped)) {
        push('ARCH-040', where, 'a network call inside the Smart Router', 'The router decides; it never talks to a provider (Stage 8 §B: Router Uses LLM = NO).', 'Resolve the selected profile at the broker seam; keep routing offline and deterministic.');
      }
      const forbiddenIdentifiers = /\b(?:tournament|vote|voting|fallback|adaptive|learnFromHistory|historicalSuccess|successRate)\b/gi;
      let f;
      while ((f = forbiddenIdentifiers.exec(stripped)) !== null) {
        push(
          'ARCH-040',
          `${where}:${lineOf(stripped, f.index)}`,
          `forbidden routing identifier "${f[0]}" in the Smart Router`,
          'Stage 8 §B forbids Model Tournament, adaptive learning and hidden fallback in the router. An identifier of that shape in router source is the forbidden mechanism (or its seed).',
          'Delete the mechanism; routing is deterministic hard-filter + weighted scoring with a declared tie-breaker.',
        );
      }
    }
  }

  /* ---- ARCH-041 · role collaboration has no second truth and no peer chat -------
   * Frozen from Stage 8 §A: collaboration flows through durable objects and the
   * Professional Handoff Contract. There is no role_messages / agent_chat_truth /
   * team_task_store / agent_team_scheduler / peer_workflow_state — neither as a
   * persistence table (with ARCH-005/006) nor as an identifier in the executor
   * collaboration module.
   */
  {
    const FORBIDDEN_COLLABORATION = [
      'role_messages',
      'agent_chat_truth',
      'agent_chat',
      'team_task_store',
      'agent_team_scheduler',
      'peer_workflow_state',
      'peer_message_truth',
    ];
    for (const file of srcFiles('apps/desktop/src/executor/role-collaboration.ts')) {
      const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      const where = rel(root, file);
      for (const name of FORBIDDEN_COLLABORATION) {
        const re = new RegExp(`\\b${name}\\b`, 'g');
        let m;
        while ((m = re.exec(stripped)) !== null) {
          push(
            'ARCH-041',
            `${where}:${lineOf(stripped, m.index)}`,
            `second-truth identifier "${name}" in the collaboration module`,
            'Stage 8 §A: collaboration has NO second truth and NO peer chat. A message/team/scheduler store beside the canonical Task chain would become a shadow execution authority.',
            'Express collaboration through the Professional Handoff Contract over durable objects (Task/Artifact/Evidence/Decision); derive every view.',
          );
        }
      }
      // A scheduler/queue mutator in the collaboration module is the same violation in API form.
      if (/\b(?:scheduleTask|assignTask|dispatchTask|enqueueTask)\b/.test(stripped)) {
        push(
          'ARCH-041',
          where,
          'a scheduling/assignment mutator in the collaboration module',
          'The PM coordinates handoffs; it is NOT a scheduler (Stage 8 §A). A scheduling mutator here would make collaboration own canonical scheduling truth.',
          'Keep task state changes in the canonical Task lifecycle; collaboration only builds handoffs and derives views.',
        );
      }
    }
  }

  /* ---- ARCH-042 · the RoleInstance never owns a selected model --------------------
   * Frozen by Stage 7B and re-asserted by Stage 8 §B: ExecutionAttempt is the
   * sole owner of the SelectedModelSnapshot. A modelLock / selectedModel field
   * on the RoleInstance interface (or a router mutating a role) is the ownership
   * regression this law blocks.
   */
  {
    for (const file of [...srcFiles('apps/desktop/src/executor/role-orchestration.ts'), ...srcFiles('apps/desktop/src/executor/smart-model-router.ts')]) {
      const raw = readFileSync(file, 'utf8');
      const where = rel(root, file);
      const ifaceMatch = /interface\s+RoleInstance\s*\{([\s\S]*?)\n\}/.exec(raw);
      if (ifaceMatch !== null) {
        const body = stripCommentsAndStrings(ifaceMatch[1] ?? '');
        const fieldRe = /\b(modelLock|selectedModel|modelProfileId)\s*\??\s*:/g;
        let m;
        while ((m = fieldRe.exec(body)) !== null) {
          push(
            'ARCH-042',
            `${where}: RoleInstance`,
            `RoleInstance declares the model field "${m[1]}"`,
            'Stage 7B/Stage 8 §B: the ExecutionAttempt owns the SelectedModelSnapshot; a RoleInstance may carry modelSelectionRequirements only. A model field on the role makes one role instance serialize a model choice across attempts.',
            'Return the snapshot on the attempt (selectModelForAttempt / routeModelForAttempt); the role contributes requirements only.',
          );
        }
      }
      // The router is a decision function: it never writes back onto the role object.
      const stripped = stripCommentsAndStrings(raw);
      if (/\brole\s*\.\s*(?:modelLock|selectedModel|modelProfileId)\s*=/.test(stripped)) {
        push(
          'ARCH-042',
          where,
          'routing writes model truth onto the role object',
          'Routing returns a RoutingDecision + snapshot for ONE attempt; mutating the role would re-introduce per-role model ownership (Stage 7B).',
          'Return the decision; let the ExecutionAttempt record the snapshot.',
        );
      }
    }
  }

  /* ---- ARCH-043 · the kernel/provider never routes; collaboration never mutates tasks ----
   * Frozen from Stage 8B §10/§18 (runtime ownership gaps only — no law inflation):
   *   (a) the embedded DSH kernel/provider must not import the Smart Router — it
   *       CONSUMES the CompanyOS-selected route on the request and never re-scores,
   *       re-fallbacks or re-routes. Selection authority stays in the application
   *       layer (the dispatch's routing phase).
   *   (b) the collaboration/runtime-bridge modules must not carry task-state
   *       mutators — the PM coordinates by producing handoffs; Task readiness,
   *       claiming and settlement stay with the CompanyOS engine.
   */
  {
    const kernelFiles = srcFiles('apps/desktop/src/executor/dsh-executor-provider.ts');
    for (const file of kernelFiles) {
      const raw = readFileSync(file, 'utf8');
      const where = rel(root, file);
      // Import specifiers live in string literals the stripper removes — scan raw.
      const specRe = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
      let m;
      while ((m = specRe.exec(raw)) !== null) {
        if (/smart-model-router/.test(m[1])) {
          push(
            'ARCH-043',
            `${where}:${lineOf(raw, m.index)}`,
            `the kernel/provider imports the Smart Router ("${m[1]}")`,
            'Stage 8B §10: the kernel receives the CompanyOS-selected ModelProfile and must never choose, re-score or re-route. A provider importing the router is hidden routing inside the execution layer.',
            'Route at the application seam (the dispatch routing phase) and pass the selected route on the request; the provider consumes it verbatim.',
          );
        }
      }
    }
    const collaborationFiles = [
      ...srcFiles('apps/desktop/src/executor/runtime-collaboration.ts'),
      ...srcFiles('apps/desktop/src/executor/role-collaboration.ts'),
      ...srcFiles('apps/desktop/src/executor/runtime-routing.ts'),
    ];
    for (const file of collaborationFiles) {
      const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'));
      const where = rel(root, file);
      if (/\b(?:settleTask|claimTask|completeTask|failTask|mutateTask|transitionTask|setTaskState)\b/.test(stripped)) {
        push(
          'ARCH-043',
          where,
          'a task-state mutator in the collaboration/runtime bridge',
          'Stage 8B §18: the PM coordinates handoffs but is NOT a scheduler. Task readiness, claiming and settlement stay with the CompanyOS engine; a mutator here would let collaboration own canonical task truth.',
          'Express coordination as durable handoffs; let the engine own Task lifecycle transitions.',
        );
      }
    }
  }

  /* ---- ARCH-044 · the normal goal pipeline never flattens work onto a generic seat ----
   * Frozen from Stage 8C §1-§6/§24: every plan item's professional responsibility
   * resolves through the deterministic Stage 7 RoleResolver into the seat pinned
   * into its task profile. The control plane — the one trusted derivation point —
   * must not hardcode a single generic worker seat for the normal path.
   */
  {
    for (const file of srcFiles('apps/desktop/src/control-plane.ts')) {
      // The seat literal lives inside a string — scan RAW source (comments
      // included deliberately: a commented generic seat is the seed of
      // reintroduction).
      const where = rel(root, file);
      if (/['"]rol\.worker['"]/.test(readFileSync(file, 'utf8'))) {
        push(
          'ARCH-044',
          where,
          "the control plane pins the generic worker seat 'rol.worker'",
          'Stage 8C: the normal Goal→Plan→Execution path resolves each plan item through the professional-seat resolver (catalog match or deterministic dynamic spec). A hardcoded generic seat re-flattens all work onto one role and defeats dynamic professional roles.',
          'Resolve the seat via the professionalSeatOf seam (resolveProfessionalSeat) and pin that seat into the task profile; rol.worker may exist only as an explicitly pinned legacy/diagnostic seat outside the control plane.',
        );
      }
    }
  }

  return { violations, notes, scanned: { sources: srcFiles('packages').length + srcFiles('apps').length, migrations: migrationCount } };
}

/* ------------------------------------------------------------------ the CLI */

function main() {
  const root = resolveRoot(process.argv.slice(2));
  const asJson = process.argv.includes('--json');
  const { violations, notes, scanned } = checkArchitecture(root);

  if (asJson) {
    console.log(JSON.stringify({ violations, notes, scanned }, null, 2));
    process.exit(violations.length === 0 ? 0 : 1);
  }

  console.log(`▌ Architecture guard — ${scanned.sources} source file(s), ${scanned.migrations} migration(s) scanned under ${root}`);
  if (notes.length > 0) {
    console.log(`▌ ${notes.length} documented exemption(s):`);
    for (const n of notes) console.log(`   ${n}`);
  }
  if (violations.length === 0) {
    console.log('✅ Architecture guard PASSED — 0 violations (ARCH-003..ARCH-044).');
    process.exit(0);
  }
  console.error(`❌ Architecture guard FAILED — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error('');
    console.error(`Architecture Law violated: ${v.law}`);
    console.error(`  What was found: ${v.what}`);
    console.error(`  Where:          ${v.where}`);
    console.error(`  Why it violates architecture:`);
    console.error(`    ${v.why}`);
    console.error(`  Allowed boundary / remediation:`);
    console.error(`    ${v.fix}`);
  }
  process.exit(1);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (invokedDirectly || process.argv[1]?.endsWith('check-architecture.mjs')) {
  main();
}
