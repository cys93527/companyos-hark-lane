# T20-03 — Normal-Task Materializer (Phase A: Canonical Task→Run Ownership)

> **Status: Phase A + Phase B COMPLETE.** Phase A = canonical Task→Run ownership
> (Boss-approved `tasks.run_id` + creation-identity hardening). Phase B = the generic
> normal-task materializer. No Planner, no Plan compiler, no Execution Run derivation —
> those remain later Sprint-20 tasks.

## Phase A — Canonical Task Run Ownership (T20-03A)

### The original vulnerability (source-proven + reproduced)

Task rows carried **no run ownership**: the `tasks` table (`engine/0001:44-57`) had no
`run_id` and no `company_id`, and EVERY production Task→Run "proof" was stage membership in
the run's pinned WorkflowVersion — `nextWorkUnit` (`autonomous-supervisor.ts:571`),
`reviewTaskIdsOf` (`:527`), the decision sink (`decision-sink.ts:420-443`), the corrective
provisioner subject check (`corrective-provisioner.ts:217`) and the desktop bounded-context
helpers. Because two Runs routinely pin the SAME version/stage (shared templates, packs),
a task "of" Run A was indistinguishable from a task of Run B at every one of those seams.

The blocker reproduction (real `composeCoreServices`, one template/version, Run A + Run B
both pinning it, ONE work task TA intended for Run A) proved **Run B's autonomous loop
claimed and fully executed TA**: applied effect `stage:work:completed`, TA → DONE, a real
Developer provider invocation, and a Developer session scoped to `runB+TA` — an
ownership-lying durable session.

### Root cause and the ownership model (frozen)

Root cause: no canonical ownership fact existed; stage membership is GRAPH LEGALITY, never
ownership. After Phase A the sole canonical chain is:

```text
Task.run_id → Run → Company
```

- `tasks.run_id TEXT NOT NULL` with `FOREIGN KEY (run_id) REFERENCES runs (id)` (no cascade:
  a durable task never disappears through a casual parent delete). No `company_id` on tasks
  (two ownership facts would drift; tenant scope resolves run → company).
- `runId` is REQUIRED, immutable identity on the domain `Task`/`CreateTaskInput`; there is
  no move/reassign API — changing ownership means a different Task. `taskId` encoding and
  `Task.inputs` are explicitly NOT ownership authority.
- Stage membership REMAINS graph legality only. Every claim seam now requires BOTH:
  `task.runId === run.id` (ownership) AND stage ∈ pinned graph (legality).

### Migration (`engine/0002_task_run_ownership.sql`)

SQLite table rebuild adds the column, the FK and `idx_tasks_run` (a plain index — NO
uniqueness: whether multiple legitimate tasks per stage/run may exist is deliberately not
frozen here; no local task key either — that is T20-03B materializer design).

**Legacy fail-closed (data-value independent — Boss corrective on T20-03A):** rows of the
old schema carry NO mechanically knowable ownership (two runs may pin the same
version/stage — stage, version membership, task id, inputs, timestamps or "the only run"
heuristics can never reconstruct it). The migration therefore aborts EXACTLY when the
legacy table still contains ANY row:

```text
legacy task count = 0  → migration proceeds (nothing to lose)
legacy task count > 0  → deterministic migration error → transaction rollback
```

The mechanism is a temporary `BEFORE INSERT` trigger whose `WHEN EXISTS (SELECT 1 FROM
tasks LIMIT 1)` fires `RAISE(ABORT, 'TASK_RUN_OWNERSHIP_LEGACY_DATA_UNMIGRATABLE: …')` —
the repository-native SQL-only precondition (the migration runner executes whole-file SQL
inside one transaction; `RAISE` inside a trigger is the only pure-SQL abort). **Why the
earlier sentinel-mapping + FK-rejection design was rejected as final architecture:** its
failure depended on a chosen Run id not existing — a data VALUE. A database that happens
to contain a Run literally named like the sentinel (or any adversarial identifier) must
still fail; existence-based abort is independent of every identifier value (proven by the
adversarial test). On failure the runner's transaction rolls back: the old schema, every
legacy row and all other data are preserved unchanged; no ownership is inferred, no
placeholder assigned, nothing deleted, nothing silently reset. Legacy development
databases with tasks require explicit manual reset/migration — the abort message says so.

### Task creation identity: replay vs conflict (Boss corrective on T20-03A)

