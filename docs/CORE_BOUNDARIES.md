> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — Core Boundaries (Boundary Constitution)

| Field | Value |
|---|---|
| Document | CORE_BOUNDARIES.md — the boundary constitution for `@companyos/core` |
| Status | **RATIFIED** — normative, not advisory. Violations fail CI; they are not review opinions. |
| Authority | CANONICAL_SPEC §1 (architectural law) + ADR-0001, ADR-0002 (`docs/ARCHITECTURE_REVIEW.md`) |
| Enforcement | `scripts/check-boundaries.mjs` · ESLint `no-restricted-imports` + `id-denylist` · `packages/core/package.json` dependency check · CI gate in `pnpm check` |
| Amendment process | §7 (boundary-exception ADR). No other path exists. |

---

## 1. The absolute rule

> **`@companyos/core` MUST NOT depend on, name, or import any of: Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce.**
> **These nouns belong to Industry Packs (`@companyos/pack-*`), which depend on Core — never the reverse.**
> **Consequence for naming: the persistence port in Core is `EntityStore`, not `Repository`. The word `repository` must not appear as an identifier in `packages/core/src/**`.**

Three verbs to parse carefully, because all three are enforced:

| Verb | Meaning in this constitution | Detection |
|---|---|---|
| **depend on** | `packages/core/package.json` lists a package that provides the noun (e.g. `@companyos/pack-devcompany`, `isomorphic-git`) | dependency allow-list check |
| **name** | The noun appears as an identifier, type name, table name, event name, string literal used as a discriminant, or **in a comment** in `packages/core/src/**` | lexical token scan (case-insensitive, word-boundary) |
| **import** | A static or dynamic import resolves to a module whose package or path indicates the noun | import-graph scan |

**Identifier-level enforcement (authoritative).** CANONICAL_SPEC §1 bans the nouns as **identifiers** in `packages/core/src/**`: type names, variable names, function names, event names, discriminants, table names. The shipped `scripts/check-boundaries.mjs` (Sprint 0) therefore **strips comments and string/template literals before scanning**, so a doc comment *about* the rule — such as the ADR-0001 note in `packages/core/src/ports/store.ts` — does not trip it. That is correct and deliberate: the checker must be able to document the rule it enforces. See §10 for the reconciliation record and the review-level convention that still rejects comments introducing *new* vertical vocabulary.

---

## 2. Forbidden terms and rationale

| Forbidden term | Rationale — why it must never be Core vocabulary |
|---|---|
| **Coding** | Coding is a *domain activity* of one vertical (software). Core models work as nodes and handoffs; a node kind literally named `coding` would make every non-software vertical a special case of software. The general Core concept is a **capability-backed step** (`NodeExecution` + `CapabilityDescriptor`). |
| **Git** | A specific VCS implementation and a specific toolchain. Core knows "a step produced an artifact with a `contentRef`"; it must not know branches, commits, or remotes. Otherwise Core inherits a merge/patch vocabulary and couples to one tool. |
| **Repository** | Two meanings collide: DDD's persistence pattern and the vertical's source-control concept. Allowing the token in Core lets vertical vocabulary in through the back door and makes lexical boundary enforcement impossible (ADR-0001). Core's persistence port is **`EntityStore<T>`**; the vertical concept lives in `pack-devcompany`. |
| **Developer** | A job title from one industry's org chart. Core has **`RoleArchetype`** / **`WorkRole`**: archetypes are pack-declared strings, titles are org-local data. Hardcoding `developer` forces every vertical onto software's org template. |
| **CTO** | Same as `Developer`, one level up: an executive title from one industry. Core models **authority** (`AuthorityGrant`, RACI) and never a title catalogue. Titles are pack data, not Core constants. |
| **Article** | A specific output medium. Core's output abstraction is **`WorkProduct`** with an artifact reference. `Article` would drag in editorial concepts (headline, byline, word count) that Video/Ecommerce would have to route around. |
| **Video** | Same problem class as `Article` — a media type with its own pipeline (takes, timelines, renders). Core models a step graph; the media pipeline is pack-owned. |
| **Ecommerce** | A whole business vertical with its own aggregates (catalog, order, fulfilment). Admitting it into Core would import a commercial model into a tool whose job is to execute SOPs. It lives in `@companyos/pack-ecommerce` with its own DTOs. |

