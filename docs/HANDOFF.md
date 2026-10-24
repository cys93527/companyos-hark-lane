# Handoff — 结构化角色交接（Sprint 11）

> 一句话：**Handoff 是一个执行角色向另一个角色提交的、结构化且有界的"工作交接包"。**
> 它承载**摘要 + 明确引用**，不承载"把所有上下文再塞一遍"。
> 代码事实源：`packages/core/src/domain/handoff.ts`、`packages/engine/src/handoff/handoff-service.ts`、
> `packages/persistence/src/durable/sqlite-handoff-store.ts`、`tests/sprint11/handoff.test.ts`；
> 决策记录：ADR-0014 之外的独立领域文档（本文件）+ `docs/STATE_MACHINE.md` §12。

## 1. Definition（定义）

```text
Agent / Role A 完成阶段性工作
   ↓ 构造结构化 Handoff Packet（不复制上下文）
   ↓ 校验（必填字段 + 证据 + 安全）
   ↓ 持久化（版本化、不可改写历史）
   ↓ Role B 读取 + 接受
   ↓ Runtime 只消费 ACCEPTED 的有界投影（previousHandoff）
```

## 2. Explicit non-equivalence（不可混淆）

| Handoff **不是** | 原因 |
|---|---|
| **Chat History** | 不保存聊天记录/执行历史；只保存摘要 + 引用 |
| **Memory** | 不做召回、不做嵌入、不做跨任务记忆（Sprint 12） |
| **Artifact** | 只持 `artifactRefs[]` 引用；产物系统是 Sprint 13 |
| **Workflow Transition** | 不推进 Workflow、不改 Run/Stage/Task 状态 |
| **Agent Runtime** | 不是执行、不启动 Agent、不选模型/Tool |

**ACCEPTED Handoff 不会自动**：启动下一个 Agent · 推进 Workflow · 选择 next role · 选择 model · 选择 tool。

## 3. HandoffPacket contract

`handoffId` · `handoffVersion` · `companyId` · `workflowId` · `workflowVersionId` · `workflowRunId` ·
`stageId` · `taskId` · `fromAgentId` · `fromRoleId` · `toRoleId` · `toAgentId?` · `objective` · `status` ·
`summary` · `completedWork[]` · `remainingWork[]` · `constraints[]` · `acceptanceCriteria[]` ·
`artifactRefs[]` · `decisionRefs[]` · `validationRefs[]` · `knownRisks[]` · `openQuestions[]` ·
`recommendedNextAction` · `modelBinding?{modelKey,providerId}` · `executionRef?` · `supersedes` ·
`acceptedBy/acceptedAt` · `rejectedBy/rejectedAt` · `rejectionReasons[]` · `rejectionComment` ·
`traceId` · `createdAt/updatedAt`。

**READY 前必填**（`HANDOFF_REQUIRED_AT_READY`）：`handoffId`、`taskId`、`fromRoleId`、`toRoleId`、
`objective`、`summary`、`recommendedNextAction`。
**证据门**：当 `acceptanceCriteria` 非空（或调用方要求）时，至少需要 1 个 `artifactRefs` 或 `validationRefs`，
否则 READY 返回 `VALIDATION_FAILED`（`reason: MISSING_EVIDENCE`）。

`toRoleId` **只能**由 Workflow/Task/Application Layer 给出；**Runtime 不决定接收者**。

## 4. Lifecycle（独立状态机）

```text
DRAFT ──▶ READY ──▶ ACCEPTED
              └───▶ REJECTED
DRAFT | READY ──────▶ CANCELLED
READY | ACCEPTED | REJECTED ──▶ SUPERSEDED（仅由新版本替代时）
```

非法迁移一律 `CONFLICT`（带 `allowed` 列表）。该状态机与 **L1 Workflow / L2 Template /
L3 Task·Stage / AgentExecution / ToolInvocation** 五套状态机**完全独立**。

## 5. Versioning / supersede

