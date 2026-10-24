# ADR-0012：Agent Runtime 与模型绑定（Runtime 不选模型）

> 归属：Sprint 8（Agent Runtime）；规划书 §五十八（P1 Agent Runtime）；上游 ADR-0009（Provider 边界）、
> ADR-0010（Registry 不是 Router）、ADR-0011（Model Selection Policy）。

## 状态

**已接受（Accepted）** — Sprint 8 交付。

## 背景

Sprint 6–7.5 建立了"有哪些模型、怎么描述、允许怎么用"的制度，但还没有"真正跑一次"的执行层。
Sprint 8 补这一层，同时必须守住用户反复强调的红线：**执行层绝不能变成第二个选择器**。
一旦 Runtime 里出现"没有模型就挑一个"，前三个 Sprint 的制度会被绕过，用户的人工指定权也会被架空。

## 决策

### 1. Role ≠ Agent ≠ Model ≠ Provider，Runtime ≠ Router（冻结）

- **Role** 是岗位描述，**Agent** 是填充该岗位的执行者，**Model** 是可替换的资源，**Provider** 是提供者；
- 因此**换模型不需要换 Role，也不需要换 Agent**（测试 D 用同一 role/task 先后跑两个模型证明）；
- **Runtime 只是一个执行器**：输入必须包含明确 `modelKey`。

### 2. 没有 modelKey 就是 `MODEL_SELECTION_REQUIRED`

`modelKey` 的合法来源只有三个：MANUAL 用户选择、上层显式绑定、未来 Router 的结果。
当前无 Router，所以缺 `modelKey` 一律拒绝，并在 details 中给出 `routerAvailable: false`。
**禁止**：自动挑第一个 preferred、自动 fallback、按 benchmark/价格/延迟选。

### 3. 策略是"验证器"，不是"选择器"

Runtime 用 Sprint 7.5 的 `evaluateManualSelection` 校验传入的 `modelKey`：
已注册 / enabled / available / Provider 在允许集合 / 不在 blocked / 能力满足 / 成本与延迟达标。
MANUAL/HYBRID/AUTO 三种模式走**同一条验证路径**；AUTO 只意味着"策略允许 Router 决定"，
而不是"Runtime 可以自己决定"。

### 4. 执行状态是独立的第三套状态机

`CREATED/READY/RUNNING/WAITING_EXTERNAL/COMPLETED/FAILED/CANCELLED/INTERRUPTED`。
**不得**与 L1（17 态）/L2（模板生命周期）/L3（Task/Stage）混用，理由：执行是**物理事实**
（一次尝试是否跑完），而 L1/L2/L3 是**业务语义**；混在一起会让"重试一次"看起来像"工作流重跑"。
边界测试断言 Runtime 不 import 这三套机器，且 `INTERRUPTED`/`WAITING_EXTERNAL` 不出现在 L1 词表。

### 5. 崩溃不得被解释成成功

进程在 `RUNNING/WAITING_EXTERNAL` 中死亡 ⇒ `recoverInterrupted()` 标为 **`INTERRUPTED`**，
`errorKind/errorCode = 'INTERRUPTED'`（**不是** `TIMEOUT`：崩溃不等于 Provider 超时，
也不得让它看起来可重试），并写审计事件 `agent.execution_interrupted`；
**绝不**自动 COMPLETED、**绝不**重新调用模型。
理由：未知执行结果最危险的处理方式就是"当成成功"，其次是"偷偷重放"。

**分层命名的说明**（Closeout-8 NIT-1）：`COMPLETED`/`FAILED` 等通用终态词在 L1 与执行层**同名**是有意为之，
但两者是**不同的枚举、不同的迁移表、不同的持久化列**；隔离由结构保证，而不是靠词表不重叠。
真正必须不重叠的是**恢复词表**：`INTERRUPTED`/`WAITING_EXTERNAL` 只属于执行层（有边界测试断言）。

**`ModelBinding.source` 的诚实性**（Closeout-8 MEDIUM-1）：Sprint 8 **不存在** `'ROUTER'` 来源——
Runtime 没有 Router，所以任何由上层给出的 `modelKey` 都记录为 `EXPLICIT_BINDING`，
用户自己输入的记录为 `MANUAL`。`'ROUTER'` 只有等 Router ADR 落地后才可能出现。

**策略门不可省略**（Closeout-8 MEDIUM-2）：Runtime 用自己手里的 `taskId`/`roleId`/`companyId`
**自行推导** scope 链（TASK → ROLE → COMPANY → `COMPANY:*`），与调用方声明的 scope 合并后再解析策略；
因此"不传 scopes"无法绕过 `blockedModels` / `allowedProviders` / 能力 / 成本策略；
畸形 scope 直接 `INVALID_ARGUMENT`（不做静默丢弃）。

### 6. Context 显式组装、Prompt 确定性

- Context 只接受有界文本与**引用 id**（不是一个 SQLite/聊天历史/项目目录的倾倒），超限即拒绝；
- Prompt 组装无时钟、无随机、无 IO，同输入同输出（`promptHash`），且**不涉及任何选择**。

### 7. 审计与密钥

七个 `agent.*` 事件，payload 只带 id 与度量；`errorMessage` 落库前统一脱敏；
DDL 中不存在能存 credential 的列（有测试断言）。密钥仍然只以 `SecretRef` 形式存在。

### 8. 独立迁移链

`migrations/agent/0001_agent_runtime.sql`（第七条链）。既有六条链未改动；
`chains` 由组合根显式开启（含 `agent`），否则相关 store 显式拒绝服务。

## 后果

**收益**

- "执行"与"选择"在代码结构上分离：Runtime 的公开面只有
  `prepare/run/execute/cancel/recoverInterrupted/get/list`，没有 chooser（测试 AA）；
- 用户的人工指定权在运行时也被尊重：命名即使用，不可用就报错，不静默替换；
- 每次尝试都有可审计、可重启、可对账的记录（状态/错误/用量/延迟/trace/产物引用）；
- 崩溃有明确的、保守的恢复语义，不会把未知结果说成成功。

**代价与限制**

- 没有 Router，所以 AUTO 模式在运行时不可用（这是**约束**，不是缺陷）；
- 只有 MockProvider 被真正跑通，真实适配器需要单独批准；
- `WAITING_EXTERNAL` 只有状态定义，没有人机交互实现；
- 输入侧 usage 暂未从 Provider 契约获得（目前记 0），需要适配器契约补充；
- 重试/退避留给调用方（Runtime 只声明 `retryable`）。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 无 modelKey 时用策略的 preferredModels 兜底 | 就是"自动选模型"，用户明令禁止 |
| Provider 拒绝后换一个允许的模型重试 | 自动 fallback，会让"用户指定"失效且掩盖真实故障 |
| 复用 L1 运行状态表示 Agent 执行 | 把物理尝试与业务语义混为一谈，恢复语义会互相污染 |
| 崩溃后直接重放请求 | 可能重复产生副作用；且属于"偷偷重新调用模型" |
| 把 Context 做成"取数据库快照" | 不可审计、不可控、容易把密钥/无关数据带进模型 |
| Runtime 直接 import 具体厂商 SDK | 违反厂商铁律（Core/Engine 不得出现厂商名） |
