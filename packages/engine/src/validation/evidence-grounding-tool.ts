/**
 * `evidence.grounding-check` — the GENERIC evidence-grounding validator tool (Stage 4 P1:
 * DYNAMIC_PLAN_VALIDATION_CLOSURE).
 *
 * ONE verifier tool that answers a single deterministic question from the workspace and
 * the target artifact only: "is every machine-checkable factual claim in the produced
 * artifact actually supported by the workspace contents?"
 *
 *   WHAT IT CHECKS (deterministic, generic — any data/text analysis workload):
 *     1. PATH GROUNDING — every backtick-quoted workspace-relative path named in the
 *        artifact exists in the opened workspace (the artifact's own name is exempt).
 *     2. RECORD GROUNDING — every CSV-shaped factual row quoted in the artifact
 *        (`id,number,word`) appears verbatim in some workspace text file.
 *
 *   WHAT IT DELIBERATELY DOES NOT CHECK: prose, self-referential statements about the
 *   report itself, or unquoted paraphrase — those are not machine-checkable, and a
 *   verifier that guesses would produce false verdicts. It is therefore an
 *   over-approximation in the safe direction: it only ever fails on claims that are
 *   provably unsupported.
 *
 *   VERIFIER ONLY — no model call, no QA command execution, no approval; it reads the
 *   artifact (durable CAS bytes) and the trusted workspace (bounded text reads).
 *
 *   VERDICT VS ERROR — `verdict: 'fail'` is a business verdict recorded on a COMPLETED
 *   invocation; only an infrastructure failure makes the invocation itself FAILED.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

export const EVIDENCE_GROUNDING_TOOL_ID = 'evidence.grounding-check';

/**
 * The durable report kind this validator materializes. The corrective cause resolver
 * accepts it alongside the legacy repository QA evidence report (Stage 4 P1 closure).
 */
export const EVIDENCE_GROUNDING_REPORT_KIND = 'companyos/evidence-grounding-report';
const REPORT_KIND = EVIDENCE_GROUNDING_REPORT_KIND;

/** Bounded reads: a verifier must never become an unbounded scanner. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_WORKSPACE_FILES = 200;

const CSV_ROW_PATTERN = /\b([A-Za-z][A-Za-z0-9_-]{0,63}),([0-9]+(?:\.[0-9]+)?),([A-Za-z][A-Za-z0-9_-]{0,63})\b/g;
const BACKTICK_TOKEN_PATTERN = /`([^`\n]+)`/g;

export interface EvidenceGroundingDeps {
  /** The process-local workspace holder (0/1 active context; T17-02). */
  readonly workspace: () => { readonly canonicalRoot: string } | null;
  /**
   * F3/F4 — OPTIONAL run-scoped canonical context (Goal binding + accessPolicy +
   * current-open comparison). When wired (production composition), the grounding
   * validator resolves the GOAL'S durable workspace binding and fails closed on a
   * missing binding or a binding/current mismatch; the reads run against the BOUND
   * root, never "whatever is open right now". The global holder is NOT consulted at
   * all once this seam is wired (a workspace switch after the binding check cannot
   * redirect the reads — TOCTOU closed).
   */
  readonly resolveRunContext?: (runId: string) => Promise<
    { readonly root: string; readonly accessPolicy: string; readonly mismatch: boolean } | null
  >;
  /** Durable artifact bytes (the CAS content store; composition-owned). */
  readonly artifactContent: (contentRef: string) => Promise<Uint8Array | null>;
  readonly clock: { nowIso(): string };
}

