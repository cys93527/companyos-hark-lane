# Model Selection Policy（Sprint 7.5）

> **ModelSelectionPolicy 是"选择规则"，不是 Router。** 本 Sprint 只交付契约、持久化、解释与 UI，
> **不实现自动选择**。依据：用户 Sprint 7.5 §三–§十；ADR-0011。

## 0. 一句话原则

**AI 可以自动选模型，但用户永远保留人工指定权；用户明确选择拥有最高优先级；AI 不得在用户不知情时
替换已指定的模型。** 任何"悄悄换模型"的实现都被视为缺陷。

## 1. 三种模式

| 模式 | 含义 | Sprint 7.5 行为 |
|---|---|---|
| `MANUAL` | 用户明确指定：Developer → model-x、Reviewer → model-y | **尊重选择**：已注册 / enabled / available / capability 满足 / policy 允许则采用；否则返回**明确原因**；不得偷换 |
| `AUTO` | 由未来 Router 在策略范围内决定 | **只定义契约**：保存配置、`autoView()` 返回"Router will decide within policy"与候选集；**不执行任何选择** |
| `HYBRID` | 用户给出候选范围，未来 Router 只能在范围内选 | 保存 `allowedModels / preferredModels / blockedModels / allowedProviders / requiredCapabilities / maxCost / maxLatency`，`hybridView()` 返回候选集与排除原因 |

`MANUAL` 的验收细节（测试 B/C/D）：`disabled` → `MODEL_DISABLED`；`unavailable` → `MODEL_UNAVAILABLE`；
未注册 → `MODEL_NOT_REGISTERED`；能力不足 → `CAPABILITY_MISSING`；越出策略范围 → `MODEL_BLOCKED_BY_POLICY`；
Provider 不在白名单 → `PROVIDER_NOT_ALLOWED`；超出成本上限 → `COST_LIMIT_EXCEEDED`。

## 2. 选择优先级（冻结）

```text
Explicit User Choice  >  Task Override  >  Role Policy  >  Workflow Policy  >  Company Policy
                      >  Router Recommendation  >  Global Default
```

- 实现为 `PRECEDENCE_LADDER`（常量）与 `precedenceLevelOf()`（纯函数），且**每个梯级都有可达输入**
  （Closeout-7.5 一致性修正）：`ROUTER_RECOMMENDATION` 仅在调用方声明"该值来自 Router"时产生
  （当前无 Router，故实际不可达，保留为契约）；`TASK` 作用域的策略**本身就是 Task 梯级**，
  不再因缺少 override 标志而回落 `GLOBAL_DEFAULT`；
- 作用域解析：`resolvePolicy(policies, scopes)` 取**最具体**的一条（`TASK` > `ROLE` > `WORKFLOW` > `COMPANY`，
  `COMPANY` 的 `scopeId='*'` 匹配所有）；
- **用户明确指定时 Router 不得覆盖**：测试 E 证明"显式选择"越过 Role 策略的允许范围并获得
  `EXPLICIT_USER_CHOICE` 优先级；测试 F 证明 Task Override 排在 Role 之前。
- 唯一的绝对规则：`blockedModels` 是**硬阻断**，即便用户显式指定也不放行（安全项，测试 E 第二段）。
  这条边界写在 ADR-0011，避免"显式即万能"的误读。

## 3. Fallback 语义

```text
allowFallback: NEVER | ASK | AUTO_WITHIN_POLICY
```

| 取值 | 语义 | 系统行为 |
|---|---|---|
| `NEVER` | 指定模型失败就停止 | 不提供任何候选（测试 K） |
| `ASK` | 不可用时询问用户 | 不提供自动候选，仅在解释里说明需要人确认（测试 L） |
| `AUTO_WITHIN_POLICY` | 只允许在 `allowedModels` / `allowedProviders` 范围内 fallback | 提供**受限**候选集（测试 K 第二段） |

**禁止无边界 fallback**：候选集只能来自策略白名单（测试 K 断言候选恰好等于策略允许的集合）。

