# Model Router（Sprint 10A 契约 → 10B/10B.2 **已实现并接线**）

> 一句话：**Router 在 Policy 已经允许的候选空间内，按确定性、可解释、可测试的规则生成建议；
> 它不选执行、不改策略、不调 Provider。**
> 依据：用户 Sprint 10A 规格 §一–§二十四；ADR-0014（架构）、ADR-0011（优先级与 fallback）、
> ADR-0012（Runtime 必须拿到明确 `modelKey`）。
> **本 Sprint 只交付契约与纯规则；没有任何 Router 服务被装配或调用（见 §9）。**

## 1. 职责边界

**做**：过滤候选（Hard Filter）· 生成 `ModelRecommendation`（建议 + 理由 + 拒绝清单 + 来源 + 版本）· 解释"为什么"。
**不做**：修改 Policy · 绕过 `blockedModels` · 覆盖 Explicit User Choice · 改 MANUAL · 擅自 fallback ·
调 Provider · 执行 Agent · 改 Workflow/Role/Benchmark 数据。

## 2. 三模式语义

| 模式 | Router | 失败语义 |
|---|---|---|
| `MANUAL` | **不参与**（`routerAppliesTo` → false；出参 `MANUAL_NOT_ROUTED`） | 指定模型不可用 → 明确失败原因；fallback 服从 `NEVER`/`ASK`/`AUTO_WITHIN_POLICY` |
| `HYBRID` | 只在人工范围内选 | 越界 → `PROVIDER_NOT_ALLOWED` / `NOT_IN_CANDIDATE_SET`；**不得扩展候选集** |
| `AUTO` | 在 Policy 完整范围内自动选 | 仍受 Company/Workflow/Role/Task 策略约束 |

优先级（冻结）：`Explicit User Choice > Task Override > Role Policy > Workflow Policy > Company Policy >
Router Recommendation > Global Default`；`blockedModels` 是**硬阻断**（显式选择也不能越过）。

## 3. Candidate Pipeline（顺序即契约）

`ALL_REGISTERED_MODELS → ENABLED_FILTER → AVAILABILITY_FILTER → PROVIDER_ALLOWED_FILTER →
BLOCKED_MODELS_FILTER → REQUIRED_CAPABILITIES_FILTER → CONTEXT_WINDOW_FILTER → MAX_OUTPUT_FILTER →
COST_CONSTRAINT → LATENCY_CONSTRAINT → RISK_ROLE_CONSTRAINTS → CANDIDATE_SET → ROUTER_RANKING → RECOMMENDATION`

- `ROUTER_HARD_FILTER_STAGES` 止于 `CANDIDATE_SET`；`ROUTER_PRESENTATION_STAGES` 只有后两段；
- **被 Hard Filter 淘汰者永不复活**（`applyHardFilters` 的 `candidates` 与 `rejected` 互斥，有测试）。

## 4. Reason Code 目录（闭集）

**正面理由**：`MANUAL_EXPLICIT_CHOICE · TASK_OVERRIDE · ROLE_POLICY · WORKFLOW_POLICY · COMPANY_POLICY ·
GLOBAL_DEFAULT · REQUIRED_CAPABILITIES_MATCH · PREFERRED_MODEL · ALLOWED_PROVIDER · PROVIDER_HEALTHY ·
PROVIDER_DEGRADED · CONTEXT_HEADROOM · OUTPUT_LIMIT_SATISFIED · WITHIN_COST_LIMIT · LOWER_ESTIMATED_COST ·
LOWER_ESTIMATED_LATENCY · HISTORICAL_SUCCESS_RATE · REVIEW_PASS_RATE · LOW_REWORK_RATE · BENCHMARK_SIGNAL ·
NO_BENCHMARK_DATA · SMALL_SAMPLE_DOWNWEIGHTED · TIE_BREAK_APPLIED`

