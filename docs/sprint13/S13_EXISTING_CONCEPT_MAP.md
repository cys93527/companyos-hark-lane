# S13_EXISTING_CONCEPT_MAP — Artifact / Validation 既有概念全景图

> Sprint 13A（Architecture & Contract Freeze 阶段）第一份交付物。
> 性质：**只读侦察结论**，不含任何冻结决策；冻结决策将在后续 S13 契约文档 + ADR 中给出。
> 基线：branch `main` @ `64b8899`（父基线 tag `sprint-12.0.0` → `396b029`），工作树 clean，Sprint 0–12 CLOSED。
> 侦察方法：对 `packages/*/src`、`packages/persistence/migrations`、`apps/*/src`、`docs/`、
> `.planning/CANONICAL_SPEC.md` 与规划书原文（`最终1.1.txt` §三十一/§三十二/§三十六/§四）执行
> artifact / output / result / validation / validator / schema / handoff / memory / decision /
> workflow / run / revision / version / supersede / attachment / file / content / metadata 全词扫描，
> 并逐文件核读命中点。所有断言带 `文件:行号` 证据。

---

## 0. Executive Summary（一段话结论）

**Artifact 与 Validation 不是新概念，而是两个"契约已冻结、实现从未接线"的休眠领域类型。**
Sprint 1 已在 Core 冻结 `Artifact`（不可变、contentRef + sha256 contentHash 指纹模型）与
`Validation`（证据门 + blocking 质量门）的纯领域契约及 10 条单测；L1 状态机已冻结
`VALIDATING` 态与 `VALIDATION_PASSED/FAILED` 转移；事件目录已预留 `artifact.created`
（发射方 `runtime:S8`，至今零发射）与 `validation.recorded`（发射方 `validators:S13`，即本 Sprint）。
与此同时，系统里已经存在**七类隐式产物载体**（agent/tool 执行的 `artifact_ref` 列、
`resultRef`、`outputDigest`、Handoff refs、Decision `related_artifact_refs`、Memory 内联 content、
Provider `InvocationResult.outputText/structured`），全部是**不透明引用或瞬态值**——
没有任何一张表存储 Artifact 本体，没有任何服务铸造 `artifactId`，质量门从未接进引擎转移。
Sprint 13 的任务因此**不是发明概念，而是给既有概念补上缺失的 SoT/服务/持久化/事件发射，
并把七类散落引用收拢到统一 Artifact 身份之下**。

---

## 1. 权威需求来源（原文摘录）

| 来源 | 内容 | 对 S13 的约束 |
|---|---|---|
| 规划书 §三十一（`最终1.1.txt:1304`） | 「所有阶段都可以产生 Artifact」；DevCompany 例子：Code Diff / Test Result / Build Result / Commit / Architecture Document；ContentCompany 例子：Article / Research Report / Image / Publishing Package；「Core 只认识：Artifact」 | 行业类型属 Pack；Core 只有抽象 Artifact（与词汇法一致） |
| 规划书 §三十二（`最终1.1.txt:1336`） | 「每个 Stage 可以定义 Validator」；DevCompany：UnitTest / Build / Lint / Typecheck / GitDiff；「Core 负责：运行 Validator → 记录 Result → 决定是否允许下一 Stage」 | Validator 按 Stage 定义；质量门语义 = 放行/阻断下一 Stage |
| 规划书 §三十六（`最终1.1.txt:1455`） | Risk 四级：LOW 自动 / MEDIUM 自动+强制 Review / HIGH 执行前审批 / CRITICAL 强制明确确认 | T13.7 需与 Tool Registry 既有 `RISK_POLICY`（S9 已实现四级门）对齐而非重造 |
| 规划书 §四（`最终1.1.txt:423`） | Core 概念词表含 Artifact（概念 11）与 Validation（概念 13） | 已在 `catalog.ts` 23 概念冻结：Artifact→execution、Validation→governance（`catalog.ts:52,54`） |
| 规划书 §二原则 7（援引于 `validation.ts:3`） | 「真实结果优先于 AI 自述」 | `pass` 必须带证据（已实现为证据门） |
| `docs/EXECUTION_ROADMAP.md:660`（Sprint 13） | T13.1 Artifact Lifecycle；T13.2 Validator（每 Stage 可定义）；T13.3 Validation Result；T13.4 Quality Gate；T13.5 DevCompany Validator 登记；T13.6 DevCompany Artifact 登记；T13.7 Risk 四级；T13.8 Core 只认识抽象 | 本 Sprint 的任务清单与验收来源 |
| `docs/MVP_SCOPE.md:32-33` | 概念 #20 Artifact（S13）「阶段产物可追溯、可引用」；#21 Validation（S13）「Validator 运行并记录结果，作为质量门」 | 可追溯 + 可引用 = 身份与引用系统 |

