# DSH KERNEL MODEL BRIDGE SPEC — 模型桥 ADR(Stage 3 冻结)

> 目的:冻结「CompanyOS Model Pool ↔ DSH Kernel 模型缝」的 V1 实现路线与边界。
> 前提法:`DSH_DEFAULT_KERNEL_PROFILE_SPEC.md` §5(BYO/API-only;account/OAuth 路线不在依赖面)。
> 所有权恒等:**Model Selection Owner = CompanyOS**;Kernel 只消费路由。

---

## 1. 候选方案(官方 pinned 源证据)

### OPTION A:CompanyOS ModelProviderPort → 进程内 callback/bridge → 自写 DSH llm adapter
为 DSH 的 `dsh-llm` 缝**新写一个 adapter 包**(CompanyOS 维护),内部转发到 CompanyOS `ModelProviderPort`。

### OPTION B:CompanyOS Model Router → 模型 profile → DSH provider seam(pi-ai hand-declared routes)→ 远端模型 API
不写新 adapter;CompanyOS 把 Pool 中选定的 provider/model 翻译为 `dsh-llm-pi-ai` 路由表(`api: openai-completions|anthropic-messages|openai-responses` + `baseURL` + `apiKeyEnv` + `models[]` 元数据),逐请求由 adapter 调远端。

## 2. 十维比较

| 维度 | OPTION A(Port bridge) | OPTION B(provider seam) |
|---|---|---|
| Secret exposure | key 经 CompanyOS 进程内 Port——最小暴露面;但 kernel 若为子进程,Port 需 IPC 桥,密钥穿越 IPC 边界 | key 仅注入**子进程 env**(apiKeyEnv 引用,逐请求解析;SecretVault→spawn 时短生命周期注入);内核不落盘 |
| Streaming | 取决于 Port 实现(现有 Port 支持 stream) | 上游 adapter 原生 token 级流(BlockAssembler) |
| Cancellation | 需自实现 adapter 侧 abort 传递 | 上游流终止块(abort 终止)已处理 |
| Usage reporting | Port 侧统一(优点) | usage chunk 由 llm 缝发出→adapter 映射(多一层) |
| Latency | 进程内直连(理论最低);子进程形态下被 IPC 抵消 | 直连远端(等价) |
| Provider compatibility | = CompanyOS 已接 provider 面_BYO 现状(OpenAI 兼容适配器) | pi-ai 目录+三协议+自托管网关(上游维护,覆盖面广) |
| Structured output | Port 契约已有 | pi-ai 路由模型元数据声明;工具层 FC+PTC |
| Reasoning models | Port 侧自管 | pi-ai `compat`(thinkingFormat 等方言)+ reasoningEffort 逐请求 |
| Cost accounting | CompanyOS 侧单一记账 | 需从 usage 事件归集(与 Native/dsh 现状一致) |
| Implementation complexity | **高**:新 adapter 包钉在一个 experimental 上游内部缝契约上(0.1→0.2 已重构一次);IPC 桥;双重流组装 | **低**:纯配置生成器(Pool→路由表 YAML)+ env 注入;上游测试面直接可用 |
| DSH upstream coupling | **高**(钉 dsh-llm adapter 内部 API) | **低**(钉 pi-ai 的声明式配置 schema=公开 README 契约) |

## 3. V1 裁定:**OPTION B**

理由:上游耦合最低(声明式配置 vs 内部 API)、managed-child 传输形态成立(进程隔离)、实现面最小(Pool→路由表生成器)、BYO-only 硬约束由"包不在依赖面"机械保证。OPTION A 记为 V1 后优化候选(若出现 pi-ai 覆盖不了的 provider 形态)。

## 4. 路由表生成(CompanyOS 侧新组件,Stage 4)

`ModelPoolRouteProjector`:输入=本次 attempt 选定的 model profile(provider/baseURL/protocol/model id/contextWindow/maxTokens/reasoning 支持/key 的 SecretRef);输出=pi-ai `providers:` 配置(单 route 单 model,最小暴露)+ 该 route 的 `apiKeyEnv` 名。**每次 kernel 启动生成,不持久化**;不同 Task 不同路由=固定内核换模型(Stage 1 已证逐请求 provider+model 原生支持)。

## 5. Secret 边界(冻结)

- 唯一产品级 owner:**CompanyOS SecretVault**(S25 SecretRef 指针)。
- 禁止:内核依赖 `~/.dsh` credentials、DSH Desktop 账号态、DSH 用户 profile secret store(组合面无 `dsh-authorization`/`llm-deepseek-account`;`DSH_HOME`=scratch)。
- Raw key 仅在 kernel 子进程 spawn 时经 env 注入(ARCH-33 允许清单的 declared additions);不进入 DSH project config/session 业务内容/Task/Artifact/Evidence/普通日志(llm 缝对密钥错误只报 typed code,不回显)。

## 6. 失败语义(冻结)

指定 provider/model 不可用 → 内核 typed 失败(`NO_ADAPTER`/`UNKNOWN_MODEL`/`MISSING_CREDENTIAL`/`AUTH`/`RATE_LIMIT`/`QUOTA`/`CONTEXT_WINDOW_EXCEEDED`)→ Profile Spec §9 错误表归一;**内核无 account fallback 可走**(包面不存在),CompanyOS 决定重试/换模型/升级。
