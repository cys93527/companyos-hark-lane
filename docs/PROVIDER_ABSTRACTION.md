# Provider Abstraction（Sprint 6）

> 目标：建立**完全厂商无关**的 Model Provider 层，为未来的云端/本地模型接入提供统一边界。
> 本 Sprint **不**实现 Model Router、真实 Agent Runtime、多模型调度。
> 依据：规划书 §五十八（P0 Provider Abstraction）、§四十七（最小权限）、§五十六（安全）；
> ADR-0002（端口冻结）、ADR-0006（持久化链）、ADR-0009（本 Sprint 决策）。

## 1. Provider Architecture

```text
调用方（UI / future Router / future Agent Runtime）
   │  registry.invoke({ providerId }, request)
   ▼
@companyos/engine  providers/registry.ts    ← 外环实现：绑定、归一化、限额预检、错误归一、脱敏
   ├── providers/mock-provider.ts           确定性假适配器（测试与 UI 用）
   ├── providers/secret-vault.ts            环境/内存密钥解析（值只在内存）
   └── authorization.ts                     Role → Authority 授权服务（持久化）
   ▼ 只依赖 Core 契约
@companyos/core    ports/model-provider.ts（Provider contract / ModelInfo / Capability / Error）
                   ports/secrets.ts（SecretRef / SecretResolver）、domain/provider-error.ts
                   domain/role-authority.ts（AUTHORITIES 闭集 + decideAuthority）
   ▼
@companyos/persistence  migrations/provider/0001_provider_registry.sql
                        providers / provider_models / secret_refs / roles / role_assignments
```

**厂商名隔离**：`tests/sprint6/boundary.test.ts` 扫描 `packages/*/src` 与 `apps/*/src`，断言
**不存在**任何厂商名（大小写不敏感）；适配器（唯一允许知道厂商的地方）**目前不存在**，
只有 MockProvider。Registry 自身只 `import '@companyos/core'`，无 HTTP、无定时器。

## 2. Provider Contract

`ModelProviderPort` 要求每个适配器提供：

| 方法 | 语义 |
|---|---|
| `describe()` | `{ providerId, kind, displayName, version }` |
| `listModels()` | `RawModelInfo[]`（Core 归一化：默认显示名、输出上限、定价、能力缺失=false） |
| `health()` | `{ status: healthy\|degraded\|unavailable, checkedAt, latencyMs, detail }` |
| `invoke(request)` | 文本 / 结构化 / 工具调用 + `usage` + `finishReason` |
| `stream(request)` | `AsyncIterable<StreamChunk>`（`done: true` 携带 usage） |
| `secretRefs?()` | 该适配器需要的 `SecretRef`（指针，不是值） |

`InvocationRequest` 含 `modelId`、`messages`、`temperature`、`maxOutputTokens`、
`responseFormat`（结构化输出契约）、`tools`（工具声明）、`traceId`（仅关联用）。
`ModelInfo` 携带 `contextWindow`、`maxOutputTokens`、`capabilities`、`pricing`。

**Registry = 显式 id 绑定，不是路由器**：`invoke({providerId}, …)` 必须点名；
没有打分、没有自动回退、没有"最佳模型"逻辑（评审重点，见 ADR-0009）。

## 3. Error Model

- 单一归一化形态：`NormalizedProviderError { kind, message, retryAfterMs, upstreamCode, retryable, providerId }`；
- 12 种 kind：`rate_limited` / `quota_exhausted` / `timeout` / `context_limit` / `auth_failed` /
  `invalid_request` / `tool_unsupported` / `structured_output_unsupported` / `streaming_unsupported` /
  `unavailable` / `content_filtered` / `unknown`；
- Core 错误码映射：`ERROR_CODE_BY_KIND`（限流/配额 → `LIMIT_EXCEEDED`；超时 → `TIMEOUT`；
  上下文超限 → `VALIDATION_FAILED`；能力缺失 → `CAPABILITY_MISSING`；鉴权 → `PERMISSION_DENIED` …）；
- `retryable` 只对 `rate_limited` / `timeout` / `unavailable` 为 true（重试策略由调用方决定）；
- 预检发生在调用**之前**：未知模型、能力不足、输出超上限、上下文超限都在本地拒绝（测试 I/M 证明
  provider 的 `calls` 为空）。

## 4. Secret Model

- **只存指针**：`SecretRef { id, providerId, purpose, source: env|os_keychain|external_vault, envName? }`；
  `secret_refs` 表**没有任何可以放值的列**（边界测试逐列断言）；
- `SecretResolver` / `SecretRefResolverPort` 是 Core 契约；`createEnvSecretVault` 是引擎侧实现，
  值只在内存，`keys()`/`available()` 只列名字；
