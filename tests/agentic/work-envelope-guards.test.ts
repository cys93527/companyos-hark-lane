/**
 * AGENTIC WORK PACKAGE CONTRACT — source-level architecture guards.
 *
 * These guards mechanize the closeout's structural laws at SOURCE level (the same
 * discipline as the native provider's timer-seam probe): they fail when someone
 * rewires the production composition away from canonical work semantics. They do NOT
 * duplicate the dynamic boundary laws already proven in
 * `apps/desktop/tests/agentic-executor-boundary-guards.test.ts` (provider cannot
 * modify Task state, cannot bypass settlement, cannot create second truths) or the
 * existing architecture guard suite.
 *
 * Laws mechanized here:
 *
 * 1. The production composition wires the CANONICAL Work Envelope (the Work Package
 *    projection) as the executor's work source — the synthetic taskKind label can
 *    never come back as the primary objective.
 * 2. No pseudo "provider" role label exists anywhere in production: the executor
 *    request carries the TASK's canonical pinned role (the seat the ExecutionAttempt
 *    records); provider identity travels as providerKey only.
 * 3. The taskKind fallback exists ONLY as the transport's last-resort defense (one
 *    module, behind the envelope/text seams) — never in the production wiring.
 * 4. No agent-specific second business Task DTO (AgentTask / AgentWorkPackage /
 *    AgentContextPackage / AgentMission) exists in production sources.
 * 5. No agent-specific AUTHORITY or ARTIFACT-INPUT store exists in production sources
 *    (the canonical owners stay the approvals machinery and the Sprint-13 artifact
 *    service).
 * 6. Provider artifact references enter the world ONLY through the canonical
 *    materialization seam (declared `artifactContent` → the ONE artifact service).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const walk = (current: string): readonly string[] =>
  readdirSync(current).flatMap((entry) => {
    const full = join(current, entry);
    return statSync(full).isDirectory() ? walk(full) : extname(full) === '.ts' ? [full] : [];
  });

/** Production sources: the shipped rings (no tests, no fixtures, no dist). */
const productionSources = (): readonly string[] => [
  ...walk(repoRoot('apps/desktop/src')),
  ...walk(repoRoot('packages/core/src')),
  ...walk(repoRoot('packages/engine/src')),
  ...walk(repoRoot('packages/persistence/src')),
  ...walk(repoRoot('packages/observability/src')),
];

const readSource = (file: string): string => readFileSync(file, 'utf8');

describe('Agentic Work Package Contract — source-level guards', () => {
  it('the production composition projects the canonical Work Envelope (Work Package → executor work source)', () => {
    const source = readSource(repoRoot('apps/desktop/src/core-services.ts'));
    // The seam is wired in the production composition...
    expect(source).toContain('workContextOf');
    // ...and its payload comes from the Work Package projection mapping, never from
    // a hand-built string.
    expect(source).toContain('projectWorkEnvelope(pkg.value)');
    // The transport prefers the envelope's objective as the primary work text.
    const dispatch = readSource(repoRoot('apps/desktop/src/executor/provider-dispatch.ts'));
    expect(dispatch).toContain('envelope.value.objective');
    expect(dispatch).toContain('ProviderWorkEnvelope');
  });

  it('no pseudo "provider" role label exists in production — the executor seat is the task\'s canonical role', () => {
    const offenders = productionSources().filter((file) => readSource(file).includes('rol.provider'));
    expect(offenders.map((file) => file.replace(repoRoot(''), ''))).toEqual([]);
  });

  it('the synthetic taskKind fallback exists ONLY as the transport\'s last-resort defense', () => {
    const filesUsingFallback = productionSources().filter((file) =>
      readSource(file).includes('Execute task kind'),
    );
    // Exactly one module — the dispatch transport — and it appears only behind the
    // envelope/text seam fallbacks, never in the composition wiring.
    expect(filesUsingFallback.map((file) => file.replace(repoRoot(''), ''))).toEqual([
      join('apps', 'desktop', 'src', 'executor', 'provider-dispatch.ts'),
    ]);
    const dispatch = readSource(repoRoot('apps/desktop/src/executor/provider-dispatch.ts'));
    expect(dispatch).toContain('workText ?? `Execute task kind ${request.taskKind}.`');
  });

  it('no agent-specific second business Task DTO exists in production sources', () => {
    const forbidden = /AgentTask|AgentWorkPackage|AgentContextPackage|AgentMission/;
    const offenders = productionSources().filter((file) => forbidden.test(readSource(file)));
    expect(offenders.map((file) => file.replace(repoRoot(''), ''))).toEqual([]);
  });

  it('no agent-specific AUTHORITY or ARTIFACT-INPUT store exists in production sources', () => {
    // The canonical owners stay: approvals/lifecycle (authority), the Sprint-13 artifact
    // service (artifacts). A provider-facing second store would be a second Truth.
    const forbidden =
      /AgentPermissionStore|AgentAuthorityTable|AgentApprovalState|AgentPolicyTruth|AgentArtifactInputStore|EffectiveAuthorityStore/;
    const offenders = productionSources().filter((file) => forbidden.test(readSource(file)));
    expect(offenders.map((file) => file.replace(repoRoot(''), ''))).toEqual([]);
  });

  it('provider artifact references enter the world ONLY through the canonical materialization seam', () => {
    // The dispatch transport materializes a DECLARED output via the composition seam —
    // it never builds an artifact row itself, and the composition wires that seam to
    // the ONE Sprint-13 artifact service with the shared output kind.
    const dispatch = readSource(repoRoot('apps/desktop/src/executor/provider-dispatch.ts'));
    expect(dispatch).toContain('materializeArtifactOf');
    expect(dispatch).toContain("structured['artifactContent']");
    const composition = readSource(repoRoot('apps/desktop/src/core-services.ts'));
    expect(composition).toContain('materializeArtifactOf: async');
    expect(composition).toContain("'companyos:executor-output'");
    expect(composition).toContain('provider-output:');
  });
});
