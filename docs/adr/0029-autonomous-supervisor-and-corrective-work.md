# ADR-0029：Autonomous Supervisor & Corrective Work — Authority, Corrective Semantics and Execution Context

> 归属：Sprint 18（Autonomous Supervisor & Corrective Loop）；规划书 §五十九 Sprint 18 段（经 T18-01 冻结的
> Autonomous Supervisor 使命）、§二 原则 5/11/12、§八、§十八。
> 上游：ADR-0005/0006（engine 边界与幂等）、ADR-0020（EvidenceGuard）、ADR-0027（Run packVersions
> trusted derived）、ADR-0028（Repository Runtime 边界）、Sprint 18 T18-01 架构冻结
> （`docs/sprint18/S18_AUTONOMOUS_SUPERVISOR_CONTRACT.md`）。
> 本 ADR 由 TASK-18-02 落地（T18-01 已写好 PROPOSED 文本；Boss 逐条裁定后 Accepted）。

## 状态

**accepted（Accepted）** — Boss 于 TASK-18-02 裁定 12 条 ruling 全数通过。**本 ADR 只冻结决策语义与
执行上下文基础设施；它不授权任何运行期行为**：Sprint 18 后续任务（T18-03 Supervisor decision sink、
T18-04 reviewer findings、T18-05 corrective provisioning、T18-06 decision runtime、T18-07 corrective
loop、T18-08 crash safety、T18-09 production E2E、T18-10 closeout）未获各自批准前不得开工。

---

## Decision 1：Supervisor is generic orchestration runtime, NOT DevCompany CTO

Supervisor 是 CompanyOS 的通用编排运行时组件（main-process 受信应用层），不是任何 industry pack 的
业务角色。`dev-company:cto` 是 DevCompany Pack 的业务角色（Sprint 16 裁定）。二者**永远不相等**：
engine/application 代码中不得出现 `if role === CTO` 之类的特例分支（既有边界测试已对此 fail closed）。
未来 DevCompany 可以让 CTO 角色参与规划，但那是 pack 层的产品配置，不改变本裁定。

## Decision 2：Supervisor is not root/admin

Supervisor **不是 root，不是 admin，不是特权主体**。它不拥有 authority 目录中的任何新 token
（T18-02 未改 `AUTHORITIES`），不绕过 ToolRegistry 的 authority/risk/approval 链，不绕过
AuthorizationService 的 Role → Authority 模型。它的一切动作都以**已被授权的既有命令面**表达。

## Decision 3：Supervisor cannot bypass ToolRegistry, RiskPolicy, approvals, ValidationService, EvidenceGuard or frozen WorkflowVersion

不可绕过的清单（冻结）：

- **ToolRegistry**：任何工具调用必须走 registry.invoke 全链（authority → risk/approval → schema →
  adapter(timeout+cancel) → output schema → durable invocation）。
- **RiskPolicy / approvals**：HIGH/CRITICAL 风险仍需人工审批；Supervisor 无权自批。
- **ValidationService**：验证只能经 validator 工具 + `Validation` 记录。
- **EvidenceGuard**：质量门只认 durable validation batch（ADR-0020，latest wins，无 fallback）。
- **frozen WorkflowVersion / RunSnapshot**：不得改写 pinned 版本、graph 或 snapshot。

## Decision 4：Retry != Corrective

两者严格分离，且在事件流中可区分：

- **Retry** = engine 既有语义：handler 返回 `failed` 且 budget 未尽 ⇒ `FAIL` + `RETRY` + `START`，
  受 `maxAttempts`（默认 3）硬限，全部在 `executeStageInternal` 的一个事务内。
- **Corrective** = Supervisor 的**新语义新记录**：一条 durable decision + 一条 run 命令（或在
  T18-05 获批后的 corrective task provisioning 请求）。Corrective **永远不是**某个任务的第四次重试。

## Decision 5：Corrective creation uses trusted application/orchestration provisioning