### 2.1 Generalized test for any new noun

If a candidate word answers "yes" to **any** of these, it is not Core vocabulary:

1. Does it name a **medium, tool, or product** rather than a role in a graph? (Article, Video, Git → pack)
2. Would a user in a *different industry* have to translate it before using Core? (Developer, CTO, Ecommerce → pack)
3. Is it a **proper tool brand** or an implementation with a version number? (Git → pack adapter)
4. Does it already have a Core-neutral synonym in §3? (Repository → `EntityStore`)
5. Can it be resolved **at runtime from a pack manifest** instead of a Core constant? If yes, it must be.

---

## 3. Allowed vs. forbidden vocabulary

### 3.1 Core vocabulary map

| ✅ Core (allowed, canonical) | ✗ Forbidden in Core | Where the forbidden noun lives instead |
|---|---|---|
| `EntityStore<T>` | `Repository` / `Repo` / `GitRepository` | `@companyos/pack-devcompany` (`Repository` = source-control repo) |
| `WorkRole` / `RoleArchetype` | `Developer` | `@companyos/pack-devcompany` role titles |
| `WorkRole.authority` / `AuthorityGrant` | `CTO` | `@companyos/pack-devcompany` executive titles |
| `WorkProduct` + `ArtifactRef` (`contentRef`) | `Article` | `@companyos/pack-article` WorkProduct *types* |
| `WorkProduct` + `ArtifactRef` (`contentRef`) | `Video` | `@companyos/pack-video` WorkProduct *types* |
| `NodeExecution` + `CapabilityDescriptor` | `Coding` (as a node kind) | `@companyos/pack-devcompany` node kinds |
| `ToolAdapter` (port-shaped, contract-resolved) | `GitClient` / `GitAdapter` | `@companyos/pack-devcompany/tools/git` |
| `TradeDomain` / `IndustryPack` (`PackManifest`) | `Ecommerce` | `@companyos/pack-ecommerce` |
| `WorkflowTemplate` / `WorkflowVersion` | `ArticlePlan` / `VideoPipeline` | pack template seeds |
| `HandoffEnvelope` / `Handoff` | `DevHandoff` | pack-specific intents inside `payload` |
| `RunSnapshot` / `Checkpoint` | `ArticleSnapshot` | n/a — Core owns snapshotting once, for all verticals |
| `Policy`, `Budget`, `Approval`, `AuditEntry` | `EditorialBoard` | pack data expressing policy in Core's schema |
| `MemoryRecord.scope`, `sensitivity` | `ArticleDraft` memory type | pack-defined `contentRef` shapes |

### 3.2 The substitution table (memorize this)

| ✗ Never write in Core | ✓ Write instead | Reason |
|---|---|---|
| `Repository<T>` | `EntityStore<T>` | ADR-0001 — one noun, one meaning |
| `Developer` | `RoleArchetype` + org-local `WorkRole` | archetypes are pack-declared strings |
| `CTO` | `AuthorityGrant` with an authority level | Core models authority, not titles |
| `Article` / `Video` | `WorkProduct` + `ArtifactRef` | medium-neutral output |
| `GitClient` | `ToolAdapter` resolved by `contractId` | no tool coupling in Core |
| `Coding` (node kind) | `NodeExecution` with `capabilityId` | capability-resolved, not hardcoded |
| `Ecommerce` | `IndustryPack` (`PackManifest`) | vertical registration, not Core knowledge |
| `articleTemplate` | `WorkflowTemplate` loaded from a pack | Core ships shapes, packs ship content |

### 3.3 Escalation rule

There is **no** "just this once" substitution. If you believe a forbidden noun is genuinely needed in Core, you are almost certainly looking at a missing **port** or a missing **capability contract**. Fix that instead; if you still disagree, follow §7.

---

## 4. Industry Pack contract surface