Canonical task creation goes through the guarded seam `tasks.putGuarded` (the durable
store; the corrective provisioner uses it for every creation):

```text
load existing by id
  absent  → insert (one canonical task; the PRIMARY KEY arbitrates same-id races)
  present → compare IMMUTABLE CREATION IDENTITY
            identical  → REPLAY (success, replayed=true — no second row, no mutation)
            different  → TASK_IDENTITY_CONFLICT (fail closed — the stored row is untouched)
```

#### Task Creation Identity vs Immutable Metadata (Boss final hardening on T20-03A)

The creation REPLAY SEED and the immutable STORED METADATA are distinct concepts: a field
may be immutable after insert without defining replay equivalence.

- **Creation seed (what a replay must reproduce):** `runId`, `stageId`, `roleId`, `kind`,
  `maxAttempts`, **canonical immutable `inputs`**.
- **`createdAt` / `updatedAt`: immutable stored metadata, NOT replay identity.** Nothing
  ever rewrites them (the first insert owns `createdAt`; the store upsert's conflict arm
  touches neither). A retry after restart / DB retry / crash recovery / a later command
  replay legitimately happens at a different wall-clock time — a caller must never need to
  know or reproduce the original `createdAt`. On replay the STORED value wins, untouched.
- **`state`, `attempts`, `outputs`: lifecycle state, excluded from creation replay
  identity.** A task created PENDING and later DONE still replays its creation command as
  a REPLAY when the seed matches — nothing resets, nothing conflicts.
- **`Task.inputs` = immutable creation specification (source-audited):** `applyTaskEvent`
  never touches inputs (spread preserves), the store upsert never rewrites `inputs_json`,
  and no production API mutates inputs after creation — exactly why corrective lineage
  (root/parent/round/Decision refs) can live there. Consequently inputs PARTICIPATE in
  creation conflict: same taskId + same scalar seed + different canonical inputs ⇒
  `TASK_IDENTITY_CONFLICT` (never "accept the new lineage onto the existing row").
- **Canonical comparison:** inputs compare by `canonicalJson` (semantic equality —
  property insertion order is irrelevant); scalar seed fields compare by value. No
  normalization beyond the existing canonical JSON behavior.
- **`maxAttempts` audit:** the domain lifecycle never changes it (creation-time
  configuration ⇒ in the seed). The generic EntityStore upsert retains its pre-existing
  ability to persist a caller-supplied `max_attempts` on the lifecycle write path —
  reported explicitly; no domain API exercises it.
- **Concurrency:** the synchronous single connection makes the load-compare-insert window
  non-interleaving; the PRIMARY KEY arbitrates same-id races and a re-read decides
  replay-vs-conflict — two same-seed attempts at different timestamps converge to ONE
  canonical task plus one replay (the stored `createdAt` stays the first value), never a
  silent double-win.
- **Future T20-03B compatibility:** the seed is generic — normal-task inputs (criterion
  refs, canonical execution refs) will participate in creation identity without any
  redesign of Task ownership.

Corrective replay: the same deterministic seed replays the same task (proven through the
REAL provisioner with an advanced clock); the same deterministic id under another run (or
any incompatible creation seed, including different lineage inputs) is a conflict;
root/parent/round/Decision lineage semantics are unchanged.

### Ownership enforcement (every seam)

| Seam | Enforcement |
| --- | --- |
| Autonomous loop claim (`nextWorkUnit`, `reviewTaskIdsOf`) | `tasks.listByRun(runId)` — only this run's rows are even loaded; stage membership stays graph legality |
| Agent unit execution (`runAgentUnits`) | `task.runId === input.runId` before ANY work — `TASK_RUN_MISMATCH` |
| Engine `executeStageInternal` | caller-supplied taskId is never proof: `task.runId === request.runId` asserted before execution — `TASK_RUN_MISMATCH` |
| Decision sink `validateStageAndTask` | ownership check BEFORE stage membership — `SUPERVISOR_DECISION_TASK_RUN_MISMATCH` |
| Corrective provisioner | subject parent must satisfy `runId === run.id` (`CORRECTIVE_PARENT_RUN_MISMATCH`) + pinned-stage legality; created T1 carries `runId = run.id` with root/parent/round/Decision lineage unchanged |
| Developer session runtime | `SESSION_TASK_RUN_MISMATCH` BEFORE any session/kernel work — a wrong-run session can no longer exist |
| Bounded review/QA projectors | `BOUNDED_CONTEXT_TASK_RUN_MISMATCH` — a projection never presents a foreign-run task |
| Stage-output carrier (recovery) | `STAGE_OUTPUT_TASK_RUN_MISMATCH` before sink lookup; the Sprint-19 unknown-carrier FAIL CLOSED rule is unchanged |
| Desktop helpers (`workSubjectTaskOf`, `reviewTaskAnchorsOf`) | run-scoped `listByRun` first, then stage semantics |

