# Agent Executor Integration Guide

**Version:** 1.0  
**Sprint:** Agentic Capability Validation  
**Purpose:** Define how external agentic executors (DSH, Codex, ZCode, other agents) integrate with CompanyOS

---

## Core Principle

**CompanyOS owns canonical truth. Agents are subordinate execution providers.**

External agents integrate with CompanyOS by implementing the **existing ExecutorProvider contract**. They do NOT require:

- New Agent Interface
- New Agent Runtime
- New Agent Truth system
- New Agent Task model
- New Agent Workflow model

---

## What CompanyOS ALWAYS Owns

CompanyOS is the **single source of truth** for:

1. **Goal** — user intent
2. **Plan** — structured decomposition
3. **Workflow** — versioned execution graph
4. **Task** — canonical work unit
5. **ExecutionAttempt** — attempt lifecycle
6. **Validation** — correctness assessment
7. **Artifact** — canonical produced work
8. **Evidence** — proof of execution
9. **Settlement** — final canonical state

**Agents NEVER own these.** They are derived inputs or subordinate outputs only.

---

## What Agents RECEIVE (Input)

When an agent executes through CompanyOS, it RECEIVES:

### ExecutorExecutionRequest

```typescript
interface ExecutorExecutionRequest {
  // Canonical identities (agent cannot choose these)
  readonly companyId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly roleId: string;
  readonly taskKind: string;

  // Work — the AGENTIC WORK ENVELOPE (see next section)
  readonly work: {
    readonly objective: string;
    readonly memoryView?: readonly string[];
    readonly artifactRefs?: readonly string[];
    readonly taskInputs?: Readonly<Record<string, unknown>>;
    readonly acceptanceCriteria?: readonly {
      readonly criterionId: string;
      readonly requirement: string;
    }[];
    readonly goalStructured?: Readonly<Record<string, unknown>>;
  };

  // Workspace (trusted root validated by CompanyOS)
  readonly workspace: {
    readonly cwd: string;
    readonly root?: string;
  } | null;

  // Required capabilities (checked before dispatch)
  readonly requiredCapabilities: readonly string[];

  // Cancellation/timeout
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
```

**Key constraints:**

- Agent receives Task identity (cannot mint new Tasks)
- Agent receives Attempt identity (cannot create parallel attempts)
- Agent receives workspace authority (cannot choose trusted root)
- Agent receives objective (natural language Task description)
- Agent receives context projection (read-only memory/artifacts)

### The Agentic Work Envelope (work projection, frozen)

`work` IS the Agentic Work Envelope: the bounded, derived projection of ONE task's
canonical business semantics. It is NOT a new durable entity — it is the existing
**WorkPackage projection** (Sprint 20 / T20-06, the canonical executor work
projection) mapped onto `ExecutorWorkInput` by the composition. Every field is a
byte-exact or clearly-labeled derivation; nothing outside the projection (renderer
input, model rewrites, provider guesses) can enter it.

| Envelope item | Canonical source | Field |
|---|---|---|
| A. Canonical identity | company / run / task / attempt / dispatch | `companyId` `runId` `taskId` `attemptId` `dispatchKey` |
| B. Objective | the compiled PlanItem objective (byte-exact, pinned node config); fallback: the run-owned canonical Goal | `work.objective` |
| C. Acceptance criteria | the pinned `acceptanceCriteria` of the node (byte-exact copies) | `work.acceptanceCriteria` |
| D. Structured inputs | the canonical immutable `Task.inputs` (per-task trusted creation data) | `work.taskInputs` |
| D2. Goal structured constraints | the run-owned canonical goal's bounded structured payload (human-supplied at `goal.create`: resource lists, rules/parameters, output requirements; 16 KiB) | `work.goalStructured` |
| E. Workspace | the preflight-proven trusted cwd/root | `workspace` |
| F. Role | the task's pinned `taskProfile.roleId` (the SAME seat the ExecutionAttempt records) | `roleId` |
| G. Required capabilities | deployment-static capability set for the task kind | `requiredCapabilities` |
| H. Input artifact references | pinned-DAG predecessor envelope `artifactRefs` (read-only) — the predecessor's CANONICAL materialized output (`structured.artifactContent` → Sprint-13 artifact service) | `work.artifactRefs` |
| I. Relevant context | bounded deterministic render: goal + criteria + input references | `work.memoryView` |
| J. Authority / restrictions | structural: the provider interface exposes NO state-mutation surface; dispatch authorization provenance (composition policy or a run approval) is proven BEFORE the call | (contract shape itself) |

