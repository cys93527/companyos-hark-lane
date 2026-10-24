# Agent Execution Runtime（Sprint 8）

> 一句话：**Runtime 负责"执行一次明确的模型绑定"，永远不负责"选哪个模型"。**
> 依据：用户 Sprint 8 规格 §一–§十六；ADR-0012。前置：Sprint 6（Provider）、Sprint 7（Model Registry）、
> Sprint 7.5（Selection Policy）。

## 0. 冻结的四条不相等

```text
Role   ≠ Agent      岗位描述 ≠ 填充岗位的执行者
Agent  ≠ Model      执行者可以换模型，换模型不需要换角色或换 Agent
Model  ≠ Provider   模型是注册表条目，Provider 是提供它的适配器
Runtime ≠ Router    执行 ≠ 选择
```

## 1. Agent Runtime Architecture

```text
Task + Role + 明确 modelKey
   │  prepare(): 授权 agent.execute → 策略验证 → createExecution(CREATED) → READY → 审计 agent.execution_created
   ▼
AgentContext（显式组装，见 §3）
   ▼
PromptAssembler（确定性，见 §4）→ PromptPlan{promptHash}
   ▼
ModelRegistry.get(modelKey) → providerId + providerModelId
   ▼
ProviderRegistry.invoke({providerId, actorId}, request)   ← Runtime 不知道任何厂商
   ▼
InvocationResult → AgentExecution COMPLETED / FAILED
   ▼
resultRef + artifactRefs（独立表）+ usage + latency + trace（全部落库）
```

**modelKey 的三个合法来源**：① MANUAL 用户明确选择；② 上层显式绑定；③ 未来 Router 的选择结果。
**当前没有 Router**，所以没有 `modelKey` 时 Runtime 返回 **`MODEL_SELECTION_REQUIRED`**
（details 带 `routerAvailable: false`），绝不自己挑。

**严禁**（有测试）：自动挑模型 · `preferredModels[0]` · 自动 fallback · 按 benchmark 选 ·
按价格/延迟选 · Provider 报错后换模型。

## 2. Execution Lifecycle（独立状态机）

```text
CREATED → READY → RUNNING → { COMPLETED | FAILED | CANCELLED | WAITING_EXTERNAL | INTERRUPTED }
WAITING_EXTERNAL → { RUNNING | COMPLETED | FAILED | CANCELLED | INTERRUPTED }
```

- **八个状态**，与 Workflow L1（17 态）/ L2（模板生命周期 4 态）/ L3（Task/Stage）**完全不同层**，
  有边界测试断言 Runtime 不 import L1/L2/L3 机器、且 `INTERRUPTED`/`WAITING_EXTERNAL` 不出现在 L1 词表；
- 所有迁移集中在一张 `TRANSITIONS` 表里（`canTransitionExecution`），非法迁移 → `CONFLICT`；
- `RUNNING/WAITING_EXTERNAL` 是**可恢复**状态，`INTERRUPTED` 是终态但**不是** COMPLETED。

## 3. Agent Context（显式组装，可审计）

字段：`company / workflow / workflowVersion / workflowRun / stage / task / role / modelBinding /
objective / instructions / constraints / acceptanceCriteria / memoryView / previousHandoff /
artifactRefs / trace`。

- **不是**"把整个 SQLite / 整个聊天历史 / 整个项目目录塞进去"：每个字段要么是有界文本，要么是**引用 id**；
- 有明确预算（`CONTEXT_LIMITS`）：objective 4k、instructions 每项 8k、constraints/acceptance 各 ≤50 项、
  memoryView 20k、previousHandoff 20k、artifactRefs ≤200 且**只允许 id**；
- 超限 → `VALIDATION_FAILED`（**拒绝**而不是静默截断）；缺 modelBinding → `MODEL_SELECTION_REQUIRED`。

## 4. Prompt Assembly（确定性）

`assemblePrompt(context, {maxOutputTokens, structuredKeys, tools, rolePreamble})` →
`PromptPlan { templateVersion:'agent-prompt/v1', system, user, modelKey, providerId, providerModelId,
maxOutputTokens, structuredKeys, tools, promptHash }`。

- **相同输入 → 相同输出**：无时钟、无随机、无 IO、无排序歧义；`promptHash` 为 FNV-1a 稳定哈希（测试 K）；
- 组装器**不选模型**、**不查 benchmark**、**不 fallback**：只把已绑定的 `modelKey` 原样放进 plan；
- system 提示词默认恒定（角色前言由调用方给出），结构化的 `responseFormat.mode='json_schema'` 只在
  调用方声明 `structuredKeys` 时出现。

## 5. Provider Invocation

`ProviderRegistry.invoke({providerId, actorId}, {modelId: providerModelId, messages, maxOutputTokens?,
responseFormat?, tools?, traceId})`。
Runtime 只知道 **providerId + providerModelId**，不知道也不允许知道任何厂商；
`packages/core/src`、`packages/engine/src` 里厂商名零出现（测试 AB）。

