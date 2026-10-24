> Source of truth: .planning/CANONICAL_SPEC.md (RECONSTRUCTED — diff against 规划书 before Sprint 1)

# CompanyOS V1.1 — Formal State Machines

| Field | Value |
|---|---|
| Document | STATE_MACHINE.md — formal machines, guards, invariants, persistence mapping, error registry |
| Implementation | L1 全局执行态：`packages/core/src/domain/run-state.ts` ｜ L2 模板生命周期：`packages/core/src/lifecycle/machine.ts` ｜ L3 局部态：`packages/core/src/domain/{stage,task}.ts` 与各子机 |
| Conformance rule | L1 的 17 态来自规划书 §三十三（**非推导**）；L2 的 4 态来自规划书 §六/§七；本文档其余机器为 `[DERIVED]` 实现细节。三者分层见 ADR-0003，**禁止混用** |
| Machines | L1：1（`RunState`，17 态）｜ L2：1（`WorkflowTemplateLifecycle`，4 态）｜ L3：`StageState`、`TaskState`、`NodeExecutionState`、`HandoffState`、`ChangeProposalState`、`TemplateLockState` |
| Layering (ADR-0003) | **L1 = 执行推进（全局 17 态）**；**L2 = 模板/版本制度状态（4 态）**；**L3 = Task/Stage 与各子机局部态**。任何机器都不得跨层复用状态名 |

---

## 1. Notation and conventions

| Symbol | Meaning |
|---|---|
| `S → E → S'` | state, event, next state |
| **G:** | Guard — all conditions must hold or the machine raises the listed error and performs **no** write |
| **A:** | Action/effect performed inside the same transaction as the state write |
| **E:** | Emitted domain events (appended in the same transaction — outbox pattern) |
| `⊥` | No transition exists (illegal); the machine throws `ILLEGAL_TRANSITION` with the machine id and `(from, event)` in the payload |
| `absorbing` | Terminal state with no outgoing edges |
| `[DERIVED]` | Not literally in CANONICAL_SPEC; a design decision recorded here and in the ADR log |

**Global machine rules**

1. **Atomicity.** Guard failure ⇒ zero writes, zero events. State write + event append are one transaction.
2. **Determinism.** Guards evaluate in fixed order: (1) existence, (2) archived/terminal check, (3) lock overlay, (4) state-edge existence, (5) policy/authority, (6) payload validation. This order is normative so error codes are stable and testable.
3. **Idempotency key.** Every command carries an idempotency key; replay returns the original result and emits no second event (except the audit-only `*Replayed` channel).
4. **Clock.** `occurredAt` comes from the injected `Clock` port, never `Date.now()` (CANONICAL_SPEC §3.1).
5. **No implicit transitions.** Every edge below is explicitly enumerated; there is no `default:` branch that "does something reasonable".

---

## 2. Machine: `WorkflowTemplateLifecycle`

Canonical states, from CANONICAL_SPEC §2: `draft`, `published`, `deprecated`, `archived`.

### 2.1 States

| State | Meaning | Runs allowed? | Mutable? | Terminal? |
|---|---|---|---|---|
| `draft` | Mutable authoring state | **No** — no production runs (V03) | Yes (the draft version only) | No |
| `published` | Current published version exists; runs allowed | Yes | No, except new draft versions via `revise` | No |
| `deprecated` | Superseded; new runs refused; existing snapshots continue | **No** (new runs) | No | No |
| `archived` | Retained for audit, read-only forever | **No** | No | **Yes (absorbing)** |

### 2.2 Events

| Event | Legal in | Effect |
|---|---|---|
| `create` | ⊥ (from nothing) | `⊥ → draft` |
| `publish` | `draft` | `draft → published` |
| `revise` | `published` | stays `published`; mints a new draft **version** |
| `fork` | `published`, `deprecated` | stays in state; creates a NEW template in `draft` |
| `deprecate` | `published` | `published → deprecated` |
| `archive` | `deprecated` | `deprecated → archived` |
| `lock` / `release` | overlay only | no state change (see §8) |
| `update` | `draft` | no state change |

### 2.3 Transition table

| From | Event | Guard | Action / Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|
| ⊥ | `create` | org exists; actor holds `workflow.draft.create` | insert template `state='draft'` + draft version `0.1.0-draft` | `WorkflowTemplateCreated`, `WorkflowDraftCreated` | `POLICY_DENIED`, `ORG_NOT_FOUND` |
| `draft` | `update` | editable draft version exists; no lock; not archived | mutate draft graph | `WorkflowDraftUpdated` | `LOCKED_TEMPLATE`, `ARCHIVED_READONLY` |
| `draft` | `publish` | DAG valid; capabilities resolvable; `bumpIntent` ≥ actual diff; no active lock on the draft version | mint immutable version; `state='published'`; `publishedVersionId' | `WorkflowPublished`, `WorkflowVersionMinted` | `ILLEGAL_TRANSITION`, `LOCKED_TEMPLATE`, `VALIDATION_FAILED`, `HASH_MISMATCH` |
| `draft` | `revise` | — | ⊥ | — | `ILLEGAL_TRANSITION` |
| `draft` | `fork` | — | ⊥ (cannot fork an unpublished draft) | — | `ILLEGAL_TRANSITION` |
| `draft` | `deprecate` / `archive` | — | ⊥ | — | `ILLEGAL_TRANSITION` |
| `published` | `publish` | same `contentHash` already recorded | idempotent replay — returns existing version | none (audit-only `WorkflowPublishReplayed`) | — |
| `published` | `publish` (different hash, same semver) | — | ⊥ | — | `ILLEGAL_TRANSITION` |
| `published` | `revise` | `ChangeProposal.status='accepted'` ∧ unconsumed; no lock on base version | mint new draft version `1.2.0 → 1.3.0-draft` with `changeProposalId`; parent unchanged | `WorkflowVersionRevised`, `WorkflowDraftCreated`, `ChangeProposalConsumed` | `PROPOSAL_NOT_ACCEPTED`, `LOCKED_TEMPLATE`, `ARCHIVED_READONLY` |
| `published` | `fork` | no `scope:'global'` lock on the source | create NEW template `draft` + copy version + lineage edge | `WorkflowForked`, `ForkLineageRecorded`, `WorkflowDraftCreated` | `LOCKED_TEMPLATE` |
| `published` | `deprecate` | no `scope:'global'` lock | `state='deprecated'`; new runs refused | `WorkflowDeprecated` | `LOCKED_TEMPLATE` |
| `published` | `archive` | — | ⊥ | — | `ILLEGAL_TRANSITION` |
| `published` | `update` | — | ⊥ (published graphs are immutable) | — | `ILLEGAL_TRANSITION` |
| `published` | `unpublish` / `revert` | — | ⊥ by design (ADR-0006) | — | `ILLEGAL_TRANSITION` |
| `deprecated` | `fork` | no `scope:'global'` lock | new template `draft` + lineage | `WorkflowForked`, `ForkLineageRecorded` | `LOCKED_TEMPLATE` |
| `deprecated` | `archive` | no in-flight run holds a lock on any version of this template | `state='archived'`, `archivedAt` | `WorkflowArchived` | `LOCKED_TEMPLATE`, `ILLEGAL_TRANSITION` |
| `deprecated` | `publish` / `revise` / `update` | — | ⊥ | — | `ILLEGAL_TRANSITION` |
| `archived` | *(any)* | — | ⊥ absorbing | — | `ARCHIVED_READONLY`, and `ILLEGAL_TRANSITION` for pure lifecycle edges |

### 2.4 Diagram

```text
                          create
                            │
                            ▼
     ┌──────────────────────┐  publish   ┌────────────────────┐  deprecate  ┌────────────────┐  archive  ┌───────────┐
     │        draft         │───────────►│     published      │────────────►│   deprecated   │──────────►│ archived  │
     │  (mutable authoring) │            │  (immutable vers.) │             │ (no new runs)  │           │ absorbing │
     └──────────────────────┘            └─────────┬──────────┘             └───────┬────────┘           └───────────┘
             ▲                                     │                                │
             │                          revise ────┤                                │ fork
             │                    (⇢ new draft ver.)│                               │
             └──────────────────────────────────────┘                               │
                                                   │ fork                       ┌────┴─────────────────────┐
                                                   └───────────────────────────►│ NEW template (draft)      │
                                                                                └──────────────────────────┘
     OVERLAY (no lifecycle change):
       published · deprecated  ──lock(scope=run)──►  locked_run     ──release──►  unlocked
       published · deprecated  ──lock(scope=global)─► locked_global ──release──►  unlocked
