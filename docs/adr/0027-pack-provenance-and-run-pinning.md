# ADR-0027：Pack Provenance and Run Pinning（Sprint 15 — Task-15-01 Architecture Decision）

> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：`TASK-15-01 APPROVED` 指令全文）**。
> 配套：ADR-0024/0025/0026 · ADR-0007（RunSnapshot 不可变 pin）· ADR-0015/0019（Artifact/Tool 溯源）·
> ADR-0021（Sprint 14 恢复）· `docs/sprint15/S15_PACK_CONTRACT.md`。

## Context

`RunSnapshot.packVersions: Record<packId, string>` 已存在且 durable（run_snapshots.pack_versions_json），
lifecycle createRun 已接受该入参（默认 {}）——但"谁在何时写入哪些 pack"未冻结。本 ADR 冻结解析时机、
pin 集合、运行时独立性、溯源与持久化要求。

## Decision 1：解析时机——仅一次

Pack runtime resolution **AT RUN CREATION**。不是 every Stage / every resume / every recovery。

## Decision 2：RunSnapshot.packVersions = Pack provenance carrier

创建 Run 时写入 `packId → exact packVersion`。**不把 Company 全部 enabled Packs 塞进 snapshot**；
只 pin：**实际贡献给该 Run 的 Pack versions + 其传递 required Pack dependencies**
（dependency closure actually used by Run）。

## Decision 3：运行时不得依赖 active Pack

Run 创建之后，execution / validation / recovery / audit **不得回查**：current PackInstallation.status、
current Pack latest version、current company Pack catalog——以这些决定当前 Run 行为一律禁止。

## Decision 4：运行时相关内容必须展开/固化

Pack 声明中真正影响运行行为的内容，在 Run 之前必须物化/固化进既有 immutable/durable structures：

```text
WorkflowVersion / stage config / validatorIds
tool requirements（后续 toolVersion provenance 走 ADR-0019）
RunSnapshot.packVersions
```

因此运行时不依赖 mutable Pack 状态。物化必须经**既有 application/service contract**
（Workflow declaration → workflow lifecycle service；Role declaration → authz/role service；
Tool requirement → Tool Registry validation；Validator requirement → workflow validatorIds；
Artifact type → declaration validation）——**禁止 PackService raw SQL 直写各子系统表**。

## Decision 5：恢复规则（Sprint 14 延续）

**Recovery never resolves current active Pack.** 恢复依据 Run / RunSnapshot / pinned
WorkflowVersion / Task / events / tool provenance / artifact provenance。Pack disable/upgrade 不能改变
恢复结果。

## Decision 6：历史可复现性

Pack 升级后 old Run 仍然：使用旧 pinned WorkflowVersion、历史 Tool provenance、历史 Artifact/Validation
identity、展示原 packVersions 溯源——**不能自动解释成 Pack v2**。

## Clarification（TASK-15-02 implementation ruling — PackContentRef.materializedEntityRef NULLABLE）

Source identity is always required; the external materialization target is
CONDITIONAL:

```text
PackContentRef { packId; packVersion; contentKind (closed 9-kind union);
                 logicalKey; materializedEntityRef: EntityRef | null }
```

- Declaration landed in an existing subsystem (WorkflowTemplate, Role, …) →
  `materializedEntityRef` = the durable entity ref.
- Pack-native declaration with no separate external entity (Generic Templates,
  Prompts, Risk Rules, Capability Rules — none has its own durable subsystem in
  Sprint 15) → **`null`**. Provenance stays uniquely locatable by
  (packId, packVersion, contentKind, logicalKey)。
- Forbidden: inventing fake entity ids, creating meaningless generic tables, or
  pretending PackVersion itself is a materialized entity.
- Runtime authority is unchanged for every case (WorkflowVersion, Tool provenance,
  Artifact identity, Validation evidence, RunSnapshot stay authoritative;
  PackContentRef is provenance only)。

## Decision 7：PackContentRef（REQUIRED domain concept）

```text
packId + packVersion + content kind + materialized entity identity
```

