/**
 * Repository filesystem & search tool adapters (Sprint 17 — Task-17-03).
 *
 * Three generic Repository Runtime tools over the existing ToolPort/ToolRegistry:
 *   repo.file-read  — UTF-8 text read (LOW, read/idempotent, <= 4 MiB)
 *   repo.file-write — UTF-8 text write (MEDIUM, deterministic command-idempotent, <= 4 MiB)
 *   repo.search     — literal text search (LOW, read/idempotent, bounded traversal)
 *
 * Every path goes through THE ONE RepositoryPathPolicy (ADR-0028 D6/D7/D11–D24): these
 * adapters hold no second path validator. The workspace root never appears in an output,
 * a Node error never leaks a host path, and nothing here spawns a process, reads the
 * environment or touches the network (T17-04 owns the process runner).
 */
import {
  createToolRecord,
  domainError,
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
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { WorkspaceContext } from './workspace.js';
import { createRepositoryPathPolicy, type RepositoryPathPolicy } from './path-policy.js';

/* ------------------------------------------------------- frozen limits ------ */

/** Boss freeze (T17-03 §15/§22): no unbounded text buffers. */
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
/** Boss freeze (T17-03 §39): bounded traversal and bounded responses. */
export const MAX_SEARCH_FILES = 10_000;
export const MAX_SEARCH_MATCHES = 1_000;
export const MAX_MATCH_LINE_PREVIEW_BYTES = 512;

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Reject anything that is not valid UTF-8: no replacement-character decoding (D13). */
const decodeUtf8Strict = (bytes: Uint8Array): Result<string, DomainError> => {
  try {
    return ok(UTF8.decode(bytes));
  } catch {
    return err(
      domainError('INVALID_ARGUMENT', 'The file is not valid UTF-8 text; binary content is not supported.', {
        reason: 'UNSUPPORTED_BINARY',
      }),
    );
  }
};

/** Never leak a host path: the caller sees the relative path, the workspaceId and a code. */
const sanitized = (message: string, relativePath: string, workspaceId: string, reason: string): DomainError =>
  domainError('INVALID_ARGUMENT', message, { reason, workspaceId, relativePath });

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isSymbolicLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------ shared deps --- */

export interface RepositoryToolDeps {
  /** The process-local workspace holder (0/1 active context; T17-02). */
  readonly workspace: () => WorkspaceContext | null;
  readonly clock: { nowIso(): string; now(): number };
}

export interface RepositoryToolSpec {
  readonly toolId: 'repo.file-read' | 'repo.file-write' | 'repo.search';
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly riskLevel: 'LOW' | 'MEDIUM';
  readonly capabilities: readonly string[];
  readonly idempotencyMode: 'IDEMPOTENT_KEY' | 'COMMAND_ID';
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export const REPOSITORY_TOOL_SPECS: readonly RepositoryToolSpec[] = [
  {
    toolId: 'repo.file-read',
    name: 'Repository file read',
    description: 'Read one UTF-8 text file inside the open workspace (relative path only).',
    version: '1.0.0',
    riskLevel: 'LOW',
    capabilities: ['read'],
    idempotencyMode: 'IDEMPOTENT_KEY',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        sizeBytes: { type: 'number' },
        sha256: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['workspaceId', 'relativePath', 'sizeBytes', 'sha256', 'content'],
      additionalProperties: false,
    },
  },
  {
    toolId: 'repo.file-write',
    name: 'Repository file write',
    description: 'Create or overwrite one UTF-8 text file inside the open workspace (relative path only).',
    version: '1.0.0',
    riskLevel: 'MEDIUM',
    capabilities: ['write'],
    idempotencyMode: 'COMMAND_ID',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        relativePath: { type: 'string' },
        sizeBytes: { type: 'number' },
        sha256: { type: 'string' },
        created: { type: 'boolean' },
      },
      required: ['workspaceId', 'relativePath', 'sizeBytes', 'sha256', 'created'],
      additionalProperties: false,
    },
  },
  {
    toolId: 'repo.search',
    name: 'Repository text search',
    description: 'Literal text search inside the open workspace (relative path only, bounded).',
    version: '1.0.0',
    riskLevel: 'LOW',
    capabilities: ['read'],
    idempotencyMode: 'IDEMPOTENT_KEY',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        caseSensitive: { type: 'boolean' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        query: { type: 'string' },
        matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string' },
              line: { type: 'number' },
              column: { type: 'number' },
              preview: { type: 'string' },
            },
            required: ['relativePath', 'line', 'column', 'preview'],
            additionalProperties: false,
          },
        },
        scannedFiles: { type: 'number' },
        skippedBinaryFiles: { type: 'number' },
        skippedOversizeFiles: { type: 'number' },
        truncated: { type: 'boolean' },
      },
      required: ['workspaceId', 'query', 'matches', 'scannedFiles', 'skippedBinaryFiles', 'skippedOversizeFiles', 'truncated'],
      additionalProperties: false,
    },
  },
];