```

### 2.5 Invariants

| ID | Invariant |
|---|---|
| SM-T-01 | `archived` has zero outgoing edges. |
| SM-T-02 | `state='published'` ⇔ `publishedVersionId` is non-null and points to a version whose semver has no `-draft` suffix. |
| SM-T-03 | `revise` never changes `state` (a revised template keeps a published version). |
| SM-T-04 | `fork` never changes the source template's state, version, or metrics. |
| SM-T-05 | `deprecate` never invalidates an existing `RunSnapshot`. |
| SM-T-06 | `archive` requires zero in-flight runs; if any exists, the guard fails atomically. |
| SM-T-07 | A `draft`-state template that has *never* been published has no `publishedVersionId`. |

---

## 3. Machine: `WorkflowVersionState` (immutability oracle)

A published version is immutable, so this "machine" is effectively an **oracle**: it has one state and answers verification questions. Its value is that every write path must consult it.

### 3.1 States

| State | Meaning | Transitions out | Terminal? |
|---|---|---|---|
| `draft_version` | Mutable pre-publish version (`0.1.0-draft`, `1.3.0-draft`) | `mint` → `published_version` | No |
| `published_version` | Immutable; contentHash assigned | **none ever** (`revise` supersedes, never mutates) | **Yes (oracle: verify only)** |

### 3.2 Events

| Event | Legal in | Effect |
|---|---|---|
| `mint` | `draft_version` | `draft_version → published_version`; assigns semver + `contentHash` |
| `verify` | `published_version` | recompute `contentHash`; equal ⇒ ok; else `HASH_MISMATCH` |
| `supersedeDraft` | `draft_version` | marks draft as superseded/read-only (no content change) |
| `mutate` | `published_version` | **⊥ always** |

### 3.3 Transition table

| From | Event | Guard | Action / Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|
| ⊥ | `draft_version.created` | by `create`/`revise` | insert row with `-draft` semver, `content_hash = NULL` | `WorkflowDraftCreated` | — |
| `draft_version` | `mint` (via publish) | graph valid; no lock; semver legal; hash not previously used for this template | set `semver` (no `-draft`), `content_hash = sha256(canonicalize(graph))`; row becomes immutable | `WorkflowVersionMinted` | `VALIDATION_FAILED`, `LOCKED_TEMPLATE` |
| `draft_version` | `mutate` | — | in-place graph edit (the **only** legal mutation path in the whole system) | `WorkflowDraftUpdated` | `LOCKED_TEMPLATE` |
| `draft_version` | `supersedeDraft` | a newer draft exists for the template | set `superseded_at`; block further mutation | `WorkflowDraftSuperseded` | — |
| `published_version` | `mutate` | — | ⊥ | — | `ILLEGAL_TRANSITION` (plus DB trigger denial) |
| `published_version` | `verify` | stored graph readable | recompute hash; equal ⇒ pass | `WorkflowVersionVerified` | `HASH_MISMATCH` |
| `published_version` | `mint` again | same hash ⇒ replay | idempotent, returns existing | none | `ILLEGAL_TRANSITION` if hash differs |
| `published_version` | `supersedeDraft` | — | ⊥ | — | `ILLEGAL_TRANSITION` |

### 3.4 Diagram

```text
   ┌───────────────────┐   mint (publish)   ┌───────────────────────┐
   │  draft_version    │───────────────────►│  published_version    │
   │  semver: x.y.z-…  │                    │  semver: x.y.z        │
   │  contentHash: null│                    │  contentHash: sha256  │
   │  MUTABLE          │                    │  IMMUTABLE (oracle)   │
   └───────────────────┘                    └───────────┬───────────┘
            │                                           │
            │ supersedeDraft                            │ verify ──► ok | HASH_MISMATCH
            ▼                                           │ mutate ──► ⊥ ILLEGAL_TRANSITION
      superseded (read-only)                            └── no outgoing edges, ever
```

### 3.5 Invariants

| ID | Invariant |
|---|---|
| SM-V-01 | `semver` without `-draft` ⇒ immutable; no `UPDATE` may change `graph`, `semver`, or `content_hash` (DB trigger `trg_version_immutable`). |
| SM-V-02 | `content_hash = sha256_hex(canonicalize(graph))` — sorted keys, no insignificant whitespace, no timestamps (§5.2 of `docs/WORKFLOW_LIFECYCLE.md`). |
| SM-V-03 | `(template_id, content_hash)` unique for published versions. |
| SM-V-04 | A published version's `graph` is byte-identical to its first persisted value. |
| SM-V-05 | Every published version's `changeProposalId` is either `NULL` (first publish) or an `accepted`, consumed proposal. |

---

## 4. Machine: `RunState`（L1 全局执行态——17 态，规划书 §三十三）

> **分层声明（ADR-0003）**：本机是 **L1（执行推进）**，与 L2 的模板生命周期
> （`DRAFT/PUBLISHED/DEPRECATED/ARCHIVED`）是**不同层**，禁止混用。
> 本机取代 Sprint 0 文档中的 8 态运行词表（映射见文末 §4.6）。
> 实现：`packages/core/src/domain/run-state.ts`（本表与实现必须同改）。

### 4.1 States（17）

| # | State | Meaning | Terminal? |
|---|---|---|---|
| 1 | `IDLE` | 无活动执行；系统就绪 | No |
| 2 | `INITIALIZING` | 正在固定 RunSnapshot、校验模板版本 / 锁 / Pack 版本 | No |
| 3 | `DESIGNING_WORKFLOW` | 无可用 SOP，Chief 正在设计 Workflow Draft | No |
| 4 | `WORKFLOW_REVIEW` | Draft 待评审 | No |
| 5 | `WORKFLOW_PUBLISHED` | Draft 已发布为模板，可创建 Run | No |
| 6 | `PLANNING` | 正在拆解 Stage / Task / 验收标准 | No |
| 7 | `ROUTING` | 正在选择模型与工具（Sprint 1 仅有状态位，无路由实现） | No |
| 8 | `WAITING_APPROVAL` | 阻塞在人工审批（HIGH / CRITICAL 风险） | No |
| 9 | `EXECUTING` | Agent 正在执行当前 Stage / Task | No |
| 10 | `REVIEWING` | 独立评审中 | No |
| 11 | `VALIDATING` | 运行 Validator（真实命令）中 | No |
| 12 | `REWORK` | 评审或验证失败后返工（默认上限 3 次） | No |
| 13 | `FINALIZING` | 全部通过，正在交付与归档 Artifact | No |
| 14 | `COMPLETED` | 交付完成 | **Yes**（吸收） |
| 15 | `FAILED` | 不可恢复失败（取消 / 超时 / 审批拒绝的最终落点） | **Yes**（吸收） |
| 16 | `PAUSED` | 暂停：返工超限、崩溃恢复待裁决、用户暂停 | No（可 `RESUME` / `CANCEL`） |
| 17 | `RECOVERING` | 崩溃 / 中断后按事件日志恢复中 | No |

### 4.2 Events

| Event | 语义 |
|---|---|
| `START` | 创建执行上下文 |
| `TEMPLATE_RESOLVED` / `TEMPLATE_MISSING` | 快照固定后：找到成熟 SOP / 需要新建 SOP |
| `SUBMIT_DRAFT` / `DRAFT_APPROVED` / `DRAFT_REJECTED` | Draft 评审往返 |
| `RUN_CREATED` | 由已发布模板创建 Run |
| `PLAN_READY` | 拆解完成 |
| `ROUTE_RESOLVED` / `ROUTE_FAILED` | 路由结果 |
| `APPROVAL_REQUIRED` / `APPROVAL_GRANTED` / `APPROVAL_DENIED` | 人工审批门（规划书 §十一 / §三十六） |
| `EXECUTION_DONE` / `EXECUTION_FAILED` | 执行结束 |
| `REVIEW_PASSED` / `REVIEW_REJECTED` | 评审结果 |
| `REWORK_READY` / `REWORK_EXHAUSTED` | 返工继续 / 超过 3 次转 `PAUSED`（规划书 §三十五） |
| `VALIDATION_PASSED` / `VALIDATION_FAILED` | 验证结果（规划书 §三十二） |
| `DELIVERED` / `DELIVERY_FAILED` | 交付结果 |
| `PAUSE` / `RESUME` | 显式暂停与恢复 |
| `CRASH_DETECTED` / `RECOVERED` / `RECOVERY_FAILED` | 崩溃恢复（规划书 §四十五） |
| `CANCEL` / `TIMEOUT` | 取消与超时（语义落点为 `FAILED` + `reason`） |

### 4.3 Transition table

| From | Event | To | Effect |
|---|---|---|---|
| `IDLE` | `START` | `INITIALIZING` | 建立 execution 上下文 |
| `INITIALIZING` | `TEMPLATE_RESOLVED` | `PLANNING` | 固定并校验 RunSnapshot |
| `INITIALIZING` | `TEMPLATE_MISSING` | `DESIGNING_WORKFLOW` | 转入 SOP 设计流程 |
| `DESIGNING_WORKFLOW` | `SUBMIT_DRAFT` | `WORKFLOW_REVIEW` | 提交 Draft |
| `WORKFLOW_REVIEW` | `DRAFT_APPROVED` | `WORKFLOW_PUBLISHED` | 发布模板新版本（L2 层另行记录） |
| `WORKFLOW_REVIEW` | `DRAFT_REJECTED` | `DESIGNING_WORKFLOW` | 退回修改 |
| `WORKFLOW_PUBLISHED` | `RUN_CREATED` | `PLANNING` | 由该模板创建 Run |
| `PLANNING` | `PLAN_READY` | `ROUTING` | Stage / Task 落定 |
| `ROUTING` | `ROUTE_RESOLVED` | `EXECUTING` | 模型 / 工具绑定完成 |
| `ROUTING` | `ROUTE_FAILED` | `FAILED` | 无可用模型或工具 |
| `PLANNING` · `ROUTING` · `EXECUTING` | `APPROVAL_REQUIRED` | `WAITING_APPROVAL` | 进入人工审批门 |
| `WAITING_APPROVAL` | `APPROVAL_GRANTED` | `EXECUTING` | 审批通过，继续执行 |
| `WAITING_APPROVAL` | `APPROVAL_DENIED` | `FAILED` | 审批拒绝 |
| `EXECUTING` | `EXECUTION_DONE` | `REVIEWING` | 进入独立评审 |
| `EXECUTING` | `EXECUTION_FAILED` | `FAILED` | 不可恢复执行失败 |
| `REVIEWING` | `REVIEW_PASSED` | `VALIDATING` | 评审通过 |
| `REVIEWING` | `REVIEW_REJECTED` | `REWORK` | `REQUEST_CHANGES` |
| `REWORK` | `REWORK_READY` | `EXECUTING` | 返工完成，重回执行 |
| `REWORK` | `REWORK_EXHAUSTED` | `PAUSED` | 超过 3 次，交 Chief / 用户重新决策 |
| `VALIDATING` | `VALIDATION_PASSED` | `FINALIZING` | 质量门通过 |
| `VALIDATING` | `VALIDATION_FAILED` | `REWORK` | 质量门失败 |
| `FINALIZING` | `DELIVERED` | `COMPLETED` | 交付完成（终态） |
| `EXECUTING` · `REVIEWING` · `VALIDATING` · `FINALIZING` | `OUTCOME_DELIVERED` | `COMPLETED` | 容器运行终态收敛（LIVE-SMOKE-FIX-09）：目标结果由子执行运行交付；引擎先证明子运行 engine-terminal `COMPLETED`（子运行自身经过证据门验证链才可能到达），容器运行绝不绕过自身的验证要求 |
| `FINALIZING` | `DELIVERY_FAILED` | `FAILED` | 交付失败 |
| 执行期状态（`PLANNING` · `ROUTING` · `WAITING_APPROVAL` · `EXECUTING` · `REVIEWING` · `VALIDATING` · `REWORK` · `FINALIZING`） | `PAUSE` | `PAUSED` | 写入 checkpoint；记录 `resumePoint = 当前状态`。**规划前状态不可暂停**（否则 PAUSE+RESUME 会绕过规划与审批门） |
| `PAUSED` | `RESUME` | `EXECUTING`（有记录点时返回该点） | 从 checkpoint 恢复；聚合体把 `resumePoint` 传给 `nextRunState`，恢复后清空该字段 |
| `PLANNING` · `ROUTING` · `EXECUTING` · `REVIEWING` · `VALIDATING` · `FINALIZING` | `CRASH_DETECTED` | `RECOVERING` | 启动时发现孤儿执行 |
| `RECOVERING` | `RECOVERED` | `EXECUTING`（有记录点时返回该点） | 按事件日志恢复到最近安全点 |
| `RECOVERING` | `RECOVERY_FAILED` | `FAILED` | 无法恢复 |
| 任何非终态（17 态中除 `COMPLETED`/`FAILED`） | `CANCEL` | `FAILED` | 取消（`reason='cancelled'`） |
| `INITIALIZING` · `PLANNING` · `ROUTING` · `WAITING_APPROVAL` · `EXECUTING` · `REVIEWING` · `VALIDATING` · `REWORK` · `FINALIZING` | `TIMEOUT` | `FAILED` | 超时（`reason='timed_out'`）。`IDLE`/`PAUSED`/`RECOVERING` 不在其中（显式表，无隐含分支） |
| `COMPLETED` · `FAILED` | *(any)* | ⊥ | 吸收态，抛 `ILLEGAL_TRANSITION` |

### 4.4 Diagram

```text
IDLE ──START──► INITIALIZING ──TEMPLATE_RESOLVED──► PLANNING ──PLAN_READY──► ROUTING
                    │                                  ▲                        │
                    └──TEMPLATE_MISSING──► DESIGNING_WORKFLOW                     │ ROUTE_RESOLVED
                                             │  ▲                                  ▼
                                   SUBMIT_DRAFT│  │DRAFT_REJECTED            ┌──────────────┐
                                             ▼  │                          │  EXECUTING   │
                                     WORKFLOW_REVIEW ──DRAFT_APPROVED──►    └──┬───────┬───┘
                                             │  WORKFLOW_PUBLISHED             │       │
                                             └──RUN_CREATED──► PLANNING ◄──────┘       │ EXECUTION_DONE
                                                                                      ▼
   ┌──────────────┐  APPROVAL_GRANTED                                   ┌──────────────────┐
   │ WAITING_     │◄──APPROVAL_REQUIRED── PLANNING / ROUTING / EXECUTING │    REVIEWING     │
   │ APPROVAL     │────────APPROVAL_DENIED──────────────► FAILED         └───┬──────────┬───┘
   └──────────────┘                                              REVIEW_PASSED│          │REVIEW_REJECTED
                                                                            ▼          ▼
                                                                     ┌────────────┐  ┌────────┐
                                                                     │ VALIDATING │  │ REWORK │
                                                                     └──┬──────┬──┘  └──┬───┬─┘
                                                          VALIDATION_PASSED│      │      │   │REWORK_EXHAUSTED
                                                                          ▼      │      │   ▼
                                                                    ┌────────────┐  │      │ ┌────────┐
                                                                    │ FINALIZING │  │      └►│ PAUSED │
                                                                    └──┬──────┬──┘  │        └───┬────┘
                                                          DELIVERED│       │DELIVERY_FAILED  RESUME│
                                                                   ▼       ▼                      ▼
                                                            ┌───────────┐ ┌────────┐        (EXECUTING)
                                                            │ COMPLETED │ │ FAILED │◄── CANCEL / TIMEOUT（来自任何非终态）
                                                            └───────────┘ └────────┘
                                                              （两者均为吸收态）

