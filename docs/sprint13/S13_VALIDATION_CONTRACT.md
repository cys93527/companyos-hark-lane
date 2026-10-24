# S13 Validation Contract（Sprint 13A Freeze）

> 状态：FROZEN（Proposed — 待 Boss 架构评审 + ADR Acceptance 后生效；生效前禁止实现）。
> 配套：`S13_ARTIFACT_CONTRACT.md` · `S13_WORKFLOW_INTEGRATION.md`（VALIDATION_PASSED evidence guard 全文）
> · `S13_TEST_STRATEGY.md` · `S13_RISK_REGISTER.md` · ADR-0016（Validation Framework）。
> 总原则：复用 Sprint 1 Validation 契约，零平行概念。

## 0. Validation 侧决策总表

| # | 决策 | 结论 |
|---|---|---|
| V-01 | 领域契约 | 复用 Sprint 1 `Validation`（`packages/core/src/domain/validation.ts`）；**Additive 修订（ADR-0017）**：增 `targetRef`（受控 `artifact:art_<ulid>` 品牌化类型，legacy null 兼容）；禁止第二套 ValidationResult 概念 |
| V-01b | Target 语义（ADR-0017） | **targetRef = 被验证 Artifact 的身份；evidenceRefs = 支持验证结论的证据引用**——两者严格分离，不得混写；Core 只验结构（`artifact:art_<ulid>`），存在性归 ValidationService |
| V-02 | 状态语义 | 闭集保持 `pass/fail/error/skipped`；**WARNING = `fail` + `blocking:false`**（不新增状态） |
| V-03 | Validator 角色 | **Validator 产生证据，不做业务流程决策**；transition 由 Workflow/Policy 层控制 |
| V-04 | 执行边界（Boss 修正 3） | Validator → 返回 result + optional `ReportArtifactDescriptor`（DTO）→ **ValidationService → ArtifactService → Store/CAS** 物化；Validator 不直访 SQLite/ArtifactStore/CAS/Workflow/Memory/Decision/Provider |
| V-05 | 解析 | `validatorId` → **受控 registration/resolution contract** → Tool Registry 记录（继承 S9 authority/risk/approval/idempotency/audit）；**不是所有 Tool 自动都是 Validator** |
| V-06 | 失败策略 | S13 词汇 = `block` + `warn`；retry/manual-review 由既有引擎语义涌现；Validator 无业务动作参数 |
| V-07 | 幂等 | **same-command retry ≠ intentional re-validation**；禁止 `UNIQUE(artifactId, validatorId)` |
| V-08 | SoT | **SQLite durable Validation record**；Validator 返回值是 transient result |
| V-09 | 证据守卫 | `VALIDATION_PASSED` 必须 **evidence-backed**（guard 清单见 Workflow Integration 文档 §3） |

## 1. 契约复用（V-01 + ADR-0017 修订，冻结）

现有 `Validation` 覆盖全部指令语义位：validationId=`id`；**targetRef（ADR-0017 additive）=
被验证 Artifact 的受控引用 `artifact:art_<ulid>`——null = legacy Sprint 1 兼容，Sprint 13 新建
durable Artifact Validation 必须非 null（Service 层 fail closed）**；锚点 = `runId+stageId+taskId`；
validatorId/validatorVersion 同名必填；status 闭集；evidence=`command+exitCode+evidenceRefs`
三件套（**target ≠ evidence：targetRef 是被验证对象身份，evidenceRefs 只是支持结论的证据引用，
二者严格分离**）；createdAt=`startedAt`（+`finishedAt`）；issues **不加**（无契约字段、无消费方；
结构化问题清单属未来 additive）。持久化 = `validations` 表 1:1（DDL 见 §5）。
`ReportArtifactDescriptor` 是 Validator 的**返回值 DTO**（Core 定义），不是第二套持久化实体。

## 2. 状态语义（V-02，冻结）

