# T19-01 — Session / Context Runtime Hard Recon

Status: recon only (Sprint 19, Task 19-01). No implementation. This document is the input for
the Boss architecture ruling before T19-02. Baseline: `6c3c0d5` (Sprint 18 CLOSED, tag
`sprint-18` preserved). Every claim below cites the exact source path + function.

## 0. Frozen principle

Session = model-context container. Session ≠ business truth. Authoritative state remains:
Run, Task, Decision, Artifact, Review, Validation, AgentExecution, ToolInvocation,
WorkflowVersion, RunSnapshot. A Session may HELP an Agent reason; a Session may NEVER decide
whether work is actually complete.

## 1. Current context path — traced exactly

There is exactly ONE production path from any agent role to a provider invocation:

```
role-specific context builder
  → AgentRuntime.prepare (creates AgentExecution row: READY)
  → AgentRuntime.runWithOutput/runTurn
      → buildAgentContext (Core: validates bounds, freezes shape)
      → assemblePrompt (Core: deterministic; computes promptHash)
      → toMessages (Core: system + user, exactly two messages)
      → ProviderRegistry.invoke (authorization: provider.invoke)
      → InvocationRequest (modelId, messages, responseFormat, tools, traceId, signal)
      → provider adapter (in-process)
```

Sites: `packages/engine/src/runtime/agent-runtime.ts` (`prepare`, `runTurn` →
`buildAgentContext`, `assemblePrompt`, `toMessages`, `providers.invoke`);
`packages/core/src/domain/agent-context.ts` (`buildAgentContext`, `CONTEXT_LIMITS`,
`contextSummary`); `packages/core/src/domain/prompt-assembly.ts` (`assemblePrompt`,
`toMessages`); `packages/core/src/ports/model-provider.ts` (`InvocationRequest`).

Per-call answers:

- **Context origin**: the CALLER of AgentRuntime constructs `ContextInput` (core:
  `ContextInput = Omit<BuildAgentContextInput,'binding'|'trace'>`). There is no
  repository/loader that gathers context; each trusted caller assembles it.
- **System prompt**: `assemblePrompt` uses `input.rolePreamble ?? DEFAULT_PREAMBLE`
  (`prompt-assembly.ts`). Role-specific: the Supervisor additionally passes
  `supervisorSystemPrompt()` as `instructions[0]` (`supervisor-runtime.ts` `runModelOnce`).
- **User/task context**: `contextSummary(context)` renders `# Objective / # Instructions /
  # Constraints / # Acceptance criteria / # Previous handoff / # Memory view / # Decision
  view / # Artifact references` (`agent-context.ts`).
- **Goal**: Supervisor reads the canonical Goal artifact per turn (`buildContext` →
  `deps.runGoal.get`); Developer/Reviewer/QA receive only `objective` as a plain string the
  caller supplies (today a static fallback string in `composedStageHandlers`,
  `apps/desktop/src/core-services.ts`).
- **Task**: Supervisor reads the subject Task row (id/stage/state/kind/attempts);
  Developer/Reviewer/QA pass only `{id, label}` references — no task fields.
- **Decisions**: Supervisor only — `decisionHistory.listRunDecisionHistory` projected
  bounded (20 entries) into `decisionView` + context refs. Workers get none.
- **Review findings**: Supervisor only — latest report (verdict/subject/findings ≤20,
  bounded text) via `getLatestReviewReport` across the run's review tasks
  (composition wiring `core-services.ts` `reviewTaskAnchorsOf`). Reviewer itself does NOT
  see prior findings; QA does not either.
- **Validation evidence**: Supervisor only — latest row via `validations.listByRun`.
- **Artifact refs**: refs only, never content (`artifactRefs: readonly ContextReference[]`,
  cap 200). Supervisor adds the latest review report ref; the AgentRuntime resolves MANAGED
  refs against durable rows before persisting (`agent-runtime.ts` ~L534-601) — the prompt
  carries only ids.
