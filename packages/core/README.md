# `@companyos/core`

The **industry-agnostic domain kernel** of CompanyOS V1.1.

## The two laws

1. **Vocabulary law** — nothing in `src/**` may name a vertical concept:
   `Coding`, `Git`, `Repository`, `Developer`, `CTO`, `Article`, `Video`,
   `Ecommerce`. Those live in `@companyos/pack-*` (ADR-0002).
2. **Dependency law** — zero runtime dependencies. `package.json` has no
   `dependencies` block at all (ADR-0005). Both laws are machine-enforced by
   `node scripts/check-boundaries.mjs`, which runs first inside `pnpm check`.

## What lives here

| Area | Content |
|---|---|
| `kernel/` | `Result`, error taxonomy, ULID minting, canonical JSON + content hashing, event envelope, in-memory bus |
| `ports/` | `Clock`, `IdFactory`, `Logger`, `EntityStore`, `UnitOfWork`, `MigrationRunner`, `EventBus`, `SecretResolver`, `ModelGateway` (types only), `AgentRuntimePort` (types only) |
| `lifecycle/` | The 10 lifecycle capabilities: draft/publish/version/fork/deprecate/archive plus run snapshot, template lock, change proposal and performance metrics |
| `registry/` | Industry-Pack manifest contract + in-memory `PackRegistry` |

## Deliberate naming

The persistence port is **`EntityStore`**, never `Repository` — the word belongs
to the coding pack. See ADR-0001 in `docs/ARCHITECTURE_REVIEW.md`.

## Sprint 0 scope

`ModelGateway` and `AgentRuntimePort` are **contracts only**: Sprint 0 must not
build a model router, an agent runtime, DevCompany, a coding agent or a workflow
designer. `tests/sprint0-guardrails.test.ts` fails the build if that rule is broken.

## Commands

```bash
pnpm --filter @companyos/core build   # tsc -b
pnpm exec vitest run packages/core    # unit tests
node scripts/check-boundaries.mjs     # architecture law
```
