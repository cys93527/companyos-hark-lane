# PROJECT EXECUTION HANDOFF — DeepSeek Harness → Codex

> 本文件是 **CompanyOS 主执行器交接单**。所有 hash / tag / 测试数字均从当前仓库真实读取
> （交接基线：tag commit `2cd0403`；本次 Docs Truth Reconciliation 开始前 HEAD `0fcb5af`）。DeepSeek Harness 到此
> **停止作为主执行器**；下一阶段由 **Codex** 作为主执行器。

---

## 1. Executive Summary

| 项 | 真实值 |
|---|---|
| 项目名称 | **CompanyOS** —— 按行业 SOP 组织多个可替换 AI 模型、Agent 与真实工具，协同完成业务目标的 AI 工作操作系统 |
| 当前目标 | 按 `最终1.1.txt` 规划书顺序交付 Sprint，每个 Sprint 严格 DoD：门禁全绿 → 独立复核 → 修 Blocker/High → 提交 → 打 tag → 更新 `PROJECT_HANDOFF.md` → 停止 |
| 当前阶段 | **Sprint 11（Structured Handoff）已关闭**；下一阶段 = Sprint 12（Memory + Decision，**未开始**） |
| 当前主分支 | `main` |
| Docs Truth Reconciliation 基线 HEAD | **`0fcb5af62ade9918b91a779bd023f202371f0c14`**（比 Sprint tag 多一个纯文档交接提交；reconciliation 提交后的实际 HEAD 以 Git 为准） |
| 当前最新 tag | **`sprint-11.0.0`** → peeled commit `2cd040359ff0a6d7e5498bc62aa12cebec112891`（annotated tag 对象 `bceb102163136d14d6832e5c950ad2bf516c8a45`；不得移动） |
| 当前测试状态 | `pnpm check` **Exit Code 0（5×PASS）**；**95 个测试文件 / 951 个用例全通过**；`pnpm test:scripts` **22/22** |
| 当前工作区状态 | `git status --porcelain` **为空（clean）** |
| 是否允许进入下一 Sprint | **允许进入 Sprint 12**（Sprint 11 已关闭：BLOCKER 0 / HIGH 0，tag 已创建） |

**执行器切换声明**：DeepSeek Harness 不再作为主执行器；本交接单 + 当前仓库即为 Codex 的完整恢复依据。
Codex **不得**假定任何未写入本文件或不在仓库中的状态。

---

## 2. Verified Git Baseline（Docs Truth Reconciliation 前）

```text
branch                : main
baseline HEAD (full)  : 0fcb5af62ade9918b91a779bd023f202371f0c14
git status --porcelain: (empty)
sprint-11.0.0 object  : bceb102163136d14d6832e5c950ad2bf516c8a45
sprint-11.0.0 peeled  : 2cd040359ff0a6d7e5498bc62aa12cebec112891
```

### 最近 12 个 commits（真实）

```text
0fcb5af 2026-09-14 docs(handoff): add DeepSeek Harness to Codex execution handoff
2cd0403 2026-09-14 test(sprint-11): cover the reject target-role branch (wrong role refused, handoff stays READY) and correct the roadmap counts
1dabe1e 2026-09-14 docs(sprint-11): correct the audit whitelist count (12 incl. actorId) and the handoff emitter wiring note
35d46e1 2026-09-14 fix(sprint-11): review closeout - the ACCEPTED-derived previousHandoff now reaches the runtime input, reject requires the target role, handoff.read is enforced, and every client previousHandoff carrier is rejected
359702f 2026-09-14 test(sprint-11): A-O production-wiring behaviour suite (real authz, durable audit, IPC, ACCEPTED-only previousHandoff) plus the two real defects it exposed, and docs go production-complete
29fee4c 2026-09-14 feat(sprint-11): production handoff wiring - Core handoff authorities, composition-root HandoffService with durable audit and authz-derived roles, and handoff IPC with role-claim rejection plus server-derived previousHandoff
3fe5615 2026-09-14 fix(sprint-11): atomic handoff create (row+refs in one transaction) and trusted role derivation for accept/reject (no caller-supplied actorRoleIds)
d70bf42 2026-09-14 fix(sprint-11): review fixes - terminal rows may only be superseded (decision facts frozen), refs deduped on create, audit records actorId, and the unimplemented composition-root/runtime wiring is documented honestly
aea05fd 2026-09-14 docs(sprint-11): add docs/HANDOFF.md, mirror the independent handoff state machine, record the deliverables and freeze the boundary/coding rules
bb6fe77 2026-09-14 test(sprint-11): A-AP handoff suite over real SQLite (lifecycle, versioning, immutability, permissions, durable redacted audit, projection, restart, E2E) plus the terminal-supersede storage rule it exposed
853dd13 2026-09-14 feat(sprint-11 WIP): enable the handoff chain in the composition root and shared fixture, consume an ACCEPTED handoff through a deterministic bounded text projection
4e82dd7 2026-09-14 feat(sprint-11 WIP): durable handoff chain and store (immutable (handoff_id, version), terminal-state guard), DurableDatabase.handoffStore wiring, and the six handoff.* audit event types
97f5337 2026-09-14 feat(sprint-11 WIP): structured handoff contract (packet, independent state machine, refs, safety, deterministic context projection) and the handoff service (authority checks, versioned persistence port, redacted audit) - persistence chain, tests and docs still pending
```

### Router / Handoff 相关 tags（真实）

