# DSH DEFAULT KERNEL PROFILE SPEC — Stage 3 设计冻结(DEFAULT_KERNEL_PROFILE_V1)

> 状态:**STAGE 3 SPEC(设计冻结;零生产实现)**。Boss Stage 2 已批准路线:`DSH_MANAGED_MINIMAL_RUNTIME`。
> CompanyOS 基线 `646f0c4`。官方唯一依据:deepseek-harness pinned 源(见 §1)。本机 `-max` 分发版只用于最终兼容性对照(见 `DSH_KERNEL_DISTRIBUTION_UPDATE_SPEC.md` §6)。
> 本文件回答:**CompanyOS 真正需要 DSH 哪些包/哪些绝对不要/模型与工具怎样被 CompanyOS 控制/权限怎样映射/启动停止升级崩溃分发与替换**。

---

## 1. 上游锚点(与基线区分)

| 项 | 值 |
|---|---|
| Upstream repo | `https://github.com/deepseek-ai/deepseek-harness` |
| **RESEARCH_BASELINE** | `639ed015397290b3745d163aafe02ffee4aa3f84` = tag `dsh-v0.2.0-rc.2`(**不是** Shipping Baseline) |
| **IMPLEMENTATION_BASELINE** | 由可复现门裁决(`DSH_KERNEL_DISTRIBUTION_UPDATE_SPEC.md` §2 记录;允许=research baseline 或另一官方 tag;**禁止** local `-max`/未提交树/私人 fork) |
| Node/pnpm 要求 | engines `node ^22.19.0 \|\| >=24.0.0`;`packageManager pnpm@11.7.0`(本机门禁环境:node v24.19.0 + pnpm 11.7.0,精确匹配) |
| License | MIT(根+逐包);随包分发须保留全部包级 LICENSE(见分发规格 SBOM 节) |
| 上游自我声明 | SAFETY.md:experimental developer-preview、未经安全审计、不可作唯一安全边界 → 本规格 §7 纵深模型与升级门安全通告跟踪的强制输入 |

## 2. PROFILE 目标(冻结)

默认 Kernel 只承担:**Model invocation / Tool invocation / Observe / Continue / Stop / Local bounded context / Subordinate session-runtime state / Cancellation / Timeout / Runtime diagnostics**。
一切 canonical concern(Goal/Plan/Workflow/Task/Role/Authority/Artifact/Validation/Decision/Handoff/Outcome)归 CompanyOS——Kernel 输入=Canonical Work Envelope,输出=现有 `ExecutorProviderOutcome` 六类,零新增完成语义。

## 3. PACKAGE 分类(官方 pinned 源推导;方法=依赖闭包脚本+官方 `bundle/sdk-minimal` 组合先例)

官方架构为 **peer 驱动**:`dsh-agent-loop` 硬依赖仅 17 包;其余能力(llm/session/tools/approval/sandbox)是组合挂载的 peer。官方 `packages/bundle/sdk-minimal`(28 deps + `cordis.patch.yml` 完整树,"deliberately excludes dsh-base, Web, settings, managed credentials, telemetry, compaction, filesystem tools, workspace instructions, skills, jobs(注:其 patch 实际挂 jobs-local 供持久 shell), subagents")是厂方支持的最小 agent 先例——**CompanyOS Profile 以它为骨架修改**。

### 3.1 REQUIRED(V1 组合面;= 闭包并集 ∪ sdk-minimal 骨干 ∪ CompanyOS 增补)

