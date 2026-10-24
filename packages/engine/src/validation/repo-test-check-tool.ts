/**
 * `repo.test-check` — the SPECIALIZED software-behavior validator tool (BB2 final forensic:
 * SOFTWARE_SPECIALIZED_VALIDATION_CANONICALITY closure; F3 containment hardening).
 *
 * ONE verifier tool that answers a single deterministic question about the GOAL-BOUND
 * workspace, independent of any model claim: "does the workspace's OWN declared test
 * contract pass right now?"
 *
 *   WHAT IT CHECKS (deterministic, project-owned contract):
 *     the bound workspace's `package.json` declares `scripts.test` — the standard npm test
 *     contract — and that command, executed FRESH by this validator, exits 0.
 *
 *   INDEPENDENCE (the P1 semantic rule): the implementation Attempt's own test runs and
 *   any VERIFICATION-style artifact are NOT consulted. The validator executes the test
 *   contract itself at validation time through an INJECTED bounded process port, so an
 *   implementation cannot force PASS by claiming, faking or selectively citing a run.
 *   A workspace that declares no test contract FAILS — unverifiable software work is
 *   never silently accepted.
 *
 *   F3 CONTAINMENT — the validator obeys the SAME canonical Goal authority / workspace
 *   boundary as the work it validates:
 *     1. The workspace is the GOAL'S DURABLE BINDING (run-goal structured payload), not
 *        "whatever is open right now"; a binding/current mismatch fails closed with a
 *        typed canonical blocker — the validator never executes against the wrong
 *        workspace, and a missing binding is refused.
 *     2. The validator NEVER executes against the user's canonical workspace: it runs in
 *        a bounded SNAPSHOT COPY (fresh temp dir, deleted after the run). Under READ_ONLY
 *        the canonical workspace cannot be mutated by the validation; under any policy
 *        the validator gains no arbitrary write authority over the real workspace — and
 *        nothing the tested project writes can escape onto the user's files.
 *     3. F3 LINK CONTAINMENT (the cpSync hole this closure removes): the snapshot is
 *        materialized by a manual bounded copy that never preserves an outbound LINK.
 *        Every symbolic link / junction inside the workspace is resolved against the
 *        bound root: a link whose target is INSIDE the workspace is materialized as real
 *        content in the snapshot (a write through it stays in the snapshot), a link whose
 *        target escapes the bound root, a dangling link or a link cycle REFUSES the
 *        validation with a typed reason — a link copied verbatim would let the project
 *        write through it onto external files.
 *     4. F3 DEPENDENCY FIDELITY: installed dependencies (`node_modules`) are INCLUDED in
 *        the snapshot (bounded by the snapshot limits below) so a project whose test
 *        contract needs its installed dependencies is not falsely failed by an
 *        environment the validator itself stripped. A workspace that exceeds the bounds
 *        is refused with the typed
 *        VALIDATION_ENVIRONMENT_UNAVAILABLE reason (never partially executed, never a
 *        silent false verdict). Only VCS metadata (`.git`) is excluded from the copy.
 *     5. The Goal's accessPolicy rides the resolved context and is recorded in the
 *        durable report (auditable authority, never redefined).
 *
 *   HONEST BOUNDARY — the snapshot contains what the project's own RELATIVE path
 *   machinery can reach: a test script that addresses absolute paths outside the
 *   snapshot is ordinary process code running under the session OS authority, which a
 *   filesystem snapshot cannot sandbox (that boundary is the deferred OS-sandbox
 *   question, not a validator guarantee). What this validator guarantees is that the
 *   copy it executes in contains no preserved link out of the snapshot, so ordinary
 *   project machinery (relative reads/writes, installed dependencies) stays inside it.
 *
 *   NON-SELECTING INPUT — the model cannot nominate a command, an expected result, a
 *   timeout or a file: the command comes from the workspace's own package.json, the scope
 *   from the trusted invocation context (runId/targetRef), the execution from the trusted
 *   port.
 *
 *   VERIFIER ONLY — no model call, no approval state. The process execution happens
 *   through the injected port whose composition implementation carries the frozen
 *   repository process discipline (allowlisted child environment — never the parent env,
 *   bounded output capture, armed deadline; the engine boundary bans engine-held timers).
 *
 *   VERDICT VS ERROR — `verdict: 'fail'` is a business verdict recorded on a COMPLETED
 *   invocation; only an infrastructure failure makes the invocation itself FAILED.
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import {
  domainError,
  TOOL_CAPABILITY_VALIDATOR,
  createToolRecord,
  err,
  ok,
  type DomainError,
  type Result,
  type ToolDescriptor,
  type ToolPort,
  type ToolRecord,
  type ToolRequest,
  type ToolResult,
} from '@companyos/core';

export const REPO_TEST_CHECK_TOOL_ID = 'repo.test-check';

/** The durable report kind this validator materializes through the ValidationService. */
export const REPO_TEST_CHECK_REPORT_KIND = 'companyos/repo-test-check-report';
const REPORT_KIND = REPO_TEST_CHECK_REPORT_KIND;