> 注：`.planning/CANONICAL_SPEC.md` 中未检索到 §三十一/§三十二 章节（规划书原文在仓库外，
> 位于本机桌面 `最终1.1.txt`）。若 Boss 要求规划书进入仓库作为长期 SoT，可作为 S13 顺带议题。

---

## 2. 既有 Core 领域契约（Sprint 1 冻结，休眠中）

### 2.1 `Artifact`（`packages/core/src/domain/artifact.ts`，93 行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `ArtifactId`（品牌化，前缀 `artifact_`） | `makeId<'ArtifactId'>('artifact', ids)`（`artifact.ts:66`） |
| `runId` | `WorkflowRunId` | **产出锚点 = Run（不是 Stage/Agent）** |
| `taskId` | `TaskId \| null` | null = 由 Stage 整体产出（`artifact.ts:17-18`） |
| `kind` | `string` | 不透明、**pack 定义**（如 `pack-x:report`）——词汇法的体现 |
| `contentRef` | `string` | 不透明定位符（workspace 路径/blob id/URL），**Core 永不解引用**（`artifact.ts:21-22`） |
| `contentHash` | `string` | 小写 sha256 hex，格式校验 `isContentHash`（`artifact.ts:30`） |
| `sizeBytes` | `number` | 非负整数 |
| `producedBy` | `string` | 产出者标识 |
| `createdAt` | `string` | — |

已冻结的不变量：

- **不可变**：`isArtifactIntact = hash 比对`——"verify 永远是指纹是否仍匹配"（`artifact.ts:78-80`）。
  **没有 artifactVersion、没有 revision、没有 supersede。**
- **Core 永不读内容**：摘要重算是外环职责（persistence/workspace 适配器），
  且结论必须记为一条 `Validation`，绝不采信产出者自述（`artifact.ts:82-88`，评审 LOW-2 记录）。
- 工厂 `createArtifact` 校验：kind/contentRef 非空、hash 为 64 位小写 hex、sizeBytes 非负整数。

### 2.2 `Validation`（`packages/core/src/domain/validation.ts`，148 行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `ValidationId`（`validation_` 前缀） | — |
| `runId` / `stageId` / `taskId` | — | 锚点 = Run + Stage/Task（可空） |
| `validatorId` / `validatorVersion` | `string` | **版本必填**（"证据需要版本"，`validation.ts:69`） |
| `status` | `'pass' \| 'fail' \| 'error' \| 'skipped'` | `VALIDATION_STATUSES`（`validation.ts:19`） |
| `command` | `string \| null` | 可复制的确切命令；非命令型 validator 为 null |
| `exitCode` | `number \| null` | — |
| `blocking` | `boolean`（默认 `true`） | 阻塞型 Validator 把门 Stage 流转（规划书 §三十二） |
| `evidenceRefs` | `readonly string[]` | **必须可寻址**：`artifact:<id>` 或 `command:<name>`（`VALIDATION_EVIDENCE_PATTERN`，`validation.ts:27`） |
| `startedAt` / `finishedAt` | `string` | — |

已冻结的不变量（证据门，`validation.ts:88-115`）：

- `pass` 不得带非零 exitCode；`pass` 必须有 exitCode 0 **或** ≥1 条 evidenceRef（空口 pass 被
  `VALIDATION_FAILED` 拒绝——评审 BLOCKER-2，规划书 §二原则 7 的实现）；