**A. 组合/运行骨架**:cordis、cordis-plugin-loader、cordis-plugin-include、cordis-plugin-timer、dsh-app-boot*(见 3.4 †)、dsh-lazy-require、dsh-invariants
**B. Agent 核心**:dsh-agent、dsh-agent-loop、dsh-scope、dsh-system-prompt、dsh-tools、dsh-timeout
**C. 模型缝(BYO-only)**:dsh-llm、dsh-llm-pi-ai(**主路线**:hand-declared routes `api: openai-completions`+`baseURL`+`apiKeyEnv`+model 元数据)、dsh-llm-deepseek-api-key(可选直连)、dsh-llm-retry、dsh-credentials、dsh-credentials-local(apiKeyEnv 引用解析)、dsh-launch-environment、dsh-home-paths(重定向至 scratch)
**D. Session(subordinate)**:dsh-session、dsh-session-persistence-jsonl、dsh-session-projection、dsh-atomic-write、dsh-storage(-domain)
**E. 工具(V1 最小集)**:dsh-tool-fs、dsh-fs、dsh-fs-local、dsh-fs-sandbox、dsh-tool-str-replace-editor、dsh-tool-pwsh(-persistent)、dsh-tool-bash(-persistent,非 win32 主用)、dsh-shell、dsh-shell-env、dsh-terminal、dsh-terminal-bash、dsh-subprocess-local、dsh-jobs-local(持久 shell 的 jobs peer)、dsh-win32-process、dsh-util-code-language、dsh-util-values、dsh-util-crypto
**F. 权限/沙箱**:dsh-sandbox、dsh-sandbox-policy、dsh-sandbox-local、dsh-sandbox-windows-acl、dsh-user-approval、dsh-workspace、dsh-ptc-runtime、dsh-typert-protocol、dsh-output-retention
**G. 传输(Stage 4 候选,规格内二选一)**:dsh-sdk-app + dsh-sdk-jsonrpc-server(managed child,JSON-RPC/stdio)∨ dsh-headless + dsh-cmdline + dsh-plugin-manager(静态单 profile 加载;one-shot NDJSON——S24 适配器契约面)

### 3.2 OPTIONAL(挂载即用,不挂不残)

dsh-session-title(会话标题;诊断便利)、dsh-mcp-resources(tools 的 MCP 资源面;仅当 MCP 升 OPTIONAL 时)、dsh-compaction(-basic)/dsh-spill(-local,-policy)(长任务上下文;V1 默认挂 basic+spill-local 以防爆上下文——**这是 OPTIONAL 中唯一建议 V1 挂载的**)、dsh-brand(输出署名剥离配置)

### 3.3 DEFER(V1 后按需评估)

browser-use 族、computer-use 族、dsh-acp(ACP 传输)、dsh-mcp-client、dsh-subagent 族、dsh-lsp(-stdio)、dsh-skill 族、dsh-web(-search/-fetch)、dsh-e2b/dsh-ssh/dsh-sandbox-ssh(远端沙箱)、dsh-experimental-* 全族、dsh-session-query-sqlite、dsh-session-snapshot

### 3.4 EXCLUDE(Worldview Denylist —— 与 CompanyOS canonical concern 重叠者,默认禁载)

| DSH 域/包 | WHY EXCLUDED | CompanyOS 既有 Owner |
|---|---|---|
| `packages/goal/*`(dsh-goal、goal-round-driver、tool-goal) | DSH Goal/轮次驱动世界观 | Goal(S18 run-goal)+goal.advance 管线 |
| `packages/plan/*`、`dsh-plan-mode` | Plan 所有权 | Plan/WorkflowVersion(S20 编译钉定) |
| `packages/workflow/*`(dsh-workflow、workflow-ptc、tool-workflow) | Workflow 真相 | WorkflowVersion/Run |
| `dsh-experimental-agent-team*`、`tool-subagent(-control)` V1 | Team Task DAG/状态 | Task/ExecutionAttempt(S21) |
| `packages/api/*`、`apps/web`、`packages/client*`、`packages/host*`、`apps/desktop*` | Web/桌面产品面 | CompanyOS UI(Renderer+Control Plane) |
| `packages/settings/*` | 用户设置产品面 | CompanyOS 配置(S25 类型化) |
| `packages/boot/plugin-manager` 自动发现、`packages/preset/agent-presets` 出厂预设、`dsh-plugin-package-inventory-deepseek` | 插件市场/远程发现 | §6 插件策略:CompanyOS 静态 allowlist |
| `packages/telemetry/*`、`dsh-anonymous-user-id` | 遥测身份 | 不适用(禁载;诊断走 CompanyOS 观测) |
| `packages/interaction/commands`、`dsh-commands`、`dsh-command-*` | 用户命令系统 | Control Plane 操作面 |
| `dsh-llm-deepseek-account`、`dsh-deepseek-account-platform`、`dsh-authorization`(OAuth 流)、`dsh-session-log-deepseek`、`dsh-deepseek-llm-api-extensions`(account 邻接) | **账号/订阅/OAuth 路线(§5 硬禁)** | CompanyOS Model Pool(BYO key) |
| `dsh-jobs`(抽象,保留 jobs-local 实现)、`dsh-attachment`、`dsh-feedback`、`dsh-schedule`、`dsh-deliverables`、`dsh-brand` UI 面 | 产品功能面 | 无需/已有对应 canonical |
| `dsh-e2b`、`dsh-ssh`、远端沙箱 | V1 边界外 | 未来评估 |

