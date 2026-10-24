# Model Registry（Sprint 7）

> 目标：把 Provider 暴露的模型目录，转化为 CompanyOS **自己可持久化、可审计、可启停、可描述能力**的
> Model Registry。**它不是 Model Router**（禁止自动选模型 / 评分路由 / fallback）。
> 依据：规划书 §五十八（P1 Model Registry）、§四十七（最小权限）；ADR-0002、ADR-0006、ADR-0009、ADR-0010。

## 1. Model Registry Architecture

```text
用户 / Designer / 未来 Agent Runtime
   │ models.list / models.register / models.enable / models.disable / models.alias / models.resolve
   ▼  单通道 IPC（schema 校验）
@companyos/engine  registry/model-registry.ts   策展层：稳定 modelKey、描述、能力档案、启停、别名、可用性、审计
   │ 只读使用 ProviderRegistry（目录 + 健康），从不要求它"挑一个"
@companyos/core    domain/model-registry.ts     纯函数：createModelRecord / resolveAlias / availabilityOf / aliasConflict
   ▼
@companyos/persistence  migrations/registry/0001_model_registry.sql（第五条校验和链）
                        model_records（策展条目）· logical_aliases（别名）
```

**两层目录，职责分明**（ADR-0010）：
`provider_models`（Sprint 6）= 适配器声明的**原始目录快照**；
`model_records`（Sprint 7）= CompanyOS **策展条目**（稳定 key、负责人描述、启停、别名、可用性）。
策展条目引用原始条目，但生命周期独立：Provider 下线不等于注册表数据丢失。

## 2. Capability Model

`capabilities` 六布尔（`streaming` / `structuredOutput` / `toolCalling` / `vision` / `reasoning` / `audio`）
+ `contextWindow` + `maxOutputTokens` + `pricing`。缺失即 `false`（fail-closed，Sprint 6 归一化沿用）。
`capabilityProfile(modelKey)` 返回供 UI 与后续调度使用的**只读档案**；registry 自身不以能力做任何选择。

## 3. Alias Model

- `LogicalAlias { id: <scope>:<alias>, alias, modelKey, scope, createdAt, createdBy }`；
- 解析规则：先精确匹配 scope，再匹配 `*`（全局）；**一个别名只指向一个模型**；
- **冲突即拒绝**（评审要求）：同一 scope 下把别名改指另一个模型 → `CONFLICT` 并回传 `currentModelKey`；
  指向同一模型 → 幂等成功；
- `resolve` 的失败语义：别名不存在 → `NOT_FOUND`；模型被停用 → `POLICY_DENIED`；
  模型不可用（Provider 下线/健康不可用）→ `AGENT_UNAVAILABLE`。**永不替换**。

## 4. Availability / Health

`availability` 是**派生值**，不是存储的意愿：`disabled`（未启用）> `unavailable`（Provider 未注册或健康
unavailable）> `degraded`（健康 degraded）> `available`。
`list()` 默认只返回启用的模型（`includeDisabled: true` 可看全部）；`refreshProvider(providerId)` 在 Provider
变动后刷新其全部条目；`unregister` 只删注册与目录，策展条目保留但变为 `unavailable`。

## 5. Authorization Closure（Sprint 6 欠账 ①）

- Core `AUTHORITIES` 新增 `model.register` / `model.read` / `model.write`（闭集，未知名 → `INVALID_ARGUMENT`）；
- **执行点全部落地**：`ProviderRegistry` 的 `register` → `provider.register`、`invoke`/`stream` → `provider.invoke`、
  `health`/`models` → `provider.read`；`SecretVault` 的 `read` → `secret.read`、`write`/`remove` → `secret.write`；
  `ModelRegistry` 的 `registerFromProvider` → `model.register`、`enable/disable/alias/unregister` → `model.write`；
- 未注入策略时只允许并**告警一次**（绝不静默）；注入后 fail-closed（拒绝即 `PERMISSION_DENIED`，且不产生写入）；
- 组合根策略：**首启显式 provision 一条 owner Role 并分配给会话 actor**（写入 SQLite，一次），
  此后恒为纯 `Role → Authority` 判定；组合根构建带 single-flight，重复的 owner Role 冲突被转换为 `CONFLICT`。
  详见 ADR-0011 §1b（该节取代早期"尚无 Role 时视为 owner"的表述，后者已作废）。

## 6. Provider Audit

事件（Core 目录已收录，发射方 `engine:provider-registry` / `engine:model-registry`）：

