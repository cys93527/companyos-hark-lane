import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { artifactTargetRef, domainError, err, ok, DomainError, type Artifact, type Result, type ToolPort } from '@companyos/core';
import { createEvidenceGroundingRecord, EVIDENCE_GROUNDING_SPEC, type ArtifactService, type ValidationService } from '@companyos/engine';

export const FILE_DELIVERY_TOOL_ID = 'file.delivery-check';
const KIND_PREFIX = 'companyos:business-file:';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
export interface FileDeliveryRequirement {
  readonly criterionId: string;
  readonly relativePath: string;
  readonly maxBytes: number;
  readonly expectedSha256?: string;
  readonly expectedSizeBytes?: number;
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const refuse = (reason: string): never => { throw domainError('VALIDATION_FAILED', 'The declared file delivery could not be verified.', { reason }); };
export const deliveryPath = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || isAbsolute(value) || /[\\:]/u.test(value) || [...value].some((character) => character.charCodeAt(0) < 32)) return refuse('FILE_PATH_INVALID');
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/u.test(part) || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(part))) return refuse('FILE_PATH_INVALID');
  return value;
};

/** Only the immutable, human-owned Goal contract can demand a file. Model prose cannot. */
export const fileDeliveriesOf = (structured: Readonly<Record<string, unknown>> | null | undefined): readonly FileDeliveryRequirement[] => {
  const raw = structured?.['fileDeliveries'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return refuse('FILE_REQUIREMENTS_INVALID');
  const result = raw.map((item) => {
    if (!record(item) || typeof item['criterionId'] !== 'string' || item['criterionId'].trim() === '' || item['criterionId'].length > 128 || !Number.isSafeInteger(item['maxBytes']) || Number(item['maxBytes']) < 1 || Number(item['maxBytes']) > MAX_FILE_BYTES) return refuse('FILE_REQUIREMENTS_INVALID');
    const path = deliveryPath(item['relativePath']);
    const hash = item['expectedSha256'];
    const size = item['expectedSizeBytes'];
    if (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))) return refuse('FILE_REQUIREMENTS_INVALID');
    if (size !== undefined && (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > Number(item['maxBytes']))) return refuse('FILE_REQUIREMENTS_INVALID');
    return { criterionId: item['criterionId'], relativePath: path, maxBytes: Number(item['maxBytes']), ...(hash === undefined ? {} : { expectedSha256: String(hash) }), ...(size === undefined ? {} : { expectedSizeBytes: Number(size) }) };
  });
  // Windows path aliases cannot be used to request the same file twice.
  if (new Set(result.map((item) => item.relativePath.toLowerCase())).size !== result.length || new Set(result.map((item) => item.criterionId)).size !== result.length) return refuse('FILE_REQUIREMENTS_DUPLICATE');
  return result;
};

/** A bounded snapshot, not an ACL sandbox. Reject aliases and detect file/path changes. */
export const readDeliveryFile = (workspace: string, path: string, maxBytes: number): Uint8Array => {
  deliveryPath(path);
  const root = realpathSync(workspace);
  if (lstatSync(workspace).isSymbolicLink() || resolve(workspace).toLowerCase() !== root.toLowerCase()) return refuse('WORKSPACE_ALIAS_REFUSED');
  const rootBefore = lstatSync(root);
  const chain = [root];
  let current = root;
  for (const part of path.split('/')) { current = join(current, part); chain.push(current); }
  const before = chain.map((entry) => lstatSync(entry));
  if (before.some((item) => item.isSymbolicLink())) return refuse('FILE_LINK_REFUSED');
  const canonical = realpathSync(current);
  const rel = relative(root, canonical);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return refuse('FILE_OUTSIDE_WORKSPACE');
  let handle: number | undefined;
  try {
    handle = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const start = fstatSync(handle);
    const last = before[before.length - 1]!;
    if (!start.isFile() || start.nlink !== 1 || start.size < 1 || start.size > maxBytes || start.dev !== last.dev || start.ino !== last.ino) return refuse('FILE_IDENTITY_OR_SIZE_INVALID');
    const bytes = new Uint8Array(start.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(handle, bytes, offset, bytes.length - offset, offset); if (count === 0) return refuse('FILE_CHANGED_DURING_READ'); offset += count; }
    const end = fstatSync(handle);
    if (start.dev !== end.dev || start.ino !== end.ino || start.size !== end.size || start.mtimeMs !== end.mtimeMs || start.ctimeMs !== end.ctimeMs || end.nlink !== 1 || realpathSync(current) !== canonical) return refuse('FILE_CHANGED_DURING_READ');
    chain.forEach((entry, index) => { const after = lstatSync(entry); const old = before[index]!; if (after.isSymbolicLink() || after.dev !== old.dev || after.ino !== old.ino) return refuse('FILE_PATH_CHANGED_DURING_READ'); });
    const rootAfter = lstatSync(root);
    if (rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino) return refuse('WORKSPACE_CHANGED_DURING_READ');
    return bytes;
  } finally { if (handle !== undefined) closeSync(handle); }
};
const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const satisfies = (bytes: Uint8Array, requirement: FileDeliveryRequirement): boolean => bytes.length > 0 && bytes.length <= requirement.maxBytes && (requirement.expectedSizeBytes === undefined || bytes.length === requirement.expectedSizeBytes) && (requirement.expectedSha256 === undefined || hashOf(bytes) === requirement.expectedSha256);