## 4. 作用域与解析顺序

`Company → Workflow → Role → Task`，越具体优先级越高（测试 F/G/H）。每条策略以
`(scopeType, scopeId)` 唯一（数据库 UNIQUE），`COMPANY/*` 为全局默认。

## 5. 数据结构

`ModelSelectionPolicy`：`id`、`scopeType`、`scopeId`、`mode`、`manualModelKey?`、`allowedModels[]`、
`preferredModels[]`、`blockedModels[]`、`allowedProviders[]`、`requiredCapabilities[]`、`maxCost?`、
`maxLatency?`、`allowFallback`、`requireApprovalForOverride`、`createdBy/At`、`updatedAt`。
`createPolicy()` 做全量校验（未知 mode/scope/capability/fallback、非法数值一律 `VALIDATION_FAILED`）。

## 6. 未来必须支持的八种场景（数据模型已支持，Router 未实现）

| 场景 | 表达方式 |
|---|---|
| Developer 固定 A，Reviewer 固定 B | 两条 `ROLE` 策略，各 `MANUAL` + `manualModelKey` |
| 普通任务自动、高风险任务人工指定 | `ROLE`/`WORKFLOW` 用 `AUTO`，`TASK` 策略用 `MANUAL`（Task 覆盖 Role） |
| 只允许本地模型 | `allowedProviders: [local]`（或 `allowedModels` 白名单） |
| 只允许两个 Provider | `allowedProviders: [p1, p2]` |
| Developer 与 Reviewer 必须用不同模型 | 两条 `ROLE` 策略各自 `manualModelKey`（不同键）；一致性校验留给 Router ADR |
| 默认优先便宜、架构任务用高能力 | `COMPANY` 策略 `preferredModels` 便宜型号 + `TASK`/`ROLE` 策略 `requiredCapabilities: [reasoning]` |
| 指定模型额度耗尽先问我 | `allowFallback: 'ASK'` |
| 这个 Workflow 全部禁用云模型 | `WORKFLOW` 策略 `allowedProviders: [local]` + `blockedModels: [cloud-*]` |

## 7. UI（最小）

Model Registry 页新增 **Model Selection Mode**：`○ Manual ○ Auto ○ Hybrid`。

- **Manual**：模型下拉（显示 capabilities / availability / pricing / context）+ "Check this choice"（解释接受或拒绝原因）；
- **Hybrid**：Allowed / Preferred / Blocked Models、Allowed Providers、Required Capabilities、Max Cost、Max Latency、Fallback Policy；
- **Auto**：显示 "Router will decide within policy"，并说明"Router 当前未实现，Auto 只保存配置，不执行自动选择"。

UI 只经 `models.policy` / `models.policy.explain` 两个 IPC operation（测试 P：不 import persistence/core）。

## 8. 测试

A MANUAL 保存与读取｜B disabled 拒绝｜C unavailable 拒绝｜D capability 不满足拒绝｜
E 用户明确选择优先于 Role Policy（且硬阻断仍生效）｜F Task Override 优先于 Role｜G Role 优先于 Workflow｜
H Workflow 优先于 Company｜I blockedModels｜J allowedProviders｜K NEVER / AUTO_WITHIN_POLICY 候选边界｜
L ASK 语义｜M AUTO 只定义不执行｜N Hybrid 候选集与排除原因｜O 重启保留｜
P UI 不访问 persistence｜Q 无厂商名/无路由标识符｜R Benchmark metadata 不参与自动决策。
位置：`tests/sprint7-5/selection-policy.test.ts`。

## 9. 已知限制

- **没有 Router**：`AUTO` 与 `HYBRID` 只保存配置与候选集；`preferredModels` 只影响**展示顺序**，不影响正确性；
- 没有成本/延迟的实时预算执行（`maxCost` / `maxLatency` 只用于准入判定，不参与选择）；
- 没有"同一 Workflow 内两个角色必须不同模型"的强制校验（留给 Router ADR）；
- Benchmark 分数不参与任何选择（设计约束，测试 R 结构性保证）。