| 事件 | 触发 |
|---|---|
| `provider.registered` | 注册成功（含 kind、模型数） |
| `provider.health_checked` | 健康检查完成（status、latencyMs） |
| `provider.invoked` | 调用成功（modelId、token 用量、finishReason） |
| `provider.failed` | 调用失败（含归一化 kind；**不含**密钥与完整错误体） |
| `model.registered` / `model.enabled` / `model.disabled` / `model.alias_bound` | 注册表策展动作 |

所有 payload 先经 `redactValue` 脱敏；测试断言事件日志中不出现密钥值。

## 7. Context Estimation（Sprint 6 欠账 ②）

`estimateText` / `estimateContext` 按**字符类别**计数（`TOKEN_RATIO`）：
ASCII ≈ 1/4 token/字符、CJK ≈ 1 token/字符、emoji ≈ 2 token/字符、fenced code ≈ 1/2、其他符号 ≈ 1/2，
逐类向上取整（**保守**）。`assertWithinContextWindow` 是预检门：超限即 `VALIDATION_FAILED`
（details 带 `kind: 'context_limit'`、`estimatedTokens`、`breakdown`）。
`conservative: true` 表示这是**上界**而非测量；适配器**必须**用自己的 tokenizer 复检。
测试对比旧 `chars/4`：`你好世界` 由 1 token 变为 4 token，长中文提示不再能绕过预检。

## 8. Persistence

第五条校验和保护链 `migrations/registry/0001_model_registry.sql`：
`model_records`（`UNIQUE(model_key)`、`UNIQUE(provider_id, provider_model_id)`、`context_window > 0`、
`availability` CHECK 四态、`enabled` CHECK(0/1)）与 `logical_aliases`（`UNIQUE(scope, alias)`）。
**没有任何 score / priority / fallback 列**（边界测试对 DDL 断言）。
core / engine / lifecycle / provider 四条链一字未动；`openDurableDatabase` 的 `chains` 默认仍是
`['core','engine']`，registry 链显式开启；未开启时相关 store 显式拒绝。

## 9. UI

`apps/renderer/src/registry.tsx`：最小列表（Model Key / Name / Provider Binding / Capabilities / Context /
Max Output / Price / Availability / Enable-Disable / alias target 选择 + 别名绑定表单 + "Show disabled"）。
只经 `workflowRequest` 的 `models.*` 操作；**不 import** persistence / engine / core，不缓存权威状态
（每次操作后重新拉取）；文案明确写出"别名只指向一个模型，没有自动选择、没有评分、没有 fallback"。

## 10. Tests

| # | 场景 | 位置 |
|---|---|---|
| A/B | 注册 / 重复 model key 与重复 Provider 绑定拒绝 | `tests/sprint7/model-registry.test.ts` |
| C | Provider 删除后模型变 `unavailable` 且**不被删除** | 同上 |
| D | Enable / Disable（列表可见性 + 解析拒绝） | 同上 |
| E/F/G | 能力档案 / 定价 / 上下文窗口与输出上限 | 同上 |
| H | Health → Availability 派生 | 同上 |
| I/J | 别名解析 / 别名冲突与幂等重绑 | 同上 |
| K | 重启后记录、启停标志、别名保留 | 同上 |
| L/M | `provider.register`/`invoke`、`model.register`/`write`、`secret.read`/`write` 权限执行点 | 同上 |
| N | Provider 审计事件（registered/health_checked/invoked/failed）+ 模型策展事件，且不含密钥 | 同上 |
| O | CJK / emoji / code 分类估算 + 中文长提示被预检拒绝 | 同上 |
| P | Registry UI 不访问 persistence/engine/core，只走 `models.*`，无路由型标识符 | `tests/sprint7/registry-boundary.test.ts` |
| Q | 出厂源码零厂商名；注册表无 score/rank/fallback；registry 链独立 | 同上 |

## 11. 已知限制

- 只有 MockProvider，没有真实适配器（仍需用户批准 + 外环 ADR）；
- **无路由**：别名与 key 都必须显式指定；"最便宜/最快"之类的选择属未来 Router 的独立 ADR；
- 无配额/用量统计（`pricing` 只是元数据，不做成本核算）；
- `model.read` 目前只用于内部读取路径，UI 侧尚未按权限过滤列表（授权执行点在 registry 服务层）；
- 无模型版本/退役流程（模型 key 稳定，Provider 侧模型改名需要重新注册）；
- Registry 与 Provider 的同步是**显式**的（`refreshProvider` 或重新注册），没有后台轮询；
- 上下文估算仍是启发式上界，不等同于计费口径。
