# Tool Registry（Sprint 9）

> 一句话：**Registry 描述与执行"被点名的那个工具"，永远不负责"用哪个工具"。**
> 依据：用户 Sprint 9 规格 §一–§十三；ADR-0013。前置：Sprint 6（Provider）、Sprint 7/7.5（模型与策略）、
> Sprint 8（Agent Runtime）。

## 0. 不做的事（冻结）

不自动选择工具 · 不做 Tool Planner · 不做多工具自动规划 · 不做无限 Tool Loop ·
不做 Model Router / 自动选模型 / 自动 fallback · 不做多模型协作 · 不接真实厂商 API · 不做真实生产工具。

## 1. Tool Registry Architecture

```text
ToolPort（适配器，实现无关）  ──►  ToolRecord（契约：schema/risk/authority/idempotency/timeout）
        ▲                                   │
        │ adapters(adapterRef)              │ 注册（tool.register）
        │                                   ▼
   ToolRegistry ── 权限 → 风险/审批 → 幂等 → INPUT schema → adapter(timeout) → OUTPUT schema → 记录
        ▲                                   │
        │ tools.invoke(toolId, …)           ├─ tool_records / tool_invocations / tool_invocation_artifacts
        │                                   │
   Agent Runtime ── 一次受控工具轮（Model → Tool Call → Tool Result → Runtime，**无循环**）
```

**八个动作**：register · get/list · enable/disable · invoke · approve · getInvocation/listInvocations ·
descriptors（声明给模型用）。**没有任何 find/plan/best/choose**（测试 Y/Z）。

## 2. Tool Contract（ToolRecord）

`toolId · name · description · version · capabilities[] · inputSchema · outputSchema · enabled ·
riskLevel · requiredAuthorities[] · timeoutMs · idempotencyMode · auditPolicy · providerKind ·
adapterRef · createdAt · updatedAt`。**禁止保存 secret 值**：表里没有可存凭据的列（DDL 断言），
调用记录里保存的是**脱敏后**的 input 与 `inputDigest`。

## 3. Tool Port（实现无关）

`ToolPort.describe()` · `invoke(ToolRequest)` · 可选 `health()` / `cancel()`；
`ToolRequest { toolId, executionId, agentId, taskId, runId, actorId, traceId, input, timeoutMs, idempotencyKey }`；
`ToolResult { status, output, artifactRefs, startedAt, finishedAt, latencyMs }`；
错误一律结构化（`ToolErrorKind` 12 种 → Core 码 + `retryable` 元数据）。Core/Engine 不出现任何真实工具名或厂商名。

## 4. Permission Model

新增闭集 authority：`tool.register · tool.read · tool.invoke · tool.enable · tool.disable`。
**所有执行点真实检查**：register/unregister → `tool.register`；get/list/getInvocation/listInvocations → `tool.read`；
setEnabled → `tool.enable` / `tool.disable`；invoke 与 approve → `tool.invoke` **加上工具自己声明的
`requiredAuthorities`（逐个检查）**。Role → Authority 仍是唯一权限来源：UI 不隐式拥有权限，
Agent 也不默认拥有所有 Tool（测试 E/F 用拒绝策略证明）。

## 5. Risk Model（Core/Engine 执行，不是 UI 提示）

| 等级 | 语义 | 强制点 |
|---|---|---|
| `LOW` | 可执行 + 记录审计 | `RISK_POLICY.LOW.requiresApproval = false` |
| `MEDIUM` | 可执行 + **强制审计**（可要求 Validator） | `requiresValidator = true`，`auditPolicy = STRICT` |
| `HIGH` | **必须先 `WAITING_APPROVAL`**，批准后才执行 | `requiresApproval = true`（测试 K/L） |
| `CRITICAL` | 必须**明确人工批准**，**不允许自批** | `selfApprovalAllowed = false`（测试 M） |

风险判定在 Core（`RISK_POLICY` / `decideToolApproval`），执行在 Engine（registry 风险门）。
**UI 传任何字段都无法绕过**（测试 X：payload 里塞 `approved: true` 依旧 `APPROVAL_REQUIRED`）。
批准只记录批准人（状态仍为 `WAITING_APPROVAL`），由执行路径自己转为 `STARTED`——
这样"批准"永远不会被误当成"已在运行"。

## 6. Schema Validation

`validateAgainstSchema(value, schema)` 是 Core 内的确定性 JSON-Schema 子集校验器
（`type/properties/required/additionalProperties/items/enum/const/minLength/maxLength/minimum/maximum/minItems/maxItems`，
未知关键字忽略并记录）。**输入在 adapter 之前**（失败 → `INVALID_ARGUMENT` + `INPUT_INVALID`，测试 G），
**输出在 adapter 之后**（失败 → `VALIDATION_FAILED` + `OUTPUT_INVALID`，测试 H）。
畸形输入**绝不**到达适配器（测试 G 断言 adapter 调用次数为 0）。