export interface FileDeliveryContext {
  readonly goalRunId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly workspace: string;
  readonly requirements: readonly FileDeliveryRequirement[];
  /** Pinned Task validators remain additive; the file verifier never replaces them. */
  readonly validatorIds: readonly string[];
}
export const fileDeliveryToolRecord = (now: string) => createEvidenceGroundingRecord({ ...EVIDENCE_GROUNDING_SPEC, toolId: FILE_DELIVERY_TOOL_ID, name: 'Business file delivery verifier', description: 'Read-only verification of canonical Artifact bytes against immutable Goal file requirements.' }, now);
export const createFileDeliveryPort = (deps: {
  readonly contextOf: (runId: string, taskId: string) => Promise<FileDeliveryContext>;
  readonly artifactOf: (id: string) => Promise<Artifact | null>;
  readonly contentOf: (ref: string) => Promise<Uint8Array | null>;
  readonly nowIso: () => string;
}): ToolPort => ({
  describe: () => ({ toolId: FILE_DELIVERY_TOOL_ID, name: 'Business file delivery verifier', description: 'Verifies canonical file delivery bytes.', parameters: EVIDENCE_GROUNDING_SPEC.inputSchema, version: '1.0.0', capabilities: EVIDENCE_GROUNDING_SPEC.capabilities, inputSchema: EVIDENCE_GROUNDING_SPEC.inputSchema, outputSchema: EVIDENCE_GROUNDING_SPEC.outputSchema, riskLevel: 'LOW' }),
  invoke: async (request) => {
    const artifactId = String(request.input['artifactId'] ?? '');
    const artifact = await deps.artifactOf(artifactId);
    const context = await deps.contextOf(request.runId, request.taskId);
    const bytes = artifact === null ? null : await deps.contentOf(artifact.contentRef);
    const requirement = artifact === null ? undefined : context.requirements.find((item) => artifact.kind === `${KIND_PREFIX}${encodeURIComponent(item.relativePath)}`);
    const passed = artifact !== null && artifact.runId === request.runId && artifact.taskId === request.taskId && request.input['targetRef'] === `artifact:${artifactId}` && bytes !== null && requirement !== undefined && bytes.length === artifact.sizeBytes && hashOf(bytes) === artifact.contentHash && satisfies(bytes, requirement);
    const now = deps.nowIso();
    const output = { verdict: passed ? 'pass' : 'fail', checkedPaths: 1, checkedRows: 0, unsupported: passed ? [] : ['Canonical file content or ownership mismatch'], reasons: [passed ? 'Verified persisted bytes and Goal requirements' : 'File delivery validation failed'], evidenceRefs: [`artifact:${artifactId}`], report: { kind: 'companyos:file-delivery-report', label: 'Business file delivery verification', content: JSON.stringify({ artifactId, goalRunId: context.goalRunId, runId: context.runId, taskId: context.taskId, passed }) } };
    // A completed validator may truthfully return a FAIL business verdict.
    return ok({ status: 'ok', output, artifactRefs: artifact === null ? [] : [artifactId], startedAt: now, finishedAt: now, latencyMs: 0 });
  },
});

