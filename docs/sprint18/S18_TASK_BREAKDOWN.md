# Sprint 18 — Autonomous Supervisor & Corrective Loop 任务分解（T18-01 冻结）

> 状态：**FROZEN（T18-01 输出）；T18-02~T18-06 已 CLOSED**。严格线性依赖，逐 Task Boss 批准后执行；任何 Task 的
> 范围变化都必须先回到 `S18_AUTONOMOUS_SUPERVISOR_CONTRACT.md` 重新冻结。
> T18-02 冻结的 Task 顺序已由 Boss 裁定为 10 项（T18-01~T18-10），见下文。
> 依赖：`sprint-17`（Repository Runtime CLOSED）、`docs/EXECUTION_ROADMAP.md`、
> ADR-0028（Accepted）。上游 recon 全部 `path:line` 见契约 §4。

## Scope Ruling（BOSS-FROZEN）

Sprint 18 = 在既有 Decision / Approval / Handoff / CommandLedger / Artifact / Validation /
EvidenceGuard / Recovery 之上，交付 **run 范围内的 Supervisor 决策与纠正回路语义**：
可审计的决策账本、正确的 retry-vs-corrective 分离、review-vs-QA 分层、停止条件与人工升级、
崩溃安全的幂等。**本 Sprint 不交付 autonomous loop 本体**（契约 §2.1）。

## 依赖图

```
T18-01（本文档 + 契约 + 测试策略，已完成，零 runtime 改动）
   └─> T18-02  Run Goal 落盘 + snapshot 校验加固  ─┐
         └─> T18-03  Supervisor Decision Sink  <─┘
               ├─> T18-04  结构化 Review Findings 契约（需单独批准）
               ├─> T18-06  Supervisor Decision Runtime（一次有界 turn）
               │     └─> T18-07  停止条件 + 受控入口 + 人工升级组合
               └─> T18-05  Controlled Corrective Task Provisioning（CLOSED）
T18-05  Controlled Corrective Task Provisioning + Durable Lineage（**CLOSED**）
T18-08  E2E 与 closeout（最后）
```

## Tasks

### T18-01 Supervisor Architecture Recon & Contract Freeze（**已完成**）

三份 `docs/sprint18/` 文档 + 全量只读 recon（98 个 `path:line` 结论）+ gap 清单 G1~~G9 +
四个开放问题（Q1~~Q4）。零 production/test/migration/docs 外改动。无 tag。

### T18-02 Durable Run Goal, Snapshot Verification & Model Binding Pinning（**CLOSED**）

- **关闭 gap**：`RUN_GOAL_CONTEXT_GAP`（G1）、`SNAPSHOT_VERIFY_PRODUCTION_GAP`（G8）、
  `MODEL_BINDING_RUN_PINNING_GAP`（G9，最小闭环：pin/validate/retrieve + fail-closed seam，
  尚无 production 消费者——Supervisor 绑定留给 T18-06）。
- **已实现**（零 migration / 零 schema 变更 / 零新表 / 零新 authority / 零新 Tool）：
  - Run Goal 契约 + writer/reader 落 **Core `lifecycle/run-goal.ts`**（纯域）与
    **Engine `goal/run-goal-service.ts`**（Artifact/CAS）：run-owned immutable artifact，
    kind `companyos:run-goal`，`run-goal:<runId>` 寻址，与 run 同事务写入，
    `getRunGoal({runId, companyId})` 逐层归属校验。
  - run 创建幂等：`CreateRunInput.commandId` + 既有 command ledger 指纹回放
    （同键同内容 ⇒ 同一 run/goal；同键异内容 ⇒ `CONFLICT`）。
  - snapshot 生产校验：Core `verifyRunSnapshot` 经 `createRunSnapshotVerifier` 注入 engine 的
    `runSnapshotVerifier` seam，在 `executeStage`（drive/advance 的唯一权威入口）任何 task 写入前执行。
  - model binding pinning：Core `lifecycle/run-model-bindings.ts`（受信配置校验：未知/禁用/不可用 ⇒
    fail closed）+ Engine `createRunModelBindingReader`（按名检索，缺失 ⇒ fail closed，无默认）。
  - 生产接线移入 `composeCoreServices`（`core.lifecycle`），main.ts 复用同一实例。
