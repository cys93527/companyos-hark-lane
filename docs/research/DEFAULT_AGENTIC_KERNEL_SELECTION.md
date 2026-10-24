# DEFAULT AGENTIC KERNEL SELECTION — 技术路线选型(研究冻结稿)

> 状态:**RESEARCH ONLY**——本 Sprint 只研究、建模、裁决。零生产实现、零外部源码复制、零真实 Agent 接入。
> 基线 `4bfc9a9`(初版)/`b34f02f`(Stage 1 官方重评估修订)。
> 上位法:`EXECUTOR_ECOSYSTEM_MODEL.md`(适配器契约+第二真相保护)、`AGENT_EXECUTOR_INTEGRATION_GUIDE.md` v1.2(Canonical Work Envelope)。
> Boss 裁定前提:`EXECUTOR_PROVIDER_CONTRACT = AGENTIC_CONTRACT_READY`。本文件回答的只是:**默认内置 Agentic Execution Kernel 选哪条技术路线**。
>
> **⚠ Stage 1 修订(官方源重评估)**:初版的 DSH 证据来自本机安装版——现已降级为 LOCAL_COMPATIBILITY_SAMPLE;
> 官方源结论见 `OFFICIAL_UPSTREAM_KERNEL_COMPARISON.md`(pinned:DSH master@`639ed01`/`dsh-v0.2.0-rc.2`;**ZCode 官方仓库存在且为 Apache-2.0 v3.14.3**——初版"专有"结论已作废);
> 污染审计见 `LOCAL_DSH_CONTAMINATION_REPORT.md`。推荐结论以 Boss Stage 1 允许词表重述为 **`DSH_MANAGED_MINIMAL_RUNTIME`**(= 本文 STRATEGY A 的规范名),附五项 Stage 3 前提。

---

## 0. 方法论(SOURCE-FIRST 实证记录)

- **DeepSeek Harness (DSH)**:直接读取**本机安装的真实 runtime 源码** `E:\DeepSeek.Harness\DeepSeek Harness\resources\runtime`(monorepo ~250 个 `@deepseek-ai/*` workspace 包,逐包 `package.json`/`LICENSE`/`README`/`lib/*.js` 源码)。上游仓库 `github.com/deepseek-ai/deepseek-harness`(`publishConfig.access: public`)。不依赖产品宣传页。
- **ZCode**:本机形态实证(`D:\zcode` = Electron GUI,`app.asar` 打包,仅附带 Electron/Chromium 第三方许可,无产品级开源许可;无 CLI/无文档化自动化面——与 `AGENTIC_EXECUTOR_POSITIONING.md` 冻结结论一致)。**不逆向 asar**(许可不合适且无必要)。
- **OpenAI Codex**:公开仓库+许可+平台支持经 web 核验(Apache-2.0;Rust `codex-rs`;原生 Windows 沙箱 elevated 模式;`model_providers` OpenAI 兼容自定义端点)。本机未装,深度以架构参考为限。
- **OpenHands / Aider**:许可与形态经 web 核验(MIT / Apache-2.0),作为次级对照候选。
- 所有结论标注证据来源;无源码支撑的判断标 `DETAILS_NOT_YET_VERIFIED`(与 `REFERENCE_ADOPTION_POLICY.md` 同纪律)。

---

## 1. 产品原则(选型的约束,不是结论)

1. **固定执行内核 + 动态模型池**:内核尽量一套;模型按 Task(Role/能力/复杂度/成本/质量/时延/上下文需求)动态选择。
2. **用户只安装 CompanyOS**:内核随 CompanyOS 安装包交付;不要求用户另装 Codex Desktop / DSH Desktop / ZCode / 其他 Agent 软件。
3. **无 Agent 会员**:内核架构上不得强制用户购买该 Agent 产品自身的会员;优先 BYO 模型 API key / CompanyOS 模型额度。
4. **不能成为第二套 CompanyOS**:内核只拥有 local agent loop / model invocation mechanics / tool invocation mechanics / observation / bounded local working context。

