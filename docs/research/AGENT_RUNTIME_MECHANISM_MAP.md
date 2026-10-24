# AGENT RUNTIME MECHANISM MAP — 逐机制吸收裁决(研究冻结稿)

> Companion to `DEFAULT_AGENTIC_KERNEL_SELECTION.md`(同一 Sprint,同一基线 `4bfc9a9`)。
> 纪律:每行给 **机制 → 真实 CompanyOS 缺口 → 既有 owner → 原生重设计裁定 → 验收证明路径**;禁缝合(DSH Session + Codex Task + ZCode Context 拼接 = 违宪)。
> 与 `docs/references/REFERENCE_CAPABILITY_MAP.md`(reference 真相)的关系:本图是**内核选型机制级**展开;已在该图登记的条目此处只引用不重复;本 Sprint 的新源码证据已回写该图(见其 DSH kernel 行)。

## 图例

- **ALREADY_HAVE**:CompanyOS 已有等价物(零新工作)。
- **ADAPT**:吸收机制,在 CompanyOS/内核边界内原生重设计(不复制其 Truth)。
- **COMBINE**:两侧机制并存成纵深(CompanyOS 层+内核层各司其职)。
- **DEFER**:真实但非现在(V1 后)。
- **REJECT**:违反冻结架构/反膨胀,永不进入。

---

## A. DSH(deepseek-harness;Stage 1 已在**官方源** `master@639ed01`=`dsh-v0.2.0-rc.2` 复核全部行——包名不变、位置迁入域目录;初版本机证据行经污染审计后保留为 LOCAL_COMPATIBILITY_SAMPLE)