| 状态 | 语义 | 质量门作用 |
|---|---|---|
| `pass` | Validator 正常执行**且**目标满足规则（必须有证据：exitCode 0 或 ≥1 evidenceRef——既有不变量） | 计入并通过 |
| `fail` | **Validator 正常执行，但目标不满足规则** | `blocking=true` → 阻断；`blocking=false` → 仅记录 |
| `error` | **Validator 本身无法完成验证**（崩溃/超时/基础设施失败）——与 fail 严格区分 | 视同不通过（无有效证据不得放行）；**也是 §24 Case B（CAS missing）的表达通道** |
| `skipped` | 未执行（不适用/前置缺失） | 不计入门 |

**WARNING（冻结）**：`fail` + `blocking=false` = "发现不满足规则的事实，但不阻断"。不新增 `warning` 状态；
组合语义由文档 + 测试锁定；`qualityGatePassed` 只统计 blocking 的既有实现天然保证 WARNING 不影响门。

## 3. Validator 执行边界（V-04，Boss 修正 3，冻结）

```text
Validator（确定性执行体）
  ↓ 返回
validation result + optional ReportArtifactDescriptor（应用层 DTO，不落盘）
  ↓
ValidationService（编排：解析 validator → 执行 → 记录 Validation 行 + 事件；报告物化经 ArtifactService）
  ↓
ArtifactService → ArtifactStore / ArtifactContentStore（durable）
```

**Validator 禁止**：直访 SQLite · 直访 ArtifactStore · 直访 filesystem CAS · 直接生成 durable Artifact record ·
控制 Workflow · 写 Memory/Decision · 调用 Model Provider（S13 禁止；LLM-as-judge 正是证据纪律排除的形态）。
**Validator 可以**：读 Artifact 元数据与 content（服务层供给 + hash 校验）；经 Tool Registry 执行命令；
返回报告描述符。目的：side-effect constrained / auditable / testable，与 persistence adapter 零耦合。

## 4. Validator 注册与解析（V-05，§19，冻结）

- **显式 registration/resolution contract**：`validatorId` 解析到受控执行体必须经过明确的
  validator capability/registration —— **不是所有 Tool 自动成为 Validator**。
  S13 形态：Tool Registry 记录声明 validator capability（adapterRef 指向确定性适配器）；
  Stage 的 `validatorIds`（Sprint 5 既有 `SET_VALIDATOR`/`STAGE_CONFIG_KEYS`）解析时按
  capability 过滤——未声明 validator capability 的 Tool 一律不可被 `validatorIds` 引用（fail closed）。
- **禁止** `Validator → arbitrary command execution`：命令型 validator 只经 Tool Registry 受控执行
  （继承 registration / authority / risk level / execution boundary / permission gate，S9 全套）；
  **不建立第二套 Validator executable runtime**。
- Renderer / 外部 caller / 不可信 payload **不得动态注入 arbitrary executable validator**（§22）。
- 具体 Validator 类型（UnitTest/Build/Lint/…）属 Pack 层注册值；Core 永不出现（词汇法）。

## 5. 持久化（§5 表 + V-08，冻结）

`validations` 与 `artifacts` 同属第 12 条链 `artifact` 的 0001 迁移（memory 链同 Sprint 双表先例）：