| tag | commit（`git rev-list -n 1 <tag>`） | 说明 |
|---|---|---|
| `sprint-10a.0.0` | `79a9b92` | Router 契约与规则（不实现执行） |
| `sprint-10a.0.1` | `6b7e3f6` | 10A 收口 |
| `sprint-10a.0.2` | `ead9b1f` | 10A.0.2 |
| `sprint-10a.0.3` | `35ca3e1` | 10A.0.3 |
| `sprint-10a.0.4` | `b4dfd23` | 10A.0.4 |
| `sprint-10a.0.5` | `9b38a67` | 10A 关闭 |
| `sprint-10b.0.0` | `5ad90ca` | Router 实现（deterministic v1） |
| `sprint-10b.1.0` | `45b7bb1` | Router 可达/可审计/可持久化 |
| `sprint-10b.2.0` | `0cee45d` | Router 行为级 E2E + 启动对账；**Router 主线关闭** |
| **`sprint-11.0.0`** | **`2cd0403`** | **Structured Handoff（已创建）** |

> 只列出与最近 Sprint 有关的 tag。annotated tag 自身对象 hash（如 `sprint-11.0.0` = `bceb102`）与
> 其指向的 commit 不同；需要 commit 时用 `git rev-list -n 1 <tag>`。

---

## 3. Current Quality Gate（真实执行结果）

| 命令 | 结果 | 规模 |
|---|---|---|
| `pnpm check` | **Exit Code 0**（lint ✅ / typecheck ✅ / boundaries ✅ / test ✅ / build ✅，5×PASS） | — |
| `pnpm test` | **Exit Code 0** | **95 个测试文件 / 951 个用例全部通过** |
| `pnpm test:scripts` | **Exit Code 0** | **22 个 node --test 用例**（tests 22 / pass 22 / fail 0） |
| `git status --porcelain` | **空** | 工作区干净 |

**测试数量只增不减**（历史：… → 10B.1 92/914 → 10B.2 93/927 → 11 95/951）。

---

## 4. Canonical Architecture Freeze（不得随意修改）

### 4.1 主链路（冻结）

```text
User / Desktop
   ↓
Chief
   ↓
Workflow Lifecycle
   ↓
Orchestrator
   ↓
Workflow Engine  /  Model Router  /  Risk & Approval
   ↓
Agent Runtime
   ↓
Industry Packs  /  Model Pool  /  Tool Pool
```

### 4.2 语义映射（冻结）

| 概念 | 含义 |
|---|---|
| Role | **固定**（岗位） |
| Model | **动态**（可替换劳动力） |
| Agent | 角色 / 岗位 |
| Tool | 生产工具 |
| Workflow | SOP |
| Orchestrator | 管理系统 |
| Memory | 组织记忆 |
| Handoff | 交接协议 |
| Validation | 质量系统 |
| Approval | 权限系统 |
| Industry Pack | 公司模板 |
| User | Boss |

**关键约束**：`Role 固定，Model 动态`。**CTO 只设计/选择，不直接 mutate execution state；只有 Orchestrator 控制 state。**

### 4.3 依赖方向（冻结）

```text
core / contracts / observability  ←  persistence  ←  apps
packs/*  →  core          （Core 永不依赖 Pack）
```

`@companyos/core` 必须保持**零运行时依赖**；持久化端口名**永远叫 `EntityStore`**；
`core`/`contracts` 不得出现行业名词（`Coding`/`Git`/`Repository`/`Developer`/`CTO`/`Article`/`Video`/`Ecommerce`）。

---

## 5. Completed Sprint History

> 只写**真实交付的关键能力**；已关闭的问题不重复解释。

