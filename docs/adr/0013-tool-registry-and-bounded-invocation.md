# ADR-0013：Tool Registry 与"一次受控调用"

> 归属：Sprint 9（Tool Registry）；规划书 §五十八（P1 Tool Registry）；上游 ADR-0011（选择规则）、
> ADR-0012（Agent Runtime 与模型绑定）。

## 状态

**已接受（Accepted）** — Sprint 9 交付；**Sprint 9.1 增补（见文末）**：恢复语义、幂等索引、重放诚实性、
分页、descriptor 进 PromptPlan、HIGH 自批规则的显式化。

## Sprint 9.1 增补（Tool Runtime Hardening）

### 10. 崩溃恢复的语义（冻结）

`STARTED` 的行在重启后**只能**变成 `INTERRUPTED`（终态）：不是 COMPLETED，也不是"重试"。
`WAITING_APPROVAL` 的行**原样保留**——恢复扫描不批准、不执行。
**`idempotencyMode: 'NONE'` 的工具崩溃后永不重试**，即使人类显式要求；幂等工具也必须由
**显式命令**（`retryInvocation`）重试，且重试创建新的 attempt 行（原行保留 `INTERRUPTED`，审计可见两次尝试）。

理由：崩溃后的状态是"未知"，未知最危险的两种处理是"当成成功"和"偷偷再调一次"；
对于有副作用的工具，第二次调用可能造成无法撤销的重复副作用。

### 11. 幂等查询必须是索引查询，UNIQUE 必须翻译

按 `idempotency_key` 的精确查询走唯一索引（`ToolInvocationIndexPort`），
**禁止**"取前 N 行再内存 find"。存储层的 UNIQUE 冲突一律翻译成
`CONFLICT`（`kind: IDEMPOTENT_REPLAY`）域错误，**不得**让裸 `SqliteError` 逃出注册表。

### 12. 重放必须诚实

命中重放返回 `replayed: true` + `originalInvocationId` + `originalStatus`，并发射
`tool.invocation_replayed`。**FAILED 的原调用重放后仍是 FAILED**：重放绝不伪装成功。

### 13. 列表分页必须显式

`list({limit, cursor})` 返回 `{items, nextCursor}`：默认 50、上限 200，
游标不透明但**明确**（无静默截断）；否则声明工具时可能"少看见一个工具"。

### 14. Descriptor 进 PromptPlan，但只带模型需要的信息

`PromptPlan.toolDescriptors` 只包含 `toolId/name/description/parameters(输入 schema)/capabilities/riskLevel`；
**不含** `adapterRef`、权限清单、secret、credential。描述符按 `toolId` 排序，
因此"相同 descriptors → 相同 PromptPlan → 相同 promptHash"（模板版本 `agent-prompt/v2`）。
理由：模型需要知道工具"能做什么、要什么参数"，不需要知道公司内部如何绑定适配器、谁能调用。

### 15. HIGH 自批是**有意设计**（并以测试锁定）

`RISK_POLICY.HIGH.selfApprovalAllowed = true`、`CRITICAL = false`：规格只要求 CRITICAL 禁止自批。
Sprint 9.1 **不修改**该规则，但要求：
1. 在本 ADR 中显式记录为有意设计（本节）；
2. 测试锁定当前行为（`tests/sprint9-1` N：HIGH 自批成功；O：CRITICAL 自批被拒）；
3. 未来若要收紧，应新增独立的 `tool.approve` authority（闭集变更 → 新 ADR），
   而不是靠实现细节或 UI 约定。行为**不得**依赖实现偶然性。

## 后果

Sprint 8 让 Runtime 能"跑一次模型调用"，并允许调用方**声明**工具，但工具本身没有任何制度：
没有契约、没有权限、没有风险分级、没有 schema 校验、没有幂等。Sprint 9 补这一层，
同时必须守住两条红线：**Registry 不能变成 Planner**，**Runtime 不能变成自主 Agent**。

## 决策

### 1. Registry 描述与执行；选择留给调用方（冻结）

`ToolRegistryPort` 只有 `register/get/list/setEnabled/invoke/approve/getInvocation/listInvocations`。
没有 `find(capability)`、没有 `plan(...)`、没有 `best(...)`。`invoke` 必须带 `toolId`。
**一个 Registry 如果开始"挑工具"，它就已经变成了 Planner。**

### 2. 权限在每一个执行点（不是 UI 惯例）

新增闭集 authority `tool.register/read/invoke/enable/disable`；`invoke` **同时**检查工具自己声明的
`requiredAuthorities`。Role → Authority 仍是唯一来源：UI 不因"在用应用"而拥有权限，
Agent 也不因"是 Agent"而拥有全部工具。

### 3. 风险是领域概念，不是 UI 提示

`RISK_POLICY` 在 Core，风险门在 Engine。HIGH 必须先 `WAITING_APPROVAL`；CRITICAL **禁止自批**
（`decideToolApproval` 比较 requester 与 approver）。调用方传什么字段都无法绕过——
测试 X 直接把 `approved: true` 塞进 payload 仍然是 `APPROVAL_REQUIRED`。

### 4. 批准不改变状态

`markInvocationApproved` 只记录 `approvedBy/approvedAt`，状态保持 `WAITING_APPROVAL`；
由执行路径自己转 `STARTED`。理由：若"批准"直接等于"运行中"，审计将无法区分
"已批准但尚未执行"与"正在执行"，也无法在崩溃后正确恢复。