### Store and reads

`createSqliteTaskStore` persists `run_id`; the upsert NEVER rewrites identity/ownership
columns (runId immutable). New canonical read `listByRun(runId)` pushes the run filter into
persistence (`idx_tasks_run`), so claim paths never load another run's rows. No second task
repository, no new table beyond the rebuilt `tasks`.

### Why taskId encoding / Task.inputs are not authority

A taskId naming convention is not enforceable (any writer may mint any id; the corrective
provisioner's run-scoped `tsk_<sha256>` never stopped another run's loop from claiming the
row). `Task.inputs` is caller-influenced data the engine never consults for ownership.

### Recovery impact

Crash/replay semantics are identity-based and unchanged: deterministic replay of the same
task seed yields the same row; recovery reconciliation gains an ownership check; the
Sprint-18/19 fault-injection and crash suites all pass unmodified. Restart preserves
ownership (proven by test §43).

### Corrective impact

The provisioner sets `runId = run.id` at creation; identity, lineage, rounds and Decision
provenance are untouched. The T18-05 corrective suite passes; the two-run corrective
positive/negative are proven in the new suite (§39/§44).

### Sprint18/19 invariant impact

None weakened: the full Sprint-18 autonomous/corrective/crash suites and the Sprint-19
session/bounded-context/durability suites pass unchanged. The only test-semantics change:
tests that (unintentionally) reused one run's task as another run's subject now fail —
exactly the vulnerability closing.

### Gap board after Phase A

TASK_RUN_OWNERSHIP / TASK_RUN_ISOLATION / TASK_TENANT_DERIVATION / TASK_RUN_MIGRATION =
CLOSED; TASK_STAGE_GRAPH_LEGALITY = PRESERVED; NORMAL_TASK_MATERIALIZER / IDENTITY / REPLAY
= OPEN (T20-03B); PLAN_TO_TASK = OPEN; T20-03 = PARTIAL.

---

## Phase B — Generic Normal Task Materializer (T20-03B)

### Owner and API

Trusted Engine infrastructure (`packages/engine/src/planning/normal-task-materializer.ts`),
wired into the production composition as `core.normalTaskMaterializer` — a trusted
main-process service exactly like the session runtime (NOT in the frozen IPC workflow
contract, not a Tool, not MCP, not model-callable; no such exposure exists for trusted
internal services and none was added).

```text
materialize({ companyId, runId, stageId, inputs? }) → { taskId, replayed, task }
```

Everything except the bounded generic `inputs` is resolved internally: run ownership,
snapshot verification, pinned version, stage legality, stage-kind classification, creation
profile (roleId/kind/maxAttempts), deterministic identity, guarded creation.

### Granularity (recon-frozen)

ONE canonical baseline normal Task per (run, materializable stage) — the V1 invariant the
Boss preferred and the source confirms: every production fixture seeds exactly one baseline
task per stage; corrective tasks share the stage but are separately owned by the corrective
provisioner (T18-05 deterministic identity). **Local task key = NOT REQUIRED.** No
`UNIQUE(run_id, stage_id)` (corrective tasks may share the stage); normal uniqueness comes
from the deterministic id + the guarded seam. No task-level DAG — the WorkflowVersion stage
DAG remains the work-decomposition authority.

### Core vs Industry/Business Pack boundary (Boss corrective — FROZEN PRINCIPLE)

**CompanyOS Core is NOT a software-development system.** Software development is ONE
Industry/Business Pack; Core must equally support procurement, legal, finance, content
operations, enterprise approval, research and any other structured business process
WITHOUT renaming their roles developer/reviewer/qa. The materializer is GENERIC pinned-work
infrastructure: Core never cares whether a node means "write code", "review a contract",
"approve an invoice", "screen a supplier", "produce an article" or "verify a shipment" — it
sees only a trusted pinned work specification → a canonical Task. A future Procurement Pack
CAN define stages like supplier-screening / finance-approval / purchase-approval /
delivery-verification without modifying Core (proven by the synthetic non-software suite:
Legal / Procurement / Content Packs require ZERO engine change; new roles/task kinds never
extend a Core switch — there is no switch).