| Sprint | Status | Key deliverables | ADR / 冻结不变量 | tag → commit | Remaining LOW |
|---|---|---|---|---|---|
| **Sprint 0** | CLOSED | pnpm workspace、TS strict ESM、ESLint flat、边界门（词汇法+方向法）、DoD 脚本 | 架构法 / 词汇法（ADR-0002） | `sprint-0.0.1` | — |
| **Sprint 1** | CLOSED | Core Domain（23 概念词表）、`EntityStore` 端口、错误码与 Result 内核、状态机机器实现 | ADR-0002/0003、`docs/STATE_MACHINE.md` 镜像规则 | — | — |
| **Sprint 2** | CLOSED | Workflow Engine（图校验、Stage/Transition 执行语义）、确定性引擎边界 | 引擎边界门（禁 electron/react-dom/better-sqlite3/express/axios/node-fetch/setInterval/setTimeout/Math.random/Date.now） | — | — |
| **Sprint 3** | CLOSED | SQLite durable 层：WAL/foreign_keys/busy_timeout、迁移运行器 + checksum、`UnitOfWork`、Event Store | `schema_migrations` 校验和保护；checksum 不匹配即失败 | — | — |
| **Sprint 4** | CLOSED | Workflow Lifecycle：Template 生命周期、Run/Stage、Change Proposal → Fork → Draft → Publish、Active Lock | **已发布 Template 禁止原地修改**（必须 Fork 新版本） | — | — |
| **Sprint 5** | CLOSED | Workflow Designer 数据模型 + 边界测试（导入共享 chain fixture 的前身） | — | — | — |
| **Sprint 6** | CLOSED | Provider 抽象：绑定、SecretRef（**无值列**）、授权执行点、分类上下文估算、Provider 审计 | **密钥铁律**：Key 不进 Git/Log/Event/Handoff/SQLite 明文；**厂商铁律**：厂商名只能在最外环 | — | — |
| **Sprint 7** | CLOSED | Model Registry（策展层）：`ModelRecord`、能力画像、context window、定价、可用性、健康、启停、元数据持久化 | **Registry ≠ Router**：无 score/rank/priority/fallback | — | — |
| **Sprint 7.1** | CLOSED | Registry Hardening：`ensureBootstrapOwner` 取代"空角色表=放行" | Role → Authority 显式授权，无隐式全权窗口 | — | — |
| **Sprint 7.5** | CLOSED | 开放模型研究 + Model Selection Policy（`SelectionRules` 单决策体、排除码、MANUAL 语义） | Policy 只解释规则，不做执行 | — | — |
| **Sprint 8** | CLOSED | Agent Runtime：AgentContext、确定性 PromptAssembler、AgentExecution 状态机、七类 `agent.*` 审计、崩溃恢复（INTERRUPTED，不 COMPLETED/不重放） | **Runtime 不选模型**：无 `modelKey` → `MODEL_SELECTION_REQUIRED` | — | — |
| **Sprint 9** | CLOSED | Tool Registry：`ToolRecord`/`ToolPort`、风险分级 + 审批、双向 schema 校验、幂等、`tool.*` 五 authority、确定性 MockTool、Runtime 一次受控工具轮 | **Tool Registry ≠ Tool Planner**：`invoke` 必须点名 `toolId` | `sprint-9.0.1` → `92ac972` | — |
| **Sprint 9.1** | CLOSED | 恢复语义、幂等索引化、重放诚实性、列表分页、descriptor 进 PromptPlan、HIGH 自批规则显式化 | — | `sprint-9.1.0` → `60b0c96`；`sprint-9.1.1` → `128c19f` | — |
| **Sprint 9.1.2** | CLOSED | Tool 运行时收口（审计与恢复一致性） | — | `sprint-9.1.2` → `db899dc` | — |
| **Sprint 10A（0.0–0.5）** | CLOSED | Router **只交付 ADR + 契约 + 纯规则**：reason code 目录（38）、14 阶段流水线、Hard Filter/Ranking 结构分离、v1 权重、override/diversity/explainability 契约 | **禁止任何真实选择执行**；被 Hard Filter 淘汰者不得复活 | `sprint-10a.0.0` → `79a9b92` … `sprint-10a.0.5` → `9b38a67` | 见 §8 |
| **Sprint 10B** | CLOSED | `createDeterministicModelRouter()` 实现 `ModelRouterPort.recommend`；`assertRouterRequestAllowed → applyHardFilters → rankCandidates → selectWinner → validateRecommendation → 审计` | v1 权重冻结；MANUAL 永不路由；无候选 → `NO_ELIGIBLE_MODEL` 不猜 | `sprint-10b.0.0` → `5ad90ca` | — |
| **Sprint 10B.1** | CLOSED | Router **可达/可审计/可持久化/可追溯**：`router` 迁移链、六类 `router.*` durable 事件（12 字段白名单）、`router.recommend` / `override.*` IPC、`registryRevisionOf`、真实 provider health、decision 有界持久化（top-20+truncated） | **事务语义非原子**（decision → event），不得声称 ACID | `sprint-10b.1.0` → `45b7bb1` | 见 §8 |
| **Sprint 10B.2** | CLOSED | 行为级 E2E（真实 SQLite 全链）、**启动对账**（`reconcileAndRepairRouterAudit`，幂等，补发打标 `reconciled:true`/`repairReason`）、`totalCandidateCount`/`eligibleCandidateCount` 语义、provider health 5 分钟新鲜度、WORKFLOW scope 可达、IPC 单一 forbidden-key 入口 | **Router 主线关闭** | `sprint-10b.2.0` → `0cee45d` | 5 项 LOW（见 §8） |
| **Sprint 11** | **CLOSED** | 见 §7（结构化 Handoff：契约/状态机/版本化/权限/持久化/durable 审计/生产接线/ACCEPTED-only 投影/两条 E2E） | Handoff 六条边界规则（§7.3） | **`sprint-11.0.0` → `2cd0403`** | 5 项 LOW（§8.2） |

---

## 6. Router Final Frozen State（主线已关闭）