- `fail` 不得带 exitCode 0；
- **质量门**：`qualityGatePassed` = 存在≥1 个 blocking Validation **且** 全部 pass——
  「没有证据 ≠ 通过」（`validation.ts:141-145`）；
- `isBlockingFailure` / `blockingFailures` 辅助已备。

### 2.3 休眠状态的直接证据

`createArtifact` / `createValidation` / `qualityGatePassed` / `blockingFailures` 在
`packages/engine/src`、`packages/persistence/src`、`apps/desktop/src` 中**零调用**
（全仓 grep 证实；唯一使用方是 `packages/core/tests/domain/artifact-validation-approval.test.ts`）。
即：**契约在 Core，消费在测试，生产从未接线**。

---

## 3. 事件目录与 L1 状态机中的预留位

| 预留位 | 证据 | 现状 |
|---|---|---|
| 事件 `artifact.created` | `event.ts:57`；发射方登记 `runtime:S8`（`event.ts:211`） | **从未发射**（Sprint 8 选择了在执行行上记 `artifactRefs` 引用而非铸造 Artifact 记录） |
| 事件 `validation.recorded` | `event.ts:52`；发射方登记 **`validators:S13`**（`event.ts:210`） | 从未发射；**发射方名字就是本 Sprint** |
| L1 态 `VALIDATING` / `FINALIZING` | `run-state.ts:24,26`（17 态之二） | 转移已冻结：`REVIEW_PASSED: REVIEWING→VALIDATING`、`VALIDATION_PASSED: VALIDATING→FINALIZING`、`VALIDATION_FAILED: VALIDATING→REWORK`（`run-state.ts:207-247`，事件 `run.validation_passed/failed` 已在目录 `event.ts:33-34`） |
| L3 语义（STATE_MACHINE.md:359） | `running→succeed` 守卫写明「output validates against declared output contract; artifacts persisted」 | **文档语义超前于实现**：Sprint 2 引擎的 `StageHandler.execute` 只返回 `'succeeded'|'failed'|'blocked'`（`handlers.ts:24,35-39`），无 output 校验、无 artifact 持久化 |
| Sprint 0 core 链注释 | `0001_init.sql:10-15` 列出规划中的 `artifacts`、`validations` 领域表 | 从未建表；core 链只有 `schema_migrations` / `entities`（JSON 文档表）/ `settings` / `events` |

---

## 4. 隐式产物载体盘点（生产中真实存在的七类）

这是「防止重复造模」的核心：以下每一个都在**扮演 Artifact 的某个侧面**，Sprint 13 必须逐一决定
「收拢 / 保留为引用 / 明确边界」。