`work|review|qa` are the CURRENT software/autonomous workflow's vocabulary (the supervisor
loop's phases use it) — legacy workflow configuration, NOT universal business roles, and
the materializer no longer enumerates them at all.

### Stage materializability + trusted task profile authority (pack-driven, PINNED)

There is NO stage-kind classification and NO live-composition resolver. The creation facts
are frozen in the **pinned WorkflowVersion node config** (`taskProfile: {roleId, taskKind,
maxAttempts}` — the same durable-with-the-version convention as `roleId`/`validatorIds`;
publish-time graph validation rejects partial/malformed profiles as
`TASK_PROFILE_INVALID`):

- **A COMPLETE pinned profile IS what makes a stage materializable.** Absent / partial /
  malformed ⇒ `NORMAL_TASK_STAGE_PROFILE_UNAVAILABLE` (fail closed — Core never guesses,
  and unknown future stage kinds gain no Task authority by absence of a deny rule).
- The Pack that publishes the version owns the business meaning: the software workflow's
  nodes carry `{roleId: rol.developer|rol.review|rol.qa, taskKind: …, maxAttempts: 3}`; a
  procurement Pack would carry `{roleId: rol.procurement-analyst, taskKind:
  task.procurement-analysis, maxAttempts: 2}`. Core treats both identically.
- **Pinned semantics (§16/§17):** a run pins V1 with profile P1 → later pack/composition/
  registry changes can never change what that run materializes: the profile is read from
  the pinned version, so replay after ANY restart or app upgrade reproduces the original
  creation seed (REPLAY, not conflict). `TASK_IDENTITY_CONFLICT` on profile mismatch
  remains defense-in-depth against corruption, not normal upgrade behavior.
- **maxAttempts** is workflow semantics frozen with the profile (each Pack sets its own
  retry policy per stage) — not a mutable deployment default.
- The `taskKindAvailable` probe (composition-owned, optional) mirrors the provider
  durable-descriptor vs process-adapter split: it CONFIRMS a process-local implementation
  exists for the pinned semantic kind (unavailable ⇒ `NORMAL_TASK_TASK_KIND_UNAVAILABLE`,
  fail closed, no substitution). It never chooses, orders or substitutes kinds — **there is
  no "first registered kind" authority anywhere**: registration order can never determine
  Task.kind (the taskKind comes from the pinned version, period).

### Pinned version resolution

Run → `runSnapshotVerifier.verify` (the T18-02 seam) → `template.versions.find(id ===
run.versionId)` — NEVER `template.currentVersion`. A V2-only stage is invisible to a V1-run
(`NORMAL_TASK_STAGE_NOT_PINNED`); exact canonical stage ids only, no fuzzy mapping. Foreign
company → `NOT_FOUND`/no leak.

### Identity and replay

```text
normalTaskId = tsk_<sha256("companyos/normal-task/1:" + companyId + ":" + runId + ":" + stageId)[0:26]>
```

The namespace is salted apart from the corrective identity (`companyos/corrective-task/1:…`)
and this module NEVER creates corrective tasks. Because (run, stage) is the permanent
semantic identity, NO command ledger is needed: repeated calls replay through the frozen
T20-03A guarded seam — same creation seed ⇒ REPLAY (the stored row wins, createdAt
unchanged, lifecycle progression untouched); different seed (inputs or trusted profile) ⇒
`TASK_IDENTITY_CONFLICT`.

### Input semantics

Bounded (≤16 384 canonical-JSON bytes — the materializer cannot become an unlimited
payload seam; note: `createTask` itself remains unbounded for other callers, a documented
pre-existing state), generic, immutable creation data. Corrective keys are REFUSED
(`NORMAL_TASK_CORRECTIVE_INPUTS_FORBIDDEN`) — lineage belongs solely to the corrective
provisioner. No Plan-specific fields were added.

### Non-responsibilities (frozen)

Materialization stops at Task creation: no execution, no Developer invocation, no provider
call, no AgentExecution, no stage advance, no Review/Validation/Decision/Session/Handoff
write, no run creation, no repin, no workflow publish. Single-task API only — future
compilers iterate stages and replay safely after crashes (deterministic identity makes
partial materialization resumable without a batch truth).