| 语义 | 冻结值 |
|---|---|
| Selection mode | `MANUAL` / `AUTO` / `HYBRID` |
| Precedence | **Explicit User Choice 永远优先**；`MANUAL` → Router **不得覆盖**（`assertRouterRequestAllowed` → `MANUAL_NOT_ROUTED`）；`HYBRID` → Router **只能在 policy 候选范围内**选（不得放宽候选）；`AUTO` → 才可完整自动选择 |
| `blockedModels` | **硬阻断**（显式选择也不能穿过）；`allowedModels` 是"范围"，显式选择可越界但自动选择不可 |
| `fallback` | **永远是契约**：`NEVER` / `ASK` / `AUTO_WITHIN_POLICY`；Router **不执行** fallback |
| Router 职责 | 只 **filter / rank / recommend** |
| Router 禁止 | ✗ 调 Provider ✗ 调 Agent Runtime ✗ 执行 fallback ✗ LLM-as-Router ✗ 多模型投票 ✗ 动态调权/在线学习 |
| 确定性权重（v1，冻结） | 7 个信号，权重 `.25/.20/.15/.15/.10/.05/.10`；`BENCHMARK_WEIGHT_CAP = 0.15` 且**只计一次** |
| 缺失信号 | `SKIP_AND_RENORMALISE`（跳过并按可用权重归一化；`LATENCY_FILTER_MODE = NO_DATA_NO_HARD_FILTER`） |
| 决胜 | 全序 tie-break，最终以 `modelKey` 字典序收尾 |
| 无候选 | `NO_ELIGIBLE_MODEL`（**绝不猜**）；被淘汰者**不得**重回 ranking |
| Durable decision store | `router` 迁移链 `router_decisions`（17 列 + 2 索引）；**主键冲突必须显式失败**（普通 INSERT，不静默 upsert）；有界 top-20 + `truncated` |
| Durable audit | 六类 `router.*` 事件经 `defineEvent` + `events.append`；payload **12 字段白名单**（无 request/prompt/context/secret） |
| IPC | `router.recommend` / `override.request` / `override.confirm`；客户端**只能**给 scope + requirements + mode + trace/actor |
| Registry revision | `registryRevisionOf(records)` 内容绑定（FNV-1a，无时钟） |
| Provider health | 真实观测 + `providerHealthObservedAt`；**5 分钟新鲜度**，过期降级 `unknown`（0.25）；每次推荐前重观测；不得默认 healthy |
| Startup reconciliation | 组合根启动调用 `reconcileAndRepairRouterAudit`；**两种终态事件都算已审计**（`recommendation_created` + `no_candidate`）；幂等补发，补发事件打 `reconciled:true` / `repairReason`（`MISSING_RECOMMENDATION_EVENT` / `MISSING_NO_CANDIDATE_EVENT`） |
| Recommendation vs Execution | **推荐 ≠ 执行**：Router 只产出 Recommendation + 可解释性，执行属 Runtime，且 Runtime 必须拿到明确 `modelKey` |
| 事务语义 | **非原子**（decision 先 → event 后），恢复靠对账；**不得声称 ACID** |

> **Do not reopen Router unless a new Sprint explicitly requires it.**
> （Router 相关冻结项、断言语义、权重、reason code 目录都属于"已验收冻结面"。）

---

## 7. Handoff Sprint 11 Current State（最重要一节）

### 7.1 Status

**CLOSED** —— `sprint-11.0.0` **已创建**，指向 `2cd040359ff0a6d7e5498bc62aa12cebec112891`。
创建条件全部满足：A–O 行为测试全绿 + 完整 DoD 全绿 + 独立复核 BLOCKER 0 / HIGH 0 + 所有必修修复包含在该提交内。
（本 Sprint 过程中曾出现 3 轮独立复核：首轮 FAIL(1 HIGH) → 修 → 次轮 PASS WITH CONDITIONS(1 HIGH) → 修 → 末轮 PASS WITH CONDITIONS(BLOCKER 0/HIGH 0)。）

### 7.2 已完成（真实代码状态）

| 能力 | 位置 / 证据 |
|---|---|
| Core 契约 | `packages/core/src/domain/handoff.ts`（`HandoffPacket` 33 字段、`HandoffRef`、READY 必填 7 项、证据门、`assertHandoffSafety` 拒凭据/超长） |
| 独立生命周期 | 六态 `HANDOFF_TRANSITIONS`；非法迁移 `CONFLICT`；`docs/STATE_MACHINE.md §12` 镜像 |
| Versioning / supersede | `handoffVersion` + `supersedes = "<id>@v<n>"`；终态内容不可改写（服务层 + 存储层条件 UPDATE 双保险）；`ACCEPTED/REJECTED → SUPERSEDED` 是唯一合法终态→终态迁移（只改 status） |
| 权限 | `handoff.create/read/accept/reject` 已在 Core `AUTHORITIES` 闭集；`accept` 与 `reject` 都强制 **target role**；`get/versions/listForTargetRole` 强制 `handoff.read`；角色由 `authz.assignmentsOf` **服务端派生** |
| refs | artifact / decision / validation / execution；只校验格式（不透明 id，禁路径） |
| 有界上下文投影 | `handoffContextViewIfAccepted()`（仅 ACCEPTED）+ `serializeHandoffContextView()`（确定性、固定章节）+ `previousHandoffTextOf()` |
| 持久化 | `handoff` 迁移链：`handoffs`（PK `(handoff_id, version)`）+ `handoff_refs`；`createSqliteHandoffStore`（create/update/get/listVersions/listForTargetRole/listRecent）；`DurableDatabase.handoffStore` 仅链启用时存在 |
| 原子性 | `create` = `db.inTransaction(row + refs)`；非法 ref → 全回滚（0 残留），失败时**不发射** `handoff.created` |
| durable audit | 六事件 `handoff.created/ready/accepted/rejected/superseded/cancelled` 经 `defineEvent` + `events.append`；payload **12 项白名单（含 actorId）** |
| 生产接线 | `apps/desktop/src/main.ts`：`handoffStore === null` → **显式抛错**；装配 `createHandoffService({store, clock, authorize: authz.decide, actorRoleIds: authz.assignmentsOf, audit})` |
| IPC | `handoff.create/ready/accept/reject/cancel/get/listForTargetRole` 接入既有 `WORKFLOW_OPERATIONS`（单一 IPC 通道，未新造框架） |
| 客户端防伪 | `actorRoleIds / roles / roleMemberships / effectiveRoles / permissions / authorities` → `INVALID_ARGUMENT`；`previousHandoff` / `previousHandoffText`（`context.*` 与顶层）→ 拒绝 |
| ACCEPTED-only 真实路径 | `handoffId(+version)` → durable store → `previousHandoffTextOf` → `PrepareExecutionInput.previousHandoff` → **真实合并进 `AgentContext.previousHandoff`**（`agent-runtime.ts`）；其余五态为 `null` |
| restart 语义 | READY / ACCEPTED 跨 close+reopen 保持；不自动 accept、不生成 v2、不生成下一 Handoff、不启动 Agent、不推进 Workflow |
| E2E | ① Developer → Reviewer（含 `previousHandoff`）② reject v1 → supersede v2 → accept v2（v1 历史与内容不变） |
| 文档 | 新增 `docs/HANDOFF.md`（15 节）；更新 `docs/STATE_MACHINE.md §12`、`docs/INDEX.md`、`PROJECT_HANDOFF.md`、`docs/EXECUTION_ROADMAP.md`、`AGENTS.md` |
| 测试 | `tests/sprint11/handoff.test.ts`（16）+ `tests/sprint11/production-wiring.test.ts`（8）= **24 条 Handoff 行为测试** |