A pack declares everything Core needs to know about it — and Core knows nothing else. `PackManifest` is validated by `@companyos/pack-sdk` with zod at startup; an invalid manifest disables that pack (it never partially loads).

| `PackManifest` field | Type | Required | Purpose | Core's use |
|---|---|---|---|---|
| `manifestVersion` | `1` (literal) | ✓ | Schema version of the manifest itself | Reject unknown manifest versions |
| `packId` | `string` (reverse-DNS-ish, e.g. `companyos.pack.devcompany`) | ✓ | Stable identity | Registry key; appears in `RunSnapshot.packVersions` |
| `packVersion` | `string` (semver) | ✓ | Pack release | Pinned into `RunSnapshot`; mismatch is a `SNAPSHOT_MISMATCH` candidate |
| `displayName` | `string` | ✓ | UI label | Presentation only |
| `description` | `string` | ✓ | Human summary | Presentation only |
| `industry` | `string` (free-form, pack-owned) | ✓ | Vertical tag (e.g. `software`, `media`, `retail`) drawn from the pack's own vocabulary | **Opaque to Core** — never branched on |
| `coreApiRange` | `string` (semver range) | ✓ | Core API versions this pack supports | Refuse to load on mismatch |
| `capabilities` | `CapabilityDescriptor[]` | ✓ (may be empty) | Capabilities this pack provides | Registered in the Capability Registry; resolved by `contractId` + range only |
| `templates` | `PackTemplateSeed[]` | ✗ | Seed `WorkflowTemplate`s (name, graph shape, default inputs) | Materialized as **draft** templates on first install; they are examples, not Core content |
| `roleArchetypes` | `RoleArchetypeDeclaration[]` (`{key, label, defaultAuthority}`) | ✗ | Org archetypes this pack suggests | Org may bind them into `WorkRole`s; Core stores the key string opaquely |
| `workProductTypes` | `WorkProductTypeDeclaration[]` (`{key, label, artifactKind}`) | ✗ | Output type labels (article, render, listing) | Opaque labels attached to `WorkProduct`; Core never switches on them |
| `toolAdapters` | `ToolAdapterDeclaration[]` (`{key, contractId, configSchemaRef}`) | ✗ | Tool integrations the pack can bind | Resolved via `ToolAdapter` port; config validated by the pack's schema ref |
| `memoryNamespaces` | `string[]` | ✗ | Extra memory namespaces the pack writes into | Used for retrieval scoping and retention |
| `sensitivityDefaults` | `Record<string, 'public'\|'internal'\|'confidential'\|'restricted'>` | ✗ | Default sensitivity per artifact kind | Applied on memory write; never relaxed by the pack at read time |
| `requiredCapabilities` | `string[]` (`capabilityId`s) | ✗ | Pack's own needs from other packs | Resolved at registration; unsatisfied ⇒ pack unavailable (explicit failure) |
| `permissions` | `PackPermission[]` (`{kind:'fs.read'\|'fs.write'\|'net'\|'secret'\|'spawn', scope}`) | ✓ (may be empty) | Least-privilege declaration | Enforced by the pack capability sandbox (`docs/SECURITY_MODEL.md` §7); undeclared ⇒ denied |
| `entrypoints` | `{main: string, migrations?: string[]}` | ✓ | Module entry and optional pack migrations | Pack migrations run under the same checksum discipline as Core's |
| `signature` | `{algo:'sha256', digest: string}` | ✓ (❌ in dev, advisory) | Integrity of the pack bundle | Advisory in V1.1; required from P4 marketplace |
| `license` | `string` (SPDX id) | ✓ | Licence compliance | Licence scan (`docs/SECURITY_MODEL.md` §11) |
| `minAppVersion` | `string` (semver) | ✗ | Minimum CompanyOS version | Refuse to load on mismatch |

**Core's entire knowledge of a pack is: `packId`, `packVersion`, `coreApiRange`, `capabilities` (by contract id), `permissions`, `entrypoints`.** Everything else is stored and displayed, never branched on.

---

## 5. Rules for naming new Core concepts (5-question checklist)

Run this before opening a PR that adds any type, port, event, table, or error code to `@companyos/core`. All five answers must be `NO` for the name to be Core vocabulary.