**拒绝理由**：`MODEL_NOT_REGISTERED · MODEL_DISABLED · MODEL_UNAVAILABLE · PROVIDER_NOT_ALLOWED ·
PROVIDER_UNAVAILABLE · MODEL_BLOCKED · CAPABILITY_MISSING · CONTEXT_TOO_SMALL · OUTPUT_LIMIT_TOO_SMALL ·
COST_LIMIT_EXCEEDED · LATENCY_LIMIT_EXCEEDED · DIVERSITY_CONFLICT · RISK_CONSTRAINT_UNSATISFIED ·
NOT_IN_CANDIDATE_SET`

**禁止自由文本理由**（如"综合表现更好"）：所有解释必须由上面的码组成。

## 5. Explainability 模型（可审计的"为什么"）

```text
Selected: model-b
Reasons:  REQUIRED_CAPABILITIES_MATCH · PREFERRED_MODEL · PROVIDER_HEALTHY ·
          WITHIN_COST_LIMIT · LOWER_ESTIMATED_LATENCY
Rejected: model-a → STRUCTURED_OUTPUT_MISSING(CAPABILITY_MISSING)
          model-c → COST_LIMIT_EXCEEDED
Tie:      TIE_BREAK_APPLIED（PREFERRED_POSITION → LOWER_ESTIMATED_COST → LOWER_ESTIMATED_LATENCY
                            → HIGHER_PROVIDER_HEALTH → LEXICAL_MODEL_KEY）
```

`ModelRecommendation` 同时携带 `rejectedCandidates[]` 与 `candidateEvaluations[]`，
因此 UI/审计不需要再问 Router 任何问题。

## 6. Ranking 信号与上限

`ROUTER_V1_RANKING`（唯一 v1 ranking 目录）：
`preferredModelsPosition → providerHealth → contextHeadroom → estimatedCost → estimatedLatency →
historicalSuccessRate → benchmarkMetadata`
（`V1_NOT_RANKED_SIGNALS` 单独列出 v1 **不参与**排序的信号：`requiredCapabilityFit` / `reviewPassRate` / `reworkRate`）。
（`ROUTER_V1_RANKING` 是**唯一** ranking 目录，含 `direction`/`missing`/`maxWeight`；`benchmarkMetadata` 权重 0.10、上限 **0.15**）。

- `requiredCapabilityFit` 与 risk 属**硬约束**（`RANKING_HARD_CONSTRAINTS`），不是"分高就行"；
- benchmark/historical 缺失一律 **跳过并重归一化（`SKIP_AND_RENORMALISE`）**——不是"差"，也不是记 0 分；
- **禁止**用另一个 LLM 决定选哪个 LLM；**禁止**多模型投票。

## 7. Benchmark / Historical 契约

- Benchmark：可缺失（Router 仍工作）· 可过期（stale ×0.5）· 可跨版本（记 `benchmarkVersion`）·
  `harness` 与 `external` 区分（external ×0.75）· **不能突破 Hard Policy**；
- Historical：`successRate · reviewPassRate · reworkRate · failureRate · avgLatencyMs · avgCost · sampleCount`；
  `sampleConfidence()`：无样本 → 0（中性）、小样本（< 20）→ 按比例降权、≥ 20 → 1；不得突破 Policy。

## 8. Fallback / Override / Diversity / Risk 契约