- **Repository state**: NOT in model context at all. The T17 repository handler uses the
  baseline for lease/anchor VERIFICATION (`repository-agent.ts` steps 2-6); no baseline or
  diff content reaches a prompt today.
- **Prior model output**: nothing feeds a later call's context from previous outputs except
  the Supervisor's bounded `decisionView` (decisions are durable records, not transcripts).
  No conversational transcript exists anywhere.
- **Tool results**: none reach context (V1 autonomous supervisor is tool-less; repository
  tools' outputs are evidence rows, not prompt content).
- **Persisted per call**: AgentExecution row (status/usage/latency/resultRef/artifactRefs),
  audit events, promptHash is COMPUTED but only persisted as `inputDigest` inside the
  invocation-started audit payload — the prompt itself and the context are NOT persisted.
- **Reconstructed**: everything a turn needs is re-derived from authoritative stores
  (Goal artifact, run row, task rows, decision history, review artifacts, validation rows).
- **In memory only**: the assembled `AgentContext`, the `PromptPlan`, the rendered messages,
  the provider result — all discarded after settlement.

## 2. AgentExecution semantics (audited)

`packages/core/src/domain/agent-execution.ts` + `packages/persistence/src/durable/sqlite-agent-stores.ts`:

- One AgentExecution = ONE model invocation attempt (prepare creates READY; one
  `runWithOutput` per execution; `deferCompletion` lets a trusted caller settle later).
  It cannot contain multiple turns; each turn mints a new execution (`attempt` increments on
  retry paths). It cannot "resume" — a RUNNING execution is reconciled fail-closed or
  FAILED→RETRY→new attempt under existing rules.
- Persisted: identity (executionId, agentId, roleId, taskId, runId), full model identity
  (modelKey, providerId, providerModelId), status, timing, `inputUsage`/`outputUsage`
  (tokens), latency, `resultRef`, artifactRefs, error triple, traceId, attempt.
  NO commandId column; NO context/prompt bytes; NO parent-execution field; NO
  conversation/session linkage.
- **Is AgentExecution sufficient as a Session? NO.** It is the canonical record of a single
  model execution (provenance + usage) — exactly what it should stay. It has no ordered
  conversational entries, no compaction checkpoint, no parent/child lineage, no per-session
  token accounting across turns, and storing prompts in it would bloat the record of
  execution truth. Conversely, a Session MUST NOT become a second execution record: session
  entries should REFERENCE executions, never replace them. (No new Session table is
  PROVEN needed by the gaps below — see storage options; the necessity ruling belongs to the
  Boss.)

## 3. Current Supervisor context (per turn)

`supervisor-runtime.ts` `buildContext` re-reads EVERYTHING from authoritative state per
turn: Goal artifact (company-scoped), run row (state/revision), subject Task row, corrective
lineage (from task inputs, T18-05 projection), latest review (cross-review-task newest),
latest validation row, decision history (bounded 20), pinned binding
(`modelBindings.resolve` → registry), blocking conditions, allowed actions, context refs.
Turns are STATE-RECONSTRUCTED, not transcript-based.

- Depends on previous conversational transcript: **NO** — by construction.
- Resume after process restart: YES (proven by T18-08 real-process tests; decisions replay
  from durable identity; provider adapter rebinds idempotently).
- Conversational information lost between turns: the model's own reasoning narrative. Only
  its DECISIONS (action/reasonCode/summary ≤400 chars) survive durably. That is a deliberate
  truth boundary, and the summary field is the only "conversational" residue.

BUSINESS FACTS (authoritative, re-read): goal, run state/revision, subject task, lineage,
review verdict/findings, validation rows, decisions, binding, blocking conditions.
CONVERSATIONAL CONTEXT (non-authoritative, currently lost or carried only in bounded
decision summaries): the model's rationale beyond the summary, intermediate reasoning,
anything a multi-turn worker would have "remembered" across its own turns.

## 4. Developer context today

Production Developer = the `e2e7:build`-style work stage executed by the ENGINE's stage
execution (engine's scripted/default handler in the Sprint-13 composition; the Sprint-18
E2E fixture substitutes the composed agent handler). The composed agent handler
(`core-services.ts` `composedStageHandlers.build`) sends: company/workflow/version('pinned'
placeholder!)/run/stage/task REFERENCES, a static objective fallback, `structuredKeys`.
It receives: NO goal text, NO task fields beyond id, NO scope, NO repository baseline, NO
previous developer output, NO reviewer feedback, NO decisions, NO acceptance criteria, NO
artifact refs (empty arrays), NO corrective lineage. Note also the placeholder bugs worth
recording for T19-02 hygiene: `company.id` is set to the SESSION ACTOR id and
`workflowVersion` to the literal `'pinned'` — both are context-projection inaccuracies, not
truth violations (neither is used for authorization).

Missing for a real multi-turn coding worker: goal + acceptance criteria; task scope/inputs
(corrective lineage); the run's decisions affecting it; bounded prior-round context for
corrective loops; repository baseline/changed-file evidence; explicit token budget.

## 5. Reviewer context today

Reviewer = composed agent handler (`role:'review'`, structured keys verdict/subjectTaskId/
findings). Receives: reference skeleton + static objective. NO code/change evidence, NO
developer reasoning, NO goal, NO task fields, NO acceptance criteria, NO repository
baseline/current state, NO prior review findings, NO corrective history. Its verdict comes
from the deterministic provider script in tests; in production there is no real reviewer
model integration yet (real-provider gap). Isolation is STRUCTURAL (the reviewer handler
builds its own context; nothing shared is passed in), but its blindness is total — the
isolation that matters (reviewer ≠ developer self-certification) exists structurally
because the reviewer receives NO developer transcript at all.

## 6. QA context today

QA = composed agent handler (`role:'qa'`, structured keys targetRef/validators) → canonical
carrier → ValidationService. Receives: reference skeleton + static objective. The
VALIDATORS and target ref come from the model's structured output (validated against the
pinned stage policy by the evidence gate) — QA does not receive the required-validator
configuration as context (it must produce it; the gate then checks it). NO review outcome,
NO repository anchor, NO prior batches, NO lineage. Again: authoritative facts (rows,
artifacts) exist; the QA model context is nearly empty.