---

## 2. 候选与源码完整性

| 候选 | 源码完整性 | 分类 |
|---|---|---|
| **DeepSeek Harness** | **FULL_SOURCE**(本机 runtime 全部包可读;MIT;公开仓库) | **EMBEDDED_KERNEL_CANDIDATE** |
| **OpenAI Codex CLI** | **FULL_SOURCE**(Apache-2.0 公开仓库;Rust 单体) | EMBEDDED_KERNEL_CANDIDABLE_BUT_REFERENCE_PREFERRED(见 §6 理由) |
| **ZCode** | **INSUFFICIENT_SOURCE_FOR_EMBEDDED_KERNEL**(专有 Electron GUI;无产品开源许可;无自动化面) | REFERENCE_ONLY(未来桌面能力) |
| OpenHands | FULL_SOURCE(MIT;Python;Docker 沙箱运行时) | 次级候选(被 Docker-on-user-machine 依赖削弱) |
| Aider | FULL_SOURCE(Apache-2.0;Python CLI;LiteLLM) | 机制参考(交互结对形态,非自主任务执行内核) |

---

## 3. License 核验(§7,逐项)

| 项 | DSH | Codex | ZCode | OpenHands | Aider |
|---|---|---|---|---|---|
| License | **MIT**(每个 workspace 包独立 `LICENSE` 文件,抽验 `dsh-agent-loop`/`dsh-llm`/`dsh-headless`/`dsh-sandbox-policy`/`dsh-permission-presets`/`dsh-agent`/`dsh-subagent`/`dsh-compaction`/`dsh-spill` 等均 MIT) | Apache-2.0 | **无产品级许可**(仅 Electron/Chromium 附带许可) | MIT | Apache-2.0 |
| 商业使用 | 允许 | 允许(含专利授权) | 不允许(专有) | 允许 | 允许 |
| 修改/再分发 | 允许;需保留版权声明 | 允许;需保留 NOTICE | — | 允许 | 允许 |
| Copyleft 传播 | 无 | 无 | — | 无 | 无 |
| 随 CompanyOS 安装包分发 | **可以**(MIT;保留各包 LICENSE 即可) | 可以 | **不可以** | 可以 | 可以 |

**结论**:DSH/Codex/OpenHands/Aider 均无许可障碍;ZCode 有硬障碍。

---

## 4. 研究维度发现(按 §8–§22 逐维度;证据=包名/源文件)

### 4.1 MODEL DECOUPLING(§8,最高优先级)

**DSH = 强解耦,最佳实证**:
- `dsh-llm`:「Provider-neutral LLM service interface」——服务本身**零 provider wire 代码**;adapter 注册制(`DUPLICATE_ADAPTER` 防冲突);请求深冻结(扩展/adapter 只读不可改写);流式必有唯一终止块;稳定错误码 `NO_ADAPTER`/`MISSING_CREDENTIAL`/`AUTH`/`RATE_LIMIT`/`CONTEXT_WINDOW_EXCEEDED`。
- `dsh-llm-pi-ai`:「routes model requests to **multiple pi-ai providers, OpenAI-compatible gateways, or self-hosted servers** from one configuration」;`apiKeyEnv` 凭证引用**按请求解析**(密钥不进配置文件);配置改动下一请求生效无需重启;OAuth 为**可选**而非强制。
- `dsh-llm-deepseek`:`apiKeyEnv: DEEPSEEK_API_KEY` 直连路线;与 pi-ai 路线名不冲突可共存。
- 模型元数据:模型发现/逐模型 context window/输出上限/reasoning efforts/输入模态/`systemPromptUpdate` 语义。
- **每次 Task 换模型不改 Runtime**:`GenerateOptions.provider` 逐请求选择;`dsh-sdk-minimal` 明言「selects the model from the SDK initialization request」。
- **无强绑定账号/厂商**;本机当前 DSH 阻断是**外部账户凭证失效**(运营问题,非架构会员要求;per Boss 令未排障)。