- **范围**：
  1. 按契约 R3 选定 run goal 承载体（**默认建议：`Artifact`，kind 受控白名单，内容进 CAS**），
     在 run 创建路径写入；不改 `RunSnapshot` pin 集、不改 schema。
  2. 在既有 `advance` 入口补一次 `verifyRunSnapshot`（只读；失败 fail closed）。
- **HARD STOP**：不得改 `SnapshotPinnedFields`；不得改 `snapshotHashOf` 语义；
  不得引入 migration；不得改 `WorkflowRun` 字段；不得让 goal 文本绕过 secret 检查
  （`validateDecisionSafety` 模式可复用）。
- **必测**：goal 落盘后可读（restart 后）；goal 不会进 snapshot 哈希；`verifyRunSnapshot`
  篡改检出（正向 + 负向）；旧 run（无 goal）不 fail closed 于无关路径。
- **Commit**：`feat: persist run goal and verify run snapshots`

### T18-03 Supervisor Decision Sink（DecisionStore 的第一个 production 写者）

- **关闭 gap**：`SUPERVISOR_DECISION_PERSISTENCE_GAP`（G2）。
- **范围**：`packages/engine/src/supervisor/`（placement recon 先行，零 Core/Contracts 改动）
  落 `createSupervisorDecisionSink`：输入（`question/decision/rationale/alternatives/provenance/
relatedRefs/traceId/actorId`）→ 经 `decision.create` authority 检查 → 一条事务内
  `DecisionRecord` + 事件；确定性幂等键（参照 `task-baseline:<runId>:<taskId>` 与
  `retryIdempotencyKey` 先例）。
- **HARD STOP**：不得新增加权（R6）；不得新建表（§2.4）；不得写 memory；不得触发任何 run 命令
  （本 Task 只做账本）；决策文本必须过 secret 检查；重复同键同内容 ⇒ 回放，不同内容 ⇒ `CONFLICT`。
- **必测**：幂等重放、同键异内容 `CONFLICT`、无 authority 拒绝、secret 拒绝、restart 后可读、
  provenance sourceType closed set、relatedRefs 引用完整性（artifact/validation/handoff）。
- **Commit**：`feat: add supervisor decision sink`

### T18-03 Durable Supervisor Decision Sink（**CLOSED**）

- **关闭 gap**：`SUPERVISOR_DECISION_PERSISTENCE_GAP`（G2，Record-only 一层）。
- **Decision 域 recon 结论（实现前硬侦察）**：`decisions` 表已存在（`migrations/memory/0001_memory.sql:12-23`），
  `PRIMARY KEY(decision_id, version)`；**无** `creation_command_id` 列、**无** fingerprint 列；
  `create` 是纯 INSERT（重复 PK 抛错）；`metadata_json` 是现成的 versioned payload seam；port 只有
  `create/update/get/listVersions/listActive/listAll`，**无** run 维度读法。
- **永久幂等裁决（不加 migration）**：decisionId 由 trusted command identity 确定性派生 ⇒ PK 即永久身份；
  fingerprint 存 `metadata` ⇒ trim 后仍可辨别同 identity 异内容。`command_ledger` 不再参与正确性。
- **词表**：action = `CONTINUE | REQUEST_CORRECTIVE | ESCALATE | COMPLETE`；reasonCode =
  `VALIDATION_FAILED | REVIEW_FINDING | TASK_FAILED | TOOL_FAILED | GOAL_SATISFIED | HUMAN_REQUIRED | NO_LEGAL_ACTION`
  （closed set；域校验拒绝未知值）。
- **验证顺序**：authority（既有 `decision.create`）→ run/company → canonical Goal → snapshot 校验 →
  stage/task 归属 → 词表 → evidence refs（既有 `artifact:`/`val_` 语法 + 同 run）→ model binding
  （只接受 run-pinned binding 名）→ 落行（同事务 + 审计事件）。