Minimal-context law: the envelope carries what THIS task needs — never run history,
sibling tasks, sessions, or cross-company state. Renders are hard-bounded by the
composition (line count + character budget + reference count).

**Knowing the standard is not owning it.** An agent may self-check against
`acceptanceCriteria`, but Validation/Settlement — CompanyOS alone — decides whether
the criteria are met.

---

## What Agents RETURN (Output)

Agents return **ExecutorProviderOutcome** — NOT canonical state.

### ExecutorProviderOutcome

```typescript
type ExecutorProviderOutcome =
  | {
      kind: 'succeeded';
      exitCode: number;
      stdoutText: string;
      structured?: unknown; // Artifact/Evidence candidates
      startedAt: string;
      finishedAt: string;
      providerSessionId?: string;
    }
  | {
      kind: 'provider-failed';
      exitCode: number;
      stdoutText: string;
      stderrText: string;
      reasonCode?: string;
      providerSessionId?: string;
    }
  | {
      kind: 'timeout';
      terminationProven: boolean;
      providerSessionId?: string;
    }
  | {
      kind: 'cancelled';
      terminationProven: boolean;
      providerSessionId?: string;
    }
  | {
      kind: 'transport-failed';
      reasonCode: string;
      detail: string;
      providerSessionId?: string;
    };
```

**Key constraints:**

- Agent returns execution result (NOT Task status)
- Agent returns diagnostic text (NOT canonical log)
- Agent returns structured payload (NOT canonical Artifact)
- Agent returns provider session ID (NOT CompanyOS session)

**CompanyOS settlement logic decides:**

- Does this outcome mean Task success?
- Should this create an Artifact?
- Should this trigger Validation?
- Should this advance Workflow?

---

## What Agents CAN Do

Agents have wide latitude for **internal execution**:

✅ **Reasoning**
- Analyze objective
- Break down steps
- Make decisions
- Plan approach

✅ **Tool Usage**
- Read files (within workspace)
- Write files (within workspace)
- Execute processes (with authority)
- Call APIs
- Search data
- Transform content

✅ **Internal State**
- Track reasoning phases
- Record tool calls
- Store observations
- Maintain context

✅ **Result Generation**
- Produce text output
- Generate files
- Create structured data
- Build reports

✅ **Session Management**
- Maintain internal session identity
- Continue work across invocations (if capable)
- Recover from interruption (if capable)

**But:** All of this is **internal to the agent**. CompanyOS does not depend on agent internal state.

---

## What Agents CANNOT Do

Agents have strict boundaries for **canonical truth**:

❌ **Modify CompanyOS State Directly**
- Cannot update Task status
- Cannot settle ExecutionAttempt
- Cannot create/modify Run
- Cannot change Workflow
- Cannot modify Goal/Plan

❌ **Create Second Truth Systems**
- Cannot create agent-owned Task model
- Cannot create agent-owned Workflow
- Cannot create agent-owned Artifact truth
- Cannot create agent-owned Validation system
- Cannot create agent-owned Settlement logic

❌ **Bypass CompanyOS Authority**
- Cannot choose trusted workspace root
- Cannot select other Tasks to run
- Cannot approve Decisions
- Cannot resolve Findings
- Cannot pass Validation

❌ **Judge Canonical Success**
- Cannot mark Task as complete
- Cannot mark Run as finished
- Cannot declare Outcome delivered
- Cannot validate own work

❌ **Claim Universal Capability**
- Cannot silently degrade when capability missing
- Cannot pretend to support unsupported features
- Cannot substitute mock behavior for real capability

---

## Integration Pattern

### Step 1: Implement ExecutorProvider

