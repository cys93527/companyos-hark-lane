# CompanyOS Zcode Takeover Audit

> 接管者：Zcode（GLM）｜接管日期：2026-09-18｜性质：只读接管审计 + 基线验证。
> 本文件为**新增**审计报告，不覆盖、不替代 `PROJECT_HANDOFF.md`（当前状态真相源）与
> `AGENTS.md`（每轮工作入口契约）。若本文件与代码 / Git / 测试结果冲突，以仓库真实状态为准。
> 本轮未修改任何产品代码、未运行任何 migration、未执行任何 Git 写操作；唯一写入为本审计文档自身（新增文件）。

---

## Repository Identity

| 项 | 值（本轮实测） |
|---|---|
| Path | `E:\DeepSeek.gzq\companyos` |
| Branch | `main`（唯一分支，无其他本地/远程分支） |
| HEAD | `396b0290e5e82a129a88a402afb8a291508d83f8`（docs: avoid stale closeout hash） |
| Latest Tag | `sprint-12.0.0`（`git describe --tags` = sprint-12.0.0；HEAD 恰指向该 tag） |
| Working Tree | 接管核验时点 clean（`git status --short` 0 条；门禁跑完后复验仍为 0 条）；写入本审计文件后，工作树仅含预期中的未跟踪 `ZCODE_TAKEOVER_AUDIT.md` 变更 |
| Remote | **无**（纯本地仓库，无 origin——见 Risks） |
| Git 身份 | 仓库级 `CompanyOS Agent <agent@companyos.local>`（未动全局配置） |
| 总提交数 | 94（2026-09-13 至 2026-09-14，Sprint 0 → 12 连续历史） |
| 环境 | Windows ｜ Node v24.19.0 ｜ pnpm 11.25.0 ｜ TypeScript 5.9.x ｜ Vitest 3.2.7 |

## Baseline Verification

命令与结果（全部本轮真实执行，非转抄）：

| Command | Exit Code | 结果 |
|---|---|---|
| `pnpm check`（总门禁：lint → typecheck → boundaries → test → build） | **0** | **5× PASS**：lint 4.4s ｜ typecheck 4.0s ｜ boundaries 0.1s ｜ test 10.7s ｜ build 5.2s |
| `pnpm test`（含于 check） | 0 | **97 个测试文件 / 972 个用例全部通过**（0 失败 0 跳过） |
| `pnpm test:scripts` | 0 | **23/23** node --test 通过 |
| Lint | PASS | ESLint 9 flat config，0 error |
| Typecheck | PASS | strict + noUncheckedIndexedAccess + verbatimModuleSyntax |
| Build | PASS | tsc -b（5 个 lib）+ vite build（renderer，33 modules）+ tsc（desktop） |
| `git status --short`（测试后） | — | 空（测试只写临时目录，不污染仓库） |

与 `PROJECT_HANDOFF.md`「Verified Commands」段记录**逐项一致**（97/972、23/23、5×PASS）。
**结论：Sprint 12 基线 PASS，无 pre-existing failure。**

## Current Architecture

实际交付架构（以代码为准，非 `docs/ARCHITECTURE.md` 的目标图）：

```text
apps/renderer（React 19 + Vite，不可信 UI，纯投影）
   │  window.companyos.workflowRequest()（preload 静态桥，contextIsolation）
   ▼
apps/desktop 主进程（Electron，组合根，唯一可信入口）
   ├─ main.ts        单 durable 句柄（11 条迁移链）+ 全部服务装配 + 启动对账
   ├─ workflows.ts   应用层：parseWorkflowRequest（schema 校验）→ operation 白名单分发
   ├─ channels.ts    静态 IPC 通道（shell 3 条 + feature 1 条 companyos:workflow）
   └─ security.ts    CSP / 导航守卫
   ▼
packages/engine（服务层：workflow engine、lifecycle、registry、router、
   runtime（agent）、tools、handoff、memory、decision、authorization）
   ▼
packages/core（纯领域：domain/* 33 个文件 + ports/* 18 个端口；零运行时依赖）
packages/persistence（node:sqlite 适配 + 11 条校验和迁移链 + UnitOfWork）
packages/contracts（zod 契约）｜ packages/observability（JSONL 日志脱敏）
```