- 每次返工产生**新版本**（`handoffVersion + 1`，同 `handoffId`），并写 `supersedes = "<id>@v<n>"`；
- **旧版本业务内容永不改写**：`summary / refs / objective / risks / next action` 在终态后不可变；
- `REJECTED / ACCEPTED → SUPERSEDED` 是**合法**迁移（返工链必需），但只改 `status`；
  存储层条件 UPDATE 只允许这一种终态→终态迁移，其余写入一律 `CONFLICT`（`TERMINAL_HANDOFF_IMMUTABLE`）；
- `versions(handoffId)` 返回完整历史（最新在前），可回答"Reviewer 当时收到的是哪一版"。

## 6. Permissions

`handoff.create` · `handoff.read` · `handoff.accept` · `handoff.reject`。
**accept 必须由持有 `toRoleId` 的行动者执行**：其它角色（即便拥有 `handoff.accept`）→
`PERMISSION_DENIED` + `reason: WRONG_TARGET_ROLE`；**创建者不能代收**（不是 UI 隐藏按钮，而是服务层强制）。

## 7. refs（artifact / decision / validation / execution）

`HandoffRef { kind, refId }`：`refId` 必须是**不透明标识符**（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`），
路径/正文/序列化对象一律 `VALIDATION_FAILED`。Sprint 11 **只做引用与格式校验**，
不实现 Artifact Asset System / Decision Memory / Validator Framework。

## 8. Durable audit（六事件，脱敏）

`handoff.created` · `handoff.ready` · `handoff.accepted` · `handoff.rejected` · `handoff.superseded` ·
`handoff.cancelled`（producer `engine:handoff-service`），经 `defineEvent` + `database.events.append` **真实落库**。
payload 白名单（**12 项**）：`handoffId · version · actorId · taskId · runId · fromRoleId · toRoleId · status ·
artifactCount · decisionCount · validationCount · traceId`。
**绝不写入**：`summary` · `completedWork` · `remainingWork` · `constraints` · `openQuestions` ·
`recommendedNextAction` · secret/credential · prompt · 完整 context。
生产接线说明：`handoff.created/ready/accepted/rejected/cancelled` 五个事件的发射路径已在组合根装配；
`handoff.superseded` 的发射器同样已接线，但**尚无 IPC 操作**触发 supersede（返工链当前经服务层调用），
因此不得声称"六事件均在 IPC 上可达"。

## 9. Persistence

迁移链 **`handoff`**（opt-in）：`handoffs`（**PRIMARY KEY (handoff_id, version)**）+ `handoff_refs`
（`(handoff_id, version, kind, ref_id)`，外键级联）。`createSqliteHandoffStore` 支持
`create / update / get / listVersions / listForTargetRole / listRecent`：
- `create` 重复 `(handoffId, version)` → `ALREADY_EXISTS`（`HANDOFF_VERSION_EXISTS`，**不静默**）；
- `update` 只允许 `DRAFT/READY → 合法后继` 或 `ACCEPTED/REJECTED → SUPERSEDED`，其余 → `CONFLICT`；
- `listForTargetRole` 只返回每个 handoff 的**最新版本**。
`DurableDatabase.handoffStore` **仅当请求 `handoff` 链时**存在，否则为 `null`。

## 10. Restart semantics

`create → READY → close → reopen` 仍为 **READY**；`accept → close → reopen` 仍为 **ACCEPTED**
（`acceptedBy/acceptedAt` 保留）。重启**不会**：自动 accept · 自动创建 v2 · 自动生成下一 Handoff ·
自动启动 Agent · 自动推进 Workflow（测试断言 `versions/recent` 数量不变、无 agent execution）。

## 11. Runtime `previousHandoff` projection

`handoffContextViewIfAccepted(packet)` → 仅 `ACCEPTED` 返回视图，其余五态 `null`；
`serializeHandoffContextView(view)` 输出**确定性、有界**文本（固定章节顺序，无时钟/随机/LLM）；
`previousHandoffTextOf(packet)` 是 Runtime 唯一可用的入口。投影**不含**：audit 内部字段、secret、
DB row、执行历史、聊天记录。Runtime **不**决定 next role / model / tool，也不 accept/reject/supersede。

## 12. Developer → Reviewer flow（E2E）

Developer：`createDraft`（summary + artifactRefs + validationRefs + risks + next action）→ `ready`
→ durable `handoff.created/ready`。
Reviewer：`listForTargetRole('role_reviewer')` → `accept` → durable `handoff.accepted`
→ `previousHandoff`。Reviewer 能看到 objective/summary/completedWork/remainingWork/constraints/
acceptanceCriteria/artifactRefs/decisionRefs/validationRefs/knownRisks/openQuestions/nextAction，
**看不到** Developer 的聊天记录、完整 AgentContext、secret、audit 内部与 SQLite 行内部。

## 13. Rejection → v2 flow（E2E）

Reviewer `reject(reasonCodes: ['ACCEPTANCE_NOT_MET'])` → v1 永久 `REJECTED`（**不可回 READY、不可改内容**）；
Developer `supersede` 创建 v2（`supersedes = "hnd_x@v1"`，初始 `DRAFT`）→ `ready` → Reviewer `accept v2`。
最终 `versions()` = `[v2 ACCEPTED, v1 SUPERSEDED]`，v1 内容未被重写。

## 14. Security / bounded context

- `assertHandoffSafety()`：拒绝疑似凭据（`sk-…`、`Bearer …`、PEM 头、`api_key=…`）与超长字段（>4000 字符）；
- 引用只接受不透明 id；审计只记 ids + 计数；
- Handoff 从不携带作者身份之外的执行上下文，也不携带工作流/模型/Tool 的执行权。

## 15. Known limitations（记录，不阻塞）

**Production wiring complete（Sprint 11 收口）**：

- `createHandoffService` 已在组合根装配：`store = DurableDatabase.handoffStore`（缺失时**显式抛错**，不静默禁用）；
  `authorize = authz.decide`；`actorRoleIds = authz.assignmentsOf(...)`（**服务端可信派生**）；
  `audit` = 六事件经 `defineEvent` + `database.events.append` **真实 durable 落库**（无 logger-only / optional / 静默吞）。
- Handoff IPC **生产可达**：`handoff.create/ready/accept/reject/cancel/get/listForTargetRole`
  （接入既有 `WORKFLOW_OPERATIONS`，未新造第二套 IPC）。
- 客户端**禁止**提交 `actorRoleIds` / `roles` / `roleMemberships` / `effectiveRoles` / `permissions` / `authorities`
  → 一律 `INVALID_ARGUMENT`；客户端**禁止**提交 `previousHandoff` / `previousHandoffText`（`readAgentContext` 直接拒绝）。
- `previousHandoff` **只能**服务端派生：客户端给 `handoffId`(+`version`) → durable store → `previousHandoffTextOf`
  （= `handoffContextViewIfAccepted` + 确定性序列化）→ Runtime；**只有 ACCEPTED** 有值，其余五态为 `null`。
- `handoff` 行 + `handoff_refs` **同一 SQLite 事务**（`db.inTransaction`）：任一步失败 → 全部回滚（0 残留），
  且失败时**不发射** `handoff.created`；
- 行为证据：`tests/sprint11/production-wiring.test.ts`（A–O）+ `tests/sprint11/handoff.test.ts`。

其余限制：

1. 引用的**存在性**未校验（Artifact/Decision/Validator 系统属后续 Sprint），只校验格式；
2. `handoff_refs` 的 `execution` 类目仅由 `executionRef` 写入，未做单独查询 API；
3. 权限判定依赖组合根注入的 `authorize`；`accept` 的**目标角色**判定在 Core 内强制，角色集合由 `authz.assignmentsOf` 派生；
4. `listForTargetRole`/`listRecent` 无分页游标（上限由调用方给 limit）；
5. UI（Handoff Card 的 Accept/Reject/View Artifacts）**未实现**，仅冻结了 `handoffCardOf()` 视图模型；
6. 未实现自动总结：摘要必须由调用方给出（LLM 生成摘要属后续能力，会破坏确定性）；
7. 数组字段（completedWork/remainingWork/…）本身无长度上限，仅校验单字段 ≤ 4000 字符；
   AgentContext 的 20k 上限由 Runtime 侧约束。