| # | Question | If **YES** → |
|---|---|---|
| **Q1** | Does the name appear in the forbidden list (Coding · Git · Repository · Developer · CTO · Article · Video · Ecommerce) or any inflection of it (`repos`, `repositories`, `devs`, `videos`)? | Rename. Consult §3.2 substitution table. |
| **Q2** | Is the name a **tool, product, medium, or brand** that could gain a version number or be swapped? | It belongs in a pack or an adapter. Define a **port** instead. |
| **Q3** | Would a user in an unrelated industry have to translate the name to understand Core? | Generalize it (`Article` → `WorkProduct`; `Developer` → `WorkRole`). |
| **Q4** | Can the concept be **resolved at runtime** from `PackManifest` (capability, template, archetype, work-product type, tool adapter)? | It must be a registration, not a Core constant. |
| **Q5** | Does the name already have a canonical Core synonym in §3? | Use the synonym; do not introduce a second word for one thing. |

**Additional naming hygiene for Core (always apply):**

- **Nouns are domain concepts, verbs are commands**: `WorkflowVersion` (entity) vs `publish` (transition).
- **Ports are capabilities, not implementations**: `SecretResolver`, not `KeychainClient`.
- **Events are past tense and owner-prefixed**: `WorkflowPublished`, `RunSucceeded`.
- **Error codes are `SCREAMING_SNAKE` and stable**: never renumbered once shipped.
- **Tables are snake_case and context-owned**: `workflow_versions`, `run_snapshots` — never `articles`.
- **No abbreviations that hide domain meaning**: `Exec`/`Mgr`/`Doc` are rejected; `RunSnapshot` is accepted.

---

## 6. Filing a boundary-exception ADR (Core author procedure)

An exception is a **superseding decision**, not a code comment. Procedure:

| Step | Action | Artefact |
|---|---|---|
| 1 | **Stop coding.** Do not open a PR containing the forbidden noun; the CI gate will fail and reviewers will not read past it. | — |
| 2 | Write an ADR draft using the block format in `docs/ARCHITECTURE_REVIEW.md` §8 — `Status / Context / Decision / Consequences`. | `docs/adr/ADR-00NN-<slug>.md` (or an inline block in the owning doc) |
| 3 | **Prove necessity**: state why the concept cannot be (a) generalized, (b) a pack registration, (c) a port, or (d) pack-local code. Cite the failed alternative explicitly. | ADR §Context |
| 4 | **Scope the blast radius**: which files change, which tests change, whether `check-boundaries.mjs` needs an allow-list entry, and what happens to the verticals that do *not* have this concept. | ADR §Decision |
| 5 | **Amend CANONICAL_SPEC §1 yourself** in the same change set — the spec is the source of truth and would otherwise contradict the code. | `.planning/CANONICAL_SPEC.md` diff |
| 6 | **Reviewer set is fixed**: Principal Architect + Core Domain Reviewer + at least one vertical owner (pack author). Unanimous. A rejected ADR is final for that version. | ARB record |
| 7 | **If accepted**: add the allow-list entry with a **narrow** pattern (file-scoped, not repo-wide), an expiry sprint, and a removal ticket. Broad expiries are rejected. | `scripts/boundary-allowlist.json` + ticket |
| 8 | **Expiry is mandatory.** `check-boundaries.mjs` warns after the expiry sprint and hard-fails one sprint later. Exception ADRs are debt, not law. | CI warning/fail |

**Anti-pattern explicitly rejected in AR-0001:** generalizing vertical nouns *into* Core (`RepositoryService`, `DeveloperRole`, `ArticleWorkflow`, `GitAdapter`). That is the coupling the constitution exists to prevent; it was reviewed and refused.

**Current allow-list state:** `scripts/boundary-allowlist.json` contains **zero entries**. No boundary-exception ADR has ever been accepted.

---

## 7. Automated checks

### 7.1 What each layer catches

