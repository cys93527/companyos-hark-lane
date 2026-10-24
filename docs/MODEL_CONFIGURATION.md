# CompanyOS 模型配置（V1）

本文档描述桌面产品的**模型接入与路由配置**。全部配置为部署/操作员级环境变量；
`COMPANYOS_` 前缀是 SecretVault 命名空间——**只有 API Key 属于那里**，其余非密钥
配置一律使用 `COS_MODEL_` 前缀。

## 基础（必需，任何路由模式）

| 变量 | 说明 |
|---|---|
| `COS_MODEL_BASE_URL` | OpenAI 兼容端点 URL（http/https）。 |
| `COS_MODEL_ID` | 该端点上的模型 id。 |
| `COMPANYOS_MODEL_API_KEY` | **SECRET**。API Key，经 SecretVault 注入；绝不写入配置对象、日志、内核环境或 RoutingDecision。 |

可选：`COS_MODEL_PROVIDER_ID`（默认 `model.openai-compatible`）、
`COS_MODEL_TIMEOUT_MS`（默认 120000）。

## 路由模式（产品级配置，可审计）

| 变量 | 合法值 | 缺省 |
|---|---|---|
| `COS_MODEL_ROUTING_MODE` | `DETERMINISTIC_V1` \| `SMART_ROUTER_V1` | `DETERMINISTIC_V1` |

- 不设置 = `DETERMINISTIC_V1`：与既有行为完全一致，不要求路由 traits。
- `SMART_ROUTER_V1`：生产组合构建**唯一权威 ModelPool** 并接入 Stage 8 冻结的
  Smart Router（静态、确定性、版本化 policy；不读任何历史数据）。非法值或
  SMART 模式下 traits 不完整都会**大声失败**（组合启动即拒绝），绝不猜测、
  绝不悄悄回退 deterministic 选择器。

## Smart Router 附加配置（仅 SMART_ROUTER_V1 生效）

| 变量 | 合法值 | 缺省 |
|---|---|---|
| `COS_MODEL_ROUTING_POLICY` | `QUALITY_FIRST` \| `BALANCED` \| `COST_AWARE` | `BALANCED` |
| `COS_MODEL_QUALITY_TIER` | `ECONOMY` \| `BALANCED` \| `STRONG` \| `PREMIUM` | （必须显式） |
| `COS_MODEL_COST_TIER` | `LOW` \| `MEDIUM` \| `HIGH` | （必须显式） |
| `COS_MODEL_LATENCY_TIER` | `FAST` \| `BALANCED` \| `SLOW` | （必须显式） |
| `COS_MODEL_RELIABILITY_CLASS` | `STANDARD` \| `HIGH` \| `CRITICAL` | （必须显式） |

四个 traits **全部必填**（SMART 模式下）；缺一即 `MODEL_ROUTING_PROFILE_INCOMPLETE`
启动失败。Ordinal 档位是诚实声明——系统不会替你猜"这个模型大概 BALANCED"。

## 行为要点

- RoutingDecision 持久化在 `provider_dispatches.routing_decision_json`（policy
  版本、候选、拒绝原因、得分明细），可审计；**绝不含密钥**。
- SelectedModelSnapshot 归 **ExecutionAttempt** 所有；内核只逐字消费 CompanyOS
  选定的路由，不做任何隐藏路由/换模。
- 凭证经 loopback Model Broker 注入上游：原始密钥只存在于 CompanyOS 进程内存。
- Runtime Doctor（goal 预检）在 SMART 模式下检查 pool/traits/policy/credential，
  缺失时以 typed 外部阻塞报告（只输出名字与 PRESENT/ABSENT，绝不输出值）。