- **Record-only**：REQUEST_CORRECTIVE 不建 Task、COMPLETE 不改状态、ESCALATE 不建 approval（测试 28-30/34 证明）。
- **读者**：`getDecision` / `listRunDecisionHistory`（全 status、tenant-first、确定性排序）+ `listActiveRunDecisions`（显式 active-only）。
- **生产接线**：`composeCoreServices().supervisorDecisionSink`（受信 application seam，非 IPC、非 Tool）。
- **Corrective（Boss 三项，已关闭）**：
  - `SUPERVISOR_DECISION_TENANT_IDEMPOTENCY_GAP` ⇒ decisionId/fingerprint 改为 tenant-scoped（companyId 进哈希）。
  - `SUPERVISOR_DECISION_HISTORY_READER_GAP` ⇒ `listRunDecisionHistory`（全 status、tenant-first、确定性排序）与 `listActiveRunDecisions`（显式 active-only）分离。
  - `DECISION_EVIDENCE_REFERENCE_CONTRACT` ⇒ `val_<id>` 不是 `relatedArtifactRefs` 合法值；只有 artifact kind 写入该字段，validation 身份在 payload seam 中带 kind 记录；QA 引用 T17-06 report Artifact。

### T18-04 Structured Reviewer Findings & Durable Review Report（**CLOSED**）

- **关闭 gap**：`REVIEW_FINDING_DURABILITY_GAP`（G3，**CLOSED**）。`HANDLER_OUTPUT_CARRIER_GAP`（G7）按 §64 保持 **OPEN**：本 Task 建立 durable review report contract + writer，不改 StageHandler 结果类型。
- **裁决**：Supervisor != DevCompany CTO、Review != QA、Reviewer 不能宣称测试通过、report 是 durable semantic claim、report 不执行纠正。
- **实现**：
  - 纯域契约 `packages/core/src/lifecycle/review-findings.ts`（`companyos/review-findings/1`、verdict 词表 `PASS|CHANGES_REQUESTED|BLOCKED`、finding 形状、系统派生 `rf_<sha256>` findingId/fingerprint、同 report 确定性去重、bounds）。
  - Writer `packages/engine/src/supervisor/review-findings-sink.ts`：受信 application service（非 Tool、非 IPC），写入走既有 ArtifactService；command identity 为 tenant-scoped 的 `companyos/review-findings/1:<companyId>:<runId>:<reviewTaskId>:<execution>` ⇒ 同一逻辑 review execution 只有一份 canonical report（ledger trim 后仍成立），同 execution 异内容 CONFLICT，新 execution 才产生新 report。
  - 读者：`listReviewHistory`（全历史，`attempt → createdAt → artifactId` 确定性排序）、`getLatestReviewReport`（**latest report，不是 latest PASS**，anti-cherry-pick）、`getReviewReport`。读取边界由 company + run + payload 结构性校验承担（Sprint 13 冻结 `artifact.read` 为保留词，不得有运行期强制点 ⇒ sink 无 read authority 门）。
  - 执行身份（corrective 后）：`executionId` 必填；attempt/agent/role/binding 全部从 AgentExecution 行派生；
    execution 必须属于本 run + 本 review task 且 `COMPLETED`；**TASK_ATTEMPT 退化通道已移除**。
  - 模型 provenance：从 execution 实际 binding 派生，并证明该 modelKey 被本 run pin；声称的 binding 名
    若非 execution 实际使用者 ⇒ 拒绝。
  - 生产接线：`composeCoreServices().reviewFindingsSink`（E2E 走同一入口）。
- **零副作用**：不建 Task / 不改 Task 状态 / 不改 Stage / 不改 Run / 不建 Decision / 不建 Validation / 不触碰 EvidenceGuard / repository 与 ToolRegistry 不变 / authority 目录不变 / DevCompany 零改动（测试 40–50 证明）。

