# ADR-0016：Validation Framework（Sprint 13A — 只冻结设计，不实现）

> 归属：Sprint 13A；规划书 §三十二（Validation System，repository-native 摘要见
> `../spec/S13_ARTIFACT_VALIDATION_CANONICAL_REQUIREMENTS.md`）。
> 上游：ADR-0002/0003/0006、ADR-0013（Tool Registry）、Sprint 12 Memory/Decision 冻结面。
> 姊妹篇：ADR-0015（Artifact Model）。配套契约：`../sprint13/S13_VALIDATION_CONTRACT.md` ·
> `../sprint13/S13_WORKFLOW_INTEGRATION.md`（evidence guard 与兼容矩阵）。
> **本 ADR 只冻结架构决策。Sprint 13B 分 Task 实施（已批准，逐 Task 审核）。**
>
> **Amended by ADR-0017（2026-09-18，Validation Target Binding）**：本 ADR 的 D11 evidence guard
> 依赖的 "Validation belongs to Artifact A" 精确判定，由 ADR-0017 的 `targetRef` additive
> extension 实现（Sprint 1 契约原无显式 target 概念——CASE 3 reconciliation 记录见 ADR-0017）。
>
> **Tool invocation crash recovery clarified by ADR-0018（2026-09-25，Durable Tool Invocation
> Replay Output）**：幂等 invocation 现持久化可重放的成功 output snapshot——validator
> crash-retry 恢复原 verdict/report descriptor（不再需要 VALIDATION_VERDICT_UNRECOVERABLE
> 作为正常路径；该错误仅保留为 legacy/缺失 snapshot 的 fail-closed 恢复路径）。
>
> **Gate selection clarified by ADR-0020（2026-09-26，Validation Gate Evidence
> Selection）**：D11 evidence guard 的 required-validator 权威源（stage snapshot
> validatorIds = blocking-required）与 re-validation evidence 选择规则（latest durable
> batch wins，禁止跨 batch 拼接与旧 PASS 回退）由 ADR-0020 冻结。
> **Version provenance completed by ADR-0019（2026-09-26，Tool Invocation Version
> Provenance）**：Validation.validatorVersion 与 report producedBy 的权威源 = durable
> ToolInvocation.toolVersion（创建时捕获；历史 NULL 不回填，消费侧 fail closed）；
> 首执行 descriptor/invocation 版本漂移与 approve 前版本漂移均 fail closed。

## Status

**Accepted（2026-09-18，Sprint 13A 最终架构评审）**。Acceptance basis：Sprint 1 frozen Validation
contract preserved（零字段变更、WARNING 组合语义）· ValidationService boundary frozen ·
evidence-backed VALIDATION_PASSED frozen · Validator produces evidence not decisions ·
Tool Registry risk gate reused · permanent creation idempotency Option B frozen
（bounded-retention conflict closed）· no architecture-blocking open questions remain。
实现属 Sprint 13B（已批准，逐 Task 审核制）。

## Context

Sprint 1 已冻结 `Validation` 契约（证据门 + blocking 质量门）但生产零接线；L1 已冻结 `VALIDATING` 态
与 `VALIDATION_PASSED/FAILED` 转移，事件目录预留 `validation.recorded`（发射方 `validators:S13`）；
Stage 声明面（`SET_VALIDATOR`/`validatorIds`）自 Sprint 5 存在；Tool Registry（S9）提供受控执行通道。
Boss 裁定：复用既有契约、additive integration。原始需求来自规划书 §三十二（已入库摘要）。

## Existing Sprint 1 Contract

`packages/core/src/domain/validation.ts`：`Validation { id, runId(必填), stageId|null, taskId|null,
validatorId, validatorVersion(必填), status ∈ pass|fail|error|skipped, command|null, exitCode|null,
blocking(默认 true), evidenceRefs(`artifact:<id>`/`command:<name>` 可寻址), startedAt, finishedAt }`；
不变量：pass 必须有证据（exitCode 0 或 ≥1 evidenceRef——空口 pass = `VALIDATION_FAILED`）；
fail 不得带 exitCode 0；`qualityGatePassed` = 存在 blocking 且全部 pass（无 blocking 不算通过）。
**本 ADR 全部决策以此为起点。**（字段面修订：ADR-0017 为 evidence guard 需求 additive 增补
`targetRef`——legacy null 兼容，domain 形状不重设计；见该 ADR 的 CASE 3 reconciliation 记录。）