```sql
CREATE TABLE IF NOT EXISTS validations (
  validation_id     TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  stage_id          TEXT,
  task_id           TEXT,
  validator_id      TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pass','fail','error','skipped')),
  command           TEXT,
  exit_code         INTEGER,
  blocking          INTEGER NOT NULL DEFAULT 1 CHECK (blocking IN (0,1)),
  evidence_refs_json TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  created_at        TEXT NOT NULL,
  -- permanent creation identity（Option B，与 artifacts 表同构；persistence metadata，非 domain 字段）
  creation_command_id         TEXT,
  creation_command_fingerprint TEXT,
  -- ADR-0017（corrective migration 0002）：被验证 Artifact 的身份（artifact:art_<ulid>）；
  -- nullable = legacy 兼容；与 evidence_refs 严格分离
  target_ref        TEXT
);
CREATE INDEX IF NOT EXISTS idx_validations_run ON validations (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validations_validator ON validations (run_id, validator_id);
CREATE INDEX IF NOT EXISTS idx_validations_target ON validations (target_ref, created_at DESC, validation_id);
-- permanent idempotency：粒度 = (command, validator)——同 command 批次内每个 validator 一行，
-- 同 command 重试不产生第二组；intentional re-validation 用新 commandId → 新组，无冲突
-- （cardinality 冻结 = ADR-0017：one command → one target；target_ref 不得加入唯一键）
CREATE UNIQUE INDEX IF NOT EXISTS idx_validations_creation_command
  ON validations (creation_command_id, validator_id) WHERE creation_command_id IS NOT NULL;
```

- 无跨链 FK（仓库先例）；run/Artifact 存在性由服务层校验。
- **禁止 `UNIQUE(artifactId, validatorId)` 类唯一约束**（V-07：会永久阻止 intentional re-validation）。
- Validation 的 issues/evidence/metadata 单表 JSON 表达优先（evidence_refs_json 先例：memory `related_*_refs_json`）。
- **`creation_command_id`/`creation_command_fingerprint` 为 persistence metadata（非 domain 字段），
  Sprint 1 类型与工厂零变更**；partial unique 粒度 = **(command, validator)**（RunValidation 一次执行
  N 个 validator = 一个逻辑操作产 N 行证据；同 command 重试不产生第二组）。**Migration #12 仍两张表。**

## 6. 幂等（V-07，§25，冻结）

| identity | 职责 |
|---|---|
| `commandId` | retry identity：same-command retry **复用既有 command ledger 语义**，不得每次 retry 插入新 validation row |
| `validationId` | durable 证据身份：由 ValidationService 在 command 执行内生成（application-generated，符合现有 makeId 约定）；**同一 command retry 不制造新 Validation** |
| `validatorId` + `validatorVersion` | validator 实现身份（复用 Tool Registry identity，§7） |
| `artifactId` | 被验证目标（evidence 绑定） |

**两种情形的严格区分（冻结）**：

- **A. Same-command retry**（same commandId + same target + same validator identity）→ 复用已有 durable
  Validation，或按 command ledger 语义返回同一操作结果。**不得**新插行。
- **B. Intentional re-validation**（调用者发**新 commandId**）→ 允许对同一 Artifact 再次执行并产生**新的
  durable evidence**（append-only，历史保留）。

因此 schema 与服务层都不得设计成"一个 Artifact 对一个 Validator 永久只能有一条 Validation"。

### 6.1 commandId 幂等双轨制（Blocker 裁定 = Option B，冻结）

**STEP 1 retention 核查结论**（完整证据表见 Artifact 契约 §11.1）：ledger durable 但**每 dispatch 后
同步 trim**、默认 1000 条、按数量 rowid 最旧先出、无 tombstone、无分区——**幂等窗口有界**，窗口外
无挡板。单靠 ledger 不能支撑 unconditional 幂等 ⇒ 双轨制：

```text
Command Ledger  = retry/result cache + transactional command record（有界窗口）
Validation row  = permanent creation identity（窗口外仍可恢复与判重）
```

`RunValidation(commandId=Y)` 成功 ⇒ 同一 UnitOfWork 内写 validations 行组（N 个 validator = N 行，
每行携带 identity 列）+ 事件 + ledger outcome 快照（含全部 validationIds）。

**服务 retry lookup 三级顺序（冻结）**：

```text
① ledger.get(Y) 命中 → fingerprint 比对：同 → 返回整组 validationIds；异 → CONFLICT
② ledger miss（已 trim）→ SELECT validations WHERE creation_command_id = Y
   （partial unique (command, validator) ⇒ 至多一组）：
   命中 → fingerprint 比对：同 → 返回既有 validationIds，不创建第二组；异 → CONFLICT
③ 都 miss → 正常执行（新组 + identity 落行 + ledger put，同一 UnitOfWork）
```

