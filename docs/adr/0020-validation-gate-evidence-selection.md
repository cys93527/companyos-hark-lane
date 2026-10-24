# ADR-0020：Validation Gate Evidence Selection（Sprint 13B — Task-13-07 Architecture Decision）

> 归属：Sprint 13 / Task-13-07；上游：ADR-0016（Validation Framework——本 ADR 澄清其 gate
> selection）、ADR-0017（Validation Target Binding——本 ADR 澄清其 target-bound revalidation
> selection）。配套实现：`packages/engine/src/validation/evidence-guard.ts`。
> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：本裁定指令）。**

## Context

Task-13-07 开工 recon 发现两个未冻结点（§51 硬停止触发）：R1（required validators 与
blocking 语义的权威源）与 R2（同一 target 多次 re-validation 时哪条 evidence 对 gate 生效）。
本 ADR 记录 Boss 裁定。

## R1 决策：Stage `validatorIds` = Blocking-Required Validators

- **权威源** = Stage snapshot（run 钉定的不可变模板版本图节点）`config.validatorIds`。
  该列表**就是**进入 VALIDATION_PASSED 必须通过的 blocking validator 集合——不新增
  validatorPolicies/blockingByValidator/validatorConfig 对象，不改 Stage schema；
- **非列表 validator 不决定 Stage gate**：non-blocking Validation（WARNING/advisory
  evidence）仍允许产生，但不在 stage.validatorIds 中的 validator 对 Stage PASS/FAIL
  **没有 authority**（caller 也无法借额外插入 blocking=true+FAIL 改变 Stage policy）；
- **Policy/Evidence mismatch fail closed**：stage 要求 V1，durable row 自报
  blocking=false → 拒绝（Stage snapshot 是 policy authority；Validation row 是
  execution evidence，不能自降 requirement）；
- **空 validatorIds**：不自动 VALIDATION_PASSED——Sprint 1 不变量保持
  （无 required evidence ≠ gate 通过），gate 以 VALIDATION_GATE_NO_REQUIREMENTS 拒绝。

## R2 决策：Latest Durable Validation Batch Wins

- **Batch identity** = 同一 `creationCommandId`（一个真实 RunValidation command 产生的
  N 条 Validation）；
- **禁止 latest-per-validator 跨 command 拼证据**（Frankenstein batch）——那组证据从未
  作为真实 plan 原子执行过；Stage gate 只消费**一个真实 durable batch**；
- **Latest batch 是权威**：同 target/run/stage 存在多个 intentional re-validation
  batch 时，gate 只消费 latest——不是 "latest that happens to PASS"；
- **禁止回退旧 PASS**：Batch2(V1 FAIL) 权威 → GATE FAIL，绝不搜索旧 Batch1(V1 PASS)；
- **新 PASS 可恢复**：Batch1(V1 FAIL) → Batch2(V1 PASS) → gate 可通过（intentional
  re-validation 的正式恢复语义）；
- **最新批次缺 required validator** → GATE FAIL，不从旧 batch 借（无跨 batch 拼接）；
- **最新批次的 extra validators**：不在 stage.validatorIds 中 → 忽略其对 Stage verdict
  的决定权（包括 non-required blocking FAIL）；
- **Batch ordering（确定性）**：`batchFinishedAt = max(validation.finishedAt)` DESC；
  平局 tie-break = `max(validationId)` DESC（branded ULID）。禁止 creationCommandId
  字典序（commandId 是幂等身份不是时间）、SQLite insertion order、rowid、无序查询；
- **Candidate scope**：进入竞争前 batch 必须满足 targetRef = 请求 Artifact、runId =
  当前 Run、stageId = gate stage（legacy stageId=null **不可作为** staged gate
  evidence——readable ≠ eligible）；taskId 在 gate 提供时精确匹配（null 非通配符）。
  同 command 出现 mixed target/run/stage/fingerprint → store 层 fail closed（复用
  既有 batch integrity 守卫），不部分使用。

## Caller 边界

- Caller 可表达 **intent**（advance validation / target Artifact A / stage 锚），经既有
  RunCommand.payload 携带 `artifactId`/`stageId`/`taskId`；
- Caller **不得提交 verdict**（validationPassed/qualityGatePassed/validatorsPassed 结构性
  不可读）；**不得选择 batch**（validationCommandId/validationIds/batchId/
  useThisEvidence——guard 自行按 durable history 选 latest，防止故意选旧 PASS）；
  **不得重定义 required validators**（requiredValidators=[V1] 无法覆盖 snapshot [V1,V2]）。

## Version Semantics

Evidence 的 validatorVersion 是历史 execution provenance（ADR-0019）；stage validatorIds
不带 version constraint → registry 当前升级不使旧 evidence 失效；guard 不查 Tool
Registry 重解释 evidence。

## Port Gap 修复（§16 授权的 additive）

`ValidationStorePort.listBatchesByTargetRef(targetRef) → readonly DurableValidationLookup[]`
（复用既有 DurableValidationLookup；无第二套 entity）。Store 返回 durable facts +
corrupt mixed-anchor fail closed；**latest-winner 选择是 Evidence Guard policy，不是
store policy**。Schema 零变更（所需列全部已存在）。

## 算法（§19 冻结全文见裁定指令；实现于 evidence-guard.ts）

authorize（既有）→ state legality（既有 machine）→ artifact 存在+归属 run → stage
snapshot requiredValidators → listBatchesByTargetRef → anchor 过滤 → 唯一 effective
batch（R2-B 排序）→ 逐 required validator 恰一行 + blocking=true + status=pass →
`qualityGatePassed(requiredRows)` 纯终检（§20/21：输入必须是 effective batch 中的
authoritative required rows）→ 才允许既有 VALIDATING→VALIDATION_PASSED transition。

## Rejected

- latest-per-validator 合成 batch（从未原子执行过）
- any-historical-PASS（旧 PASS 无法被新 FAIL 撤销）
- 旧 PASS 回退 / 跨 batch 拼接
- row.blocking 自降 stage policy
- caller 选择 batch / 提交 requiredValidators
- 新状态机 / 新事件（validation.gate.passed 拒绝——复用既有 transition events）
- 新 schema / migration

## 接线

Engine 可选 `validationGate` seam（WorkflowEngineDeps）：存在时 VALIDATION.PASS 命令
在任何写入前经 guard 证明；缺席时 Sprint 2/3 行为不变。真实 stage-policy 读取器
（snapshot → 模板版本图 → 节点 config.validatorIds）由组合根/T11 wiring 提供；
guard 本体 persistence-blind。