## Decision（13 项冻结）

1. **Reuse Sprint 1 Validation contract**：零重设计；issues 不加（无契约字段、无消费方）。
   Additive 例外：`targetRef`（ADR-0017，见上）。
2. **No second ValidationResult model**：持久化 = `validations` 表 1:1；`ReportArtifactDescriptor`
   是 Validator 返回值 DTO，不是第二套持久化实体。
3. **Statuses remain `pass/fail/error/skipped`**：语义冻结——fail = validator 正常执行但目标不满足；
   error = validator 自身无法完成验证（两者严格区分，Sprint 1 已内置）；skipped 不计入门；
   error 视同不通过（无有效证据不得放行）。
4. **warning = fail + blocking:false**：不新增状态；组合语义由文档与测试锁定；
   `qualityGatePassed` 只统计 blocking 的既有实现天然保证 WARNING 不影响门。
5. **Validator produces evidence, not workflow decisions**：Validator 无 block/retry/manual-review
   参数或权限；transition 由 Workflow/Policy 层控制；S13 失败词汇 = block + warn（retry/manual-review
   由既有引擎语义涌现：返工预算、REWORK_EXHAUSTED→PAUSED、Tool 风险门）。
6. **ValidationService = application service**（Option B）：`createValidationService()`
   （`packages/engine/src/validation/`，先例同 handoff-service）；引擎不内建验证阶段（Option A 拒——
   改冻结引擎且外部命令执行不属于确定性事务边界）；事件消费者模式拒（事件是审计不是编排）。
7. **Validator resolution is controlled**：显式 validator capability registration——**不是所有 Tool
   自动都是 Validator**；`validatorIds` 解析时按 capability 过滤（未声明即拒，fail closed）；
   Renderer/外部 payload 不得动态注入 executable validator；Core 不做 validator 类型分类学
   （validatorId 不透明，具体类型属 Pack）。
8. **Tool Registry risk gate reused**：命令型 validator 只经 Tool Registry 受控执行
   （registration/authority/risk level/approval/idempotency/audit，S9 全套）；**不建第二套
   Validator executable runtime**；禁止 `Validator → arbitrary command execution`。
9. **Validator cannot directly persist Artifact**：Validator → 返回 result + optional
   `ReportArtifactDescriptor` → ValidationService → ArtifactService → ArtifactStore/CAS 物化
   （`producedBy = validator:<id>@<version>`）。Validator 禁止直访 SQLite/ArtifactStore/CAS/
   Workflow/Memory/Decision/Provider。Memory provenance 同理只加引用不迁移内容
   （additive：+ARTIFACT、兑现 VALIDATION verifier）。
10. **Validation durable before workflow evidence use**：Validator 返回值 = transient；
    durable record 是唯一事实；只有持久化成功后才能作为 `VALIDATION_PASSED` 证据。
11. **VALIDATION_PASSED must be evidence-backed**：11 项证据守卫（WORKFLOW_INTEGRATION §3）——
    durable record 存在 / targetRef 对应 Artifact / Run 归属正确 / stage 要求的 validator 满足 /
    validator identity 正确 / qualityGatePassed / blocking FAIL 拒 / ERROR 拒 / wrong-Artifact 拒 /
    wrong-Run 拒 / caller 自造 status 不信。引擎侧唯一新增 = 该载荷守卫（不改 L1 转移表、不新增状态、
    不把 SQLite query 塞进纯 Core 状态机——evidence resolver 在 App/Engine 层，纯判定留在 Core）。
12. **Same-command retry is idempotent；intentional re-validation uses new commandId**：
    same commandId + same target + same validator → 复用既有 durable Validation（command ledger 语义），
    不得插新行；新 commandId → 允许再验证并产生新 durable evidence（append-only）；
    **禁止 `UNIQUE(artifactId, validatorId)`**；validationId 由 ValidationService 在 command 执行内
    生成（makeId 约定）；validator identity/version 复用 Tool Registry identity（不建第二套 version 系统）。