```typescript
import {
  type ExecutorProvider,
  type ExecutorProviderDescriptor,
  type ExecutorExecutionRequest,
  type ExecutorProviderOutcome,
} from '@companyos/engine';

const myAgent: ExecutorProvider = {
  descriptor: {
    providerKey: 'my-agent',
    capabilities: [
      'cancellation',
      'timeout',
      'structured-output',
      'working-directory',
      'external-session-identity',
      // List ONLY what you truly support
    ],
  },

  async start(
    request: ExecutorExecutionRequest,
  ): Promise<ExecutorProviderOutcome> {
    // 1. Analyze request.work.objective
    // 2. Do agent reasoning
    // 3. Call agent tools
    // 4. Generate result
    // 5. Return ExecutorProviderOutcome

    return {
      kind: 'succeeded',
      exitCode: 0,
      stdoutText: 'Agent completed work...',
      structured: {
        // Artifact candidates
      },
      startedAt: '...',
      finishedAt: '...',
      providerSessionId: 'agent-session-123',
    };
  },
};
```

### Step 2: Register with CompanyOS

```typescript
import { createExecutorProviderRegistry } from '@companyos/engine';

const registry = createExecutorProviderRegistry([
  myAgent,
  // other providers
]);
```

### Step 3: CompanyOS Routes Work

CompanyOS routing decides:

1. What capabilities does this Task require?
2. Which providers support those capabilities?
3. Which available provider should execute?

Then dispatches to your agent via `start(request)`.

### Step 4: Your Agent Executes

Inside `start()`:

1. Receive ExecutorExecutionRequest
2. Analyze `request.work.objective`
3. Reason about approach
4. Use tools within `request.workspace`
5. Generate output
6. Return ExecutorProviderOutcome

### Step 5: CompanyOS Settles

CompanyOS settlement logic:

1. Receives ExecutorProviderOutcome
2. Validates result
3. Updates ExecutionAttempt
4. Creates Artifacts (if appropriate)
5. Records Evidence
6. Projects Observation
7. Advances Workflow (if appropriate)

**Your agent does NOT do these steps. CompanyOS owns them.**

---

## Capability Declaration

Agents declare capabilities **honestly**:

### Typical Agentic Capabilities

```typescript
capabilities: [
  'cancellation',        // Can respond to abort signal
  'timeout',             // Can respect timeout
  'structured-output',   // Can return structured payload
  'working-directory',   // Can work in provided workspace
  'external-session-identity', // Has own session ID
]
```

### Capabilities Agentic Providers Typically Do NOT Support

```typescript
// These are deterministic/native execution features:
'provider-idempotency',      // Reasoning is non-deterministic
'same-invocation-recovery',  // Internal state is opaque
'status-query',              // Progress tracking not exposed
```

**This is CORRECT.** Agentic execution is different from deterministic execution. CompanyOS routing accounts for this.

---

## Internal State vs. Canonical State

### Agent Internal State (Ephemeral, Opaque)

Examples:

- Reasoning phases ("analyzing", "planning", "executing", "synthesizing")
- Tool call history
- Observations
- Internal decisions
- Intermediate results

**Status:** CompanyOS does NOT save or depend on this.

**Lifetime:** Lives only during `start()` execution. Discarded after return.

### CompanyOS Canonical State (Durable, Authoritative)

Examples:

- Task status (pending/active/completed/failed)
- ExecutionAttempt lifecycle
- Artifact
- Evidence
- Settlement
- Validation
- Observation

**Status:** CompanyOS OWNS and PERSISTS this.

**Lifetime:** Durable across restarts, durable across invocations.

---

## Session Semantics

### Agent Provider Session

Agents may have internal session identity:

```typescript
return {
  kind: 'succeeded',
  providerSessionId: 'my-agent-session-xyz',
  // ...
};
```

**Use:** Debugging, correlation, agent-internal continuity.

**Not used for:** CompanyOS Task/Run/Attempt identity.

### CompanyOS Session

CompanyOS has separate conversational Session for:

- Developer multi-turn interaction
- Context accumulation
- Model reasoning history

**These are different.** Agent provider session ≠ CompanyOS Session.

---

## Artifact & Evidence

### How Agents Produce Artifacts

Agents return **artifact candidates** in structured payload:

```typescript
return {
  kind: 'succeeded',
  structured: {
    artifactCandidates: [
      { path: '/workspace/output.txt', description: '...' },
      { path: '/workspace/report.md', description: '...' },
    ],
  },
  // ...
};
```

