# ADR-0014：Model Router 架构（Sprint 10A — 只冻结设计，不实现）

> 归属：Sprint 10A（Model Router ADR + Contract）；规划书 §五十八（P1 Router）。
> 上游：ADR-0010（Registry 不是 Router）、ADR-0011（Model Selection Policy 与优先级阶梯）、
> ADR-0012（Agent Runtime 与模型绑定）、ADR-0013（Tool Registry）。
> **本 ADR 只冻结规则与契约。Sprint 10A 不交付任何 Router 实现（见 §19）。**

## 状态

**已接受（Accepted）** — Sprint 10A 冻结；实现留给 Sprint 10B（需用户批准）。

## 背景

Sprint 7.5 已经冻结"选择规则"（`ModelSelectionPolicy`：MANUAL/AUTO/HYBRID、优先级阶梯、
fallback 语义、候选范围），Sprint 8 的 Agent Runtime 也明确"运行时必须拿到明确 `modelKey`"。
缺的最后一环是：**在策略已经允许的空间内，按可解释、可测试、确定性的规则生成一个模型建议**。
本 ADR 就是这一环的规则说明书。

## 1. Router 的职责（冻结）

**职责**：在 Policy **已经允许**的候选空间内，根据明确、可解释、可测试的规则，生成
`ModelRecommendation`（建议 + 理由 + 拒绝清单 + 来源 + 版本）。

**不得**（出现即违规）：修改 `ModelSelectionPolicy` · 绕过 `blockedModels` · 覆盖 Explicit User Choice ·
修改 MANUAL 模式 · 擅自 fallback · 直接调用 Provider · 直接执行 Agent · 修改 Workflow · 修改 Role ·
修改 Benchmark 数据。

Router 是一个**建议生成器**，不是执行者，也不是策略修改者。

## 2. 三模式语义（§二十 A/B/C/D）

| 模式 | Router 是否参与 | 语义 |
|---|---|---|
| **MANUAL** | **否**（`routerAppliesTo('MANUAL') === false`） | 用户显式 `modelKey`；Router 不参与、不覆盖、不推荐替代；不可用时返回**明确失败原因**；是否 fallback 严格服从 `NEVER`/`ASK`/`AUTO_WITHIN_POLICY` |
| **HYBRID** | 是，但**只能在人工给定范围内** | Policy 先生成允许候选集，Router 只能在 `allowedModels`/`allowedProviders`/`requiredCapabilities`/cost/latency/`blockedModels` 允许的集合内选择；**不得扩展候选集** |
| **AUTO** | 是，可在 Policy 完整允许范围内自动选择 | 仍受 Company → Workflow → Role → Task 四层策略约束 |

## 3. 优先级（冻结，沿用 ADR-0011）

```text
Explicit User Choice > Task Override > Role Policy > Workflow Policy > Company Policy
                     > Router Recommendation > Global Default
```

**Router Recommendation 永远不能覆盖前五层。**
`blockedModels` 属 **Hard Block**：**即使 Explicit User Choice 命中，也必须拒绝**（保持 ADR-0011 §3）。

## 4. Candidate Pipeline（冻结顺序，§四）

```text
ALL_REGISTERED_MODELS
  → ENABLED_FILTER
  → AVAILABILITY_FILTER
  → PROVIDER_ALLOWED_FILTER
  → BLOCKED_MODELS_FILTER
  → REQUIRED_CAPABILITIES_FILTER
  → CONTEXT_WINDOW_FILTER
  → MAX_OUTPUT_FILTER
  → COST_CONSTRAINT
  → LATENCY_CONSTRAINT
  → RISK_ROLE_CONSTRAINTS
  → CANDIDATE_SET
  → ROUTER_RANKING
  → RECOMMENDATION
```

**Hard Filter 与 Ranking 严格分离**（`ROUTER_HARD_FILTER_STAGES` / `ROUTER_PRESENTATION_STAGES`）：
被任一 Hard Filter 淘汰的模型**禁止通过高分重新进入候选集**。实现只能是
"先过滤，后排序"，且排序函数的输入类型只接受**已存活的候选**。

## 5. Router 输入 / 输出（契约）

输入 `RouterRequest`：`requestId · companyId · workflowId? · workflowVersionId? · runId? · stageId? ·
taskId · roleId · selectionMode · policySnapshot（含 snapshotVersion）· requiredCapabilities[] ·
estimatedInputTokens · requiredOutputTokens? · maxCost? · maxLatency? · riskConstraint? · diversity? ·
manualModelKey? · candidateModels[] · allowedModels?/blockedModels?/allowedProviders?/preferredModels?（**policy view**）·
performanceMetadata? · benchmarkMetadata? · traceId`。

输出 `ModelRecommendation`：`selectedModelKey? · decision · reasonCodes[] · rejectedCandidates[] ·
candidateEvaluations[] · policySource · selectionMode · fallbackPolicy · estimatedCost? · estimatedLatency? ·
confidence? · routerVersion · traceId · provenance`。

**决定（`decision`）**：`RECOMMENDED` / `NO_ELIGIBLE_MODEL` / `ROUTER_NOT_AVAILABLE` /
`MANUAL_NOT_ROUTED` / `AWAITING_CONFIRMATION` / `REFUSED_HARD_BLOCK`。

**拒绝理由（闭集）**：`MODEL_NOT_REGISTERED` · `MODEL_DISABLED` · `MODEL_UNAVAILABLE` ·
`PROVIDER_NOT_ALLOWED` · `PROVIDER_UNAVAILABLE` · `MODEL_BLOCKED` · `CAPABILITY_MISSING` ·
`CONTEXT_TOO_SMALL` · `OUTPUT_LIMIT_TOO_SMALL` · `COST_LIMIT_EXCEEDED` · `LATENCY_LIMIT_EXCEEDED` ·
`DIVERSITY_CONFLICT` · `RISK_CONSTRAINT_UNSATISFIED` · `NOT_IN_CANDIDATE_SET`。

## 6. Ranking 原则（第一版：确定性规则路由器）

第一版必须是 **Deterministic Rule-Based Router**；**禁止用另一个 LLM 来决定选哪个 LLM**（禁止 LLM-as-Router、
禁止多模型投票）。信号（顺序即意图优先级）：