13. **commandId 幂等 = ledger 快照（有界窗口）+ row-level permanent creation identity（双轨，与
    ADR-0015 决策 15 同构；Boss Blocker 裁定 = Option B）**：ledger 幂等窗口有界（每次 dispatch 后
    trim，默认 1000 条，engine.ts:173/:491 实证）⇒ 单靠 ledger 不能支撑 unconditional
    "same commandId retry never duplicates"。因此 `validations` 表增
    `creation_command_id TEXT` + `creation_command_fingerprint TEXT`（persistence metadata，非 domain
    字段）+ **partial unique index `UNIQUE(creation_command_id, validator_id) WHERE
    creation_command_id IS NOT NULL`**——粒度为 (command, validator)：同 command 批次内每个 validator
    一行（RunValidation 一次执行 N 个 validator = 一个逻辑操作产 N 行证据），同 command 重试不产生
    第二组；intentional re-validation 用新 commandId → 新组行，无冲突。服务 retry lookup 三级顺序
    （冻结）：① ledger.get 命中 → fingerprint 比对（同 → 返回整组 validationIds / 异 → CONFLICT）→
    ② ledger miss（已 trim）→ 按 `creation_command_id` 查行组（命中 → fingerprint 比对：同 → 返回既有
    validationIds，**不创建第二组**；异 → CONFLICT）→ ③ 都 miss → 正常执行。**不加第三张表**；
    ledger bounded 语义零改动；trim 后 Case 3 见 Failure/Recovery Model。
    - **Batch outcome（Accepted contract 补充）**：一次 RunValidation 可执行 N 个 validator 产生
      V1…VN——因此 ledger 的 durable `outcome_json` **必须携带该 command 的完整 validationId set**，
      **不得只记录单个 validationId**；同 command retry 必须恢复同一组 identities
      （row-level `UNIQUE(creation_command_id, validator_id)` 继续成立）。

## Alternatives Considered

| 议题 | 备选 | 裁定理由 |
|---|---|---|
| 集成架构 | A: Engine 内建阶段；C: Event-driven consumer | A 改冻结引擎、把外部命令执行塞进确定性事务边界；C 与"事件是审计不是编排"（Sprint 2 冻结）冲突；B 与 handoff/router/lifecycle 服务先例同构 |
| WARNING 表达 | 新增 `warning` 状态 | 破坏 Sprint 1 闭集；`fail+blocking:false` 组合已完整表达且零迁移成本 |
| Validator 执行 | 自建 executable runtime / 任意命令执行 | 绕过 S9 authority/risk/approval/audit 全套门禁；capability 过滤 + Tool Registry 复用零新风险面 |
| 报告产物 | Validator 直写 ArtifactStore/CAS | 耦合 persistence adapter、破坏 side-effect constrained/auditable/testable（Boss 修正 3） |
| 幂等 | `UNIQUE(artifactId, validatorId)` | 永久阻止 intentional re-validation；区分两种情形（D-12）后无此需求 |
| validator version | 新建 version 系统 | Tool Registry identity 已稳定；复用（不足时最小新增须 13B 说明） |
| 事务 | 超长事务（创建+执行+转移一个事务） | 外部命令执行不可入事务；分段使 retry/crash/audit/幂等各自清晰 |
| commandId→validationId 映射 | 第三张映射表 / 新幂等系统 | 现有 `command_ledger.outcome`（不透明 owner-defined JSON 快照）即 durable 载体，且 ledger.put 已纳入既有事务纪律（Sprint 3 先例）；复用零新表 |

## Consequences

- 正面：L1 预留态与事件全部兑现；Stage 声明的 validator 首次有运行时消费；质量门从"纯函数"变为
  durable 证据驱动的真实门；防自declare pass 有结构性防线（证据守卫）。
- 代价：VALIDATING 态进入真实路径后，返工循环（REWORK）首次对真实生产可用——返工预算语义需在
  13B 测试中实测；evidence resolver 是引擎与 durable 层之间的新边界（有明确职责：查询与归属校验，
  不做 policy 判定）。

## Compatibility

additive（矩阵详见 `../sprint13/S13_WORKFLOW_INTEGRATION.md` §5）：Engine 仅加证据守卫（载荷校验扩展，
L1 转移/事件目录零改动）；Memory 仅 provenance 闭集 +ARTIFACT + verifier 兑现（content model/ownership/
write/durability 不变）；Handoff/Decision 引用消费侧加存在性校验（schema 零变更）；Tool Registry 加
capability 声明面；组合根 chains 11→12。既有 972 测试零删除。**无 breaking change。**

