# Sprint 18 — Autonomous Supervisor & Corrective Loop 测试策略（T18-01 冻结）

> 状态：**FROZEN（T18-01 输出）；T18-02~T18-06 已 CLOSED**。
> 当前证据（T18-06 corrective 后）：**162 files / 1942 cases 全绿**；T18-06 正式 baseline =
> **T18-05：159 files / 1870 cases / HEAD `1bdb88c`**（Sprint 17 基线 145/1689）。T18-06 累计
> 新增 3 文件 / 72 用例：52 项矩阵 + 4 项生产 E2E（commit `18de001`），再加 corrective 的
> 1 文件 / 16 用例（provider 级 12 + supervisor 级 4，覆盖 §L13 的 15 项）。
> 上游：`S18_AUTONOMOUS_SUPERVISOR_CONTRACT.md`（§5 RULINGS / §7 决策语义 / §8 纠正语义 /
> §10 升级 / §11 停止条件 / §13 V1 限制）、`S18_TASK_BREAKDOWN.md`。
> 既有基线（Sprint 17 closeout）：**145 files / 1689 cases 全绿**；本 Sprint 只增不减。

## 分层

| 层                                               | 内容                                                                                                                                                           | 位置（建议）                                                       | Task              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------- |
| L0 Freeze                                        | 三份契约文档一致性、gap↔Task 双向可追                                                                                                                          | 无测试；由 gate 证明（test:scripts 23/23、files/cases 不退）       | T18-01            |
| L8 生产接线（**T18-02 已实现：3 项**）           | `composeCoreServices` 真的接上 goal writer / replay ledger / binding registry / engine verifier；篡改 pin 后 engine 拒绝执行；无 seam 的 legacy 组合仍可建 run | `tests/sprint18/production-execution-context.test.ts`              | T18-02            |
| L1 Goal                                          | run goal 落盘/restart 可读、不进 snapshot 哈希、`verifyRunSnapshot` 篡改检出、旧 run 不回归                                                                    | `tests/sprint18/run-goal-persistence.test.ts`                      | T18-02            |
| L2 Decision Sink                                 | 幂等重放、同键异内容 `CONFLICT`、authority 拒绝、secret 拒绝、provenance closed set、refs 引用完整性                                                           | `tests/sprint18/supervisor-decision-sink.test.ts`                  | T18-03            |
| L3 Review Findings                               | 信封 schema 拒绝、severity closed set、artifact+CAS 绑定、EvidenceGuard 不受影响、review artifact ≠ validation evidence                                        | `tests/sprint18/review-findings-contract.test.ts`                  | T18-04（需批准）  |
| L4 Corrective Provisioning                       | 幂等、重复拒绝、终态 stage/run 拒绝、跨 run 拒绝、attempts 仍由引擎强制、provisioned task 真被执行                                                             | `tests/sprint18/corrective-task-provisioning.test.ts`              | T18-05（阻塞 Q1） |
| L5 Escalation                                    | 三件套齐备且互引、decider ≠ requester、升级期间 corrective 被拒、restart 不被 recovery 解除、重复升级幂等                                                      | `tests/sprint18/human-escalation.test.ts`                          | T18-07            |
| L12 Decision Runtime（**T18-06 已实现：56 项**） | 见下方 §L12 矩阵（binding/execution 1–10、context 11–22、proposal 23–34、零副作用 35–42、取消/超时 43–52 + 生产 E2E 4 项）                                     | `tests/sprint18/supervisor-decision-runtime{,-production}.test.ts` | T18-06            |
| L6 Stop Conditions                               | §11 八条各一负例、停止后无 decision 之外的 durable 副作用                                                                                                      | `tests/sprint18/supervisor-stop-conditions.test.ts`                | T18-07            |
| L7 E2E                                           | 生产 composition 全链 + DevCompany Pack 不变量回归 + 边界否定                                                                                                  | `tests/sprint18/supervisor-production-e2e.test.ts`                 | T18-08            |