CRASH_DETECTED：PLANNING / ROUTING / EXECUTING / REVIEWING / VALIDATING / FINALIZING ──► RECOVERING
RECOVERING ──RECOVERED──► EXECUTING ；RECOVERING ──RECOVERY_FAILED──► FAILED
```

### 4.5 Invariants

| ID | Invariant |
|---|---|
| SM-L1-01 | `COMPLETED` 与 `FAILED` 为吸收态：不存在任何出边候选。 |
| SM-L1-02 | 一次执行只允许一个 L1 状态；状态迁移必须来自 §4.3 表中的显式边，禁止"默认分支"。 |
| SM-L1-03 | `WAITING_APPROVAL` 只能由 `APPROVAL_GRANTED` / `APPROVAL_DENIED` / `PAUSE` / `CANCEL` / `TIMEOUT` 离开；不存在"超时自动批准"。 |
| SM-L1-04 | `REWORK` 的累计次数达到上限（默认 3）时**只能**转 `PAUSED`，不得直接转 `FAILED` 或 `COMPLETED`。 |
| SM-L1-05 | `PAUSED` 不自动恢复：恢复必须由显式 `RESUME` 驱动（规划书 §四十五）。 |
| SM-L1-06 | `RECOVERING` 的出口只有 `RECOVERED` / `RECOVERY_FAILED`；恢复过程不产生新的业务副作用。 |
| SM-L1-07 | 取消与超时都落到 `FAILED`，但必须携带 `reason`（`cancelled` / `timed_out`）与对应事件，以便审计区分。 |

Execution Safety Sprint 2（ADR-0032，F 候选待独立审查）：Goal 取消意图先持久化于既有 Run
预算 envelope，受理不等于进程或远端已停止。派发、恢复与终态提交重新读取该意图；未提交的迟到
结果不得复活 Goal。现有 Task `CANCELLED`、AgentExecution `CANCELLED`、ExecutionAttempt
`INTERRUPTED` 与 Run `FAILED/cancelled` 保持原枚举与唯一权威，不引入第二套状态机。
| SM-L1-08 | L1 状态与 L2 模板状态是不同层：L1 的 `WORKFLOW_PUBLISHED` 只表示"本次执行所处的阶段"，不等于 L2 的模板 `PUBLISHED`。 |
| SM-L1-09 | `PAUSE` 只能从**执行期状态**出发（`PAUSABLE_RUN_STATES`：PLANNING / ROUTING / WAITING_APPROVAL / EXECUTING / REVIEWING / VALIDATING / REWORK / FINALIZING）。规划前状态不可暂停，因此 `PAUSE` + `RESUME` 永远无法绕过规划、路由或审批门。 |
| SM-L1-10 | 恢复不跳步：`RESUME` / `RECOVERED` 必须返回暂停/崩溃时记录的 `resumePoint`；仅在无记录点时才回退到 `EXECUTING`。恢复后 `resumePoint` 清空。 |
| SM-L1-11 | `maxRework` 的口径 = **允许完整回到执行的返工轮次**；第 (maxRework+1) 次进入 `REWORK` 后只能用 `REWORK_EXHAUSTED` 离开（→ `PAUSED`）。默认 `maxRework = 3`。 |

### 4.6 取代关系

本文档早先把一次执行的运行态写成 8 个状态（队列中 / 运行中 / 暂停 / 等待交接 / 成功 / 失败 / 取消 / 超时）。
该词表**已被 L1 的 17 态取代**，逐项映射（含旧词表的原文）见
`docs/adr/0003-state-layering.md` §取代关系 —— 那里是唯一真相源，此处刻意不重复，避免两处分叉。
要点：取消与超时不再单列状态，而是落到 `FAILED` 并携带 `reason`。

---
## 5. Machine: `NodeExecutionState`

### 5.1 States

| State | Meaning | Terminal? |
|---|---|---|
| `pending` | Declared in the graph; not ready (unmet dependencies) | No |
| `ready` | All dependencies satisfied; eligible for dispatch | No |
| `running` | Dispatched to a worker | No |
| `retrying` | Attempt failed, backoff in progress, attempts remain | No |
| `succeeded` | Completed with output | **Yes** |
| `failed` | Attempts exhausted | **Yes** |
| `skipped` | Guard/branch not taken, or upstream skipped | **Yes** |
| `cancelled` | Run cancelled/timed out while pending/running | **Yes** |

### 5.2 Events

`dependenciesSatisfied`, `guardSkipped`, `dispatch`, `retry`, `succeed`, `fail`, `cancel`, `deadlineExceeded`.

### 5.3 Transition table

| From | Event | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|
| ⊥ | `planned` | snapshot graph contains the node | insert `NodeExecution{state:'pending'}` | `NodeExecutionPlanned` | `SNAPSHOT_MISMATCH` |
| `pending` | `dependenciesSatisfied` | all inbound nodes ∈ `{succeeded, skipped}` per edge condition | `state='ready'` | `NodeReady` | — |
| `pending` | `guardSkipped` | branch condition false / upstream skipped | `state='skipped'` | `NodeSkipped` | — |
| `pending` | `cancel` | run is being cancelled | `state='cancelled'` | `NodeExecutionCancelled` | — |
| `ready` | `dispatch` | run is `running`; worker slot available; deadline not passed | `state='running'`; `startedAt` | `NodeStarted` | `ILLEGAL_TRANSITION` if run is terminal |
| `ready` | `guardSkipped` | condition re-evaluated false | `state='skipped'` | `NodeSkipped` | — |
| `ready` | `cancel` | run cancelled | `state='cancelled'` | `NodeExecutionCancelled` | — |
| `ready` | `deadlineExceeded` | run/node deadline passed before dispatch | `state='failed'` | `NodeFailed` | — |
| `running` | `succeed` | output validates against declared output contract; artifacts persisted | `state='succeeded'`; `finishedAt`; checkpoint written | `NodeSucceeded`, `CheckpointWritten` | `VALIDATION_FAILED` |
| `running` | `fail` (attempts remain) | `attempt < maxAttempts` | `state='retrying'`; backoff schedule set | `NodeRetryScheduled` | — |
| `running` | `fail` (attempts exhausted) | `attempt >= maxAttempts` | `state='failed'`; upstream-independent siblings continue; dependents become `skipped` | `NodeFailed`, `NodeSkipped` | — |
| `running` | `cancel` | run cancelled | kill/abandon attempt; `state='cancelled'` | `NodeExecutionCancelled` | — |
| `running` | `deadlineExceeded` | node timeout exceeded | `state='failed'` with reason `NODE_TIMEOUT`; counts as `failed` (not run-level `timed_out`) | `NodeFailed` | — |
| `retrying` | `dispatch` | backoff elapsed; run still `running`; attempts remain | `state='running'`; `attempt += 1` | `NodeStarted` | `ILLEGAL_TRANSITION` if run terminal |
| `retrying` | `deadlineExceeded` | run deadline passed during backoff | `state='failed'` | `NodeFailed` | — |
| `retrying` | `cancel` | run cancelled | `state='cancelled'` | `NodeExecutionCancelled` | — |
| `succeeded`/`failed`/`skipped`/`cancelled` | *(any)* | — | ⊥ absorbing | — | `ILLEGAL_TRANSITION` |

### 5.4 Diagram

```text
  ┌─────────┐  dependenciesSatisfied  ┌───────┐  dispatch  ┌─────────┐  succeed  ┌───────────┐
  │ pending │────────────────────────►│ ready │───────────►│ running │──────────►│ succeeded │
  └────┬────┘                         └───┬───┘            └────┬────┘           └───────────┘
       │ guardSkipped / cancel            │ cancel              │ fail (attempts left)
       │                                  │                     ▼
       ▼                                  ▼              ┌──────────┐ dispatch (backoff elapsed)
  ┌──────────┐                     ┌───────────┐         │ retrying │────────────┐
  │ skipped  │                     │ cancelled │         └────┬─────┘            │
  └──────────┘                     └───────────┘              │ fail (exhausted) └──► running
                                                              ▼
                                                        ┌──────────┐
                                                        │  failed  │
                                                        └──────────┘
   all five marked states are ABSORBING