| Layer | Tool | Catches |
|---|---|---|
| 1 | `scripts/check-boundaries.mjs` — **LAW 1** vocabulary scan (comments/strings stripped), **LAW 1b** inner-ring import ban, **LAW 2** dependency-direction check | the 8 forbidden nouns used as identifiers in `packages/core/src` **and** `packages/contracts/src`; illegal imports of `@companyos/pack-*`, `electron`, `react`, `@companyos/{desktop,renderer,persistence,observability}` from the inner ring; reverse dependency edges. Third-party runtime imports in Core are reported as **notes** (advisory) rather than failures |
| 2 | ESLint (root `eslint.config.js`, scoped to `packages/core/src/**` + `packages/contracts/src/**`): `no-restricted-imports` + `no-restricted-syntax` over `FORBIDDEN_CORE_IDENTIFIERS` | forbidden pack imports and forbidden vertical vocabulary — at author time in the IDE, before CI |
| 3 | `packages/core/package.json` dependency check (within `scripts/check-workspace.mjs` / the boundary script) | any non-allow-listed runtime dependency in Core; Core's internal deps must stay `[]` |
| 4 | CI gate (`.github/workflows/ci.yml` job → `pnpm check` = `node scripts/check.mjs`) | the whole set, on every push and PR; branch protection requires green |

### 7.2 Commands and expected output

```bash
# full gate — CANONICAL_SPEC §8 (lint + typecheck + boundary + test + build)
pnpm install --frozen-lockfile
pnpm check                       # wrapper: scripts/check.mjs — must exit 0

# boundary gate on its own (this is the Sprint-0 shipped CLI; it takes NO flags)
pnpm boundaries
# equivalently:
node scripts/check-boundaries.mjs
```

Real output (Sprint 0, verified — exit 0):

```text
▌ LAW 1 — Industry vocabulary must not exist in Core/Contracts
   scanned 23 source file(s) under packages/core/src/
   scanned 0 source file(s) under packages/contracts/src/
▌ LAW 1b — Core/Contracts imports must stay inner-ring only
▌ LAW 2 — Dependency direction (inner <- outer, never the reverse)
   @companyos/contracts: internal deps [-]
   @companyos/core: internal deps [-]
   @companyos/observability: internal deps [-]
   @companyos/persistence: internal deps [@companyos/contracts, @companyos/core]
   @companyos/desktop: internal deps [@companyos/contracts, @companyos/core, @companyos/observability, @companyos/persistence]
   @companyos/renderer: internal deps [@companyos/contracts]

✅ Architecture boundary check PASSED — Core is industry-agnostic.
```

```bash
# the checker's own regression suite (red-team fixtures live under scripts/tests/)
pnpm test:scripts
```

**Target CLI (not yet implemented — see §10).** The following flags are the *planned* interface for richer CI evidence; they do **not** exist in the Sprint-0 script and must not be assumed by CI today:

```bash
node scripts/check-boundaries.mjs --layer core --fail-on violation     # planned
node scripts/check-boundaries.mjs --self-test                          # planned
node scripts/check-boundaries.mjs --deps --json > .artifacts/boundary-report.json  # planned
```

```bash
# ESLint layer (IDE-visible, same rules)
pnpm --filter @companyos/core exec eslint "src/**/*.ts"
```

```text
✖ 0 problems (0 errors, 0 warnings)   # expected
```

**Expected failure (exit 1) — real format from `scripts/check-boundaries.mjs`:**

```text
LAW1  packages/core/src/ports/repository.ts:3  forbidden word "repository" (owned by pack-coding) — use EntityStore
LAW1  packages/core/src/execution/git-step.ts:7  forbidden word "git" (owned by pack-coding) — use versioned artifact store
LAW1b packages/core/src/execution/git-step.ts  illegal import "@companyos/pack-coding" from @companyos/core

❌ Architecture boundary check FAILED — 3 violation(s). Core must stay industry-agnostic.
```

Advisory (non-failing) output uses a separate channel — a third-party runtime import in Core is reported as a **note**, so it is visible in CI without breaking the build until the ADR-0011 dependency budget is formally breached:

```text
⚠  1 note(s):
   LAW1b packages/core/src/kernel/ids.ts  third-party runtime import "ulid" in @companyos/core — Core is designed to be dependency-free (ADR-0005)
```