Corrective 的创建由**受信 application/orchestration service** 执行，不由 model、agent payload、Task
payload 或 Pack 可执行代码触发。它必须验证自己仍在 run-pinned Workflow 允许的边界内（pinned 版本
graph、stage、role 要求）。V1 **优先复用现有 `Task` + `DecisionRecord`**，不建 CorrectiveTask 第二套表；
若真实 Task schema 无法安全表达 lineage ⇒ HARD STOP（不允许用自由文本凑合）。

## Decision 6：V1 does NOT add task creation authority or task creation Tool

`task.create` / `task.read` 等 authority token **不进入** V1；不以 Tool 形式暴露任务创建。
T18-05 的 corrective provisioning（若 Boss 批准选项 1）经受信 application service 执行，不经 authority
目录、不经 Tool Registry。**这是已知治理债务，按 Q3 裁定保留，不阻塞本 Sprint。**

## Decision 7：Corrective provenance must be durable and idempotent

每条 corrective 必须携带：一条 `DecisionRecord`（question/decision/rationale/alternatives/provenance/
relatedRefs）+ 确定性幂等键。重复触发 ⇒ 既有 command-ledger 指纹回放同一结果，不产生第二次副作用；
同键异内容 ⇒ `CONFLICT` 并进入停止条件。禁止用随机 id 作为决策键（沿用
`task-baseline:<runId>:<taskId>` 与 `retryIdempotencyKey` 先例）。

## Decision 8：Reviewer semantic finding != QA evidence

Reviewer 的结构化 findings（T18-04）与 QA 的 validation evidence 是两层，**不可互替**：
EvidenceGuard 只认 durable validation batch；reviewer verdict 永远不能替代 validation evidence 通过
质量门。reviewer findings 只能作为 artifact/decision 进入证据链。

## Decision 9：Supervisor cannot self-approve

Supervisor 不得批准自己的升级请求。人工决定必须由 `decidedBy !== requestedBy` 的主体做出
（`decideApproval` 的职责分离，ADR/approval.ts 冻结）。`run.approve` 不在 V1 authority 目录中
（Decision 6 的同一债务）；生产审批继续走既有受信 application path。

## Decision 10：Human escalation is mandatory at bounded stop conditions

停止条件清单（冻结，Sprint 18 契约 §11）命中时，Supervisor **必须停止并升级**，不得"再试一次"：
预算耗尽、证据缺失/过期、快照不匹配、run 非执行期、升级未决、恢复进行中、决策键冲突、未知状态。
升级 = 一条 decision + 一个 `Approval(pending)`（必要时 + `Handoff(READY)`），**不发明第四种等待状态**
（既有三种：Task `BLOCKED`、run `WAITING_APPROVAL`、Tool `WAITING_APPROVAL`）。

## Decision 11：Run-pinned WorkflowVersion/RunSnapshot remain immutable

`WorkflowVersion.immutable`、`RunSnapshot` pin 集（orgId/templateId/workflowVersionId/templateLockId/
packVersions/modelBindings/memoryViewRef）、run 行上的三重 pin **均不可变**。T18-02 起，生产执行路径
在**任何 task 写入之前**用 Core 的 `verifyRunSnapshot` 证明 pin：快照缺失、内容被篡改（同 id 不同内容）、
pinned template/version 缺失 ⇒ fail closed；不得 `repairSnapshot` / `updateSnapshot` / 重新生成。

## Decision 12：No DevCompany special case

engine / application / composition 代码不得出现 DevCompany（或任何 pack）的特殊分支、字面量或导入。
DevCompany 的产品策略（模型分离等）留在 pack 层，由未来 Task 显式接线。既有边界测试
（`tests/sprint4/boundary.test.ts`、Sprint 16 集成测试）继续对此 fail closed。

---

## T18-02 已落地的基础设施（本 ADR 的 Execution Context 部分）

三个"Supervisor 醒来时必须拿到的可信事实"已在 T18-02 交付，全部复用既有持久化原语，
**零 migration、零 schema 变更、零新表**：

