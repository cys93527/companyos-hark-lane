# ADR-0010：Model Registry 与"不是 Router"的边界

> 归属：Sprint 7（Model Registry，P1）；规划书 §五十八（P1 Model Registry）、§四十七（最小权限）；
> 上游 ADR-0002（端口冻结）、ADR-0006（迁移链）、ADR-0009（Provider 抽象与密钥边界）。

## 状态

**已接受（Accepted）** — Sprint 7 交付。

## 背景

Sprint 6 交付了厂商无关的 Provider 层与**原始模型目录**（适配器声明什么就是什么）。
但"某个 Provider 此刻声明的模型列表"不是产品资产：它不能启停、不能改名、不能绑定业务别名、
没有 CompanyOS 自己的描述，也没有持久化的可用性视图。Sprint 7 要补这一层，
同时**绝对不许**越界成为路由器 —— 用户明确禁止自动选模型、评分路由与 fallback。

## 决策

### 1. 策展层与原始目录分离

`provider_models`（原始快照）与 `model_records`（策展条目）是两张表、两个生命周期：

- 原始目录随适配器变化，可随时重刷、可离线展示；
- 策展条目是 CompanyOS 的资产：稳定 `modelKey`、负责人描述、启停、别名、可用性派生；
- **Provider 下线不删策展数据**，只把可用性降为 `unavailable`（测试 C）。

### 2. "不是 Router"是结构保证，不是口头承诺

- 唯一入口是 `models.get(modelKey)` 与 `models.resolve(alias)`，**必须点名**；
- Core 的 `resolveAlias` 只做精确匹配 + 失败即错，没有候选集、没有打分函数；
- 源码与 DDL 层禁止 `score` / `rank` / `priority` / `fallback`（边界测试断言，含 SQL 列名）；
- 别名冲突一律 `CONFLICT`，不"挑一个更合适的"。

### 3. 别名语义：一别名一模型

`logical_aliases(scope, alias) UNIQUE`；解析顺序：精确 scope → `*` 全局。
失败语义细分（`NOT_FOUND` 未绑定 / `POLICY_DENIED` 已停用 / `AGENT_UNAVAILABLE` 当前不可用），
使调用方可以区分"要不要重试"与"要不要换人"，但**永远不替它换**。

### 4. 可用性是派生值

`availability = disabled | unavailable | degraded | available`，由 `enabled` 与 Provider 健康派生，
落库只是缓存。这样"停用"是人的决定，"不可用"是事实，两者不会被混为一谈。

### 5. 授权执行点必须落地（Sprint 6 欠账 ①）

Sprint 6 只交付了 authority 闭集与决策函数，没有执行点；Sprint 7 把它变成真的：
`ProviderRegistry`、`SecretVault`、`ModelRegistry` 三个服务都接受 `authorize` 回调，并在
`provider.register` / `invoke` / `read`、`secret.read` / `write`、`model.register` / `write` 处强制判定。
未注入策略时只允许并**告警一次**；注入后 fail-closed，拒绝不产生任何写入（有测试）。

### 6. 上下文估算按字符类别（Sprint 6 欠账 ②）

`chars/4` 是英文启发式：中文被低估约 4 倍，导致预检可被绕过。改为分类计数
（ASCII / CJK / emoji / code / 其他）并逐类**向上取整**，返回 `conservative: true` 表示这是上界；
适配器**必须**用自己的 tokenizer 复检。Sprint 6 的"预检"因此从"安慰剂"变成有效门。

### 7. Provider 审计（Sprint 6 欠账 ③）

`provider.registered` / `provider.health_checked` / `provider.invoked` / `provider.failed` 与
`model.registered` / `enabled` / `disabled` / `alias_bound` 写入同一事件日志（`EventStorePort`），
payload 先脱敏；密钥永不进入事件。

### 8. 第五条校验和链

`migrations/registry/0001_model_registry.sql`。理由同 ADR-0006：既有四条链已冻结且被测试锁定名字与内容，
新关注点必须有自己的链。`chains` 默认仍是最小集合，registry 链由组合根显式开启。

## 后果

**收益**

- 模型目录成为可治理资产（启停、别名、描述、可用性、审计），而不再只是适配器的回声；
- "不可能偷偷路由"有结构证据（入口形态 + 源码/DDL 扫描 + 别名冲突语义）；
- 授权与审计在 Provider/Secret/Model 三条路径上真正执行，Sprint 6 的欠账全部闭环；
- 上下文预检对 CJK/emoji/code 有效，避免"看不见的超限"。

**代价与限制**

- 没有路由（这是本 Sprint 的**约束**）：调用方必须显式指定 key 或别名；
- 没有成本核算与配额（`pricing` 仅元数据）；
- Registry 与 Provider 目录同步是显式的，无后台轮询；
- UI 尚未按 `model.read` 过滤列表（执行点在服务层）；
- 模型改名即"新 key"，没有版本/退役流程；
- 上下文估算仍是上界启发式，不等于计费口径。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| 让 Registry 提供 `pickBest(capability)` | 就是 Router；用户明确禁止，且会把策略埋进目录层 |
| 别名解析失败时回退到同能力的其它模型 | fallback 被禁止；也会掩盖停用/下线这类需要人处理的事实 |
| 复用 `provider_models` 存启停与别名 | 原始快照会被重刷覆盖；策展数据必须独立于适配器 |
| 上下文估算继续用 `chars/4` | 中文低估 4 倍，预检形同虚设（Sprint 6 记录在案） |
| 授权只做"闭集 + 决策函数" | Sprint 6 已证明那样等于没有权限；执行点必须落到服务上 |
| 把 registry 表塞进 provider 链 | 会改动已冻结链条与其测试，违反 ADR-0006 的多链约定 |