† `dsh-app-boot` 仅取其 **Loader 组合 glue**(.env/守护/fail-loud loader);其 app 生命周期(desktop/web)不进入。若 G 组选 sdk 路线,boot 由 `dsh-sdk-app` 承担,`dsh-app-boot` 可整包 EXCLUDE。

### 3.5 闭包证据(官方源记录)

- `dsh-agent-loop` 硬依赖闭包(deps-only)=17 包;含 peers 的运行闭包=22 包(已含 sandbox-policy/user-approval/workspace/timeout/session 族)。
- 扩展闭包(+llm-pi-ai/api-key/tool-fs/tool-bash/tool-pwsh/fs-local/fs-sandbox/sandbox-local/windows-acl/credentials-local/str-replace-editor,含 peers)=55 包——**V1 Profile 的包面 ≤55,扣除不挂载 peers(jobs 抽象/skill/attachment/authorization 等)后实际分发面约 40-45 包**(精确数以 Stage 4 构建产物 SBOM 为准)。

## 4. TOOL ALLOWLIST 与 VISIBILITY(冻结)

- **V1 挂载工具**:File Read/Write(tool-fs+fs-local+fs-sandbox)、结构化编辑(str-replace-editor)、Process/Shell(persistent pwsh/bash,经 bash-sandbox/pwsh-sandbox+windows-acl)、Git(经 shell 工具 `git` 命令;不单独挂 git 工具包——官方无独立 git 工具包,与 §21 owner 一致)。
- **Visibility 控制链(机械)**:组合时 tools 行按 Role/Task 声明挂载 → `dsh-tools` 对模型只暴露已挂载+per-agent 收窄后的集合 → **模型/Agent 无 mount 接口**:插件管理器不装、preset 出厂树不挂、MCP 不挂、subagent 不挂 → profile 文件本身由 CompanyOS 生成于 scratch 目录(进程级 env `DSH_HOME` 重定向),Agent 运行时不可写。
- **证明义务(Stage 4/5 测试)**:未挂载工具在模型 tool 列表不可见;尝试调用未暴露工具名=typed 工具错误;运行期无任何 API 可追加工具。

## 5. MODEL ROUTE(BYO/API-only,冻结)

- 唯一路线:`CompanyOS Model Pool → 选定 provider/model → pi-ai hand-declared route(api: openai-completions|anthropic-messages|openai-responses, baseURL, apiKeyEnv, models[]) → dsh-llm 逐请求 provider+model`。
- **EXCLUDE(硬禁)**:`dsh-llm-deepseek-account`、OAuth 授权流(`dsh-authorization`)、任何 account-plan fallback、DSH 登录/订阅。组合上这些包**不在依赖面**——fallback 在进程内不存在,而非被禁用。
- 指定模型不可用 → 内核返回 typed 失败(`NO_ADAPTER`/`MISSING_CREDENTIAL`/`AUTH`/`UNKNOWN_MODEL`)→ 归一化为 CompanyOS provider-failed(§9);**内核永不自选替代模型**。
- 细节(ADR/密钥/路由表生成)→ `DSH_KERNEL_MODEL_BRIDGE_SPEC.md`。