| 契约 | 行为 |
|---|---|
| `decideFallback` | `NEVER → STOP`（无自动替代）｜`ASK → ASK_USER`（等确认）｜`AUTO_WITHIN_POLICY → AUTOMATIC_WITHIN_CANDIDATES`（候选 = 已过滤集，禁止跨策略） |
| `routerUnavailableOutcome` | MANUAL → `MANUAL_NOT_ROUTED`；有明确 key → `MANUAL_NOT_ROUTED`；AUTO/HYBRID 无 key → `ROUTER_NOT_AVAILABLE`（**不得**取"列表第一个"） |
| `noCandidateOutcome` | `NO_ELIGIBLE_MODEL` + `{checked, byReason, summaryText}` |
| `applyHumanOverride` / `overrideRecord` | 合法人工选择**永远不被 Router 阻止**；记录 `routerRecommendation` + `userFinalSelection` + `agreement` |
| `ModelDiversityConstraint` | `NONE` / `DIFFERENT_FROM_PREVIOUS_ROLE` / `DIFFERENT_FROM_DEVELOPER` / `DIFFERENT_PROVIDER`（冲突 → `DIVERSITY_CONFLICT`，Hard Filter） |
| `RouterRiskConstraint` | 钩子 `ALLOW_LOW_COST_MODELS` / `REQUIRE_REASONING_CAPABILITY` / `REQUIRE_MINIMUM_QUALITY_TIER` / `REQUIRE_MANUAL_CONFIRMATION`（**只定义，不硬编码业务**） |

## 9. 端口与实现状态（Sprint 10B/10B.2 起**已实现并接线**）

`ModelRouterPort`（`packages/core/src/ports/model-router.ts`）只有一个方法 `recommend(request)`；
它的唯一实现是 `createDeterministicModelRouter()`（`@companyos/engine`），由**组合根**装配并经应用服务
`createRouterApplicationService()` 暴露给 IPC（`router.recommend` / `router.override.*`）。
Runtime / Tool Registry **仍然不依赖** Router（Runtime 只接受明确 `modelKey`）。

- `ModelRouterPort`（`packages/core/src/ports/model-router.ts`）**只有一个方法** `recommend(request)`；
  **没有任何实现**：`packages/engine` 未导出 Router，组合根未装配，Runtime/Tool Registry 也**不依赖**它；
- 因此当前行为不变：AUTO 请求仍旧 `MODEL_SELECTION_REQUIRED`（Runtime 侧）/ `ROUTER_NOT_AVAILABLE`（契约侧）；
- 审计事件 `router.requested · router.candidates_built · router.recommendation_created ·
  router.no_candidate · router.override_requested · router.override_confirmed` 已登记类型，
  但**尚未有发射方**（Core 事件表标记为 Sprint 10 待发射）。

## 10. Versioning / Provenance

每条建议记录 `routerVersion('model-router/v1') · policySnapshotVersion · modelRegistryRevision ·
benchmarkVersion? · performanceSnapshot?` —— 用于回答"某年某月当时为什么选它"。

## 11. 测试（A–S）

`tests/sprint10a/router-contract.test.ts`（19 条）：
A MANUAL 不经过 Router｜B Explicit 优先｜C blocked 硬阻断｜D Hybrid 不越界｜E Auto 受 policy｜
F Hard Filter 不可被 ranking 复活（含 pipeline 顺序断言）｜G No Candidate｜H Router unavailable｜
I NEVER｜J ASK｜K AUTO_WITHIN_POLICY 不越界｜L Benchmark 可选且有上限｜M Historical 可选且小样本降权｜
N Tie-break 契约｜O 相同输入相同输出｜P Human override 契约｜Q 版本记录｜
R Runtime/Tool Registry 不承担 Router 职责｜S 契约无实现、无厂商名、无 LLM-as-Router。

## 12. RouterPolicyView（Closeout-10A STEP 3）

```text
Model Selection Policy Service ──resolvePolicy(scopes)──► deriveRouterPolicyView() ──► RouterPolicyView ──► Router
```

- **唯一解释**：`RouterRequest.policyView` 是 Router 能看到的全部策略信息（`allowedModels` / `blockedModels` /
  `allowedProviders` / `preferredModels` / `requiredCapabilities` / `maxCost` / `maxLatency` + `source` 快照元数据）；
- **禁止手工拼装**：`RouterRequest` 不再有散落的策略字段；`assertDerivedPolicyView()` 会拒绝
  `derivedBy` 不对或 digest 不匹配（派生后被改）的视图；