/** Bounded reads/writes: a verifier must never become an unbounded scanner. */
const MAX_PACKAGE_JSON_BYTES = 256 * 1024;
const MAX_OUTPUT_TAIL_CHARS = 2_000;

/**
 * F3 snapshot bounds. The copy INCLUDES installed dependencies (F3 dependency fidelity),
 * so the bounds are sized for a real project with a populated `node_modules`; a workspace
 * beyond them is refused (typed VALIDATION_ENVIRONMENT_UNAVAILABLE), never partially
 * executed. `limits` is injectable so the bounded-refusal behavior is testable without
 * materializing a production-scale tree.
 */
export interface SnapshotLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = { maxFiles: 150_000, maxTotalBytes: 1024 * 1024 * 1024 };
/** Only VCS metadata is excluded — dependency trees and everything else are copied (F3). */
const SNAPSHOT_EXCLUDED = new Set(['.git']);
const SNAPSHOT_MAX_DEPTH = 24;

export interface RunWorkspaceContext {
  /** The GOAL-BOUND canonical workspace root. */
  readonly root: string;
  /** The Goal's canonical access policy (durable, from the run-goal structured payload). */
  readonly accessPolicy: string;
  /** True when the currently open workspace differs from the binding (fail closed). */
  readonly mismatch: boolean;
}

export interface RepoTestCheckDeps {
  /**
   * F3 — the run-scoped canonical context resolver (composition-owned): resolves
   * Goal → durable workspace binding + accessPolicy and compares the binding with the
   * currently open workspace. Null ⇒ the run has no binding (refused).
   */
  readonly resolveRunContext: (runId: string) => Promise<RunWorkspaceContext | null>;
  /**
   * The INJECTED bounded process port (composition-owned). The composition implementation
   * executes `npm test` in the given cwd under the repository process discipline: fixed
   * constant command (no shell interpolation of any value), allowlisted child environment
   * (never the parent environment — ADR-0028 D12), bounded output capture, armed deadline.
   */
  readonly runTestContract: (input: {
    readonly cwd: string;
  }) => Promise<{ readonly exitCode: number; readonly timedOut: boolean; readonly outputTail: string }>;
  /**
   * F3 — OPTIONAL snapshot bounds (composition/test seam). Defaults to a real-project
   * sized bound; injected small in tests to exercise the typed bounded refusal.
   */
  readonly limits?: SnapshotLimits;
  readonly clock: { nowIso(): string };
}

export interface RepoTestCheckSpec {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: 'MEDIUM';
  readonly capabilities: readonly string[];
  readonly idempotencyMode: 'IDEMPOTENT_KEY';
  readonly timeoutMs: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export const REPO_TEST_CHECK_SPEC: RepoTestCheckSpec = {
  toolId: REPO_TEST_CHECK_TOOL_ID,
  name: 'Repository test contract validator',
  description:
    "Verifier-only: executes the GOAL-BOUND workspace's OWN declared test contract (package.json scripts.test) fresh at validation time inside a bounded snapshot copy — links materialized, installed dependencies included — and passes only when it exits 0. Independent of any implementation self-report; enforces the Goal's workspace binding and access authority; a workspace without a test contract fails.",
  version: '1.2.0',
  riskLevel: 'MEDIUM',
  capabilities: [TOOL_CAPABILITY_VALIDATOR],
  idempotencyMode: 'IDEMPOTENT_KEY',
  timeoutMs: 600_000,
  inputSchema: {
    type: 'object',
    properties: {
      targetRef: { type: 'string', minLength: 1 },
      artifactId: { type: 'string', minLength: 1 },
      runId: { type: 'string', minLength: 1 },
      kind: { type: 'string', minLength: 1 },
      contentRef: { type: 'string', minLength: 1 },
      contentHash: { type: 'string', minLength: 1 },
      sizeBytes: { type: 'number' },
    },
    required: ['targetRef', 'artifactId', 'runId'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'fail'] },
      command: { type: 'string' },
      exitCode: { type: 'number' },
      timedOut: { type: 'boolean' },
      outputTail: { type: 'string' },
      accessPolicy: { type: 'string' },
      executedOn: { type: 'string', enum: ['snapshot'] },
      reasons: { type: 'array', items: { type: 'string' } },
      evidenceRefs: { type: 'array', items: { type: 'string' } },
      report: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          label: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['kind', 'label', 'content'],
        additionalProperties: false,
      },
    },
    required: ['verdict', 'command', 'exitCode', 'timedOut', 'outputTail', 'accessPolicy', 'executedOn', 'reasons', 'evidenceRefs', 'report'],
    additionalProperties: false,
  },
};

