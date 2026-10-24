# OFFICIAL UPSTREAM KERNEL COMPARISON — Stage 1 官方源码重评估(研究冻结稿)

> 状态:**STAGE 1 / RESEARCH ONLY**——只研究、建模、裁决;未实现任何 Kernel;未接入任何真实 Agent。
> 基线 `b34f02f`。本文件取代上一轮以**本机安装版**为架构证据的做法(本机版降级为 LOCAL_COMPATIBILITY_SAMPLE,见 `LOCAL_DSH_CONTAMINATION_REPORT.md`)。
> 上位:`DEFAULT_AGENTIC_KERNEL_SELECTION.md`(路线框架)、`EXECUTOR_ECOSYSTEM_MODEL.md`(适配器契约)。

---

## 0. 钉住的官方证据(PINNED EVIDENCE)

| 项 | DeepSeek Harness | ZCode |
|---|---|---|
| Repo | `https://github.com/deepseek-ai/deepseek-harness` | `https://github.com/zai-org/ZCode` |
| Clone 位置(CompanyOS 仓外,research-only) | `E:\DeepSeek.gzq\kernel-research\dsh-upstream`(+worktree `dsh-016`) | `E:\DeepSeek.gzq\kernel-research\zcode-upstream` |
| Branch | `master` | `main` |
| **Exact commit SHA** | **`639ed015397290b3745d163aafe02ffee4aa3f84`** | **`29628c9acdb81b703bbd4080c207a0e7ce5e276e`** |
| Tag / version | `dsh-v0.2.0-rc.2`(apps/cli `0.2.0-rc.2`) | `v3.14.3`(root `zcode` `3.14.3`;CLI 子工作区 `zcode-cli` `0.16.9`) |
| **License** | **MIT**(根 `LICENSE` ©2026 DeepSeek;逐包 `license: MIT` 抽验:`dsh-headless`/`dsh-sdk-minimal`/`dsh-llm`/`dsh-llm-pi-ai`/`dsh-agent-loop`/`dsh-sandbox-policy`/`dsh-tools`)+`THIRD_PARTY_NOTICES.md`+`SAFETY.md` | **Apache-2.0**(根 `LICENSE`+root package.json;子包 license 字段多为空=根许可统辖)+`NOTICE.md`+`THIRD_PARTY-NOTICES.md` |
| 商用/修改/随 CompanyOS 分发 | 允许;保留版权声明 | 允许(含专利授权);保留 NOTICE |
| 上游自我声明 | **SAFETY.md:"experimental developer-preview…not undergone a security audit and must not be treated as secure or production-ready";沙箱不保证隔离** | **NOTICE.md:共享 Agent 执行适配器不提供默认 OS 沙箱;工作目录/工作区身份不是系统级隔离** |

**上一轮重大更正**:ZCode 官方仓库**存在且开源(Apache-2.0)**。上轮"专有/无源"结论只对本机**桌面分发**成立(`D:\zcode` Electron app.asar)——当时未查官方仓库,本轮已纠正。

---

## 1. 同维度比较矩阵(26 维,全部官方源码证据)