## 7. Idempotency

`NONE` · `COMMAND_ID`（键 = `toolId:executionId:inputDigest`）· `IDEMPOTENT_KEY`（调用方必须显式提供键，
否则 `VALIDATION_FAILED`）。数据库层有**部分唯一索引**（`idempotency_key` 非空时唯一），
注册表侧在调用前先查重：**命中即返回记录的结果，不再调用适配器**（测试 P/Q：adapter 只被调用一次）。
同一 invocation 重放**不会**产生第二次副作用。

## 7b. Sprint 9.1：Tool Runtime Hardening

| 主题 | 行为 |
|---|---|
| **恢复语义** | `recoverInvocations(actorId)`：`STARTED → INTERRUPTED`（审计 `tool.invocation_interrupted`，带 `previousStatus`）；`WAITING_APPROVAL` **原样保留**（不自动批准、不自动执行）；结果报告区分 `interrupted / waitingApproval / retryable` |
| **绝不自动重试** | **`NON-IDEMPOTENT`（`idempotencyMode: NONE`）的 invocation 崩溃后永不重试**，连 `retryable` 列表都不进；显式 `retryInvocation()` 也会被 `POLICY_DENIED` 拒绝 |
| **显式重试** | 仅 `INTERRUPTED` + 幂等模式非 NONE 可被**人工命令**重试；重试创建**新 attempt（新行 + `#retry` 派生键）**，原行保持 `INTERRUPTED` |
| **幂等查询** | 按 `idempotency_key` 走**唯一索引精确查询**（`ToolInvocationIndexPort`），移除 500 行内存扫描；UNIQUE 冲突被翻译为 `CONFLICT`（`kind: IDEMPOTENT_REPLAY`）域错误，**不裸抛 SqliteError** |
| **重放诚实性** | 命中重放返回 `replayed: true`、`originalInvocationId`、`originalStatus`，并发射 **`tool.invocation_replayed`**；**FAILED 的原调用重放后仍是 FAILED**，绝不伪装成功 |
| **列表分页** | `list({limit?, cursor?, includeDisabled?})` → `{items, nextCursor}`；默认 50、上限 200、游标不透明且**明确**；畸形游标 → `INVALID_ARGUMENT`；**移除静默截断** |
| **Descriptor 进 Prompt** | `assemblePrompt({toolDescriptors})`：模型只看到 `toolId/name/description/parameters(输入 schema)/capabilities/riskLevel`；**不含** adapterRef / 权限清单 / secret / credential；描述符按 `toolId` 排序，**相同 descriptors → 相同 promptHash**（模板版本升至 `agent-prompt/v2`） |
| **HIGH 自批** | **有意设计**：HIGH 允许请求人自批（`selfApprovalAllowed: true`），CRITICAL 禁止（`false`）；两者都有测试锁定（N/O），未来可升级为独立 `tool.approve` authority（闭集变更需 ADR） |

## 7c. Sprint 9.1.2：NIT Hardening

| 主题 | 行为 |
|---|---|
| **连续 Retry 链** | 每次显式 `retryInvocation()` 都基于**最新 attempt** 生成新的 attempt identity：新 `id`、`parentInvocationId`、稳定的 `rootInvocationId`、**单调递增** `attemptNumber`；幂等键为 `<base>#retry-<n>`（`attemptNumber` 从链上最大值 +1，遇到已占用则继续 +1），因此**第 N 次重试永远不会误命中第 N-1 次的 replay**；NON-IDEMPOTENT 仍禁止 |
| **Descriptor 防御性拷贝** | `assemblePrompt` 对每个 descriptor 做 **JSON 深拷贝 + 递归 freeze**（`cloneJsonValue` / `deepFreezeJson`），`promptHash` 基于该快照 ⇒ 调用方之后修改自己的 `inputSchema` **不会**改变已产出的 PromptPlan 或它的 hash |
| **Invocation 分页稳定排序** | 显式排序 **`created_at DESC, id DESC`**（不再依赖隐式 rowid）；`listInvocations({limit, cursor, executionId?, toolId?, rootInvocationId?})` → `{items, nextCursor}`（默认 50 / 上限 200 / 畸形游标 `INVALID_ARGUMENT`）；固定时钟下 1000 条同时间戳记录跨页**不重复、不丢失、顺序不漂移** |

## 8. Agent Runtime Integration（一次受控工具轮）

```text
Model returns tool call → Runtime 解析（caller 给出 toolId）
  → ToolRegistry.get（权限） → Risk/Approval → Input schema
  → ToolPort.invoke（带 timeout） → Output schema → 记录 ToolInvocation → 返回 ToolResult 给 Runtime
```

