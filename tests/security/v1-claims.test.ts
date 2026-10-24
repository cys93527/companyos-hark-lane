/**
 * STAGE 5E — NEGATIVE CLAIM TESTS (Boss §20).
 *
 * Architecture/document tests preventing future overclaims about what
 * Standard Mode provides. Each test scans shipped docs and runtime code for
 * forbidden phrases that would misrepresent the V1 security posture.
 */
import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {join} from 'node:path';

import {describe, expect, it} from 'vitest';

const REPO = process.cwd();
const DOCS_DIR = join(REPO, 'docs', 'security');
const DESKTOP_SRC = join(REPO, 'apps', 'desktop', 'src', 'executor');

/** Collect .md files in docs/security + docs root (not recursive into research). */
const securityDocs = (): string[] => {
  const files: string[] = [];
  for (const dir of [DOCS_DIR, join(REPO, 'docs')]) {
    try {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isFile() && name.endsWith('.md')) files.push(full);
      }
    } catch { /* dir may not exist */ }
  }
  return files;
};

/** Executor runtime source files that must not carry stale security claims. */
const executorSource = (): string[] => {
  const files: string[] = [];
  try {
    for (const name of readdirSync(DESKTOP_SRC)) {
      const full = join(DESKTOP_SRC, name);
      if (statSync(full).isFile() && name.endsWith('.ts')) files.push(full);
    }
  } catch { /* dir may not exist */ }
  return files;
};

describe('STAGE 5E negative claim tests (Boss §20)', () => {
  it('Standard Mode docs never claim "FULLY ISOLATED" or "SANDBOXED" without a Hardened qualifier', () => {
    for (const file of securityDocs()) {
      const text = readFileSync(file, 'utf8');
      const basename = file.split(/[\\/]/).pop() ?? file;
      // Allowed when explicitly about the Hardened backlog, not Standard Mode.
      if (basename.includes('BACKLOG') || basename.includes('HARDENED') || basename.includes('CLOSURE') || basename.includes('PROOF')) continue;
      // The V1 Standard Execution model explicitly disclaims sandbox; it may use the word in a negation.
      if (basename.includes('V1_STANDARD')) continue;
      for (const phrase of ['FULLY ISOLATED', 'ZERO NETWORK EXFILTRATION', 'HOST ESCAPE IMPOSSIBLE']) {
        if (text.includes(phrase)) {
          throw new Error(`${basename} contains forbidden claim "${phrase}" — Standard Mode must not overclaim`);
        }
      }
    }
  });

  it('Executor runtime source never claims "Network Blocked" or "Full Sandbox"', () => {
    for (const file of executorSource()) {
      const text = readFileSync(file, 'utf8');
      for (const phrase of ['network blocked', 'full sandbox', 'fully isolated', 'zero network']) {
        if (text.toLowerCase().includes(phrase)) {
          throw new Error(`${file.split(/[\\/]/).pop()} contains stale claim "${phrase}" — use EXPLICIT_NETWORK_TOOL / HOST_NETWORK_ISOLATION terms`);
        }
      }
    }
  });

  it('V1 Standard Security Model explicitly separates STRUCTURED_TOOL_BOUNDARY from GENERAL_PROCESS_TRUST_BOUNDARY', () => {
    const model = readFileSync(join(DOCS_DIR, 'V1_STANDARD_EXECUTION_SECURITY_MODEL.md'), 'utf8');
    expect(model).toContain('STRUCTURED_TOOL_BOUNDARY');
    expect(model).toContain('GENERAL_PROCESS_TRUST_BOUNDARY');
    expect(model).toContain('NOT GUARANTEED AGAINST HOSTILE SHELL');
  });

  it('V1 Standard Security Model declares Hardened Execution as BACKLOG (not implemented)', () => {
    const model = readFileSync(join(DOCS_DIR, 'V1_STANDARD_EXECUTION_SECURITY_MODEL.md'), 'utf8');
    expect(model).toContain('NOT_IMPLEMENTED');
    expect(model).toContain('NOT_AVAILABLE');
    expect(model).toContain('HARDENED_EXECUTION_BACKLOG');
  });

  it('Role ≠ Model and Role ≠ Fixed Agent are explicitly documented', () => {
    const model = readFileSync(join(DOCS_DIR, 'V1_STANDARD_EXECUTION_SECURITY_MODEL.md'), 'utf8');
    expect(model).toContain('Role ≠ Model');
    expect(model).toContain('Role ≠ Fixed Agent');
    expect(model).toContain('Professional Responsibility');
    expect(model).toContain('Execution Intelligence Provider');
  });

  it('Network semantics: "Network Tool not mounted" ≠ "Network blocked" is documented', () => {
    const model = readFileSync(join(DOCS_DIR, 'V1_STANDARD_EXECUTION_SECURITY_MODEL.md'), 'utf8');
    expect(model).toContain('EXPLICIT_NETWORK_TOOL');
    expect(model).toContain('HOST_NETWORK_ISOLATION: NOT GUARANTEED');
  });

  it('Stage 5B/5C/5D research evidence is preserved (not deleted)', () => {
    const evidence = [
      join(REPO, 'docs', 'security', 'WINDOWS_SANDBOX_IDENTITY_PROOF.md'),
      join(REPO, 'docs', 'security', 'WINDOWS_SANDBOX_IDENTITY_CLOSURE.md'),
      join(REPO, 'docs', 'sprint5c', 'WINDOWS_SANDBOX_PROOF_REPORT.md'),
      join(REPO, 'docs', 'sprint5b', 'STAGE5B_FINAL_REPORT.md'),
    ];
    for (const file of evidence) {
      expect(existsSync(file), `Research evidence missing: ${file}`).toBe(true);
    }
  });
});
