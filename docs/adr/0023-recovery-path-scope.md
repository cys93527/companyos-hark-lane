# ADR-0023：Recovery Path Scope（Sprint 14 — Task-14-01 Architecture Decision）

> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：`TASK-14-01 APPROVED` 指令全文）**。
> Subject：roadmap T14.5 恢复路径链条的真实运行时范围。
> 配套：ADR-0021 · ADR-0022 · `docs/sprint14/S14_RECOVERY_CONTRACT.md`。

## Context

规划书 §四十五 / roadmap T14.5 的恢复链条为：
`RECOVERING → Last Event → Workflow Run → Task → Handoff → Workspace → Artifact → Continue`。
Recon（Task-14-01 前置 planning）证实：**Workspace 在当前 runtime domain 不是实体**
（无类型、无表、无端口；`docs/WORKSPACE_GOVERNANCE.md` 是 git worktree 治理文档，非运行时概念）。

## Decision 1：Workspace 裁定

# 不创建 Workspace entity
# 不创建 Workspace table
# 不创建 placeholder runtime state

roadmap 恢复链中的 Workspace = **conceptual working context，非当前 runtime entity**；
Sprint 14 实现层面为 **NO-OP / DEFERRED**。未来若需要 runtime Workspace，必须独立 architecture
decision（登记 Deferred Work）。

## Decision 2：运行时恢复上下文链（冻结）

Sprint 14 实际恢复 context chain 冻结为：

```text
Last Durable Event
→ Workflow Run
→ Task
→ Handoff context（如存在）
→ Artifact references（如存在）
→ Continue
```

## Decision 3：Handoff 在恢复中的语义

Handoff = **context reference**。恢复**不要求** create new Handoff / rewrite Handoff /
advance Handoff state。Run/Task 无 Handoff 时恢复不得因此失败——除非真实 workflow contract
明确该 Stage 要求 Handoff。

## Decision 4：Artifact 在恢复中的语义

Artifact = **durable prior-work identity**。恢复 **reuse existing Artifact refs**；
禁止 recreate / copy / mutate Artifact。Sprint 13 permanent creation identity（`creation_command_id`
+ fingerprint + 行级 UNIQUE）继续权威——恢复后的续作创建新 Artifact 天然去重安全。

## Decision 5：无新持久化

# New table: NONE
# New column: NONE
# New migration: NONE

Sprint 14 Recovery 完全建立在现有 `runs` / `tasks` / `events` / agent executions /
tool invocations / `approvals` / `handoffs` / `artifacts` / `validations` 之上。
CommandLedger = retry cache（非永久恢复真相）；永久依据 = entity 行、execution 行、event
history、permanent creation identity。

## Rejected

- 为 T14.5 链条新建 Workspace 概念（当前无消费方；扩 scope 无收益）。
- 恢复时重建/复制 Artifact（破坏 Option A 不可变与 permanent identity 幂等）。
- 恢复时推进 Handoff 状态（Handoff 转移属于业务流转，不属于恢复）。

## Consequences

- roadmap T14.5 的实现范围 = Decision 2 链条；Workspace 段落以 "conceptual / deferred" 注记，
  Mission 不变。
- Sprint 13 的 CAS reconciliation、EvidenceGuard、DurableReferenceResolver、Tool replayOutput、
  toolVersion、Artifact/Validation creation identity **全部 reused as-is，禁止重做**。
- Provenance 纠正（指令 §39）：Sprint 14 文档不得写 "Sprint 11 delivered restart recovery"。
  真实出处 = Sprint 2（engine crash recovery / resumePoint）、Sprint 8（Agent interrupted recovery）、
  Sprint 9/9.1（Tool interrupted recovery / retry）、Sprint 13（durable provenance / CAS integrity /
  idempotent Artifact+Validation）。