### T18-05 Controlled Corrective Task Provisioning & Durable Lineage（**CLOSED**）

- **关闭 gap**：`CORRECTIVE_TASK_PERSISTENCE_GAP`（G4，**CLOSED**）。Boss 裁定 Q1 = 受控
  provisioning，复用既有 Task 域，不建第二套表、不加 migration、不加 authority、不加 Tool。
- **Task 域 recon**：Task 有 `inputs` payload seam、无 metadata/creationCommandId/fingerprint；
  主键 `id`；`createTask` production reachability 为零；tasks 表 upsert **不覆写 inputs_json**
  （永久 lineage 的存储基础）。
- **实现**：Core `lifecycle/corrective-task.ts`（schema、tenant-scoped taskId、lineage
  fingerprint、payload 编解码）+ Engine `supervisor/corrective-provisioner.ts`
  （provision / getCorrectiveLineage / listCorrectiveChildren）+
  生产接线 `composeCoreServices().correctiveProvisioner`。
- **零执行**：只插一行 task（PENDING / attempts=0）；无 AgentExecution、无 baseline、
  无 ToolInvocation、无 Validation、无 Review Report、无自动 Decision。
- **conflict 检测双重比对**（测试暴露后加固）：重算既有 lineage 的 fingerprint 必须等于其
  存储值，且等于本次派生值。

### T18-06 Supervisor Decision Runtime（**CLOSED**）

一次有界 Supervisor 决策 turn：load Run → load Goal → 校验 snapshot → 解析 pinned binding →
组装有界 SupervisorContext → 创建 durable AgentExecution → **调用模型一次**（结构化契约）→
严格解析 → 语义校验 → 经 T18-03 sink 落 Decision → complete AgentExecution → 返回 Decision。

- **关闭 gap**：`SUPERVISOR_DECISION_RUNTIME_GAP`（契约 §3 的执行层缺口）、
  `SUPERVISOR_PINNED_MODEL_CONSUMER` 对 Supervisor 自身**已闭合**（T18-02 遗留的
  `GENERIC_AGENT_PINNED_MODEL_CONSUMER` 仍开放，属 T18-07 范围）。
- **已实现**（零 migration / 零 schema 变更 / 零新表 / 零新 authority / 零新 Tool）：
  - Engine `supervisor/supervisor-runtime.ts`：`createSupervisorDecisionRuntime`
    （`buildContext` 只读 + `runOneSupervisorDecisionTurn` 一次 turn）+ 提案契约
    `companyos/supervisor-proposal/1`（`decodeSupervisorProposal` 严格解码，无子串提取/无修复）。
  - AgentRuntime 新增**只增不减**的 defer/settle 接缝（`runWithOutput` / `completeExecution` /
    `failExecution` + `deferCompletion`）：`run` 的既有契约与逐字行为不变； provider 用量
    （input/output tokens）原样回填，未被清零。
  - 生产接线 `composeCoreServices().supervisorDecisionRuntime`：受信配置
    `ComposeCoreServicesOptions.supervisorBindingKey`（默认 `supervisor`），缺链 ⇒ null（无降级 turn）。
- **结构约束（非 prompt 规则）**：Supervisor 模型**看不到任何 tool**（不声明 descriptors、
  不跑 tool round、runtime 本身不依赖 tool registry），无法 spawn/subagent；binding 只能来自
  `RunSnapshot.modelBindings`（无默认/无 latest/无回退/无调用方模型身份）。
- **全 turn 取消/超时**：一个 AbortSignal + 一个注入式 deadline 覆盖 Run/Goal/snapshot/context/
  binding/execution setup/模型调用/解析/语义校验/Decision 落盘；提交前取消 ⇒ 零 Decision，
  提交后取消 ⇒ Decision 仍幂等（retry 零模型调用）。provider 端口无 AbortSignal，
  飞行中请求是**被放弃**而非被取消（已记录为限制）。