1. **Run Goal（WHAT）**：canonical durable goal = run-owned immutable `Artifact`
   （kind `companyos:run-goal`），创建时与 run 同事务写入，`run-goal:<runId>` 寻址，
   `getRunGoal({runId, companyId})` 精确检索（company/run/kind 归属逐层校验，无 latest 回退）。
   Goal 不是 WorkflowVersion、不是 chat history、不可被 model 覆盖；同 commandId 重放返回同一
   run + 同一 goal，同 commandId 异内容 ⇒ ledger 指纹 `CONFLICT`。
2. **RunSnapshot 校验（WHAT NOT）**：生产 engine 经 `runSnapshotVerifier` seam 在每个 stage 执行前
   证明 pin（§11）。
3. **Model binding pinning（WITH WHAT）**：`RunSnapshot.modelBindings` 由受信 application 配置提供，
   创建时对真实 Model Registry 校验（未知/禁用/不可用 ⇒ fail closed，无默认、无 latest），
   run 创建后不可变；读取侧按名字 fail closed。

## T18-03 已落地：Durable Supervisor Decision Sink

### Corrective（T18-03 final）：tenant scope、history reader、evidence contract

三项 Boss 裁定的加固：

1. **`SUPERVISOR_DECISION_TENANT_IDEMPOTENCY_GAP`（已关闭）**：`command_ledger.command_id` 虽是全局
   PRIMARY KEY，但它**有界可 trim** 且 decision sink **从不写 ledger** ⇒ supervisor decision 的 command
   identity 没有任何地方被强制全局唯一。因此：
   - `decisionId = dec_ + sha256("companyos/supervisor-decision/1:" + companyId + ":" + commandId)[0:26]`
     —— 永久身份是 **tenant-scoped** 的，跨公司同 commandId 不会 PK 冲突、不会互相泄漏存在性；
   - fingerprint 以 `companyId` 开头参与哈希 —— 跨 tenant 重放既无法匹配指纹、也无法通过 runId
     解析（run 归属检查先于一切 decision 访问，返回与"不存在"不可区分的 `RUN_MISSING`）。
2. **`SUPERVISOR_DECISION_HISTORY_READER_GAP`（已关闭）**：读者拆成语义明确的两个：
   - `listRunDecisionHistory(companyId, runId)` —— **全历史**（ACTIVE + SUPERSEDED + REVOKED，
     按现有 Decision domain status），tenant-first 过滤（store 的 `listAll()` 是全库扫描，故先按
     companyId 过滤再按 runId 过滤，其它 tenant 的行永不抵达 caller），确定性排序
     `decidedAt → decisionId → version`（不用 SQLite 偶然行序）；
   - `listActiveRunDecisions(companyId, runId)` —— 显式命名的 ACTIVE-only 查询。recovery/audit 读者
     不再偷等于 active-only。
3. **`DECISION_EVIDENCE_REFERENCE_CONTRACT`（已重新核实并收紧）**：`DecisionService` 只把
   `artifact:art_…` / 裸 `art_…` 视为受管 ref 并解析 ⇒ **`val_<id>` 不是 `relatedArtifactRefs` 的
   合法值**。因此 sink 现在：所有 ref 仍经既有 durable resolver 校验（`artifact:…` / `art_…` / `val_…`
   是既有合法语法；`toolinvocation:` / `validation:` / `supervisor:` 一律拒绝，不发明新 namespace），
   但**只有 kind='artifact' 的 ref 才写进 `relatedArtifactRefs`**；每个 ref 的 resolved kind 记录在
   payload seam 中，QA provenance 引用 T17-06 的 validator report Artifact（既有 durable 链：
   ToolInvocation → report Artifact → Validation batch）。

**永久幂等在 version 演进后仍然成立**：原 command 重放返回原始 version 1（同一逻辑身份），
不会因为 version 2 存在而新建逻辑决策，也不覆盖历史（测试 17）。

DecisionStore 从"零 production 写者"变为有**第一个**写者：`createSupervisorDecisionSink`
（engine `supervisor/decision-sink.ts`），经 `composeCoreServices` 的受信 seam 暴露（非 IPC、非 Tool）。

