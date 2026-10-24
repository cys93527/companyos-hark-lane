# ADR-0011：Model Selection Policy（选择规则，不是 Router）

> 归属：Sprint 7.5（Open Model Research & Model Selection Policy）；规划书 §五十八（P1 Model Registry / Router）、
> §四十七（最小权限）；上游 ADR-0009（Provider 边界）、ADR-0010（Registry 与"不是 Router"）。

## 状态

**已接受（Accepted）** — Sprint 7.5 交付。

## 背景

Sprint 6/7 让"有哪些模型"成为可治理资产。但"**用哪个模型**"这件事还没有制度：
一旦未来有了 Router，如果没有先把规则写死，就容易滑向"AI 自己决定、用户不知情"。
用户因此要求：先把**选择规则**（ModelSelectionPolicy）正式立为产品概念，并明确
**AI 可以自动选模型，但用户永远保留人工指定权**。

## 决策

### 1. 规则与执行分离

`ModelSelectionPolicy` 只描述**约束与优先级**，不执行任何选择。Sprint 7.5 交付：
三种模式（MANUAL/AUTO/HYBRID）、四种作用域（Company/Workflow/Role/Task）、三种 fallback 语义、
六条优先级阶梯、五个准入谓词（注册 / enabled / available / capability / 允许范围）、
以及把"为什么不能"讲清楚的解释器。**没有任何评分、排序、自动替换逻辑。**

### 2. 优先级阶梯（冻结）

`Explicit User Choice > Task Override > Role Policy > Workflow Policy > Company Policy >
Router Recommendation > Global Default`。

用户明确指定时 Router 不得覆盖；这既是产品承诺，也是本 ADR 的**冻结项**（推翻需 Change Proposal）。

### 1b. 授权引导（bootstrap）—— Closeout-7.5 补充记录

Sprint 7.1 关闭了"roles 表为空即放行一切"的 fail-open，做法必须写在这里以免再次误读：

1. **首启（roles 表为空）**：组合根调用 `ensureBootstrapOwner()` **显式 provision 一条 owner Role**
   （携带 Core `AUTHORITIES` 全量）**并分配给会话 actor**，写入 SQLite；这是一次**有记录**的初始化，
   不是"默认允许"；
2. **此后永久**：授权路径恒为纯 `Role → Authority`（`authz.decide`），没有任何"表为空就放行"的分支；
3. **只执行一次**：`ensureBootstrapOwner` 在 `roles.length > 0` 时返回 `roles_already_defined` 且**不授予任何人**；
4. **其他 actor 无法利用初始化窗口**：非会话 actor 一律 `POLICY_DENIED`，IPC 强制注入会话身份；
5. **并发**：组合根构建带 single-flight（同进程共享同一 promise）；若两个进程同时创建 owner Role，
   数据库 `UNIQUE(company_id, key)` 挡住第二次，并被转换为 `CONFLICT` 域错误（不是裸存储异常）；
6. 若产品希望"首启必须由人确认"，在 `ensureBootstrapOwner` 之前插入显式确认即可——数据模型无需改动。
7. 该节取代早期"尚无 Role 时视为 owner"的表述（`docs/MODEL_REGISTRY.md` 已同步订正）。

### 3. 唯一的绝对阻断

`blockedModels` 是硬阻断：即便用户显式指定也不放行。理由：它是**安全/合规**手段
（"这个 Workflow 全部禁用云模型"），而"显式选择优先"针对的是**策略范围**（allowed/preferred），
不是安全底线。实现与测试都按此划分（E 组两段断言）。

### 4. Fallback 必须有边界

`NEVER` 不提供候选；`ASK` 交给人；`AUTO_WITHIN_POLICY` 只允许在 `allowedModels` / `allowedProviders` /
`requiredCapabilities` 范围内候选。**禁止无边界 fallback**：候选集由策略算出，不由模型质量决定。

### 5. AUTO 只是契约

`AUTO` 可保存、可解释（`autoView()` 返回 "Router will decide within policy" 与候选集），
但**不执行选择**；UI 明示"Router 当前未实现"。这样即使配置先行，也不会出现"偷偷自动选"。

### 6. Benchmark 分数不是决策输入

Benchmark 只产出 **Model Performance Metadata**（展示与选型讨论）。结构性保证：
`domain/model-selection-policy.ts` 不 import `domain/benchmark.ts`；引擎侧评测调用不接收任何 metadata；
测试 R 断言"记录前后同一问题的答案完全一致"。

### 7. UI 只经 IPC

模式选择、Manual 下拉（显示能力/可用性/定价/上下文）、Hybrid 六项、Auto 说明，全部通过
`models.policy` / `models.policy.explain` 两个 operation；UI 不 import persistence/core。

## 后果

**收益**

- "用户明确指定 → 不被偷换"从一个口头承诺变成有优先级常量、有解释器、有测试的制度；
- 未来 Router 落地时，只能在既定阶梯与候选集内活动，不需要重新设计规则层；
- fallback 有明确边界，避免"悄悄降级到便宜模型"这类不可解释行为；
- Benchmark 与决策解耦，分数不会因为"跑分高"而绕过策略。

**代价与限制**

- 尚无 Router：`AUTO`/`HYBRID` 只保存与解释，`preferredModels` 只影响展示顺序；
- 没有"同 Workflow 两个角色必须不同模型"的强制校验（留给 Router ADR）；
- `maxCost` / `maxLatency` 只做准入判定，不参与选择与预算执行；
- 规格/分数依赖外部资料，需要定期复核（见 `OPEN_MODEL_BENCHMARK.md` §5）。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 直接实现 Router（评分 + 自动选） | 用户明确禁止；且会绕开"用户指定优先"的制度 |
| 把规则写进代码常量而不落库 | 无法按 Company/Workflow/Role/Task 分层，也无法审计变更 |
| 用 benchmark 分数做选择 | 分数不可比、会随版本漂移，且用户明令禁止 |
| 允许"显式选择"越过 `blockedModels` | 会让安全/合规阻断形同虚设 |
| ASK 语义下系统自行挑一个候选 | 那就是"偷换模型"，与最高优先级条款冲突 |
