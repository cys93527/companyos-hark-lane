# Sprint 15 Closeout — Industry Pack Framework（T15-01–T15-07）

> 状态：**CLOSED**（本文为 Sprint 15 最终收口记录；独立评审 = Boss 逐 Task review，T15-01~T15-06 均
> 获 `PASS / CLOSED`，T15-07 以本文 + 最终回归 + tag 为准）。真实 commit hash 见本文 §12 与
> `PROJECT_HANDOFF.md`。**未 push、未 release。**

## 1. Mission（roadmap 冻结原文）

让行业能力以 Pack 方式扩展，**Core 保持行业无关**（AC15.2）。一个 Pack 可声明规划书 §十五 的九类内容
（AC15.1）；Pack 卸载后其能力全部消失且不留残迹，Pack 版本被固定进 Run Snapshot（AC15.3）。

## 2. Delivered Capabilities（→ IMPLEMENTED / TESTED / DOCUMENTED）

| # | Capability | 实现 | 测试证据 | 文档 |
|---|---|---|---|---|
| 1 | 架构冻结 | ADR-0024/0025/0026/0027 Accepted + S15 契约三份 | docs guards 全绿 | `docs/adr/` + `docs/sprint15/` |
| 2 | Canonical manifest + 九类声明 | `packages/core/src/registry/pack-manifest.ts`（语义权威：canonical 字段、legacy alias 归一化仅在 contracts、严格校验、forbidden 字段拒绝、JSON-safe Generic Template） | `core/pack-manifest.test.ts`、`contracts/pack-manifest.test.ts`、`tests/sprint15/pack-contracts.test.ts` | ADR-0024 |
| 3 | PackVersion / PackInstallation / PackContentRef 域契约 | `packages/core/src/domain/pack.ts`（qualified `sha256:<64hex>` fingerprint、canonical 排序指纹、nullable materialized ref） | core 域测试 + 7 点 fingerprint 锁 | ADR-0024 |
| 4 | Pack 持久化 | `pack/0001_pack_persistence.sql`（三表 + CHECK + partial unique one-enabled + UNIQUE creation 身份）+ `core/src/ports/pack.ts` + `persistence/src/durable/sqlite-pack-stores.ts` + pack chain（12→13） | `packages/persistence/tests/pack-persistence.test.ts` 25 项 | ADR-0025/0027 |
| 5 | PackService 生命周期编排 | `packages/engine/src/pack/pack-service.ts`（install/enable/disable/upgrade + list/get；冻结序管道；UoW 原子） | `tests/sprint15/pack-service.test.ts` 34 项 | ADR-0025 |
| 6 | Disable live-capability 守卫 | `pack-availability.ts` + Core 端口 `PackAvailabilityPolicy`；守卫落在 `AuthorizationService.assign` 与 lifecycle 五个 new-use 入口 | 同上（corrective 5 项） | ADR-0025 D4 |
| 7 | Run Pack Pinning | `run-pack-provenance.ts` + Core 端口 `PackRunProvenancePolicy`；`createRun` 写阶段前解析；`CreateRunInput.packVersions` 移除 | `tests/sprint15/pack-run-pinning.test.ts` 23 项 | ADR-0027 |
| 8 | 生产组合 | `main.ts`：availability policy + run provenance resolver 以同一批 pack stores 构造并注入（无 Pack IPC / 无 renderer / 无自动安装） | composition 级断言 + E2E | ADR-0027 |
| 9 | 框架 E2E | —（纯证据） | `tests/sprint15/industry-pack-framework-e2e.test.ts` 26 项（Scenario A–F） | 本文 §7 |

## 3. Pack Architecture（一句话摘要）

**Pack = 不可变、可版本化的声明式配置束（DATA/CONFIG ONLY）**：canonical manifest 经 Core 校验后成为
`PackVersion`（`(packId, packVersion)` 业务身份 + qualified sha256 fingerprint）；公司域安装成为
`PackInstallation`（installed/disabled 两态，`creation_command_id`+`creation_command_fingerprint` 为
永久身份）；九类声明中 roles/workflowTemplates 经**既有子系统服务**物化（authorization / lifecycle），
其余七类为 pack-native 数据；每次物化/声明留一条不可变 `PackContentRef`（provenance）。Pack 不引入
执行代码、动态加载、继承覆盖、marketplace 或任何 renderer/IPC 面。

## 4. Nine Declarations（闭环证据）