```bash
# ESLint layer (IDE-visible; root config: eslint.config.js)
pnpm lint
```

```text
✖ 0 problems (0 errors, 0 warnings)   # expected
```

---

## 8. Capsule code: GOOD vs. BAD

A "capsule" is the minimal vertical-facing unit Core must support: register a capability, run a step, store a result. The GOOD example is **Core-legal**. The BAD example is an **anti-example for contrast only** — it is illustrative text, it must never be committed to `packages/core`, and it does not compile in the repo because the imports it needs are not resolvable from Core (they are pack packages that depend on Core, so importing them from Core is a cycle and a boundary violation).

### GOOD — Core-legal capsule (`packages/core/src/execution/capsule.ts`)

```ts
// packages/core/src/execution/capsule.ts
// Core-legal: medium-neutral, tool-neutral, resolved by contract. No forbidden nouns.
import type {
  CapabilityDescriptor,
  CapabilityId,
  ContractId,
  Result,
} from '@companyos/contracts';
import type { EntityStore } from '../ports/entity-store.js';
import type { EventBus } from '../ports/event-bus.js';
import type { Clock, IdFactory } from '../ports/kernel.js';
import type { CapabilityRegistryPort } from '../ports/capability-registry.js';

/** A WorkProduct is the medium-neutral output of a step. Its KIND is pack-declared. */
export interface WorkProduct {
  readonly id: string;
  readonly runId: string;
  readonly nodeExecutionId: string;
  /** opaque pack-declared label, e.g. from WorkProductTypeDeclaration.key */
  readonly typeKey: string;
  /** reference into the artifact store; never an inline blob above threshold */
  readonly contentRef: string;
  readonly sensitivity: 'public' | 'internal' | 'confidential' | 'restricted';
  readonly createdAt: string;
}

export class CapsuleService {
  constructor(
    private readonly capabilities: CapabilityRegistryPort,
    private readonly workProducts: EntityStore<WorkProduct>,
    private readonly events: EventBus,
    private readonly clock: Clock,
    private readonly ids: IdFactory,
  ) {}

  /** Resolve by contract, never by a hardcoded vertical name. */
  async resolveCapability(
    contractId: ContractId,
    range: string,
  ): Promise<Result<CapabilityDescriptor, 'CAPABILITY_UNAVAILABLE'> {
    const found = await this.capabilities.findByContract(contractId, range);
    return found ? { ok: true, value: found } : { ok: false, error: 'CAPABILITY_UNAVAILABLE' };
  }

  async recordWorkProduct(input: {
    runId: string;
    nodeExecutionId: string;
    typeKey: string;
    contentRef: string;
    sensitivity?: WorkProduct['sensitivity'];
  }): Promise<Result<WorkProduct, never>> {
    const product: WorkProduct = {
      id: this.ids.ulid(),
      runId: input.runId,
      nodeExecutionId: input.nodeExecutionId,
      typeKey: input.typeKey,                        // pack-declared, opaque to Core
      contentRef: input.contentRef,
      sensitivity: input.sensitivity ?? 'internal',
      createdAt: this.clock.nowIso(),
    };
    await this.workProducts.put(product);             // EntityStore, NOT Repository (ADR-0001)
    await this.events.emit({
      type: 'ExecutionWorkProductRecorded',
      occurredAt: product.createdAt,
      payload: { workProductId: product.id, typeKey: product.typeKey },
    });
    return { ok: true, value: product };
  }
}
```

### BAD — ANTI-EXAMPLE (must NOT be committed; does not compile in `packages/core`)

> ⚠️ **Illustrative anti-example only.** Every forbidden noun appears here on purpose. Adding this file to `packages/core` fails `pnpm check` at three checks simultaneously: token scan (`Coding`, `Git`, `Repository`, `Developer`, `CTO`, `Article`), identifier scan (`Repository`), and the import/dependency check (`@companyos/pack-devcompany` resolves to a pack that depends on Core — a cycle). It is shown so reviewers can recognise the pattern instantly in diff review.

