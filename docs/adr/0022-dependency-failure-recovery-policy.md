# ADR-0022：Dependency-Failure Recovery Policy（Sprint 14 — Task-14-01 Architecture Decision）

> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：`TASK-14-01 APPROVED` 指令全文）**。
> Scope：API Error 与 Quota exhaustion 两类**依赖故障**（roadmap T14.2 / T14.3）。
> 配套：ADR-0021（Startup Recovery Orchestration）· `docs/sprint14/S14_RECOVERY_CONTRACT.md`。

## Context

Provider 层已有失败分类（`provider-error.ts`：`rate_limited` / `quota_exhausted` / `timeout` /
`context_limit` / `auth_failed` / … → 归一化 `NormalizedProviderError`，`RETRYABLE_KINDS =
['rate_limited','timeout','unavailable']`，Core 只分类、caller 决定）。但当前**没有任何**
依赖故障的重试编排：失败终止当前 attempt 并 durable 留痕，恢复依赖人工/显式继续。Sprint 14 需要
冻结"API Error / Quota 之后系统如何继续"。

## Decision 1：三条总禁令

# NO PERSISTENT RETRY SCHEDULER
# NO BACKGROUND RETRY LOOP
# NO NEW RETRY STATE

不创建 `WAITING_QUOTA`、`RETRY_SCHEDULED` 之类新状态；不建持久化重试计划、后台重试循环、
定时器轮询、后台 quota watcher。

## Decision 2：API Error

继续使用既有 `provider-error` 分类与 `RETRYABLE_KINDS`，**不新增无限/自动后台重试**。
若 runtime 已存在 bounded in-attempt retry contract（attempt 内有限重试）：preserve it；
否则当前 attempt 终止并 durable 留痕。恢复路径 = 经既有 Run/Task context 的
**显式 continuation/retry**（用户不需要重新描述目标，见 Decision 4）。

## Decision 3：Quota Exhaustion

**不自动重试**。禁止 tight retry loop、startup retry、timer polling、background quota watcher。
Quota 恢复后经既有 durable Run/Task context 显式继续/重试。

## Decision 4：故障上下文保全（Recovery 的核心义务）

API Error / Quota 失败后必须保持：Run identity、Task identity、Stage snapshot、Handoff context、
Artifact references、（如适用）Memory/Decision references。Recovery **不能**要求：new Run、
recreate Task、user retype original goal（规划书 §二 原则 9：不要求用户重新解释目标）。

## Decision 5：事件词汇

优先复用既有 execution failure / provider failure / run recovery 事件词汇。若实现期证明现有
词汇不足以满足 AC14.3（恢复事件可在事件流查到），T14 只能登记 `EVENT_VOCABULARY_GAP`
报告裁定，**不得自行新增事件**。

## Rejected

- 指数退避后台重试（违反三条总禁令；quota 场景重试即自我放大）。
- 新增 retry/quota 持久状态（破坏 17 态 L1 闭集与既有审计词汇）。
- 启动时自动重发失败的 provider 调用（ADR-0021 Decision 3 同源禁令：恢复不重新调用 provider）。

## Consequences

- Sprint 14 的 T14.2/T14.3 验收形态 = 故障注入（模拟 provider 失败）→ attempt 终止 + durable 留痕
  → 上下文保全断言 → **显式**继续后从既有 context 恢复且不重复已完成工作。
- Sprint 6 provider 抽象与错误分类零改动；无新迁移；无新事件。