```

### 5.5 Invariants

| ID | Invariant |
|---|---|
| SM-N-01 | `attempt` starts at 1 and increments only on `retrying → running`. |
| SM-N-02 | A node's inputs come from the snapshot graph + upstream outputs only; no live lookup. |
| SM-N-03 | Node terminal states are final; a re-run creates a new `NodeExecution` row (new id) — never a resurrection. |
| SM-N-04 | `failed` node ⇒ all its transitive dependents become `skipped` in the same transaction. |
| SM-N-05 | Node-level timeout yields `failed` (reason `NODE_TIMEOUT`); run-level deadline yields run `timed_out`. The two are never conflated. |
| SM-N-06 | `succeeded` requires a persisted output reference (`contentRef` or inline payload within threshold). |

---

## 6. Machine: `HandoffState`

Full protocol in `docs/HANDOFF_PROTOCOL.md`. States here are the persistence-authoritative ones.

### 6.1 States

| State | Meaning | Terminal? | Ack/nack semantics |
|---|---|---|---|
| `prepared` | Envelope built and written to the outbox in the same transaction as the node's state change | No | not yet sent |
| `dispatched` | Sent to the target role/agent; awaiting response | No | deadline armed |
| `acknowledged` | Receiver accepted responsibility | No | receiver will act |
| `effect_applied` | The handoff's effect is committed exactly once (dedupe key consumed) | **Yes** | success terminal |
| `nacked` | Receiver explicitly refused (invalid payload, not my role, precondition failed) | No | retry may follow, per policy |
| `retrying` | Backoff in progress after `nack` or timeout | No | attempt += 1 |
| `dead_lettered` | Retries exhausted or non-retryable nack | **Yes** | DLQ holds it for replay |
| `expired` | Deadline passed before any ack | No (recoverable via DLQ) | acts like a non-retryable failure unless policy says retry |
| `cancelled` | Owning run reached a terminal state | **Yes** | no effect applied |

### 6.2 Events

`prepare`, `dispatch`, `ack`, `nack`, `applyEffect`, `timeout`, `retry`, `deadLetter`, `replay`, `cancel`.

### 6.3 Transition table

| From | Event | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|
| ⊥ | `prepare` | envelope schema-valid (zod); `idempotencyKey` unique per `(runId, fromRole, toRole, intent)` | insert `Handoff{state:'prepared'}` + outbox row | `HandoffPrepared` | `VALIDATION_FAILED`, `DUPLICATE_IDEMPOTENCY_KEY` (replay returns original) |
| `prepared` | `dispatch` | run not terminal; `attempt ≤ maxAttempts` | `state='dispatched'`; `dispatchedAt`; deadline armed | `HandoffDispatched` | `ILLEGAL_TRANSITION` |
| `dispatched` | `ack` | receiver exists and has authority for `toRole` | `state='acknowledged'` | `HandoffAcknowledged` | — |
| `dispatched` | `nack` | reason supplied | `state='nacked'` | `HandoffNacked` | — |
| `dispatched` | `timeout` | `now > deadline` | `state='expired'` | `HandoffExpired` | — |
| `acknowledged` | `applyEffect` | effect handler idempotent; dedupe row not yet consumed | apply effect + consume dedupe key in one transaction; `state='effect_applied'` | `HandoffEffectApplied`, `HandoffCompleted` | `ILLEGAL_TRANSITION` if dedupe already consumed |
| `nacked` | `retry` | `retryable(reason)` ∧ `attempt < maxAttempts` | `state='retrying'`; backoff delay computed | `HandoffRetryScheduled` | — |
| `nacked` | `deadLetter` | non-retryable, or attempts exhausted | `state='dead_lettered'`; DLQ row | `HandoffDeadLettered` | — |
| `retrying` | `dispatch` | backoff elapsed; run not terminal | `state='dispatched'`; `attempt += 1` | `HandoffDispatched` | `ILLEGAL_TRANSITION` |
| `retrying` | `deadLetter` | attempts exhausted | `state='dead_lettered'` | `HandoffDeadLettered` | — |
| `expired` | `replay` | policy allows; attempts remain | `state='dispatched'`; `attempt += 1` | `HandoffReplayed` | — |
| `expired` | `deadLetter` | policy says fail-fast | `state='dead_lettered'` | `HandoffDeadLettered` | — |
| `dead_lettered` | `replay` | operator-triggered; dedupe key still unconsumed | `state='dispatched'`; `attempt += 1`; DLQ row marked replayed | `HandoffReplayed` | `ILLEGAL_TRANSITION` if dedupe already consumed |
| any non-terminal | `cancel` | owning run reached a terminal state | `state='cancelled'` | `HandoffCancelled` | — |
| `effect_applied` / `cancelled` | *(any)* | — | ⊥ absorbing | — | `ILLEGAL_TRANSITION` |

### 6.4 Diagram

```text
   prepare        dispatch        ack           applyEffect
 ⊥ ──────► ┌──────────┐ ──────► ┌────────────┐ ────► ┌──────────────┐ ──────────► ┌────────────────┐
           │ prepared │         │ dispatched │       │ acknowledged │             │ effect_applied │
           └──────────┘         └─────┬──────┘       └──────────────┘             └────────────────┘
                                      │   │  timeout
                          nack        │   └──────────► ┌─────────┐ replay ──┐
                    ┌─────────────────┘                │ expired │◄─────────┤
                    ▼                                  └────┬────┘          │
              ┌────────┐  retry (backoff)  ┌───────────┐     │ deadLetter   │
              │ nacked │──────────────────►│ retrying  │─────┴──────────────┘
              └───┬────┘                   └─────┬─────┘
                  │ deadLetter                   │ dispatch (attempt+1)
                  ▼                              └──────► dispatched
           ┌────────────────┐   replay (operator)     ▲
           │ dead_lettered  │─────────────────────────┘
           └────────────────┘
   cancel from any non-terminal state ⇒ cancelled
   ABSORBING: effect_applied | dead_lettered? (replayable by operator) | cancelled