之间的 **durable provenance mapping**。它是审计、disable visibility（哪些 live 能力要消失）、冲突检测、
历史溯源、租户隔离的依据。**PackContentRef 不是运行时内容**：运行时不能用 PackContentRef 替代
WorkflowVersion / ToolInvocation provenance / Artifact identity 这些现有权威——它只描述
"PackVersion → 物化对象"的来源关系。

## Decision 8：持久化（Sprint 15 REQUIRED）

**NEW PACK PERSISTENCE IS REQUIRED**（T15-03 非条件任务）：

- **PackVersionStore**：至少持久化 `packId + packVersion + canonical manifest snapshot +
  manifestFingerprint（qualified SHA-256 ref：`sha256:<64 lowercase hex>`，TASK-15-02 corrective）`——application binary/catalog 后来变化时，已安装版本仍有 durable
  identity/audit evidence（同 `(packId, packVersion)` 不同 canonical content ⇒ CONFLICT，见 ADR-0024 D4）。
- **PackInstallationStore**：`installationId + companyId + packId + packVersion + status +
  creation/idempotency identity`（+ 实现所需 timestamps 等既有惯例字段）。
- **PackContentRef persistence**（语义如 Decision 7）。
- SQLite 表设计是 T15-03 implementation detail，但语义必须满足本 ADR。

## Decision 9：永久安装身份（Sprint 13 pattern 延续）

CommandLedger 仍是 bounded retry cache，**不能作为永久 installation identity**。安装命令必须有
durable creation identity/fingerprint：same command + same fingerprint → replay same result；
different fingerprint → conflict。**唯一性**：`companyId + packId + packVersion` 恰一个 durable
installation identity；重复合法 install 必须 idempotent（不建重复 installations）。
One-enabled-version 不变量（ADR-0025 D8）由 store/service 组合强制。

## Implementation Addendum（T15-03）

PackVersionStore / PackInstallationStore / PackContentRefStore 三端口位于
`packages/core/src/ports/pack.ts`（SQLite/Electron/fs 零依赖），SQLite 实现位于
`packages/persistence/src/durable/sqlite-pack-stores.ts`，随 `pack` 链挂入 DurableDatabase
门面（链未启用时为 null）。Store 不做授权、无 delete/GC；读路径 fail closed（manifest/fingerprint
损坏 → PERSISTENCE_FAILED，绝不返回部分对象）；SQLite 约束违例映射为 CONFLICT/INVALID_ARGUMENT
（不泄漏原始 SQL 文本）。Run pinning 仍属 T15-05。

## Implementation Addendum（T15-04 — provenance 写入点）

- PackContentRef 由 PackService 在 install/upgrade 的同一 UoW 内写入：每个 canonical 声明项一条
  （(installationId, contentKind, logicalKey) 主键），materializedEntityRef 对 role/workflowTemplate
  记真实实体 id、对 pack-native 七类记 null；回滚即全撤。
- `pack.manage` 首个运行时执行点落地于 PackService（Decision 10）：公司域授权，不 grant/assign/
  bypass/execute；事件 `pack.installed`/`pack.enabled`/`pack.disabled`/`pack.upgraded` payload 白名单
  （不含 manifest 正文/prompt/模板内容/密钥）。
- Run pinning（createRun → RunSnapshot.packVersions）仍属 T15-05：PackService 只保证 installed status
  与闭包可寻址，不在本任务写 run 侧。
- **T15-04 corrective**：availability policy 使 PackContentRef 同时承担 **live-availability
  guard 的 provenance 输入**（PackContentRef → installation → status）；guard 位于
  `AuthorizationService.assign` 与 workflow lifecycle 的 new-use 入口，Run pinning 未实现。

## Implementation Addendum（T15-05 — Run Pack Pinning）

- **Root contributor**：新 Run 选中的 materialized WorkflowTemplate 的 **live owners**
  （`PackContentRef.contentKind = 'workflowTemplate'` + `materializedEntityRef = templateId` →
  拥有它的 `PackInstallation`，仅 `status = 'installed'`，公司域）。不用模板名/命名空间串/
  当前 catalog/文件系统推断。