**永久幂等（不依赖 bounded command_ledger）**：

- `decisionId` 由 trusted command identity **确定性派生**（`dec_ + sha256(commandId)[0..26]`），
  落点即 `PRIMARY KEY(decision_id, version)` —— 一个逻辑决策永远只有一行，ledger 被 trim 后依然如此。
- decision fingerprint 存进既有 `metadata` versioned payload seam（`companyos/supervisor-decision/1`），
  覆盖 commandId/runId/stageId/taskId/action/reasonCode/summary/evidenceRefs/binding 身份。
- 同 identity 同 fingerprint ⇒ 原样回放；同 identity 异内容 ⇒ `CONFLICT`
  （`SUPERVISOR_DECISION_FINGERPRINT_MISMATCH`）；并发/崩溃重试同样收敛到一行。

**Record-only（不执行）**：sink 只写 decision 行。REQUEST_CORRECTIVE 不建 Task、COMPLETE 不改 run/stage/task
状态、ESCALATE 不建 approval；Task 表无 runId，stage 归属经 run-pinned 版本图证明。

**上下文前置校验（失败即拒绝，零写入）**：authority（既有 `decision.create`）→ run 归属 → canonical Goal
（无 goal ⇒ `RUN_GOAL_MISSING`）→ snapshot 校验（T18-02 唯一 verifier）→ stage/task 归属 → 动作/原因词表 →
evidence refs（既有 `artifact:art_…` / `val_…` 语法，存在性 + 同 run，无 `toolinvocation:` 发明）→
model binding（只接受 run-pinned binding 名，经 RunSnapshot + registry 解析；任意 provider/model 字段
结构上不可提交）。

## Corrective（T18-04 final）：Review Report 必须绑定真实 AgentExecution

Boss 判定两条硬规则，均已关闭：

1. **`REVIEW_EXECUTION_IDENTITY_FALLBACK_GAP`（已关闭）**：T18-04 原契约 §16 的
   `TASK_ATTEMPT` 退化通道已**移除**。硬侦察确认 `AgentExecution`（`agent-execution.ts:207-233`）
   durable 持有 `executionId / runId / taskId / roleId / agentId / attempt` 与 **binding**
   （`createExecution` 的 `binding` 为必填），因此"ownership 不可证"的前提不成立：
   - `recordReviewReport` 的 `executionId` **必填**；缺失 ⇒ `REVIEW_EXECUTION_REQUIRED`。
   - 加载后逐项验证：存在、`execution.runId === run.id`、`execution.taskId === reviewTask.id`，
     且 **status 必须为 `COMPLETED`**（`CREATED/READY/RUNNING/WAITING_EXTERNAL/FAILED/CANCELLED/
INTERRUPTED` 一律拒绝 ⇒ 不能用 Review Report 冒充 execution failure）。
   - `reviewAttempt` / `agentId` / `roleId` **全部从 execution 行派生**，caller 提供
     `reviewer` / `reviewAttempt` / `agentId` / `roleId` 一律拒绝（`REVIEW_MODEL_IDENTITY_REJECTED`）。

2. **`REVIEW_EXECUTION_MODEL_PROVENANCE_GAP`（不存在，已核实）**：execution durable 记录其
   **实际使用的 binding**。Review Report 的 model provenance 现在**从 execution 派生**，然后证明：

   ```
   execution.binding.modelKey ∈ { RunSnapshot.modelBindings 各 name 解析后的 modelKey }
   ```
   - execution 运行的模型未被本 run pin ⇒ `REVIEW_EXECUTION_BINDING_NOT_PINNED`，拒绝。
   - caller 声称的 `modelBindingKey` 虽被 run pin、但**不是 execution 实际使用的那个** ⇒
     `REVIEW_EXECUTION_BINDING_MISMATCH`，拒绝（"这个模型被 Run 允许"不再足够）。
   - payload 同时记录 `executionBinding {modelKey, providerId, providerModelId}` 与
     `resolvedModelKey`，fingerprint 覆盖 executionBinding。

