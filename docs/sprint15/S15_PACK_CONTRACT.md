# S15 Pack Contract（Sprint 15 — Task-15-01 Architecture Freeze）

> 状态：**FROZEN**（Accepted：`TASK-15-01 APPROVED` 指令全文，2026-09-26）。
> 配套：`docs/adr/0024-industry-pack-domain-model.md` · `0025-pack-versioning-and-installation-lifecycle.md`
> · `0026-pack-dependencies-and-conflict-resolution.md` · `0027-pack-provenance-and-run-pinning.md`
> · `docs/sprint15/S15_TASK_BREAKDOWN.md` · `docs/sprint15/S15_TEST_STRATEGY.md`。
> Mission（roadmap 冻结，不改）：让行业能力以 Pack 方式扩展，Core 保持行业无关（AC15.1–15.3）。

## 1. Pack 定义（ADR-0024）

**Industry Pack = immutable versioned declarative configuration bundle（DATA / CONFIG ONLY）。**
非 plugin / code module / runtime object / dynamic extension。禁止携带：JS/TS 可执行模块、Python、
shell、native executable、eval code、dynamic import target、MCP server 实现、任意 callback。
Loader 只 **validates data + resolves declarations + never executes Pack-supplied code**。
无 filesystem payload ⇒ 无 SQLite+FS 双写事务。未来 executable Pack 需独立 ADR/security model。

## 2. 九类 Canonical 声明（不加不减；Workflow Templates ≠ Templates）

> **T15-02 实现裁定**：第九类 Generic Templates 的字段 schema 仓库从未定义（规划书不在仓内；
> TASK-15-02 报 GAP 后由 Boss OPTION 2 冻结最小契约——**schema 来源 = TASK-15-02 架构裁定，
> 非规划书原文**）。最小契约 `{ key, kind, content: JsonValue }`：`kind` 为 opaque token
> （Core 不解释不切换，非 authority/capability/可执行 handler/module 名）；`content` 仅
> JSON-safe inert data（function/undefined/bigint/symbol/class instance/Date/Buffer/
> 非有限数一律校验拒绝，绝不 stringify 静默丢字段）；看起来像代码的字符串仍按惰性数据处理；
> 不建模板变量引擎/渲染 runtime；不得替代 workflowTemplates/prompts。参与指纹：对象键递归
> 排序（等价键序同指纹）；**数组保序**（数组序即模板数据语义，数组序变指纹变）。

| # | 类别 | 语义边界 |
|---|---|---|
| 1 | Roles | archetype/定义数据；authority 名必须 ∈ AUTHORITIES 闭集；安装不分配角色 |
| 2 | Workflow Templates | 声明 → 经 lifecycle service 物化（seed 为 draft → publish 走既有流程） |
| 3 | Prompts | 声明式数据；不引入新 runtime prompt engine（Sprint 8 assembly 不变） |
| 4 | Tools | **REQUIREMENTS, NOT IMPLEMENTATIONS**：required toolId/capability 存在性验证 |
| 5 | Validators | Tool capability `validation:validator` 需求 → 物化进 pinned WorkflowVersion `stage.config.validatorIds` |
| 6 | Artifacts | artifact kind 词汇/期望声明；不建 Artifact 子类/可变 schema（ADR-0015 权威） |
| 7 | Risk Rules | 声明式 policy 数据；不绕过 RiskLevel/Tool risk/authorization/approval |
| 8 | Capability Rules | required/exposed capability 关系数据；不授予权限、不建可执行 capability |
| 9 | Templates（Generic） | 独立类别（≠ WorkflowTemplate ≠ Prompt）；字段不足 ⇒ T15-02 报 `PACK_GENERIC_TEMPLATE_SCHEMA_GAP` |

**Agent 不是 Pack 内容**：无 AgentDefinition（S15 不引入）；人员/执行角色经 Roles + Workflow config 表达；
绝不引用 AgentExecution。

## 3. Canonical Manifest（ADR-0024 D3 字段收敛）

**Core = semantic authority；contracts = transport/validation projection；CORE_BOUNDARIES = 文档。**
三者一一对应，conformance tests 锁定（T15-02）。canonical 命名：`manifestVersion` / `packId` /
`packVersion` / `coreApi`（精确版本串）/ `name` / `capabilities` / `dependsOn`（exact-version 正规化）/
九类 declarations。legacy 别名（contracts `id`/`version`/`schemaVersion`/`coreApi`、core `apiVersion`、
`displayName`、`provides.*`）由 T15-02 收敛，禁止永久双命名。