## 7. Cross-contamination audit

Searched all context-path sources for shared mutable arrays, prompt buffers, module
globals, provider conversation ids, cached transcripts, singletons, process-global maps:

- `agent-runtime.ts`, `supervisor-runtime.ts`, `pinned-agent-execution.ts`,
  `autonomous-supervisor.ts`: NO module-level mutable context state. Per-call closures only.
- `core-services.ts`: ONE module-level mutable: `lastCompositionError` (diagnostic string,
  not context). The composed handler map is built once per composition (immutable map).
- `ProviderRegistry`: `bound` Map is process-local ADAPTER bindings (not context);
  `knownSecrets` refetched per call — no conversation state.
- No provider adapter keeps conversation state (only the deterministic mock/fake exist).
- The Sprint-18 test fixture has module-level script state (`routingScript`,
  `validatorScript`) — TEST-ONLY, outside production source.

Conclusion: today there is NO cross-role contamination channel because there is NO shared
conversational state at all. The contamination risk is FUTURE: any Session runtime that
introduces shared buffers must keep per-session immutability.

## 8. Tenant / run isolation

- Context SOURCES are tenant-safe today: runGoal reader is company-scoped; decision history
  is company+run scoped; review readers are company+run scoped; validation store is
  run-scoped; tasks are bound to runs via the pinned graph.
- The composition's reviewer context resolution (`reviewTaskAnchorsOf`) derives review
  tasks from the RUN's pinned graph — run-scoped by construction.
- One Run cannot inherit another Run's prompt/outputs: contexts are built per call from
  run-scoped reads; nothing is cached across runs. Cross-tenant: every durable reader
  enforces companyId (T18-08 §32 test). Fail-closed requirements to carry into any Session
  design: session reads keyed by (companyId, runId[, taskId]) with companyId mandatory and
  mismatch = NOT_FOUND (never CONFLICT-leak); no latest/global session lookups.

