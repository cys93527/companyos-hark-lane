/**
 * Read-only CAS diagnostics (Sprint 13B — Task-13-10; ADR-0015 decision 11 as revised
 * by the Boss ruling: reconciliation is DETECT/REPORT ONLY — automatic orphan/staging
 * deletion is OUT OF SCOPE, so this port deliberately exposes NO mutating capability:
 * no delete/unlink/remove/cleanup/gc/purge).
 *
 * Least privilege (Task-13-10 §10/§11): enumerate managed finals and staging entries,
 * and stat managed entries (size + reparse detection) — nothing else.
 */
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type {
  ArtifactContentDiagnosticsPort,
  CasDiagnosticsSnapshot,
  ManagedCasEntry,
  StagingEntry,
  UnknownEntry,
} from '@companyos/core';

export type { ArtifactContentDiagnosticsPort };
const FINAL_DIR_PATTERN = /^[0-9a-f]{2}$/;
const FINAL_FILE_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_FILE_PATTERN = /^[0-9A-Za-z-]+\.staging$/;

export function createFilesystemArtifactContentDiagnostics(options: {
  readonly casRoot: string;
}): ArtifactContentDiagnosticsPort {
  const casRoot = options.casRoot;

  return {
    snapshot(): CasDiagnosticsSnapshot {
      const managedFinals: ManagedCasEntry[] = [];
      const stagingEntries: StagingEntry[] = [];
      const unknownEntries: UnknownEntry[] = [];
      const reparseViolations: string[] = [];

      const rootEntries = existsAndList(casRoot) ?? [];
      for (const entry of rootEntries) {
        const fullPath = join(casRoot, entry);
        if (entry === 'staging') {
          const stagingDir = join(casRoot, 'staging');
          for (const stagingName of existsAndList(stagingDir) ?? []) {
            const stagingPath = join(stagingDir, stagingName);
            if (isReparse(stagingPath)) {
              reparseViolations.push(join('staging', stagingName));
              continue;
            }
            if (STAGING_FILE_PATTERN.test(stagingName)) {
              stagingEntries.push({ fileName: stagingName, sizeBytes: statSync(stagingPath).size });
            } else {
              unknownEntries.push({ relativePath: join('staging', stagingName), isDirectory: statSync(stagingPath).isDirectory(), isSymbolicLink: false });
            }
          }
          continue;
        }
        // Managed namespace: strictly <2hex>/<64hex>. Anything else is unknown.
        if (!FINAL_DIR_PATTERN.test(entry)) {
          unknownEntries.push({ relativePath: entry, isDirectory: statSync(fullPath).isDirectory(), isSymbolicLink: isReparse(fullPath) });
          continue;
        }
        if (isReparse(fullPath)) {
          reparseViolations.push(entry);
          continue;
        }
        for (const inner of existsAndList(fullPath) ?? []) {
          const innerPath = join(fullPath, inner);
          if (isReparse(innerPath)) {
            reparseViolations.push(join(entry, inner));
            continue;
          }
          if (!FINAL_FILE_PATTERN.test(inner)) {
            unknownEntries.push({ relativePath: join(entry, inner), isDirectory: statSync(innerPath).isDirectory(), isSymbolicLink: false });
            continue;
          }
          managedFinals.push({ digest: inner, contentRef: `sha256:${inner}`, sizeBytes: statSync(innerPath).size });
        }
      }

      return { managedFinals, stagingEntries, unknownEntries, reparseViolations };
    },
  };
}

function existsAndList(dir: string): readonly string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

function isReparse(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