**五个 Case**：Case 1 同 retry 同组；Case 2 rollback 双无；**Case 3 trim 后重试 → 行组命中 →
fingerprint 同返回既有 / 异 CONFLICT（permanent，不依赖窗口）**；Case 4 intentional re-validation
新 commandId → 新组（partial unique 不阻止）；Case 5 同 key 异 fingerprint → CONFLICT fail closed
（窗口内外都可判）。

## 7. Validator 版本（§26，冻结）

核查结论：Tool Registry 已提供稳定 identity——`ToolRecord`（含 toolId、`adapterRef`、注册元数据）+
tool invocation 记录 execution identity；`Validation.validatorVersion` 字段（Sprint 1 必填）由解析层从
Tool Registry 记录填充。**复用，不建第二套 validator version system**。若实现期发现 Tool Registry 缺少
稳定的 implementation version 字段，最小新增（tool record 上的 version 列）须在 13B 实现报告中说明原因——
预期不需要（tool registration 语义已含版本化登记空间）。

## 8. 事件（§20，冻结）

`validation.recorded`：只有 **Validation durable persistence 成功**后才可观察：

```text
Validation durable record + 既有 event append 语义（同一 UnitOfWork）→ validation.recorded 可观察
```

事件可定位：validation identity（validationId）、target（runId/stageId/taskId + evidenceRefs 指向的
Artifact）、validator（validatorId/validatorVersion）。payload 白名单：validationId/runId/stageId/
validatorId/validatorVersion/status/blocking/exitCode/evidenceRefCount/traceId——无内容正文、无完整 evidence 数组。
发射方按既有登记 `validators:S13` 首发。不引入新 event bus/queue/outbox/broker（§20 Event Infrastructure
核查结论：UnitOfWork + append-only events + 事务内 append 已满足，Sprint 3 先例）。

## 9. Source of Truth 与证据使用（V-08，冻结）

```text
Validator 函数返回值            = transient result（不是事实）
validations 表 durable record   = SoT（唯一事实）
```

只有 ValidationService 完成 durable persistence 后，该 Validation 才能作为 `VALIDATION_PASSED`
或其它 Workflow evidence 的事实来源。caller 自报 status=pass 一律不信（§22）。

## 10. 失败策略（V-06，§15，冻结）

| 策略 | 进 S13 | 机制 |
|---|---|---|
| block | **YES** | `fail/error` + `blocking=true` → `VALIDATION_FAILED` → REWORK（既有返工预算管辖） |
| warn | **YES** | `fail` + `blocking=false` → 记录 + 审计，不触发转移 |
| retry | 非 Validator 能力 | 返工循环（既有）+ Tool invocation 显式 retry（S9.1.2 既有） |
| manual-review | 不新建机制 | 执行前审批 = Tool 风险门；失败后人审 = REWORK_EXHAUSTED → PAUSED（既有 L1） |
| supersede | **N/A** | Validation 是 append-only 证据，无替代语义 |

**契约明文**：Validator 的输出类型只有 Validation 结果 + optional `ReportArtifactDescriptor`；
`block workflow` / `retry task` / `manual review` 不是 Validator 的参数、返回值或权限——业务动作唯一归属
Workflow/Policy 层。

## 10b. 实现澄清（Task-13-06）

- **WAITING_APPROVAL 穿透**：Sprint 9 registry 对 HIGH/CRITICAL 工具的等待审批以
  err(APPROVAL_REQUIRED)（含持久化 WAITING_APPROVAL invocation 行）返回；ValidationService
  将其穿透为整个 RunValidation 的 APPROVAL_REQUIRED（零 Validation 写入）；approve 后
  retry 经 deterministic idempotency key 复用同一 invocation。
