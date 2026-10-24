# ADR-0018：Durable Tool Invocation Replay Output（Sprint 13B Corrective）

> 归属：Sprint 13 / Task-13-06 corrective；上游：ADR-0013（Tool Registry 与受控调用）、
> ADR-0016（Validation Framework——本 ADR 澄清其 crash recovery）。
> 配套：`migrations/tools/0004_invocation_replay_output.sql`。
> **Status: Accepted（2026-09-25，Boss Architecture Decision——acceptance authority：本 corrective 指令）。**

## Context

Sprint 9 持久化了 `output_digest` 但**没有**可重放的 output：`replayOutcome` 返回
`output: null`。结果：幂等调用防止了重复执行（execution idempotency = YES），
但无法重放成功结果（result replayability = NO）。对 Validation 这直接导致
「validator 执行成功 → Validation 事务崩溃 → retry → 无法重建原 PASS/FAIL/SKIPPED/report」。

## Problem

Idempotent invocation prevents re-execution but cannot replay the successful result.

## Decision

Persist a **replayable successful Tool output snapshot atomically with the terminal
invocation state**（`replay_output_json`，tools 链 additive migration 0004）：

- **原子性**：snapshot 与 COMPLETED 状态、outputDigest、finishedAt 在**同一 terminal
  upsert** 中写入——不存在「成功已提交、snapshot 后补」的窗口；
- **写时无损校验**：registry 仅在 `JSON round-trip 后 digest 不变`时持久化 snapshot；
  无法无损恢复的奇异 output 不写 snapshot（replay 时 fail closed，绝不谎报）；
- **Replay 语义**：幂等命中且 prior COMPLETED → 读取 snapshot → 反序列化 →
  `digestInput(snapshot) === outputDigest` 校验 → 返回**原逻辑 ToolResult.output**；
- **时间戳溯源**：`ToolInvocationOutcome.startedAt/finishedAt` 来自 durable invocation
  行——replay 恢复**原执行时间**，不是 retry 时钟；
- **工具中性**：恢复的是原 ToolResult.output 本体——Tool Registry 不知道 Validation
  domain（validator envelope 的 decode 仍归 ValidationService）。

## Integrity

Replayed output must match the durable `output_digest`：
- mismatch → `PERSISTENCE_FAILED / TOOL_REPLAY_OUTPUT_CORRUPT`（fail closed）；
- 绝不调用 adapter 重新生成结果来"修复"。

## Compatibility

- 历史（pre-0004）COMPLETED 行无 snapshot → replay fail closed：
  `TOOL_REPLAY_OUTPUT_UNAVAILABLE`（ValidationService 将其映射为
  `VALIDATION_VERDICT_UNRECOVERABLE`——legacy/integrity 恢复路径，**不再是正常
  crash-retry 行为**）；绝不以 `output: null` 伪装成有效成功 replay；
- FAILED invocation 的既有错误重放行为保持（本 corrective 不为其添加成功 output）；
- WAITING_APPROVAL 在真正执行前无 snapshot；approve 后真实执行成功即写入 snapshot，
  随后同 idempotencyKey retry 返回原 output（端到端测试锁定）。

## 已知边界

**Version provenance completed by ADR-0019（2026-09-26）**：`tool_invocations`
增 durable `tool_version` 列（tools/0005，创建时捕获、历史保持 NULL 不回填）；
Validation 的 validatorVersion / report producedBy / 首执行一致性检查 / approve 漂移检查
均由 ADR-0019 冻结。本 ADR 报告的 version provenance gap 已关闭。

## Data Security Boundary

Snapshot 只进 `tool_invocations` durable state——**不进**日志 / event payload /
command ledger（既有 SQLite trust boundary 不变）。

## Rejected Alternatives

- **Validator-specific verdict cache**（Option B）：ToolInvocation 本就是
  tool execution + idempotency + durable outcome 的载体；再造 Validator cache 形成双 SoT；
- **Partial Validation commits**（Option C）：逐 validator 提交会引入半批次 durable
  evidence，破坏已冻结的 batch atomicity（N rows + N events + 1 ledger 同一 UoW）；
- **Silent output=null replay**：现状缺陷，正是本 ADR 消除的对象。

## Consequences

ValidationService crash-retry 完整闭环：tool 执行一次 → snapshot durable →
Validation UoW 失败 → retry → adapter 零重执行 → 原 verdict/report descriptor 恢复 →
deterministic report artifact 复用 → batch 提交。Malformed output 的 replay 同样确定
性重映射为同一 error 证据（不重执行）。