分层状态机（ADR-0003，禁止混用）：L1 全局执行态 17 个（`domain/run-state.ts`）·
L2 模板生命周期 4 个（`lifecycle/machine.ts`）· L3 Task/Stage 局部态 ·
另有三套**独立**状态机：AgentExecution 8 态、ToolInvocation、Handoff 6 态、Memory/Decision 生命周期。

迁移链（`packages/persistence/migrations/`，checksum 保护，共 11 条）：
`core(0001_init.sql) · engine · lifecycle · provider · registry · selection · agent · tools · router · handoff · memory`。

## Current Source of Truth

| 问题 | 答案（证据） |
|---|---|
| 权威状态是谁 | **SQLite 文件**（`userData/data/companyos.sqlite`，WAL + foreign_keys ON + busy_timeout），且**只有主进程**经 persistence 包持有唯一连接（`main.ts` 单次 `openDurableDatabase`，测试断言仅出现 1 次） |
| 事务 | `UnitOfWork`：`BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`，单连接 **FIFO 串行化**，嵌套调用经 `AsyncLocalStorage` 加入外层事务（`persistence/src/durable/unit-of-work.ts`） |
| revision | 乐观并发：引擎写 run 时带 `expectedRevision`（`engine/src/engine.ts`，冲突即拒） |
| commandId | 幂等账本：`command_ledger` 落库，重放返回记录结果不再执行；`trim` 按 rowid；跨重启幂等（Sprint 3 测试） |
| history 持久化 | append-only 事件表（`global_position` 全序 + `readByRun`）；Handoff 以 `(handoff_id, version)` 版本化追加；Memory/Decision 同为版本化 + supersede，终态内容不可改写 |
| Undo / Redo | **无通用 undo/redo**。设计上以「版本化 + supersession + 幂等 + 事件账本」替代回滚；Run 级有 Pause/Resume/Recover 语义（`RESUME`/`RECOVERED` 返回记录点 `resumePoint`） |
| 重启恢复 | Run：resumePoint + 跨重启幂等（Sprint 3）；Agent/Tool：`INTERRUPTED` + 显式 recover API（绝不自动 COMPLETED / 不重放）；Router：启动对账 `reconcileAndRepairRouterAudit`（`main.ts:356` 已接线，幂等补发打标）；Handoff/Memory：READY/ACCEPTED 状态跨重启保持，不自动推进 |
| 内存缓存 | 引擎缓存**只在 COMMIT 之后**更新（Sprint 3 评审修复），回滚不留悬空缓存 |

## Trust Boundaries

不可信 → 可信的验证链（每层验证点均已核实存在）：

```text
Renderer（不可信：sandbox、无 node、无磁盘、模型可影响的内容在这里渲染）
  → preload 静态桥（contextBridge，固定通道白名单，无动态 IPC）
  → IPC 单一 feature 通道 companyos:workflow
  → parseWorkflowRequest：schema 校验，未知字段/类型即 INVALID_ARGUMENT（进任何业务代码之前）
  → 客户端身份覆盖：服务端用会话身份覆盖渲染层自述 actorId
  → 客户端禁止字段：actorRoleIds/roles/policyView/candidateModels/allowedModels/
    previousHandoff 载体等一律 INVALID_ARGUMENT（服务端派生）
  → authorize（Role→Authority 闭集，authz.assignmentsOf 服务端派生角色；bootstrap owner 仅一次）
  → engine 服务（业务规则与风险门所在，UI 无法绕过——有测试）
  → UnitOfWork → SQLite（仅主进程可达）
```

密钥边界：DB 只存 `SecretRef` 指针（`secret_refs` **无值列**，有逐列断言）；值只在内存 vault；
适配器只能拿到 authority-checked 的 `SecretAccessView`；全部出口脱敏；结果含密钥即拒绝返回。
厂商边界：Core/Engine/Persistence/Apps 源码零厂商名（边界测试扫描）；真实 Provider 适配器尚不存在（仅 MockProvider）。

## Core Business Logic Locations