## 9. Provider session capabilities

`InvocationRequest` carries: modelId, messages, temperature, maxOutputTokens,
responseFormat, tools, traceId (correlation only), signal. NO sessionId /
conversationId / previousResponseId / threadId / resume token / provider state handle. No
adapter keeps internal conversation state (only in-process deterministic fakes exist).
Classification: nothing to classify — there is NO provider-side session state in CompanyOS
today. The architecture is therefore free to stay provider-neutral; any future
provider-specific resume handle may only ever be adapter METADATA (recorded on the
execution/session entry), never the Session identity or a structural dependency.

## 10. Restart analysis

| Role | After process exit → fresh composeCoreServices |
|---|---|
| Supervisor | **FULLY RECONSTRUCTIBLE** — every turn rebuilds from Goal/run/task/review/validation/decision stores; decisions replay by permanent identity; T18-08 real-process tests prove it end to end. Lost: model rationale beyond decision summaries (bounded, deliberate). |
| Developer | **PARTIALLY RECONSTRUCTIBLE** — the engine's task state and stage outputs (Task.outputs, artifacts) survive; but the Developer's own working context (what it was doing mid-task, its plan) never existed anywhere: today's developer context is rebuilt from a nearly-empty skeleton, so "reconstruction" is trivially complete yet informationally empty. For a real multi-turn worker it would be NOT RECONSTRUCTIBLE without a session. |
| Reviewer | **FULLY RECONSTRUCTIBLE** (stateless per review round: findings are durable artifacts; the next review round is a fresh turn by design). |
| QA | **FULLY RECONSTRUCTIBLE** (validation batches durable; QA turn is stateless). |

## 11. Multi-turn need

- Supervisor: **STATE-RECONSTRUCTED TURN** (proven sufficient by Sprint 18; a transcript
  would add risk, not capability; bounded decision summaries already carry the gist).
- Developer: **MULTI-TURN SESSION** — a real coding worker iterates (explore→edit→verify)
  and needs its own working memory across attempts and across corrective rounds; this is
  the one role a Session is FOR.
- Reviewer: **STATE-RECONSTRUCTED TURN** (+ bounded prior-findings references) — each
  review must be an independent judgment; a reviewer conversation would bias it.
- QA: **STATE-RECONSTRUCTED TURN** — deterministic validators need no conversation.

## 12. Ownership options

- **A. one Session per Run per role**: simple; but a long run's Developer context grows
  unboundedly across unrelated tasks; corrective rounds blur into the same transcript;
  task switching drags stale context. Isolation/audit coarse.
- **B. one Session per Task per role**: natural boundary (task = unit of work); corrective
  child tasks get fresh sessions by default; bounded growth per task; clean handoff
  (session dies with task). Weakness: a Developer needing run-level background (goal,
  decisions) must re-read state anyway — which is exactly the frozen principle (state-
  reconstructed facts + session only for conversational residue).
- **C. one Session per AgentExecution chain**: ties sessions to execution mechanics;
  executions are per-attempt records, so "chain" is ill-defined without inventing a second
  execution grouping; bad fit.
- **D. hierarchical (Run Supervisor session + task-scoped worker children)**: adds a
  Supervisor session that §11 says is unnecessary, plus parent machinery for no user value.

**Recommendation: B (one Session per Task per role), with an optional `parentSessionId`
for lineage only.** Scores: isolation (per task, per role), restartability (task-scoped
durable state is small), corrective loops (fresh child session seeded by bounded handoff —
see §16), context growth (naturally bounded; compaction per task), task switching
(sessions never shared), auditability (session ↔ task ↔ run lineage is exact), tenant
safety (companyId+runId+taskId keys), handoff compatibility (task boundary IS the handoff
boundary). Not chosen for simplicity — chosen because the task is already the unit of
work, evidence, and corrective lineage in the authoritative model.

## 13. Session identity