**Codex = 可解耦但 OpenAI 倾向**:`model_providers`(config.toml)支持 OpenAI 兼容自定义 `base_url`+key(社区与 Azure 文档证实);默认体验绑定 ChatGPT 登录。**ZCode = 不可评(无源)**。**Aider = LiteLLM 100+ 模型**(业界通用的通用抽象层先例)。

### 4.2 AGENT LOOP(§9)

DSH `dsh-agent-loop`(`lib/index.js` ~1950 行,已读):
- 生命周期:create/resume session → turn → step(call model → run tools → repeat);README 明言标准生命周期就是「call model, run tools, repeat」。
- **durable Inbox 投影**(`next-turn`/`next-step` 事件 splice,含持久历史校验:非法 splice 直接拒绝)。
- **abort 信号按 step 共享**;取消保留已流式交付文本;被跳过的模型调用也记 durable 记录(`TOOL_ABORTED_BEFORE_DISPATCH`)。
- **并行工具调度**:`maxParallelToolCalls`(默认 10;1=串行),parallel-safe 才并发,exclusive 保序;调度器失败安全排空。
- 预算/保护:请求级 `maxTokens`;`dsh-llm-retry` 独立重试包;`dsh-timeout`/`dsh-tool-call-timeout-policy` 协作超时。*(未见显式全局 step/turn 上限字段——由宿主(CompanyOS)的 attempt/超时/预算治理兜底,正好符合"编排归 CompanyOS"。)*

**Codex**(架构参考):turn/item/delta 事件流协议、apply_patch、approval×sandbox 门(已在 `REFERENCE_CAPABILITY_MAP.md` Sprint0 行登记)。

### 4.3 TOOL SYSTEM(§10)

DSH:
- `dsh-tools`:`defineTool` 声明 typed 参数/输出、协作超时、parallel-safety、UI 呈现;**allow/deny/ask 策略**;「per-agent restrictions can narrow that visible set」——**CompanyOS 能控制本次 Task 暴露哪些工具:是内核原生能力**。Function Calling + PTC 双模。
- 工具族(本机包清单实证):`dsh-tool-bash(-persistent)`/`dsh-tool-pwsh(-persistent)`(Windows PowerShell 一等)/`dsh-tool-fs`/`dsh-tool-fs-search`/`dsh-tool-str-replace-editor`(软件工程编辑)/`dsh-tool-web`(search: deepseek/exa/perplexity;fetch)/`dsh-tool-terminal`/`dsh-tool-subagent(-control)`/`dsh-tool-todo`/`dsh-tool-lsp`(代码智能)/`dsh-tool-skill`/`dsh-tool-jobs`/`dsh-tool-goal`/`dsh-tool-workflow`/`dsh-mcp-client`(MCP)/browser-use/computer-use(experimental 族)。
- 通用性:research/文档/数据/文件/API/浏览器工作流皆有对应工具族;非 coding-only。

### 4.4 TOOL AUTHORITY(§11,HARD GATE)

DSH 逐维度分类:

| 维度 | 机制(证据) | 分类 |
|---|---|---|
| tool allowlist/denylist | `dsh-tools` allow/deny/ask + per-agent 可见集收窄 | **NATIVE_ENFORCEMENT** |
| filesystem boundary | `dsh-fs-sandbox`:read-only 拒绝一切变更 / workspace-write 仅限会话工作区+平台临时根 / danger-full-access;typed `FS_SANDBOX_DENIED` | **NATIVE_ENFORCEMENT** |
| process/workspace 边界 | `dsh-sandbox-policy`:per-call 解析器,**fail-safe 默认 read-only**,部署默认+会话覆盖(重启存活);`dsh-bash-sandbox`/`dsh-pwsh-sandbox` | **NATIVE_ENFORCEMENT** |
| Windows 沙箱 | `dsh-sandbox-windows-acl`:ACL 限制子进程写工作区+私有临时目录;失败即阻止启动;**诚实标注 partial**(NTFS hardlink 限制) | **NATIVE_ENFORCEMENT(部分,且诚实披露)**——与 CompanyOS「禁沙箱声明」法则同纪律 |
| network restriction | web 工具族独立成包(search/fetch 按配置挂载);不挂载即不存在——组合级控制 | **ADAPTER_ENFORCEABLE**(组合裁剪=不挂载) |
| approval hook | `dsh-user-approval`:ask 策略逐请求一次性审批,answerer 缺失/失败=**fail-closed unavailable**;审计入会话日志;`never` 直接拒绝 | **NATIVE_ENFORCEMENT** |
| secret boundary | 凭证走 `dsh-credentials(-local)` 引用 seam;`apiKeyEnv` 引用按请求解析,密钥不进配置/不进上下文 | **NATIVE_ENFORCEMENT** |
| OS 级 jail | `node-addon-landlock-run`(Linux);Windows=ACL(部分) | 部分;**诚实披露**(同 CompanyOS 立场) |

**结论:无 PROMPT_ONLY 高风险项。** CompanyOS Adapter 还可叠加自己的 S25 预检(cwd/env/argv/能力协商)——纵深防御。

### 4.5 CONTEXT(§12)

DSH:会话持久化(JSONL/SQLite 投影/查询/快照/checkpoint 策略);**compaction 族**(token 压力→旧史摘要+保留近期;上下文溢出→压缩重试;`tool-result-pruner`/`image-offload`);**spill 机制**(超长工具文本→存储+locator+有界预览,不撑爆上下文)。**裁定:全部 subordinate runtime state,绝不成为 CompanyOS Session Truth**(S24 已冻结 provider_session_id 只是 provenance 列)。

### 4.6 HEADLESS / EMBEDDABILITY(§13)

DSH 理想序全部命中:
- **CLI one-shot**:`dsh --profile headless`(无 GUI/无 server/无端口;`--json` NDJSON 事件流;`--session-id` 续作;退出码语义)——**CompanyOS S24 已冻结适配器并实证(PONG 3/3)**。
- **Library/API embeddable**:`dsh-sdk-minimal`(显式小型 runtime 组合;模型来自 SDK init 请求;完整 Cordis 树;**刻意排除** dsh-base/Web/settings/托管凭证/遥测/compaction/fs 工具/skills/jobs/subagents);`dsh-sdk-jsonrpc-server`/`dsh-sdk-protocol`/`dsh-sdk-client`/`dsh-sdk-app`;`dsh-acp`(Agent Client Protocol)。
- 不依赖 Electron GUI、不需独立 daemon、不需独立账号(API-key 路线)。

### 4.7 一体化安装(§14)

DSH 桌面产品本身就是「`resources/runtime`(node + npm 树)+ profile 组合」的分发形态——**CompanyOS 可原样采用**:随安装包分发 pinned runtime + CompanyOS 专属 profile;版本锁定/升级/回滚/健康检查由 CompanyOS 组合层治理(升级门=既有冻结的 dsh NDJSON 契约测试)。

### 4.8 账号与订阅(§15)

DSH 内核路线 **BYO API key 架构成立**:`apiKeyEnv` 引用 → CompanyOS Model Pool 持有用户 key(Provider A/B/C),内核只消费传入路由。OAuth/云服务是可选增强非前提。**无独立会员要求**。

### 4.9 模型池/角色(§16–§17)

- 逐 Task 模型路由:CompanyOS 选模型 → adapter 以 SDK-init/config 下发路由(现有 `ExecutorProvider` 契约无需改动;如需更显式可未来加性可选字段——本 Sprint 不做)。
- 角色:同一内核按组合差异承担不同 Role(`dsh-persona`/`dsh-system-prompt`/`dsh-agent-instructions` 系统指令按组合注入;工具可见集按 agent 收窄;模型逐请求)。**一套内核,多 Role,零第二执行器架构**。

