# Sprint 12 — Organizational Memory + Decision

状态：Sprint 12 CLOSED；实现、收口门禁与独立只读复核均已通过。Router 与 Handoff 仍为 CLOSED 冻结面。

## 边界

Memory 是结构化、持久化、可审计的组织知识，不是聊天记录、Handoff、Decision、Artifact、Workflow 状态、Audit 或 prompt cache。Decision 是独立的、不可变版本化的治理记录；Memory Service 不调用 Router，Memory/Decision 写入不推进 Workflow。

当前 scope 使用 `COMPANY`、`WORKFLOW`、`ROLE`、`TASK`；kind 为 `FACT`、`CONSTRAINT`、`PREFERENCE`、`LESSON`、`PROCEDURE_NOTE`、`REFERENCE`。所有记录均带 sourceType/sourceRefs、trust、actor、traceId 和时间戳，服务端拒绝明显 secret-like 内容。

## 生命周期与版本

Memory：`ACTIVE → SUPERSEDED | STALE | RETRACTED | EXPIRED`；Decision：`ACTIVE → SUPERSEDED | REVOKED`。终态历史不可编辑；新内容创建新版本并通过 `supersedes` 关联。SQLite 主键为 `(id, version)`，写入由 UnitOfWork 事务包裹，禁止 hard delete。

## 检索与投影

检索是确定性的，按 `TASK > ROLE > WORKFLOW > COMPANY` 优先级进行 scope shadowing；同一 scope/subjectKey 的多个 ACTIVE 记录会显式报告 conflict，不随机选择。默认排除 stale、expired、retracted、superseded；结果受 item/character 上限约束并返回 `totalMatched`、`includedCount`、`truncated` 元数据。

## 组合根与 IPC

`memory` migration chain、SQLite stores、Engine services 和 `WORKFLOW_OPERATIONS` 均由桌面组合根显式接入。Handoff 被接受不会自动写 Memory、调用 Router、启动 Agent 或推进 Workflow；只有显式 `memory.create` 才能以 `HANDOFF` provenance 写入。

## 审计

事件类型为 `memory.created|superseded|stale|retracted|expired` 与 `decision.created|superseded|revoked`。事件 payload 仅包含 id、version、scope/kind/status、actor、sourceType、traceId 等必要元数据，不包含正文。