`requiredCapabilityFit → preferredModelsPosition → providerHealth → contextHeadroom → cost → latency →
`preferredModelsPosition → providerHealth → contextHeadroom → estimatedCost → estimatedLatency →
historicalSuccessRate → benchmarkMetadata`（`V1_NOT_RANKED_SIGNALS` 列出 v1 不参与排序者）。

其中 `requiredCapabilityFit` 与 risk 约束属**硬约束**（不是"分高就行"）；
`benchmarkMetadata` 的权重有上限 **`BENCHMARK_WEIGHT_CAP = 0.15`**。

## 7. Benchmark 关系（§九）

Benchmark Metadata **可以**进入 `RouterRequest`，但：**可缺失**（缺失时 Router 仍必须工作）、**可过期**
（stale 减半）、**可来自不同 benchmarkVersion**（必须记录版本）、`external` 与 `harness` 必须区分
（external 打折至 75%）、**benchmark 不能突破 Hard Policy**。**绝不允许**"排行榜第一名自动获胜"
或"benchmark score = 最终决定"。

## 8. Historical Performance 契约（§十）

字段：`successRate · reviewPassRate · reworkRate · failureRate · avgLatencyMs · avgCost · sampleCount`。
`sampleConfidence()`：**无样本 → 0（中性，不是"差"）**；**小样本（< 20）→ 按比例降权**；
≥ `HISTORICAL_MIN_SAMPLE`（20）→ 1。**历史数据不得突破 Policy**。Sprint 10A 只定义契约。

## 9. Stable Tie-Break（§十一）

同分必须**确定性**选择，**禁止随机**。冻结顺序：

```text
PREFERRED_POSITION → LOWER_ESTIMATED_COST → LOWER_ESTIMATED_LATENCY → HIGHER_PROVIDER_HEALTH → LEXICAL_MODEL_KEY
```

最后一个键是 `modelKey` 字典序，因此比较是全序；**相同输入必须产生相同 recommendation**（契约函数
`compareTieBreak` 已实现为纯函数并被测试锁定）。

## 10. Fallback Semantics（§十二）

严格沿用三种模式，**禁止跨 Policy / 跨 blockedModels fallback，禁止偷偷切 Provider 或模型**：

| 模式 | 契约动作（`decideFallback`） |
|---|---|
| `NEVER` | `STOP`，`candidateSet = []`（不提供自动替代执行） |
| `ASK` | `ASK_USER`，`candidateSet = []`（可以先有建议，但必须等用户确认） |
| `AUTO_WITHIN_POLICY` | `AUTOMATIC_WITHIN_CANDIDATES`，`candidateSet` **恰为已过滤候选**（⊆ 策略集合） |

## 11. No Candidate（§十三）

候选为空时**不得猜**：返回 `NO_ELIGIBLE_MODEL` + `RejectionSummary{checked, byReason, summaryText}`
（例："3 models checked: 1 model blocked, 1 capability missing, 1 model unavailable."）。
UI 可展示"当前没有符合策略的模型。"

## 12. Router Unavailable（§十四）

| 情形 | 结果 |
|---|---|
| MANUAL | **不受影响**（`MANUAL_NOT_ROUTED`） |
| 明确 `modelKey`（HYBRID/AUTO） | 仍可执行（`MANUAL_NOT_ROUTED`） |
| AUTO 且无 `modelKey` | `ROUTER_NOT_AVAILABLE` |
| HYBRID 且无 `modelKey` | `ROUTER_NOT_AVAILABLE` |

**不得静默降级为"候选列表第一个"**。这与 Sprint 8 的 `MODEL_SELECTION_REQUIRED` 一致：
Router 未接线时，AUTO 请求继续被拒绝。

## 13. Risk Constraints（§十五，只定义钩子）

`LOW → ALLOW_LOW_COST_MODELS`；`HIGH → REQUIRE_REASONING_CAPABILITY` / `REQUIRE_MINIMUM_QUALITY_TIER`；
`CRITICAL → REQUIRE_MANUAL_CONFIRMATION`。**Sprint 10A 只定义接口**（`RouterRiskConstraint` + 钩子枚举），
不写任何业务硬编码。

## 14. Role Diversity（§十六，只定义约束）

`ModelDiversityConstraint`：`NONE` / `DIFFERENT_FROM_PREVIOUS_ROLE` / `DIFFERENT_FROM_DEVELOPER` /
`DIFFERENT_PROVIDER`；`checkDiversity()` 为纯函数，冲突 → 拒绝理由 `DIVERSITY_CONFLICT`
（属 **Hard Filter**，不是排序偏好）。用途：Developer 与 Reviewer 使用不同模型，避免"自己写自己审"。

## 15. Versioning 与 Provenance（§十七）

每条 recommendation 必须记录：`routerVersion`（`model-router/v1`）· `policySnapshotVersion` ·
`modelRegistryRevision` · `benchmarkVersion?` · `performanceSnapshot?`。
目的：日后必须能回答"2026-09-14 当时为什么选了这个模型"。

## 16. Audit（§十八，只定义事件契约）

事件：`router.requested` · `router.candidates_built` · `router.recommendation_created` ·
`router.no_candidate` · `router.override_requested` · `router.override_confirmed`。
Sprint 10A **只登记事件类型**（发射方标记为未发射，待 10B）。
**不得记录** secret / credential / 完整敏感 prompt。

## 17. Human Override（§十九）

即使 AUTO 已给出建议，用户仍可 **Use Recommended Model** 或 **Choose Another Model**；
选择其他模型后走 `ModelSelectionPolicy` 校验。**Router 不得阻止合法人工选择**。
`applyHumanOverride()` 为纯函数，返回 `accepted/refusals/agreement`，并产出
`OverrideRecord{routerRecommendation, userFinalSelection, agreement}`，
以便日后统计"AI 推荐 vs 用户最终选择"。

## 18. 场景问答（用户 §二十要求，逐条冻结）

| # | 场景 | 答案 |
|---|---|---|
| A | MANUAL 是否经过 Router | **否**（`routerAppliesTo('MANUAL') === false`，出参 `MANUAL_NOT_ROUTED`） |
| B | AUTO 怎么选 | Router 在 Policy 完整允许范围内选（决定 `RECOMMENDED`） |
| C | HYBRID 怎么选 | Router 在人工给定范围内选，**不得扩展候选集** |
| D | 用户指定与 Router 冲突 | **合法用户选择优先**（Router Recommendation 在阶梯最下两层之上仅高于 Global Default） |
| E | blocked 模型被用户指定 | **拒绝**（Hard Block，测试 C） |
| F | 无候选 | `NO_ELIGIBLE_MODEL` + `rejectionSummary`（不猜） |
| G | Router 挂了 | MANUAL 不受影响；AUTO/HYBRID 无明确 key → 拒绝（`ROUTER_NOT_AVAILABLE`） |
| H | quota exhausted | 按 `fallbackPolicy`（`NEVER` 停止 / `ASK` 询问 / `AUTO_WITHIN_POLICY` 仅在候选内） |
| I | Developer/Reviewer 强制不同模型 | 预留 `ModelDiversityConstraint`（本阶段只定义接口） |
| J | Benchmark 没数据 | Router 仍能工作（benchmark 缺失 → 中性，权重 0） |
| K | Historical 样本太少 | **降权**（`sampleConfidence < 1`），无样本中性，历史不得突破 Policy |
| L | Tie | **确定性 tie-break**（五个键 + 字典序兜底） |

## 19. Sprint 10A 交付范围（不可越界）

**允许**：Pure Contract · Pure Types · Pure Explanation Schema · Pure Decision Rules · ADR ·
Tests for invariants。

**禁止**（10A 内出现即违规）：真正 `selectModel()` / `rankModels()` 执行 · Provider 调用 ·
Agent Runtime 调用 · 自动 fallback 执行 · LLM-as-Router · 多模型投票 · 多 Agent 协作 ·
真实厂商 API · DevCompany。

**证据**：`tests/sprint10a/router-contract.test.ts` 断言契约源码不含 `selectModel(`/`rankModels(`/
`scoreModel(`、不 import Provider/Runtime、无厂商名；Runtime 与 Tool Registry 均未被改动。

## 24. Sprint 10A.0.2 增补：把"文档承诺"升级为"代码结构强制"

Cross-Model Independent Review 判定 `PASS WITH CONDITIONS`，并指出 1 HIGH + 5 MEDIUM 都是
"契约声称的约束没有任何规则/测试强制"。本节冻结修复后的结构。

### 24.1 HIGH-1：MANUAL 强制门（`assertRouterRequestAllowed`）

**冻结**：任何 `ModelRouterPort.recommend(request)` 实现的**第一条规则**必须是

```text
assertRouterRequestAllowed(request)
```

它必须拒绝（错误码 `MANUAL_NOT_ROUTED`，`details.decision = 'MANUAL_NOT_ROUTED'`）：
1. `request.selectionMode === 'MANUAL'`；
2. `request.manualModelKey` 非空（即使 mode 声称 AUTO/HYBRID）；
3. `request.policyView.source.mode === 'MANUAL'`。

`applyHardFilters` 的**入口顺序**（同一规则，防止实现者漏写）：

```text
assertRouterRequestAllowed  →  assertDerivedPolicyView  →  Hard Filters
```

### 24.2 MEDIUM-1：防篡改门真正接入

`applyHardFilters(request): Result<HardFilterOutcome, DomainError>`：先验请求、再验视图，
**digest 不匹配或 `derivedBy` 非法即拒绝（`VALIDATION_FAILED`）**，绝不进入候选流水线。
视图 digest 现在覆盖 **七个** 字段：`allowedModels · blockedModels · allowedProviders ·
preferredModels · requiredCapabilities · maxCost · maxLatency`（后两个此前未纳入）。

### 24.3 MEDIUM-2：唯一 ranking 目录

**`ROUTER_V1_RANKING` 是唯一权威真相源**。旧的 10 键 `RANKING_SIGNALS`（`missing: 'NEUTRAL'`，无权重）
已删除；缺失数据语义**统一为 `SKIP_AND_RENORMALISE`**（"跳过并重归一化"，不是记 0 分）。
v1 不参与排序的信号单独列出并标记 `V1_NOT_RANKED`：`requiredCapabilityFit · reviewPassRate · reworkRate`。
硬约束不是信号，它们是**阶段**（`RANKING_HARD_CONSTRAINTS` 列出阶段名）。

### 24.4 MEDIUM-3：Latency 不做假阶段

`LATENCY_FILTER_MODE = 'NO_DATA_NO_HARD_FILTER'`：v1 缺少可比较的候选级延迟元数据，
因此 `LATENCY_CONSTRAINT` 是**显式声明的 no-op**——不淘汰候选、不假装 `maxLatency` 已强制生效；
`HardFilterOutcome.latencyFilter` 会把这一事实带给出处。`LATENCY_LIMIT_EXCEEDED` 的 producer 标记为
**`FUTURE`**（只有未来具备可验证延迟元数据时才可产生）；解释上需要时使用
`LATENCY_DATA_UNAVAILABLE`。

### 24.5 MEDIUM-4：Recommendation 不变式

`validateRecommendation(recommendation)` 强制：
`RECOMMENDED` ⇒ `selectedModelKey` 非空 **且** `reasonCodes` 至少 1 条正面码；
`NO_ELIGIBLE_MODEL` ⇒ 不得带 selected model **且** 必须有拒绝/评估记录；
`AWAITING_CONFIRMATION` ⇒ `fallbackPolicy === 'ASK'`；
`MANUAL_NOT_ROUTED` / `ROUTER_NOT_AVAILABLE` ⇒ 不得伪造 selected model；
`REFUSED_HARD_BLOCK` ⇒ 必须带上被拒候选。不一致 → `RECOMMENDATION_INVALID`。
**10B：`recommend()` 返回前必须调用它。**

### 24.6 MEDIUM-5：单一 Policy 解读入口

`manualOutcome(request)` 与 `applyHumanOverride({..., policyView})` 现在都读取**派生视图**
（`RouterPolicyView` 结构上满足新的 `SelectionRules`），共同调用同一个
`evaluateManualSelection`；不再存在"Router 一套解释、Manual 一套解释、Override 又一套"。
生产入口仍是 `ModelSelectionPolicy Service → routerPolicyView() → RouterPolicyView`。

### 24.7 LOW-2：名义 `FilteredCandidateSet`

`applyHardFilters` 的成功结果是**带 brand 的 `FilteredCandidateSet`**（brand 符号不导出，外部无法构造），
排序入口 `assertRankingInput(set)` 只接受该类型 ⇒ **被硬过滤淘汰的模型在类型层面不可能重新进入排序**。

### 24.8 §九：`snapshotVersion` 语义

`RouterPolicyView.source.snapshotVersion` 是**语义版本**（必须由 policy 身份 + 内容派生，
例如 `COMPANY:*@<digest>`，参与视图 digest）；时间戳单独放在 `source.generatedAt`，
**不参与 digest、不参与路由语义**（引擎侧不再用 `nowIso()` 生成 snapshotVersion）。

### 24.9 §八：ReasonCode producer 目录

`ROUTER_REASON_PRODUCERS` 为**每个** reason code 标注唯一 producer：
`POLICY | HARD_FILTER | RANKING | ROUTER_SERVICE | PROVIDER_LAYER | RUNTIME | FUTURE`。
特别标注：`MODEL_NOT_REGISTERED` 与 `PROVIDER_UNAVAILABLE` = `PROVIDER_LAYER`，
`LATENCY_LIMIT_EXCEEDED` = `FUTURE`；`HARD_FILTER_EMITTED_REASONS` 列出的 11 个码才由硬过滤真正产生
（测试保证两者一致）。

## 25. Sprint 10A.0.3 增补：Version & Digest Hardening（关闭评审的 1 HIGH + 4 MEDIUM）

第二次 Cross-Model Review 判定 `PASS WITH CONDITIONS`（无 Blocker，1 HIGH + 4 MEDIUM）。本节冻结修复后的结构。

### 25.1 HIGH：`snapshotVersion` 必须内容绑定（§一）

```text
snapshotVersion = <policyId | 'no-policy'> @ <contentDigest>
```

- 由 `deriveRouterPolicyView` **自己计算**：调用方无法注入时钟，`DeriveRouterPolicyViewInput.snapshotVersion`
  变成**文档化且被忽略的弃用别名**（保留只为旧调用点可编译）；
- 时间戳只能进入 `source.generatedAt`，**不参与** digest、语义版本、路由确定性；
- `assertDerivedPolicyView` 会校验 `snapshotVersion === policyId@contentDigest`，并对**缺失必需字段**报
  `VALIDATION_FAILED`（不得静默补洞）；
- 引擎生产入口（`selectionPolicyService.routerPolicyView()`）不再生成版本，只传 `generatedAt`。

### 25.2 MEDIUM-1：digest 保留 `preferredModels` 顺序（§二）

`contentDigestOf` 采用**分类规范化**：

| 类别 | 字段 | 规范化 |
|---|---|---|
| 集合语义 | `allowedModels · blockedModels · allowedProviders · requiredCapabilities` | 排序（顺序无意义） |
| **顺序语义** | **`preferredModels`** | **保序**（位置 0 = 最高偏好，权重 0.25） |
| 数值 | `maxCost · maxLatency` | 原值 |

因此 `[a,b]` 与 `[b,a]` **digest 必然不同**。
**同时修复**：`createPolicy` 过去用 `normalizeList` **排序** `preferredModels`（破坏顺序语义）→ 改用
`normalizeOrderedList`（仅 trim/lowercase/dedupe，保序）。

### 25.3 MEDIUM-2：digest 覆盖全部安全语义字段（§三）

digest 输入 = `policyId · mode · scopeType · scopeId · fallback`（标量）+ 四个集合 + 保序的 `preferredModels`
+ `maxCost`/`maxLatency`。因此篡改 `mode(MANUAL↔AUTO)`、`fallback(NEVER↔AUTO_WITHIN_POLICY)`、
`scopeType`、`scopeId`、`policyId`、`snapshotVersion` 任一字段都会使校验失败，**无法绕过 HIGH-1 的 mode 门**。

### 25.4 MEDIUM-3：RouterPolicyView 不丢策略字段（§四）

`RouterPolicyView` 顶层新增权威字段 `scopeType · scopeId · fallback`（`source.fallback` 被移除，只保留一个
权威 fallback）；`SelectionRules` 的对应字段改为**必填**。所有消费者（Manual / Override / Hybrid / Auto / Router）
读取同一份派生视图；`evaluateManualSelection` 中唯一的 `'NEVER'` 只用于"**完全没有 policy**"这一种情况
（`policy === null ? 'NEVER' : policy.fallback`），不再有 `allowFallback ?? 'NEVER'` 式的静默补洞。

### 25.5 MEDIUM-4：`NO_ELIGIBLE_MODEL` 不变量（§五）

`validateRecommendation` 现在要求：`selectedModelKey === null` **且**（`rejectedCandidates.length > 0`
**或** 显式提供 `rejectionSummary`）。`ModelRecommendation` 新增 `rejectionSummary: RejectionSummary | null`。
**评审反例（selected=null + rejected=[] + candidateEvaluations 非空）现在必然失败**——候选评估不是"无候选证据"。

### 25.6 §六/§七/§八/§九/§十/§十一

- **`FilteredCandidateSet` 收紧为"带 brand 的数组类型"**：`HardFilterOutcome.candidates` 的类型即 brand 类型
  （brand 符号不导出，运行时就是同一数组），**不再存在未 brand 的副本**；`assertRankingInput` 只接受该类型。
- **`SelectionRules` 正式导出**并成为统一 Policy Interpretation Contract（`selectionRulesFromPolicy` 是唯一适配点）。
- **第二解释器收敛**：`hybridCandidates` / `describeAutoPolicy` 改为消费 `SelectionRules`，排除判定统一走
  `rulesExcludeCandidate`（Hybrid 只保留 presentation 标签；`evaluateManualSelection` 的 fallback 集合也改用它）。
- **`V1_NOT_RANKED_MARKER` 挂到条目上**：`V1_NOT_RANKED_SIGNALS` 现在是 `{key, marker, note}[]`。
- **死代码删除**：`RANKING_HARD_CONSTRAINTS_LEGACY` 移除。
- **ReasonCode 计数修正为 38**（24 正面 + 14 拒绝），并有 tuple length + producer 完整性测试锁定。

## 26. Sprint 10A.0.4 增补：Final Closeout（统一判定 / 结构校验 / 类型化 digest）

### 26.1 唯一候选准入规则（§一/§二）

```text
evaluateCandidateAgainstSelectionRules(candidate, rules, context) → SelectionExclusion[]
```

- **唯一真相源（事实层）**：`evaluateCandidateAgainstSelectionRules()` 产出 policy admission **事实**；
  MANUAL 判定、Human Override、HYBRID 候选集、AUTO presentation 与 Router 的 **policy 级**硬过滤都读取这些事实
  （Router 经 `SELECTION_EXCLUSION_TO_ROUTER_REASON` 把事实映射为自己的 rejection reason）；
  Router 仍自行负责 **registry/runtime 级**硬过滤（启用、可用性、上下文窗口、输出上限、风险/角色约束）；
  `rulesExcludeCandidate()` 只是它的"首个事实"薄包装，`isCandidateAdmissible()` 是集合判定薄包装；
- **事实码 → 展示/错误**：`EXCLUSION_TO_MANUAL_REFUSAL`（事实码 → MANUAL refusal）与
  `SELECTION_EXCLUSION_TO_ROUTER_REASON`（事实码 → Router ReasonCode）是**两张表**，
  调用方只能做映射，不得再自行判定；`UNKNOWN_CAPABILITY` 只是 MANUAL 侧的标签，
  其**事实码恒为 `CAPABILITY_MISSING`**（`unknownCapability: true`）——此前的
  `UNKNOWN_CAPABILITY` / `CAPABILITY_MISSING` 漂移由此消除；
- 显式用户选择仍可越过 `allowedModels` **范围**，但**不得**越过 `blockedModels` / provider / capability / cost
  （`context.explicit` 只影响范围豁免）。

### 26.2 PolicyView 结构与枚举校验（§三/§四/§五）

`validateRouterPolicyViewShape(view)` **先于**任何规范化/digest 运行，并校验：
`source.{policyId,mode,snapshotVersion,generatedAt}`、`scopeType`、`scopeId`、`fallback`、
`allowedModels`、`blockedModels`、`allowedProviders`、`preferredModels`、`requiredCapabilities`、
`maxCost`、`maxLatency`、`derivedBy`、`digest` 的存在性、类型与枚举成员资格
（`MANUAL|AUTO|HYBRID` / `NEVER|ASK|AUTO_WITHIN_POLICY` / `COMPANY|WORKFLOW|ROLE|TASK`）。
任何缺失/非法值一律 `VALIDATION_FAILED`，**不得抛 `TypeError`/`RangeError`**；
校验器整体包裹 try/catch，恶意（Proxy）对象也无法穿透。

### 26.3 类型化 digest（§六）

digest token 携带类型：`null` → `null`、`undefined` → `undefined`、数字 → `num:<v>`、
布尔 → `bool:<v>`、字符串 → `str:<len>:<v>`；集合与保序列表各自带 `set:`/`ord:` 前缀。
因此 `null` / `"null"` / `0` / `"0"` / `false` / `"false"` **不可能编码碰撞**（有碰撞测试）。

### 26.4 冻结与文档一致（§七）

`deriveRouterPolicyView` 现在**真的冻结**：返回对象、`source` 与五个数组都 `Object.freeze`，
派生后的 mutation 会立即失败；文档不再声称未经实现的运行时保证。

### 26.5 引擎与文档对账（§十/§十一）

- 引擎 `routerPolicyView()` 只传 `generatedAt`，**不构造版本字符串**（有结构性集成守卫测试，
  锁住 10A.0.3 曾出现的"Core 修好、生产入口没跟上"回归）；
- 文档计数与代码对账：ReasonCode **24 正面 + 14 拒绝 = 38**；旧 10 键目录不再出现在文档/公开表面。

## 27. Sprint 10A.0.5 增补：Mapping & Docs Truth Closeout

### 27.1 事实拆分（关闭 HIGH）

```text
MODEL_BLOCKED_BY_POLICY  → 命中 blockedModels          → MANUAL: MODEL_BLOCKED_BY_POLICY → Router: MODEL_BLOCKED
NOT_IN_ALLOWED_RANGE     → 仅不在 allowedModels 范围内  → MANUAL: MODEL_BLOCKED_BY_POLICY → Router: NOT_IN_CANDIDATE_SET
```

一个事实码**不得**再承载两种业务含义：硬阻断（不可被显式选择越过）与范围外（显式选择可豁免，ADR-0011 §3）
现在是**两个事实**。MANUAL 侧保留同一展示标签以兼容既有 UI/DomainError；Router 侧的映射各不相同。
`SELECTION_EXCLUSION_CODES` 现为 8 个；Router ReasonCode 仍为 **38**（新事实复用既有 `NOT_IN_CANDIDATE_SET`）。

### 27.2 单一安全边界（§六）

`assertDerivedPolicyView` 把 **shape 校验 → derivedBy → digest → snapshotVersion 交叉校验**整体包在 try/catch 中：
任何不可信输入（含"前几次读取正常、之后 getter 抛错"的有状态 Proxy）只能得到
`Result.err(VALIDATION_FAILED)`，**不得**抛 `TypeError`/`RangeError`/Proxy 异常。

### 27.3 Shape 收紧（§七）

`scopeId` 必须是 `string | null` 且 trim 后非空（空串、数字、对象、数组一律拒绝）；
`maxCost`/`maxLatency` 必须是 **finite** number 或 `null`（`NaN`/`Infinity`/`-Infinity` 一律拒绝）。

### 27.4 文档真实性（§十一/§十二）

ADR 与 `MODEL_ROUTER.md` 只描述 `ROUTER_V1_RANKING` + `V1_NOT_RANKED_SIGNALS`（不再把已删除的 10 键目录当现状）；
ReasonCode 计数统一为 **24 正面 + 14 拒绝 = 38**；删去"Router 硬过滤全部经由统一规则"这类不实表述，
改为 §1 中的真实结构（事实由统一规则产出，Router 负责映射 + registry/runtime 级过滤）；
`PROJECT_HANDOFF.md` 记录 10A.0.3 与 10A.0.4 的完整评审结论（verdict / Blocker / High / Medium / ALLOW 10B / 未关闭项）。

## 28. Sprint 10B 增补：Deterministic Router v1 实现

### 28.1 实现与流水线

`createDeterministicModelRouter(deps)`（`packages/engine/src/router/deterministic-router.ts`）实现 `ModelRouterPort`，
严格按冻结顺序执行：

```text
assertRouterRequestAllowed → applyHardFilters（内部先校验派生视图）→ rankCandidates
  → selectWinner（冻结 tie-break）→ 组装 ModelRecommendation → validateRecommendation → 审计
```

- **硬过滤复用**：Ranking 的输入只能是 `applyHardFilters` 产出的 `FilteredCandidateSet`（branded 数组），
  Router 内**没有**第二套 blocked/provider/capability/cost 判定；
- **零候选**：`NO_ELIGIBLE_MODEL` + `rejectionSummary` + `candidateEvaluations = []`，绝不猜模型；
- **推荐即止**：不调 Provider、不执行 Agent、不改 Policy/Registry/Benchmark、不执行 fallback
  （`fallbackContract()` 只产出 `decideFallback` 契约）；
- 依赖方向：engine → core（无 provider、无 runtime、无 IO）；`RouterDecisionRecord/StorePort` 定义在
  **Core 端口**，由 persistence 实现（避免 persistence → engine 的反向依赖）。

### 28.2 排名引擎（Core 纯函数）

`packages/core/src/domain/model-router-ranking.ts`：`rankCandidates(set, context)` 只读 `ROUTER_V1_RANKING` /
`ROUTER_V1_WEIGHTS`，逐信号计算并记录 `signalScores / availableWeights / normalisedScore / reasonCodes /
tieBreakFacts`（§十六 可解释性）；**缺失 = 跳过并重归一化剩余权重**，全部可选数据缺失时仍确定（退化为
硬过滤 + 稳定 tie-break，`TIE_BREAK_APPLIED`）；`providerHealth` 归一化 healthy 1.0 / degraded 0.5 / unknown 0.25；
cost/latency 在候选集内 min/max 反演（全等 → 0.5 中性）；historical = `successRate × sampleConfidence`；
benchmark 信号 = `score × benchmarkAdjustment`（stale ×0.5、external ×0.75），**权重 0.10 只在总分里乘一次**
（Sprint 10B.1 §十 修正：`effectiveBenchmarkWeight` 已弃用，把它折进信号分会导致权重双计）。

### 28.3 审计与持久化

- 审计经注入的 `RouterAuditEmitter` 端口发射六个 `router.*` 事件，payload **白名单**：requestId/taskId/roleId/
  selectionMode/routerVersion/policySnapshotVersion/modelRegistryRevision/candidateCount/rejectedCount/
  selectedModelKey/reasonCodes/traceId；**禁止** secret / credential / 完整 prompt / 上下文正文；
- `router_decisions`（`migrations/router/0001_router_decisions.sql` + `createSqliteRouterDecisionStore`）保存
  decision/provenance/理由码/候选评估（默认 top-10），使"当时为什么选它"在重启后仍可回答；
- **本轮未完成（10B.1 backlog）**：① 组合根的 `router_decisions` 链请求（`chains` 追加 `'router'` 会触及三条既有
  边界断言的精确列表，改由 10B.1 一并更新）；② 六个 `router.*` 事件的**持久化**发射绑定（当前组合根用结构化日志
  适配）；③ `router.recommend` 的 IPC 曝光。

## 29. Sprint 10B.1 增补：Router Reachability & Durable Audit

### 29.1 生产可达性

- 组合根（`apps/desktop/src/main.ts`）的迁移链请求现已包含 **`router`** ⇒ 启动即创建 `router_decisions`；
  链清单唯一真相源是 `tests/shared/expected-chains.ts`（三条历史边界测试改为引用它，不再复制正则）。
- **IPC 边界**（`workflows.ts`）：`router.recommend` / `router.override.request` / `router.override.confirm`。
  客户端**只能**提供 scope（company/workflow/run/stage/task/role）、requirements、selectionMode、traceId/actorId；
  `CLIENT_FORBIDDEN_ROUTER_KEYS` 明确拒绝 `policyView`、`candidateModels`、`allowedModels`、`blockedModels`、
  `allowedProviders`、`requiredCapabilities`、`preferredModels`、`request`、`routerRequest`。
  **RouterPolicyView 与候选快照由应用层（Policy Service + Model Registry）派生。**
- **推荐 ≠ 执行**：`router.recommend` 只返回 `ModelRecommendation`；不调 Provider、不调 Agent Runtime、
  不执行 fallback；Runtime 仍只接受明确 `modelKey`，且不 import Router。

### 29.2 Durable audit 与事务语义（**非原子**，如实记录）

- 六个 `router.*` 事件经 `database.events.append([defineEvent({...}, ids, clock.nowIso())])` 写入 durable event store；
  payload 仍是 12 字段白名单（requestId/taskId/roleId/selectionMode/routerVersion/policySnapshotVersion/
  modelRegistryRevision/candidateCount/rejectedCount/selectedModelKey/reasonCodes/traceId），
  **绝不写入** RouterRequest / ModelRecommendation / prompt / context / secret / credential。
- **当前事务语义不是原子的**：决策与事件经两个不同端口写入。冻结 ordering = **decision 先 → event 后**
  （成功路径与 NO_ELIGIBLE_MODEL 路径都是这个顺序）。已提供 `reconcileRouterAudit({decisions, auditedRequestIds})`
  + `repairPayloadOf(gap)` 作为对账/补发工具；**但事件存储目前没有"按类型查询"能力，因此生产启动接线尚未落地**
  （列为 10B.2 第一项）。在接线完成前，**不得声称"启动自动对账已启用"**。
- 持久化有界：默认 top-20 评估（`MAX_STORED_EVALUATIONS`）+ 20 条拒绝明细，结构化为
  `{ totalCandidateCount, storedEvaluationCount, truncated, … }`；`decision_id` 冲突**显式失败**
  （`PERSISTENCE_FAILED` + `DECISION_PERSISTENCE_FAILED`）。

### 29.3 rankingContext 的真实来源

| 信号 | 来源 | 缺失语义 |
|---|---|---|
| `providerHealth` | 真实 Provider Registry（`boundProviderIds()` + `health(id)`）；非 healthy/degraded 一律 **`unknown`（0.25）** | 允许 unknown，**禁止默认 healthy** |
| `historicalSuccessRate` | 无真实指标源则不装配 | `SKIP_AND_RENORMALISE` |
| `benchmarkMetadata` | 无真实持久化 benchmark 则不装配 | `SKIP_AND_RENORMALISE`（stale ×0.5 / external ×0.75 保留） |
| `modelRegistryRevision` | `registryRevisionOf(records)`：registry **内容**派生的稳定摘要（无时钟、无随机） | 同内容同 revision；内容变则变 |

### 29.4 本轮测试发现的真实缺陷（如实记录）

A–AP 套件抓到一处**生产级 SQL 缺陷**：把 `ON CONFLICT(decision_id) DO NOTHING` 替换为 `--` 注释时，
注释吃掉了 INSERT 的收尾括号 ⇒ `near ")" syntax error`，`router_decisions` 完全无法写入。
修复（普通 INSERT，说明性注释移到语句之前）后持久化与重启测试全绿。
教训：**只有跑真实 SQLite 的断言才能发现这类问题。**

## 30. Sprint 10B.2 增补：Reachability E2E & Startup Reconciliation

### 30.1 行为级可达性（不再是文本级）

`tests/sprint10b-2/reachability-e2e.test.ts` 用**真实组件 + 真实 SQLite 文件**跑完整链路
（应用服务 → 确定性 Router → `router_decisions` → durable `events`），并直接查库断言：
`router_decisions` 里的决策字段、`events` 里的 `router.requested` / `router.candidates_built` /
`router.recommendation_created` / `router.no_candidate` / `router.override_requested` /
`router.override_confirmed`。**不再依赖 mock emitter 或源码 grep 来证明行为**（源码断言仅作为
"组合根不可被静默删除"的补充守卫）。

### 30.2 启动对账正式接线（幂等）

组合根启动时调用 `reconcileAndRepairRouterAudit(...)`：读取最近 500 条 `router_decisions`，
读取 durable events 中已覆盖的 requestId，计算 gap，对每个 gap 以 **同一事件类型** 补发一条并打标
`reconciled: true` + `repairReason: 'MISSING_RECOMMENDATION_EVENT'`（`ROUTER_AUDIT_REPAIR_KEYS` 是白名单里
唯一允许的额外键），且 payload 中的 `selectionMode`/`candidateCount`/`rejectedCount` 取自**决策真实值**。

**已审计的判定必须包含两种终态事件**（`ROUTER_TERMINAL_AUDIT_EVENT_TYPES`）：
`router.recommendation_created`（RECOMMENDED）与 `router.no_candidate`（NO_ELIGIBLE_MODEL）。
只统计前者会把每一次"无候选"误判为缺事件并写出**伪造的补发事件**（审计污染）——这是 10B.2 评审发现的 HIGH，
已修复并加了回归测试（no-candidate 决策不是 gap，且不会凭空出现 `recommendation_created`）。

**幂等**：补发后该 requestId 已被视为已审计，第二次/第三次启动 repaired = 0（有三次启动的测试）。

### 30.3 事务语义（继续诚实）

```text
正常路径：decision → event
崩溃窗口：decision 存在 / event 缺失
恢复：startup reconciliation（幂等补发）
```

**仍然不是 ACID 原子**：10B.2 不引入分布式事务，只把非原子窗口变成**可恢复**。文档不得写"原子"。

### 30.4 计数与新鲜度语义

- `candidateEvaluationsJson`：`totalCandidateCount` = **进入 Router 的候选数**，
  `eligibleCandidateCount` = 硬过滤后剩余数，`storedEvaluationCount`/`truncated` 描述落库规模
  （修复"NO_ELIGIBLE 时 totalCandidateCount = 0"的歧义）。
- Provider health 带 `providerHealthObservedAt`；超过 `DEFAULT_PROVIDER_HEALTH_MAX_AGE_MS`（5 分钟）
  的观测**降级为 `unknown`（0.25）**，不得把启动快照当作实时健康。
- Run/Stage 是**上下文 id**，不是 policy scope：只有 `COMPANY` / `WORKFLOW` / `ROLE` / `TASK` 进入 scope 阶梯
  （`workflowId` 补齐后可真实命中 WORKFLOW 策略，有测试）。
- IPC 只保留**一个** forbidden-key 校验入口（删除 `workflows.ts` 中读取被禁字段名的死代码）。

## 后果

**收益**

- "选模型"这件事第一次有了**可解释的规则说明书**：每条建议都带理由码与拒绝清单，而不是"综合表现更好"；
- Hard Filter 与 Ranking 的**结构分离**写进了类型与测试，从源头杜绝"高分复活被禁模型"；
- Benchmark 与历史数据被明确定位为**信号**（有上限、可缺失、可降权），不会变成唯一决定因素；
- 人工指定权、blockedModels 硬阻断、fallback 边界全部沿用既有 ADR，不引入新的例外；
- 版本与 provenance 让"当时为什么选它"可回溯。

**代价与限制**

- 规则引擎的表达力有限：跨模型的复杂权衡（如"贵但质量高"的整体最优）不在第一版范围；
- 权重与阈值的**具体数值**尚未落定（10B 需要 ADR 补充或配置化），当前只有上限与方向；
- `RouterRequest` 需要调用方提供 policy view 与候选集，装配成本转移给上层；
- 仍无 Router 实现，AUTO 在运行时依旧返回 `MODEL_SELECTION_REQUIRED`/`ROUTER_NOT_AVAILABLE`。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 用另一个 LLM 决定选哪个 LLM（LLM-as-Router） | 不可审计、不可复现、不可测试；用户明令禁止 |
| benchmark 排名第一自动获胜 | 用户明确禁止；benchmark 只是信号且可缺失/过期 |
| Router 直接调用 Provider / Agent Runtime | Router 是建议生成器，执行属 Runtime 职责 |
| Router 修改 Policy 或 benchmark 数据 | 越权，且会让"为什么"不可信 |
| Hybrid 时"顺手扩一点候选" | 会绕过人工给定的范围，破坏 HYBRID 的意义 |
| 无候选时取候选列表第一个 | 静默猜测，正是 §十三/§十四 禁止的行为 |
| 把 tie 交给随机/时间戳 | 破坏"相同输入相同输出"，无法复现 |

## 20. Closeout-10A 增补 A：Router v1 数值策略（冻结，STEP 2）

**排序阶段顺序（冻结）**：

```text
Hard Filters → User Preference → Provider Health → Context Headroom → Cost → Latency
             → Historical Performance → Benchmark → Stable Tie Break
```

**每个信号的六项事实（实现必须照此，不得自定义语义）**：

| signal | 数据来源 | 缺失处理 | 归一化 | 权重（上限） | 参与 tie-break | 可突破 Hard Filter |
|---|---|---|---|---|---|---|
| `preferredModelsPosition` | `RouterPolicyView.preferredModels`（用户/策略偏好顺序） | 跳过并重归一化 | 序数：第 0 位 1.0 / 第 1 位 0.6 / 第 2 位 0.3 / 不在列表 0 | 0.25 | **是** | **否** |
| `providerHealth` | Provider 注册表的 `lastHealth` | 跳过并重归一化 | healthy 1.0 / degraded 0.5 / unknown 0.25（unavailable 已在硬过滤被淘汰） | 0.20 | **是** | **否** |
| `contextHeadroom` | `ModelRecord.contextWindow` vs `estimatedInputTokens + requiredOutputTokens` | 跳过并重归一化 | `min(1, (window − input − output) / window)`，钳制到 [0,1] | 0.15 | 否 | **否** |
| `estimatedCost` | `ModelRecord.pricing` | 跳过并重归一化 | 候选集内 min/max 反演：`1 − (cost − min)/(max − min)`；全等 → 0.5（中性） | 0.15 | **是** | **否** |
| `estimatedLatency` | 历史 `avgLatencyMs`，否则 provider 健康延迟基线 | 跳过并重归一化 | 同 cost 的 min/max 反演；全部未知 → 0.5（中性） | 0.10 | **是** | **否** |
| `historicalSuccessRate` | `HistoricalPerformanceSnapshot`（successRate/reviewPassRate/reworkRate） | 跳过并重归一化 | `successRate × sampleConfidence(sampleCount)`：0 样本 → 跳过；< 20 → 降权；≥ 20 → 全权重 | 0.05 | 否 | **否** |
| `benchmarkMetadata` | `BenchmarkReference`（harness/external + benchmarkVersion） | 跳过并重归一化 | `score × benchmarkAdjustment`（stale ×0.5、external ×0.75）；权重仅在总分乘一次 | **0.10（硬上限 0.15）** | 否 | **否** |

**总和**：`0.25 + 0.20 + 0.15 + 0.15 + 0.10 + 0.05 + 0.10 = 1.00`；`BENCHMARK_WEIGHT_CAP = 0.15` 仍生效。
**所有信号的 `canBreakHardFilter` 恒为 `false`**（`ROUTER_V1_RANKING` 中逐条声明，测试断言）。

**缺数据时的行为（必须明确）**：任一信号缺失 → **跳过该信号并把剩余权重按比例归一化**（不是记 0 分）；
因此**全部可选信号缺失时 Router 仍能工作**——退化为"硬过滤 + 稳定 tie-break"，仍然确定、仍然可解释。
`sampleConfidence(sampleCount)`：`0 → 0`（中性）、`< 20 → 按比例`、`≥ 20 → 1`。

**明确不做**：复杂优化器、机器学习 Router、LLM-as-Router、多模型投票 —— 第一版就是**确定性规则排序**。

## 21. Closeout-10A 增补 B：RouterPolicyView 由 Policy Service 统一派生（STEP 3）

```text
ModelSelectionPolicy Service
        │  resolvePolicy(scopes)  →  deriveRouterPolicyView(policy, requirements)
        ▼
   RouterPolicyView（唯一解释）
        ▼
      Router（只接收已解析快照）
```

- `RouterPolicyView` 是 Router **唯一可消费**的策略形态：`source{policyId,scopeType,scopeId,mode,fallback,snapshotVersion}`
  + `allowedModels` / `blockedModels` / `allowedProviders` / `preferredModels` / `requiredCapabilities` /
  `maxCost` / `maxLatency` + `derivedBy` + `digest`；
- `RouterRequest` **不再接受** `allowedModels?` / `blockedModels?` / `allowedProviders?` / `preferredModels?` /
  `requiredCapabilities` 这些散字段——它们只能来自视图；
- `deriveRouterPolicyView()` 是 Core 纯函数（确定性、排序稳定、带 digest）；
- 引擎侧由 **Model Selection Policy Service** 暴露 `routerPolicyView({scopes, requiredCapabilities, actorId})`
  （授权 `model.read`），**Runtime / UI 不得自行拼 policy 列表**（有边界测试）；
- `assertDerivedPolicyView()` 拒绝"手工拼装"或"派生后被篡改"的视图（digest 不匹配即拒绝）。

## 22. Closeout-10A 增补 C：Router v1 Contract Freeze（STEP 4）

**冻结的契约名**（后续破坏性改动必须升版本 + 新 ADR）：

`RouterRequest` · `RouterPolicyView` · `CandidateEvaluation` · `RejectedCandidate` ·
`ModelRecommendation` · `RouterProvenance` · `OverrideRecord`（HumanOverrideRecord）·
`FallbackDecision` · `ModelDiversityConstraint`（DiversityConstraint）· `RouterRiskConstraint`（RiskConstraint）·
`RouterDecision`/`RouterReasonCode`（ReasonCode 闭集，24 正面 + 14 拒绝 = 38）· `CandidateModel`（= `ModelRecord` 视图）。

**版本**：`routerVersion = 'model-router/v1'`（`ROUTER_VERSION` 常量；测试锁定）。
**冻结的数值**：见 §20（`ROUTER_V1_RANKING` / `ROUTER_V1_WEIGHTS` / `routerV1Policy()`）。
**冻结的语义**：§1–§19（职责边界、三模式、优先级、流水线、Hard/Ranking 分离、fallback、override、provenance）。

## 23. Closeout-10A 状态说明（评审如实记录）

Sprint 10A 的 **Independent Review 未能完成**：评审进程三次运行中断（同一评审 agent 两次 + 一个新起的只读
reviewer subagent 一次），均未产出结论。因此本 ADR 与契约的冻结**建立在自检之上**：
`tests/sprint10a/router-contract.test.ts`（A–S，20 条）与 `tests/sprint10a-open/policy-view-freeze.test.ts`
（STEP 2/3/4，11 条）合计 31 条不变式测试，外加用户要求的 20 点自检（记录于 `PROJECT_HANDOFF.md`）。
**补齐独立评审仍是最优先欠账**，且 10B 实现前必须先完成。