### 4.10 软件工程 / 通用工作 / 桌面(§18–§20)

- SE:`dsh-tool-str-replace-editor`+`dsh-lsp`+persistent shell+`dsh-workspace-changes`;Codex 的 apply_patch/规划/沙箱门为**机制吸收参考**(见机制图)。
- 通用:web/office(`libreoffice-kit`,`dsh-office-to-pdf`)/文件/研究工具族齐备——**非 coding-only**。
- 桌面:`dsh-computer-use`/browser-use experimental 族 + **ZCode 桌面机制(无源)** → 一律 `FUTURE_DESKTOP_CAPABILITY`,以「内核+桌面工具能力」形态进入,不污染内核。

### 4.11 SUBAGENT(§21)

DSH `dsh-subagent`:命名 provider 注册(in-process fork/spawn、ACP、SDK、Codex、ClaudeCode 并存);one-shot/continuable;lineage 可查。**DEFER**:未来若用,父 CompanyOS Task 仍为 canonical owner;禁复制其 TeamTask DAG/Workflow(`dsh-experimental-agent-team` 等 = REJECT)。

### 4.12 维护成本(§22)

| 路线 | upstream 跟随 | 破坏性变更 | 测试负担 | 评定 |
|---|---|---|---|---|
| A. 直接依赖 pinned upstream runtime + CompanyOS profile | 换 pinned 版本+契约门(已有 dsh-live/s24 套件) | alpha 变更被 profile 面收窄 | 中(NDJSON 契约已冻结) | **低-中** |
| B. vendor/fork 最小包集 | merge ~10+ 相互依赖包+cordis 框架 | 高(内部 API 漂移) | 高 | **高** |
| C. 自研薄内核 | 无(自持) | 自控 | 高(自建工具/沙箱/压缩/spill 等价物) | 一次性高+持续中 |

DSH 上游为 `0.1.6-alpha.x` 快速演进、无 LTS 承诺——**这是 A 路线的最大风险**,缓解:pinned+契约门+内核可整体摘除(anti-coupling 已证:无任何 agent CompanyOS 完整运转)。

---

## 5. 决策矩阵(§26)

| 维度 | DSH | Codex | ZCode | OpenHands | Aider |
|---|---|---|---|---|---|
| Source Completeness | **A+**(本机全源) | A(公开 Rust 单体) | **F** | B(公开,未本地深读) | B |
| License Suitability | **A**(MIT×包) | A(Apache-2.0) | F | A | A |
| Embeddability | **A**(headless CLI+SDK+ACP+minimal profile) | B(CLI subprocess;Rust 不可 Node 库嵌) | F | C(Docker 依赖) | C(交互结对形态) |
| Model Independence | **A**(provider-neutral+pi-ai+OpenAI 兼容+自托管,逐请求) | B+(OpenAI 兼容可配;默认 ChatGPT 倾向) | ? | B | A(LiteLLM) |
| Tool System | **A**(typed+allow/deny/ask+全族+MCP) | A(SE 向) | — | B | B(git-native 编辑) |
| Permission Enforcement | **A**(见 §4.4,无 PROMPT_ONLY) | A(沙箱门) | — | A(Docker 隔离) | C |
| Context Management | **A**(compaction 族+spill+持久化投影) | B+ | — | B | C |
| Cancellation | **A**(abort 信号/保留已交付文本/耐用记录) | A | — | B | C |
| Structured Results | **B+**(NDJSON 事件流+最终答案;schema 约定在宿主) | A(Approval/patch 协议) | — | B | B |
| Windows Support | **A**(pwsh/win32/ACL 沙箱一等) | B(原生 elevated 沙箱,一次性 UAC) | A(GUI) | C(需 Docker Desktop) | B |
| Distribution | **A**(npm/runtime 树形态,桌面产品同构) | B(npm/brew 分发) | F | C | B |
| Update Cost | B(alpha churn;pinned+契约门缓解) | B | — | C | B |
| General-purpose Ability | **A**(research/文档/office/web/文件/API) | C(coding-centric) | — | B(SE-centric) | C |
| Coding Ability | B+(editor+LSP+persistent shell) | **A+** | — | A | A |
| Browser/Desktop Potential | B(browser-use/computer-use 实验族) | C | **A**(形态强,无源) | B | C |
| **CompanyOS Contract Fit** | **A+**(S24 已冻结适配器+NDJSON 契约+PONG 实证;Node 同栈) | B(需新建 Rust subprocess 适配器) | F | C | C |