| L9 Decision Sink + Corrective（**T18-03 已实现：56 项**） | 域/持久化 21 + 上下文 11 + 幂等/副作用 13 + 生产接线 4 + corrective 18（tenant 身份 / 全历史读者 / 证据契约；含跨 tenant 同 commandId、ledger-trim 重放、supersede/revoke 后重放） | tests/sprint18/{supervisor-decision-sink,supervisor-decision-idempotency,supervisor-decision-production,supervisor-decision-corrective}.test.ts | T18-03 |
| L10 Review Findings + Execution Provenance（**T18-04 已实现：62 项**） | 契约 10（§67）+ 上下文 10（§68）+ 持久化 11（§69）+ 引用 8（§70）+ 副作用 11（§71），含 corrective 16 项（executionId 必填 / 跨 run·task·company 拒绝 / 状态门 / 派生不可伪造 / binding 派生与 mismatch）+ 生产 E2E 2 项（§72/§73） | tests/sprint18/{review-findings-contract,review-findings-durability,review-findings-production}.test.ts | T18-04 |
| L11 Corrective Provisioning（**T18-05 已实现：29 项**） | 载体 8（§72）+ 决策授权 8（§73）+ cause 8（§74）+ lineage 11（§75）+ 幂等 8（§76）+ 零执行 8（§77）+ 历史 8（§78）中的可达项，含 tamper 行到达的防御分支、并发、restart、raw-SQL 伪造 | tests/sprint18/{corrective-provisioning,corrective-production}.test.ts | T18-05 |

## L12 Supervisor Decision Runtime 断言矩阵（T18-06，52 + 4）

**binding + execution（1–10）**

1. 调用用的模型恰是 run pin 的那个（且只有它）。
2. run 未 pin supervisor 名 ⇒ `RUN_BINDING_MISSING`，零模型调用、零决策、零执行。
3. pin 的模型记录消失 ⇒ `RUN_BINDING_UNKNOWN`，零模型调用。
4. pin 的模型被禁用 ⇒ `RUN_BINDING_UNUSABLE`，零执行。
5. 调用方塞入 providerId/modelKey/providerModelId/modelVersion ⇒ 永不进入 Decision；
   直接喂给 sink 时被 `SUPERVISOR_DECISION_MODEL_IDENTITY_REJECTED` 拒绝。
6. 一次 turn 只产生一个 durable AgentExecution。
7. 执行携带通用 supervisor 身份与 subject task/run 锚点。
8. Decision 落盘后才允许 COMPLETED；`resultRef` 保持 null（Sprint 13 冻结契约 = 不透明字符串，
   T18-06 corrective 移除了自造的 `decision:<id>@<version>` namespace），两行以 `traceId` 关联，
   且 usage 用 provider 实际报告值（3 in / 7 out）。
9. 严格解析失败 ⇒ 执行 FAILED(INVALID_OUTPUT)，零 Decision。
10. 语义前置失败 ⇒ 执行 FAILED，零 Decision。

**context（11–22）** 11. context 目标是 canonical goal artifact 的 objective。12. 无 goal ⇒ fail closed，零模型调用。13. 快照被篡改 ⇒ `SNAPSHOT_MISMATCH`，零模型调用、零决策、零执行。14. 投影 **latest** review report（新 PASS 覆盖旧 CHANGES_REQUESTED）。15. 投影 **latest** validation（newest wins）。16. decision history 有界（20）且 `truncated` 记录截断。17. corrective lineage 投影（parent/root/round/origin/cause）。18. blocking conditions 由 latest review/validation/subject 状态计算。19. 每个投影都有对应 durable ref。20. 超 16 KiB ⇒ `SUPERVISOR_CONTEXT_TOO_LARGE`（拒绝，不静默截断）。21. context 确定性：同 durable 状态 ⇒ 同字节。22. 投影只含有界摘要与 ref，finding detail / artifact 内容从不进入 context。