- Registry 每次调用前刷新已知密钥集合，并对**所有外发字符串**脱敏：
  - provider 错误消息 → `redactSecrets`；
  - 成功结果若仍含密钥 → **拒绝返回**（`PERMISSION_DENIED: Secret material detected`），
    而不是"打个洞还回去"；
  - health `detail` 落库前脱敏；
- 禁止面：Git、Log、Event、Handoff、SQLite 明文、Error details —— 边界测试扫描全仓 `sk-` 形态字面量
  （只允许明显标注的 `sk-mock-*`）并断言数据库文本无值。

## 5. Authorization Update（低成本遗留 2）

- Core：`AUTHORITIES` **闭集**（workflow.* / run.* / provider.* / secret.*）+ `isAuthority` +
  `decideAuthority` + `rolesOfActor` / `authoritiesOfActor` + `validateRoleAuthorities`；
  未知名一律 `INVALID_ARGUMENT`（错字不是权限），缺权限一律 `PERMISSION_DENIED`（附 `held` 列表）；
- 引擎：`createAuthorizationService` 持久化 `roles` / `role_assignments`，提供
  `defineRole / assign / revoke / decide / effective`；
- 与既有 `Role.authority`（Sprint 1）和授权缝（Sprint 4 `authorize`）对接：生产装配把它接到
  `SESSION_ACTOR`（Sprint 5），下一步把 `authorize` 换成 `authorization.decide(actor, authority)`。

## 6. Persistence Changes（低成本遗留 1 + 新增）

- **单 durable 句柄**：`main.ts` 只调用一次 `openDurableDatabase({ chains: ['core','engine','lifecycle','provider'] })`，
  外壳状态、工作流治理、Provider 注册表共用同一连接与同一 `UnitOfWork` 事务协调器
  （此前是两个句柄 + SQLite 锁兜底）。
- 新增**第四条校验和保护链** `migrations/provider/0001_provider_registry.sql`：
  `providers`（注册 + 启用 + 最近健康）、`provider_models`（模型目录快照）、
  `secret_refs`（指针）、`roles`、`role_assignments`；core/engine/lifecycle 三条链**未改动**。
- `openDurableDatabase` 的 `chains` 默认仍是 `['core','engine']`，provider 链显式开启；
  未开启时相关 store 会显式拒绝（`PERSISTENCE_FAILED` + 提示）。

## 7. Mock Provider

`createMockProvider({ providerId, kind, displayName, script })`：脚本化模型目录、健康报告、
按调用序的输出/失败、流式分片；**无随机、无定时器、无 IO**；记录 `calls` 供断言；
`setScript()` 支持在同一 id 上替换行为（测试 Q 证明调用点无需改动）；
失败以 `DomainError` 携带 `companyos.provider.kind` 标记，让 Registry 保留精确 kind
（这也是 J/K/L 三组错误映射能被确定性测试的原因）。

## 8. Tests

| # | 场景 | 位置 |
|---|---|---|
| A/B | 注册 / 重复注册（内存 + 存储两种重复） | `tests/sprint6/providers.test.ts` |
| C/D | 模型列表与能力归一化（缺失=false，离线目录） | 同上 |
| E | 健康检查与落库（离线可读） | 同上 |
| F/G | Invoke / Stream（含 done 携带 usage） | 同上 |
| H/I | 结构化输出契约、工具调用能力（含拒绝路径） | 同上 |
| J/K/L/M | 限流 / 配额 / 超时 / 上下文与输出上限映射 | 同上 |
| N | 密钥脱敏（结果拒绝、错误脱敏、健康脱敏、数据库无值） | 同上 |
| O/Q | 重启持久化（注册/目录/健康）与适配器替换 | 同上 |
| 授权 | Role→Authority 允许/拒绝、未知名拒绝、角色校验、撤销、重启保留 | `tests/sprint6/authorization.test.ts` |
| P | 全仓无厂商名、Core/Engine 无 HTTP 与定时器、Registry 只依赖 Core | `tests/sprint6/boundary.test.ts` |

## 9. 已知限制

- 只有 MockProvider：真实适配器（含 HTTP、重试、SSE 解析）属于后续 Sprint，且必须放在外环；
- 无 Router：调用方必须点名 provider（这是本 Sprint 的**约束**，不是缺陷）；
- 无重试/退避实现：只提供 `retryable` 与 `retryAfterMs` 元数据；
- token 估算用 `chars/4` 启发式（没有厂商 tokenizer，且 Core 不得内置任何一家）；
- 定价与上下文窗口以适配器声明为准，未做交叉校验；
- 授权目前接到会话身份（单用户 V1），未做 UI 权限矩阵；
- 密钥源只有环境/内存实现，OS keychain 适配器待后续 Sprint。