```ts
// ❌ packages/core/src/execution/article-capsule.ts   <-- NEVER COMMIT
// ❌ forbidden: "Article", "Coding", "Git", "Repository", "Developer", "CTO"
import { GitClient } from '@companyos/pack-devcompany/tools/git';        // ❌ boundary + cycle
import { ArticleDraft } from '@companyos/pack-article/models/draft';     // ❌ boundary + cycle

export interface Repository<T> {                                          // ❌ ADR-0001
  find(id: string): Promise<T>;
}

export interface Developer {                                              // ❌ vertical job title
  id: string;
  cto: string;                                                            // ❌ vertical exec title
}

/** ❌ Core hardcodes one vertical's node kind as a Core constant. */
export type NodeKind = 'coding' | 'article_writing' | 'git_push';

export async function runArticleCapsule(
  repo: Repository<ArticleDraft>,                                          // ❌ DDD + vertical noun
  git: GitClient,                                                          // ❌ tool coupling
  developer: Developer,                                                    // ❌ org-title coupling
): Promise<void> {
  const draft = await repo.find('latest');
  await git.commit(`draft by ${developer.id}`);                            // ❌ Core performing VCS work
  draft.headline = 'Q3 launch';                                            // ❌ editorial concepts in Core
}

// Why this is wrong, in one line: Core now requires the software vertical (Git/Developer/CTO)
// and the media vertical (Article) to exist before it can compile — the exact inversion
// CANONICAL_SPEC §1 forbids. The fix is the GOOD capsule above: WorkProduct + contentRef,
// capability resolved by contractId, persistence through EntityStore<T>.
```

### Side-by-side summary

| Concern | GOOD capsule | BAD anti-example |
|---|---|---|
| Output abstraction | `WorkProduct` + `contentRef` (medium-neutral) | `ArticleDraft` with `headline` |
| Persistence | `EntityStore<WorkProduct>` | `Repository<ArticleDraft>` |
| Step dispatch | capability resolved by `contractId` + range | `NodeKind = 'coding' \| 'article_writing' \| 'git_push'` |
| Tool use | `ToolAdapter` declared in `PackManifest`, bound at composition root | `import { GitClient } from '@companyos/pack-devcompany'` |
| Org model | `RoleArchetype` (pack-declared string) + `AuthorityGrant` | `Developer { cto: string }` |
| Direction of dependency | packs → core ports | core → packs (cycle) |
| CI result | green | **fails** (token scan × 8, identifier scan, import + dependency check) |
| Blast radius if admitted | Core stays universal; verticals add packs | every vertical must route around software+media assumptions; vertical count is capped by Core |

---

## 9. Contributor quick reference

| Situation | Do this |
|---|---|
| You need a generic store | `EntityStore<T>` — never `Repository` (ADR-0001) |
| You need a role name in Core | `RoleArchetype` (string) or `WorkRole.authority` — never a title |
| You need to output something | `WorkProduct` + `ArtifactRef` — never a medium type |
| You need a tool | Declare a port + `ToolAdapter` contract; bind it in a pack manifest |
| You need a template shipped with the app | Ship a `PackTemplateSeed`, materialized as a **draft** |
| You think Core needs a vertical noun | Re-read §5, then §6 (boundary-exception ADR). The answer is usually a missing port. |
| You added a Core dependency | Needs an ADR (ADR-0011 budget): Core depends on `@companyos/contracts` only |
| You want to skip the checker "temporarily" | Not a supported operation. Allow-list entries require an accepted ADR **and** an expiry sprint. |

---

## 10. Reconciliation with the shipped Sprint-0 implementation

Written after a post-draft audit of the delivered workspace, so contributors are not misled by aspirational detail. Normative rules above are unchanged; this section records where the shipped code differs, and which side needs to move.