- **Pinned set**：所有 live root owners（含多 owner，不随机选一个）**+** 它们的传递
  REQUIRED exact-version 依赖闭包。同一 packId 在闭包里出现两个版本 ⇒ `CONFLICT`
  （`PACK_MULTIPLE_INSTALLED_VERSIONS`，绝不 last-wins）。
- **Packless**：模板无任何 pack owner ⇒ `packVersions = {}`（legacy 工作流一等公民）。
- **Resolution timing**：仅新 Run 创建；解析在 **write phase 之前**完成，依赖缺失/disabled/
  unknown/cycle/corrupt ⇒ `createRun` fail closed（0 WorkflowRun、0 RunSnapshot）。
- **Runtime**：创建后 Run 只读 pinned snapshot；advance/drive/dispatch/validation/review/
  finalize/recovery 均不读 `PackInstallation.status` / 当前 installed Pack / Pack catalog。
- **Caller authority**：`RunSnapshot.packVersions` 是 **trusted derived data** ——
  `CreateRunInput` 已无该字段（编译期即拒），resolver 结果是唯一权威，caller 值与 resolver
  不一致的情况在 API 面不存在（不是"忽略"而是"不存在"）。
- **实现**：Core 端口 `PackRunProvenancePolicy`（`core/src/ports/pack.ts`）；engine 实现
  `createRunPackProvenanceResolver`（`packages/engine/src/pack/run-pack-provenance.ts`），复用
  `pack-provenance.ts` 的 `findPackOwnersOfMaterializedEntity` 与
  `resolveExactDependencyClosure`（与 T15-04 PackService 同一个依赖解析器，不建第二套）；
  lifecycle `createRun` 经可选 `packProvenance` 依赖注入调用；桌面生产组合在 quiescent
  startup 用同一批 pack stores 构造并注入。**无新 migration / 无新 authority / 无新 IPC /
  无 renderer 改动**；事件仍只有既有 run 事件（不加 `pack.pinned` 之类词汇）。

## E2E Evidence（T15-06）

`tests/sprint15/industry-pack-framework-e2e.test.ts`（26 项）以真实基础设施证明本 ADR 的运行时
独立性：创建后 Run 只读 pinned snapshot；真实 close/reopen + fresh service graph 后 provenance
精确保留；recovery 与 engine drive 期间 run provenance resolver 调用为 0；EvidenceGuard 仍以
run-pinned WorkflowVersion 为权威（缺证据拒 / 真实证据过，升级+停用后判定不变）；corrupt
PackVersion 行只影响**新** Run（fail closed），既有 Run 不重读。未新增 ADR/迁移/authority/IPC。

## Decision 10：Pack 管理 authority 与边界

- 新增唯一 Pack mutation authority：**`pack.manage`**（用于 install/enable/disable/upgrade）。
  Sprint 15 **不加** `pack.read`（Pack read/catalog 未来公开需另行 contract）。`pack.manage` 也不能
  grant authorities / assign owner / bypass closed authority catalog / execute Pack code——它只管理
  声明式 Pack lifecycle。本 ADR 仅冻结语义；**加入 AUTHORITIES 目录属 T15-02**。
- **无新 IPC**（pack.install/disable/enable IPC 均未批准）：Sprint 15 先实现 trusted application
  service；Renderer 暴露是后续独立决策（默认 NO NEW RENDERER UI）。

## Rejected

- 每 Stage/每次恢复重解析 active Pack（可复现性破坏）。
- pin 全部 enabled packs（噪声 + 伪依赖）。
- 以 PackContentRef 充当运行时权威（平行真相来源）。
- 以 CommandLedger 充当永久安装身份（有界缓存）。

## Consequences

- T15-03：三 store + 迁移 + 永久身份 + one-active-version 强制。
- T15-05：createRun 填充 packVersions（used-closure）+ 生产组合 + 恢复/证据门独立性回归。
- Sprint 14 冻结面零改动；无 Pack 的 Run（packVersions={}）永远合法。