export const createVerifiedFileCarrier = (deps: {
  readonly artifacts: ArtifactService;
  readonly validation: ValidationService;
  readonly actorId: string;
  readonly checkActive: (runId: string) => Promise<void>;
}) => async (input: { readonly context: FileDeliveryContext; readonly attemptId: string; readonly finalText: string }): Promise<Result<{ readonly artifactRefs: readonly string[]; readonly validationRefs: readonly string[] }, DomainError>> => {
  try {
    const { context } = input;
    if (context.requirements.length === 0) return ok({ artifactRefs: [], validationRefs: [] });
    await deps.checkActive(context.runId);
    if (input.finalText.length > 16384) return refuse('FILE_DECLARATION_TOO_LARGE');
    const declaration: unknown = JSON.parse(input.finalText);
    if (!record(declaration) || declaration['schema'] !== 'companyos/business-files/1' || declaration['goalRunId'] !== context.goalRunId || declaration['runId'] !== context.runId || declaration['taskId'] !== context.taskId || !Array.isArray(declaration['files']) || declaration['files'].length !== context.requirements.length) return refuse('FILE_DECLARATION_IDENTITY_INVALID');
    const files = declaration['files'];
    const seen = new Set<string>();
    const snapshots = context.requirements.map((requirement) => {
      const declared = files.find((file: unknown) => record(file) && file['relativePath'] === requirement.relativePath) as Record<string, unknown> | undefined;
      if (declared === undefined || seen.has(requirement.relativePath)) return refuse('FILE_DECLARATION_PATH_INVALID');
      seen.add(requirement.relativePath);
      if (files.filter((file: unknown) => record(file) && file['relativePath'] === requirement.relativePath).length !== 1) return refuse('FILE_DECLARATION_DUPLICATE');
      const bytes = readDeliveryFile(context.workspace, requirement.relativePath, requirement.maxBytes);
      if (!satisfies(bytes, requirement) || declared['sizeBytes'] !== bytes.length || declared['sha256'] !== hashOf(bytes)) return refuse('FILE_CONTENT_MISMATCH');
      return { requirement, bytes };
    });
    const artifactRefs: string[] = []; const validationRefs: string[] = [];
    for (const { requirement, bytes } of snapshots) {
      await deps.checkActive(context.runId);
      const commandId = `business-file:${input.attemptId}:${encodeURIComponent(requirement.relativePath)}`;
      const artifact = await deps.artifacts.create({ commandId, runId: context.runId as never, taskId: context.taskId as never, kind: `${KIND_PREFIX}${encodeURIComponent(requirement.relativePath)}`, content: bytes, producedBy: deps.actorId, traceId: `delivery:${input.attemptId}` });
      if (!artifact.ok) return artifact;
      const validatorIds = [...new Set([FILE_DELIVERY_TOOL_ID, ...context.validatorIds])];
      const validated = await deps.validation.run({ commandId: `verify:${commandId}`, actorId: deps.actorId, runId: context.runId as never, taskId: context.taskId as never, targetRef: artifactTargetRef(artifact.value.id), validators: validatorIds.map((validatorId) => ({ validatorId, blocking: true })), traceId: `delivery:${input.attemptId}` });
      if (!validated.ok) return validated;
      if (validated.value.length !== validatorIds.length || validated.value.some((item) => item.status !== 'pass' || item.taskId !== context.taskId || item.runId !== context.runId || item.targetRef !== artifactTargetRef(artifact.value.id))) return err(domainError('VALIDATION_FAILED', 'The canonical file Validators did not return matching PASS evidence.', { reason: 'FILE_VALIDATION_NOT_PASS', statuses: validated.value.map((item) => item.status) }));
      artifactRefs.push(String(artifact.value.id)); validationRefs.push(...validated.value.map((item) => String(item.id)));
    }
    await deps.checkActive(context.runId);
    return ok({ artifactRefs, validationRefs });
  } catch (error) {
    return err(error instanceof DomainError ? error : domainError('VALIDATION_FAILED', 'The file delivery is missing, malformed, or unreadable.', { reason: 'FILE_DELIVERY_UNAVAILABLE' }));
  }
};