| 层 | 位置 | 内容 |
|---|---|---|
| **领域规则（真正的业务规则）** | `packages/core/src/domain/*`（33 文件，纯函数 + 冻结词表） | 状态机转移表、审批授权与不得自批、验证证据门（`pass` 必须有证据、空质量门不通过）、返工预算、选择策略优先级阶梯、Router 硬过滤/排名契约、Handoff/Memory/Decision 生命周期与 provenance 规则、schema 校验器 |
| 编排服务 | `packages/engine/src/*` | engine.ts（Command→Engine→Event）、lifecycle-service、model-registry + selection-policy、deterministic-router、agent-runtime、tool-registry、handoff/memory/decision-service、authorization |
| 应用层（只做校验与分发） | `apps/desktop/src/workflows.ts` | 单入口 `handle(raw)` → parse → 20+ operation 分发；**无业务规则** |
| UI 投影（只读投影） | `apps/renderer/src/designer-model.ts` 等 | 纯投影函数，无第二真相源（有测试） |
| 持久化 | `packages/persistence/src/durable/*` | SQL 适配 + 不可变守卫（如 handoff 终态条件 UPDATE）；**无业务决策** |

历史教训（`PROJECT_EXECUTION_HANDOFF_TO_CODEX.md` §13）已内化为边界测试：模块实现 ≠ 组合根接线，typecheck 绿 ≠ 生产路径验证。

## Completed Capabilities Through Sprint 12

94 个连续 commit、20+ tag、97 文件 / 972 用例。逐 Sprint（全部 CLOSED，证据为 tag + 测试）：

- **Sprint 0**（`sprint-0.0.1`）：monorepo、Electron 加固壳、React 19 渲染层、SQLite+迁移、结构化日志、CI、AGENTS/HANDOFF。
- **Sprint 1**（`sprint-1.0.0`）：Core Domain——23 概念冻结词表、品牌化 ID、Result/DomainError、11 端口冻结、ADR-0002/0003/0004。
- **Sprint 2**（`sprint-2.0.0`）：确定性 Workflow Engine——Command→Engine→Event、Retry/Pause/Resume/Approval/Rework/Branch、幂等账本、revision、同 Run FIFO。
- **Sprint 3**（`sprint-3.0.0`）：durable 持久化——UnitOfWork、SQLite stores、事件全序、跨重启幂等。
- **Sprint 4**（`sprint-4.0.0`）：Workflow Lifecycle 治理——模板版本、锁、提案、Run 快照、已发布不可变。
- **Sprint 5**（`sprint-5.0.0`）：Workflow Designer——9 个 change-op、10 类图校验、单一 IPC 契约、UI 投影。
- **Sprint 6**（`sprint-6.0.0`）：Provider 抽象——端口、归一化错误、SecretRef 无值列、MockProvider、16 Authority 闭集。
- **Sprint 7/7.1/7.5**（`sprint-7.x`）：Model Registry + 加固 + Selection Policy——bootstrap owner、SecretAccessView、四类失败审计、CJK 上下文估算、MANUAL/AUTO/HYBRID 与冻结优先级阶梯（Registry ≠ Router）。
- **Sprint 8**（`sprint-8.0.0`）：Agent Runtime——8 态执行机、确定性 Prompt（FNV-1a hash）、Runtime 不选模型（`MODEL_SELECTION_REQUIRED`）、INTERRUPTED 崩溃恢复。
- **Sprint 9/9.1/9.1.2**（`sprint-9.x`）：Tool Registry + 加固——风险四级门、双向 schema 校验、幂等（claim 并发恰一次）、重试链 attempt 化、descriptor 进 PromptPlan。
- **Sprint 10A.0.0–0.5**：Router 只设计——ADR-0014、38 ReasonCode、契约与纯规则（多次 Cross-Model 评审打磨 digest/防篡改/事实拆分）。
- **Sprint 10B/10B.1/10B.2**（`sprint-10b.2.0`，主线 CLOSED）：确定性 Router v1 实现——可达、durable 审计（12 字段白名单）、IPC、注册表 revision、启动对账。
- **Sprint 11**（`sprint-11.0.0`，主线 CLOSED）：Structured Handoff——33 字段 Packet、六态机、版本化 supersede、目标角色强制、生产接线、ACCEPTED-only `previousHandoff` 投影。
- **Sprint 12**（`sprint-12.0.0`，CLOSED）：组织记忆 + 决策——Company/Workflow/Role/Task 作用域、版本化与过期、provenance（USER→ASSERTED，组合根 durable verifier 才产 VERIFIED）、冲突表面化、有界投影进 AgentContext、`memory`/`decision` IPC、独立 `memory` 迁移链。