**CompanyOS settlement logic:**

1. Receives artifact candidates
2. Validates workspace boundaries
3. Verifies file existence
4. Creates canonical Artifact records
5. Links to ExecutionAttempt/Task/Run

**Agent does NOT create Artifacts directly.**

### How Agents Produce Evidence

Agents return diagnostic text + structured payload:

```typescript
return {
  kind: 'succeeded',
  stdoutText: 'Agent completed analysis. Found 3 issues...',
  structured: {
    findings: [...],
    metrics: {...},
  },
  // ...
};
```

**CompanyOS Evidence system:**

1. Receives execution outcome
2. Preserves provider output
3. Links to ExecutionAttempt
4. Makes available for Validation

**Agent does NOT create Evidence records directly.**

---

## Validation & Settlement

### Agent CANNOT Validate Itself

Agents return execution result. They do NOT:

- Mark Task as validated
- Resolve Findings
- Pass Quality checks
- Declare work complete

**CompanyOS Validation system owns:**

- Calling validators
- Recording validation results
- Triggering corrective loops
- Blocking Run on unresolved issues

### Agent CANNOT Settle Task

Agents return ExecutorProviderOutcome. They do NOT:

- Mark Task as done
- Advance Workflow
- Trigger next Task
- Complete Run

**CompanyOS Settlement logic owns:**

- Interpreting provider outcome
- Updating ExecutionAttempt status
- Advancing Task lifecycle
- Progressing Run

---

## Error Handling

### Agent Failures

Agents can return failure:

```typescript
return {
  kind: 'provider-failed',
  exitCode: 1,
  stdoutText: 'Agent output...',
  stderrText: 'Error details...',
  reasonCode: 'AGENT_REASONING_FAILED',
};
```

**CompanyOS response:**

1. Records failed outcome
2. Preserves diagnostic text
3. Updates ExecutionAttempt status
4. Applies retry policy (if appropriate)
5. Notifies user (if appropriate)

### Agent Uncertainty

Agents may not always succeed deterministically. Examples:

- Model reasoning produces unusable output
- Tool calls fail
- Workspace constraints violated
- External services unavailable

**Agents should:**

- Return honest failure outcome
- Provide diagnostic detail
- Use appropriate reasonCode

**Agents should NOT:**

- Silently succeed with fake result
- Retry indefinitely without bounds
- Hide failure in success outcome

---

## Restart & Recovery

### CompanyOS Restart

When CompanyOS restarts:

1. Canonical state is durable
2. ExecutionAttempt status is preserved
3. Provider dispatches are recovered
4. Agent may be re-invoked (if attempt incomplete)

### Agent Session Continuity

If agent supports `external-session-identity`:

- Agent can correlate new invocation with old session
- Agent can resume work (internal decision)
- Agent returns same providerSessionId

**But:** CompanyOS does NOT depend on agent resuming. If agent restarts work from scratch, that is valid too.

---

## Anti-Patterns

### ❌ Agent Creates Second Task System

**Wrong:**

```typescript
// Inside agent
const agentTasks = [
  { id: 'agent-task-1', status: 'completed' },
  { id: 'agent-task-2', status: 'active' },
];
```

**Why wrong:** CompanyOS Task is canonical. Agent-owned task system creates conflicting truth.

**Right:** Agent works on ONE CompanyOS Task at a time. Agent returns ONE outcome per invocation.

### ❌ Agent Judges Success

**Wrong:**

```typescript
// Inside agent
database.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(taskId);
```

**Why wrong:** Agent bypasses CompanyOS settlement. Canonical state corrupted.

**Right:** Agent returns `{ kind: 'succeeded', ... }`. CompanyOS settlement decides if Task is done.

### ❌ Agent Creates Artifacts Directly

**Wrong:**

```typescript
// Inside agent
database.prepare(`INSERT INTO artifacts (...) VALUES (...)`).run(...);
```

**Why wrong:** Artifact is canonical CompanyOS truth. Agent cannot create it directly.

**Right:** Agent returns artifact candidates in structured payload. CompanyOS canonicalizes them.

### ❌ Agent Depends on CompanyOS Internals

**Wrong:**