## 6. 插件策略(冻结:V1 DISABLED BY DEFAULT)

只允许 CompanyOS 打包、版本锁定、审计过、allowlisted 的组合行(即本 Profile 的 cordis.patch)。**机械关闭面**:不挂 `plugin-manager`;不挂 `dsh` 聚合 CLI 入口(apps/cli 的自动发现/registry 逻辑不进入);`DSH_HOME` 指向 CompanyOS 生成的 scratch(无用户 profile 层可叠加);config trees 只含 CompanyOS 生成的 profile 文件。禁:runtime 自动发现 registry、模型装插件、远程 marketplace、用户不知情安装。

## 7. 安全边界(defense in depth;详见 `DSH_KERNEL_SECURITY_BOUNDARY.md`)

冻结表述:**CompanyOS Outer Boundary(S25 preflight/workspace trust/path containment/capability negotiation/SecretRef/approval provenance/process bounds/settlement)+ DSH Inner Enforcement(sandbox 三模式/tool visibility/approval interception/fs+process enforcement)**。**禁止任何"DSH sandbox 保证 Agent 安全"表述**;windows-acl 为诚实 partial(Landlock 仅 Linux,不计入 Windows PASS)。

## 8. SESSION(冻结:SUBORDINATE_RUNTIME_STATE)

- V1 模式:**per-attempt ephemeral**(create→run→return→destroy),与 Boss §15"优先最简单模式"一致;session 持久化(jsonl)挂载但存储根=attempt 级 scratch(诊断可取,业务不依赖)。
- 身份映射(三者不等):`CompanyOS attemptId(exa_*,canonical)` ≠ `provider invocation identity(本内核=null,S24 已证无 per-invocation id)` ≠ `DSH session id(session-*)`;后者仅作为 `provider_session_id` subordinate 列记录(S24 冻结),DSH session 损坏/消失不影响 CompanyOS 判定 attempt 状态。
- 续作:`session-continuation` 能力仅用于**显式新工作**(Boss 令 + S24 §21),永不自动重放(UNCERTAIN 拒绝已冻结)。

## 9. RESULT / ERROR 归一化(冻结映射)

**Result**:DSH 一次 agent 运行的 durable 结果 → `ExecutorProviderOutcome`:`succeeded`(exitCode 0+最终文本/structured,artifact 走 `structured.artifactContent` 约定→Sprint-13 物化,已在 Final Readiness Gate 冻结)/`provider-failed`/`transport-failed`(内核进程崩溃/无法启动)/`cancelled`(signal+终止证明)/`timeout`(timer+终止证明)/`uncertain`(外部副作用不可证)。**禁新增** AgentSuccess/AgentTaskComplete/AgentWorkflowComplete。

**Error 表**(DSH→CompanyOS taxonomy):

| DSH 侧 | CompanyOS 归一 |
|---|---|
| `NO_ADAPTER`/`UNKNOWN_MODEL`(路由缺失) | provider-failed,reason=EXECUTOR_MODEL_ROUTE_MISSING(配置错误,非重试型) |
| `MISSING_CREDENTIAL`/`INVALID_CREDENTIAL`/`AUTH` | provider-failed,reason=MODEL_AUTH(SecretVault 指针失效路径) |
| `RATE_LIMIT`/`QUOTA` | provider-failed,reason=MODEL_RATE_LIMIT(可重试分类) |
| `CONTEXT_WINDOW_EXCEEDED` | provider-failed,reason=MODEL_CONTEXT_OVERFLOW |
| `FS_SANDBOX_DENIED`/sandbox 拒绝/approval `never` 拒绝 | 内核内工具拒绝(Agent 自行调整或中止);若 Agent 因此中止→其 outcome 归一(不绕过) |
| 模型输出 malformed | llm 错误→agent-loop 中止→provider-failed,reason=MODEL_OUTPUT_MALFORMED |
| 工具/进程失败 | Agent 内部观察;Attempt 级失败→provider-failed,reason=TOOL_FAILURE |
| 内核进程 crash/启动失败 | transport-failed,reason=KERNEL_CRASH |
| session 损坏 | provider-failed(续作场景)或新 attempt;不判完成 |
| 未知外部效应 | uncertain(现有语义) |