**当前系统真实能力边界**：全部执行者仍是确定性 stub（MockProvider/MockTool）；无真实厂商 API、无 Desktop 运行闭环 UI（仅 Designer/Registry 两屏）、无 Artifact 资产系统、无 Validator Framework、无 DevCompany Pack。这是一台**测试覆盖完整、语义冻结严格的地基与引擎**，尚未接入真实生产负载。

## Current Stable Modules（冻结面，勿动）

- Router 全部冻结语义（v1 权重、hard filter、reason code、fallback 契约、对账）——「Do not reopen」。
- Handoff 六条边界规则与生产接线语义。
- Core 23 概念词表 + 禁词法 + 依赖方向（自动化门禁强制）。
- 既有 10 条迁移链 checksum（`memory` 为第 11 条，Sprint 12 新增）。
- 状态三层（L1/L2/L3）与五套独立状态机语义。
- 密钥铁律 / 厂商铁律 / 单一 Writer 治理（ADR-0004）。
- Runtime 不选模型、Tool 必须点名、Registry 不是 Router 等结构性禁令（各有边界测试）。

## Known Issues

无 BLOCKER / HIGH / mandatory MEDIUM（Sprint 11、12 独立评审均确认）。当前有效 LOW backlog
（`PROJECT_HANDOFF.md` 指定以 `PROJECT_EXECUTION_HANDOFF_TO_CODEX.md` §8.2 为准，仍有效）：

1. **L1** Core `rejectHandoffPacket` 缺自身 `actorRoleIds` 纵深校验（服务层已强制）。
2. **L2** `derivePreviousHandoff` 对 `PERMISSION_DENIED` 静默降级为 null（不泄露但无诊断）。
3. **L3** Handoff 审计事件与主行非同一事务（崩溃窗口，可复用 Router 对账思路）。
4. **L4** Handoff 数组字段无长度上限；supersede 忽略非最新版本；`execution` refs 无读取 API。
5. **L5** Router 10B.2 遗留 5 项 LOW（补发事件计数语义、组合根接线守卫为文本级、对账上限 500、health 无轮询、UI 闭环未实现）。

另：Electron 运行时二进制因当时网络原因未下载（`allowBuilds.electron=false`），`pnpm dev` 无法开窗，桌面壳无真实窗口冒烟（类型/构建/门禁不受影响；恢复方式 `pnpm approve-builds`）。

## Technical Debt

1. **链清单 fixture 过期**：`tests/shared/expected-chains.ts` 声明 10 条链，组合根实际 11 条（`main.ts:71` 含 `memory`）。三条边界测试（sprint5/8/9）的 `expectedChainsRegex()` 现在匹配的是 `main.ts:65-66` 特意保留的**注释**（注释自述 "Existing boundary checks retain the frozen pre-Sprint-12 chain contract"），对真实代码的链增删已**失去检测力**。fixture 自我声明的「迁移链清单单一真相源」已被打破。
2. **状态文档落后一个 Sprint 且被测试锁定**：见 Documentation Drift #1/#2。
3. **覆盖率未进门禁**：`vitest.config.ts` 配置了阈值（70/70/70/60），但 `scripts/check.mjs` 的 test 步骤是纯 `vitest run`（无 `--coverage`）；`PROJECT_HANDOFF.md` 历史 Open Risks 中「Sprint 3 起把 --coverage 纳入门禁」的承诺与现状不符。
4. **纯本地仓库**：无 git remote，无异地备份；94 个 commit 的历史只存在于这一块盘上。
5. 审计事件多为「主行提交后发射」（Router 声明为非原子 + 对账；Handoff/Memory 同模式）——已知且有补偿设计，但属结构性欠账。
6. Sprint 12 未给组合根 memory/decision 接线增加行为级守卫测试（`tests/sprint12/` 无 main.ts 断言）；现有兜底是 `main.ts:441` 运行时显式抛错。

## Documentation Drift

以「代码 / Git / 测试 > PROJECT_HANDOFF.md > 其他文档」裁定，逐条实测：