/** Build the registry record (validated by Core, so the spec cannot be malformed). */
export const createRepoTestCheckRecord = (
  spec: RepoTestCheckSpec,
  now: string,
): Result<ToolRecord, DomainError> =>
  createToolRecord({
    toolId: spec.toolId,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    capabilities: spec.capabilities,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    riskLevel: spec.riskLevel,
    requiredAuthorities: ['tool.invoke'],
    timeoutMs: spec.timeoutMs,
    idempotencyMode: spec.idempotencyMode,
    auditPolicy: 'STANDARD',
    providerKind: 'validation',
    adapterRef: spec.toolId,
    now,
  });

const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(bytes);

const tail = (text: string): string => {
  const flat = text.replace(/\r\n/g, '\n').trim();
  return flat.length <= MAX_OUTPUT_TAIL_CHARS ? flat : `…${flat.slice(flat.length - MAX_OUTPUT_TAIL_CHARS)}`;
};

/** A typed snapshot refusal: never a verdict — the environment cannot be built faithfully. */
interface SnapshotRefusal {
  readonly reason:
    | 'SNAPSHOT_BOUND_EXCEEDED'
    | 'WORKSPACE_SYMLINK_ESCAPES_ROOT'
    | 'WORKSPACE_SYMLINK_UNRESOLVABLE'
    | 'WORKSPACE_SYMLINK_CYCLE';
  readonly detail: string;
}

type CopyOutcome = true | SnapshotRefusal;

/**
 * F3 — bounded manual snapshot copy (the cpSync hole: `cpSync` preserves outbound
 * symlinks/junctions verbatim, so a link inside the workspace survived the copy and a
 * write through it in the snapshot mutated the EXTERNAL target).
 *
 * This copy materializes links: an internal link's target content is copied into the
 * snapshot as real content (writes through it stay inside), while an external, dangling
 * or cyclic link REFUSES the whole validation with a typed reason. The real workspace
 * root is re-resolved (`realpathSync`) so the containment decision is made on canonical
 * paths, never on lexical prefixes.
 */
