# S13 Workflow Integration（Sprint 13A Freeze）

> 状态：FROZEN（Proposed）。配套：`S13_ARTIFACT_CONTRACT.md` · `S13_VALIDATION_CONTRACT.md` · ADR-0015/0016。
> 本文档冻结 Validation 与 Workflow Engine 的集成架构、VALIDATION_PASSED evidence guard、
> Memory 边界与全系统兼容性矩阵。

## 1. 集成架构（D-12，冻结）

| 方案 | 评估 |
|---|---|
| A：Engine 内建阶段 | ✗ 改冻结的 Engine 核心；外部命令执行不属于确定性引擎事务边界 |
| **B：独立 Application Service + 引擎证据守卫** | ✓ 与 handoff-service / router / lifecycle-service 同构（全部先例）；引擎只消费结论 |
| C：Event-driven consumer | ✗ 引擎无异步消费者；事件是审计轨迹不是编排机制（Sprint 2 冻结） |

**选定 B**：`createValidationService()`（`packages/engine/src/validation/`，先例同 handoff）。
**总原则：不重写 Workflow Engine。**

### 1.1 端到端时序（全部节点对齐既有代码）

```text
Stage 执行（事务内）
  → Artifact 记录（CAS 先落 → 行 + artifact.created，同一 UnitOfWork；见 Artifact 契约 §10）
REVIEW_PASSED（既有 L1 转移，run-state.ts:207-212）
  → Run 进入 VALIDATING（既有态，零改动）
ValidationService（Application Service）：
  resolveValidatorIds(stage 快照的 validatorIds；capability 过滤，fail closed)
  → 逐个执行（命令型走 Tool Registry 受控执行；validator 返回 result + optional ReportArtifactDescriptor）
  → 报告物化（ArtifactService；producedBy = validator:<id>@<version>）
  → 记录 Validation 行 + validation.recorded 事件（同一 UnitOfWork，逐 validator 独立事务）
Policy（应用层，qualityGatePassed 复核 durable 证据）：
  通过 → 向 Engine 发 VALIDATION_PASSED 命令（携带 validationIds 证据）→ 引擎证据守卫 → FINALIZING
  失败 → VALIDATION_FAILED 命令 → REWORK（既有返工预算）
```

### 1.2 引擎侧唯一新增（evidence guard，非重写）

`VALIDATION_PASSED` 命令新增**证据守卫**，属既有守卫序列（存在→终态→锁→状态边→policy/authority→载荷）
的**载荷校验扩展**：命令必须携带本次 run 的 validationIds，且下述 §3 全部成立，否则
`VALIDATION_FAILED`/`INVALID_ARGUMENT` 拒绝。L1 冻结转移（REVIEW_PASSED→VALIDATING→FINALIZING/REWORK）
**零改动**；不新增状态。

## 2. 边界纪律（§33 Engine 行）

**不把 SQLite query 塞进纯 Core 状态机。** 证据解析通过：

```text
Application / Engine evidence resolver（读 durable Validation + Artifact rows，服务层校验归属）
→ pure policy evaluation（qualityGatePassed 等 Core 纯函数，输入为已解析的证据视图）
→ transition command
```

与现有架构等价的边界：Core 状态机只做纯转移判定；durable 查询与归属校验在 Application/Engine 层完成。

## 3. VALIDATION_PASSED Evidence Guard（冻结，11 项必验）

`VALIDATION_PASSED` **绝对不能**是 caller declares "passed"；必须 **evidence-backed**。Engine/Application
至少验证：

1. durable Validation record 存在（commandId 携带的 validationIds 逐条可查）；
2. **targetRef 对应当前 Artifact（ADR-0017）**：durable `target_ref` 列（受控 `artifact:art_<ulid>`）
   经 `ValidationStorePort.listByTargetRef()` 精确解析——**target ≠ evidence**，不靠 evidenceRefs
   猜测、不靠 runId 推断；targetRef 为 null 的 legacy 记录不能作为 targeted evidence；
3. Artifact 属于正确 Workflow Run / context（runId 匹配）；
4. Stage 要求的 validator 已满足（stage 快照 validatorIds 逐个有对应 Validation）；
5. validator identity 正确（validatorId/validatorVersion 与注册解析一致）；
6. blocking validations 全部满足 quality gate（`qualityGatePassed` 为真）；
7. blocking FAIL 不允许通过；
8. ERROR 不允许通过；
9. wrong Artifact evidence 不允许复用（证据绑定其它 Artifact → 拒绝）；
10. wrong Run evidence 不允许复用（跨 run 证据 → 拒绝）；
11. caller 自造 status 不被信任（status 以 durable 行为准；请求体不携带可信 status）。

## 4. Memory 边界（Boss 修正 4，冻结）