| # | 载体 | 位置 | 形态 | 与 Artifact 的关系 |
|---|---|---|---|---|
| 1 | **Agent 执行产物引用** | `agent_execution_artifacts` 表（`migrations/agent/0001:44-53`）+ `AgentExecution.artifactRefs: string[]`（`agent-execution.ts:227`，`markCompleted` 写入 `:320-333`） | 不透明 `artifact_ref TEXT` + `label`，`UNIQUE(execution_id, artifact_ref)` | 引用侧表，**无 Artifact 本体**；refId 无格式约束、无指向校验 |
| 2 | **Agent 结果引用** | `AgentExecution.resultRef: string \| null`（`CompleteExecutionInput`，`agent-execution.ts:318-320`） | 单个不透明字符串 | "主产物"概念的最小雏形——一次执行有一个 resultRef + 若干 artifactRefs |
| 3 | **工具调用产物** | `tool_invocation_artifacts` 表（`migrations/tools/0001:70-80`，形态同 #1）+ `ToolInvocation.artifactRefs`（`tool-invocation.ts:153` 附近，`markInvocationCompleted` 写入 `:339-346`） | 不透明 ref + label | 同 #1；且 `outputDigest` 只存输出摘要不存本体 |
| 4 | **工具输出摘要** | `ToolInvocation.outputDigest: string \| null`（`tool-invocation.ts:150`） | digest 字符串 | 内容指纹思想与 `contentHash` 同源，但无内容寻址语义 |
| 5 | **Provider 调用结果** | `InvocationResult { outputText, structured: unknown \| null, toolCalls, usage, finishReason }`（`model-provider.ts:129-137`） | 瞬态内存对象 | **模型输出是最大的未落地产物源**：outputText/structured 目前不持久化为任何可引用实体；`prompt-assembly.ts:19-20` 的 `structuredKeys` 已声明结构化输出契约 |
| 6 | **Handoff 引用** | `HandoffRef { kind: 'artifact'\|'decision'\|'validation'\|'execution', refId }`（`handoff.ts:70-80`；DDL `migrations/handoff/0001:49`） | 不透明 id，正则 `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`，**只校验格式**（`docs/HANDOFF.md` §7：存在性校验留给 Artifact/Decision/Validator 系统即本 Sprint） | 三种 ref 里有两种（artifact/validation）指向本 Sprint 要建的实体——**Handoff 是已就绪的消费方** |
| 7 | **Memory / Decision** | Memory：`content TEXT` 内联（`migrations/memory/0001:5-13`，无 contentRef 列）；`MEMORY_SOURCE_TYPES = ['USER','HANDOFF','DECISION','VALIDATION','WORKFLOW','SYSTEM']`（`memory.ts:10`，**含 VALIDATION、不含 ARTIFACT**）；Decision：`related_artifact_refs_json`（`migrations/memory/0001:24`） | 内联文本 / JSON 引用数组 | Sprint 12 组合根 provenance verifier 对 `VALIDATION` 源显式返回 "Unsupported provenance source type for Sprint 12"（`main.ts` memory verifier 分支）——**预留的 S13 接线点**；Decision 已声明关联 artifact 的意图但无实体可指 |

**判定（隐式 Artifact 问题）**：#1–#4 是"引用但没有被引用物"；#5 是"内容存在但没有身份"；
#6/#7 是"引用方已就绪，等待被引用物"。**全仓不存在任何一张存储 Artifact 本体的表**——
`entities` JSON 文档表（`0001_init.sql:23-33`）理论上可承载，但零写入。

---

## 5. 既有文档级设计（Sprint 0 已写、待兑现）

| 文档 | 已写设计 | 与实现的差距 |
|---|---|---|
| `docs/MEMORY_ARCHITECTURE.md` | **内容寻址不可变内容**：`contentRef = sha256:<hex>`（M6）；`artifacts` 索引表 + 文件仓 `%APPDATA%\CompanyOS\artifacts/`；Memory >8KiB 溢写入 artifact 仓；`artifact` 是五个 Memory scope 之一（canonical 四可写 scope 之一）；孤儿回收/压缩 | 全部未实现：Sprint 12 Memory 选择了 content 内联 TEXT（小内容路径），artifact scope 与溢写规则悬空 |
| `docs/ARCHITECTURE.md` §7.11/§9.4 | 大载荷进 artifact 仓（contentRef），小载荷内联；**Artifact blob 永不进 DB**；备份 = db + artifacts/ 目录拷贝 | 同上 |
| `docs/STATE_MACHINE.md` §10（经 `0001_init.sql:6-16` 与 `MEMORY_ARCHITECTURE.md:11` 引用） | 规划领域表清单含 `artifacts`、`validations`、`workflow_validators`、`workflow_risk_rules` | 零建表 |
| `docs/WORKFLOW_LIFECYCLE.md` / Designer | Stage 定义含 Validator/Risk/Approval 绑定（Designer 的 SET_VALIDATOR/SET_RISK/SET_APPROVAL op，Sprint 5 change-ops） | 模板图里可以声明 validator，但运行时无 Validator 系统消费它 |
| Tool Registry（S9） | `RISK_POLICY` + `decideToolApproval` 四级风险门已实现并有测试 | T13.7 的对齐对象——**不重造，复用语义** |

---

## 6. Sprint 13 的冻结面约束（不可违反的既有边界）