## 6. 错误模型（结构化、可审计、可持久化、不泄密）

13 种 kind：`MODEL_SELECTION_REQUIRED`、`MODEL_DISABLED`、`MODEL_UNAVAILABLE`、`CAPABILITY_MISSING`、
`PROVIDER_UNAVAILABLE`、`RATE_LIMITED`、`QUOTA_EXHAUSTED`、`TIMEOUT`、`CONTEXT_LIMIT`、
`CONTENT_REJECTED`、`INVALID_OUTPUT`、`CANCELLED`、`POLICY_REFUSED`（策略拒绝：blocked/越界/Provider/成本/延迟）。

- kind → Core 错误码由一张表决定（`EXECUTION_ERROR_CODES`），`retryable` 由另一张表决定
  （仅 `RATE_LIMITED` / `TIMEOUT` / `PROVIDER_UNAVAILABLE`）——**Runtime 自己不重试**；
- 失败一律：`markFailed` + 落库（`errorCode/errorKind/errorMessage`）+ 审计 `agent.execution_failed`
  + 返回 `err(DomainError)`（details 带 kind/retryable）；
- **任何 Provider 错误都不会导致换模型**（测试 Y：允许 fallback 的策略下，另一个模型调用次数为 0）；
- errorMessage 落库前统一 `redactSecrets`（测试 V：DB、事件、错误对象三处都不含密钥）。

## 7. 审计事件

`agent.execution_created` / `agent.execution_started` / `agent.provider_invoked` /
`agent.execution_completed` / `agent.execution_failed` / `agent.execution_cancelled` /
`agent.execution_interrupted`。
payload 固定携带 `executionId / agentId / roleId / taskId / runId / modelKey / providerId / status`，
外加 `promptHash`（started）、token 用量与延迟（invoked/completed）、`errorKind`（failed）、
`previousStatus`（interrupted）。**不含** secret / credential / 敏感 header。

## 8. Persistence（第七条校验和保护链）

`migrations/agent/0001_agent_runtime.sql`：
`agent_executions`（22 列，status CHECK 八态、attempt ≥ 1、usage 存 JSON、trace/created/updated）
与 `agent_execution_artifacts`（`UNIQUE(execution_id, artifact_ref)`）。
**没有** score/priority/fallback/secret/token/credential 列（DDL 断言）。
重启后：状态、失败原因、model binding、usage、trace、artifact 引用全部保留（测试 W）。

## 9. Restart / Recovery

`recoverInterrupted(actorId)`：把 `RUNNING/WAITING_EXTERNAL` 的执行标记为 **`INTERRUPTED`**
（`errorKind/errorCode = 'INTERRUPTED'` —— **不是** TIMEOUT：崩溃不等于 Provider 超时，且不得看起来可重试），
审计 `agent.execution_interrupted`，**绝不自动标 COMPLETED、绝不重新调用模型**（测试 X：`calls` 保持 0）。
对终态执行再次 `run()` → `CONFLICT`（不会静默重跑）。

**策略门不可绕过**：Runtime 用 `taskId`/`roleId`/`companyId` **自行推导** scope 链并与调用方声明的
scope 合并，因此不传 `scopes` 也会命中 ROLE/TASK/COMPANY 策略；畸形 scope → `INVALID_ARGUMENT`。

## 10. 测试

`tests/sprint8/agent-runtime.test.ts`（A–Z + AA：27 条）与 `tests/sprint8/runtime-boundary.test.ts`
（AA/AB + 生命周期隔离 + 持久化无密钥 + 组合根接线：11 条）。

A 创建｜B 角色绑定｜C MANUAL 成功｜D 同角色换模型｜E disabled 拒绝｜F unavailable 拒绝｜
G blocked 拒绝｜H capability 拒绝｜I HYBRID 只验证不选择｜J AUTO 无 modelKey 拒绝｜
K Prompt 确定性｜L Context 结构｜M Mock Provider 调用｜N 结构化结果 + INVALID_OUTPUT｜O COMPLETED｜
P 限流｜Q 超时｜R 配额｜S 上下文｜T 内容拒绝｜U 取消（不触达 Provider）｜V 密钥不入库/事件/错误｜
W 重启保留｜X 崩溃不误标完成且不重跑｜Y 不 fallback｜Z benchmark 不影响决策｜AA 无 Router 逻辑｜AB 无厂商名。

## 11. 已知限制

- 只跑通 MockProvider（真实适配器需用户批准 + 外环 ADR）；
- `WAITING_EXTERNAL` 目前只有状态与迁移，没有人机交互的实现（留给后续人机协同）；
- usage 的 `inputUsage` 暂记为 0（Provider 契约目前只回报 output 侧 usage）；
- 没有重试/退避执行（只给 `retryable` 元数据，由调用方决定）；
- 没有 Agent 的具体"岗位"实现（Agent 目前是 id + role 的组合，岗位语义属 Tool/Agent Registry）。