| # | Item | This document / spec says | Shipped Sprint-0 reality | Resolution |
|---|---|---|---|---|
| R1 | Comment scanning | The spec bans the nouns **as identifiers**; an earlier draft of §1 of this document over-read this as "comments count too" | `scripts/check-boundaries.mjs` strips comments and string/template literals before the vocabulary scan | **Document fixed** (§1 now matches the spec and the code). Comments remain a **review convention**: a comment that introduces *new* vertical vocabulary is rejected in review, but it is not an automated failure. |
| R2 | Checker CLI | §7.2 originally showed `--layer`, `--self-test`, `--deps`, `--json` flags and a `[boundary] …` output style | The script takes **no flags**; it prints `▌ LAW 1 …`, `▌ LAW 1b …`, `▌ LAW 2 …` and `✅ Architecture boundary check PASSED — Core is industry-agnostic.` / `❌ … FAILED`; regression fixtures run through `pnpm test:scripts` | **Document fixed**: real commands/output are shown, and the richer flags are clearly labelled *planned*. |
| R3 | Which sources are scanned | §1/§7 originally implied `packages/core/src/**` only | LAW 1 scans **`packages/core/src` and `packages/contracts/src`**; LAW 1b bans inner-ring imports of pack/electron/react/persistence/observability from both | **Document fixed** (§7.1). Core+contracts is the stricter, correct reading — contracts is shared by all layers, so vertical nouns there would leak everywhere. |
| R4 | ESLint config location | `packages/core/eslint.config.js` | Single root `eslint.config.js` with a scoped block over `packages/core/src/**` + `packages/contracts/src/**` exporting `FORBIDDEN_CORE_IDENTIFIERS` | **Document fixed** (§7.1). |
| R5 | Industry-Pack package ids | This document names `@companyos/pack-devcompany`, `pack-article`, `pack-video`, `pack-ecommerce` (one pack per vertical) | The checker's vocabulary map names `pack-coding`, `pack-devcompany`, `pack-content`, `pack-commerce` | **Open — needs one decision before Sprint 3.** The canonical spec fixes only the `@companyos/pack-*` shape, not the cardinality. Either mapping satisfies the spec; the divergence is a naming collision that must be settled by an ADR so the checker's owner map, `PackManifest.packId`s, and the vertical roadmap agree. Recommended: keep the shipped four ids and treat `coding` as the software-vertical pack that `devcompany` composes, since the spec lists **Coding** and **Developer** as separate nouns. |
| R6 | Always-available packages | This document refers to `@companyos/platform`, `@companyos/ipc`, `@companyos/pack-sdk`, `@companyos/app-desktop`, `@companyos/app-renderer` | Shipped workspace has `@companyos/core`, `@companyos/contracts`, `@companyos/observability`, `@companyos/persistence`, `@companyos/desktop`, `@companyos/renderer` | **Open — naming alignment.** `@companyos/observability` (logger sinks) and the main/renderer split into `desktop`/`renderer` are the shipped names; the IPC registry and pack SDK are not yet separate packages. `docs/ARCHITECTURE.md` §4 should be read as the **target** package map and re-cut to the shipped names at the Sprint-1 planning step. |
| R7 | Lifecycle-machine path | CANONICAL_SPEC §2 states the machine lives at `packages/core/src/lifecycle/lifecycle-machine.ts`; this document repeats that path | The shipped file is `packages/core/src/lifecycle/machine.ts` (its own header says "`docs/STATE_MACHINE.md` mirrors this table — change both together") | **Open — spec-vs-code path conflict.** Do not "fix" silently: the spec is the source of truth, so either rename the file to match the spec or amend the spec by ADR. Tracked as FR-15 in `docs/ARCHITECTURE_REVIEW.md` §7. |
| R8 | Transition event naming | `revise` (spec diagram) | Shipped machine exposes **two** events, `open_revision` (draft created under an accepted proposal) and `publish_revision` (draft promoted) | **Compatible, not conflicting**: `revise` in this document is the *capability*, and its implementation is the two-phase pair. `docs/STATE_MACHINE.md` §2.3's `revise` row should be read as `open_revision` + `publish_revision` in code terms. |
| R9 | Event-name casing | This document uses PascalCase domain events (`WorkflowPublished`) | Shipped code emits dotted lowercase (`workflow.template.published`) | **Cosmetic but real.** Pick one and apply it in both places; recommend keeping the shipped dotted form and updating the event tables, since it is already the persisted contract shape. |