```typescript
// Inside agent
import { Task, Run, Workflow } from '@companyos/engine';
const task = new Task({ id: '...', status: 'completed' });
```

**Why wrong:** Agent couples to CompanyOS implementation. Violates boundary.

**Right:** Agent receives ExecutorExecutionRequest. Agent returns ExecutorProviderOutcome. Agent depends ONLY on contract types.

---

## Testing Your Agent Integration

### Step 1: Implement ExecutorProvider

Create provider that implements contract.

### Step 2: Unit Test Provider

Test `start()` method in isolation:

```typescript
const outcome = await provider.start(mockRequest);
expect(outcome.kind).toBe('succeeded');
```

### Step 3: Integration Test

Run through full CompanyOS chain:

```typescript
// Create Goal
// Create Plan
// Create Run
// Dispatch to your agent
// Verify Settlement
// Verify Artifact
// Verify Observation
```

See `apps/desktop/tests/agentic-executor-integration.test.ts` for example.

### Step 4: Verify Boundaries

Confirm agent does NOT:

- Create second truth
- Bypass settlement
- Modify canonical state directly

---

## Real-World Examples

### Future DSH Integration

DeepSeek Harness would:

1. Implement ExecutorProvider
2. Receive CompanyOS Task
3. Run DSH agent internally
4. Return ExecutorProviderOutcome
5. Let CompanyOS settle

No DSH-specific Core logic. DSH is ONE provider among many.

### Future Codex Integration

Codex would:

1. Implement ExecutorProvider
2. Receive CompanyOS Task
3. Run Codex agent internally
4. Return ExecutorProviderOutcome
5. Let CompanyOS settle

No Codex-specific Core logic. Codex is ONE provider among many.

### Future ZCode Integration

ZCode would:

1. Implement ExecutorProvider
2. Receive CompanyOS Task
3. Run ZCode agent internally
4. Return ExecutorProviderOutcome
5. Let CompanyOS settle

No ZCode-specific Core logic. ZCode is ONE provider among many.

**Key insight:** All agents integrate the same way. CompanyOS Core remains vendor-neutral.

---

## Summary

### Agent Integration Checklist

✅ Implement ExecutorProvider contract  
✅ Declare capabilities honestly  
✅ Receive ExecutorExecutionRequest  
✅ Return ExecutorProviderOutcome  
✅ Let CompanyOS own canonical truth  
✅ Let CompanyOS settle result  
✅ Let CompanyOS create Artifacts  
✅ Let CompanyOS validate work  
✅ Test through full chain  
✅ Verify boundary preservation  

❌ Do NOT create Agent Interface  
❌ Do NOT create Agent Runtime  
❌ Do NOT create Agent Truth  
❌ Do NOT create Agent Task model  
❌ Do NOT bypass CompanyOS flow  
❌ Do NOT judge success yourself  
❌ Do NOT create Artifacts directly  
❌ Do NOT modify canonical state  

---

## References

- `packages/engine/src/executor/executor-provider.ts` — the canonical contract (engine ships CONTRACTS only)
- `apps/desktop/tests/support/mock-agent-executor-provider.ts` — the mock agent (TEST INFRASTRUCTURE: deterministic, timer/clock injected, lives outside the engine ring by the engine boundary law)
- `apps/desktop/tests/agentic-executor-integration.test.ts` — contract + registry integration test pattern
- `apps/desktop/tests/agentic-executor-boundary-guards.test.ts` — boundary-law guard tests
- `tests/agentic/agent-executor-e2e.test.ts` — the FULL production-path chain proof (Goal → Plan → pinned Run → Task → WorkPackage → Work Envelope → agent provider → settlement → artifacts → work package → handoff → observation) with REAL business semantics, plus the identical-envelope swap proof (agent vs deterministic provider)
- `tests/agentic/work-envelope-guards.test.ts` — source-level guards: the composition wires the canonical envelope; no pseudo provider role; the taskKind fallback stays last-resort-only; no agent-specific second Task DTO/authority store; artifact refs enter only via the canonical materialization seam
- `tests/agentic/authority-boundary-negatives.test.ts` — mechanical fail-closed proofs: capability escalation refused before invocation; no trusted boundary = no execution; provider return values cannot forge authority or widen the next envelope; artifact references are run-scoped
- `docs/architecture/EXECUTOR_ECOSYSTEM_MODEL.md` — execution philosophy
- `docs/architecture/EXECUTION_CAPABILITY_MODEL.md` — capability model