**proposal（23–34）** 23. 非对象 / 24. 错误 schema / 25. 缺键 / 26. 未知 action / 27. 未知 reasonCode / 28. 空 summary / 29. evidenceRefs 非数组或超限 —— 各自拒绝。30. proposal 不得针对非 subject task。31. 无子串提取：只回散文 ⇒ INVALID_OUTPUT（零 Decision）。32. CONTINUE 在有 blocking condition 时被拒。33. ESCALATE 无 blocking condition 被拒。34. COMPLETE 需要 `DONE` + latest validation `pass` + 引用该 validation。

**零副作用（35–42）** 35. 一次成功 turn 产生零 ToolInvocation / 零 Validation。36. provider 请求**不声明任何 tool**，且 responseFormat = `json_schema`。37. 每次 turn 只调用 provider 一次（被拒的提案也不触发第二次）。38. run/stage/task 无任何状态迁移，tasks 行数不变。39. REQUEST_CORRECTIVE 只记录：零 corrective task、零额外执行。40. 同 commandId 重放 ⇒ 零额外模型调用、同 decisionId、同 executionId。41. 别的 company 与"run 不存在"不可区分。42. 不同 turn identity ⇒ 第二条 Decision（无意外去重）。

**取消/超时（43–52）** 43. 已中止的 signal ⇒ 零模型调用/零决策/零执行。44. 模型调用前取消 ⇒ 执行记 CANCELLED（不留 READY），零决策。45. 模型调用**飞行中** deadline 到期 ⇒ `TIMEOUT`，零决策，执行 CANCELLED。46. 提交前取消 ⇒ 零 Decision，执行不得 COMPLETED。47. 提交后取消 ⇒ 返回取消，但 Decision 已耐久；同 identity retry 幂等（零模型调用）。48. 全 turn deadline 生效且 timer 被释放。49. 调用方不能放宽 deadline（`maxTimeoutMs` 上限）。50. 正常结束也释放 timer。51. provider 失败 ⇒ 执行 FAILED(PROVIDER_UNAVAILABLE)，零决策。52. 崩溃遗留的 RUNNING 执行经 restart + recovery 变 INTERRUPTED，**永不重新调用 provider**。

**生产 E2E 四条（`composeCoreServices` 入口，fake model seam，无 live API）**

- review `CHANGES_REQUESTED` ⇒ 一条 REQUEST_CORRECTIVE 决策（引用该报告、`RECORDED_ONLY`），
  零 corrective task/零 tool/零 validation，supervisor 执行 COMPLETED 且 usage 如实。
- QA 失败 ⇒ 一条 VALIDATION_FAILED 请求（引用该 validation 行）。
- subject `DONE` + validation `pass` ⇒ COMPLETE，且 run 自身不被推进。
- restart 重放：同一 turn identity 在同一 durable 文件上 ⇒ `replayed: true`、零新执行、零新决策。

## L13 Provider Cancellation 断言矩阵（T18-06 corrective，15 项）

1. abort before provider invoke ⇒ **zero provider calls**（AgentRuntime 调用前硬门）。
2. abort while provider pending ⇒ provider **receives** the abort（adapter 记录 signalObservations /
   abortObservations / cancellations）。
3. 在飞的 provider promise **真正终止**（远早于其脚本化等待窗口结束）。
4. abort during model ⇒ **no Decision**，execution 终态非成功且 `error_kind=CANCELLED`。
5. timeout aborts the provider itself，不只是外层 promise。
6. 未传 signal 的正常调用**逐字不变**（adapter 从未看到 signal）。
7. abort during retry backoff ⇒ **不再发起下一次 attempt**（retryAttempts 停在 1）。
8. abort 不触发 alternate provider / alternate model / fallback binding（same pinned model only）。
9. 取消分类为 `CANCELLED`，不得伪装成 `MODEL_FAILED` / `INVALID_OUTPUT` / `PROVIDER_ERROR`；
   ProviderRegistry 不把取消重新分类成 `AGENT_UNAVAILABLE`。