安装一个含全部九类声明的行业中立 fixture 后：`PackContentRef` 数 = 声明项数 = **9**；`role` 与
`workflowTemplate` 带真实 `materializedEntityRef`（Role id / Template id），`prompt`/`tool`/`validator`/
`artifactType`/`riskRule`/`capabilityRule`/`template` 七类为 `null`（pack-native，无子系统实体）。
**无第十类**（`PACK_CONTENT_KINDS` 闭集 = 九项）。

## 5. Persistence Model

- 唯一新迁移：`packages/persistence/migrations/pack/0001_pack_persistence.sql`（opt-in `pack` 链，13 链之一）。
- 三表：`pack_versions`（PK `(pack_id, pack_version)`，INSERT-only，`manifest_fingerprint` CHECK
  `length=71 AND GLOB 'sha256:*'`）/ `pack_installations`（两态 CHECK、`UNIQUE(company,pack,version)`、
  `UNIQUE(creation_command_id)`、partial UNIQUE index `(company,pack) WHERE status='installed'`）/
  `pack_content_refs`（PK `(installation_id, content_kind, logical_key)`，九种 kind CHECK，
  `materialized_entity_ref` nullable）。
- **无 FK**（PackVersion 存在性在调用方事务内校验）；无 marketplace / download cache / signature /
  PackActivation / scheduler / renderer state 表。读路径 fail closed（manifest/fingerprint 损坏 →
  错误而非部分对象）。
- 空库全迁移 + Sprint 14 schema 升级后 pack 迁移应用且旧数据完好（既有 persistence 测试矩阵）。

## 6. Lifecycle / Dependency / Provenance Model

- **生命周期**：install（预检先行、失败于可见性、单 UoW 原子）→ enable（完整重验证、零重物化）→
  disable（无 live 残迹、历史全保留、被依赖时 `PACK_DEPENDENCY_IN_USE`）→ upgrade（同 UoW：v2 installed
  + v1 disabled，v1 可寻址；participant 失败则整体回滚，v1 不动）。
- **依赖**：仅 REQUIRED + exact version（无 optional/recommended/peer/range/latest）；传递闭包 + 环检测
  先于可用性检查；availability = installed status；无 auto-install；同 packId 两版本 ⇒
  `PACK_MULTIPLE_INSTALLED_VERSIONS`（fail closed，绝不 last-wins）。**单一共享 resolver**
  （`resolveExactDependencyClosure`，T15-04 提取后 PackService 与 Run pinning 共用）。
- **Run provenance**：`RunSnapshot.packVersions` 是**可信导出数据**（`CreateRunInput` 无该字段）；新 Run
  创建时在写阶段前由 live owners of selected materialized WorkflowTemplate + 传递 REQUIRED exact 依赖
  闭包解析（packless ⇒ `{}`；按 packId 排序；immutable）；创建后 advance/review/validation/finalize/
  recovery 一律不回查 active Pack。
- **安全不变量**：`pack.manage` 为唯一 Pack mutation authority（无 pack.read/install/enable/disable/
  upgrade/admin）；Pack 不铸造 authority、不分配用户/owner、不改 bootstrap owner；Tool/Validator 仅需求
  验证（不装 adapter/不执行/不停用全局 Tool）；Provider 仅 logical capability（schema 无 vendor 字段）；
  事件词汇仅 `pack.installed/enabled/disabled/upgraded`，payload 白名单，仅 UoW 成功后发射，重放不重复。

## 7. E2E Evidence（T15-06，Scenario A–F）

`tests/sprint15/industry-pack-framework-e2e.test.ts` 26 项，全部真实基础设施（SQLite + 迁移 + pack
stores + UoW + authorization + PackService + lifecycle + ToolRegistry + EventStore + availability policy
+ run provenance resolver）；仅 mock 外部 provider 行为。

- **A Full Install**：foundation→fixture 依赖链；九类声明 → 九 refs；Generic Template JSON 持久化；
  tool requirement 零 ToolRecord/零 adapter/零执行；真实 provider/model 共存且 vendor 字段被拒。
- **B Security/Failure**：缺依赖 / 未知 authority / validator 缺 capability / 无 `pack.manage` 四类
  mutation / 跨公司 mutation ⇒ 全部 fail closed 且零 durable 写入；pack role 不自分配；durable cycle
  无栈溢出。
- **C Disable/Re-enable**：五个 new-use 入口直调全部 `POLICY_DENIED`；历史全保留；re-enable 零重复
  物化；依赖在用拒绝 disable；disabled 依赖不能支撑安装。
- **D Upgrade+Runs**：R1=v1 / R2=v2 / v1 保留 disabled / one-enabled 不变式；role 跨版复用与改写冲突；
  upgrade 原子；永久幂等 / 命令冲突 / PackVersion 身份冲突 / 同版本跨公司共享一行。