## Effective Execution Restrictions (Final Readiness Gate audit verdict)

Source-traced audit of what CompanyOS mechanically KNOWS and ENFORCES before a
provider runs (the Sprint25 ordered preflight + adapter mechanics):

| Permission fact (repo-native semantics) | Owner | Enforced how |
|---|---|---|
| Typed provider configuration valid + fingerprinted (`scfg_`) | composition registration | preflight stage `config-valid`; drift on resume fails closed |
| Secret refs are POINTERs; no secret material in config/env/argv | SecretRef law (S25) | preflight `secret-refs-resolvable` + `assertNoSecretMaterial`; env is allowlist-only (ARCH-033) |
| Trusted workspace root (canonical, reparse-checked) | application-opened workspace | preflight `workspace-trusted`; none ⇒ no execution |
| Execution cwd contained in the root (component boundary) | S25 | preflight `cwd-allowed`; declared write targets contained (`assertWritePathWithinRoot`) |
| Required capabilities ⊆ advertised (closed vocabulary) | dispatch negotiation | fail-loud BEFORE invocation + preflight re-assert |
| Authorization provenance present | composition policy OR an APPROVED run approval | preflight `authorization-present`; absent ⇒ refusal |
| Process execution surface | deployment data (native operations table / dsh typed config) | literal argv, `shell:false`, typed `taskInputs` as single data args (ARCH-039: prose never executable) |
| Output bounds | process provider | bounded stream capture; overflow kills the tree |

**Verdict: an explicit per-task permission projection is NOT_REQUIRED.** The
provider request carries the boundary facts it needs (`workspace`, `requiredCapabilities`);
everything else is enforced UPSTREAM of the provider, mechanically. There is NO
canonical read/write/network grant dimension anywhere in the repository — inventing
one would create a second authority system, which this architecture forbids.

**Honest limit (do not paper over):** CompanyOS constrains WHAT IT LAUNCHES (cwd,
env, argv, secrets, capabilities) — it does not OS-sandbox a running process, and
the S25 laws explicitly forbid claiming otherwise (no sandbox claims; TOCTOU
disclosed). A provider that is a process can, like any process, do what the OS user
may do. That is why providers are DEPLOYMENT-TRUSTED adapters (registered by the
operator), never model- or task-chosen strangers.

## Agent Tool Permission Translation (the adapter's duty)

A future real agent adapter (DSH/Codex/self-built) whose runtime has MORE tools
than CompanyOS states (shell, git, browser, network, subagents…) MUST translate the
real CompanyOS restrictions into ACTUAL runtime tool permissions — mechanically,
never by prompt:

- `workspace.{cwd,root}` → confine the runtime's file tools to the root (cwd +
  tool path config); refuse paths outside.
- `requiredCapabilities` + the provider's own advertised set → enable ONLY the
  tools the capability set covers; a tool with no covering capability stays off.
- Typed provider config (env allowlist, argv literals) → the runtime's env/argv
  construction, unchanged.