| # | 文档 | 漂移内容 | 裁定 | 级别 |
|---|---|---|---|---|
| 1 | `AGENTS.md` §3 | 写「当前 active sprint 是 Sprint 12，允许在正式开发指令后进入」；实际 Sprint 12 已 CLOSED（tag `sprint-12.0.0` 在 HEAD）。`git log` 显示 AGENTS.md 最后更新于 `3214e16`（Sprint 12 开工前），收口提交只改了 PROJECT_HANDOFF.md | PROJECT_HANDOFF 胜：Sprint 12 CLOSED。AGENTS.md 落后一步 | **Medium** |
| 2 | `docs/EXECUTION_ROADMAP.md` 交付状态说明表 | 同上：写「已关闭 Sprint 0–11 / active Sprint 12」 | 同上 | **Medium** |
| 3 | `scripts/tests/docs-consistency.test.mjs:17` | 断言 AGENTS.md 必须包含「active sprint 是 Sprint 12」——**用测试锁定了过时措辞**（Sprint 12 期间 `e1f53d8` 加入，未随收口更新） | 守卫与真相源互相锁错；下次状态推进时必须同改 | **Medium** |
| 4 | `tests/shared/expected-chains.ts` | 10 链 vs 实际 11 链（见 Technical Debt #1） | 代码胜；fixture 需补 `memory` | **Medium** |
| 5 | `README.md` | 仍写「本仓库当前处于 Sprint 0：Foundation」 | 历史性陈旧（快速开始命令仍有效）；低危 | Low |
| 6 | `docs/ARCHITECTURE.md` §4/§8 | 目标包图命名（platform/ipc/pack-sdk）与实际（observability/无 ipc 包）不一致（文内已自注 Status note + FR-17）；§8 写 pnpm 9.x（实际 11.25.0） | 自declare 为目标图，属已记录偏差 | Low |
| 7 | `PROJECT_EXECUTION_HANDOFF_TO_CODEX.md` §1 | 「下一阶段 = Sprint 12（未开始）」快照（写于 Sprint 11 收尾） | 文件自我声明为时点快照；其 §8.2 LOW backlog 与 §12 纪律**仍被 PROJECT_HANDOFF 指定为现行有效** | 信息性 |
| 8 | `PROJECT_HANDOFF.md` 内部 | 大量 Sprint 0–11 历史段落（Open Risks / Known Limitations 自注「历史时点」）；「记录值」哈希字段受 `docs/tests/handoff.test.ts` 强制为真实 40 位哈希（当前通过） | 历史与现况分区清晰，符合其自我定位 | 无（设计如此） |
| 9 | `docs/HANDOFF.md` §8 | 「`handoff.superseded` 尚无 IPC 操作触发」 | **实测仍准确**（workflows.ts 仅 7 个 handoff 操作，无 supersede） | 无漂移 |
| 10 | 覆盖率承诺 | 见 Technical Debt #3 | 代码胜 | Low |

结论：**存在漂移（YES）**，但全部为「收口时只更新了单一真相源、未回写入口文档/守卫」这一种模式；没有任何一条漂移影响代码行为或测试结果，门禁全绿与漂移并存本身就是证据。

## Open Work

- **无强制遗留修复**（Sprint 11/12 均 BLOCKER 0 / HIGH 0 / mandatory MEDIUM 0）。
- LOW backlog 见上（5 组，均不阻塞）。
- 路线图原定下一步：**Sprint 13 — Artifact + Validation**（`docs/EXECUTION_ROADMAP.md:660`，
  P1，依赖 sprint-12；Artifact Lifecycle / Validator / Quality Gate / Risk 四级落地 / DevCompany
  Validator 与 Artifact 登记）。**但所有治理文档一致要求：Sprint 13+ 禁止提前进入，
  须用户正式批准 + 先冻结 ADR/契约再实现。**
- 其余被禁止提前拉起的：DevCompany、Desktop UI、真实 Provider 调用、自动编排。

## Risks

- **Critical**：无（基线全绿、无必修项、数据一致性有事务+幂等+对账三层防护）。
- **High**：无。
- **Medium**：
  1. 状态文档三处落后一步且被守卫测试锁定——下一位只读 AGENTS.md 的 Agent 可能误判 Sprint 12 仍待开发或误重开已冻结范围；
  2. 链清单守卫失能（匹配注释）——迁移链被误删/误改时三条边界测试不会变红；
  3. 仓库无 remote / 无异地备份——单盘故障即丢失全部历史（对「可持续接力开发」目标是结构性威胁）。