- **生产入口**：`selectionPolicyService.routerPolicyView({ scopes, requiredCapabilities, actorId })`（授权 `model.read`）；
  Runtime / UI / Tool Registry 都不得自己拼 policy 列表（有边界测试）；
- 派生是**确定性**的：同一 policy + 同一 requirements → 同一视图 + 同一 digest。

## 13. Router v1 数值策略（冻结，Closeout-10A STEP 2）

阶段顺序：`Hard Filters → User Preference → Provider Health → Context Headroom → Cost → Latency → Historical → Benchmark → Stable Tie Break`。

| signal | 权重（上限） | 缺失 | tie-break | 可破 Hard Filter |
|---|---|---|---|---|
| `preferredModelsPosition` | 0.25 | 跳过并重归一化 | 是 | **否** |
| `providerHealth` | 0.20 | 跳过并重归一化 | 是 | **否** |
| `contextHeadroom` | 0.15 | 跳过并重归一化 | 否 | **否** |
| `estimatedCost` | 0.15 | 跳过并重归一化 | 是 | **否** |
| `estimatedLatency` | 0.10 | 跳过并重归一化 | 是 | **否** |
| `historicalSuccessRate` | 0.05 | 跳过并重归一化 | 否 | **否** |
| `benchmarkMetadata` | **0.10（硬上限 0.15）** | 跳过并重归一化 | 否 | **否** |

权重总和恰为 `1.00`（测试断言）；每个信号都声明 `source` / `normalization` / `maxWeight` / `tieBreak` /
`canBreakHardFilter: false`（`ROUTER_V1_RANKING`，测试逐条断言）。
**缺数据 → 跳过该信号并重归一化剩余权重**（不是记 0 分）⇒ **全部可选信号缺失时 Router 仍能工作**
（退化为硬过滤 + 稳定 tie-break，仍确定、仍可解释）。`sampleConfidence`：0 样本中性、< 20 降权、≥ 20 全权重。

## 14. 契约冻结（Closeout-10A STEP 4）

`routerVersion = 'model-router/v1'`（常量，测试锁定）。冻结的契约：`RouterRequest` · `RouterPolicyView` ·
`CandidateEvaluation` · `RejectedCandidate` · `ModelRecommendation` · `RouterProvenance` · `OverrideRecord` ·
`FallbackDecision` · `ModelDiversityConstraint` · `RouterRiskConstraint` · `ReasonCode`（**24 正面 + 14 拒绝 = 38**）。
**后续破坏性改动必须升版本 + 新 ADR。**

## 16. Hardening（Sprint 10A.0.2，评审条件修复）

| 主题 | 冻结结构 |
|---|---|
| MANUAL 强制门 | `assertRouterRequestAllowed(request)` 是 `recommend()` 的**第一条规则**；拒绝 MANUAL / 有 `manualModelKey` / 视图 mode=MANUAL → `MANUAL_NOT_ROUTED`。`applyHardFilters` 入口顺序：`assertRouterRequestAllowed → assertDerivedPolicyView → Hard Filters` |
| 防篡改 | `applyHardFilters` 返回 `Result`；digest（现覆盖 7 个字段，含 `maxCost`/`maxLatency`）不匹配或 `derivedBy` 非法 ⇒ `VALIDATION_FAILED`，**不进流水线** |
| 唯一 ranking 目录 | `ROUTER_V1_RANKING` 为唯一真相源；旧 10 键目录已从代码与公开表面删除；缺失语义统一 `SKIP_AND_RENORMALISE`；`V1_NOT_RANKED_SIGNALS`（`requiredCapabilityFit`/`reviewPassRate`/`reworkRate`）逐条带 `V1_NOT_RANKED` 标记；`RANKING_HARD_CONSTRAINTS` 是阶段名而非信号 |
| Latency | `LATENCY_FILTER_MODE = NO_DATA_NO_HARD_FILTER`：v1 不淘汰候选、不假装 `maxLatency` 生效；`LATENCY_LIMIT_EXCEEDED` producer = `FUTURE`；解释用 `LATENCY_DATA_UNAVAILABLE`；`HardFilterOutcome.latencyFilter` 显式声明 |
| Recommendation 不变式 | `validateRecommendation()`：`RECOMMENDED` 需 selected + ≥1 正面码；`NO_ELIGIBLE_MODEL` 不得带 selected 且有拒绝记录；`AWAITING_CONFIRMATION` 需 `ASK`；`MANUAL_NOT_ROUTED`/`ROUTER_NOT_AVAILABLE` 不得伪造；`REFUSED_HARD_BLOCK` 需带被拒候选 → 否则 `RECOMMENDATION_INVALID` |
| 单一 Policy 解读 | `manualOutcome(request)` / `applyHumanOverride({policyView})` 与 Router 共用派生视图与同一 `evaluateManualSelection` |
| 名义候选集 | `FilteredCandidateSet`（brand 不导出）+ `assertRankingInput(set)`：被淘汰者无法在类型层面回到排序 |
| snapshotVersion | 语义版本（`policyId@digest`，参与 digest）；`source.generatedAt` 是 provenance 时间戳（不参与 digest/语义） |
| ReasonCode producer | `ROUTER_REASON_PRODUCERS` 全量标注；`HARD_FILTER_EMITTED_REASONS` = 硬过滤真正产生的 11 个码 |