**身份**：永久 command identity = `companyos/review-findings/1:<companyId>:<runId>:
<reviewTaskId>:execution:<executionId>` ⇒ 同一 execution 只有一份 canonical report
（ledger trim 后仍成立），同 execution 异内容 `CONFLICT`；新 execution ⇒ 新 report，旧报告永久保留。

**排序**：`listReviewHistory` 首排序维度改为 execution 派生出的 `reviewAttempt`，tie-break
`createdAt` → `artifactIdId`；`getLatestReviewReport` 取 latest report（不是 latest PASS）。

**`HANDLER_OUTPUT_CARRIER_GAP` 仍 OPEN**：本 corrective 只收紧"受信 orchestration 记录 report
> 关闭时补注（T18-09）：`HANDLER_OUTPUT_CARRIER_GAP` 已在 T18-07 关闭（结构化 stage-output 通道 + canonical carrier）；本句为当时的快照，终态见 `sprint18/S18_CLOSEOUT.md`。
时必须绑定真实 execution"，未让 AgentRuntime 输出文本自动进入 sink。

## T18-05 已落地：Controlled Corrective Task Provisioning & Durable Lineage

`CORRECTIVE_TASK_PERSISTENCE_GAP` **已关闭**。`REQUEST_CORRECTIVE` Decision 之后：

```
Decision Sink（T18-03）
  → createCorrectiveProvisioner（engine/supervisor/corrective-provisioner.ts，受信 application service）
  → 一条 durable corrective Task（既有 tasks 表，既有 Task 域）
  → parent/root/round/cause lineage（Task.inputs 的 versioned payload seam）
  → 永久幂等 + 崩溃/并发安全
```

**Task 域 recon 结论（实现前硬侦察，全部读真实代码）**：

- Task 行字段：`id / stageId / roleId / kind / state / attempts / maxAttempts / inputs / outputs /
createdAt / updatedAt`（`task.ts:75-97`）——**有 `inputs` payload seam，无 metadata
  seam、无 creationCommandId、无 fingerprint**。
- 主键 = `id`；`createTask` 恒以 `PENDING, attempts=0` 出生（`task.ts:100-123`）。
- **`tasks` 表的 upsert on conflict 只更新 `state/attempts/max_attempts/outputs_json/updated_at`，
  不更新 `inputs_json`** ⇒ lineage 一旦写入不可被覆盖（这正是永久 lineage 的存储基础，
  也意味着 provisioner 的 conflict 检测必须重算 fingerprint，见下）。
- `createTask` 的 production reachability 依然是零（只有测试/fixture）；Engine 只执行
  `StageExecutionRequest.taskIds` 里给定的 task（`engine.ts:659`），不会自行发现 corrective task
  ⇒ **T18-05 只创建 work item，不启动它**。
- 因此 corrective task 是 **runtime execution work item**，不是 workflow 定义变更：
  WorkflowVersion / RunSnapshot / stage graph / Pack manifest 全部零改动。

**永久身份与幂等**：

- `taskId = tsk_ + sha256(canonical{namespace, companyId, runId, originDecisionId,
originDecisionVersion})[0:26]` ⇒ **tenant-scoped**（R27），一个 Decision version
  永远至多一个 corrective task。
- lineage fingerprint 覆盖 companyId/runId/decisionId/version/reasonCode/parent/root/round/
  sorted causeEvidenceRefs。
- **conflict 检测是双重比对**（测试暴露后加固）：(a) 重算既有 lineage 自身的 fingerprint 必须
  等于其存储值（否则行被篡改）；(b) 必须等于本次决策派生值。单比存储字段可被"保留旧
  fingerprint 改语义"绕过。

**授权规则**：只接受 durable、ACTIVE、**current version** 的 `REQUEST_CORRECTIVE` Decision；
跨 company / 跨 run / 非 REQUEST_CORRECTIVE / REVOKED / SUPERSEDED 的旧 version 一律拒绝。

**Cause 词表（V1）**：