- **Low**：
  1. LOW backlog 5 组（Handoff 纵深防御不对称、静默降级、审计非同事务等）；
  2. Electron 二进制缺失 → 桌面壳无真实冒烟；
  3. 覆盖率未进门禁；
  4. README/ARCHITECTURE 陈旧描述；
  5. MockProvider 的 `sk-mock-*` 白名单是唯一允许的密钥形态——接入真实适配器时需重新审视该白名单边界。

## Recommended Next Task

> 只提出，不执行。需用户批准后方可开工。

**任务：Post-Sprint-12 Documentation Truth Reconciliation（文档真相回填）**

- **Goal**：把「Sprint 12 已关闭」这一事实从 PROJECT_HANDOFF.md 回填到全部入口文档与守卫，
  恢复守卫的检测力，使下一位 Agent（人或 AI）从任何入口读到的状态一致。
- **Why Now**：① 这是当前唯一已被证实的信息级风险（三处漂移 + 一处守卫失能 + 一处守卫锁错）；
  ② 改动全在文档/测试 fixture，零产品代码、零迁移、零语义变化，风险最小；
  ③ 不做它，任何后续 Sprint 的入口状态判断都建立在过期契约上；做了它，Sprint 13 的批准与开工才有干净基线。
- **Affected Modules**：
  `AGENTS.md` §3 ｜ `docs/EXECUTION_ROADMAP.md` 交付状态说明表 ｜
  `scripts/tests/docs-consistency.test.mjs`（断言改为「Sprint 0–12 已关闭 / 禁止进入 Sprint 13+ 待批准」）
  ｜ `tests/shared/expected-chains.ts`（补第 11 条链 `memory`）｜
  `apps/desktop/src/main.ts`（删除 :65-66 的冻结注释，使正则重新咬住真实代码——属守卫修复，不改行为）
  ｜ `README.md`（当前阶段一句话，可选）。
- **Risks**：极低。唯一注意点：改 fixture 后三条边界测试的正则会转而匹配 `main.ts:71` 真实链表
  （11 链精确匹配），需确认全绿；`docs/tests/agents-md.test.ts` 与 `docs-consistency` 断言需同步措辞；
  遵守编码硬规则（只用文件工具，提交前扫 U+FFFD）。
- **Acceptance Criteria**：
  1. AGENTS.md、EXECUTION_ROADMAP 尾表、PROJECT_HANDOFF 三处对「当前阶段」陈述一致（Sprint 0–12 CLOSED，Sprint 13+ 待用户批准）；
  2. `expected-chains.ts` = 11 链；删除 main.ts 冻结注释后 `pnpm check` 仍 5×PASS（证明正则咬的是真实代码）；
  3. 负向自证：临时从 `main.ts:71` 删掉 `'memory'` 时边界测试**必须变红**（验毕还原）；
  4. 测试数量不减少；`pnpm test:scripts` 全绿。
- **Tests Required**：更新（不删除）`docs-consistency.test.mjs` 措辞断言；`sprint5/8/9` 边界测试无需改动
  （自动随 fixture 生效）；新增或调整的断言随上述 3 的负向自证一次性验证。

---

## 审计方法与证据附录

- Git：`status/branch/log -20/tag --sort=-creatordate/describe/rev-parse/tag --points-at` 全部实测。
- 门禁：`pnpm check`、`pnpm test:scripts` 全量真实执行（输出留存于会话记录）。
- 结构核验：migrations 目录 11 链 = main.ts:71 链表 = fixture(10) 的差异即漂移 #4 的证据。
- 接线核验：memory/decision 服务装配（main.ts:441/476）、Router 启动对账（main.ts:356）、
  handoff 7 操作、memory/decision 12 操作均在 workflows.ts 操作白名单中确认。
- 措辞锁定证据：`git log -- AGENTS.md`（最后 `3214e16`）vs `git log -- scripts/tests/docs-consistency.test.mjs`（`e1f53d8`）。

*本文件由 Zcode 于接管审计中生成；下一步行动等待用户指令。*
