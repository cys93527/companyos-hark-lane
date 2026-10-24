# Windows V1 release gates and Ubuntu compatibility

Boss decision, 2026-10-12. This contract supersedes treating Ubuntu environment
compatibility as an automatic Windows candidate-freeze prerequisite. It changes
no canonical Runtime authority, required remote check, or safety policy.

| Gate | Required evidence | Effect of an actual failure |
|---|---|---|
| Windows candidate freeze | Exact source and fixture inventory, latest-candidate Windows offline six-stage gate and tooling regressions, independent review, no open shared P0/P1, no unknown required files or credentials | Blocks freeze. Old candidate evidence cannot validate new bytes. |
| Windows V1 formal release (PRIMARY) | Frozen candidate plus controlled real business loop, default Electron desktop, authorized permissions and Medium-user compatibility, recovery/stop evidence, packaging/install/uninstall and independent acceptance | Blocks Windows release. Freeze and offline PASS alone do not authorize release. |
| Ubuntu compatibility CI (INDEPENDENT) | Native Ubuntu 24.04, Node 22/24, pnpm 11.25.0 frozen lockfile, workspace check, complete existing `pnpm check` and `pnpm test:scripts`; exact latest source | Record real FAIL/BLOCKED. Ubuntu-only environment issues do not automatically block a Windows freeze application. They are never converted to PASS. |
| Shared correctness/security | Confirmed shared product or safety defect, including unsafe default execution or broken budget/cancel/artifact invariants | Shared P0/P1 blocks both gates until corrected and independently verified. Unknown evidence stays open pending adjudication. |

## Enforcement and remote checks

The existing six-stage aggregator and default offline Guard remain authoritative
for local offline checks. No release automation or new status authority is added.
The existing GitHub `check` job, check names, Node matrix, complete checks, failure
propagation and timeout remain intact. Its OS label is pinned to `ubuntu-24.04`.
Its fixed file-only preparation step runs `node scripts/prepare-offline-resources.mjs`
before checks, supplying only the three audited test files on a clean checkout.
No `continue-on-error`, excluded test, disabled CI or replacement PASS is allowed.
Repository branch protection and required status checks are unchanged: merge must
satisfy them. Any future rule change needs separate Boss and repository-owner
authorization; this document cannot bypass a failing required Ubuntu check.

## Test-resource supply

`scripts/prepare-offline-resources.mjs` supplies only three exact byte resources
for offline tests. The B fixture and MIT notice are versioned under
`tests/fixtures/kernel-readonly`; two A texts are derived from hash-pinned literal
expressions in the reviewed materializer source, without importing that program.
The preparer rejects drift and links, never overwrites mismatching existing data,
and creates no manifest, complete Kernel or execution permission.

Preparation precedes Guard initialization in the two existing test entries.
Run that same fixed preparation entry before a local fresh-checkout aggregate.
For an externally preloaded Guard on a fresh checkout, explicit resource
preparation must precede starting that process; do not start with a missing
Kernel hash and claim equivalent protection. Preparing the missing Kernel bytes
after Guard installation is explicitly refused. The original copy/hash-denial
assertion must actually execute. Generated files remain ignored test data.

The tracked broker TLS key/certificate are non-production loopback fixtures;
leave their bytes unchanged. No production credential is permitted in Git,
logs, fixtures or CI artifacts. Ubuntu hosted-runner upload/execution requires
a separate private-repository, source identity, credentials and cost approval.
Stop local VM provisioning. No upload or native Ubuntu execution is authorized
by this local implementation decision.

## Current status and unresolved boundaries

`WINDOWS_FIRST_FULL_OFFLINE_QUALITY_GATE = PASS` (Date: 2026-10-13; Boss
adjudication: CLOSED). 6/6 stages PASS; 299 test files; 3682 PASS / 0 FAIL /
0 SKIP; No reported unhandled error; Build 3/3 PASS; Node / Wrapper exit
0 / 0. One attempt, 267.91 seconds; Evidence 98 items.

Source: [final acceptance report](F:/chatgpt/CodexData/visualizations/2026/10/05/01a10e6b-7a2f-7e02-b394-4e6e12e57701/Windows-First-Final-Gate-20261013-0913/WINDOWS-FIRST-FINAL-FULL-GATE-RESULT.md);
SHA-256 `DFB691BBD581BBA88DD141E5031D4A5E2686A23C729E25026614D5932524C919`.
[98-item evidence seal](F:/chatgpt/CodexData/visualizations/2026/10/05/01a10e6b-7a2f-7e02-b394-4e6e12e57701/Windows-First-Final-Gate-20261013-0913/evidence-sha256.json);
SHA-256 `4AA1EF3147537C9346EA11CC69F0DE1DF889D21384E3531FA6DCDFD5BF1FB416`.
The gate verified the 914-file candidate before this two-document state sync.
This documentation delta is separately identified, not a new gate run.

`SPRINT2_CANDIDATE_FREEZE = BLOCKED / NOT YET AUTHORIZED`. The audit
proposed 138 implementation files (74 modified, 64 added), not staged or
committed files. PROJECT_HANDOFF.md is handled separately. This state sync
requires ZCode delta review and does not authorize candidate freeze.

`WINDOWS_V1_RELEASE = BLOCKED`. Real DSH / Provider / Goal, Medium
Integrity User, complete Electron Desktop delivery, Persistence / Recovery,
Windows Packaging / Installation / Uninstallation, and Shared Correctness
and Security Blockers still require their independent acceptance. Existing
startup/Workspace partial acceptance is not full release acceptance.

`UBUNTU_COMPATIBILITY = NOT ACCEPTED`; native Ubuntu validation: NOT RUN.
Complete Ubuntu CI and required remote checks remain unchanged. NOT RUN or
FAIL is never PASS. Windows candidate freeze and Ubuntu compatibility remain
independent under the approved contract. Earlier Lint/Ubuntu/quality-gate
failures and incident evidence remain historical, not rewritten by this PASS.
E-ROOT-DACL-CHANGE remains OPEN; C-user SDDL remains NOT VERIFIED. Historical
TCP, RC5 origin and CROSS-TASK remain UNKNOWN. Real DSH/Provider/Goal, Windows
Medium-user compatibility and packaging remain NOT ACCEPTED.