- `REVIEW_FINDING`：必须引用同 company/同 run 的 `companyos:review-findings` artifact，
  verdict 必须 `CHANGES_REQUESTED`，且该 report 必须仍是该 review task 的 **latest actionable**
  report（anti-cherry-pick）；parent = report 的 `subjectTaskId`（**不是 review task**）。
- `VALIDATION_FAILED`：必须引用同 run 的 `companyos/repository-qa-evidence` report，
  且必须是该 run **最新**的一份（latest batch wins）且 verdict 非 PASS；parent 由 report
  evidence slots 的 tool invocation `taskId` 解析（不用 stage 启发式）。
- `TASK_FAILED` / `TOOL_FAILED`：**V1 拒绝**（无可机读的 durable cause contract）。

**继承规则**：child 只继承 parent 的 `kind / stageId / roleId / maxAttempts` 与 work payload
（剥掉 lineage 键，避免嵌套漂移）；**不继承** state/attempts/outputs/时间戳/execution id/
baseline/QA/review PASS。

**读者**：`getCorrectiveLineage`（跨验证祖先链：parent 存在、无环、round/root 一致、
origin Decision 确为 REQUEST_CORRECTIVE）、`listCorrectiveChildren`（确定性、tenant-safe）。

**零执行**：provision 只插一行 task；无 AgentExecution、无 repo baseline、无 ToolInvocation、
无 Validation、无 Review Report、无自动 Decision。

## 已知限制 / 延后

### T18-04 已落地：Structured Reviewer Findings & Durable Review Report

`REVIEW_FINDING_DURABILITY_GAP`（G3）**已关闭**。Reviewer 从"一段自由文本"升级为：

```
model output → schema parser → trusted review runtime（未来 T18-06）
  → createReviewFindingsSink（engine/supervisor/review-findings-sink.ts，受信 application service）
  → ArtifactService → 不可变 run-owned Artifact（kind companyos:review-findings）
```

**纯域契约**（`packages/core/src/lifecycle/review-findings.ts`）：`companyos/review-findings/1`；
verdict 词表 `PASS | CHANGES_REQUESTED | BLOCKED`；finding = `{findingId, code, summary, detail,
blocking, subject?, locator?, evidenceRefs[], fingerprint}`；`findingId`/`fingerprint` 系统派生
（`rf_<sha256>`，覆盖 code/blocking/summary/detail/subject/locator/sorted refs，**不含** createdAt、
随机 id、数组顺序）；同 report 内语义重复 finding 确定性去重；界限已文档化
（max 64 findings / summary 2000 / detail 8000 / 16 refs per finding / locator 400）。

**Report != QA**：PASS 只表示"reviewed scope 内无 blocking 语义发现"，**不产生** Validation、
不进入六个 QA evidence slots、不放行 EvidenceGuard。Reviewer finding 是 durable semantic **claim**。

**永久幂等**：artifact command identity 是 tenant-scoped 的
`companyos/review-findings/1:<companyId>:<runId>:<reviewTaskId>:<execution identity>`；同一逻辑
review execution + 同报告 ⇒ 同一 artifact（ledger trim / fresh process 后仍成立）；同 execution
不同内容 ⇒ `CONFLICT`；新 execution ⇒ 新 report，旧报告永久保留。报告字节**确定性**：创建时刻与
作者以 artifact 行为唯一来源，不进 payload（否则重放字节不同会被误判 CONFLICT）。

**执行身份**：优先 `AgentExecution`（经 `agentExecutions` store 验证 execution.runId/taskId 归属），
否则退化为 reviewed task 的 durable attempt（`attempt:<n>`）——已在报告与文档中如实标注
`Review Execution Identity = TASK_ATTEMPT`（无 execution 时）。

**读者**：`listReviewHistory(companyId, runId, reviewTaskId)`（全历史，确定性排序
attempt → createdAt → artifactId）与 `getLatestReviewReport`（**latest report，不是 latest PASS**
——anti-cherry-pick）。读者不设 authority 门：读取边界由 company + run + payload 结构性校验承担
（Sprint 13 冻结 `artifact.read` 为保留词、不得有运行期强制点）。