1. **词汇法**：Core 不得出现行业名词（UnitTest/Lint/GitDiff 等只能出现在 Pack 层的 kind/validatorId 值里，不能成为 Core 类型名）。
2. **Core 纯度**：Core 零运行时依赖、无 `node:*`、无 fs——内容存储/摘要重算必须在 persistence/适配器环（`artifact.ts:82-88` 已注明）。
3. **EntityStore 命名法**：端口不得叫 Repository。
4. **迁移链纪律**：既有 11 条链 checksum 冻结；新表走**新链**（第 12 条，参照 handoff/memory 的 opt-in 先例），`tests/shared/expected-chains.ts` 同步（这正是上一轮 reconciliation 修好的守卫）。
5. **事件纪律**：`artifact.created`/`validation.recorded`/`run.validation_*` 已在目录与 `CORE_EVENT_EMITTERS` 登记，发射即走 `defineEvent` + durable 落库 + 白名单 payload（无内容正文）。
6. **审计与密钥**：artifact 内容不进事件；`contentRef` 不得携带密钥形态。
7. **单一 SoT**：Artifact 的权威状态只能有一个（SQLite），七类载体必须收敛为"引用方"而非"第二真相源"。
8. **L1 机器**：`VALIDATING` 的进出转移已冻结（`REVIEW_PASSED` 进、`VALIDATION_PASSED/FAILED` 出），质量门接线不得发明新状态。
9. **Memory/Decision/Handoff 已关闭语义**：S13 不得重开其冻结面；Memory provenance 的 `VALIDATION` 源接线属于既有闭集内的兑现，不是词表变更。

---

## 7. 缺口清单（S13 契约冻结必须回答的实现面）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | 无 `artifacts` / `validations` 持久化（表、store、迁移链） | §4 判定 |
| G2 | 无 ArtifactService / ValidationService（引擎服务层零实现） | §2.3 零调用 |
| G3 | 无内容存储适配器（写内容→得 contentRef+hash；读回校验） | MEMORY_ARCHITECTURE 设计未兑现 |
| G4 | 无 Validator 注册/解析（模板声明的 validator 如何映射到可运行实体） | §5 Designer 行 |
| G5 | 质量门未接引擎转移（`VALIDATION_PASSED/FAILED` 事件无生产发射路径） | §3 |
| G6 | `artifact.created` 从未发射；Agent/Tool 的 artifact_ref 无指向校验（悬空引用可能） | §4 #1/#3 |
| G7 | Memory provenance `VALIDATION` 源在组合根 verifier 中 Unsupported | §4 #7 |
| G8 | 无 `artifact.*` / `validation.*` authorities（AUTHORITIES 闭集需评估是否扩展） | `role-authority.ts` 闭集现状 |
| G9 | Provider `InvocationResult.outputText/structured` 无落地路径（谁把它变成 Artifact） | §4 #5 |
| G10 | Risk 四级（T13.7）与 Tool `RISK_POLICY` 的语义对齐声明 | §5 末行 |

---

## 8. 冻结预备分析（DRAFT — 仅为后续契约文档提供证据底稿，**不是冻结决策**）

针对开工指令中的边界问题，证据倾向如下（最终以 Boss 批准的契约为准）：

- **3.1 身份**：`ArtifactId`（品牌化、`artifact_` 前缀）+ `runId/taskId` 锚点 + `createdAt/producedBy`
  已在 Sprint 1 冻结；**没有 artifactVersion/revision 字段**。最小模型已存在，S13 大概率只需
  决定"是否补 `companyId`（Memory/Decision/Handoff 均有 company 维度而 Artifact 没有）"这一处。
- **3.2 不可变性**：现状契约是**方案 A（单记录不可变 + 内容指纹校验）**，且与
  contentHash/MEMORY_ARCHITECTURE M6（内容寻址）/已发布模板不可变/L1 事件 append-only
  完全同构；方案 B（mutable+revision）与 `revision` 乐观并发语义冲突于"产物是证据"的定位；
  方案 C（logical + immutable versions）在"产物=一次性交付物"场景下引入无人消费的版本链。
  倾向 A，但**这是 Boss 裁定项**，契约文档中必须三案对比后落锤。
