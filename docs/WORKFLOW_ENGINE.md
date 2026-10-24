# Workflow Engine（Sprint 2）

> 目标：让已有的 Core Domain / WorkflowRun / L1 状态机**通过一个确定性的引擎真正产生可执行的状态推进**。
> 依据：规划书 §二原则 6（Orchestrator 是制度，不是 AI）、§三十三（全局状态机）、§三十四（标准执行生命周期）、
> §三十五（自动返工）、§四十五（Recovery）；ADR-0002/0003/0005。

## 1. 边界与依赖（Engine 只依赖 Core Contract / Port）

| 项 | 规则 |
|---|---|
| 包 | `@companyos/engine`（外环，`packages/engine`） |
| 运行时依赖 | **仅** `@companyos/core`（`workspace:*`）；`devDependencies` 为空 |
| 允许 import | `@companyos/core`、自身相对模块、`node:` 内置 |
| 禁止 import | `electron` / `react` / `@companyos/persistence` / `@companyos/observability` / `@companyos/contracts` / 任何第三方 |
| 禁止知道 | 任何模型或供应商名（含注释与字符串）、`Coding`/`Git`/`Repository`/`Developer`/`CTO`/`Article`/`Video`/`Ecommerce` |
| 禁止能力 | 网络、UI、调度线程、定时器、随机数、`Date.now()`（时间一律来自 `Clock` 端口） |

以上每一条都有自动化证据：`packages/engine/tests/boundary.test.ts`（包清单 + import 扫描 + 标识符扫描 +
厂商名扫描 + 能力扫描）、`scripts/check-boundaries.mjs` 的 LAW2 白名单（`ALLOWED_INTERNAL_DEPS['@companyos/engine'] = ['@companyos/core']`）。

**执行者由外部注入**：`StageHandlerRegistry` 是引擎唯一的扩展点。Sprint 2 只提供确定性 stub
（`alwaysSucceed` / `alwaysFail` / `failTimes` / `createScriptedRegistry`），
真实 Agent Runtime 属 P1（Sprint 8），且必须继续在 Core 端口之后。

## 2. Command → Engine → Event 执行边界

```text
调用方（UI / Chief / driver）
   │  RunCommand { commandId, runId, type, expectedRevision, actorId, traceId, issuedAt, reason?, payload? }
   ▼
Engine.dispatch(raw)                     ← ① 永不信任调用方：validateRunCommand(raw)
   │  ② 幂等查表（commandId + fingerprint）
   │  ③ 读 Run，乐观并发校验（expectedRevision === run.revision）
   │  ④ routeCommand：Command → RunEvent（30 : 30 满射）
   │  ⑤ 审批副作用（APPROVAL.REQUEST/GRANT/DENY 先落 Approval 聚合）
   │  ⑥ applyRunEvent（Core 拥有不变量与状态写）
   │  ⑦ 持久化 Run（revision + 1）
   ▼
事件追加（EventStorePort）               ← ⑧ 每条被应用的转移按 RUN_TRANSITIONS[].emits 落事件
   ▼
DispatchOutcome { from, to, revision, eventTypes, duplicate }
```

**命令与事件是两套词表**：命令表达**意图**（`PLAN.COMPLETE`），事件记录**事实**（`run.plan_ready`）。
映射表 `COMMAND_TO_EVENT` 是满射（每个命令恰好一个事件、每个事件恰好被一个命令产生），
由 `command-router.test.ts` 断言。命令词表定义在 **Core**（`domain/commands.ts`），
因为它是跨边界契约；引擎只做解释。

## 3. 状态推进实现

- **唯一状态写入口**：`Core.applyRunEvent(run, event, { at, failureReason?, expectedRevision? })`。
  引擎不写 `state` 字段，只调用它；非法转移由 Core 抛 `ILLEGAL_TRANSITION`，且**零副作用**。