const buildSnapshot = (
  root: string,
  limits: SnapshotLimits,
): { ok: true; dir: string } | { ok: false; refusal: SnapshotRefusal } => {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, refusal: { reason: 'WORKSPACE_SYMLINK_UNRESOLVABLE', detail: 'the bound workspace root does not resolve' } };
  }
  const norm = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  const insideRoot = (realPath: string): boolean =>
    norm(realPath) === norm(realRoot) || norm(realPath).startsWith(norm(realRoot).endsWith(sep) ? norm(realRoot) : `${norm(realRoot)}${sep}`);

  let files = 0;
  let totalBytes = 0;
  const overBound = (): SnapshotRefusal | null => {
    if (files > limits.maxFiles) {
      return { reason: 'SNAPSHOT_BOUND_EXCEEDED', detail: 'workspace exceeds the snapshot file-count bound' };
    }
    if (totalBytes > limits.maxTotalBytes) {
      return { reason: 'SNAPSHOT_BOUND_EXCEEDED', detail: 'workspace exceeds the snapshot size bound' };
    }
    return null;
  };
  const copyFile = (src: string, dest: string, mode: number): SnapshotRefusal | null => {
    files += 1;
    totalBytes += statSync(src).size;
    const bound = overBound();
    if (bound !== null) return bound;
    copyFileSync(src, dest);
    if (process.platform !== 'win32') {
      try {
        chmodSync(dest, mode & 0o777);
      } catch {
        // best effort — a mode-preservation failure never changes the verdict
      }
    }
    return null;
  };

  const copyTree = (srcDir: string, destDir: string, depth: number, ancestors: ReadonlySet<string>): CopyOutcome => {
    if (depth > SNAPSHOT_MAX_DEPTH) {
      return { reason: 'SNAPSHOT_BOUND_EXCEEDED', detail: 'workspace nesting exceeds the snapshot depth bound' };
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(srcDir);
    } catch {
      return true;
    }
    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (SNAPSHOT_EXCLUDED.has(entry)) continue;
      const full = join(srcDir, entry);
      const dest = join(destDir, entry);
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        // F3 link containment: resolve the link against the bound root and MATERIALIZE
        // its target content — a preserved link could redirect a write out of the copy.
        let realTarget: string;
        let targetStat;
        try {
          realTarget = realpathSync(full);
          targetStat = statSync(realTarget);
        } catch {
          return {
            reason: 'WORKSPACE_SYMLINK_UNRESOLVABLE',
            detail: `the workspace link "${relative(realRoot, full)}" does not resolve to existing content`,
          };
        }
        if (!insideRoot(realTarget)) {
          return {
            reason: 'WORKSPACE_SYMLINK_ESCAPES_ROOT',
            detail: `the workspace link "${relative(realRoot, full)}" points outside the bound workspace`,
          };
        }
        const key = norm(realTarget);
        if (ancestors.has(key)) {
          return {
            reason: 'WORKSPACE_SYMLINK_CYCLE',
            detail: `the workspace link "${relative(realRoot, full)}" forms a cycle`,
          };
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(key);
        if (targetStat.isDirectory()) {
          const nested = copyTree(realTarget, dest, depth + 1, nextAncestors);
          if (nested !== true) return nested;
          continue;
        }
        if (targetStat.isFile()) {
          const failed = copyFile(realTarget, dest, targetStat.mode);
          if (failed !== null) return failed;
        }
        continue;
      }
      if (lst.isDirectory()) {
        const nested = copyTree(full, dest, depth + 1, ancestors);
        if (nested !== true) return nested;
        continue;
      }
      if (!lst.isFile()) continue; // sockets/PIPEs are not part of a test environment
      const failed = copyFile(full, dest, lst.mode);
      if (failed !== null) return failed;
    }
    return true;
  };

  const dir = mkdtempSync(join(tmpdir(), 'companyos-testcheck-'));
  const outcome = copyTree(root, dir, 0, new Set([norm(realRoot)]));
  if (outcome !== true) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, refusal: outcome };
  }
  return { ok: true, dir };
};