| # | 机制(证据包/文件) | CompanyOS 缺口 | 既有 owner | 裁定 | 验收证明路径 |
|---|---|---|---|---|---|
| A1 | Provider-neutral LLM seam+adapter 注册+逐请求 provider/model+稳定错误码(`dsh-llm`) | 内核侧模型传输 | CompanyOS Model Pool/`ModelProviderPort`(S7) | **COMBINE**(Pool 拥有选择,内核 seam 拥有传输;adapter 下发路由) | 每 Task 换模型不换 Runtime 的 E2E;错误码→`ExecutorProviderOutcome` 归一化测试 |
| A2 | pi-ai 多 provider/OpenAI 兼容网关/自托管+`apiKeyEnv` 凭证引用(`dsh-llm-pi-ai`) | BYO key 通道 | CompanyOS Model Pool(SecretRef 指针,S25) | **ADAPT**(key 只存 Pool 的指针体系;内核只见引用) | 密钥不进配置/不进上下文的探针;MISSING_CREDENTIAL fail-closed 测试 |
| A3 | Agent loop:turn/step/durable Inbox 投影/abort 共享/并行工具调度(`dsh-agent-loop`) | 内核执行机制 | `ExecutorProvider`(S24)+ExecutionAttempt(S21) | **ADAPT**(loop 完全活在 provider 边界内;attempt/预算/超时归 CompanyOS 编排) | 既有 dsh-headless 契约套件;取消→`cancelled`+terminationProven 归一化 |
| A4 | 工具 typed 定义+allow/deny/ask+per-agent 可见集收窄(`dsh-tools`) | 内核工具面控制 | CompanyOS 工具注册表(S9)+能力策略 | **COMBINE**(CompanyOS Role→工具族声明;内核 enforce 可见集) | per-Task 工具暴露差异的负面测试(未暴露工具不可达) |
| A5 | FS 沙箱三模式+`FS_SANDBOX_DENIED`(`dsh-fs-sandbox`+`dsh-sandbox-policy`,fail-safe 默认 read-only) | 内核文件边界 | S25 预检 cwd/写路径包含(ARCH-034) | **COMBINE**(双层:预检证明的 root+内核会话级拒绝) | workspace 外写拒绝的机械测试(§17 已有同型) |
| A6 | Windows ACL 沙箱(诚实 partial 披露)(`dsh-sandbox-windows-acl`) | Windows 进程写边界 | CompanyOS 禁沙箱声明法则(S25) | **ADAPT**(采纳其诚实 partial 语义;不夸大) | partial enforcement level 透传诊断 |
| A7 | 一次性审批 ask/never+fail-closed+审计(`dsh-user-approval`) | 内核敏感动作门 | CompanyOS approvals 机制(APPROVAL.GRANT) | **COMBINE**(内核 ask 路由到 CompanyOS 审批;未来 adapter 桥) | 无审批→动作拒绝的负面测试 |
| A8 | Compaction 族+spill(超长工具结果→locator+有界预览)(`dsh-compaction-*`/`dsh-spill`) | 长任务上下文管理 | CompanyOS Work Envelope 有界投影(S20/终审) | **ADAPT**(仅内核内部;CompanyOS 上下文真相不变) | 超长工具输出不爆上下文的内核测试 |
| A9 | 会话持久化/投影/查询(`dsh-session*`) | — | CompanyOS Session Kernel(S19,canonical) | **REJECT as Truth / ADAPT as state**:provider_session_id 仅 provenance 列(S24 已冻结);内核会话=subordinate runtime state | 既有 provider_dispatches 语义;session truth 归 S19 的架构守卫 |
| A10 | Subagent 命名 provider/in-process/ACP/SDK/Codex/ClaudeCode(`dsh-subagent`) | 未来委派 | 无(未建) | **DEFER**(父 CompanyOS Task 仍 canonical owner;禁复制其 team DAG) | 未来 sprint 规格+负面守卫(禁第二 Task 系统) |
| A11 | headless one-shot+NDJSON+`--session-id`(`dsh-headless`) | — | CompanyOS `dsh-headless` 适配器(S24 冻结,PONG 3/3 实证) | **ALREADY_HAVE** | 既有 dsh-live/s24 契约套件 |
| A12 | SDK/jsonrpc/ACP 嵌入面(`dsh-sdk-*`/`dsh-acp`) | 更细控制通道(对比 NDJSON) | ExecutorProvider 契约 | **DEFER**(V1 用 headless;SDK 通道待需要更细控制时评估) | 未来 adapter 规格 |
| A13 | `dsh-goal`/`dsh-goal-round-driver`/`dsh-workflow`/`dsh-experimental-agent-team`/web-app/settings 世界观 | **无缺口——CompanyOS 已有更严格的** | Goal/Plan/Workflow/Task(S20-21) | **REJECT**(永不挂载进 kernel profile) | profile 禁挂载清单+守卫 |
| A14 | pwsh/win32 进程族+persistent shell(`dsh-tool-pwsh*`/`dsh-win32-process`) | Windows 原生执行 | Native process provider(S25 前置) | **COMBINE**(Native=确定性操作;内核 shell=开放推理操作,经同一预检) | 既有 native 套件;内核 shell 走同 preflight |
| A15 | LSP 代码智能(`dsh-lsp`/`dsh-lsp-stdio`) | 内核 SE 能力 | 无 | **ADAPT**(内核内;未来 SE Role 的工具族) | SE 任务 E2E(未来) |
| A16 | browser-use/computer-use 实验族 | 桌面/浏览器 | 无 | **DEFER**(FUTURE_DESKTOP_CAPABILITY;以工具能力挂内核) | 未来规格 |

## B. ZCode(官方仓 `zai-org/ZCode` main@`29628c9` = v3.14.3,**Apache-2.0**;Stage 1 修订:初版"专有"结论只对本机桌面分发成立,已作废)