### 7.3 Handoff 边界（冻结）

```text
Handoff ≠ Chat History
Handoff ≠ Memory
Handoff ≠ Artifact
Handoff ≠ Workflow Transition
Handoff ≠ Agent Runtime
```

**ACCEPTED Handoff 不会自动**：启动下一个 Agent · 推进 Workflow · 选择 next role · 选择 model · 选择 tool。

### 7.4 尚未完成

**无必修项遗留。** Sprint 11 的 HIGH 与 mandatory MEDIUM 全部在 tag 指向的提交内关闭：

| 曾报问题 | 当前状态 |
|---|---|
| HIGH：派生 `previousHandoff` 写进 Runtime 不读的字段（实际恒为 null） | **已修**（`PrepareExecutionInput`/`RunExecutionInput` 新增字段并合并进 AgentContext；新增行为测试观测 runtime 输入） |
| MEDIUM：`reject` 缺 target-role 校验 | **已修**（服务层强制 + Core 语义对称；新增测试：wrong-role 拒绝且保持 READY） |
| MEDIUM：`handoff.read` 未强制 | **已修**（get/versions/listForTargetRole 全部 `permit`；新增测试） |
| MEDIUM：`create` 非原子 / refs 半提交 | **已修**（单事务；新增回滚测试与"失败无 created 审计"测试） |
| MEDIUM：审计缺 `actorId` | **已修**（白名单 12 项） |
| LOW：文档白名单写成 11 项、`event.ts` 陈旧注释 | **已修**（文档/注释已同步真值） |

### 7.5 最新 Cross-Model Review（末轮，真实）

| 项 | 值 |
|---|---|
| Verdict | `PASS WITH CONDITIONS` |
| BLOCKER | **0** |
| HIGH | **0** |
| MEDIUM | 1（"reject 新分支缺行为测试"）→ **已在 tag 提交中补齐**（`2cd0403`） |
| LOW | 3（Core `rejectHandoffPacket` 缺自身的 `actorRoleIds` 纵深校验；`derivePreviousHandoff` 对 `PERMISSION_DENIED` 静默降级为 `null`；审计与主行非同一事务） |
| ALLOW SPRINT 12 | **YES** |

---

## 8. Remaining Issues

### 8.1 Mandatory fixes

**无。** （Sprint 11 已关闭：BLOCKER 0 / HIGH 0 / mandatory MEDIUM 0。）

### 8.2 LOW backlog（不阻塞；仅在升级为 correctness/permissions/history-integrity 时处理）

| # | Issue | File / module | Why it matters | Suggested exit condition |
|---|---|---|---|---|
| L1 | Core `rejectHandoffPacket` 未像 `acceptHandoffPacket` 那样自带 `actorRoleIds` 校验（服务层已强制） | `packages/core/src/domain/handoff.ts` | 纵深防御不对称 | 任一 Sprint 需改动该校验时补对称 |
| L2 | `derivePreviousHandoff` 在 `handoff.get` 返回 `PERMISSION_DENIED` 时静默降级为 `null` | `apps/desktop/src/workflows.ts` | 不泄露，但无诊断线索 | 记录 warn 日志或返回显式理由（不得泄露内容） |
| L3 | Handoff 审计事件与主行**非同一事务**（event 在主行提交后发射） | `packages/engine/src/handoff/handoff-service.ts` | 崩溃窗口存在（可用对账思路补） | 若引入对账，复用 Router reconciliation 模式 |
| L4 | 数组字段（completedWork/remainingWork/…）无长度上限；`supersede` 忽略非最新版本；`handoff_refs` 的 `execution` 类目无读取 API | Core / Persistence | 边界与便利性 | 与 Artifact/Validator Sprint 一并处理 |
| L5 | Router 10B.2 遗留 5 项 LOW（补发事件 candidateCount 语义与 live 事件可能不同；组合根接线守卫为文本级；对账上限 500 决策；provider health 无独立轮询；UI 闭环未实现） | `apps/desktop/src/main.ts`、`packages/engine/src/router/*` | 不影响正确性 | Desktop UI / 后续 Sprint 处理 |

---

## 9. Runtime Invariants（冻结）

Runtime **不负责**：workflow design · next role selection · router policy · model selection ·
Handoff accept/reject · Workflow advancement。

Runtime **只能消费**已被上游验证过的输入：