## 18. Version & Digest Hardening（Sprint 10A.0.3）

| 主题 | 冻结结构 |
|---|---|
| 语义版本 | `source.snapshotVersion = <policyId|'no-policy'>@<contentDigest>`，由 `deriveRouterPolicyView` 计算；`assertDerivedPolicyView` 交叉校验；`DeriveRouterPolicyViewInput.snapshotVersion` 是**被忽略的弃用别名**（时钟不得进入语义）；时间只进 `source.generatedAt` |
| digest 规范化 | 集合字段（allowed/blocked/providers/requiredCapabilities）排序；**`preferredModels` 保序**（权重 0.25）；数值 `maxCost`/`maxLatency`；标量 `policyId/mode/scopeType/scopeId/fallback`。`contentDigestOf(view)` 可复核 |
| 生产入口 | `selectionPolicyService.routerPolicyView()` 只传 `generatedAt`，不再生成版本；`createPolicy` 用 `normalizeOrderedList` **保序**保存 `preferredModels` |
| 视图完整性 | 顶层权威字段 `scopeType/scopeId/fallback`（`source.fallback` 已移除）；缺失必需字段 → `VALIDATION_FAILED`；`SelectionRules` 对应字段必填；`policy === null` 是唯一允许 `'NEVER'` 的情形 |
| 推荐不变式 | `NO_ELIGIBLE_MODEL` 需 `selected === null` **且**（`rejectedCandidates.length > 0` **或** 显式 `rejectionSummary`）；候选评估**不构成**无候选证据 |
| 候选集 | `FilteredCandidateSet` = 带 brand 的 `readonly ModelRecord[]`；`HardFilterOutcome.candidates` 即该类型（无未 brand 副本）；`assertRankingInput` 为唯一排序入口 |
| 统一解释 | `SelectionRules`（导出）+ `selectionRulesFromPolicy` + `rulesExcludeCandidate`：Manual/Override/Hybrid/Auto/Router 共用，不再各自实现判定 |
| 目录 | `V1_NOT_RANKED_SIGNALS` 每条带 `marker: 'V1_NOT_RANKED'` + `note`；死常量删除；ReasonCode **38** 个（24 正面 + 14 拒绝），producer 全覆盖 |

## 21. 实现（Sprint 10B）