- **revision 单调 +1**：每次成功应用事件即 +1；这是乐观并发与幂等的唯一排序依据（不依赖时钟、不依赖锁）。
- **每 Run FIFO 串行化**：引擎为每个 `runId` 维护一条 promise 链，同一 Run 的命令按到达顺序执行；
  **跨 Run 不互相阻塞**。这是"并发命令冲突测试"（L）能给出确定结果的原因。
  - 注意：已验证的内部路径（`executeStage` 内部的 `EXECUTION.COMPLETE/FAIL`）传
    `alreadySerialized=true`，避免在临界区内重入串行链造成**自死锁**（该缺陷由 Sprint 2 测试抓出并修复）。
- **确定性 driver**（`engine.drive(runId, options)`）：测试与桌面端"继续"按钮使用同一个推进器。
  它对每个状态选择唯一合法的下一条命令，遇到 `WAITING_APPROVAL` / `PAUSED` / 终态 / 需要外部决策
  （如 `EXECUTING` 但没有 stage 描述）时**停下来报告原因**，绝不猜测。
- **副作用顺序（评审 HIGH 修复）**：`execute` 先做**纯校验**（`applyRunEvent` 不写任何东西），
  只有校验通过才落审批副作用、才持久化。因此"非法/过期命令"不会留下孤儿 pending 审批。
- **重入守卫**：`StageHandler` 在执行期处于 per-run 临界区内，若回调 `dispatch`，
  引擎返回 `CONFLICT`（`details.reason='reentrant_dispatch'`）而**不是死锁**；
  handler 的正确做法是只返回结果（`handlers.ts` 已写明该契约）。

| 状态 | driver 的动作 |
|---|---|
| `IDLE` | `RUN.START` |
| `INITIALIZING` | `TEMPLATE.RESOLVE`（`templateAvailable:false` 时 `TEMPLATE.MISSING`） |
| `DESIGNING_WORKFLOW` / `WORKFLOW_REVIEW` / `WORKFLOW_PUBLISHED` | `DRAFT.SUBMIT` / `DRAFT.APPROVE` / `RUN.CREATE` |
| `PLANNING` | `PLAN.COMPLETE`（携带分支规则与上下文） |
| `ROUTING` | 风险 HIGH/CRITICAL → `APPROVAL.REQUEST`，否则 `ROUTE.RESOLVE` |
| `WAITING_APPROVAL` | 有 `approvalDecision` 才 `APPROVAL.GRANT/DENY`；否则**停止** |
| `EXECUTING` | 执行 stage（见 §4 Retry），然后 `EXECUTION.COMPLETE` / `EXECUTION.FAIL` |
| `REVIEWING` / `VALIDATING` | 按 `reviewOutcomes` / `validationOutcomes` 脚本 → PASS / REJECT(FAIL) |
| `REWORK` | 预算未超 → `REWORK.READY`；已超 → `REWORK.EXHAUST` |
| `FINALIZING` / `RECOVERING` | `DELIVERY.COMPLETE` / `RECOVERY.COMPLETE` |
| `PAUSED` / 终态 | **停止**（`paused` / `terminal`） |

## 4. Retry / Pause / Resume / Approval / Rework / Branch

**Retry（任务级，需求 4）**：`Task` 携带 `attempts` / `maxAttempts`（L3 机器）。
处理器返回 `failed` → `FAIL` → 若 `attempts < maxAttempts` 则 `RETRY` 回到 `READY`，
耗尽则**保持 `FAILED`** 并让引擎发 `EXECUTION.FAIL`（Run → `FAILED`，`failureReason='execution_failed'`）。
处理器返回 `blocked` → `BLOCK`，Run **停在 `EXECUTING`**（不是失败），等待后续命令。
`attempts` 永不超过 `maxAttempts`（测试断言恰好等于）。