- **HARD STOP**：本 Task 不含 autonomous loop、无 `maxCorrectiveRounds`（T18-07）、
  不调用 Corrective Provisioner、不 drive/advance、无审批/人工状态、无 IPC/UI、无 shell/hook。
- **必测**：52 项矩阵（`tests/sprint18/supervisor-decision-runtime.test.ts`）+
  生产 E2E 四条（`...-production.test.ts`：review 失败 / QA 失败 / COMPLETE / restart 重放）。
- **Commit**：`feat: add supervisor decision runtime`

### T18-07 Bounded Autonomous Supervisor Loop & Stop Conditions（**CLOSED**）

- **新增**：Engine `supervisor/autonomous-supervisor.ts`（`createAutonomousSupervisorRuntime`）——
  **唯一**编排器：Goal → T18-06 Supervisor turn（原样复用，无第二条模型路径）→ Decision →
  **Decision Applicator**（受信确定性接缝，模型输出永不直接调用 Engine/Provisioner）→
  work / corrective / stop → 新 durable 证据 → 下一 turn → … → COMPLETE 或 ESCALATE。
- **单一事实**：编排器不自持 Task/Run/Decision 状态、retry ledger 或 workflow graph；
  唯一写入物是 **application receipt artifact**（`companyos:supervisor-application`），
  身份由 `supervisor-application:<runId>:<decisionId>@<version>` 派生 ⇒ 一个 Decision 版本
  永远只有一次效果（不依赖有界 ledger；ArtifactService.create + ArtifactStorePort.getByCreationCommand）。
- **有界循环**：`maxSupervisorTurns = 20`、`maxCorrectiveRounds = 3`（Boss V1 裁定，受信应用配置）；
  迭代非递归；每轮前检查硬计数；连续无 durable 进展（revision/task 状态/decision id 指纹）达
  `maxIdleTurns` ⇒ fail-closed 停止。
- **round 上限在 provisioner 边界**：T18-05 provisioner 的 `provision` 在派生 round 之后、
  构造 Task 之前执行上限检查；超过 ⇒ `LIMIT_EXCEEDED` + `CORRECTIVE_ROUND_LIMIT_EXCEEDED`，
  **零 Task**。直接调用 provisioner 同样受限（无绕过）。
- **CONTINUE = 恰好一个合法工作单元**：由 run 的 PINNED WorkflowVersion 图（拓扑序，nodes 数组序为
  确定性 tie-break）+ Task 行（task.stageId ∈ pinned 节点集）推导下一个仍有非终态 task 的 stage；
  没有"猜 stage 名 / pack 数据 / conversation"。
- **Decision 应用映射**（每条都是 canonical service 调用，绝不直接改 run/task/decision 行）：
  CONTINUE → `engine.advance(stage)`；REQUEST_CORRECTIVE → T18-05 `provision` + `engine.advance`；
  COMPLETE → `engine.dispatch(DELIVERY.COMPLETE)`（仅 FINALIZING 合法，前置条件在应用前重读）；
  ESCALATE → `engine.dispatch(APPROVAL.REQUEST)`（riskLevel 来自受信配置）。
- **人工升级 = 既有耐久接缝**：pending Approval 行 + `Run.state = WAITING_APPROVAL`；从该状态没有任何
  合法 run 事件能继续工作 ⇒ 结构性阻塞，可机器读取，restart 后仍成立。恢复 =
  `resumeEscalatedRun` → 一次 `APPROVAL.GRANT`（authority 由受信调用方按 engine driver 既有方式提供；
  **不新增 token**；decider ≠ requester 由 `decideApproval` 强制）；无 pending ⇒ 确定性拒绝
  （`AUTONOMOUS_RESUME_NOT_WAITING`）。
- **取消**：一个 AbortSignal + 一个 deadline 覆盖整个 autonomous run，并向每个 turn 传播；
  提交前取消 ⇒ 零效果；已提交的 durable 状态保留；`CANCELLED` 执行（FAILED + error_kind=CANCELLED）
  是终态非成功，编排器**在任何 turn 前**检查并停止，绝不进入自动重试。