- **3.3 类型集**：`kind` 是 pack 定义的不透明字符串（词汇法），S13 不需要也不应该在 Core 建
  类型枚举；最小支撑 = contentRef 约定（workspace 路径 / 内容寻址 `sha256:<hex>`）+ inline 与
  file-ref 两档（MEMORY_ARCHITECTURE 的 8KiB 阈值先例）。image/video/blob 属 Pack 层 kind 值。
- **4 归属**：既有契约锚点是 **Workflow Run**（`runId` 必填、`taskId` 可空）——primary owner
  已在 Sprint 1 冻结；Agent 执行/Tool 调用/Handoff/Memory/Decision 均通过 ref 表达关系
  （§4 七类载体即证据）。待裁定项：Project/Organization 维度是否经 ref 而非 ownership。
- **5 持久化**：既有同构先例 = handoff 链（版本化主键）与 memory 链（scope 索引 + JSON refs）；
  内容本体按 ARCHITECTURE §9.4 **永不进 DB**，DB 存索引行 + contentRef + hash。
  具体主键/唯一约束/外键/删除策略待 Boss 指令的剩余部分（本指令在 §5 处截断）后一并冻结。

---

## 9. 证据索引（文件:行号 快查）

```text
packages/core/src/domain/artifact.ts            全文（93 行；契约+不变量）
packages/core/src/domain/validation.ts          全文（148 行；证据门+质量门）
packages/core/src/domain/agent-execution.ts     :227 :280 :318-333（artifactRefs / resultRef）
packages/core/src/domain/agent-context.ts       :23 :26-31 :55-56（ContextReference 上限 200）
packages/core/src/domain/tool-invocation.ts     :150 :153 :339-346（outputDigest / artifactRefs）
packages/core/src/domain/handoff.ts             :70-80 :125-127（HandoffRef 三类 refs）
packages/core/src/domain/memory.ts              :4 :10-11 :19 :51（SOURCE_TYPES 含 VALIDATION 无 ARTIFACT）
packages/core/src/domain/event.ts               :29-34 :52 :57 :166 :210-211（目录+发射方预留）
packages/core/src/domain/run-state.ts           :24 :26 :205-247（VALIDATING 进出转移）
packages/core/src/domain/catalog.ts             :52 :54（23 概念含 Artifact/Validation）
packages/core/src/ports/model-provider.ts       :129-137（InvocationResult.outputText/structured）
packages/engine/src/handlers.ts                 :24 :35-39（StageHandler 仅返回 outcome）
packages/persistence/migrations/0001_init.sql   :6-16 :23-33（规划表清单 / entities 文档表）
packages/persistence/migrations/agent/0001_agent_runtime.sql      :44-53
packages/persistence/migrations/tools/0001_tool_registry.sql      :70-80
packages/persistence/migrations/handoff/0001_handoffs.sql         :45-49
packages/persistence/migrations/memory/0001_memory.sql            :1-40
docs/MEMORY_ARCHITECTURE.md                     :11 :26 :34 :38-41（内容寻址/8KiB/artifact scope）
docs/ARCHITECTURE.md                            :186 :283（contentRef 溢写、blob 不进 DB）
docs/STATE_MACHINE.md                           :205 :254-255 :359（VALIDATING 语义 / run succeed 守卫）
docs/MVP_SCOPE.md                               :32-33（#20 #21 S13）
docs/EXECUTION_ROADMAP.md                       :660-690（Sprint 13 T13.1–T13.8）
apps/desktop/src/main.ts                        memory provenance verifier（VALIDATION → Unsupported for Sprint 12）
最终1.1.txt（仓库外，桌面）                     :1304 §三十一 ：1336 §三十二 ：1455 §三十六 ：423 §四
```

*本文件为侦察结论，下一步：依据 Boss 的 S13 契约冻结指令剩余部分，产出 Artifact/Validation
契约文档 + ADR（含 §8 各裁定项的三案对比与落锤），再经独立评审后方可进入实现。*
