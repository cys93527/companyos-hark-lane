# ADR-0009：Provider 抽象边界、错误归一与密钥边界

> 归属：Sprint 6（Provider Abstraction，P0）；规划书 §五十八（P0 Provider Abstraction）、§四十七（最小权限）、
> §五十六（安全）；上游 ADR-0002（端口冻结）、ADR-0006（持久化链）、ADR-0007（生命周期治理）。

## 状态

**已接受（Accepted）** — Sprint 6 交付。

## 背景

Sprint 0–5 把领域、引擎、持久化、生命周期与 Designer 全部做完，但**没有任何模型接入边界**。
Sprint 6 要在不实现 Router 的前提下，给出一个**厂商无关、可替换、可测试、不会泄漏密钥**的 Provider 层。
四个必须同时满足的约束：

1. Core/Engine **不得出现任何厂商名**（OpenAI / Anthropic / Claude / DeepSeek / Gemini / Kimi / Ollama）；
2. 不允许 Model Router / 真实 Agent Runtime / 多模型调度；
3. API Key 不得进入 Git、Log、Event、Handoff、SQLite 明文、Error details；
4. 必须可被一个确定性 MockProvider 完整替换（这是 UI 与测试能用它的前提）。

## 决策

### 1. Provider 是"一个适配器的契约"，不是路由器

`ModelProviderPort`（Core）只有 `describe / listModels / health / invoke / stream / secretRefs?`。
Registry 的实现（引擎外环）按**显式 providerId** 绑定与调用：没有打分、没有自动回退、没有"最佳模型"，
因此它**不是** Model Router（Sprint 7+ 才有，且届时仍只依赖该契约）。
`ModelGateway`（Sprint 1）继续作为"逻辑能力 → 具体模型"的路由缝，本 Sprint 不实现它。

### 2. 归一化发生在唯一的地方

- **能力**：适配器返回 `Partial<ModelCapabilities>`，Core 归一化为**完整布尔集**（缺失=false），
  调用方永远不需要判断 `undefined`；
- **模型**：`normalizeModelInfo` 补全显示名、输出上限、定价；
- **错误**：任何失败都变成 `NormalizedProviderError`（12 种 kind + `retryable` + `retryAfterMs` +
  `upstreamCode`），再由 `ERROR_CODE_BY_KIND` 映射成 Core 错误码。调用方永不解析厂商方言。

### 3. 预检在本地，不在上游

未知模型、能力不足（结构化输出/工具调用）、输出超上限、上下文超限都在调用**之前**拒绝，
并且有测试断言 provider 的 `calls` 为空——失败的请求不浪费一次真实调用，也不产生费用。
上下文估算用 `chars/4` 启发式（Core 不得内置任何厂商 tokenizer），已记入限制。

### 4. 密钥只有指针，值只在内存

`SecretRef { providerId, purpose, source, envName? }` 是唯一可持久化/可记录的形态；
`secret_refs` 表**没有值列**（边界测试逐列断言）。Registry 在每次调用前刷新已知值集合，并：

- 脱敏 provider 的错误消息与 health detail（落库前也脱敏）；
- 若**结果本身**仍含密钥，直接拒绝该结果（`PERMISSION_DENIED: Secret material detected`）——
  宁可不返回，也不"打洞返回"；
- 边界测试扫描全仓 `sk-` 形态字面量（只白名单 `sk-mock-*`）。

### 5. 最小 Role → Authority

`AUTHORITIES` 是**闭集**（workflow.* / run.* / provider.* / secret.*）；未知名一律 `INVALID_ARGUMENT`
（错字不能变成权限），缺权限 `PERMISSION_DENIED` 并在 details 给出 `held` 列表。
授权服务（引擎）持久化 `roles` / `role_assignments`，与 Sprint 4 的 `authorize` 缝对接。

### 6. 第四条校验和迁移链 + 单 durable 句柄

新增 `migrations/provider/0001_provider_registry.sql`（providers / provider_models / secret_refs /
roles / role_assignments），core/engine/lifecycle 三条链**一字未动**（有测试锁定）。
同时关掉 Sprint 5 遗留的第二个句柄：`main.ts` 只开**一个** `openDurableDatabase`，四条链全开，
外壳状态 / 工作流治理 / Provider 注册表共用同一连接与同一 `UnitOfWork`。

## 后果

**收益**

- 接入任何云端或本地模型只需在外环写一个适配器，Core/Engine/持久化层零改动（有测试 Q 证明调用点不变）；
- 12 种错误语义与重试元数据统一，下游不需要认识任何厂商错误码；
- 密钥"结构上"无法落库或落日志（没有列、没有出口、有扫描测试）；
- 可测试性：MockProvider 确定性 + 可脚本化失败，使限流/配额/超时/上下文映射都能在单测里断言；
- 授权与 Provider 层共用一套 authority 名字，权限矩阵有落点。

**代价与限制**

- 没有真实适配器（本 Sprint 的约束）：HTTP、SSE、重试退避、真实 tokenizer 都待后续；
- 没有 Router：调用方必须点名 provider——这是设计约束，不是遗漏；
- token 估算为启发式，可能与真实计费口径不同；
- 密钥源只有环境/内存实现，OS keychain 适配器待后续；
- `char/4` 与定价未做交叉校验；
- 授权在生产仍是"会话级"（单用户 V1），UI 权限矩阵待 Role 存储接入；
- Provider 的 `stream` 只做逐块脱敏/拒绝，不做背压或部分结果回滚。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 在 Core 里放厂商适配器 | 直接违反约束 1；Core 必须零依赖且行业无关 |
| 让 Registry 自动挑模型（即 Router） | 本 Sprint 明确禁止；且会把策略与契约混在一起 |
| 密钥存 SQLite（哪怕加密） | 违反约束 3 的明文条款与最小暴露面；指针 + 运行时解析更安全 |
| 结果含密钥时"打洞返回" | 部分泄漏仍是泄漏；拒绝比修补更可解释 |
| 每个厂商一条迁移链 | 表的形状与厂商无关；一条 provider 链足够，且避免链爆炸 |
| 保留两个 durable 句柄 | "单连接单 Writer"是既有承诺；句柄合并消除了跨连接竞态 |