### 5. Schema 双向校验，畸形输入绝不进适配器

输入先校验（`INVALID_ARGUMENT`），输出后校验（`VALIDATION_FAILED`）。
Core 自带确定性 JSON-Schema 子集校验器（零依赖），未知关键字忽略但不放行非法类型。

### 6. 幂等是副作用工具的义务

三种模式：`NONE` / `COMMAND_ID`（由 `toolId:executionId:inputDigest` 派生键）/ `IDEMPOTENT_KEY`
（调用方必须显式提供键）。数据库层用**部分唯一索引**兜底，注册表层在调用前查重并直接返回记录结果。
**重放绝不第二次调用适配器**（这是本 ADR 的核心安全承诺）。

### 7. 一次受控工具轮，循环被禁止

Runtime 新增 `runToolCall`：`Model → Tool Call → Tool Result → Runtime`，**恰好一轮**。
多步编排/自主循环需要**新的 ADR** 与用户明确批准；在此之前它属于禁止项。

### 8. 超时由组合根注入

Engine 的边界门禁止 `setTimeout`（既有、有效的约束）。因此 registry 接受一个
`timer(ms, onTimeout) => cancel` 注入点：生产由桌面外壳提供，测试由 fixture 提供。
未注入时 `timeoutMs` 只是声明——这一点已在文档写明，不伪装成"一定有超时"。

### 9. 独立迁移链

`migrations/tools/0001_tool_registry.sql`（第八条链）。既有七条链未改动；组合根显式开启 `tools`。

### 16. 重试是"链"，不是"改键"（Sprint 9.1.2 §一）

每个 attempt 都是独立身份：`id`（新）、`parentInvocationId`（上一个 attempt）、`rootInvocationId`（链首，
恒定）、`attemptNumber`（单调递增）；幂等键 = `<base>#retry-<attemptNumber>`，`attemptNumber` 从链上
最大值 +1 起取第一个空闲值（若连续 50 个都已被占用则返回 `CONFLICT`，绝不静默复用）。
**第 N 次重试永远不可能命中第 N-1 次的 replay**，且链可以无限增长。
只有 `INTERRUPTED` + 幂等模式非 NONE 的 attempt 可被重试；NON-IDEMPOTENT 永不重试。
端口形状随之扩展：`ToolInvokeInput.attempt`、`ToolInvocation.parentInvocationId/rootInvocationId/attemptNumber`、
`listInvocations(...) -> ToolInvocationPage{items,nextCursor}`。

### 17. PromptPlan 是快照，不是引用（Sprint 9.1.2 §二）

`assemblePrompt` 对 descriptor 的 `parameters` 做 JSON 深拷贝并递归 `Object.freeze`；
落 hash 的是快照。理由：调用方（注册表 / UI / 上层）继续持有并可能修改自己的 schema 对象，
如果 plan 保留引用，会让"已产出的 plan 与 hash"随外部变化而漂移，破坏可复现性。

### 18. 分页必须有声明式稳定排序（Sprint 9.1.2 §三）

invocation 分页使用 **`created_at DESC, id DESC`** 作为显式全序（并建对应索引），
**不**依赖 SQLite 隐式 rowid。理由：固定/低精度时钟下 `created_at` 大量平局，
未声明的隐含顺序在跨页时可能重复、丢失或漂移——这对审计数据是不可接受的。
**已知限制**：游标携带的是 `(id, offset)`，隐含"id 顺序 ≈ created_at 顺序"；若时钟回拨导致两者背离，
可能丢行（不会重复）。未来可改为携带 `(created_at, id)` 的 keyset 游标。

## 后果

**收益**

- 工具成为可治理资产：契约、能力、权限、风险、幂等、超时、审计、可重启的历史；
- "高风险必须人工批准、CRITICAL 不能自批"是**代码与测试**保证，而不是界面约定；
- 畸形输入/输出在边界被拦下，适配器只看到合法数据；
- 副作用工具的重放不会产生第二次副作用（DB 唯一索引 + 注册表查重双保险）；
- Runtime 仍然不会替模型选工具：它只声明、只执行被点名的那一个。

**代价与限制**

- 只有 MockTool；真实工具需要新 ADR + 权限/风险复审；
- 没有工具版本迁移/退役流程；
- `MEDIUM` 的 Validator 只有标志位，没有 Validator 资产；
- 幂等命中返回记录结果而非重放适配器（刻意取舍）；
- 超时依赖注入（未注入时仅为声明）；
- 多步工具编排（Planner/Agent 自主循环）明确不在本 ADR 范围内，且当前被禁止。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| Registry 提供 `findTools(capability)` | 就是 Planner 的第一步；用户明令禁止自动选择工具 |
| Runtime 自行决定调用哪个工具 | 等于把"选择"藏进执行层，绕过 ModelSelectionPolicy 与人工指定 |
| 风险只做 UI 提示 | 用户明确要求"Risk 不得只存在 UI，必须由 Core/Engine 执行" |
| 批准即置为 STARTED | 审计无法区分"已批准"与"运行中"，崩溃恢复语义会被污染 |
| 幂等命中时重新调用适配器以取回输出 | 会产生第二次副作用；宁可返回记录引用 |
| Engine 直接 `setTimeout` 做超时 | 违反既有 engine 边界门；改为组合根注入 timer |
| 把工具表塞进 agent 链 | 违反 ADR-0006 的多链约定（每条链独立校验和） |