| 项 | 结构 |
|---|---|
| 实现 | `createDeterministicModelRouter(deps)`（engine）→ `recommend(request)`：`assertRouterRequestAllowed → applyHardFilters → rankCandidates → selectWinner → validateRecommendation → audit` |
| 排名 | `rankCandidates(set, context)`（Core 纯函数）：冻结权重、逐信号明细、缺失跳过重归一化、稳定 tie-break |
| 推荐 | `RECOMMENDED`（带 ≥1 正面理由码）/ `NO_ELIGIBLE_MODEL`（带 `rejectionSummary`，绝不猜） |
| fallback | 只产出 `decideFallback` 契约（`fallbackContract()`），**从不执行** |
| 审计 | 注入 `RouterAuditEmitter`：六个 `router.*` 事件 + 白名单 payload（无 secret/prompt） |
| 持久化 | `router_decisions`（opt-in `router` 迁移链）+ `createSqliteRouterDecisionStore`（Core 端口实现） |
| 边界 | Router 不调 Provider、不执行 Agent、不改 Policy/Registry/Benchmark；Runtime 仍只接受明确 `modelKey` |

## 23. 生产可达性与 Durable Audit（Sprint 10B.1）

| 项 | 结构 |
|---|---|
| 迁移链 | 组合根请求 `router` ⇒ `router_decisions` 真实存在；链清单由 `tests/shared/expected-chains.ts` 单点维护 |
| 审计 | 六个 `router.*` 事件经 `defineEvent` + `database.events.append` **durable** 落库；payload 12 字段白名单 |
| 事务 | **非原子**：decision 先写 → event 后写（两条路径同序）；`reconcileAndRepairRouterAudit()` 已由组合根**启动时调用**（对账覆盖 `router.recommendation_created` 与 `router.no_candidate` 两种终态事件，幂等补发并打标 `reconciled: true` / `repairReason`） |
| IPC | `router.recommend` / `router.override.request` / `router.override.confirm`；客户端只能给 scope，禁止 policyView/candidateModels/allowedModels/blockedModels/allowedProviders/requiredCapabilities/preferredModels |
| 应用层 | `createRouterApplicationService`：Policy Service → RouterPolicyView；Model Registry → 候选快照 |
| Health | 真实 Provider Registry；非 healthy/degraded ⇒ **unknown（0.25）**，禁止默认 healthy |
| Revision | `registryRevisionOf(records)`：内容绑定（同内容同 revision、内容变则变，无时钟/随机） |
| 边界 | 推荐 ≠ 执行：不调 Provider、不调 Runtime、不执行 fallback；持久化 top-20 + `truncated`；`decision_id` 冲突显式失败 |

## 24. Reachability E2E 与启动对账（Sprint 10B.2）

| 项 | 结构 |
|---|---|
| 行为级 E2E | 真实 SQLite + 真实组件全链：recommend/override → `router_decisions` + 六个 `router.*` 事件（直接查库断言） |
| 启动对账 | `reconcileAndRepairRouterAudit()`（组合根启动调用）：gap → 同类型补发 + `reconciled: true` / `repairReason: MISSING_RECOMMENDATION_EVENT`；幂等（1 → 0 → 0） |
| 计数 | `totalCandidateCount`（进入 Router）/ `eligibleCandidateCount`（硬过滤后）/ `storedEvaluationCount` / `truncated` |
| 健康新鲜度 | `providerHealthObservedAt` + 5 分钟窗口；过期 → `unknown`（0.25） |
| Scope | `workflowId` 可达 WORKFLOW 策略；Run/Stage 仅上下文 id |
| IPC | forbidden-key 单一校验入口（无死读取） |

## 17. 已知限制

- 权重数值未定（只有方向与上限），10B 需要 ADR 补充或配置化；
- 无跨模型"整体最优"权衡（第一版是过滤器 + 规则排序，不是优化器）；
- `RouterRequest` 的 policy view 由调用方装配，存在装配错误的空间（10B 应从 Policy 服务统一派生）；
- Router 已实现并可达（10B/10B.2），但 UI 的"Use recommended model / Choose another model"闭环尚未实现 ⇒
  在 Desktop UI 阶段之前，AUTO/HYBRID 仍需要应用层调用 `router.recommend`（这是**范围**而非缺陷）。