10. provider 报告的 usage 仍然如实落库（不被清零、不编造）。
11. late abort after Decision commit ⇒ Decision 保持权威，不重复、不回滚。
12. replay after committed Decision ⇒ **zero new model invocation**、零新 execution。
13. AgentRuntime 提供的 signal 原对象到达 adapter（`request.signal === caller.signal`）；
    streaming 路径遵守同一契约。
14. deadline timer 在取消路径与正常路径都被释放（`pendingCount() === 0`）。
15. 无 unhandled rejection / dangling listener（`runWithOutput` 的已放弃 promise 也不例外）。

**Adapter 契约**（`ModelProviderPort.invoke`，Core `ports/model-provider.ts`）：
`InvocationRequest.signal?: AbortSignal`，optional ⇒ 未提供的调用方行为不变；adapter 必须把它
传播到真实模型调用并在触发时终止该次调用，取消的标准返回是
`err(DomainError('CANCELLED', …, { kind: 'CANCELLED' }))`（不得抛异常、不得重试、不得回退）。
引擎不安装定时器（boundary gate）：mock adapter 的"在飞"窗口由注入 sleeper 提供。

## L14 Autonomous Loop 断言矩阵（T18-07，36 + 4）

**loop core（1-10）**：一次 turn 到 CONTINUE 到恰好一个工作单元；工作结果到下一 turn；
REQUEST_CORRECTIVE 到恰好一个 corrective Task（round=1、parent/root 正确）；该 Task 只执行一次
（attempts=1）；结果到下一 turn；COMPLETE 结束循环且 Run=COMPLETED；ESCALATE 结束循环且
Run=WAITING_APPROVAL + 一条 pending Approval；无合法动作结束；CANCELLED 执行结束循环且零模型
调用 / 零执行 / 零 stage 执行；不可重试失败结束（Task FAILED + Run FAILED）。

**bounds（11-20）**：round 1/2/3 允许；round 4 在 Task 创建前被拒（`CORRECTIVE_ROUND_LIMIT_EXCEEDED`，
derivedRound=4，零新 Task），且**直接调用 provisioner 同样被拒**；`maxSupervisorTurns` 用尽 =>
human-required 且不再有模型调用（剩余合法工作不被悄悄执行）；round 耗尽 => 人类必需停止而非
silent COMPLETE；迭代有界、无递归、advance 次数等于已应用工作单元数。

**idempotency（21-27）**：同 CONTINUE Decision 两次 => 一个工作单元；同 corrective Decision 两次
=> 一个 Task；同 COMPLETE 两次 => 一次迁移（run 已终态，零新模型调用）；同 ESCALATE 重放 => 稳定
且零模型调用、零新 Approval；**ledger 全表删除后**重放仍 replay（receipt 是永久身份）；restart
后重放无重复；并发同 Decision => 一个效果（一个 Task / 一个 receipt / 一个 decision）。

**anti-stale（28-32）**：REVOKED Decision 不得应用；latest review 在窗口内变化 => 拒绝陈旧应用
（零新 Task）；latest validation 在窗口内变化 => 拒绝；Task 在窗口内变终态 => 引擎自身语义拒绝，
零 handler 执行。

**model binding（39-44）**：编排器自身不暴露任何 model 身份面（其公开方法只有
run / nextWorkUnit / resumeEscalatedRun）；run 未 pin supervisor 名 => fail closed 且零模型调用；
provider 连续失败 => 同一模型，无 fallback provider/model。

**cancellation（45-52）**：外层 abort => CANCELLED，且 provider **观察到** abort
（signalObservations / abortObservations 均大于等于 1），零工作执行；CANCELLED 执行永不自动重试；
Decision 之后、action 之前 abort => task 未被 DONE；timer 在所有退出路径释放。

**escalation & resume（53-57）**：ESCALATE 跨 restart 仍 WAITING_APPROVAL + pending；escalated
run 无法 advance（引擎自身状态机拒绝）；重放不产生重复 escalation；`resumeEscalatedRun` 一次
APPROVAL.GRANT => EXECUTING，第二次拒绝（`AUTONOMOUS_RESUME_NOT_WAITING`）。