| 维度 | DSH 官方 `0.2.0-rc.2` | ZCode 官方 `v3.14.3` |
|---|---|---|
| **Source Completeness** | **FULL**:pnpm monorepo,`packages/` 61 域目录(~320 个 `@deepseek-ai/*` 包)+`apps/`(cli/desktop/desktop-host/web)+`native/`+`python/`+测试(vitest 全家) | **FULL**:根 `packages/` 14 域(client/desktop/provider/server/rpc/services/ui/web/zcode-cua…)+`apps/zcode-cli/` 子工作区(16 包:core/cli/adapters/contracts/tui/node-repl-host…)+`harness/remote`+测试 |
| **License** | MIT×包 | Apache-2.0(根);子包无显式字段(如实记录) |
| **Model Independence** | `dsh-llm` provider-neutral seam;`dsh-llm-pi-ai`("multiple pi-ai providers, **OpenAI-compatible gateways, or self-hosted servers**…Profiles and credentials are resolved **for each request**");0.2.0 把 DeepSeek 路线拆为 **`llm-deepseek-account` 与 `llm-deepseek-api-key`**(账号 vs BYO-key 分包);OAuth 可选非强制 | provider 注册表:builtin+`zai-family`/`bigmodel-family`+**`standard-personal`**;协议枚举 **`anthropic-messages`/`openai-chat-completions`/`openai-responses`**;`ModelSelection{providerId,modelId,reasoningLevel}` 逐执行选择+typed `selectionIssue`;subagent 携带 `modelSelection(Override)`;`zhipu-coding-plan` 账号类 provider 是**一类**而非前提 |
| **Agent Loop** | `dsh-agent-loop`:turn/step、durable Inbox 投影、abort 信号按 step 共享、`maxParallelToolCalls` 并行调度、取消保留已交付文本 | `TurnMachineImpl` 类型化相位状态机(非法转移抛 typed recoverable 错);turn-state/message-history(hydration)/compact-session |
| **Tool Runtime** | `dsh-tools` defineTool(typed 参数/输出、协作超时、parallel-safety、FC+PTC);工具族=shell(fs/bash/pwsh+persistent)/fs-search/str-replace-editor/web/terminal/lsp/skill/todo/… | tool executor:`call-runner`/`batch-runner`/`approval-gate`/`permission-flow`/`permission-input-recheck`/`timeout`/`hook-flow`/`background-tasks`;edit-matchers/path-policy/diff |
| **Permission Enforcement** | allow/deny/ask+per-agent 可见集;`sandbox-policy` fail-safe 默认 read-only;`fs-sandbox` 三模式 typed 拒绝;bash/pwsh 沙箱;**`sandbox-windows-acl`(诚实 partial)**;Landlock(Linux);`user-approval` fail-closed+审计 | **权限规则引擎**:`PermissionRuleset`+通配 rule-matching+`RiskLevel`+`CollaborationMode`(含 plan 模式)+`alwaysAsk`/`readOnly` 能力组+webfetch 预批准 URL 规则+approval-gate+权限规则持久化;**无默认 OS 沙箱(NOTICE 诚实)**——强制点在工具层 ask/allow,非 OS |
| **Workspace Boundary** | sandbox-policy workspaceRoot(部署默认+会话覆盖,重启存活) | 会话工作目录/工作区身份;NOTICE 明言非系统级隔离 |
| **Filesystem** | `tool-fs(-search)`/`tool-str-replace-editor`+`fs-sandbox` | edit-matchers+path-normalization+path-policy+diff |
| **Process/Shell** | `tool-bash/pwsh(+persistent)` 沙箱化 | bash 工具+bash-timeout-policy;按 OS 账号权限运行(NOTICE) |
| **Git** | workspace-changes 包;hooks 集成包 | edit/diff 深度集成;git 工具在 handler 面(细节 `PARTIALLY_VERIFIED`) |
| **Network** | web 工具**独立成包**(search: deepseek/exa/perplexity;fetch)——不挂载即无网络工具(组合级裁剪) | webfetch+预批准 URL 规则;browser 插件 |
| **Browser** | `browser-use` 域(chrome-devtools-mcp/playwright-mcp/stagehand,experimental) | `browser-use-plugin`+browser-client;**`zcode-cua`=fail-closed 占位包**("every runtime surface reports unavailable and fails closed") |
| **Context** | compaction 族(basic/tool-result-pruner/image-offload)+**spill**(超长工具文本→locator+有界预览) | `compact/`+session-context+memory+embedded-search |
| **Session** | session 持久化(jsonl/sqlite 投影/查询/snapshot/checkpoint)——subordinate only | session-context/history;**自带 workflow 草稿世界观**(`workflow-draft-path`/AMEND_WORKFLOW 工具)=必须 REJECT 的上层 Truth |
| **Cancellation** | step 级共享 abort+部分结果 durable 记录 | turn-control+executor abort 面 |
| **Timeout** | `tool-call-timeout-policy`+timeout 包 | `bash-timeout-policy`+executor `timeout.ts` |
| **Error handling** | LLM 稳定错误码(NO_ADAPTER/MISSING_CREDENTIAL/AUTH/RATE_LIMIT/CONTEXT_WINDOW_EXCEEDED)+流终止块 | typed `CoreError`(recoverable 标志)+`selectionIssue` 枚举 |
| **Headless** | **`bundle/headless`**:one-shot CLI,无 GUI/server,`--json` NDJSON,`--session-id` 续作,退出码语义 | **server `entry-stdio`/`entry-http`**+CLI(TUI/SEA);headless 服务形态存在 |
| **SDK/API** | `bundle/sdk-minimal`(模型来自 **SDK initialization request**;显式排除 base/web/settings/凭证/遥测/compaction/fs 工具/skills/jobs/subagents)+`sdk/`(client/protocol/server) | `rpc` 框架(VS Code 风格 IPC 抽象)+`server`+`zcode-server-cli`(`bin: zcode`) |
| **Windows Support** | 一等:pwsh 工具/win32-process/**windows-acl 沙箱** | 一等:Electron 桌面在 Windows 发行(本机即证);Node 24.14+pnpm 10.33(mise 钉版) |
| **Distribution** | npm 公开包+桌面产品内嵌 runtime 树(本机形态同构) | pnpm monorepo;desktop/web/server/CLI(SEA)多形态 |
| **Update Cost** | **高**:0.1.6→0.1.7-rc→0.2.0-rc 数周内;自称 experimental preview;域目录大重构已发生一次 | 版本成熟(v3.14.3);但嵌入面(desktop/web/services 栈)大,跟随成本高 |
| **General-purpose Ability** | research/文档/office/web/文件工具族——通用 | coding workspace 基因为主+web/桌面;通用性次之 |
| **Coding Ability** | editor+LSP+persistent shell(B+) | coding 工作台血统:diff/edit/bash/测试面(A) |
| **CompanyOS Contract Fit** | **A+**:S24 已冻结 `dsh-headless` 适配器并实证(对本机同源 0.1.6-alpha.2 构建);Node 同栈;逐请求模型;最小组合官方支持 | **B-**:尚无适配器;自有 workspace/skills/plugins/workflow-draft 世界观与 agent core 缠绕更深;无"最小内核组合"等价物;Apache 专利授权是加分 |

---

## 2. 两项特别确认

### 2.1 Task A→Model A / B→Model B / C→Model C,同一内核?

- **DSH:YES(架构原生)**。模型选择是**逐请求**字段(`GenerateOptions.provider`+`model`;pi-ai 路由"resolved for each request");`sdk-minimal` 组合的模型来自 **SDK initialization request**(宿主每次启动会话时指定);0.2.0 的 `llm-deepseek-account`/`llm-deepseek-api-key` 分包让"账号路线"与"BYO-key 路线"可分别挂载——CompanyOS Model Pool 逐 Task 下发路由,内核零修改。
- **ZCode:YES(架构支持,带条件)**。`ModelSelection{providerId,modelId,reasoningLevel}` 是逐执行 schema,subagent 还支持 per-invocation override;personal `standard-personal` provider(api-key,三协议)允许 BYO 端点。**条件**:`resolveEffectiveModelSelection` 对 `account-plan` 类 provider 有"当前账号连接"回退语义——CompanyOS 必须只钉 `standard-personal` provider 并禁用账号类回退,否则模型选择权会漂移到账号状态。

### 2.2 用户是否可以只安装 CompanyOS?

- **DSH:YES**。内核=pnpm/npm 可分发的 Node runtime 树(MIT);CompanyOS 随安装包携带 pinned 版本+专属 profile;无 GUI/daemon/独立账号前提。
- **ZCode:架构上 YES 但成本更高**。`server`(stdio/http)+`zcode-cli` core 是 Node/TS,理论上可子集分发;但 agent core 依赖其 provider/services/session/workspace 脚手架,无官方"最小组合",嵌入面显著更大。

---

## 3. 三方对照结论(允许词表内)

- **DSH_MANAGED_MINIMAL_RUNTIME** —— 成立(官方源重新证实全部关键机制;`sdk-minimal` 即官方支持的最小组合先例;CompanyOS 契约适配器已冻结)。
- **ZCODE_MANAGED_MINIMAL_RUNTIME** —— 架构上可探索但**不推荐为默认**:无最小组合等价物、世界观缠绕更深、无既有适配器;其**权限规则引擎与 ModelSelection schema 是一流的机制吸收源**,且 Apache-2.0+server stdio 使它成为未来"第二个 ExecutorProvider"的强候选(与默认内核正交)。
- **COMPANYOS_THIN_KERNEL** —— 保留为热备(上一轮已列最小机制清单);本轮官方源证据反而提高了它的门槛(DSH 0.2.0 的 account/api-key 分包、ZCode 的权限规则引擎都是可直接消费的成熟机制)。
- **MORE_RESEARCH_REQUIRED** —— 不需要:两候选官方源码完整可评,无黑洞。

**最终裁决(提交 Boss 复核):`DSH_MANAGED_MINIMAL_RUNTIME`**——在官方源证据下重新确认,且**必须**携带以下 Stage 3 前提:
1. 锚定官方 tag(建议 `dsh-v0.2.0-rc.2` 起步或首个 0.2.0 stable),不再以本机 `-max` 分发版为依据;
2. SAFETY.md 的 experimental 声明原文进入 Profile Spec 风险节(升级门必须含安全通告跟踪);
3. 模型路线只钉 BYO-key(`llm-deepseek-api-key`/`llm-pi-ai` 自定义路由),不挂 account 路线;
4. worldview 包(goal/workflow/plan/agent-team/web-app/settings)**永不入 profile**(禁挂载清单);
5. ZCode 官方仓库登记为**第二参考机制源 + 未来第二 adapter 候选**(修正上轮"专有"误判)。

---

## 4. 与上一轮结论的差异(诚实记录)

| 项 | 上一轮(本机证据) | 本轮(官方证据) | 影响 |
|---|---|---|---|
| DSH 证据基础 | 本机安装版(0.1.6 分发) | 官方 master@639ed01 / `dsh-v0.2.0-rc.2` | 上轮所有包级结论在 0.2.0 复核为仍然成立(域目录重命名);新增 account/api-key 分包与 SAFETY.md 声明 |
| ZCode 分类 | 专有/无源 → REFERENCE_ONLY | **官方开源 Apache-2.0 v3.14.3** → 全源候选 | 上轮误判根因=只查了本机桌面分发;本轮完成首次真评 |
| 推荐路线 | STRATEGY A(EMBED_UPSTREAM,DSH) | **DSH_MANAGED_MINIMAL_RUNTIME**(同义,词表对齐 Boss Stage 1) | 结论稳定,证据基础已更换为官方源 |
| 新风险 | — | 上游自称 experimental/未审计(DSH);ZCode 无 OS 沙箱声明(其 NOTICE) | 进入 Profile Spec 风险节与升级门设计 |

---

## 5. HARD STOP 声明

本 Stage 未实现 Kernel、未接入 DSH/ZCode/Codex、未复制外部源码进 CompanyOS、未修改 ExecutorProvider/canonical Truth。研究 clone 位于 CompanyOS 仓库之外(`E:\DeepSeek.gzq\kernel-research\`),仅为只读证据。等待 Boss Kernel Selection Review(Stage 2)。