export const createRepoTestCheckPort = (
  spec: RepoTestCheckSpec,
  deps: RepoTestCheckDeps,
): ToolPort => {
  const descriptor: ToolDescriptor & { readonly id?: string; readonly enabled?: boolean } = {
    toolId: spec.toolId,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    riskLevel: spec.riskLevel,
    capabilities: [...spec.capabilities].sort(),
    parameters: spec.inputSchema,
  };

  return {
    async invoke(request: ToolRequest): Promise<Result<ToolResult, DomainError>> {
      const input = (request.input ?? {}) as Record<string, unknown>;
      const artifactId = String(input['artifactId'] ?? '');
      const runId = String(input['runId'] ?? '');

      // F3 (1) — the run-scoped canonical context: Goal → durable binding + accessPolicy,
      // verified against the currently open workspace. Fail closed on absence/mismatch
      // BEFORE any process executes.
      const ctx = await deps.resolveRunContext(runId);
      if (ctx === null) {
        return err(
          domainError('VALIDATION_FAILED', 'The run has no durable workspace binding; the software validator refuses to execute.', {
            reason: 'GOAL_WORKSPACE_NOT_BOUND',
            runId,
          }),
        );
      }
      if (ctx.mismatch) {
        return err(
          domainError('VALIDATION_FAILED', 'The currently open workspace differs from the Goal workspace binding; the software validator refuses to execute.', {
            reason: 'GOAL_WORKSPACE_MISMATCH',
            runId,
            boundRoot: ctx.root,
          }),
        );
      }

      // The workspace's OWN declared test contract (project-owned metadata — the same
      // source `npm test` resolves). Never a model-nominated command.
      let script: string | null = null;
      let readError: string | null = null;
      try {
        const raw = readFileSync(join(ctx.root, 'package.json'));
        if (raw.byteLength > MAX_PACKAGE_JSON_BYTES) {
          readError = 'package.json exceeds the bounded read size.';
        } else {
          const parsed: unknown = JSON.parse(decode(raw));
          const scripts =
            typeof parsed === 'object' && parsed !== null
              ? (parsed as Record<string, unknown>)['scripts']
              : undefined;
          const test =
            typeof scripts === 'object' && scripts !== null
              ? (scripts as Record<string, unknown>)['test']
              : undefined;
          script = typeof test === 'string' && test.trim() !== '' ? test : null;
          if (script === null) readError = 'package.json declares no scripts.test test contract.';
        }
      } catch {
        readError = 'The workspace declares no package.json test contract.';
      }

      const finish = (
        verdict: 'pass' | 'fail',
        fields: {
          readonly command: string;
          readonly exitCode: number;
          readonly timedOut: boolean;
          readonly outputTail: string;
          readonly reasons: readonly string[];
        },
        status: 'ok' | 'error',
      ): Result<ToolResult, DomainError> => {
        const output: Readonly<Record<string, unknown>> = {
          verdict,
          command: fields.command,
          exitCode: fields.exitCode,
          timedOut: fields.timedOut,
          outputTail: tail(fields.outputTail),
          accessPolicy: ctx.accessPolicy,
          executedOn: 'snapshot',
          reasons: [...fields.reasons],
          evidenceRefs: [`artifact:${artifactId}`],
          report: {
            kind: REPORT_KIND,
            label: 'Repository test contract validation report',
            content: JSON.stringify(
              {
                verdict,
                command: fields.command,
                exitCode: fields.exitCode,
                timedOut: fields.timedOut,
                outputTail: tail(fields.outputTail),
                accessPolicy: ctx.accessPolicy,
                executedOn: 'snapshot',
                boundRoot: ctx.root,
                reasons: [...fields.reasons],
                targetRef: input['targetRef'] ?? '',
                artifactId,
              },
              null,
              2,
            ),
          },
        };
        const now = deps.clock.nowIso();
        return ok({
          status,
          output,
          artifactRefs: [artifactId],
          startedAt: now,
          finishedAt: now,
          latencyMs: 0,
        } satisfies ToolResult);
      };

      // Fail-closed: software work whose workspace declares no runnable test contract
      // cannot be verified — never silently accepted.
      if (script === null) {
        return finish(
          'fail',
          {
            command: '',
            exitCode: -1,
            timedOut: false,
            outputTail: '',
            reasons: [readError ?? 'The workspace declares no test contract.'],
          },
          'error',
        );
      }

      // F3 (2) — the validator NEVER executes against the user's canonical workspace:
      // a bounded fresh snapshot copy (links materialized, dependencies included) is the
      // execution root, deleted after the run.
      const snapshot = buildSnapshot(ctx.root, deps.limits ?? DEFAULT_SNAPSHOT_LIMITS);
      if (!snapshot.ok) {
        return err(
          domainError('VALIDATION_FAILED', `The workspace environment cannot be safely materialized for validation: ${snapshot.refusal.detail}`, {
            reason: 'VALIDATION_ENVIRONMENT_UNAVAILABLE',
            snapshotReason: snapshot.refusal.reason,
            runId,
          }),
        );
      }
      try {
        // The validator executes the test contract ITSELF — the implementation's own runs
        // and claims are never consulted (the P1 independence rule).
        const run = await deps.runTestContract({ cwd: snapshot.dir });
        const passed = !run.timedOut && run.exitCode === 0;
        const reasons = passed
          ? ['the workspace test contract ran fresh under the validator (snapshot) and exited 0.']
          : run.timedOut
            ? ['the workspace test contract exceeded the validator deadline.']
            : [`the workspace test contract exited ${String(run.exitCode)}.`];
        return finish(
          passed ? 'pass' : 'fail',
          {
            command: script,
            exitCode: run.exitCode,
            timedOut: run.timedOut,
            outputTail: run.outputTail,
            reasons,
          },
          passed ? 'ok' : 'error',
        );
      } finally {
        rmSync(snapshot.dir, { recursive: true, force: true });
      }
    },

    describe(): ToolDescriptor {
      return descriptor;
    },
  };
};