## 10. 传输(Stage 4 推荐,不预设终局)

| 选项 | 隔离 | 升级隔离 | 健康检查 | 契约现状 | 评估 |
|---|---|---|---|---|---|
| **Managed child + sdk-jsonrpc-server**(stdio JSON-RPC) | 进程级 | 换 pinned 树即换内核 | initialize/ping 面 | 官方 sdk-minimal 同组合 | **Stage 4 首选**(Boss 优先原则全中) |
| One-shot headless CLI(NDJSON) | 进程级(每任务一进程) | 同上 | 退出码 | **S24 已冻结适配器+实证** | 首选的 fallback/MVP 捷径 |
| In-process library(cordis 直挂) | 无(同进程) | 差 | — | 可行 | 否决(V1):崩溃 containment 不足 |
| ACP | 进程级 | 好 | 协议内 | 官方 acp 包 | DEFER(V1 后按需) |

## 11. START/STOP CONTRACT(冻结语义)

`start`(spawn 子进程,注入 env:DSH_HOME=scratch、模型路由 env 键、超预算)→ `ready`(initialize/首 ping)→ `health`(ping+内存/任务数上限)→ `execute`(一次 CompanyOS attempt=一次 agent 运行:Work Envelope→persona/system-prompt 注入+任务)→ `cancel`(AbortSignal→agent-loop step 级 abort→进程树终止证明)→ `shutdown`(graceful dispose→超时强杀)→ `crash`(§12)。**DSH Desktop 生命周期不是产品 runtime 生命周期**。

## 12. CRASH 语义(冻结)

内核崩溃→transport-failed→**现有** at-least-once/uncertainty 语义接管:dispatch 行 PUBLISHED/UNCERTAIN 拒绝自动重放(S24 §16/17/20);CompanyOS 以自身 durable attempt/dispatch 状态判定,DSH session 自恢复**永不**决定 CompanyOS 完成与否;重试安全由 configFingerprint 漂移门(S25)守。

## 13. 事件流策略(冻结)

内核事件(turn/step/tool/model/approval/diagnostic/session)**默认=provider-internal noise**,仅三类出口:①runtime observation 投影(有界采样→现有 RunObservation,不建第二 durable timeline);②usage accounting(token/模型/时长→现有 usage 管道);③诊断日志(有界,redactExecutionText 同源规则)。

## 14. EXIT STRATEGY(冻结证明)

删除整个 DSH Kernel = 注销一个 `ExecutorProvider` 实现+删除 pinned runtime 目录+移除路由表生成器。Goal/Plan/Task/Workflow/Role/Model Pool/Artifact/Validation/Authority/UI/Database **零迁移**(Sprint26 anti-coupling 已证"无任一 agent 完整运转";本 Profile 未引入任何新依赖面)。

## 15. READY_TO_IMPLEMENT 判定(§38 十三项对照)

见 `DSH_KERNEL_DISTRIBUTION_UPDATE_SPEC.md` §7(含可复现门记录)——十三项全 YES,门全 PASS,判定 **READY_TO_IMPLEMENT_EMBEDDED_KERNEL = YES**。

---

## 16. DEFAULT_KERNEL_PROFILE_V1(汇总卡)