Deterministic identity from immutable scope inputs only:
`sessionId = ses_<hash>(companyId, runId, taskId, roleKey, parentSessionId?)` — same
pattern as `supervisorDecisionIdOf`/`correctiveTaskIdOf` (hash-derived, tenant-first,
idempotent by construction). No model output, no display names, no generated UUIDs (a
generated id would make crash-replay mint a second session for the same scope). Open
question for the Boss: whether the corrective child task's role key should include the
lineage round (it should NOT — identity from scope, round is data).

## 14. Session ↔ AgentExecution / Task / Run

- **Session 1 → N AgentExecutions**: matches the runtime exactly (each turn = one
  execution). Session entries REFERENCE executionId; executions never reference sessions
  (no schema change to executions; the join lives in the session entry). AgentExecution
  remains the canonical record of an individual model execution — agreed, unchanged.
- **Session ↔ Task**: session lifecycle is INSIDE the task's life (created on first turn
  for that task+role; may be closed when the task reaches a terminal state) but NEVER
  drives it. Forbidden: "session completed → task DONE". Task completion keeps coming only
  through the trusted runtime/evidence path (engine, carrier, evidence applicator).
- **Session ↔ Run**: run is the ownership scope (tenant + audit parent). Sessions never
  outlive their run; run terminal states close them (bookkeeping only).

## 15. Storage options (compared; no schema change now)

- **Artifact-based storage** (session = run/task-owned artifact(s)): reuses CAS+permanent
  command identity; but artifacts are immutable blobs — append-only conversations would
  need one artifact per entry (query hell) or growing rewrite (CONFLICT on change); no
  ordering primitive; compaction = new artifact family. Truth duplication risk LOW;
  queryability POOR.