```

### 6.5 Invariants

| ID | Invariant |
|---|---|
| SM-H-01 | Exactly-once **effect**: the effect is applied at most once per `idempotencyKey` (outbox + dedupe table). |
| SM-H-02 | Envelope write and the owning node's state change share one transaction. |
| SM-H-03 | `effect_applied` requires a consumed dedupe row; the two are written together or not at all. |
| SM-H-04 | `attempt` increments only on a transition **into** `dispatched` from `retrying`/`expired`/`dead_lettered`. |
| SM-H-05 | A handoff never outlives its run in a non-terminal state: run termination cancels all open handoffs. |
| SM-H-06 | An approval handoff is single-use: the second identical decision is a no-op returning the first result. |
| SM-H-07 | Backoff is deterministic and injectable (`delay = min(baseMs × 2^(attempt−1), capMs)` + jitter from the injected RNG), so tests are reproducible. |

---

## 7. Machine: `ChangeProposalState`

Canonical statuses from CANONICAL_SPEC §2: `open | accepted | rejected | superseded`.

### 7.1 States

| State | Meaning | Terminal? | Consumed? |
|---|---|---|---|
| `open` | Awaiting decision | No | — |
| `accepted` | Approved; may mint exactly one draft version | No (until consumed) | No → then Yes |
| `rejected` | Refused with a required reason | **Yes** | n/a |
| `superseded` | Replaced by a newer proposal for the same base/overlap | **Yes** | n/a |

`consumed` is a **derived flag** (`consumedByVersionId != null`) on `accepted`, not a fifth canonical status.

### 7.2 Events

`open`, `decide(accepted)`, `decide(rejected)`, `supersede`, `consume`, `stale`.

### 7.3 Transition table

| From | Event | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|
| ⊥ | `open` | `baseVersionId` belongs to `targetTemplateId`; base ∈ `{published, deprecated}`; diff parses; `baseContentHash` matches | insert `ChangeProposal{status:'open'}`; auto-`supersede` overlapping open proposals | `ChangeProposalOpened`, `ChangeProposalSuperseded` | `VALIDATION_FAILED`, `POLICY_DENIED` |
| `open` | `decide(accepted)` | decider holds `workflow.proposal.decide`; decider ≠ author unless an explicit policy permits; base still exists | `status='accepted'` + `decidedBy`/`decidedAt` | `ChangeProposalAccepted` | `POLICY_DENIED`, `STALE_PROPOSAL` |
| `open` | `decide(rejected)` | decider authority; reason non-empty | `status='rejected'` + decider + reason | `ChangeProposalRejected` | `POLICY_DENIED`, `VALIDATION_FAILED` (missing reason) |
| `open` | `supersede` | newer proposal covers the same base/overlap, or author withdraws | `status='superseded'` | `ChangeProposalSuperseded` | — |
| `open` | `consume` | — | ⊥ (must be accepted first) | — | `PROPOSAL_NOT_ACCEPTED` |
| `accepted` | `consume` | no lock on base; diff still applies cleanly to base | mint new draft version; `consumedByVersionId` set | `ChangeProposalConsumed`, `WorkflowVersionRevised` | `LOCKED_TEMPLATE`, `HASH_MISMATCH` (base drifted) |
| `accepted` | `consume` (second time) | — | ⊥ (one-shot) | — | `PROPOSAL_NOT_ACCEPTED` |
| `accepted` | `decide(...)` | — | ⊥ terminal decision | — | `ILLEGAL_TRANSITION` |
| `rejected` / `superseded` | `consume` | — | ⊥ | — | `PROPOSAL_NOT_ACCEPTED` |
| `rejected` / `superseded` | `decide` / `supersede` | — | ⊥ absorbing | — | `ILLEGAL_TRANSITION` |

### 7.4 Diagram

```text
                       decide(accepted)                    consume (one-shot)
    ┌────────┐  ────────────────────────────►  ┌──────────┐ ──────────────────► consumed=true
    │  open  │                                │ accepted │                     (still status=accepted)
    └───┬────┘  ────────────────────────────►  └──────────┘
        │        decide(rejected)              ┌──────────┐
        ├─────────────────────────────────────►│ rejected │  ABSORBING
        │                                      └──────────┘
        │        supersede                     ┌────────────┐
        └─────────────────────────────────────►│ superseded │  ABSORBING
                                               └────────────┘
    consume from open/rejected/superseded ⇒ PROPOSAL_NOT_ACCEPTED
```

### 7.5 Invariants

| ID | Invariant |
|---|---|
| SM-P-01 | Only `accepted` (unconsumed) may mint a draft version. |
| SM-P-02 | An accepted proposal mints **at most one** version (`consumedByVersionId` unique). |
| SM-P-03 | `rejected` requires a non-empty reason and a `decidedBy`. |
| SM-P-04 | Segregation of duties: decider ≠ author by default (deny-by-default). |
| SM-P-05 | A proposal whose base version no longer exists cannot be decided (`STALE_PROPOSAL`). |
| SM-P-06 | All decision paths are audited (append-only, hash-chained). |

---

## 8. Machine: `TemplateLockState`

### 8.1 States

| State | Meaning | Blocks | Terminal? |
|---|---|---|---|
| `unlocked` | No lock row (represented by absence, or by `releasedAt != null`) | nothing | n/a |
| `locked_run` | `scope:'run'` lock held | `update`, `publish`, `revise`, `deprecate`, `archive` of the version | No |
| `locked_global` | `scope:'global'` lock held | everything `locked_run` blocks **plus** `fork` | No |
| `released` | `releasedAt` stamped; audit row preserved | nothing | **Yes (per row)** |

### 8.2 Events

`acquire(scope)`, `escalate`, `release`, `sweep`, `transfer`.

### 8.3 Transition table

| From | Event | Guard | Effect | Emitted events | Illegal-case error |
|---|---|---|---|---|---|
| `unlocked` | `acquire(run)` | version not `archived`; no incompatible lock | insert `TemplateLock{scope:'run', releasedAt:null}` | `TemplateLockAcquired` | `LOCKED_TEMPLATE`, `ARCHIVED_READONLY` |
| `unlocked` | `acquire(global)` | actor holds `workflow.lock.global` | insert `TemplateLock{scope:'global'}` | `TemplateLockAcquired` | `LOCKED_TEMPLATE` |
| `locked_run` | `acquire(run)` same run | same `runId` | idempotent (no second row) | none | — |
| `locked_run` | `escalate` | no other lock; actor holds global authority | insert a second `scope:'global'` row subsuming the run lock for guard purposes | `TemplateLockEscalated` | `LOCKED_TEMPLATE` |
| `locked_run` | `release` | no other in-flight run pins the version | stamp `releasedAt` ⇒ `released` | `TemplateLockReleased` | `ILLEGAL_TRANSITION` if already released |
| `locked_run` | `transfer` | another run still pins the version | release current + insert new `run` lock, one transaction | `TemplateLockReleased`, `TemplateLockAcquired` | — |
| `locked_global` | `release` | actor owns it or holds `workflow.lock.release` | stamp `releasedAt` | `TemplateLockReleased` | `ILLEGAL_TRANSITION` |
| `locked_run`/`locked_global` | `sweep` | owning run is terminal, or age > 24 h (global, advisory) | stamp `releasedAt`, `reason:'sweep'` | `TemplateLockReleased` | — |
| `released` | *(any)* | — | ⊥ per row (a new acquire creates a NEW row) | — | `ILLEGAL_TRANSITION` on re-releasing the same row |

### 8.4 Diagram

```text
                        acquire(run)            release / transfer / sweep
   ┌──────────┐  ───────────────────────►  ┌────────────┐  ──────────────────►  ┌──────────┐
   │ unlocked │                            │ locked_run │                       │ released │
   └────┬─────┘  ───────────────────────►  └─────┬──────┘                       └──────────┘
        │           acquire(global)              │ escalate                      (per row, absorbing)
        │                                        ▼
        │                                 ┌───────────────┐  release / sweep
        └────────────────────────────────►│ locked_global │─────────────────────► released
                                          └───────────────┘
   GUARD PREVIEW: locked_run  blocks update|publish|revise|deprecate|archive
                  locked_global additionally blocks fork
   NO row is ever DELETED — release stamps released_at (append-only, INV-WF-07)