/** Build the registry record for one spec (validated by Core, so a spec cannot be malformed). */
export const createRepositoryToolRecord = (
  spec: RepositoryToolSpec,
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
    timeoutMs: 10_000,
    idempotencyMode: spec.idempotencyMode,
    auditPolicy: 'STANDARD',
    providerKind: 'repository',
    adapterRef: spec.toolId,
    now,
  });

const UTF8_BYTES = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Qualified sha256 over the ACTUAL bytes (the project's existing digest shape). */
const digestOf = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

/* ------------------------------------------------------------- file read --- */

const readTextFile = (
  context: WorkspaceContext,
  policy: RepositoryPathPolicy,
  input: Readonly<Record<string, unknown>>,
): Result<Readonly<Record<string, unknown>>, DomainError> => {
  const resolved = policy.resolve({ context, input: input['path'], operation: 'READ' });
  if (!resolved.ok) return err(resolved.error);
  const absolute = resolved.value.internalAbsolutePath;
  if (isSymbolicLink(absolute)) {
    return err(sanitized('The path is a symlink/junction/reparse point — refused.', resolved.value.relativePath, context.workspaceId, 'REPOSITORY_PATH_REPARSE_POINT'));
  }
  if (!isRegularFile(absolute)) {
    return err(sanitized('The path is not a regular file.', resolved.value.relativePath, context.workspaceId, 'NOT_A_FILE'));
  }
  const size = statSync(absolute).size;
  if (size > MAX_TEXT_FILE_BYTES) {
    return err(sanitized('The file exceeds the 4 MiB text limit.', resolved.value.relativePath, context.workspaceId, 'FILE_SIZE_LIMIT_EXCEEDED'));
  }
  const bytes = readFileSync(absolute);
  const text = decodeUtf8Strict(bytes);
  if (!text.ok) return err(text.error);
  return ok({
    workspaceId: context.workspaceId,
    relativePath: resolved.value.relativePath,
    sizeBytes: bytes.byteLength,
    sha256: digestOf(bytes),
    content: text.value,
  });
};

/* ------------------------------------------------------------ file write --- */

const writeTextFile = (
  context: WorkspaceContext,
  policy: RepositoryPathPolicy,
  input: Readonly<Record<string, unknown>>,
): Result<Readonly<Record<string, unknown>>, DomainError> => {
  const resolved = policy.resolve({ context, input: input['path'], operation: 'WRITE' });
  if (!resolved.ok) return err(resolved.error);
  const content = input['content'];
  if (typeof content !== 'string') {
    return err(sanitized('The write payload must be a UTF-8 string.', resolved.value.relativePath, context.workspaceId, 'INVALID_ARGUMENT'));
  }
  const bytes = UTF8_BYTES(content);
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
    return err(sanitized('The payload exceeds the 4 MiB text limit.', resolved.value.relativePath, context.workspaceId, 'FILE_SIZE_LIMIT_EXCEEDED'));
  }
  const absolute = resolved.value.internalAbsolutePath;
  if (isSymbolicLink(absolute)) {
    return err(sanitized('The target is a symlink/junction/reparse point — refused.', resolved.value.relativePath, context.workspaceId, 'REPOSITORY_PATH_REPARSE_POINT'));
  }
  const parent = dirname(absolute);
  // V1: the parent must already exist and be a real directory (no .git/symlink creation).
  if (!isRegularFile(parent) && !isDirectory(parent)) {
    try {
      statSync(parent);
    } catch {
      return err(sanitized('The parent directory does not exist.', resolved.value.relativePath, context.workspaceId, 'PARENT_MISSING'));
    }
  }
  const existed = isRegularFile(absolute);
  const parentDir = existed ? dirname(absolute) : parent;
  // Atomic replace: temp file in the SAME directory (never the OS global temp), fsync, rename.
  const tempPath = resolve(parentDir, `.companyos-${randomUUID()}.tmp`);
  const descriptor = openSync(tempPath, 'w');
  try {
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch {
    closeSync(descriptor);
    rmSync(tempPath, { force: true });
    return err(sanitized('The write failed.', resolved.value.relativePath, context.workspaceId, 'IO_ERROR'));
  }
  closeSync(descriptor);
  try {
    renameSync(tempPath, absolute);
  } catch {
    rmSync(tempPath, { force: true });
    return err(sanitized('The write failed.', resolved.value.relativePath, context.workspaceId, 'IO_ERROR'));
  }
  return ok({
    workspaceId: context.workspaceId,
    relativePath: resolved.value.relativePath,
    sizeBytes: bytes.byteLength,
    sha256: digestOf(bytes),
    created: !existed,
  });
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/* ---------------------------------------------------------------- search --- */

interface SearchMatch {
  readonly relativePath: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

const searchText = (
  context: WorkspaceContext,
  policy: RepositoryPathPolicy,
  input: Readonly<Record<string, unknown>>,
): Result<Readonly<Record<string, unknown>>, DomainError> => {
  const query = input['query'];
  if (typeof query !== 'string' || query.length === 0) {
    return err(sanitized('The search query must be a non-empty string.', '.', context.workspaceId, 'INVALID_ARGUMENT'));
  }
  const rawPath = input['path'] === undefined ? '.' : input['path'];
  const resolved = policy.resolve({ context, input: rawPath, operation: 'SEARCH', allowRoot: true });
  if (!resolved.ok) return err(resolved.error);
  const root = resolved.value.internalAbsolutePath;
  const needle = input['caseSensitive'] === true ? query : query.toLowerCase();
  const matches: SearchMatch[] = [];
  let scannedFiles = 0;
  let skippedBinaryFiles = 0;
  let skippedOversizeFiles = 0;
  let truncated = false;

  const walk = (absoluteDir: string, relativeDir: string): void => {
    if (truncated) return;
    if (scannedFiles >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) {
      truncated = true;
      return;
    }
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const name = entry.name;
      const childRelative = relativeDir === '.' ? name : `${relativeDir}/${name}`;
      if (isGitInternalName(name)) continue; // .git is never searched (D34)
      if (isIgnoredDirectory(name)) continue; // node_modules and friends (D35)
      const childAbsolute = resolve(absoluteDir, name);
      if (entry.isSymbolicLink()) continue; // links are never traversed (D36)
      if (entry.isDirectory()) {
        walk(childAbsolute, childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (scannedFiles >= MAX_SEARCH_FILES || matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        return;
      }
      let size = 0;
      try {
        size = statSync(childAbsolute).size;
      } catch {
        continue;
      }
      if (size > MAX_TEXT_FILE_BYTES) {
        skippedOversizeFiles += 1;
        continue;
      }
      const bytes = readFileSync(childAbsolute);
      const text = decodeUtf8Strict(bytes);
      if (!text.ok) {
        skippedBinaryFiles += 1;
        continue;
      }
      scannedFiles += 1;
      const lines = text.value.split('\\n');
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        if (matches.length >= MAX_SEARCH_MATCHES) {
          truncated = true;
          return;
        }
        const line = lines[lineNumber] ?? '';
        const haystack = input['caseSensitive'] === true ? line : line.toLowerCase();
        let from = 0;
        for (;;) {
          const column = haystack.indexOf(needle, from);
          if (column === -1) break;
          if (matches.length >= MAX_SEARCH_MATCHES) {
            truncated = true;
            return;
          }
          const previewBytes = UTF8_BYTES(line.slice(column, column + MAX_MATCH_LINE_PREVIEW_BYTES));
          matches.push({
            relativePath: childRelative,
            line: lineNumber + 1,
            column: column + 1,
            preview: decodeUtf8Strict(previewBytes).ok ? (decodeUtf8Strict(previewBytes) as { value: string }).value : '',
          });
          from = column + needle.length;
        }
      }
    }
  };
  walk(root, resolved.value.relativePath);

  matches.sort((left, right) =>
    left.relativePath === right.relativePath
      ? left.line === right.line
        ? left.column - right.column
        : left.line - right.line
      : left.relativePath < right.relativePath
        ? -1
        : 1,
  );

  return ok({
    workspaceId: context.workspaceId,
    query,
    matches,
    scannedFiles,
    skippedBinaryFiles,
    skippedOversizeFiles,
    truncated,
  });
};

const isGitInternalName = (name: string): boolean => name.toLowerCase() === '.git';
const isIgnoredDirectory = (name: string): boolean =>
  name === 'node_modules' || name === '.next' || name === 'target';

/* ------------------------------------------------------------ tool ports --- */

/** Build the ToolPort adapter for one spec. The workspace holder is injected per call. */
export const createRepositoryToolPort = (
  spec: RepositoryToolSpec,
  deps: RepositoryToolDeps,
): ToolPort => {
  const policy = createRepositoryPathPolicy();
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
    describe(): ToolDescriptor & { readonly id?: string; readonly enabled?: boolean } {
      return descriptor;
    },
    async invoke(request: ToolRequest): Promise<Result<ToolResult, DomainError>> {
      const context = deps.workspace();
      if (context === null) {
        return err(
          domainError('POLICY_DENIED', 'No workspace is open; the trusted application must open one first.', {
            reason: 'WORKSPACE_NOT_OPEN',
          }),
        );
      }
      const startedAt = deps.clock.nowIso();
      const started = deps.clock.now();
      const outcome =
        spec.toolId === 'repo.file-read'
          ? readTextFile(context, policy, request.input)
          : spec.toolId === 'repo.file-write'
            ? writeTextFile(context, policy, request.input)
            : searchText(context, policy, request.input);
      const finishedAt = deps.clock.nowIso();
      if (!outcome.ok) {
        return {
          ok: false as const,
          error: outcome.error,
        };
      }
      // The payload is the tool's structured output (validated against outputSchema by the registry).
      return {
        ok: true as const,
        value: {
          status: 'ok',
          output: outcome.value,
          artifactRefs: [],
          startedAt,
          finishedAt,
          latencyMs: deps.clock.now() - started,
        },
      };
    },
  };
};

/** Convenience: all three adapters + their records, from one workspace holder. */
export const createRepositoryTools = (
  deps: RepositoryToolDeps,
  now: string,
): {
  readonly records: readonly ToolRecord[];
  readonly adapters: ReadonlyMap<string, ToolPort>;
} => {
  const records: ToolRecord[] = [];
  const adapters = new Map<string, ToolPort>();
  for (const spec of REPOSITORY_TOOL_SPECS) {
    const record = createRepositoryToolRecord(spec, now);
    if (!record.ok) throw new Error(record.error.message);
    records.push(record.value);
    adapters.set(spec.toolId, createRepositoryToolPort(spec, deps));
  }
  return { records, adapters };
};