- **E Restart/Recovery**：真实 close/reopen + fresh graph；provenance 精确保留；recovery 与 drive 的
  resolver 调用为 0；EvidenceGuard 双半；corrupt `canonical_manifest_json` ⇒ 新 Run fail closed 而既有
  Run 不重读；同 packId 两 root 版本 ⇒ `PACK_MULTIPLE_INSTALLED_VERSIONS`。
- **F Legacy**：packless 工作流 `{}` 且 create/advance/recovery 正常；结构锁（动态代码 / loader /
  marketplace / vendor / 新 authority / IPC / renderer / 新 migration 全无）；事件四词汇仅真实变化、
  重放不重复、payload 白名单。

## 8. Test Evidence（收口时点）

- `pnpm check` 5× PASS（lint/typecheck/boundaries/test/build）；`pnpm test:scripts` 23/23；
  `git diff --check` clean；Sprint 15 touched 文件 UTF-8 有效、0 U+FFFD、0 NUL。
- vitest **122 文件 / 1387 用例全绿**（Sprint 14 收口基线 116/1258 → +6 文件 +129 用例，只增不减）。
- 新增套件：`tests/sprint15/pack-service.test.ts`（29+5=34）、`pack-run-pinning.test.ts`（23）、
  `industry-pack-framework-e2e.test.ts`（26）；既有 `core/pack-manifest`、`contracts/pack-manifest`、
  `packages/persistence/tests/pack-persistence.test.ts`（25）与 T15-02 contracts 套件全绿。

## 9. Known Limitations（诚实记录 — 有意范围/延后，非缺陷）

1. 无 marketplace / signature verification / remote import（Sprint 15 OUT OF SCOPE）。
2. 无可执行 Pack（DATA/CONFIG ONLY）；无动态代码/loader/zip/download。
3. 无 Pack 继承 / override / last-writer-wins（NO IMPLICIT OVERRIDE）。
4. 无 semver range solver；无 optional/recommended/peer 依赖。
5. 无 hard-delete uninstall / Pack GC（Sprint 15 unload = 非破坏性 disable）。
6. 无 Pack IPC、无 Pack renderer UI（PackService 为 trusted application service）。
7. 无 automatic Pack selection；无 runtime 跨 Pack content selector（因此不猜额外贡献 Pack）。
8. Generic Template 无 runtime engine（declaration-only JSON）。
9. CommandLedger 有界、非永久真相（永久身份 = installation 行）。
10. 同一 materialized 实体被多 live owner 共享时全部 pin（真实生产中 workflow template 由各版本各自
    物化；多 owner 共享为合法但罕见的 durable 状态， resolver 已定义语义）。
11. 无真实行业 Pack（DevCompany 等延至 Sprint 16）。

## 10. Deferred Work（只记录，不实现）

Sprint 16 DevCompany Pack；Pack UI / Pack IPC（如后续批准）；marketplace/signature/remote import；
optional 依赖与 semver range；hard uninstall/GC；dynamic/executable Pack model（仅未来 ADR）；
automatic Pack selection；跨 Pack 的 runtime content selector。

## 11. Final Blocker Matrix（逐项 NONE）

Manifest Contract / Generic Template / PackVersion / PackInstallation / PackContentRef / Persistence /
Lifecycle / Disable Semantics / Dependency / Authorization / Run Pinning / Recovery Independence /
EvidenceGuard / Tenant Isolation / Security / IPC Boundary / Renderer / Documentation：
**全部 NONE**。

## 12. Final Record

- Commit 链（基线 `d5bddbb` = tag `sprint-14.0.0`）：
  `21c983f`（T15-01 架构冻结）→ `ea0d206`（T15-02 canonical 契约）→ `b3d8243`（fingerprint qualified
  纠正）→ `246ae48`（T15-03 持久化）→ `330ac8a`（T15-04 PackService）→ `821afd4`（T15-04 corrective：
  disable live-capability guard）→ `fe5c0aa`（T15-05 Run Pack Pinning）→ `c0b5aa9`（T15-06 E2E）→
  closeout commit（本文，见 `PROJECT_HANDOFF.md`）。
- Tag：`sprint-15.0.0`（依 G6 惯例与 sprint-1.0.0…sprint-14.0.0 先例），指向最终 closeout HEAD；
  **未 push、未 release**。
- T15-01–T15-06 全部 CLOSED（逐 Task 独立 commit + Boss review）；T15-07 = 本文 + 架构审计 + 文档收口
  + 最终回归 + tag。
- **Sprint 16**：`pending`（DevCompany Pack），未经批准不得开工。