## 4. 两个核心概念（不合一）

- **PackVersion**：immutable；全局身份 `(packId, packVersion)`；同 id+version 不同 canonical content ⇒
  **CONFLICT**（canonical fingerprint/hash 由 T15-02/03 落地）。
- **PackInstallation**：companyId-scoped mutable binding；`status ∈ {installed, disabled}`
  （installed=可供新解析；disabled=不可供新解析）；**无 PackActivation 实体/表**。

## 5. 生命周期（ADR-0025）

- **Install**：validate manifest → core 兼容 → dependencies → conflicts → privileges → declarations →
  prepare all materialization，全部 PASS 才可见 installed（PREVALIDATE FIRST / FAIL BEFORE VISIBILITY）；
  多 durable 对象经既有 UnitOfWork all-or-nothing；禁止 half-installed。
- **Disable**：live capability residue 归零（新 selection/catalog/role/capability/materialization 全停）；
  历史全保留（Run snapshots/WorkflowVersions/Events/Artifacts/Validations/Tool provenance/Pack provenance）。
  **AC15.3 "no residue" = no LIVE CAPABILITY RESIDUE，非擦除历史审计**。
- **Sprint 15 unload = 非破坏性 disable**；destructive uninstall/GC = Deferred（future ADR）。
- **Re-enable**：须完整重新验证（manifest/依赖/冲突），不得跳过。
- **Upgrade v1→v2**：install immutable v2 → validate → v2 供未来解析 → v1 disabled（v1 历史可寻址）。
  无自动升级。**One-active-version**：`companyId+packId` 同时至多一个 installed 版本。
- **既有 Run**：不切换版本、不重解析、不因 disable 失败——沿用创建时 pinned context。

### 5.1 执行点与命令身份（T15-04 冻结）

- `pack.manage` 是**唯一** mutation authority（install/enable/disable/upgrade 共用）；无 `pack.read`/
  `pack.install`/`pack.enable`/`pack.disable`/`pack.upgrade`；公司域执行（decide 带 scopeId + actor 须
  持该公司角色）——跨公司写入即 `PACK_COMPANY_SCOPE_DENIED`。
- **命令永久身份（Sprint 13 Option B）**：ledger 是有界重试缓存；durable installation 的
  `creation_command_id` + `creation_command_fingerprint` 是永久幂等真相。同命令不同 manifest ⇒
  `PACK_COMMAND_FINGERPRINT_CONFLICT`；同 tuple 不同命令 ⇒ 重放既有 installation（不建第二行）；
  ledger 被裁剪后仍按永久身份重放。
- **PackVersion 身份不可变**：`(packId, packVersion)` 已存在且 manifestFingerprint 不同 ⇒
  `PACK_VERSION_CONFLICT`（零写入，绝不改写）；同一 PackVersion 跨公司复用（不复制 manifest 行）。

### 5.2 物化矩阵（T15-04 冻结：九类声明 → 实体映射）

| 声明类别 | 物化方式 | PackContentRef.materializedEntityRef |
|---|---|---|
| roles | `authorization.defineRole`（仅定义，**绝不分配用户**）；key = 扁平化命名空间键 | Role id |
| workflowTemplates | `lifecycle.createTemplate` + `saveDraftGraph`（公司域 draft；不改写已发布版本） | WorkflowTemplate id |
| prompts / tools / validators / artifacts / riskRules / capabilityRules / templates | pack-native，无子系统实体（tool/validator 只做需求验证，不装 adapter/不配凭据） | `null` |

- 每条声明项恰好一条 contentRef（1:1；出现 1→N 即 `PACK_CONTENT_REF_CARDINALITY_GAP` 硬停）。

### 5.3 Disable 的 live-capability 边界（T15-04 corrective — PACK_LIVE_CAPABILITY_DISABLE_GAP）

`status` 只是 Pack 自身的可用性来源；物化进子系统后的实体必须由 **availability policy**
（`PackAvailabilityPolicy`，Core 端口）在**权威 new-use 入口**拦截，语义：

- 无 contentRef 指向该实体 => 非 Pack 内容 => 永不拦截；任一 owning installation 为
  installed => live；全部 owning installation 均 disabled => 拒绝新使用（any-live-owner，
  公司域）。v1 disabled + v2 installed 共享同一物化 Role 时该 Role 仍可分配。