---

## 6. 三战略评估(§23)

### STRATEGY A:EMBED UPSTREAM RUNTIME(推荐)
**形态**:CompanyOS 安装包内置 pinned DSH runtime(npm 树)+ CompanyOS 专属 kernel profile(只挂载 `dsh-agent-loop`+`dsh-llm`(+deepseek/pi-ai adapter)+`dsh-tools`+选定工具族+`dsh-sandbox-policy`/`dsh-fs-sandbox`/`dsh-sandbox-windows-acl`+`dsh-user-approval`+session 持久化+compaction/spill;**不挂载** `dsh-base`/web/settings/`dsh-goal`/`dsh-workflow`/agent-team/telemetry)。经**既有** `dsh-headless` ExecutorProvider 适配器进入(S24 冻结管线:registry→preflight→dispatch→settlement),或未来升级到 SDK/jsonrpc 通道获取更细控制。
- 优点:实现成本最低(适配器已存在并实证);MIT 可分发;模型解耦/工具权限/上下文机制全部原生;Worldview 包根本不进 profile(其包架构**本身就是**可组合最小内核——`dsh-sdk-minimal` 即官方证明);升级有既有契约测试门。
- 风险与缓解:上游 alpha churn → pinned 版本+契约门+「内核=一个 Provider,可整体摘除」;Windows ACL 部分 → 诚实披露+CompanyOS S25 预检叠加。
- **世界观剥离是组合决策而非 fork 决策**——这是 A 优于 B 的本质。

### STRATEGY B:VENDOR / FORK MINIMAL KERNEL
固定版本裁剪 vendored 包集。**否决理由**:250 包 monorepo+cordis 框架内聚,vendor 面真实成本≈维护一个 fork;上游 alpha 期 merge 冲突高发;而 A 已用 profile 达到同样"最小内核"语义且零 fork。

### STRATEGY C:COMPANYOS THIN AGENT KERNEL
自研薄循环(吸收多项目机制),基于既有 `ExecutorProvider`/`ModelProviderPort`/Sprint 8 `createAgentRuntime`(单轮 pinned agent execution 已存在)+Sprint 9 工具注册表。
- **若做,最小机制清单(§Q4)**:多步 loop(step/turn+abort 信号共享);step/token 双预算+超时(composition-armed timer);模型 seam 直连 `ModelProviderPort`(逐 Task 路由);工具 registry+allow/deny(复用 S9)+协作超时;上下文组装自 Work Envelope+压缩策略(摘要重试)+spill(超长工具结果→有界预览);结果归一化到 `ExecutorProviderOutcome` 六类。
- **评估**:一次性成本中-高(工具族/沙箱/上下文管理等价物全部自建),换来零上游依赖与完全自控。**作为 A 的 fallback 与压力验证领域保持热备**,不是首选:DSH 的机制成熟度(并行调度/持久 inbox/ACL/审批/compaction/spill)短期难以等价重建,而其许可与解耦架构已消除"绑定"风险。

---

## 7. 十问回答(§27)