- **AgentExecution-derived reconstruction**: NO new storage at all — reconstruct context
  from durable decisions/outputs. This is exactly today's Supervisor model and §11 says it
  suffices for Supervisor/Reviewer/QA. For the Developer it CANNOT carry conversational
  residue (executions don't store prompts/outputs beyond resultRef) — insufficient alone,
  but it remains the primary mechanism for all BUSINESS facts.
- **New metadata table + context entry table**: two tables; clean queries; migration cost;
  more schema than V1 may need.
- **Single append-only session event table** (one row per entry kind: created/append/
  execution-attached/compacted/closed, with per-session ordinal + permanent command id):
  ONE migration, natural ordering (ordinal), idempotency via command id (the ledger/CAS
  pattern already proven), compaction = a checkpoint entry that supersedes a range, tenant
  columns companyId/runId/taskId, growth bounded by compaction checkpoints. Truth
  duplication: NONE if entries are references + bounded conversational text only.
- **Hybrid**: session event table + artifact for large blobs. More moving parts than V1
  needs.

**Recommendation: single append-only session event table** (+ the frozen reconstruct-from-
state principle for all business facts). Compaction writes a checkpoint entry; reads fold
entries after the last checkpoint. If the Boss rules "zero migrations in V1", fallback =
artifact-per-compaction-checkpoint with derived entries — workable but strictly worse on
queryability/ordering.

## 16. Corrective loop semantics

T0 → CHANGES → T1: **new child Session seeded from bounded previous context** (option 3).
Reason: T1 is a NEW task with its own lineage (T18-05 truth); reusing the T0 session
crosses task boundaries (contradicts ownership B) and drags stale reasoning; a bare new
session loses hard-won working knowledge. The seed = a bounded handoff projection of the
T0 session's authoritative outputs + a compacted summary of its conversational residue +
references to the canonical review findings that caused the correction. `parentSessionId`
records the lineage for audit only.

## 17. Reviewer repeat semantics

After corrective work, the Reviewer gets a **new isolated session** containing: the goal,
the task (T_n), acceptance criteria, the CHANGES-requested findings it must verify against
(durable refs — anti-amnesia without anchoring), and repository change evidence (when a
real provider exists). NOT its prior conversation (independence per round is the point),
NOT the developer transcript. This preserves the T18-04 anti-cherry-pick rule (latest
report is truth) while giving the reviewer its own prior findings as DATA.

## 18. Token budget

Current metadata: catalogue rows carry `contextWindow` + `maxOutputTokens`;
`InvocationRequest.maxOutputTokens` optional; provider returns `usage` (inputTokens,
outputTokens, cost); AgentExecution persists input/output usage; prompt-level
`maxOutputTokens` exists in PromptPlan. MISSING: pre-invocation input-size estimate (we
have character budgets — CONTEXT_LIMITS chars and supervisor maxContextBytes 16 KiB — but
no TOKEN estimate), no session-scoped cumulative budget, no ceiling comparison against
`contextWindow` before invoke. Recommendation: enforce in the SESSION/runtime layer BEFORE
`ProviderRegistry.invoke` — estimate = deterministic char→token heuristic (no model call),
compare against the pinned binding's catalogue `contextWindow` minus reserved output;
refuse fail-closed (`SESSION_TOKEN_BUDGET_EXCEEDED`) rather than truncate. Per-session
cumulative accounting rides the session entries (sum of recorded usage).

## 19. Context overflow (current behavior)

Core `buildAgentContext` VALIDATION_FAILED on any budget (objective 4 000 chars,
instructions 8 000, memoryView 20 000, decisionView 20 000, artifactRefs 200, etc.).
Supervisor: turn REFUSED over 16 KiB rendered context (explicit fail-closed, no silent
truncation). AgentRuntime: no retry on overflow. Provider: would error if the real request
exceeded limits (classification exists for provider failures). So today's behavior is
FAIL, never truncate/drop/retry. Keep fail-closed; compaction is the future remedy.

## 20. Compaction (V1 minimum)

Rule: `recent entries verbatim + bounded summary of older conversational entries +
references to canonical facts`. A compaction summary is DATA: it must not overwrite or
become Goal/Task/Decision/Review/Validation (asserted in the contract). Recommendation for
V1: **deterministic** compaction (drop/keep by entry category + ordinal window; summary =
structured roll-up of entry HEADERS, not model-generated prose) — no model call, no new
failure mode, reproducible; model-generated compaction deferred until a real provider
exists and is proven.

## 21. Handoff seam (future Structured Handoff)

Seam: `session.projectHandoff({companyId, sessionId, kind: 'work-package'}) → bounded,
explicit handoff input` — a projection composed of authoritative outputs (stage output,
artifacts, findings) + the compacted conversational summary, NEVER the raw transcript.
Reviewer sessions accept ONLY such explicit bounded inputs. Minimal API for T19-02+:
`openSession`, `appendEntry`, `attachExecution`, `projectHandoff` (read-only), `fold`
(read-only). No transcript export.

## 22. Parent/child

`parentSessionId` for lineage/audit ONLY (corrective chains). It must NOT imply task
ownership, workflow dependency, or authorization. No inheritance of context by default —
a child is seeded explicitly via the bounded handoff projection (§16).

## 23. Resume semantics

`resume` = **reconstruct session context for the NEXT AUTHORIZED AgentExecution**. It does
NOT resume task execution automatically, does not bypass the engine/loop, does not touch
run/task state. After restart, the session fold + state reconstruction together produce
the next turn's context — exactly what T18-08 proved for state, extended with the
conversational residue.

## 24. Session status

V1 needs only: `ACTIVE` / `COMPACTED` / `CLOSED` — and even these are DERIVABLE from the
entry log (compaction checkpoint exists; close entry exists). Recommendation: no separate
status column in V1; status is a projection. Avoids a second lifecycle machine entirely.

## 25. Durability

Must survive restart: session identity + scope (derivable from the deterministic id),
ordered conversational entries, compaction checkpoints, token accounting (derivable by
summing referenced executions' usage — store per-entry cumulative estimate instead if the
Boss prefers no aggregation), parent relation. Can remain derived: all business facts
(re-read from stores), status, handoff projections (pure functions of entries + state).

## 26. Ordering

Never `createdAt` alone. Recommendation: **per-session monotonic ordinal** assigned by the
append seam (max existing ordinal + 1 inside the write UoW), plus the entry's permanent
command id for idempotent replay. Deterministic, collision-free under the serialized
writer, and compaction ranges are ordinals.

## 27. Idempotency (permanent identities)

Same hash pattern as Sprint 18: `session created` = deterministic session id (§13);
`context append` = `commandId = ses-entry:<sessionId>:<ordinal>:<kindHash>`;
`execution attachment` = `ses-exec:<sessionId>:<executionId>`;
`compaction result` = `ses-compact:<sessionId>:<throughOrdinal>`;
`handoff attachment` = `ses-handoff:<sessionId>:<targetSessionId>`. All dedupe by command
identity; replays converge (the proven decision-sink pattern).

## 28. Context security

Audit: prompts today carry NO secrets — provider secrets live in the vault and are only
redaction-compared (`redactSecrets` over every audit payload; `knownSecrets` never enters
prompts); tool descriptors carry no authority lists or secrets ("no adapter reference, no
authority list, no secret ever enters the prompt"). Session design must preserve: entries
store the RENDERED seats (bounded), never vault handles; repository credentials never
enter entries; audit payloads pass the same redaction; env vars are never context input.
V1 redaction boundary: the session append seam validates entries with the same
character/shape budgets as `buildAgentContext` and applies `redactSecrets` before persist.

## 29. Prompt-injection boundary

Frozen: session content = data/context; session content ≠ authority. No model-produced
session text may grant authority, change risk policy, register tools, change RunSnapshot
or WorkflowVersion, or bypass ToolRegistry — structurally guaranteed today (models are
tool-less; authority decisions are code seams), and the Session runtime must add NO path
from entry text to any of those seams. Enforced by: entries are inert rows; the only
consumers are prompt seats.

## 30. Real provider gap (recorded)

User-facing production composition still has NO real provider/executor integration — only
the deterministic mock/fake providers. Sprint 19 does NOT change that. The recommended
architecture assumes NO provider session ids (OpenAI conversations / Anthropic threads /
ZCode sessions / DeepSeek harness sessions). Provider-specific resume handles, if ever
adopted, are adapter metadata on the entry — never identity.

## 31. Gap board

```
SESSION_RUNTIME_EXISTS         OPEN   (no session runtime exists — recon only)
SESSION_DURABILITY             OPEN   (conversational residue is not persisted anywhere)
SESSION_RESTART                PARTIAL (state reconstruction CLOSED by T18-08; conversational residue NOT reconstructible)
SESSION_ROLE_ISOLATION         CLOSED-today-by-absence (no shared context state exists to leak; must be re-proven once sessions exist)
SESSION_TENANT_ISOLATION       CLOSED at sources (all readers company-scoped); session store not yet applicable
SESSION_TASK_ISOLATION         CLOSED-today-by-absence (contexts built per call, run/task-scoped reads)
SESSION_PARENT_CHILD           OPEN   (no parent/child context lineage exists)
SESSION_TOKEN_BUDGET           OPEN   (no pre-invoke token ceiling; char budgets only; usage persisted post-hoc)
SESSION_CONTEXT_OVERFLOW       CLOSED as fail-closed (Core budgets + supervisor 16 KiB refusal; no truncation) — re-prove for session folds
SESSION_COMPACTION             OPEN   (none; bounded views only)
SESSION_HANDOFF_SEAM           OPEN   (previousHandoff seat exists in Core context; no projection producer)
SESSION_PROVIDER_NEUTRALITY    CLOSED (contracts carry no session ids; nothing provider-specific to be neutral about — must stay so)
SESSION_SECRET_BOUNDARY        CLOSED at sources (redaction + vault separation); session store not yet applicable
SESSION_TRUTH_SEPARATION       CLOSED today (sessions don't exist; state reconstruction only) — must be preserved by design
```

## 32. Recommended V1 Session contract (for Boss ruling)

- **Purpose**: bounded, durable, per-(task,role) conversational context container for
  model turns; business facts are ALWAYS re-read from authoritative stores.
- **Owner/scope**: (companyId, runId, taskId, roleKey); optional parentSessionId.
- **Identity**: deterministic `ses_<hash32>(companyId|runId|taskId|roleKey[|parent])` —
  idempotent, tenant-first, no generated ids.
- **↔ Run**: ownership/audit scope; closed (bookkeeping) when the run reaches a terminal
  state; never drives run state.
- **↔ Task**: lives inside the task; closed when the task is terminal; NEVER implies task
  completion. Forbidden: session-completed ⇒ Task DONE.
- **↔ AgentExecution**: Session 1→N executions; entries reference executionId; executions
  unchanged; AgentExecution stays the canonical per-invocation record.
- **↔ Provider**: none. No provider session handles in identity or structure; optional
  adapter metadata on entries only.
- **Durable fields**: sessionId, companyId, runId, taskId, roleKey, parentSessionId,
  createdAt, closedAt (derived-safe), per-entry: ordinal, kind, commandId, payloadRef/
  bounded text, executionId?, tokenEstimate/cumulative.
- **Entry categories**: `created`, `turn-input` (rendered seats digest + refs), `turn-
  output-summary` (bounded), `execution-attached`, `compaction-checkpoint`, `handoff-
  attached`, `closed`. References to canonical state (goal artifact, task, decision,
  artifact, review, validation, tool invocation, repository anchor) are REFS; the only
  copied data is conversational residue with no canonical source.
- **Ordering**: per-session ordinal in the append UoW + commandId idempotency.
- **Resume**: reconstruct context for the next AUTHORIZED execution; no auto-execution.
- **Token budget**: deterministic pre-invoke estimate vs the pinned binding's
  contextWindow; fail-closed; per-session cumulative accounting.
- **Compaction**: deterministic V1 (category+window roll-up); summary is data, never
  truth; checkpoints are ordinal ranges.
- **Parent/child**: lineage only; explicit bounded seeding via handoff projection.
- **Corrective**: fresh child session per corrective task, seeded from the parent's
  bounded projection.
- **Handoff seam**: `projectHandoff` — explicit bounded input; never raw transcripts.
- **Tenant isolation**: companyId mandatory on every read/write; mismatch = NOT_FOUND.
- **Security**: entry redaction + budgets at the append seam; entries are inert data; no
  path from entry text to authority/policy/tools/snapshot.
- **What Session explicitly cannot do**: complete tasks; make decisions; replace evidence;
  bypass ToolRegistry/RiskPolicy; mutate Run/RunSnapshot/WorkflowVersion; outlive its run;
  carry cross-run/cross-project/user-preference/semantic memory; auto-resume execution;
  become a scheduler or retry machine.

## 33. Risks if implemented incorrectly

Session becomes a shadow task machine; entries drift into business truth (decisions-by-
transcript); compaction summaries overwrite facts; provider session ids leak into identity
(lock-in + restart fragility); unbounded growth (no compaction) DOSes the context budget;
tenant leaks via run-scoped-only keys; prompt-injection via stored model text reaching a
seam; duplicate sessions from generated ids breaking crash replay.

## 34. Required T19-02 scope (if Boss approves)

Session identity + append-only entry store (one migration: the only schema change, pending
ruling); append/attach/compaction/close seams with permanent command ids; fold reader;
deterministic token-budget gate before invoke; projectHandoff (read-only); corrective child
seeding; wiring into `composedStageHandlers` (Developer role first) with the context-
projection hygiene fixes (company.id, workflowVersion placeholders); role isolation tests;
tenant tests; restart tests; overflow fail-closed tests.

## 35. Deferred beyond Sprint 19

Model-generated compaction; real provider integration (handoff item 6); Structured Handoff
full implementation; Planning; long-term memory (explicitly excluded: cross-project,
cross-run, user-preference, semantic vector, learned facts, agent personality); remote/
parallel agents; full Secrets/Config sprint (only the session redaction boundary is V1).