- Anything the runtime additionally restricts by policy (e.g. network OFF because
  the adapter's deployment profile says so) is the ADAPTER's own enforcement
  duty — CompanyOS states what it knows; the adapter may only TIGHTEN, never widen.

An adapter that cannot enforce a restriction mechanically must not advertise the
capability that implies it.

## Artifact Input Flow (cross-task propagation)

```
Task A (provider) declares structured.artifactContent (frozen convention)
  → dispatch materializes via the ONE Sprint-13 artifact service
     (kind companyos:executor-output, idempotent command provider-output:run:task:attempt)
  → settled stage-output envelope carries artifactRefs = [art_…]
  → Task B's WorkPackage dependencies[].artifactRefs (pinned-DAG projection)
  → Task B's ExecutorWorkInput.work.artifactRefs + memoryView line (read-only REFERENCES)
  → Task B's provider reads CONTENT only through the canonical artifact read seam
```

References only — content never rides the envelope (no context bloat, no
cross-task/company leakage; the projection is run-scoped and company-checked).

## Structured Input Ownership

Two DIFFERENT canonical owners, deliberately not merged:

- **Run-level machine-readable input** = `RunGoal.structured` (human-supplied at
  `goal.create`, 16 KiB bounded, rides the run-goal artifact, byte-exact to the
  provider as `work.goalStructured`). A model never authors it (ARCH-039).
- **Task-level typed creation data** = `Task.inputs` (Native Execution §5). For
  goal-work baseline tasks it is `{}` BY DESIGN: per-item trusted data does not
  exist at compile time; corrective/reassessment lineage and native operation
  inputs own their keys there.

---
## Verified Facts About the Current Production Path (do not re-discover)

These were verified by source trace + production-path E2E in the Agentic Work Package
Contract closeout; the source-level guards in `tests/agentic/work-envelope-guards.test.ts`
fail loudly if the wiring drifts.

1. **What an agent receives as `work.objective`**: the BYTE-EXACT compiled PlanItem
   objective (frozen in the pinned WorkflowVersion node config); when a node carries no
   plan-item objective, the run-owned canonical Goal objective stands in. The synthetic
   `Execute task kind <taskKind>.` string survives ONLY as the transport's last-resort
   defense for narrow unwired compositions — with the envelope seam wired, a projection
   failure fails the dispatch closed rather than degrading to the label. `taskKind` is a
   routing identity, never a business objective.
2. **The execution seat**: the dispatch hands the provider the TASK's canonical pinned
   role (`taskProfile.roleId`, e.g. `rol.worker` for goal work) — the SAME seat the
   canonical ExecutionAttempt records. There is no `rol.provider` pseudo-role anywhere:
   provider identity travels as `providerKey` only, so Role can never hard-bind a vendor.
3. **Provider selection is a routing decision, not truth**: V1 selection =
   deployment `providerRoutes` (taskKind → providerKey) + registry availability +
   explicit defaults. The result lands on the dispatch row (`provider_key`) — it is not
   Role truth, not Task truth, not Workflow truth.
4. **Multiple plan items**: one plan item compiles to exactly ONE work Task with ONE
   ExecutionAttempt and ONE provider dispatch. An agent serving N items sees N separate
   `start()` calls — never one call with a batch, never a provider-side queue.
5. **Cross-task artifact propagation is REAL**: a provider's declared
   `structured.artifactContent` is materialized through the ONE Sprint-13 artifact
   service and the canonical reference reaches downstream providers via the pinned-DAG
   dependency projection (`work.artifactRefs` + memoryView) — proven end-to-end by the
   Final Readiness E2E. `work.taskInputs` is `{}` for goal-work tasks (per-item typed
   data has no compile-time source — see Structured Input Ownership);
   corrective/reassessment tasks carry their canonical inputs there.
7. **Goal-work structured input classification**: SMALL_MAPPING_GAP, now closed — the
   canonical owner (`RunGoal.structured`, human-supplied) existed but was not
   projected; `goal.create` accepts it and the compiler carries it byte-same onto the
   execution run's goal, reaching providers as `work.goalStructured`.
6. **Timer and clock are the caller's**: the engine boundary bans engine-held timers,
   wall-clock reads and randomness. An in-process provider implementation receives the
   composition-armed timer seam; deterministic identity derives from canonical identities
   (e.g. `sha256` over `dispatchKey` + `attemptId`), never `Math.random`/`Date.now`.

---

**Version History:**

- 1.0 (2026-10-01): Initial version for Agentic Capability Validation Sprint
- 1.1 (2026-10-01): Agentic Work Package Contract closeout — the Work Envelope section (A–J canonical mapping), `acceptanceCriteria` on ExecutorWorkInput (additive optional), the fail-closed envelope seam, and the corrected production facts (real objective reaches the provider; the seat is the task's canonical role)
- 1.2 (2026-10-01): Final Readiness Gate — `goalStructured` transport (RunGoal.structured → provider, byte-exact); cross-task artifact propagation via the frozen `artifactContent` convention and the canonical materialization seam; the Effective Execution Restrictions audit (NOT_REQUIRED verdict + the honest no-sandbox limit); Agent Tool Permission Translation; Structured Input Ownership