- `modelKey` 必须由上游明确给出 → 否则 `MODEL_SELECTION_REQUIRED`；
- Tool 必须点名 `toolId`（Runtime 不选工具）；
- `context` 由调用方给出，且 **不允许**客户端携带 `previousHandoff` / `previousHandoffText`；
- `AgentContext.previousHandoff` **只能**来自 **ACCEPTED durable Handoff 的服务端投影**
  （`handoffId(+version)` → durable store → `handoffContextViewIfAccepted` → `serializeHandoffContextView`）；
- Runtime 不 `new HandoffService`，不 accept/reject/supersede，不推进 Workflow。

---

## 10. Persistence Invariants（冻结）

1. **SQLite 是 authoritative durable state**（WAL + foreign_keys ON + 有界 busy_timeout）；
2. 迁移链 checksum 保护（`schema_migrations`），不匹配即失败；链：`core | engine | lifecycle | provider | registry | selection | agent | tools | router | handoff`；
3. **已发布 workflow immutable**（Change Proposal → Fork → Draft → 测试 → Review → Publish 新版本）；
4. **Router decision 冲突不静默**（普通 INSERT，主键碰撞显式失败）；
5. **Handoff version history 不覆盖**（PK `(handoff_id, version)`；重复版本 → `ALREADY_EXISTS`）；
6. **terminal handoff 业务内容不可原地改写**（`objective/summary/refs/risks/next action`）；
7. **`ACCEPTED/REJECTED → SUPERSEDED` 合法**（唯一终态→终态迁移，只改 status + updated_at）；
8. **`handoff` 行 + refs 原子提交** —— **已完成**（`db.inTransaction`，非法 ref 全回滚）。

---

## 11. Security / Permission Invariants（冻结）

- **client input is untrusted**（Renderer 只提供 scope / requirements / mode / trace / actor）；
- Renderer **不得**传 `RouterPolicyView`（`policyView` 等一律拒绝）；
- Renderer **不得**传 `candidateModels`（以及 `allowedModels`/`blockedModels`/`allowedProviders`/`requiredCapabilities`/`preferredModels`）；
- Renderer **不得**把 `actorRoleIds` / `roles` / `roleMemberships` / `effectiveRoles` / `permissions` / `authorities` 当作可信权限事实（一律 `INVALID_ARGUMENT`）；
- **secret 不进入 audit**（API Key 不进 Git/Log/Event/Handoff/SQLite 明文/Error details；DB 只存 `SecretRef` 指针）；
- **完整 prompt / context 不进入 audit**（只记 ids + 计数 + status + traceId）；
- **critical authority 服务端强制**：`handoff.accept/reject` 必须持 target role；`handoff.read` 真实强制；Router/Registry 等 authority 同样服务端判定。

---

## 12. Engineering Rules（工作纪律，不可谈判）

1. **同一 Workspace 同一时间最多一个 Writer**；
2. **Reviewer 默认只读**（不得"顺手修一下"）；
3. **QA 默认只读**（仅允许临时文件/被 .gitignore 覆盖的产物）；
4. 需要并行写作 → **必须使用独立 Git Worktree**；
5. 出现来源不明的修改 → **立即停止写入**，先 `git status` / `git diff` 列出全部差异并交用户裁决；
6. **禁止**用 `git reset --hard` / `git clean -fd` 掩盖差异（除非明确人工批准）；
7. 一次只做一个 Sprint；Plan → Implement → Test → Independent Review → Commit → Update Handoff；
8. **不得通过 `skip` / `only` / 删除测试 / 放宽断言制造 PASS；测试数量只能增加**；
9. 秘密永不入库、永不进日志、永不进记忆；
10. 文档与代码冲突时**以代码为准**并立即同步文档。

### 12.1 文本文件编码硬规则（已发生 **3 次**损坏）

> **禁止**使用 PowerShell `Set-Content` / `Out-File` / `>` / `>>` 或任何会重写项目文本文件的 shell 写法。

**原因（真实事故）**：曾三次用 `Set-Content` 回写项目文本文件，造成 UTF-8 编码损坏（U+FFFD、注释吞掉代码行、
文件变为非法 UTF-8 无法读取），其中一次需要逐字节修复并补回被合并的代码行。

**项目文本文件只能使用**：
- 安全文件编辑工具（edit/write 类工具）；或
- **明确 UTF-8 byte-safe** 的程序化写法；

并在提交前扫描 `U+FFFD` 与 UTF-8 有效性（含 BOM 检查）。

---

## 13. Important Production Lessons / Known Failure Patterns（真实发生过，供 Codex 避免）