- Role：`AuthorizationService.assign`（新分配）拒绝（POLICY_DENIED /
  reason=PACK_MATERIALIZED_CONTENT_UNAVAILABLE）；既有分配、角色行、历史 grant 记录保留可读。
- Workflow：`saveDraftGraph` / `publish` / `publishRevision` / `fork` / `createRun` 拒绝；
  `readTemplate` / `readSnapshot` / `eventsOf` 与既有 Run/Version 历史解析不拦。
- 不新增 Role/Template 状态字段、不 delete provenance、不加 migration；Tool/Validator 全局
  实体不受 Pack disable 影响（只撤该 Pack 的 requirement live 性）。
- role key = `<packId>-<name>`（命名空间键扁平化，满足 Role key 契约）；本 pack 早前版本物化过的 role
  仅在**逐字节相同**声明下被升级复用，否则 `PACK_ROLE_CONFLICT`（禁止静默改写 role authority）。
- 事件词汇：`pack.installed` / `pack.enabled` / `pack.disabled` / `pack.upgraded`；payload 白名单
  （companyId/packId/packVersion/installationId/actorId/traceId），禁 manifest 正文/prompt/模板内容/密钥；
  事件仅在 UoW 提交成功后发射（回滚测试断言无 `pack.installed`）。

## 5.4 Run Pack Pinning（T15-05 — ADR-0027 Decision 1/2）

- **可信导出，非调用方输入**：`CreateRunInput` 没有 `packVersions` 字段；Run 的
  `packVersions` 由 `PackRunProvenancePolicy`（Core 端口，engine 实现
  `createRunPackProvenanceResolver`）在**新 Run 创建的写阶段之前**解析并写入 snapshot。
- **root provenance**：选中 materialized WorkflowTemplate 的 live owners（company 域，
  status = installed）；**pinned set** = 所有 live root owners + 传递 REQUIRED exact
  依赖闭包（复用 T15-04 同一依赖解析器）；同一 packId 两个版本 ⇒ CONFLICT。
- **packless**：无 owner ⇒ `{}`。**顺序**：按 packId 排序，确定性 JSON。
- **fail closed**：依赖 missing/disabled/unknown/cycle/corrupt ⇒ createRun 失败，0 Run、
  0 RunSnapshot。**runtime 不反查**：创建后只读 pinned snapshot；既有 Run/Version 的
  历史读与恢复不受影响；Pack 升级/停用后旧 Run 的 `packVersions` 永不改写。

## 6. 依赖与冲突（ADR-0026）

仅 REQUIRED 依赖；Pack→Pack 显式声明 + **exact version**（无 semver solver：`^`/`>=`/`latest` 禁）；
`dependsOn` 结构由 T15-02 正规化；install/enable 验证**传递闭包**；**环 reject**；依赖缺失 fail closed
（无自动安装）。Capability 依赖与 Pack 依赖分离。**Provider 只可 require logical model capability**
（禁 vendor；不注册凭据）。Tool = 需求验证（不装 adapter/不绕过 registry 门禁）。Validator → pinned
WorkflowVersion（EvidenceGuard 只读 run-pinned 版本，永不查 active Pack latest）。**NO IMPLICIT
OVERRIDE**：同 logical key 冲突 ⇒ CONFLICT。命名空间 `<packId>:<name>`（logical key，不改 branded
ULID）。**无继承/无覆盖**：组合只经 required dependency。

## 7. 权限与信任（ADR-0026 D7 / ADR-0027 D10）

Pack 不创造 authority 词汇、不自动分配角色、不授予 owner、不修改 bootstrap owner；安装本身 MUST NOT
给用户分配角色（assignment 走既有授权流程）。**manifest 在校验边界视为 untrusted data**（即使
first-party/本地/fixture 也完整校验）。S15 不实现签名/marketplace/remote 信任/可执行沙盒（Deferred）。

## 8. Run Pinning 与运行时独立（ADR-0027）

- 解析 **AT RUN CREATION（仅一次）**；`RunSnapshot.packVersions`（既有字段）为 carrier：只 pin
  **实际贡献该 Run 的 packs + 传递 required 闭包**（不塞全部 enabled）。
- Run 创建后 execution/validation/recovery/audit **不回查** active Pack 状态/最新版本/catalog。
- 运行时相关内容先物化/固化进既有 immutable 结构（WorkflowVersion/stage config/validatorIds/
  toolVersion provenance/packVersions）；物化只经既有 service contract（禁 PackService raw SQL 直写）。