## Security

Must Solve：R-03 validator 注入（capability 注册 fail closed）· R-06 caller-declared PASS
（evidence guard 11 项）· R-08 wrong evidence reuse（绑定校验）。Mitigate：R-10/R-11/R-12（ oversized/
JSON bomb/unsafe metadata——复用既有 IPC 传输上限与 schema 校验先例）· R-18 forged evidence ·
R-20 validator 超时/资源（Tool Registry timeoutMs/风险门）。全部负例见 `../sprint13/S13_TEST_STRATEGY.md` §8。

## Failure / Recovery Model

- **事务边界（三段，不做超长事务）**：① 报告物化（ArtifactService 独立事务）→
  ② Validation durable record + `validation.recorded`（一个 UnitOfWork；多 validator 逐个独立事务，
  一个失败不回滚其他证据——证据只增不减）→ ③ `VALIDATION_PASSED/FAILED` command（引擎既有事务边界，
  单独消费 durable evidence）。收益：retry/crash recovery/audit/idempotency 各自清晰。
- 事件落点：durable 先于 observable（禁止 emit 后再持久化 = phantom）；复用既有 `defineEvent` +
  `events.append` + UnitOfWork；不引入 event bus/queue/outbox/broker（现有机制充分）。
- `validation.recorded` payload 白名单：validationId/runId/stageId/validatorId/validatorVersion/
  status/blocking/exitCode/evidenceRefCount/traceId——无内容正文、无完整 evidence 数组。
- 崩溃恢复：Validation 侧无 CAS 介质（纯 SQLite 行）→ 既有 UnitOfWork 原子性覆盖；
  报告物化的崩溃面归 ADR-0015 Case A–E；**commandId retry 的 crash cases**（Option B 双轨语义）：
  Case 1 row+ledger 同事务成功 → retry（任一级命中）返回同一组 validationId；Case 2 事务 rollback →
  row 与 ledger 都不存在；**Case 3 ledger 后来被 trim → retry 查 `creation_command_id` 行组命中 →
  fingerprint 相同返回既有 validationIds（不产生第二组）、不同 CONFLICT fail closed**——permanent
  idempotency 不依赖 ledger 窗口；Case 4 intentional re-validation 用新 commandId → 新 validationId
  组（append-only）；Case 5 same commandId + different fingerprint → CONFLICT fail closed
  （窗口内由 ledger fingerprint、窗口外由行上 fingerprint 判定）。

## Risks

- 证据守卫过严误拒 / 过松放水（缓解：§5 正负例矩阵全量测试 + 既有 run 套件零回归）；
- 返工循环首次真实化（缓解：T13-07 专项返工预算测试）；
- `MEMORY_SOURCE_TYPES.ARTIFACT` 属 Memory 闭集变更（缓解：additive、A–AZ 套件零回归、
  verifier 存在性校验杜绝悬空）。

## Rejected Alternatives

第二套 ValidationResult / `warning` 新状态 / Engine 内建验证阶段 / 事件驱动消费者 /
Validator 自建执行通道或任意命令执行 / Validator 直写 ArtifactStore/CAS/SQLite /
UNIQUE(artifactId, validatorId) / 超长事务 / LLM-as-judge（S13 禁止，解禁需新 ADR + Boss 批准）/
第二套 validator version 系统 / 事件总线或 outbox。

## Open Questions

无 architecture-blocking open question。以下为 Implementation Verification Item（13B 实施期验证，
不影响本 ADR 核心边界）：

| # | 事项 | 归属 |
|---|---|---|
| IVI-3（原 OQ-4） | Tool Registry 记录是否需要显式 version 列（预期不需要；核实后回填，不足则最小新增并说明） | 13B T05 |
| IVI-4（原 OQ-5） | validator capability 声明面的 IPC 暴露形态（注册面板 UI 属 Sprint 29，S13 仅服务层） | 13B T05/T11 |

（外部规划书入库问题 OQ-1 已由 Boss 裁定关闭：NO——见 ADR-0015 Open Questions。）