**证据语法**：只用既有 `artifact:art_…` / `art_…` / `val_…`；`toolinvocation:` / `review:` /
`finding:` 一律拒绝；每个 ref 记录 resolved kind，validation 身份**不伪装**成 artifact ref；
QA provenance 引用 T17-06 的 validator report Artifact。

**零副作用**：记录报告不建 Task / 不改 Task 状态 / 不改 Stage / 不改 Run / 不建 Decision /
不建 Validation / 不触碰 EvidenceGuard / repository 不变 / ToolRegistry 不变 / authority 目录不变 /
DevCompany 零改动。

## T18-06追加裁定：Supervisor Decision Runtime（一次有界 turn）

- **只记录不执行**：`runOneSupervisorDecisionTurn` 是 Supervisor 的第一个生产消费者，但它只做
  "取事实 → 组装有界 context → 调用 pin 模型一次 → 严格解析 → 语义前置校验 → 经 T18-03 sink
  落 Decision → 完成 execution"。它不 provision corrective work、不 advance engine、不批准、
  不通知（T18-07 拥有执行语义）。
- **binding 唯一来源**：Supervisor 自身的模型只能来自 `RunSnapshot.modelBindings` 中由受信
  应用配置指定的名字（默认 `supervisor`）；没有默认、没有 latest、没有回退，调用方无法提供
  任何模型身份（providerId / providerModelId / modelKey / modelVersion 一律拒绝）。
- **结构上无 tool / 无 spawn**：Supervisor 模型看不到任何工具（不声明 descriptors、不跑 tool
  round、本模块不依赖 tool registry），因此"不要派 Agent"不是 prompt 请求而是构造事实。
- **语义前置校验优先于 prompt**：action↔reasonCode 封闭配对表 + CONTINUE/ESCALATE/COMPLETE/
  REQUEST_CORRECTIVE 的机器可校验前置条件（latest review / latest validation / subject task
  状态）；模型说"COMPLETE"而 durable 状态不成立 ⇒ 拒绝且零 Decision。
- **全 turn 取消/超时**：一个 AbortSignal + 一个 deadline 覆盖加载、校验、context、binding、
  execution setup、模型调用、解析、语义校验与 Decision 落盘。提交前取消 ⇒ 零 Decision；
  提交后取消 ⇒ Decision 仍幂等（同 identity retry 零模型调用）。
- **不新增 loop 语义**：一次调用 = 一次 turn；无 `while`、无 scheduler、无
  `maxCorrectiveRounds`（T18-07）。

## T18-06 corrective：取消必须真实到达 provider（Boss: PASS WITH REQUIRED FIX）

- **拒绝的伪取消**：`Promise.race` 让 Supervisor 停止等待而 provider 继续跑 = 幽灵执行
  （记录说 CANCELLED，外部副作用还活着）。本 corrective 将其移除。
- **canonical 契约**：`InvocationRequest.signal?: AbortSignal`（optional，未提供者行为不变）；
  adapter 必须传播到真实模型调用并在触发时终止，标准返回 `err(CANCELLED)`；不得抛异常、
  不得重试、不得回退到别的 provider/model（same pinned model only）。
- **ProviderRegistry 不重新分类取消**：`CANCELLED` 原样上抛并审计 `provider.cancelled` ——
  把取消洗成 `AGENT_UNAVAILABLE` 会把它伪装成可重试的 provider 故障。
- **resultRef 不自造 namespace**：`resultRef` 是 Sprint 13 冻结契约里的不透明字符串，仓库里
  没有 canonical Decision ref grammar；T18-06 原写的 `decision:<id>@<version>` 已移除，两行
  以 `traceId` 关联。
- **引擎不装定时器**（boundary gate）：mock adapter 的在飞窗口由注入 sleeper 提供。

## T18-07 追加裁定：有界自主编排与停止条件（Accepted）