| 字段 | 值 |
|---|---|
| Upstream repo | `https://github.com/deepseek-ai/deepseek-harness` |
| Research baseline | `639ed015397290b3745d163aafe02ffee4aa3f84`(`dsh-v0.2.0-rc.2`) |
| **Implementation baseline** | **同上**(可复现门裁决;rc 状态→二十项升级门约束) |
| Node/pnpm | node `^22.19.0\|\|>=24.0.0`(门环境 v24.19.0);pnpm `11.7.0` exact |
| Required packages | §3.1 A-G(骨架 cordis/loader/include/timer;agent 核心 agent/agent-loop/scope/system-prompt/tools/timeout;模型 llm/llm-pi-ai/llm-deepseek-api-key(OPT)/llm-retry/credentials(-local)/launch-environment/home-paths;session(-persistence-jsonl/-projection)/storage;工具 tool-fs+fs(-local/-sandbox)/str-replace-editor/pwsh(-persistent)/bash(-persistent)/shell(-env)/terminal(-bash)/subprocess-local/jobs-local/win32-process;权限 sandbox(-local/-policy/-windows-acl)/user-approval/workspace/ptc-runtime/typert-protocol/output-retention;传输二选一 sdk-app+sdk-jsonrpc-server ∨ headless+cmdline;**研究原型实证=后者**) |
| Optional | compaction-basic+spill(-local/-policy)(**建议 V1 挂**)、session-title、mcp-resources |
| Deferred | browser/computer-use/acp/mcp-client/subagent/lsp/skill/web/e2b/ssh/remote 沙箱/session-query-sqlite/snapshot |
| Excluded(=Worldview Denylist) | §3.4(goal/plan/workflow/agent-team/api/web/client/host/desktop/settings/插件发现/遥测/commands/llm-deepseek-account+authorization(OAuth)/jobs 抽象保留实现/etc.) |
| Tool allowlist(V1) | File R/W、str-replace 编辑、pwsh/bash(沙箱化)、git(经 shell) |
| Plugin policy | V1 全禁;仅 CompanyOS 打包锁定审计 allowlist 组合行;机械关闭=不挂 plugin-manager+DSH_HOME scratch |
| Model bridge | OPTION B(Pool→pi-ai 路由表生成器→逐请求 provider+model);BYO/API-only |
| Secret boundary | CompanyOS SecretVault 唯一;spawn 时 env 短生命周期注入;内核面无 account/OAuth 包 |
| Approval mapping | CompanyOS=Truth;DSH=enforcement;adapter 注册 `approval/request` answerer 只读桥(§Security §2 表) |
| Sandbox mapping | 外层 S25 预检+内层 read-only/workspace-write;danger-full-access 不被生成器产出 |
| Workspace mapping | 预检证明根→spawn cwd→sandbox-policy workspaceRoot→fs-sandbox→windows-acl(partial) |
| Context mapping | Canonical Work Envelope→persona/system-prompt+任务注入;compaction/spill 内核内部;禁覆盖 canonical |
| Session status | SUBORDINATE_RUNTIME_STATE;V1 per-attempt ephemeral;attemptId≠invocation(null)≠DSH session id |
| Transport | Stage 4 首选 managed child(sdk-jsonrpc-server);research 原型实证 one-shot headless NDJSON(S24 契约面) |
| Startup/Health/Execute/Cancel/Shutdown/Crash | §11/§12(start/ready/health/execute/cancel/shutdown/crash 语义;crash→transport-failed→现有 uncertainty) |
| Error/Result normalization | §9(表;六类 outcome,零新增完成语义) |
| Logging/Usage | 有界诊断(redact 同源)+usage 事件→现有管道;其余=provider-internal noise |
| Distribution | `<install>/resources/agent-kernel/<version>/`+manifest(SHA/tag/node/包面/锁切片/license 全集/SBOM)+首启健康检查 |
| Upgrade gate | 二十项(DISTRIBUTION_SPEC §4);exact pin;禁 auto-update |
| Exit strategy | 删=注销一个 ExecutorProvider+删目录;canonical 零迁移(PASS) |
| **研究原型实证** | fresh clone→install(59.4s)→官方构建(exit 0)→`companyos-minimal` profile 实跑:**final=PONG、exit 0、零告警、SIGINT→typed TRANSPORT 收尾**(DISTRIBUTION_SPEC §2.1) |

---

*本规格由官方 pinned 源推导;任何包面/缝事实变更须回到官方源重证并过升级门。*