> **Memory 的 content model、ownership、write semantics、durability semantics 不变。**
> Sprint 13 仅对 provenance source contract 做 additive extension：
> - 新增 `ARTIFACT`（`MEMORY_SOURCE_TYPES` 闭集加法式扩展）；
> - 兑现现有但 Sprint 12 尚未支持的 `VALIDATION` source verifier（组合根按 artifacts/validations
>   表存在性校验，杜绝悬空引用；兑现 main.ts "Unsupported for Sprint 12" 预留接线点）。

- `Artifact → Memory` **只通过 provenance reference** 建立关系；
- S13 默认**不复制 Artifact content 到 Memory**；Memory 保存自己的 immutable knowledge content；
- `Artifact owns Memory` 与 `Memory owns Artifact` **均不成立**；
- >8KiB Memory 溢写不随 S13 启动（Memory 侧未来 ADR）。

## 5. 兼容性矩阵（§33，冻结）

总原则：**Sprint 13 必须是 additive integration，不能推翻 Sprint 0–12 已稳定架构。**

| 模块 | Current Behavior | Sprint 13 Interaction | Required Change | Breaking? | Risk | Compatibility Strategy |
|---|---|---|---|---|---|---|
| **Workflow Engine** | Command→Engine→Event；L1 17 态含未兑现的 VALIDATING；质量门零接线 | VALIDATING 态首次真实到达：VALIDATION_PASSED/FAILED 命令 | **唯一新增** = VALIDATION_PASSED 证据守卫（载荷校验扩展） | **NO** | 守卫过严误拒 / 过松放水 | 不改转移表/事件目录；守卫独立测试（正负例矩阵）；既有 run 测试零删除 |
| **Router** | 冻结主线；filter/rank/recommend | **零交互** | 无 | NO | Router 被迫依赖 Artifact persistence = 边界错误 | Router 不得知道 CAS path/ArtifactStore/ValidationStore（源码级边界测试） |
| **Agent Runtime** | 执行记录带 resultRef/artifactRefs 引用（不透明字符串） | 执行后经 Application 层物化选定输出，回填真实 artifactId | runtime 代码**零改动**（物化在 App 层）；类型不变 | NO | 物化路径被塞进 runtime | 物化只经 ArtifactService；runtime 不 import ArtifactStore/CAS |
| **Tool Registry** | 注册/authority/risk/approval/幂等/audit 全套 | 命令型 validator 的受控执行通道；validator capability 声明 | **加法**：tool record 增 validator capability 声明面 | NO | 第二套 executable runtime | 复用 S9 全部门禁；"不是所有 Tool 自动是 Validator"由 capability 过滤强制 |
| **Handoff** | 独立领域；refs 只校验格式 | artifact refs 从悬空字符串升级为可校验引用 | Handoff 契约/存储**零改动**（存在性校验在消费侧服务层） | NO | Handoff 被 Artifact 系统吞并 | 保持独立领域语义；非 artifact refs 不迁移；breaking 迁移推迟 |
| **Memory** | 内联 content；provenance 闭集含 VALIDATION（verifier S12 未支持）、无 ARTIFACT | provenance 加法扩展 + verifier 兑现 | `MEMORY_SOURCE_TYPES` +`ARTIFACT`；组合根 verifier +2 分支 | **NO（additive）** | 被误读为 Memory 语义变更 | content model/ownership/write/durability 不变（§4）；A–AZ 类既有测试零删除 |
| **Decision** | `related_artifact_refs_json` 悬空引用 | 引用可校验 | Decision 侧**零改动**（校验在引用消费/verifier 侧） | NO | schema 扩大 | 沿用 JSON refs（S13_ARTIFACT_CONTRACT §5）；不建 relation 表/跨链 FK |
| **Provider** | 返回 raw InvocationResult；零持久化 | 零交互（物化在 App 层） | 无 | NO | Provider 直写存储 | 禁止 Provider→ArtifactStore/ValidationStore/CAS/SQLite（边界测试） |
| **Desktop Composition Root** | 装配 11 链 + 全部服务 | 装配 ArtifactService/ValidationService/ArtifactContentStore；12 链请求 | **加法**：chains +`artifact`；expected-chains 同步；新服务 wiring | NO | 组合根长出业务策略 | 组合根只 wiring；quality policy/business decision 留在 service/policy 层 |
| **Persistence** | 11 条 checksum 链 + durable stores | 新 `artifact` 链 + 2 个 SQLite store + CAS 适配器 | **加法**：migrations/artifact/0001；新 adapter 文件 | NO | 既有链 checksum 破坏 | 既有 11 链字节不动（有测试锁定）；新链 opt-in；expected-chains 一行增补 |

## 6. 集成事务边界

分三段（见 Validation 契约 §11）：① Artifact/Validation durable（各自 UnitOfWork）→
② 报告物化（ArtifactService 事务）→ ③ transition command（引擎既有边界）。**无跨段超长事务**；
CAS+SQLite 非原子（Artifact 契约 §10），崩溃恢复按 Case A–E 矩阵 + 启动对账。