- **上界是受信不变量，不是提示词**：`maxSupervisorTurns = 20`、`maxCorrectiveRounds = 3`（V1 Boss
  裁定）。round 上限实现在 T18-05 provisioning 边界本身，因此直接调用 provisioner 也无法绕过——
  上限属于领域边界，不属于某个调用方。
- **模型输出是非权威提案**：Decision Applicator 是受信确定性接缝；模型 never 直接调用 Engine /
  Provisioner / Tool。Applicator 只应用 current ACTIVE Decision 版本，并在应用前重读关键 durable
  状态（TOCTOU 防护）。
- **一次 Decision 一次效果，永久**：application receipt 骑在既有 artifact 原语上，身份由
  (runId, decisionId, version) 派生；不依赖有界 command ledger；ledger trim / restart / 并发均收敛。
- **人工升级复用既有 Approval 接缝**：不新增 `run.approve` token、不新增等待状态；pending Approval
  - `Run.state = WAITING_APPROVAL` 即为耐久且机器可读的人工等待，结构性阻止继续自治执行；
    恢复 = 一次受信 `APPROVAL.GRANT`。
- **取消是终态**：`FAILED + error_kind=CANCELLED` 永不进入自动重试；编排器在任何 turn 之前检查。
- **诚实保留**：`HANDLER_OUTPUT_CARRIER_GAP` 仍 OPEN（`StageHandlerOutcome` 无结构化通道），本次
  不解析 prose、不闭合该缺口，避免用文本猜测冒充证据。

## T18-07 corrective 追加裁定：carrier / pinned binding / evidence lifecycle / crash window（Accepted）

- **允许拓宽 Sprint 2 handler 契约到最小必要程度**：`StageHandlerOutcome` 变为
  `{ status, output? }`，`output` 是 versioned `companyos/stage-output/1` 信封；裸字符串仍合法，
  经**一个**归一化边界收敛。引擎把信封写进 Task 既有 `outputs`（与 DONE 同 step）——不新表、
  不迁移。
- **每个领域只有一个写者**：reviewer 结果只进 T18-04 ReviewFindingsSink，QA 结果只进 T17
  canonical ValidationService；executionId 由 carrier 对照 durable 行校验，不可伪造；禁止散文
  解析 / `"PASS"` grep / JSON 子串提取。
- **Run 生命周期只能由 canonical 证据驱动**：一个 evidence applicator 把 latest canonical
  review/validation 映射到唯一合法 Run 事件，anchors 从 durable validation 行派生，应用前重读。
  调用方与模型都不能直接下达生命周期事件。
- **自主执行路径的模型只来自 RunSnapshot**：`pinnedAgentExecution` 方法面无 model 身份参数；
  通用 AgentRuntime 低层入口保留给既有非自主调用方，但不再作为自主执行 API。
- **receipt 不构成 exactly-once 的充分条件**：receipt 写在 action 之后（如实记录，非同一
  事务）；四个 action 各自以永久身份自证幂等，terminal run 从 durable decision history 补写
  缺失 receipt（纯记账）。HANDLER_OUTPUT_ATOMICITY 记为 PARTIAL，由注入式 checkpoint 测试证明。
  **不伪造原子性。**
- **保留**：`maxCorrectiveRounds = 3`、`maxSupervisorTurns = 20`、`run.approve` 不进入
  authority 目录、requester ≠ decider。

## 未决事项（未获批准前不得开工）

- corrective task provisioning、Supervisor decision sink、reviewer findings、corrective loop 本体
  均在后续 Task，未获批准前不得开工（T18-02~T18-06 已分别获准并 CLOSED；余下 T18-07 起等批准）。
- `task.create` / `task.read` / `workflow.read` / `run.approve` 等 authority 缺口（治理债务）。
- production IPC 尚未提交 goal（本 Sprint 不做 UI/IPC）；因此生产创建的 run 暂无 goal，
  `getRunGoal` 对其 fail closed —— 这正是"不许猜"的语义。
- run 创建幂等回放依赖 `command_ledger`；ledger trim 后的重放会创建新 run（goal 工件本身永久不可变）。