- **Recovery never resolves current active Pack**（Sprint 14 冻结延续）。
- 历史可复现：old Run 永远按旧 pin + 历史 provenance 解释，不自动变成 v2。

## 9. PackContentRef（REQUIRED domain concept）

> **T15-02 裁定**：`materializedEntityRef` 为 **NULLABLE**（source identity 恒必填、外部物化
> 目标条件必填）：已物化到既有子系统的声明记录真实 durable entity ref；Pack 原生声明
> （Generic Templates/Prompts/Risk Rules/Capability Rules——Sprint 15 无独立 durable 子系统）
> 记录 `null`，provenance 由 (packId, packVersion, contentKind, logicalKey) 唯一定位。
> 禁止伪造实体 id/建无意义通用表/把 PackVersion 冒充物化实体。运行时权威不变。

`packId + packVersion + content kind + materialized entity identity` 的 durable provenance mapping；
用于 audit / disable visibility / conflict detection / historical provenance / tenant isolation。
**不是运行时内容**：不替代 WorkflowVersion / ToolInvocation provenance / Artifact identity 权威。

## 10. 持久化（REQUIRED；T15-03 已实现）

新 opt-in 链 **`pack`**（migration `pack/0001_pack_persistence.sql`，三表）：

- **pack_versions**：`(pack_id, pack_version)` 主键；canonical_manifest_json；manifest_fingerprint
  **qualified SHA-256 ref**（CHECK 长度 71 + `sha256:` 前缀，唯一格式，无裸 hex 兼容）；INSERT-only
  （identity 相同 fingerprint → replay；不同 fingerprint → CONFLICT；读时重算校验，损坏即
  fail closed）。
- **pack_installations**：installation_id 主键；company_id；pack_id；pack_version；status
  **CHECK IN ('installed','disabled')**；capabilities_json；installed_by/installed_at/updated_at；
  creation_command_id（**UNIQUE**）/creation_command_fingerprint；**UNIQUE(company_id, pack_id,
  pack_version)**；**partial UNIQUE index (company_id, pack_id) WHERE status='installed'**
  （one-enabled-version 由数据库强制，防 race）。**无跨链 FK**：PackVersion 存在性在安装事务内
  校验（缺失 → NOT_FOUND fail closed）。
- **pack_content_refs**：PRIMARY KEY (installation_id, content_kind, logical_key)；content_kind
  CHECK = 九类闭集；materialized_entity_ref **可空**；JOIN pack_installations 重建
  (packId, packVersion) 所有权锚；INSERT-only，无 update/delete/GC。
- 永久安装身份沿用 Sprint 13 pattern（creation command identity/fingerprint；ledger 仅 retry cache）。

## 11. Authority / IPC / Renderer

- 新增唯一 mutation authority **`pack.manage`**（install/enable/disable/upgrade）；**无 `pack.read`**；
  `pack.manage` 不得授予权限/owner/绕过闭集/执行代码。入 AUTHORITIES 目录 = T15-02。
- **NO NEW IPC**（pack.install/disable/enable IPC 未批准）：先做 trusted application service；
  Renderer 默认 NO NEW UI。

## 12. Legacy 兼容与既有系统交互

Pack **ADDITIVE**：无 Pack 的 WorkflowTemplate/Run（packVersions={}）永远一等公民；禁迁存量入默认
Pack、禁强制 Pack、禁隐藏默认 Pack。Sprint 14 恢复、ADR-0015 Artifact、ADR-0019 Tool 溯源、
ADR-0020 证据门、Handoff/Memory 冻结面全部不动（Pack 不改写已创建 Handoff 版本、不 rewrite Memory、
不使历史 Artifact/Validation 失效）。

## 13. Canonical First Pack

Sprint 15 **无真实行业 Pack**（DevCompany=Sprint 16）。测试仅用 industry-neutral fixture
（`pack.fixture` 类命名，遵守真实 schema）。

## 14. Non-Goals（冻结）

marketplace · remote download · zip import · signature verification · 第三方可执行插件 · 动态
JavaScript · Pack inheritance · Pack overrides · semver-range solver · optional/recommended 依赖 ·
自动升级 · hard-delete uninstall · Pack GC · 存量工作流自动迁移 · AI 自动选 Pack · renderer
marketplace · Sprint 16 DevCompany。