**生产 E2E（75-78）**：happy（work 到 reviewer PASS 到 QA PASS 到 COMPLETE 到 Run COMPLETED）；
corrective（CHANGES_REQUESTED 到一个 T1 round=1 到 DONE 到下一 turn）；round limit（T0 到 T1 到
T2 到 T3，round 4 被拒且零 Task，autonomous loop 停在 round_limit 且 Run 非 COMPLETED）；
restart replay（同 identity 在新 composition 上零新 task / 零新 receipt）。

## 必须覆盖的断言矩阵（按契约条款）

### R1 Supervisor 不是第二个 dispatcher

1. 任何 Supervisor 入口都不得直接调 `tasks.put` / `runs.put` / `step(...)`；只经
   `engine.dispatch` 命令面（以代码审查 + 单测断言"未经命令面的状态写 → 拒绝"证明）。
2. re-entrancy 仍被拒（`CONFLICT` / `reentrant_dispatch`，`engine.ts:569-576`）。

### R2 决策落 `DecisionRecord`，无新表

3. 决策字段映射完整：`question/decision/rationale/alternativesConsidered/consequences/
constraints/provenance.sourceType/traceId/decidedBy`（§7 表）。
4. `provenance.sourceType` 只允许 closed set 内取值（`decision.ts:6`）。
5. **无新 migration**：门禁对比 `packages/persistence/migrations/` 文件集合不变。
6. 决策在 `decisionId+version` 不可变历史下可追（supersede/revoke 只改 status）。

### R3 Run goal 不进 `RunSnapshot` pin 集

7. goal 落盘后 `snapshotHashOf` 输出与落盘前一致（pin 集语义不变）。
8. goal 承载体（run-owned artifact）重启后可读，内容在 CAS 中按 `sha256:<64hex>` 可验证。

### R4 纠正 ≠ 第三次重试

9. `attempts` 仍只由 `START` 递增且永不超过 `maxAttempts`
   （`task.ts:134-146`、`engine.ts:792-796`、`retry.test.ts` 的 `toBe(3)` 断言保持）。
10. corrective 动作在事件流中与引擎自动 `RETRY` 可区分（不同事件/决策键）。
11. corrective 触发前必须已有 decision + 非空证据引用（否则拒绝）。

### R5 Review ≠ QA

12. EvidenceGuard 判定**不含** reviewer artifact：把 review artifact 设为
    `targetRef` 时仍走 validation batch 规则，缺 batch ⇒ `VALIDATION_GATE_NO_EVIDENCE`。
13. review verdict 永不写入 `Validation` 行；`validation.record` 仍只属 validator 工具路径。
14. 结构化 findings 的 `evidenceRefs` 必须过 `VALIDATION_EVIDENCE_PATTERN`
    （`^(artifact|command):\s*\S.*$`）。

### R6 无新 authority

15. 门禁断言 `AUTHORITIES` 数组内容与 `role-authority.ts:16-74` 逐项相同（43 项），
    无新增 token（除非 Boss 显式批准并在 closeout 记录）。

### R7 Pack 中立

16. 新增 production 代码零 pack 名/角色名字面量（沿用 engine 边界 greps：
    `'cto'|'developer'|'reviewer'|'qa'|'documentation'|'dev-company'`）。

### R8/R11 停止条件（§11 八条，每条至少一负例）

17. 预算耗尽（attempts ≥ maxAttempts）⇒ 停，无 corrective。
18. 证据缺失/过期（EvidenceGuard 七类 fail-closed 理由任一）⇒ 停。
19. `SNAPSHOT_MISMATCH` / `GATE_*` 四级失败 ⇒ 停。
20. run 非执行期或已终态 ⇒ 停。
21. 存在 `pending` approval（`decidedBy === null`）⇒ 停。
22. run 在 `RECOVERING` / recovery 单飞未完成 ⇒ 停。
23. ledger 键冲突（同键异内容 `CONFLICT`）⇒ 停。
24. 未知状态 ⇒ `OBSERVE` + 升级。
25. 停止后唯一新增 durable 记录是 decision 本身（无 second 副作用）。