- **Q1 是否内置完整 upstream Runtime?** **YES——但以"pinned runtime + CompanyOS 最小 kernel profile"形态**(A 路线);不是裸装整个 DSH 桌面世界观。
- **Q2 哪个候选为基础?** **DeepSeek Harness**。理由:全源 MIT;模型层 provider-neutral(pi-ai/OpenAI 兼容/自托管/逐请求路由/BYO key);工具 allow/deny/ask+三类沙箱+审批 fail-closed(无 PROMPT_ONLY);headless+SDK+ACP 可嵌;Windows 一等(pwsh/ACL);通用工作非 coding-only;**CompanyOS 契约已冻结并实证**;Node 同栈。
- **Q3 若 NO 是否 Thin Kernel?** A 已当选;**C 保留为热备**(触发条件:上游许可变更/契约漂移不可控/维护成本超阈值)。
- **Q4 Thin Kernel 最小机制?** 见 §6 STRATEGY C 清单。
- **Q5 DSH 吸收机制?** 见 `AGENT_RUNTIME_MECHANISM_MAP.md`(总 disposition:机制 **ADAPT/COMBINE**,worldview **REJECT**)。
- **Q6 ZCode 吸收机制?** 无源;仅登记 FUTURE_DESKTOP_CAPABILITY 形态参考(桌面工具能力未来挂在内核上,不引入第二 Truth)。
- **Q7 Codex 吸收机制?** SE 向:apply_patch 风格结构化编辑、approval×sandbox 双门、turn/item/delta 事件流纪律、规划-执行分离——**ADAPT(原则级)**;Rust runtime/ChatGPT 绑定倾向/产品体系 REJECT。
- **Q8 模型动态切换如何保证?** 内核逐请求 `provider+model` 路由;CompanyOS Model Pool 拥有模型 profile(id/provider/能力/上下文窗/成本/时延/结构化/代码/推理/历史可靠性);adapter 在 dispatch 时下发路由;不换 Runtime。
- **Q9 用户只装 CompanyOS?** **YES**——pinned runtime 随安装包分发+首启健康检查;无第二桌面软件/无手工 prompt 往返。
- **Q10 避免多会员?** **YES(架构上)**——内核消费 CompanyOS Model Pool 的 BYO key/额度;DSH OAuth 为可选增强非前提。*(注意:本机当前 DSH 账号凭证失效的运营事件不构成架构反例,恢复路径=API-key 路线。)*

---

## 8. 风险与实施建议

**Major Risks**:
1. 上游 alpha churn/无 LTS(缓解:pinned+NDJSON 契约门+整体可摘除)。
2. profile 组合面 = 事实 API 依赖(缓解:升级前跑冻结契约套件;dsh-live 恢复后纳入常规门)。
3. Windows ACL 部分执行(缓解:诚实披露+CompanyOS S25 预检+未来 Landlock/E2B 按需)。
4. 内核与 CompanyOS 语义漂移(缓解:机制图 disposition 冻结+架构守卫已有 11 法则+6 源级探针)。

**Implementation Recommendation(下一 Sprint 提案,待 Boss 批准后才做)**:
1. `KERNEL_PROFILE` 组合定义(pinned 版本+包清单+禁挂载清单)+ 安装包分发/健康检查设计文档;
2. CompanyOS Model Pool → 内核路由的 adapter 映射规范(模型 profile 字段对齐 `dsh-llm` 路由);
3. 工具可见集 per-Task 收窄的声明式配置(Role→工具族);
4. 契约升级门(既有 dsh-live/s24 套件扩展)。

**Next Sprint Recommended**:`DEFAULT_KERNEL_PROFILE_SPEC`(设计冻结,仍零接入)——把上述 4 项写成可审规格;真实接入与 Bug Bash 继续等待 Boss 令。

---

## 9. 本 Sprint 遵守的禁令

未实现任何真实 Agent Kernel;未接入 DSH/Codex/ZCode;未复制外部源码进生产;未修改 ExecutorProvider/canonical Truth;未做 Smart Router/Model Tournament/多 Agent Team/Bug Bash/V1 Freeze。仅研究、建模、裁决。