**Pause / Resume（需求 5、6、14）**：`PAUSE` 只允许从**执行期 8 态**出发（ADR-0003 / SM-L1-09），
写入 `resumePoint = 当前状态`；`RESUME` 返回 `resumePoint` 并清空该字段——因此暂停**无法**绕过规划、
路由或审批门。`IDLE/INITIALIZING/DESIGNING_WORKFLOW/WORKFLOW_REVIEW/WORKFLOW_PUBLISHED` 上 `PAUSE`
一律 `ILLEGAL_TRANSITION`。

**Approval（需求 8）**：`APPROVAL.REQUEST` 先经 Core `requestApproval` 落一条 `Approval`
（仅 HIGH/CRITICAL 合法，LOW/MEDIUM 抛 `POLICY_DENIED`），再转移到 `WAITING_APPROVAL`；
`APPROVAL.GRANT/DENY` 先经 `decideApproval`（要求 `authorities` 含 `run.approve`，且**不得自批**），
再转移到 `EXECUTING` / `FAILED`。任一副作用失败 ⇒ 不产生状态写、不产生事件、`revision` 不变。

**Rework（需求 9）**：`REVIEW.REJECT` / `VALIDATION.FAIL` → `REWORK`（`reworkCount + 1`）。
预算未超 → `REWORK.READY` 回 `EXECUTING`；超过 → `REWORK_READY` 被拒（`LIMIT_EXCEEDED`），
只能 `REWORK.EXHAUST` → `PAUSED`（规划书 §三十五）。

**Branch（需求 10）**：分支是**声明式数据**（Core `domain/branch.ts`）：规则按声明顺序求值，
**首个全部条件成立者胜出**，无匹配则用 `defaultBranch`；求值是纯函数、可内容哈希、可重放。
`PLAN.COMPLETE` 时可携带 `branchSet + branchContext`（引擎用 Core `selectBranch` 求值）
或显式 `branch`；选中的分支用于选择 stage 处理器（`<branch>:<kind>` 优先于 `<kind>`）。

## 5. Idempotency 与 Revision 策略（需求 13、15、16）

| 机制 | 规则 | 失败码 |
|---|---|---|
| **幂等键** | `commandId` 已应用过 → 直接返回**首次的 `DispatchOutcome`**（`duplicate: true`），不重放副作用、不新增事件、`revision` 不变 | — |
| **键复用** | 同一 `commandId` 携带不同内容（fingerprint 不同） → 拒绝 | `CONFLICT` |
| **账本上界** | `maxLedgerEntries`（默认 1000）FIFO 淘汰；被淘汰的旧命令不再是"重复"，会因 revision 过期而被拒 | `CONFLICT` |
| **乐观并发** | `command.expectedRevision !== run.revision` → 拒绝且零写入（`details.reason='stale_revision'`） | `CONFLICT` |
| **同 Run 并发** | 引擎按 FIFO 串行化：同 revision 的两条命令恰好一条成功；revision 连续的两条按到达顺序双双成功 | 同上 |
| **非法转移** | Core 拒绝，零写入、零事件（需求 12） | `ILLEGAL_TRANSITION` |

`revision` 是**唯一**的并发凭据：不依赖挂钟、不依赖数据库锁，因此同一批命令在任何机器上得到相同结果。

## 6. 事件与审计

- **每条被应用的转移**按 `RUN_TRANSITIONS[].emits` 写成 `DomainEvent`（`EventStorePort` 追加），
  payload 含 `from` / `to` / `revision` / `commandType`；聚合为 `WorkflowRun`；
- **任务级转移同样产事件**：`task.state_changed`（每次 PLAN/START/FAIL/RETRY/COMPLETE/BLOCK/UNBLOCK），
  阻塞时额外 `task.blocked`；聚合为 `Task`；
