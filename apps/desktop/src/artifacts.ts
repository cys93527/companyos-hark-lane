/**
 * STAGE 3 — the bounded artifact surface (Preview / Open / Reveal in Explorer).
 *
 * The renderer may name a CANONICAL ARTIFACT ID and nothing else. Every action resolves
 * that id through durable truth here, in the main process, and refuses anything it cannot
 * prove:
 *
 *   - the artifact row must exist (durable `artifacts` store);
 *   - its `contentRef` must be a managed CAS reference (`sha256:<64 lowercase hex>`) —
 *     an opaque/foreign locator is REFUSED, never dereferenced;
 *   - the derived object path must stay inside the trusted CAS root (containment is
 *     re-checked after path derivation, so traversal is structurally impossible);
 *   - the object must exist on disk.
 *
 * There is deliberately NO `openAnyPath(string)` operation and no path is ever accepted
 * from the renderer: a generic filesystem primitive would hand the untrusted renderer
 * arbitrary filesystem authority.
 */
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import type { ArtifactContentStore } from '@companyos/core';

/** The managed CAS reference shape — the only content ref this surface will dereference. */
const MANAGED_REF_PATTERN = /^sha256:([0-9a-f]{64})$/u;

/** Preview is bounded: small text shapes only, and a hard byte ceiling. */
export const ARTIFACT_PREVIEW_MAX_BYTES = 16 * 1024;

const PREVIEWABLE_KINDS: readonly string[] = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'companyos:plan',
  'companyos:plan-compilation',
  'companyos:report',
  'companyos:summary',
];

export type ArtifactAction = 'reveal' | 'open' | 'preview';

export type ArtifactActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface ArtifactLookup {
  /** The durable artifact row, or null when the id is unknown. */
  readonly get: (artifactId: string) => Promise<{
    readonly id: string;
    readonly contentRef: string;
    readonly contentHash: string;
    readonly kind: string;
    readonly sizeBytes: number;
  } | null>;
}

export interface ArtifactTarget {
  readonly artifactId: string;
  readonly kind: string;
  readonly contentRef: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  /** Absolute path INSIDE the CAS root. Never handed to the renderer by this module. */
  readonly absolutePath: string;
}

/**
 * Resolve a canonical artifact id to a CAS object path, or fail closed with a typed error.
 * Pure path logic is separated so it can be tested without touching the filesystem.
 */
export const resolveCasObjectPath = (casRoot: string, contentRef: string): string | null => {
  const match = MANAGED_REF_PATTERN.exec(contentRef);
  if (match === null) return null;
  const hash = match[1];
  if (hash === undefined) return null;
  const derived = resolve(join(casRoot, hash.slice(0, 2), hash));
  // Containment is re-checked AFTER derivation (not assumed from the pattern): the result
  // must be a direct child of `<casRoot>/<2 hex>/<64 hex>` with no separators of its own.
  if (!isAbsolute(derived)) return null;
  const root = resolve(casRoot);
  const rel = relative(root, derived);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const segments = normalize(rel).split(sep);
  if (segments.length !== 2) return null;
  if (segments[0]?.length !== 2 || !/^[0-9a-f]{2}$/u.test(segments[0] ?? '')) return null;
  return derived;
};

export const resolveArtifactTarget = async (
  casRoot: string,
  lookup: ArtifactLookup,
  artifactId: string,
): Promise<ArtifactActionResult<ArtifactTarget>> => {
  if (typeof artifactId !== 'string' || artifactId.trim() === '') {
    return { ok: false, code: 'ARTIFACT_ID_INVALID', message: 'A canonical artifact id is required.' };
  }
  const row = await lookup.get(artifactId);
  if (row === null) {
    return { ok: false, code: 'ARTIFACT_NOT_FOUND', message: '该产物不是 canonical artifact。' };
  }
  const absolutePath = resolveCasObjectPath(casRoot, row.contentRef);
  if (absolutePath === null) {
    return { ok: false, code: 'ARTIFACT_REF_NOT_MANAGED', message: '该产物的内容引用不是受管 CAS 引用，已拒绝解引用。' };
  }
  return {
    ok: true,
    value: {
      artifactId: row.id,
      kind: row.kind,
      contentRef: row.contentRef,
      contentHash: row.contentHash,
      sizeBytes: row.sizeBytes,
      absolutePath,
    },
  };
};

export interface ArtifactPreview {
  readonly artifactId: string;
  readonly kind: string;
  readonly truncated: boolean;
  readonly sizeBytes: number;
  readonly text: string;
}

/** Bounded text preview for safe kinds; unsupported kinds are refused (external open is the answer). */
export const readArtifactPreview = async (
  target: ArtifactTarget,
  contentStore: ArtifactContentStore,
): Promise<ArtifactActionResult<ArtifactPreview>> => {
  if (!PREVIEWABLE_KINDS.includes(target.kind)) {
    return { ok: false, code: 'ARTIFACT_PREVIEW_UNSUPPORTED', message: '该产物类型不支持内嵌预览。' };
  }
  const content = await contentStore.get(target.contentRef);
  if (content === null) {
    return { ok: false, code: 'ARTIFACT_CONTENT_MISSING', message: '产物内容不在受管存储中。' };
  }
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content as ArrayLike<number>);
  const truncated = bytes.byteLength > ARTIFACT_PREVIEW_MAX_BYTES;
  const slice = truncated ? bytes.subarray(0, ARTIFACT_PREVIEW_MAX_BYTES) : bytes;
  return {
    ok: true,
    value: {
      artifactId: target.artifactId,
      kind: target.kind,
      truncated,
      sizeBytes: target.sizeBytes,
      text: new TextDecoder('utf-8').decode(slice),
    },
  };
};