export interface EvidenceGroundingSpec {
  readonly toolId: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: 'LOW';
  readonly capabilities: readonly string[];
  readonly idempotencyMode: 'IDEMPOTENT_KEY';
  readonly timeoutMs: number;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export const EVIDENCE_GROUNDING_SPEC: EvidenceGroundingSpec = {
  toolId: EVIDENCE_GROUNDING_TOOL_ID,
  name: 'Evidence grounding validator',
  description:
    'Verifier-only: decides whether every machine-checkable factual claim in the target artifact (named workspace paths and quoted CSV-shaped data rows) is supported by the opened workspace contents. Never calls a model.',
  version: '1.0.0',
  riskLevel: 'LOW',
  capabilities: [TOOL_CAPABILITY_VALIDATOR],
  idempotencyMode: 'IDEMPOTENT_KEY',
  timeoutMs: 120_000,
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
      checkedPaths: { type: 'number' },
      checkedRows: { type: 'number' },
      unsupported: { type: 'array', items: { type: 'string' } },
      reasons: { type: 'array', items: { type: 'string' } },
      // The frozen validator envelope (Task-13-06): the durable report the
      // ValidationService materializes through ArtifactService, plus addressable
      // evidence refs pointing at the target artifact.
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
    required: ['verdict', 'checkedPaths', 'checkedRows', 'unsupported', 'reasons', 'evidenceRefs', 'report'],
    additionalProperties: false,
  },
};

/** Build the registry record (validated by Core, so the spec cannot be malformed). */
export const createEvidenceGroundingRecord = (
  spec: EvidenceGroundingSpec,
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

/** Bounded recursive text inventory of the opened workspace. */
const workspaceTexts = (root: string): readonly { readonly relative: string; readonly text: string }[] => {
  const out: { relative: string; text: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= MAX_WORKSPACE_FILES) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_WORKSPACE_FILES) return;
      if (entry.startsWith('.')) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;
      try {
        out.push({ relative: relative(root, full).split(sep).join('/'), text: decode(readFileSync(full)) });
      } catch {
        continue;
      }
    }
  };
  walk(root, 0);
  return out;
};