- **审批副作用产事件**：`approval.requested` / `approval.granted` / `approval.denied`；聚合为 `Approval`；
- 转移 `DELIVERED` 同时 emit `run.delivered` 与 `run.completed`；
- 引擎只转发 L2 拥有的生命周期事实（如 `workflow.template.published`），不重新声明它们；
- **每个目录条目有且只有一个已声明的发射方**（Core `CORE_EVENT_EMITTERS`）：尚未实现的条目
  （如 `stage.created`、`validation.recorded`）标注归属 Sprint，因此"死条目"是可被测试发现的，
  而不是沉默的谎言（`core/tests/domain/event-emitters.test.ts`）；
- 被拒绝的命令**不产生任何事件**（测试断言事件条数不变），因此事件流可视为"已发生事实"的完整记录；
- **写入顺序**：先校验转移合法性 → 再落审批副作用 → 再持久化 Run → 再追加事件。
  最后两步目前**不在同一事务**内（引擎逐条 IO），已列为 Sprint 3 的 `UnitOfWork` 待办（ADR-0005）。

## 7. 测试矩阵（用户 A–L + 需求）

| # | 场景 | 测试文件 |
|---|---|---|
| A | 完整 Happy Path（8 次转移 → `COMPLETED`） | `engine/tests/happy-path.test.ts` |
| B | Retry 成功（3 次尝试后成功） | `engine/tests/retry.test.ts` |
| C | Retry Exhausted（恰好 `maxAttempts` 次 → Run `FAILED`） | `engine/tests/retry.test.ts` |
| D | Pause → Resume（含逐轮重复、暂停不得早于规划） | `engine/tests/pause-resume.test.ts` |
| E | Approval Granted（含"驱动不替人做决定"） | `engine/tests/approval.test.ts` |
| F | Approval Rejected（含无授权 / 自批 / 低风险请求被拒） | `engine/tests/approval.test.ts` |
| G | Review → Rework → Review（含验证失败计返工、预算耗尽 → `PAUSED`） | `engine/tests/rework.test.ts` |
| H | Illegal Transition（Run 逐字节不变、零事件） | `engine/tests/illegal-transition.test.ts` |
| I | Duplicate Command（重放不产生第二效果） | `engine/tests/idempotency.test.ts` |
| J | Stale Revision（`CONFLICT` + `stale_revision`） | `engine/tests/revision.test.ts` |
| K | Crash 后基于 `resumePoint` 恢复（含中断任务重跑） | `engine/tests/crash-recovery.test.ts` |
| L | 同一 Run 并发命令冲突（1 胜 1 冲突 / FIFO 双成功 / 10 连发） | `engine/tests/concurrency.test.ts` |
| 10 | Branch 最小确定性语义 | `engine/tests/branch.test.ts` |
| 11/12 | 每次合法转移产生事件 / 非法转移无事件 | `happy-path` + `illegal-transition` |
| 2 | Command → Event 满射与理由一致性 | `engine/tests/command-router.test.ts` |
| 边界 | 引擎只依赖 Core、不含行业名词与厂商名 | `engine/tests/boundary.test.ts` |
| Core 侧 | 命令契约 / 分支求值 / revision 守卫 | `core/tests/domain/{commands,branch,workflow-run-revision}.test.ts` |

## 8. 与 Sprint 3 的接口

| 现在（Sprint 2） | 下一步（Sprint 3） |
|---|---|
| `EntityStore<WorkflowRun>` / `<Task>` / `<Approval>` 由内存实现提供 | 换成 `@companyos/persistence` 的 SQLite 实现，表结构见 `docs/STATE_MACHINE.md` §10 |
| `EventStorePort` 内存实现（追加 + 按位置回放） | SQLite `events` 表 + 审计链 |
| Run 状态写入与事件追加**非原子**（先 `runs.put` 再 `events.append`） | 用 Core 的 `UnitOfWork` 端口把两者纳入同一事务 |
| `Run.resumePoint` 仅存在于聚合体 | `runs.resume_point` 列持久化，崩溃后直接读取 |
| 幂等账本在内存（`maxLedgerEntries`） | 落库 `command_ledger(command_id, fingerprint, outcome)`，跨进程重启仍幂等 |