1. **模块实现了 ≠ composition root 已接线** —— Sprint 11 曾出现 `createHandoffService` 存在但组合根未装配，被 HIGH 打回。
2. **function exists ≠ startup path calls it** —— `reconcileRouterAudit` 曾长期没有生产调用方（10B.2 才接线）。
3. **typecheck green ≠ production path verified** —— 派生 `previousHandoff` 曾写进 Runtime 不读的字段，类型全绿但实际恒为 null。
4. **mock emitter test ≠ durable audit wired** —— 审计必须走真实 `defineEvent` + `events.append` 并用真实 SQLite 读回断言。
5. **client-provided role membership ≠ trusted authorization** —— 角色必须由 `authz.assignmentsOf` 服务端派生。
6. **SQLite 多步写入无事务会半提交** —— Handoff 行与 refs 曾可分离，已改为单事务。
7. **text grep is not a substitute for behaviour E2E** —— 源码断言只能作为"不可被静默删除"的补充守卫。
8. **PowerShell `Set-Content` 会破坏编码**（3 次真实事故，见 §12.1）。
9. **docs must not claim production wiring before real wiring exists** —— 曾因"对账文档过度声明"与"未接线却写已接线"各被独立复审判 HIGH。
10. **`INSERT OR IGNORE` 会静默吞掉非法数据** —— Handoff refs 曾用它，导致非法 ref 不报错、数据不完整（行为测试抓到）。
11. **持久层异常会穿透 IPC** —— 重复创建曾抛原始存储错误而非域错误（已翻译为 `ALREADY_EXISTS`/`PERSISTENCE_FAILED`）。
12. **正则替换路径别只写宽松匹配** —— 曾因 `INSERT` 前的 `--` 注释吃掉收尾括号，只有在真实 SQLite 测试中才暴露。
13. **测试装置误用真实 API 会造成"假红"** —— 写行为测试前必须**先读真实 API**（本 Sprint 曾因此浪费一轮）。

---

## 14. Exact Next Action for Codex

**Sprint 11 已正式关闭**（`sprint-11.0.0` 已创建，BLOCKER 0 / HIGH 0 / mandatory MEDIUM 0 / DoD 全绿 / 独立复核通过）。

因此：

```text
START AT: Sprint 12 — Memory + Decision
DO NOT:   reopen Router
DO NOT:   pull forward DevCompany / Artifact Asset System / Validator Framework / Desktop UI
DO NOT:   skip the ADR + contract freeze step
```

**Codex 的第一步（Sprint 12 开工前，必须按序执行）**：

```powershell
git status --porcelain        # 必须为空
git rev-parse HEAD                  # reconciliation 前核验值为 0fcb5af...；提交后以实际输出为准
git merge-base --is-ancestor 0fcb5af62ade9918b91a779bd023f202371f0c14 HEAD # 期望 Exit Code 0
git rev-parse sprint-11.0.0^{}      # 期望 2cd040359ff0a6d7e5498bc62aa12cebec112891
git tag --points-at HEAD            # 期望为空；HEAD 比 Sprint tag 多一个纯文档提交
pnpm install --frozen-lockfile
pnpm check                    # 期望 Exit Code 0（5×PASS）
pnpm test                     # 期望 95 files / 951 tests
pnpm test:scripts             # 期望 22/22
```

然后读：`AGENTS.md` → `PROJECT_HANDOFF.md` → `docs/EXECUTION_ROADMAP.md` → `docs/HANDOFF.md` →
`docs/adr/*`（尤其 0014 Router）→ `docs/STATE_MACHINE.md`。

**Sprint 12 的验收门槛（与既有 Sprint 一致）**：
`BLOCKER = 0` · `HIGH = 0` · mandatory MEDIUM 关闭 · DoD 四项全绿 · 独立复核通过 · tag `sprint-12.0.0`。

---

## 15. Sprint 12 Preview（只预览，不实现）

**Sprint 12 = Memory + Decision**。预计重点（正式范围以 Boss 批准 + ADR 冻结为准）：

- **organizational memory boundaries**：Memory ≠ Chat History ≠ Handoff ≠ Artifact；
- **decision records**：记录"做过哪些关键决定"（`decisionRefs` 的落地形态）；
- **provenance**：每条记忆/决策可溯源（谁、何时、依据哪次执行/验证）；
- **scope**：COMPANY / WORKFLOW / ROLE / TASK 的可见性与作用域阶梯（与 Router/Handoff 的 scope 语义一致）；
- **supersession**：新版本替代旧版本，历史只增不改（复用 Handoff 的"不可原地改写"模式）；
- **stale / conflict handling**：过期与冲突的显式语义（不得静默取其一）；
- **retrieval**：确定性检索（无 LLM 决断、无隐藏排序）；
- **Agent context projection**：有界、确定性的 Memory → AgentContext 投影（对齐 `handoffToAgentContextView` 模式）；
- **persistence**：独立迁移链 `memory`（opt-in），`DurableDatabase.memoryStore`；
- **audit**：脱敏白名单事件；
- **restart**：重启不自动推进任何东西；
- **no hidden chat-history dump**：禁止把聊天记录当"记忆"。

> **Codex 不得在 Sprint 11 收尾前（或未获批准时）提前实现 Sprint 12。**
> 现在 Sprint 11 已收尾，Sprint 12 可按上表推进，但**必须先冻结 ADR + 契约**再实现。

---