- Runtime 的 `prompt.toolIds` 会把被点名工具的**名称**声明给模型（`toMessages` 目前生成
  `Tool declared by the caller: <name>` + 宽松参数 schema）。**诚实说明**：真实 `description`/`parameters`
  尚未进入 PromptPlan（注册表的 `descriptors()` 与 `ToolPort.describe()` 当前不被 prompt 路径使用），
  已列为 Sprint 10 的改进项；
- `runtime.runToolCall(...)` 只做**一轮**：没有循环、没有 next-tool、没有重试风暴（测试 U/V 断言恰好 1 次调用）。

## 8b. 批准与超时的边界语义（Closeout-9）

- **批准是原子认领**：`markInvocationApproved` 只写 `approvedBy/approvedAt`（状态仍 `WAITING_APPROVAL`，
  二次批准 → `CONFLICT`），随后由存储层**条件更新**（`UPDATE … WHERE status='WAITING_APPROVAL'
  AND approved_by IS NOT NULL AND started_at IS NULL`）判定唯一胜者；**并发批准只会执行一次**
  （测试"Closeout HIGH-1"；组合根必须注入该 claim，否则并发下可能重复执行）。
- **enabled 在共享执行路径检查**：请求后被禁用的工具，即使被批准也不会执行（测试"Closeout MEDIUM-1"）。
- **超时是判决，不是中止**：到点后会 best-effort 调用 `ToolPort.cancel?.()`，但**不保证**适配器已经停止；
  因此副作用型工具**必须**是幂等的（或实现可取消），这一点是使用方的义务。

## 9. Tool Execution Lifecycle

`REQUESTED → WAITING_APPROVAL → STARTED → { COMPLETED | FAILED | CANCELLED }`（独立于 Agent Execution 与 L1/L2/L3）。
非法迁移 → `CONFLICT`；终态吸收。

## 10. Persistence（第八条校验和保护链）

`migrations/tools/0001_tool_registry.sql`：
`tool_records`（契约，`UNIQUE(tool_id)`，risk/idempotency/audit CHECK）、
`tool_invocations`（状态机 CHECK、`idempotency_key` 部分唯一索引、input 脱敏 payload + digest、错误三列）、
`tool_invocation_artifacts`（`UNIQUE(invocation_id, artifact_ref)`）。
重启后：**注册 + enabled + risk + authorities + 历史 invocation + 结果 + 错误**全部保留（测试 T）。

## 11. Audit

`tool.registered · tool.enabled · tool.disabled · tool.invocation_requested · tool.invocation_started ·
tool.invocation_completed · tool.invocation_failed · tool.approval_requested`。
payload 携带 `toolId/invocationId/executionId/agentId/taskId/runId/actorId/riskLevel/traceId`
（+ 用量/digest/延迟），统一 `redactValue` 脱敏；**不含 secret / credential / authorization header /
完整敏感 input**（测试 R 断言 payload 里没有输入正文，测试 S 断言密钥在 DB、事件、错误三处都不出现）。

## 12. Tests

`tests/sprint9/tool-registry.test.ts`（A–X + 无人选择器面 + 未绑定适配器：25 条）与
`tests/sprint9/tool-boundary.test.ts`（Y/Z/AA/AB + 链与组合根边界：11 条）。
A 注册｜B 重复 ID 拒绝｜C 启停（持久 + 审计）｜D 能力与声明权限｜E `tool.read`｜F `tool.invoke`｜
G 输入 schema 拒绝｜H 输出 schema 拒绝｜I LOW 执行｜J MEDIUM 执行 + STRICT 审计｜K HIGH 未批准拒绝｜
L HIGH 批准后执行（恰一次）｜M CRITICAL 禁止自批｜N 工具错误｜O 超时｜P/Q 幂等与重放不重复副作用｜
R 审计字段（且不含正文）｜S 密钥脱敏｜T 重启持久｜U/V Runtime → MockTool 一轮并回传结果｜
W disabled 不执行｜X 风险不可由 UI 绕过｜Y 无选择器｜Z 无 Router/Planner｜AA 无真实工具实现名｜AB 无破坏性工具。

## 13. 已知限制

- 适配器只有 MockTool（真实工具需用户批准 + 外环 ADR + 权限/风险复审）；
- 没有工具版本迁移/退役流程（`version` 只是契约字符串）；
- `MEDIUM` 的 "Validator" 语义只体现在 `requiresValidator` 标志，尚无 Validator 资产（Sprint 10+ 方向）；
- 幂等命中只返回**记录的结果引用与 artifact 引用**（不重放适配器）。重放语义按"不重复副作用"实现，
  这是刻意的安全取舍；
- `runToolCall` 每轮只执行一个工具；多步编排需要**新 ADR**（当前明令禁止自动规划）；
- 超时依赖组合根注入的 timer（engine 边界门禁止 engine 自己用 `setTimeout`）；未注入时 `timeoutMs` 仅为声明。