- **corrective 已闭合的缺口**（Boss BLOCKED 后的 corrective，见下节）：`HANDLER_OUTPUT_CARRIER_GAP`、
  `GENERIC_AGENT_PINNED_MODEL_CONSUMER`、`EVIDENCE_TO_RUN_LIFECYCLE_GAP`、
  `DECISION_APPLICATION_CRASH_WINDOW`。
- 同案保留：`HUMAN_GOAL_PRODUCT_INGRESS_GAP`（IPC/UI 不在本 Sprint）。

### T18-07 corrective（Boss BLOCKED 后执行）

- **REVIEW_OUTPUT_CARRIER = CLOSED**；**QA_OUTPUT_CARRIER = CLOSED**；
  **HANDLER_OUTPUT_CARRIER_GAP = CLOSED**：Boss 授权把 Sprint 2 handler 契约拓宽到最小必要
  程度——`StageHandlerOutcome` → `{ status, output? }`，`output` 是 versioned
  `companyos/stage-output/1` 信封；裸状态字符串经**一个**归一化边界（
  `normalizeStageHandlerResult`）汇成同一种规范形式，引擎自此只认一种。
- **Task.outputs 成为耐久载体**：引擎在把 task 迁到 DONE 的同一个 step 写入信封，
  "Task DONE 但载体缺失"在事务内不可能出现；信封不得携带 transcript / raw stdout /
  无界 source / 作为权威的散文。
- **carrier**（`supervisor/stage-output-carrier.ts`）：reviewer 候选 → T18-04 ReviewFindingsSink
  （`companyos:review-findings` 的唯一写者）；QA 候选 → T17 canonical ValidationService
  （Validation 行的唯一写者）。executionId 对照 durable 行校验（存在/同 run/同 task/已
  COMPLETED）⇒ 不可伪造；无第二写者、无散文解析、无 `"PASS"` grep、无 JSON 子串提取。
- **evidence applicator**（`supervisor/evidence-lifecycle.ts`）：canonical 证据 ⇒ 唯一合法 Run
  事件（REVIEW.PASS / REVIEW.REJECT / VALIDATION.PASS / VALIDATION.FAIL），anchors 从 durable
  validation 行派生，应用前重读（TOCTOU）。**EVIDENCE_TO_RUN_LIFECYCLE_GAP = CLOSED**。
- **pinned agent execution**（`supervisor/pinned-agent-execution.ts`）：自主执行路径唯一模型
  入口，`RunSnapshot.modelBindings[bindingKey] → ModelRegistry → AgentRuntime`，方法面无 model
  身份参数；缺失/禁用 ⇒ fail closed 且零 provider 调用，无 fallback。
  **GENERIC_AGENT_PINNED_MODEL_CONSUMER = CLOSED（自主路径）**。
- **Decision application 崩溃窗口**：receipt 写在 action 之后（已如实记录，非同一事务）；
  四个 action 各自用永久身份自证幂等（CONTINUE 以 durable Task 状态 / corrective 以永久 task 身份 /
  ESCALATE 以唯一 pending Approval / COMPLETE 以 run 终态），terminal run 从 durable decision
  history 补写缺失 receipt（纯记账）。**DECISION_APPLICATION_DURABILITY_GAP = CLOSED**
  （无新表/迁移）。
- **HUMAN_ESCALATION_STATE_GAP = CLOSED**（跨 restart 耐久、机器可读、结构性阻止自治执行、
  resume 语义确定；UI/IPC 缺失属产品入口）。
- **HANDLER_OUTPUT_ATOMICITY**：action 与 receipt 不同事务 ⇒ 记为 PARTIAL，靠 per-action 永久
  身份与注入式 checkpoint 测试（36–40）证明；不伪造原子性。

### T18-07 corrective 剩余（诚实记录）

