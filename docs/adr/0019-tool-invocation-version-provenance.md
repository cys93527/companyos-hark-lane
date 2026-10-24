# ADR-0019：Tool Invocation Version Provenance（Sprint 13B Corrective）

> 归属：Sprint 13 / Task-13-06 最终 corrective；上游：ADR-0013（Tool Registry）、
> ADR-0016（Validation Framework）、ADR-0018（Durable Tool Invocation Replay Output——
> 本 ADR 补全其已记录的 version provenance 缺口）。
> 配套：`migrations/tools/0005_invocation_version_provenance.sql`。
> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：本 corrective 指令）。**

## Context

Invocation output is now replayable (ADR-0018), but the executed Tool version was not
durable：`tool_invocations` 只存 `tool_id`；replay 路径的 validatorVersion 只能取 retry
时 registry 的当前版本。

## Risk

Crash retry could attribute v1 output to a current v2 registration——审计证据的版本
provenance 失真；report 物化的 `producedBy` 在漂移下会改变嵌套命令 fingerprint 导致
CONFLICT（错误行为）。

## Decision

Persist `toolVersion` on ToolInvocation and use it as execution provenance：

- **Capture point**：invocation **创建时**从实际执行的 ToolRecord.version 捕获
  （WAITING_APPROVAL / FAILED / COMPLETED 全都从创建起就知道目标版本）；caller 与
  validator output 均无法提供；
- **权威源切换**：Validation.validatorVersion 与 report producedBy 一律来自
  `outcome.toolVersion`（= durable invocation 版本）；resolver descriptor 仅用于
  preflight/解析元数据；
- **首执行一致性**：fresh 执行时 descriptor 版本 ≠ invocation 版本 → FAIL CLOSED
  （`VALIDATION_VERSION_PROVENANCE_DRIFT`——resolve 与 execute 之间身份漂移）；
  **replay 允许不同**（durable v1 invocation 胜过当前 v2 resolver——fingerprint 刻意
  不含版本，这正是冻结设计的直接结果）；
- **Report producedBy 连锁**：retry 在 registry 漂移下仍写
  `validator:<id>@<v1>`，嵌套 deterministic report command 的 fingerprint 保持稳定，
  同一 report Artifact 复用。

## Legacy

Unknown stays NULL；**never backfill from current registry**——当前 ToolRecord.version
不能证明历史 invocation 实际执行的版本（§5 recon：历史行无可确定性证明原始版本的
durable 字段）。UNKNOWN 比伪造 provenance 正确。Validation 消费 legacy null 版本 →
FAIL CLOSED（`VALIDATION_VERSION_PROVENANCE_UNRECOVERABLE`，绝不以当前版本顶替）；
通用 Tool replay 保持 `toolVersion: null` 兼容返回（不强迫非 Validation 历史 replay 失败）。

## Validation

validatorVersion comes from the durable invocation（fresh = 实际执行版本；
replay = durable 原版本）；`validation.recorded` 事件版本随之正确（不在 event 层重查
registry）。

## Approval

Version drift before deferred execution fails closed：WAITING_APPROVAL invocation 携带
创建时版本；approve 时加载当前 registration——若版本漂移 → `CONFLICT /
TOOL_INVOCATION_VERSION_CHANGED`（绝不静默以 v2 执行还记成 v1/v2）。要执行新版本必须
走新的 logical execution / command identity。

**Final-review clarification**：A deferred invocation with unknown durable tool version
MUST NOT be approved/resumed into execution. Unknown historical provenance is never
substituted with the current registry version — legacy WAITING + toolVersion=null →
approve FAIL CLOSED（`TOOL_INVOCATION_VERSION_UNRECOVERABLE`，零 adapter 调用、状态
保持 WAITING、null 不回填）。与 COMPLETED legacy replay（已完成结果的兼容返回
outcome.toolVersion=null，由上层决定是否接受）不同：WAITING 意味着**即将发生新的实际
执行**，因此更严格。

## Rejected Alternatives

- **Current registry fallback**：把 retry 时当前版本写进证据——正是本 ADR 消除的失真；
- **Version in RunValidation fingerprint**：会令 registry 升级后的历史成功命令 replay
  变成 CONFLICT——违反已冻结设计（fingerprint 只表达 caller 命令语义）；
- **Version in invocation idempotency key**：同理——我们要的正是历史成功 invocation
  在升级后仍被 replay；
- **历史版本回填**：伪造 provenance。

## Consequences

crash-retry 全链 provenance 闭环：adapter 零重执行 + 原 output/verdict/report
descriptor 恢复 + validatorVersion/时间戳/producedBy 全部来自 durable invocation
+ 同一 report Artifact 复用 + batch 提交。
