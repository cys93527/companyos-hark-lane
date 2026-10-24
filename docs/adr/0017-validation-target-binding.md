# ADR-0017：Validation Target Binding（Sprint 13A Reconciliation）

> 归属：Sprint 13A 架构裁定后续（CASE 3 reconciliation）；上游：ADR-0015、ADR-0016。
> 配套：`../sprint13/S13_VALIDATION_CONTRACT.md`（targetRef 术语已同步）、`../sprint13/S13_WORKFLOW_INTEGRATION.md` §3。
> **Status: Accepted（2026-09-18，Architecture Reconciliation Decision——acceptance authority：Boss 指令）。**

## Context

Task-13-02 review 发现的 CASE 3 mismatch：Sprint 1 冻结的 `Validation` 契约没有显式的
`targetRef` 字段，也没有把任何现有字段（含 `evidenceRefs` 中的 `artifact:<id>`）定义为
canonical target anchor（证据：`validation.ts` 全文无 target 概念；`VALIDATION_EVIDENCE_PATTERN`
将 `artifact:` 与 `command:` 证据平级；`qualityGatePassed` 无 target 维度；生产代码零消费
evidenceRefs）。而 Accepted Sprint 13 架构要求 `VALIDATION_PASSED` evidence guard 精确判定
"validation belongs to Artifact A"——同一 run/task 下必须可区分 Artifact A 与 B
（runId/stageId/taskId 不足以表达该绑定）。

## Problem

S13 evidence guard（ADR-0016 D11 第 9 项 wrong-Artifact 拒绝）在 Sprint 1 契约下无法不靠猜测实现：
target ≠ evidence，但 target 只能混在 evidenceRefs 里被"猜"出来。

## Decision

1. **Domain additive extension**（不重设计、无第二套模型）：`Validation` 增
   `targetRef: ValidationTargetRef | null`；`ValidationTargetRef` 为受控品牌化类型，
   Sprint 13 唯一形态 `artifact:art_<ulid>`（`artifactTargetRef()` 构造 + `isValidationTargetRef()`
   结构守卫）。Core 只验证结构，不解析 SQLite/filesystem/ArtifactStore。
2. **Legacy compatibility**：`targetRef = null`（或缺省）保留 Sprint 1 兼容；
   `createValidation` 既有调用不受影响。
3. **Sprint 13 rule**：新建 durable Artifact Validation **必须**携带 targetRef；legacy
   untargeted validation 永远不能作为 T07 `VALIDATION_PASSED` 的 targeted evidence
   （Service 层 fail closed，未来实现）。
4. **Cardinality 冻结**：one RunValidation command → **exactly one targetRef** →
   one or more validators → N Validation rows。multi-target 需另立 ADR。
5. **Uniqueness 不变**：partial `UNIQUE(creation_command_id, validator_id)` 保持——
   **禁止**把 target_ref 加进唯一键（那会允许 same command/same validator/different target，
   与 cardinality 冲突）。
6. **Batch integrity**：同 commandId 的全部 rows 必须同 fingerprint **且**同 targetRef；
   `getByCreationCommand` 对 mixed fingerprint（既有）与 mixed targetRef（新增
   `VALIDATION_BATCH_TARGET_MISMATCH`）一律 fail closed。
7. **Persistence**：corrective migration `artifact/0002_validation_target_ref.sql`
   （nullable `target_ref` 列 + `idx_validations_target(target_ref, created_at DESC, validation_id)`；
   不修改已提交的 0001）；`ValidationStorePort` 增 `listByTargetRef(targetRef)` 精确 target 查询；
   adapter 全方法 round-trip targetRef 并恢复时结构重验（corrupt → `VALIDATION_ROW_CORRUPT`）。
8. **qualityGatePassed 保持纯函数**：target evidence resolution（filter/verify targetRef）属
   Application/Engine 层（T07），不进 SQLite、不进 domain 纯函数。

## Compatibility

- Sprint 1：`createValidation` 既有调用零破坏（targetRef 可选，缺省 null）；既有 972 用例零修改。
- Schema：0001 checksum 不动，0002 纯加法（ADD COLUMN nullable + index）。
- 命名统一：S13 文档术语同步为 **targetRef = validated Artifact identity；evidenceRefs = evidence
  supporting the validation result**——禁止混写。

## Rejected Alternatives

- **Target hidden inside evidenceRefs**（Option 2）：target ≠ evidence；T07 不得从混合
  evidenceRefs 中猜被验证对象。
- **Run-level-only guard**（Option 3）：wrong-Artifact 精确拒绝是 Accepted 验收标准，不降级。
- **Multi-target command**：Sprint 13 不隐式支持；需要时另立 ADR。
- **UNIQUE 加入 target_ref**：与 one command → one target 冲突。

## Consequences

T07 可实现性恢复：`listByTargetRef(artifact:A)` 给出精确属于 A 的 durable validations，
再依次验证 runId/targetRef/required validators/quality gate → wrong-Artifact 可精确拒绝。
`DurableValidationLookup` 增 `targetRef` 字段（批次级，null = legacy）。

## frozenAreas

targetRef 唯一形态 `artifact:art_<ulid>`；legacy null 语义；cardinality
（one command → one target）；唯一键不含 target_ref；batch 双一致性守卫
（fingerprint + target）；targetRef ≠ evidenceRefs 术语边界。

## Gate Selection Clarification

**target-bound revalidation selection clarified by ADR-0020（2026-09-26）**：同一
targetRef 存在多个 re-validation batch 时，Stage gate 只消费 **latest durable
RunValidation batch**（batchFinishedAt=max(finishedAt)，tie-break max(validationId)）；
禁止跨 batch 拼接与旧 PASS 回退；legacy stageId=null 不可作为 staged gate
evidence。详见 `docs/adr/0020-validation-gate-evidence-selection.md`。

## revisitWhen

multi-target validation 需求（→ 另立 ADR）；非 artifact 类 target（如 tool output、
document）进入验证范围（→ 扩展受控 ref 形态，另立 ADR）。