- **PRODUCTION_TURN_TWO_DEFECT**：生产 composition 中一次 autonomous run 的**第二个**
  Supervisor turn 目前以 `invariant_failure` 停止（单元矩阵 items 1–10 已端到端证明该 turn 的
  正确行为；生产接线路径上尚未复现同样成功）。因此 §52/42 与 §52/43–45 两个生产 E2E 暂以
  `it.skip` 保留在 `tests/sprint18/autonomous-production-paths.test.ts`，未假装通过；已通过的
  §52/41 证明生产 composition 上 CONTINUE → 一个有界工作单元 → 引擎自身迁移的真实链路。

### T18-08 End-to-End Verification & Closeout

- **范围**：实现契约 §11 的 8 条停止条件 + 受控入口（由 recon 决定挂在既有哪个入口；
  无常驻循环、无 scheduler、无新 IPC）。每个入口调用前做 §11 全量评估，任一命中 ⇒
  落 `OBSERVE` decision 并返回，不产生副作用。
- **HARD STOP**：无 `setTimeout`/定时器进入 engine（boundary gate）；无 vendor/industry
  noun 作为标识符（engine 边界）；不得在 engine 内新增第二个 dispatcher（R1）；
  不得直接 spawn 进程或写文件（§2.10）；每 Task 的 corrective 必须携带 ledger 键（R9）。
- **必测**：逐条停止条件一条负例（8 项最小）；预算耗尽/证据缺失/快照错配/恢复中/
  审批未决/键冲突各自 fail closed；停止后无任何 durable 副作用（除 decision 本身）。
- **Commit**：`feat: enforce supervisor stop conditions`

### T18-08 End-to-End Verification & Closeout

- **范围**：真实 production composition（`composeCoreServices` 入口）+ 真实 SQLite/CAS 的
  E2E：goal → decision sink → evidence 读取 → 停止条件 → 升级 → 人工决定 → correct 重试；
  外加 DevCompany Pack 不变量回归（24 refs / 5 pack roles / owner 1 / 1 workflow /
  0 自动分配）。
- **HARD STOP**：E2E 必须复用生产入口（T17-08 教训：不得旁路 composition）；不得为通过测试
  放宽任何 fail-closed；closeout 期间不得改 production runtime。
- **Commit**：`test: verify supervisor e2e` → `chore: close sprint 18` + annotated tag
  `sprint-18`（**权威 checkpoint 名，不得先假定 `sprint-18.0.0`**），不 push。

## 冻结的 Task 顺序（Boss 裁定，§44）

```
T18-01  Architecture Recon & Contract Freeze          CLOSED
T18-02  Durable Run Goal + Snapshot Verification
        + Model Binding Pinning                       CLOSED
T18-03  Durable Supervisor Decision Sink
T18-04  Structured Reviewer Findings
T18-05  Controlled Corrective Task Provisioning + Durable Lineage（**CLOSED**）
T18-06  Supervisor Decision Runtime（**CLOSED**）
T18-07  Bounded Autonomous Supervisor Loop & Stop Conditions（**CLOSED**：
        SupervisorDecisionRuntime 复用 + Decision Applicator + maxSupervisorTurns=20
        + maxCorrectiveRounds=3（provisioner 边界）+ 人工升级经既有 Approval seam
        + resumeEscalatedRun；corrective 后 carrier / evidence-lifecycle / pinned-binding /
        崩溃窗口均已闭合，仅剩 PRODUCTION_TURN_TWO_DEFECT）
T18-08  Crash Safety / Idempotency / Recovery
T18-09  DevCompany Integration + Autonomous Production E2E
T18-10  Sprint 18 Closeout
```

## 未列入本 Sprint 的项（显式延后）

- G6 authority 目录变更（`task.create` / `task.read` / `workflow.read` / `run.approve`）——
  等 Boss 裁定，可能独立 ADR。
- G9 run 级 model binding 基准（`RunSnapshot.modelBindings` 生产空置）。
- roadmap `Sprint 18：CTO Workflow` 段（CTO 搜模板/建 Draft/输出 Plan）与本文档的关系
  （契约 §9 Q2）。
- 成本/预算 治理（V1 无货币成本落盘）。