| # | 机制(官方源证据) | 缺口 | 既有 owner | 裁定 | 验收/说明 |
|---|---|---|---|---|---|
| B1 | `ModelSelection{providerId,modelId,reasoningLevel}` 逐执行选择+typed `selectionIssue`+subagent per-invocation override(`packages/shared/src/model-selection.ts`、`packages/provider/src/effective-model-selection.ts`) | 内核侧模型路由 schema | CompanyOS Model Pool | **ADAPT**(schema 形状参考;Pool 仍是唯一选择 owner;只钉 standard-personal provider,禁 account-plan 回退) | 逐 Task 换模型 E2E;选择权漂移负面测试 |
| B2 | 权限规则引擎:`PermissionRuleset`+通配 rule-matching+RiskLevel+CollaborationMode(plan)+alwaysAsk/readOnly 能力组+webfetch 预批准 URL+规则持久化(`apps/zcode-cli/packages/core/src/permission/`、`tool/executor/approval-gate.ts`) | 细粒度 ask/allow 规则表达 | CompanyOS approvals+S25 预检 | **ADAPT**(规则模型参考;执行点仍在 CompanyOS 审批与内核工具门) | 未批准动作拒绝的机械测试 |
| B3 | `TurnMachineImpl` 类型化相位状态机(非法转移=typed recoverable 错)(`core/src/agent/turn-machine.ts`) | loop 相位纪律 | ExecutorProvider 边界 | **ADAPT**(原则级;DSH loop 已选型,此为交叉验证) | 契约套件 |
| B4 | server `entry-stdio`/`entry-http`+`rpc` IPC 框架+`zcode-server-cli` | headless 通道形态 | ExecutorProvider 适配器 | **DEFER**(未来第二 adapter 候选的传输参考) | 未来规格 |
| B5 | 自带 workspace/skills/plugins/**workflow-draft** 世界观(`workflow-draft-path`/AMEND_WORKFLOW 工具) | **无缺口——CompanyOS 已有** | Goal/Plan/Workflow/Task(S20-21) | **REJECT**(与 DSH A13 同律) | 禁挂载/禁映射 |
| B6 | NOTICE 诚实声明:共享 Agent 执行适配器**无默认 OS 沙箱**;工作区身份非系统级隔离 | 诚实边界先例 | CompanyOS 禁沙箱声明法则(S25) | **ALREADY_HAVE(立场一致)** | 文档互引 |
| B7 | `zcode-cua` fail-closed 占位包("every runtime surface reports unavailable and fails closed") | 桌面能力 | 无 | **DEFER**(FUTURE_DESKTOP_CAPABILITY;fail-closed 形态是正面先例) | 未来规格 |

## C. Codex(Apache-2.0;ARCHITECTURE_REFERENCE)

| # | 机制 | 缺口 | 裁定 | 说明 |
|---|---|---|---|---|
| C1 | apply_patch 风格结构化编辑协议 | 内核编辑工具的协议纪律 | **ADAPT**(原则级;dsh 已有 str-replace-editor,可借其补丁语义校验思想) | 未来内核 SE 工具的验收标准参考 |
| C2 | approval×sandbox 双门矩阵 | — | **ALREADY_HAVE**(等价:CompanyOS S25 预检×授权 provenance+内核 A5/A7) | 组合后已覆盖 |
| C3 | turn/item/delta 事件流协议 | 诊断事件纪律 | **ADAPT**(原则级;CompanyOS 侧已有 NDJSON+typed outcome) | `REFERENCE_CAPABILITY_MAP.md` Sprint0 行已登记 |
| C4 | 规划-执行分离(planning turns) | — | **ALREADY_HAVE**(S20 Goal→Plan→pinned version 管线更严格) | 不引入其内部任务系统 |
| C5 | Rust runtime/ChatGPT 账号倾向/IDE 产品体系 | — | **REJECT**(作为默认内核;未来可作为**又一个** ExecutorProvider 适配器服务开放 SE 工作) | 与本选型正交:多 Provider 共存不改变默认内核 |

## D. OpenHands / Aider(次级对照)

| # | 机制 | 裁定 | 说明 |
|---|---|---|---|
| D1 | OpenHands Docker 沙箱运行时 | **DEFER** | 隔离彻底但要求用户机 Docker Desktop——违反"只装 CompanyOS"轻量目标;未来云执行场景再评 |
| D2 | Aider LiteLLM 100+ 模型抽象 | **ADAPT**(原则级) | 证实"通用模型抽象层"为业界共识;CompanyOS Model Pool + dsh-llm 已构成等价双层的薄版 |
| D3 | Aider git-native 纪 edit 格式 | **DEFER** | 交互结对形态与自主任务内核不同构;git 纪律 CompanyOS 已由 repository runtime(S17)拥有 |

---

## 防缝合检查(§24 逐项)

- Task/Workflow/Authority/Artifact/Validation/Session Truth:全部单一 owner(CompanyOS;A9/A13/B2/C4/C5 REJECT 兜底)。
- 内核进入方式:唯一 `ExecutorProvider` 适配器(S24 冻结管线),无第二路径。
- 吸收面:机制级(A1-A8/A14-A15/C1/C3/D2),非世界观级。
- 每个机制行的验收证明路径均可映射到已有或已规格的测试面(契约套件/负面安全测试/架构守卫)。