```

### 8.5 Invariants

| ID | Invariant |
|---|---|
| SM-L-01 | Lock rows are append-only: never `DELETE`, only `releasedAt` stamping. |
| SM-L-02 | `scope:'global'` blocks `fork`; `scope:'run'` does not. |
| SM-L-03 | A guard never observes a version as "unlocked" while an in-flight run still pins it (transfer is atomic). |
| SM-L-04 | At most one **active** `scope:'global'` row per template at any time. |
| SM-L-05 | `release` on an already-released row raises `ILLEGAL_TRANSITION` (idempotency is handled by the command's idempotency key, not by the state machine). |
| SM-L-06 | `LOCKED_TEMPLATE` is the single error code for every lock-guard refusal, regardless of which command hit it. |

---

## 9. Cross-machine consistency rules

| # | Rule | Machines involved | Enforcement |
|---|---|---|---|
| X-01 | A run may be created only when the target version's template state ∈ `{published}`. `deprecated` ⇒ `DEPRECATED_TEMPLATE`; `archived` ⇒ `ARCHIVED_READONLY`; `draft` ⇒ `ILLEGAL_TRANSITION` (`DRAFT_NOT_RUNNABLE`). | `WorkflowTemplateLifecycle` observes `RunState` creation | `RunService.create()` consults the lifecycle machine, not the DB column directly |
| X-02 | `TemplateLockState.locked_global` blocks `WorkflowTemplateLifecycle.fork`; `locked_run` blocks `update`/`publish`/`revise`/`deprecate`/`archive`. | `TemplateLockState` blocks `WorkflowTemplateLifecycle` | Guard order rule (§1 rule 2): archived → lock → edge → policy |
| X-03 | `RunState.WAITING_APPROVAL` ⇔ ∃ pending `Approval` for the run; a cross-role `Handoff` keeps the run in `EXECUTING` (it is not a state of its own in L1). Closing the last open handoff/approval is applied in the same transaction. | `RunState` ⇔ `HandoffState` / `Approval` | Single transaction in the run engine; asserted by an integration test |
| X-04 | A node terminal state (`failed`) forces transitive dependents to `skipped` and may force `RunState → FAILED`. | `NodeExecutionState` drives `RunState` | DAG propagator inside one transaction |
| X-05 | `ChangeProposalState.accepted` (unconsumed) is the **only** precondition for `WorkflowVersionState.draft_version.created` via `revise`. | `ChangeProposalState` gates `WorkflowTemplateLifecycle.revise` | `PROPOSAL_NOT_ACCEPTED` guard; `changeProposalId` FK `NOT NULL` on revised versions |
| X-06 | A published `WorkflowVersion` can never be observed in a mutable state: `RunState` and `WorkflowTemplateLifecycle` both read it through the `WorkflowVersionState` oracle. | `WorkflowVersionState` observed by all | Repository guard + DB trigger; violation ⇒ `HASH_MISMATCH` |
| X-07 | `RunState` terminal ⇒ all its `NodeExecutionState` and `HandoffState` rows are terminal (cascade close). | `RunState` blocks others from staying open | Cascade in the terminal transition transaction |
| X-08 | `TemplateLockState` release requires no in-flight `RunState` non-terminal for that version (except the transferring case X-in-L06). | `RunState` blocks `TemplateLockState` release | Release guard queries runs by `(version_id, state)` index |
| X-09 | `WorkflowMetrics` observes but never blocks any machine (read-only projection). | — | Projection job has no write access to lifecycle tables |
| X-10 | A machine never transitions another machine's state directly; it emits an event the owner consumes. | all | Lint rule: no cross-context aggregate writes (`docs/ARCHITECTURE.md` §5.8) |

---

## 10. Persistence mapping

All access through `EntityStore<T>` (never `Repository` — ADR-0001). Single writer: Electron main process. WAL mode. Every state change is one transaction containing the state write, the event append, and any outbox row.

### 10.1 Table ↔ machine map

| Machine | Table(s) | State column | Values stored |
|---|---|---|---|
| `WorkflowTemplateLifecycle` | `workflow_templates`, `workflow_versions`, `workflow_fork_lineage` | `workflow_templates.state` | `draft \| published \| deprecated \| archived` |
| `WorkflowVersionState` | `workflow_versions` | `semver` (presence/absence of `-draft`) + immutability trigger | `draft_version` inferred when `semver LIKE '%-draft'`; else `published_version` |
| `RunState` | `runs`, `run_snapshots`, `checkpoints` | `runs.state` | `IDLE \| INITIALIZING \| DESIGNING_WORKFLOW \| WORKFLOW_REVIEW \| WORKFLOW_PUBLISHED \| PLANNING \| ROUTING \| WAITING_APPROVAL \| EXECUTING \| REVIEWING \| VALIDATING \| REWORK \| FINALIZING \| COMPLETED \| FAILED \| PAUSED \| RECOVERING`（17 态；`resume_point` 记录恢复点） |
| `NodeExecutionState` | `node_executions` | `node_executions.state` | `pending \| ready \| running \| retrying \| succeeded \| failed \| skipped \| cancelled` |
| `HandoffState` | `handoffs`, `handoff_outbox`, `handoff_dedupe` | `handoffs.state` | `prepared \| dispatched \| acknowledged \| effect_applied \| nacked \| retrying \| dead_lettered \| expired \| cancelled` |
| `ChangeProposalState` | `change_proposals` | `change_proposals.status` | `open \| accepted \| rejected \| superseded` (+ `consumed_by_version_id`) |
| `TemplateLockState` | `template_locks` | `scope` + `released_at` | `locked_run` = `scope='run' AND released_at IS NULL`; `locked_global` = `scope='global' AND released_at IS NULL`; `released` = `released_at IS NOT NULL`; `unlocked` = no active row |
| *(supporting)* Metrics projection | `workflow_metrics` | — | per `(version_id, bucket_day)` |
| *(supporting)* Event log | `events` | — | append-only; `event_id`, `type`, `occurred_at`, `trace_id`, `run_id`, `org_id`, `payload_json` |
| *(supporting)* Audit | `audit_log` | — | append-only, hash-chained (`prev_hash`, `entry_hash`) |
| *(supporting)* Migrations | `schema_migrations` | — | `version`, `name`, `checksum`, `applied_at` |

### 10.2 Columns per table

| Table | Columns (abridged, keys marked 🔑) |
|---|---|
| `workflow_templates` | 🔑`id` TEXT PK, `org_id` TEXT, `name` TEXT, `state` TEXT CHECK(state IN ('draft','published','deprecated','archived')), `published_version_id` TEXT NULL, `created_at` TEXT, `updated_at` TEXT, `archived_at` TEXT NULL, `fork_parent_template_id` TEXT NULL, `fork_parent_version_id` TEXT NULL |
| `workflow_versions` | 🔑`id` TEXT PK, `template_id` TEXT FK, `semver` TEXT, `content_hash` TEXT NULL, `graph_json` TEXT, `created_at` TEXT, `change_proposal_id` TEXT NULL, `superseded_at` TEXT NULL, `is_immutable` INTEGER (1 when semver has no `-draft`) |
| `workflow_fork_lineage` | 🔑`child_template_id` TEXT PK/FK, `parent_template_id` TEXT, `parent_version_id` TEXT, `forked_by` TEXT, `forked_at` TEXT, `fork_event_id` TEXT |
| `template_locks` | 🔑`id` TEXT PK, `template_id` TEXT FK, `version_id` TEXT NULL, `scope` TEXT CHECK(scope IN ('run','global')), `reason` TEXT, `locked_by` TEXT, `locked_at` TEXT, `released_at` TEXT NULL, `release_reason` TEXT NULL |
| `change_proposals` | 🔑`id` TEXT PK, `target_template_id` TEXT, `base_version_id` TEXT, `base_content_hash` TEXT, `diff_json` TEXT, `rationale` TEXT, `author` TEXT, `status` TEXT CHECK(status IN ('open','accepted','rejected','superseded')), `decided_by` TEXT NULL, `decided_at` TEXT NULL, `decision_reason` TEXT NULL, `consumed_by_version_id` TEXT NULL, `created_at` TEXT |
| `workflow_metrics` | 🔑(`version_id`,`bucket_day`) composite PK, `run_count` INTEGER, `succeeded_count`, `failed_count`, `timed_out_count`, `cancelled_count`, `success_rate` REAL, `p50_duration_ms` INTEGER NULL, `p95_duration_ms` INTEGER NULL, `cost_usd` REAL, `tokens_in` INTEGER, `tokens_out` INTEGER, `human_interventions` INTEGER, `node_failure_rates_json` TEXT, `sample_size` INTEGER, `sealed` INTEGER |
| `runs` | 🔑`id` TEXT PK, `org_id` TEXT, `template_id` TEXT, `workflow_version_id` TEXT, `snapshot_id` TEXT FK, `state` TEXT CHECK(state IN ('IDLE','INITIALIZING','DESIGNING_WORKFLOW','WORKFLOW_REVIEW','WORKFLOW_PUBLISHED','PLANNING','ROUTING','WAITING_APPROVAL','EXECUTING','REVIEWING','VALIDATING','REWORK','FINALIZING','COMPLETED','FAILED','PAUSED','RECOVERING')), `resume_point` TEXT NULL CHECK(resume_point IS NULL OR resume_point IN ('PLANNING','ROUTING','WAITING_APPROVAL','EXECUTING','REVIEWING','VALIDATING','REWORK','FINALIZING')), `rework_count` INTEGER, `max_rework` INTEGER, `failure_reason` TEXT NULL, `created_at` TEXT, `started_at` TEXT NULL, `finished_at` TEXT NULL, `duration_ms` INTEGER NULL, `attempt` INTEGER, `error_code` TEXT NULL, `cost_usd` REAL, `tokens_in` INTEGER, `tokens_out` INTEGER, `deadline_at` TEXT NULL |
| `run_snapshots` | 🔑`id` TEXT PK, `run_id` TEXT NULL, `workflow_version_id` TEXT FK, `template_lock_id` TEXT, `pack_versions_json` TEXT, `model_bindings_json` TEXT, `memory_view_ref` TEXT, `created_at` TEXT, `verified_at` TEXT NULL |
| `node_executions` | 🔑`id` TEXT PK, `run_id` TEXT FK, `node_id` TEXT, `capability_id` TEXT, `state` TEXT CHECK(state IN ('pending','ready','running','retrying','succeeded','failed','skipped','cancelled')), `attempt` INTEGER, `started_at` TEXT NULL, `finished_at` TEXT NULL, `duration_ms` INTEGER NULL, `output_ref` TEXT NULL, `error_code` TEXT NULL, `error_detail` TEXT NULL |
| `handoffs` | 🔑`id` TEXT PK, `envelope_id` TEXT UNIQUE, `trace_id` TEXT, `run_id` TEXT, `from_role` TEXT, `to_role` TEXT, `intent` TEXT, `payload_json` TEXT, `artifacts_json` TEXT, `constraints_json` TEXT, `deadline_at` TEXT, `budget_json` TEXT, `idempotency_key` TEXT, `attempt` INTEGER, `state` TEXT CHECK(state IN ('prepared','dispatched','acknowledged','effect_applied','nacked','retrying','dead_lettered','expired','cancelled')), `created_at` TEXT, `dispatched_at` TEXT NULL, `settled_at` TEXT NULL, `nack_reason` TEXT NULL, `signature` TEXT |
| `handoff_outbox` | 🔑`id` TEXT PK, `handoff_id` TEXT FK, `enqueued_at` TEXT, `sent_at` TEXT NULL, `state` TEXT CHECK(state IN ('pending','sent','failed')) |
| `handoff_dedupe` | 🔑`idempotency_key` TEXT PK, `handoff_id` TEXT, `consumed_at` TEXT, `result_ref` TEXT |
| `checkpoints` | 🔑`id` TEXT PK, `run_id` TEXT FK, `seq` INTEGER, `last_completed_node_id` TEXT, `node_output_refs_json` TEXT, `memory_view_cursor` TEXT, `created_at` TEXT |
| `events` | 🔑`event_id` TEXT PK, `type` TEXT, `occurred_at` TEXT, `trace_id` TEXT, `run_id` TEXT NULL, `org_id` TEXT, `version_id` TEXT NULL, `payload_json` TEXT, `envelope_version` INTEGER |
| `audit_log` | 🔑`seq` INTEGER PK AUTOINCREMENT, `occurred_at` TEXT, `actor` TEXT, `action` TEXT, `target` TEXT, `detail_json` TEXT, `prev_hash` TEXT, `entry_hash` TEXT |
| `memory_records` | 🔑`id` TEXT PK, `scope` TEXT, `org_id` TEXT, `run_id` TEXT NULL, `content_ref` TEXT, `summary` TEXT, `embedding_ref` TEXT NULL, `provenance_json` TEXT, `confidence` REAL, `sensitivity` TEXT, `created_at` TEXT, `ttl_at` TEXT NULL (see `docs/MEMORY_ARCHITECTURE.md`) |

### 10.3 Index requirements

| Table | Index | Purpose (query it serves) | Type |
|---|---|---|---|
| `workflow_templates` | `idx_templates_org_state(org_id, state)` | list templates by org and lifecycle state | btree |
| `workflow_templates` | `idx_templates_published_version(published_version_id)` | resolve current version for run start | btree |
| `workflow_versions` | `uq_versions_template_hash(template_id, content_hash)` UNIQUE | prevent duplicate publish of the same hash | unique btree |
| `workflow_versions` | `idx_versions_template_semver(template_id, semver)` | version history, semver ordering | btree |
| `workflow_versions` | `idx_versions_proposal(change_proposal_id)` | trace revision → proposal | btree (partial, `NOT NULL`) |
| `workflow_fork_lineage` | `idx_forklineage_parent(parent_template_id)` | descendants / siblings | btree |
| `workflow_fork_lineage` | `idx_forklineage_parent_version(parent_version_id)` | impact-of-version queries | btree |
| `template_locks` | `idx_locks_active(version_id, scope) WHERE released_at IS NULL` | **hot path**: guard evaluation on every mutation/run-start | partial btree |
| `template_locks` | `idx_locks_template_active(template_id) WHERE released_at IS NULL` | global-lock checks for fork | partial btree |
| `template_locks` | `idx_locks_stale(locked_at) WHERE released_at IS NULL` | liveness sweep | partial btree |
| `change_proposals` | `idx_proposals_target_status(target_template_id, status)` | open-proposal lists, supersede scan | btree |
| `change_proposals` | `idx_proposals_consumed(consumed_by_version_id)` | one-shot enforcement | btree |
| `runs` | `idx_runs_state(state)` | engine scheduling and resume scanning (`INITIALIZING`, `PLANNING`, `ROUTING`, `EXECUTING`, `REVIEWING`, `VALIDATING`, `PAUSED`, `RECOVERING`) | btree |
| `runs` | `idx_runs_version_metrics(workflow_version_id, state, duration_ms)` | metrics percentiles without a full scan | covering btree |
| `runs` | `idx_runs_snapshot(snapshot_id)` | snapshot → run resolution | btree |
| `runs` | `idx_runs_inflight_version(workflow_version_id) WHERE state NOT IN ('COMPLETED','FAILED')` | lock release guard (X-08), archive guard (SM-T-06) | partial btree |
| `run_snapshots` | `uq_snapshots_run(run_id)` UNIQUE | one snapshot per run | unique btree |
| `node_executions` | `idx_nodes_run_state(run_id, state)` | DAG propagation, run completion check | btree |
| `node_executions` | `idx_nodes_run_node(run_id, node_id)` UNIQUE | idempotent node planning | unique btree |
| `handoffs` | `uq_handoffs_idem(run_id, from_role, to_role, intent, idempotency_key)` UNIQUE | dedupe scope (FR-10) | unique btree |
| `handoffs` | `idx_handoffs_run_state(run_id, state)` | run `WAITING_APPROVAL` ⇔ open Approval / handoff check (X-03) | btree |
| `handoffs` | `idx_handoffs_deadline(deadline_at) WHERE state IN ('dispatched','retrying')` | deadline/expiry sweeper | partial btree |
| `handoff_outbox` | `idx_outbox_state(state, enqueued_at)` | outbox drain ordering | btree |
| `handoff_dedupe` | PK on `idempotency_key` | exactly-once effect | unique |
| `checkpoints` | `idx_checkpoints_run_seq(run_id, seq DESC)` | resume from the latest checkpoint | btree |
| `events` | `idx_events_run(run_id, occurred_at)` | run timeline | btree |
| `events` | `idx_events_type_occurred(type, occurred_at)` | projections/metrics rebuild | btree |
| `workflow_metrics` | PK `(version_id, bucket_day)` | metric reads | unique |
| `audit_log` | `idx_audit_seq(seq DESC)` | latest-chain verification | btree |
| `memory_records` | `idx_memory_scope_org(scope, org_id)` | scoped retrieval | btree |
| `memory_records` | `idx_memory_ttl(ttl_at) WHERE ttl_at IS NOT NULL` | expiry sweep | partial btree |

**Index budget:** 29 indexes across 16 tables. Partial indexes carry the hot guards so that a mutation's guard check stays a sub-millisecond lookup (NFR §9.1).

---

## 11. Error code registry

Codes are stable identifiers; they are never renumbered, and they appear verbatim in logs, IPC error envelopes, and tests.

### 11.1 The seven spec-mandated codes

| Code | Raised by machine | Trigger | Recoverable | User-facing message (zh/en) |
|---|---|---|---|---|
| `ILLEGAL_TRANSITION` | **`WorkflowTemplateLifecycle`** (also raised generically by every machine on `⊥`) | An edge not present in the transition table is attempted, e.g. `archive` from `published`, or any event from `archived` for a pure lifecycle edge | Yes — the caller must choose a legal command | 「不允许的状态流转」/ "Illegal lifecycle transition" |
| `LOCKED_TEMPLATE` | **`TemplateLockState`** (guard for `WorkflowTemplateLifecycle` + `RunState` creation) | `update`/`publish`/`revise`/`deprecate`/`archive` against a `locked_run` version; `fork` against a `locked_global` template; run start against a locked version | Yes — wait for release/sweep, or transfer per L06 | 「模板已被锁定（进行中的运行）」/ "Template is locked by an in-flight run" |
| `DEPRECATED_TEMPLATE` | **`WorkflowTemplateLifecycle`** (raised on `RunState` creation path, V02) | `run.create` targets a `deprecated` version/template | No — start a run on a live version | 「模板已弃用，无法启动新运行」/ "Template deprecated; new runs refused" |
| `ARCHIVED_READONLY` | **`WorkflowTemplateLifecycle`** | Any command against an `archived` template (absorbing state) | No — read-only forever | 「模板已归档，仅可读取」/ "Template archived; read-only" |
| `SNAPSHOT_MISMATCH` | **`RunState`** (pin verification; also `NodeExecutionState` planning) | A pinned `RunSnapshot` cannot be satisfied: pack version missing, `memoryViewRef` unresolvable, snapshot's version row absent | Partially — restore the pin, or start a **new** run (never re-pin silently) | 「运行快照与当前环境不一致」/ "Run snapshot does not match the current environment" |
| `PROPOSAL_NOT_ACCEPTED` | **`ChangeProposalState`** (guard for `WorkflowTemplateLifecycle.revise`) | `revise` without an `accepted`, unconsumed proposal; second consumption of the same proposal | Yes — open/accept a proposal | 「变更提案未被接受」/ "Change proposal is not accepted" |
| `HASH_MISMATCH` | **`WorkflowVersionState`** (oracle `verify`); raised at `publish` and at `RunSnapshot` verification | Recomputed `contentHash` ≠ stored hash (canonicalization drift, corruption, tampering) | No silent repair — investigate, then publish a new version | 「内容哈希不一致」/ "Content hash mismatch" |

### 11.2 Supporting codes (non-spec, `[DERIVED]`)

| Code | Raised by | Trigger |
|---|---|---|
| `POLICY_DENIED` | Governance (via any machine's authority guard) | Actor lacks the required authority; deny-by-default |
| `VALIDATION_FAILED` | any machine's payload guard | Schema-invalid payload, cyclic graph, unresolvable capability, semver bump too small |
| `STALE_PROPOSAL` | `ChangeProposalState` | Base version no longer exists / was archived |
| `CAPABILITY_UNAVAILABLE` | Capability Registry | No registered capability matches `(contractId, range)` |
| `ORG_NOT_FOUND` | Org context | Org id unresolvable |
| `DUPLICATE_IDEMPOTENCY_KEY` | Handoff persistence | Replay of a consumed key (returns the original result; not a hard failure) |
| `MIGRATION_CHECKSUM_MISMATCH` | `MigrationRunner` | `NNNN_name.sql` checksum differs from `schema_migrations.checksum` ⇒ refuse to open DB |
| `DEADLINE_EXCEEDED` | Run engine / handoff sweeper | Deadline passed (maps to `RunState → FAILED` with `reason='timed_out'` / `HandoffState.expired`) |
| `RETRY_EXHAUSTED` | Node/handoff retry policy | Attempts exhausted ⇒ `failed` / `dead_lettered` |
| `SENSITIVITY_DENIED` | Memory retrieval | Copied/derived content exceeds the caller's clearance (`docs/SECURITY_MODEL.md`) |

**Convention:** the code is a stable contract; the human message is localizable. Logs carry `{errorCode, machine, from, event, traceId}` so a failure is reconstructable from the event log alone.

### 11.3 Reconciliation with the shipped Sprint-0 error taxonomy

The delivered `packages/core/src/kernel/errors.ts` freezes the Sprint-0 `ERROR_CODES` union and every
**additive** revision since. As of **Sprint 8** the shipped union is:

```text
ILLEGAL_TRANSITION · LOCKED_TEMPLATE · DEPRECATED_TEMPLATE · ARCHIVED_READONLY ·
SNAPSHOT_MISMATCH · PROPOSAL_NOT_ACCEPTED · HASH_MISMATCH ·
VALIDATION_FAILED · NOT_FOUND · CONFLICT · NOT_IMPLEMENTED ·
INVALID_ARGUMENT · ALREADY_EXISTS · IMMUTABLE_ENTITY · POLICY_DENIED ·
APPROVAL_REQUIRED · APPROVAL_DENIED · CAPABILITY_MISSING · AGENT_UNAVAILABLE · LIMIT_EXCEEDED ·
PERSISTENCE_FAILED · TIMEOUT · PERMISSION_DENIED ·
MODEL_SELECTION_REQUIRED · ROUTER_NOT_AVAILABLE · CANCELLED · INTERRUPTED ·
MANUAL_NOT_ROUTED · RECOMMENDATION_INVALID ·
SECRET_NOT_FOUND · SECRET_SOURCE_UNAVAILABLE
```

Sprint 1 added the nine codes on line 3–4; Sprint 3 added `PERSISTENCE_FAILED`; Sprint 6 added
`TIMEOUT` and `PERMISSION_DENIED`; Sprint 8 added `MODEL_SELECTION_REQUIRED`, `ROUTER_NOT_AVAILABLE`,
`CANCELLED` and `INTERRUPTED`; Sprint 10A.0.2 added `MANUAL_NOT_ROUTED` (the router refuses to run
for a MANUAL request) and `RECOMMENDATION_INVALID` (a recommendation that failed its own consistency
invariants); Sprint 25 added `SECRET_NOT_FOUND` and `SECRET_SOURCE_UNAVAILABLE` (a `SecretRef` names
something that is not configured vs. the source that should hold it could not be reached — the two
have different operator remedies, so they are never one code, and neither ever degrades into an
empty-string substitution). All additive: renames and retypes remain forbidden.
`docs/tests/error-taxonomy.test.ts` asserts this mirror equals the shipped union, so the mirror can no
longer drift from the machine (AGENTS §0.1).

Two consequences for this document:

1. **The seven spec-mandated codes (§11.1) are exact matches** to the shipped union — no conflict.
2. **Every code in §11.2 is a *proposal*, not shipped.** In particular the shipped code raises `PROPOSAL_NOT_ACCEPTED` for a proposal written against a **stale** base version (`change-proposal.ts`: *"was written against a stale version"*), whereas §11.2 proposes a distinct `STALE_PROPOSAL`. **Resolution for Sprint 1:** keep the shipped behaviour (one code, `PROPOSAL_NOT_ACCEPTED`, with `details.reason='stale_base'`), because splitting a code after it ships is a breaking contract change; §11.2 is amended to mark `STALE_PROPOSAL` as *rejected*. The remaining §11.2 codes (`POLICY_DENIED`, `CAPABILITY_UNAVAILABLE`, `MIGRATION_CHECKSUM_MISMATCH`, `DEADLINE_EXCEEDED`, `RETRY_EXHAUSTED`, `SENSITIVITY_DENIED`, `DUPLICATE_IDEMPOTENCY_KEY`) are added to the union **only** by an explicit, additive revision of `ERROR_CODES` — additive additions are safe; renames and retypes are not.

Also note: the shipped machine exposes `open_revision` / `publish_revision` where this document (following the spec diagram) writes the single capability `revise`; `revise` = `open_revision` + `publish_revision`. See `docs/CORE_BOUNDARIES.md` §10 R8.

## 12. Handoff state machine (Sprint 11, independent)

```text
DRAFT ──▶ READY ──▶ ACCEPTED
              └───▶ REJECTED
DRAFT | READY ──────▶ CANCELLED
READY | ACCEPTED | REJECTED ──▶ SUPERSEDED（仅由新版本替代时）
```

- **完全独立**于 L1 Workflow lifecycle、L2 Template lifecycle、L3 Task/Stage、AgentExecution、
  ToolInvocation 五套状态机；Handoff 的推进**不会**改变它们中的任何一个。
- 非法迁移一律 `CONFLICT`（`details.allowed` 列出合法后继）。
- **`REJECTED / ACCEPTED → SUPERSEDED` 是合法迁移**（返工链必需），但**只允许改 `status`**：
  旧版本业务内容（`objective / summary / refs / risks / next action`）**不可改写**；
  存储层条件 UPDATE 也只放行这一种终态→终态迁移，其余写入 → `CONFLICT`（`TERMINAL_HANDOFF_IMMUTABLE`）。
- 返工必须创建**新版本**（`handoffVersion + 1`，`supersedes = "<id>@v<n>"`），历史只增不改。
- 证据：`packages/core/src/domain/handoff.ts`（`HANDOFF_TRANSITIONS`）、
  `packages/persistence/src/durable/sqlite-handoff-store.ts`、`tests/sprint11/handoff.test.ts`。