- **已裁定并关闭（ADR-0018，Option A——Durable Tool Invocation Replay Output）**：
  tools 链 migration 0004 增 `replay_output_json`；成功 invocation 的 snapshot 与终态
  原子写入（写时无损校验）；replay 恢复原 output 并对 output_digest 校验
  （mismatch → TOOL_REPLAY_OUTPUT_CORRUPT fail closed；pre-0004 行缺失 snapshot →
  TOOL_REPLAY_OUTPUT_UNAVAILABLE → ValidationService 映射 VALIDATION_VERDICT_UNRECOVERABLE，
  仅剩 legacy/integrity 路径）。crash-retry 现完整闭环：adapter 零重执行 + 原 verdict/
  report descriptor 恢复 + deterministic report artifact 复用 + batch 提交。
  **遗留已关闭（ADR-0019）**：tool_invocations 增 durable tool_version 列
  （tools/0005，创建时捕获；历史 NULL 不回填）——validatorVersion / report producedBy /
  首执行一致性 / approve 漂移 / legacy null 消费全部由 ADR-0019 冻结并测试锁定。
  逐 validator 的 startedAt/finishedAt 改用 durable invocation 执行时间戳
  （replay 恢复原时间，§20）。
- **报告物化失败语义**：report 属 optional descriptor；物化失败 → 整命令 fail-closed
  返回该错误（零 Validation 写入；retry 经幂等 key + deterministic report command 复用全部
  durable 对象后批次可提交）——依据 §30 冻结 crash model 组合推导，已在 T06 报告标注供审核。

## 11. 事务边界（§24 Validation Transaction Boundary，冻结）

**不做**覆盖"Artifact 创建 + Validator 执行 + Workflow transition"的超长事务。分三段：

```text
① Validation durable record + validation.recorded event —— 一个 UnitOfWork（既有机制）
② （报告物化在 ① 之前的 ArtifactService 独立事务，见 Artifact 契约 §10）
③ VALIDATION_PASSED / VALIDATION_FAILED command —— 单独消费 durable evidence，引擎既有事务边界
```

多 validator 执行 = **逐个独立事务**（一个失败不回滚已记录的其他证据——证据只增不减）。
收益：retry / crash recovery / audit / idempotency 各自清晰。

## 12. Authorities 与 Ports（§23 Validation 侧，冻结）

- `AUTHORITIES` 加法式 +4：`artifact.create` · `artifact.read` · `validation.record` · `validation.read`
  （先例：Sprint 11/12 的加法式扩展）。
- `packages/core/src/ports/validation.ts`：`ValidationStorePort` = record / get / listByRun（append-only）。
- Core 不知 fs/SQLite/Electron/路径/CAS；ValidationService（engine）编排；persistence 提供 SQLite 适配器。
- **Implementation status reconciliation（Task-13-11 read-authority recon，2026-09-26）**：本节冻结的是
  authority **词汇表**。`artifact.create` / `validation.record` 已有真实运行时执行点（`ArtifactService.create`
  / `ValidationService.run` 的 authorize 门，T04/T06 交付）；原文"全部有执行点"对 read 两项是设计期意图、
  **不是当前 normative 要求**：`artifact.read` / `validation.read` 当前为 planned permission vocabulary
  （catalog reservation）——无冻结的具体 Service/action，生产无 reachable 执行点（T11 曾短暂经 IPC read
  op 暴露，已被 IPC boundary corrective 裁定移除，且禁止以 renderer IPC 重新引入）。其执行点属 future
  contract。catalog entry ≠ exposed capability；unknown authority 仍 fail closed（INVALID_ARGUMENT）。

## 13. 测试锚（详见 S13_TEST_STRATEGY.md）

Validation 侧验收骨架：invariants / 四态语义 / blocking vs non-blocking / evidence addressability /
same-command retry 无重复行 / intentional re-validation 成功 / 目标 Artifact 存在性 / validator identity
与 version / evidence refs 校验 / 报告物化唯一路径 / guard 正负例 / 边界负例（Validator 不可触 Store、
Renderer 不可声明 PASS、未知/未授权 validator 拒绝）。