### §10 人工升级

26. 升级 = decision + `Approval(pending)`（+ 可选 `Handoff(READY)`），三者 `runId` 一致。
27. `decidedBy === requestedBy` ⇒ `POLICY_DENIED`（职责分离）。
28. LOW/MEDIUM 风险请求人工审批 ⇒ 策略拒绝（`approval.ts:52`）。
29. restart 后 `pending` 仍 `pending`；startup recovery 不解除 manual 状态
    （`startup-recovery.ts:116-124`）。
30. Task `BLOCKED` 与 run `WAITING_APPROVAL` **不得同时无解释置位**。

### R9 幂等与崩溃安全

31. 决策键确定性：同输入两次 ⇒ 同一 id、一条记录（回放）。
32. 同键异内容 ⇒ `CONFLICT`（ledger 指纹不匹配）。
33. corrective 命令重复触发 ⇒ ledger 回放，无第二次外部副作用
    （用可控副作用探针证明，参照 T17-04 的失败证据模式）。
34. 决策 + 副作用同一事务：中途失败 ⇒ 两者都不落（`engine.ts:491-533` 模式）。
35. 恢复中的半成品决策靠键幂等重入，不得重放副作用。

### §12 交互与 §13 V1 限制

36. Supervisor 不得 spawn 进程/写文件/调 git：断言 repository 工具只能经 ToolRegistry
    调用链（T17-04 唯一 spawn 点不变）。
37. Supervisor 的模型需求必须显式 `modelKey`，否则 `MODEL_SELECTION_REQUIRED`
    （`agent-runtime.ts:308-318`）。
38. V1 限制断言：无 corrective task（Q1 未定时）、无 autonomous loop（无 timer/scheduler）、
    无 cost 落盘、无新 authority。

### L7 E2E（生产 composition）

39. 全链：run goal → decision sink → 读既有 durable evidence → 停止条件命中 → 升级 →
    人类决定 → corrective 重试 → 门禁仍由 EvidenceGuard 决定。
40. E2E 必须复用 `composeCoreServices` 生产入口（T17-08 corrective 教训：不得旁路）。
41. DevCompany Pack 不变量回归：24 refs / 5 pack roles / system owner 1 / 1 workflow /
    0 自动分配。
42. 否定链：无 workspace 打开 / evidence 缺失 / snapshot 篡改 / 键冲突，各自 fail closed。

## 覆盖度缺口（诚实声明）

- **T18-04 的 handler 输出载体扩展未规划单测**：它改动 `handlers.ts` 契约与
  `engine.ts:779`，影响所有既有 handler；若 Boss 批准，需要一轮既有 handler 的回归矩阵
  （`createScriptedRegistry` / `createStaticRegistry` / repository handler 三条路径）。
- **T18-05 的 provisioning 与 pack materialization 的关系未测**：pack 不创建 Task 是 recon
  事实（§4.3），provisioning 上线后需证明"pack 路径仍然不创建 Task"。
- **无性能/并发测试**：Supervisor 的并发决策只靠单飞与键幂等保证，未做压力测试。
- **无 renderer/IPC 测试（本 Sprint无此面）**。

## 门禁（每个 Task 结束时强制执行）

1. `pnpm check` 五次全 PASS（lint / typecheck / boundaries / test / build）。
2. `pnpm test:scripts` 23/23 PASS。
3. `git diff --check` 干净（无空白错误）。
4. 测试文件数 ≥ 145、用例数 ≥ 1689（只增不减；T18-06 corrective 实际 162 files / 1942 cases）。
5. 全仓 `git status --porcelain` 无未跟踪遗留（报告输出除外）。
6. 每个 Task 一个 commit（corrective 独立 commit，不 amend）；Sprint 18 收口时打
   annotated tag `sprint-18`，**不 push**。