## 16. Key Files

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 每轮工作入口契约：架构法、词汇法、优先级阶梯、阶段禁止项、DoD、工作纪律、编码硬规则 |
| `PROJECT_HANDOFF.md` | 当前运行状态真相源：门禁命令与规模、各 Sprint 交付表、Independent Review 记录 |
| `docs/EXECUTION_ROADMAP.md` | Sprint 执行路线真相源（Sprint 10/11 状态与下一步） |
| `docs/PROJECT_CONSTITUTION.md` / `docs/ARCHITECTURE.md` / `docs/CORE_BOUNDARIES.md` | 产品宪法 / 技术架构 / 边界细化 |
| `docs/STATE_MACHINE.md` | 状态机镜像（含 §12 Handoff 独立状态机；与 Core 机器实现必须同改） |
| `docs/adr/0014-model-router-architecture.md` | Router 架构决策 + §28–§30（10B/10B.1/10B.2 增补：可达性、对账、事务语义） |
| `docs/adr/0012-agent-runtime-and-model-binding.md` | Runtime 与模型绑定的冻结边界 |
| `docs/adr/0010-model-registry-and-no-routing.md` | Registry ≠ Router |
| `docs/MODEL_ROUTER.md` | Router 实现规格（含 §21 实现、§23 10B.1、§24 10B.2 可达性与对账） |
| `docs/HANDOFF.md` | **Sprint 11 交接规范**：定义、四条"≠"、Packet、生命周期、版本化、权限、refs、审计、持久化、restart、Runtime 投影、两条 E2E、安全、已知限制 |
| `packages/core/src/domain/handoff.ts` | Handoff 契约 + 独立状态机 + 校验/安全 + 有界确定性投影 |
| `packages/core/src/ports/handoff.ts` | `HandoffStorePort`（create/update/get/listVersions/listForTargetRole/listRecent） |
| `packages/core/src/domain/role-authority.ts` | `AUTHORITIES` 闭集（含 `handoff.create/read/accept/reject`） |
| `packages/engine/src/handoff/handoff-service.ts` | Handoff 服务：授权、状态转移、版本化持久化、脱敏审计、服务端角色派生 |
| `packages/engine/src/router/deterministic-router.ts` | Router 实现 + 启动对账（`reconcileAndRepairRouterAudit`） |
| `packages/persistence/src/durable/sqlite-handoff-store.ts` | Handoff SQLite 适配器（原子 create、终态不可改写） |
| `packages/persistence/migrations/handoff/0001_handoffs.sql` | Handoff 迁移（`handoffs` PK `(handoff_id, version)` + `handoff_refs`） |
| `packages/persistence/src/durable/index.ts` | `DurableDatabase`（含 `handoffStore`、`routerDecisions`、链清单与迁移报告） |
| `apps/desktop/src/main.ts` | **组合根**：迁移链清单、authz、Router 装配与启动对账、Handoff 服务装配（store 缺失即显式失败） |
| `apps/desktop/src/workflows.ts` | Workflow/Application IPC：operations 白名单、forbidden-key 校验、Handoff 七操作、服务端派生 `previousHandoff` |
| `packages/engine/src/runtime/agent-runtime.ts` | Agent Runtime：上下文组装（含服务端 `previousHandoff` 合并）、`MODEL_SELECTION_REQUIRED` |
| `tests/sprint11/handoff.test.ts` | Handoff A–AP 行为测试（真实 SQLite + 真实服务） |
| `tests/sprint11/production-wiring.test.ts` | Handoff 生产接线行为测试 A–O（真实 authz + durable audit + IPC + ACCEPTED-only 派生 + 回滚） |
| `tests/shared/expected-chains.ts` | 迁移链清单**单一真相源**（`EXPECTED_COMPOSITION_CHAINS` 含 `router`、`handoff`；边界测试引用它，禁止复制正则） |

---

## 17. Final Commands for Codex（开场检查清单）

```powershell
git status --porcelain            # 必须为空
git rev-parse HEAD                # 输出当前实际 HEAD（应包含下述 0fcb5af... 基线）
git merge-base --is-ancestor 0fcb5af62ade9918b91a779bd023f202371f0c14 HEAD # Exit Code 0
git rev-parse sprint-11.0.0^{}    # 2cd040359ff0a6d7e5498bc62aa12cebec112891
git tag --points-at HEAD          # 空；sprint-11.0.0 不得移动
pnpm check                        # Exit Code 0（lint/typecheck/boundaries/test/build 5×PASS）
pnpm test                         # 95 files / 951 tests
pnpm test:scripts                 # 22/22
```

随后按序阅读：`AGENTS.md` → `PROJECT_HANDOFF.md` → `docs/EXECUTION_ROADMAP.md` → `docs/HANDOFF.md` →
`docs/STATE_MACHINE.md` → 相关 ADR（0014 Router / 0012 Runtime）→ 再开始 Sprint 12 的 ADR + 契约冻结。

---

## 18. Handoff Certification

```text
DeepSeek Harness Handoff Status: READY

Verified Baseline HEAD   : 0fcb5af62ade9918b91a779bd023f202371f0c14
Latest Valid Tag        : sprint-11.0.0 (annotated bceb102...; peeled -> 2cd040359ff0a6d7e5498bc62aa12cebec112891; DO NOT MOVE)
Next Required Sprint    : Sprint 12 — Memory + Decision
Do Not Start             : Sprint 13+; DevCompany; Artifact Asset System; Validator Framework; Desktop UI
                           (Do Not Reopen: Router 主线已关闭)
Known Mandatory Fixes   : NONE (Sprint 11 CLOSED; BLOCKER 0 / HIGH 0 / mandatory MEDIUM 0)
LOW Backlog             : 5 项（见 §8.2；不阻塞）
Quality Gate            : pnpm check Exit 0 · 95 files / 951 tests · test:scripts 22/22 · worktree clean
Independent Review      : PASS WITH CONDITIONS · BLOCKER 0 · HIGH 0 · ALLOW SPRINT 12: YES
```

**交接声明**：DeepSeek Harness 到此停止作为主执行器。Codex 以本文件 + 当前仓库为准继续开发；
任何与本文件冲突的"记忆"（包括来自 DeepSeek Harness 会话的叙述）**以仓库真实状态与本文件为准**。