export const createEvidenceGroundingPort = (
  spec: EvidenceGroundingSpec,
  deps: EvidenceGroundingDeps,
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
      // F4 CLOSURE — run-scoped canonical context: when the composition wires the
      // resolver (production), the grounding reads run against the GOAL'S DURABLE
      // BINDING or not at all. The global process workspace is NEVER a fallback there:
      // it may have been switched after the binding was captured, and re-reading it
      // would ground against a different workspace than the Goal was bound to.
      const runId = String((request.input ?? {})['runId'] ?? '');
      const runScoped = deps.resolveRunContext !== undefined;
      const runContext = runScoped && runId !== '' ? await deps.resolveRunContext(runId) : null;
      if (runScoped && runContext === null) {
        return err(
          domainError('VALIDATION_FAILED', 'The run has no durable workspace binding; the grounding validator refuses to execute.', {
            reason: 'GOAL_WORKSPACE_NOT_BOUND',
            runId,
          }),
        );
      }
      if (runContext !== null && runContext.mismatch) {
        return err(
          domainError('VALIDATION_FAILED', 'The currently open workspace differs from the Goal workspace binding; the grounding validator refuses to execute.', {
            reason: 'GOAL_WORKSPACE_MISMATCH',
            runId,
            boundRoot: runContext.root,
          }),
        );
      }
      const workspace = runContext !== null ? { canonicalRoot: runContext.root } : deps.workspace();
      if (workspace === null) {
        return err({
          code: 'VALIDATION_FAILED',
          message: 'The evidence grounding validator requires an opened workspace.',
        } as DomainError);
      }
      // The ValidationService hands the stage-output envelope fields in the input.
      const input = (request.input ?? {}) as Record<string, unknown>;
      const contentRef = typeof input['contentRef'] === 'string' ? (input['contentRef'] as string) : '';
      const artifactContent = contentRef === '' ? null : await deps.artifactContent(contentRef);
      if (artifactContent === null) {
        return err({
          code: 'VALIDATION_FAILED',
          message: 'The target artifact content is not present in durable storage.',
        } as DomainError);
      }
      const artifactText = decode(artifactContent);

      // 1. PATH GROUNDING — every backtick-quoted path-like token must exist in the
      //    workspace (or be the artifact itself).
      const unsupported: string[] = [];
      let checkedPaths = 0;
      const sources = workspaceTexts(workspace.canonicalRoot);
      const allSourceText = sources.map((source) => source.text).join('\n');
      // 1b. IDENTIFIER GROUNDING — every backtick-quoted digit-bearing identifier (a cited
      //     record id, sensor id, order number, …) must be traceable to the workspace.
      for (const match of artifactText.matchAll(BACKTICK_TOKEN_PATTERN)) {
        const token = match[1] ?? '';
        if (!/[0-9]/.test(token) || token.length < 3 || /\s/.test(token)) continue;
        if (allSourceText.includes(token)) continue;
        unsupported.push(`cited identifier not supported by workspace: ${token}`);
      }
      const pathMatches = [...artifactText.matchAll(BACKTICK_TOKEN_PATTERN)].map((m) => m[1] ?? '');
      for (const candidate of pathMatches) {
        if (candidate === '' || candidate.includes('..') || candidate.includes('://')) continue;
        // A scheme-qualified specifier (`node:assert/strict`, `npm:pkg`, `data:…`) names a module or
        // URI, not a workspace-relative path (H15d acceptance run 4, hark-live-goal 40345609717: two
        // false `fail` verdicts on `node:assert/strict` forced corrective rework). A one-letter
        // "scheme" is a Windows drive and stays checked.
        if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(candidate)) continue;
        if (/\s/.test(candidate)) continue;
        // Skip non-path tokens (ids, commands, single words without an extension/separator).
        if (!candidate.includes('/') && !candidate.includes('.')) continue;
        const relativeCandidate = candidate.replace(/^\.\//, '');
        if (relativeCandidate === 'report.md' || relativeCandidate.endsWith('/report.md')) continue;
        checkedPaths += 1;
        try {
          const full = join(workspace.canonicalRoot, ...relativeCandidate.split('/'));
          statSync(full);
        } catch {
          unsupported.push(`named path not found in workspace: ${candidate}`);
        }
      }

      // 2. RECORD GROUNDING — every CSV-shaped factual row quoted in the artifact must
      //    appear verbatim in some workspace text file.
      let checkedRows = 0;
      for (const match of artifactText.matchAll(CSV_ROW_PATTERN)) {
        const row = `${match[1]},${match[2]},${match[3]}`;
        checkedRows += 1;
        const grounded = sources.some((source) => source.text.includes(row));
        if (!grounded) unsupported.push(`quoted data row not supported by workspace: ${row}`);
      }

      const verdict = unsupported.length === 0 ? 'pass' : 'fail';
      const reasons =
        verdict === 'pass'
          ? [`checked ${checkedPaths} named path(s) and ${checkedRows} quoted data row(s); all grounded in the workspace.`]
          : [`${unsupported.length} unsupported factual claim(s) detected.`];
      // The frozen validator envelope (Task-13-06): evidence refs are addressable and the
      // durable report is materialized by the ValidationService through ArtifactService —
      // this is what makes the corrective cause (resolveValidationCause) actionable.
      const artifactId = String(input['artifactId'] ?? '');
      const output: Readonly<Record<string, unknown>> = {
        verdict,
        checkedPaths,
        checkedRows,
        unsupported,
        reasons,
        evidenceRefs: [`artifact:${artifactId}`],
        report: {
          kind: REPORT_KIND,
          label: 'Evidence grounding validation report',
          content: JSON.stringify(
            { verdict, checkedPaths, checkedRows, unsupported, reasons, targetRef: input['targetRef'] ?? '', artifactId },
            null,
            2,
          ),
        },
      };
      const now = deps.clock.nowIso();
      return ok({
        status: verdict === 'pass' ? 'ok' : 'error',
        output,
        artifactRefs: [artifactId],
        startedAt: now,
        finishedAt: now,
        latencyMs: 0,
      } satisfies ToolResult);
    },

    describe(): ToolDescriptor {
      return descriptor;
    },
  };
};
