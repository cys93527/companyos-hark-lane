# Sprint 15 Task Breakdown（Task-15-01 冻结产物）

> 状态：**FROZEN**（Accepted：`TASK-15-01 APPROVED` 指令 §73/§74，2026-09-26）。
> 配套：`S15_PACK_CONTRACT.md` · `S15_TEST_STRATEGY.md` · ADR-0024/0025/0026/0027。
> Mission 不变（roadmap 冻结原文）。纪律：逐 Task 独立 commit → 完成即停 → 等 Boss review +
> `TASK-15-0X APPROVED`。

## 依赖图（§74 冻结：线性，避免 domain/persistence 未冻结时并行实现）

```text
T15-01 → T15-02 → T15-03 → T15-04 → T15-05 → T15-06 → T15-07
```

### Task-15-01 Industry Pack Architecture Freeze（**已完成：本 commit；ADR-0024/0025/0026/0027 Accepted + 本文件 + Pack Contract + Test Strategy**）
- Docs/ADR only；零 production/test/migration/IPC/renderer/fixture。

### Task-15-02 Pack Domain & Canonical Manifest Contracts（**已完成（含 TASK-15-02 Boss 澄清裁定）：`packages/core/src/registry/pack-manifest.ts` canonical 语义权威（九类声明 + PackDependency 精确版本 + 命名空间 + 严格校验 + forbidden 字段拒绝 + JsonValue）；`packages/core/src/domain/pack.ts`（canonical PackInstallation + createPackInstallation + PackVersion/manifestFingerprint + PackContentRef nullable）；`packages/contracts/src/pack-manifest.ts` canonical zod 投影 + legacy alias 归一化（冲突即拒）；`pack.manage` 入 AUTHORITIES 目录（vocabulary-only，执行点=T15-04）；测试：core/pack-manifest 13 + contracts/pack-manifest 12（既有 envelope pack 段 canonical 化）+ tests/sprint15/pack-contracts 13；零 persistence/migration/PackService/IPC/renderer**）
- **Goal**：canonical PackManifest（九类声明齐，含 Prompts/Risk Rules/Capability Rules/Generic
  Templates 新契约——Generic 字段不足即报 `PACK_GENERIC_TEMPLATE_SCHEMA_GAP`）；字段收敛落地
  （canonical 命名 + contracts zod 一一对应 + conformance tests）；validation/normalization；
  PackVersion / PackContentRef 域契约；`pack.manage` 加入 AUTHORITIES 目录；`dependsOn` exact-version
  正规化。**NO persistence**。
- **Dependencies**：T15-01。 **Files**：`packages/core/src/registry/pack-manifest.ts`、
  `packages/core/src/domain/pack.ts`、`packages/contracts/src/pack-manifest.ts`、tests。

### Task-15-03 Pack Persistence & Durable Identity（**已完成：migration `pack/0001`（三表）+ `core/src/ports/pack.ts` 三 Store port + `persistence/src/durable/sqlite-pack-stores.ts` 三 SQLite 实现 + `pack` chain 注册（expected-chains 12→13、desktop chains）+ `packages/persistence/tests/pack-persistence.test.ts` 25 项矩阵**）
- **Goal**：PackVersionStore / PackInstallationStore / PackContentRef store + 迁移（新 pack 链或并入
  既有——按 repo 惯例定）；canonical manifest snapshot + content hash；`(companyId,packId,packVersion)`
  永久身份 + 幂等重放；company 隔离；one-active-version 不变量强制。
- **Dependencies**：T15-02。

### Task-15-04 PackService & Dependency Resolution（**已完成：`packages/engine/src/pack/pack-service.ts`
`createPackService`（install/enable/disable/upgrade/listInstalled/getInstallation/getPackVersion）+ engine index
导出；`tests/sprint15/pack-service.test.ts` 29 项矩阵（九类声明 happy path + 授权/租户 + 依赖 + preflight +
永久幂等 + disable/enable/upgrade + 边界结构锁）。无新 migration / 无新 IPC / 无 renderer / 无新 authority /
无 Run pinning 变更**）
- **Goal**：install / enable / disable / upgrade（PREVALIDATE FIRST、fail-before-visibility、UoW 原子）；
  传递依赖闭包 + 环检测 + 冲突检测；物化编排（经既有 service contract，禁 raw SQL）；`pack.manage`
  授权执行点；失败语义 fail-closed；事件词汇落定（候选 pack.installed/activated/disabled——未冻结前不新增）。
- **Dependencies**：T15-03。
- **实现落点（T15-04 裁定，文档=实现权威）**：
  - **服务 API**：`createPackService(deps)` → `install / enable / disable / upgrade / listInstalled /
    getInstallation / getPackVersion`；输入仅 `commandId / companyId / actorId / manifest（+ packId/packVersion
    于 enable/disable/upgrade）`；fingerprint、installationId、status、时间戳、contentRefs 全部 trusted 派生。
  - **install 管道（冻结序）**：authorize `pack.manage`（company scope：decide + actor 须持该公司角色）→
    canonical PackVersion（manifest 校验 + `sha256:<64hex>` fingerprint）→ 命令永久身份（ledger 指纹 +
    durable creation_command_id/fingerprint + PackVersion 行指纹 + tuple 重放）→ 依赖闭包（exact、transitive、
    候选含入）→ preflight（role key/authority、tool 需求、validator capability）→ ONE UnitOfWork：
    packVersions.put → installation create → 物化（roles 经 authorization.defineRole 且绝不分配用户；
    workflowTemplates 经 lifecycle.createTemplate + saveDraftGraph）→ PackContentRefs（每声明一条）→
    事件 → commit。
  - **依赖解析**：仅 REQUIRED exact 版本；availability=**installed status**（disabled 不可解析）；环检测
    先于 availability（图形状先于可用性）；missing/cycle/self/unknown 四种 CONFLICT 码；无 auto-install。
  - **物化语义**：role key = 命名空间键扁平化（`<packId>:<name>` → `<packId>-<name>`，满足 Role key
    契约）；本 pack 早前版本物化过的 role 在**逐字节相同**声明下可复用（升级复用），否则 PACK_ROLE_CONFLICT
    （不静默改写 role authority）；pack-native 六类（prompt/tool/validator/artifactType/riskRule/capabilityRule/
    template）`materializedEntityRef = null`。
  - **Disable live-capability corrective（PACK_LIVE_CAPABILITY_DISABLE_GAP）**：Core 端口
  `PackAvailabilityPolicy`（derived，无新 migration）+ engine `createPackAvailabilityPolicy`；守卫落在
  权威 new-use 入口（`AuthorizationService.assign`；lifecycle 的 saveDraftGraph/publish/
  publishRevision/fork/createRun），读路径与既有 Run 不拦；any-live-owner + 公司域；生产组合
  （desktop main.ts）注入同一实例。
- **事件词汇（冻结）**：`pack.installed` / `pack.enabled` / `pack.disabled` / `pack.upgraded`；payload 白名单
    （companyId/packId/packVersion/installationId/actorId/traceId），禁 manifest 正文/prompt/模板内容/密钥；
    事件仅在 UoW 提交成功后发射。
  - **升级**：v2 install + v1 disable 同 UoW（先 disable 旧版再插新版，保 partial unique index 一致）；存在
    依赖 exact 旧版的已装 pack ⇒ PACK_DEPENDENCY_IN_USE 拒绝；重放幂等。
  - **禁用守卫**：disable 与 upgrade-away 均拒绝“被已装 pack 依赖”的 exact 版本（PACK_DEPENDENCY_IN_USE）；
    disable 不删除任何 durable 事实。

### Task-15-05 Run Pack Pinning & Production Composition（**已完成：Core 端口
`PackRunProvenancePolicy` + engine `createRunPackProvenanceResolver`；`CreateRunInput.packVersions`
已移除（trusted derived data）；lifecycle `createRun` 写阶段前解析；desktop 生产组合注入
（同一批 pack stores）；`tests/sprint15/pack-run-pinning.test.ts` 23 项矩阵。无新 migration /
authority / IPC / renderer，Run 事件词汇不变**）
- **Goal**：createRun 填充 `RunSnapshot.packVersions`（used-pack 传递闭包）；生产组合接线
  （trusted main-process capability，无新 IPC）；legacy packless 工作流不受影响；恢复独立性
  （Recovery/审计不回查 active Pack）+ EvidenceGuard 回归。
- **Dependencies**：T15-04。
- **实现落点（T15-05 冻结）**：
  - **Root contributor**：选中 materialized WorkflowTemplate 的 **live owners**
    （PackContentRef `workflowTemplate` → PackInstallation status=installed，公司域）。
  - **Pinned set**：所有 live root owners + 传递 REQUIRED exact 依赖闭包（复用 T15-04 同一
    `resolveExactDependencyClosure`，不建第二套 resolver）；同 packId 两版本 ⇒ CONFLICT。
  - **packless**：无 owner ⇒ `{}`；按 packId 排序的确定性 map。
  - **fail closed**：依赖 missing/disabled/unknown/cycle/corrupt ⇒ createRun 失败，
    0 Run / 0 RunSnapshot（解析先于写阶段，无需回滚）。
  - **caller 无 authority**：`CreateRunInput` 无 `packVersions` 字段（编译期拒绝伪造）；
    resolver 结果是唯一权威。
  - **runtime/recovery 不反查**：创建后只读 pinned snapshot；engine/recovery 无 pack 依赖
    （测试 spy 证明 0 调用）；EvidenceGuard 仍以 run-pinned WorkflowVersion 为权威。

### Task-15-06 Industry Pack Framework E2E（**已完成：`tests/sprint15/industry-pack-framework-e2e.test.ts`
26 项 E2E（Scenario A 全链安装九类 / B 安全失败矩阵零写入 / C disable/re-enable / D upgrade+runs /
E restart+recovery+evidence+corrupt 读区分 / F legacy packless+结构锁）。**零 production 变更**
（无 production defect）；新增 engine index 导出共享 provenance primitives 供测试复用**）
- **Goal**：九类声明解析；租户隔离；install/disable/re-enable/upgrade 生命周期；disable 后 live
  capability 消失 + 历史保留；旧 Run 可复现（升级/停用后）；legacy 无 Pack 工作流不受影响；
  安全边界（不造 authority/不配 owner/不执行代码/Tool 需求不装 adapter/Provider vendor 中立）。
- **Dependencies**：T15-05。
- **E2E 覆盖要点**：九类声明 → 一 installation + 九 refs（role/template 真实实体 ref，七类
  pack-native null ref，Generic Template 结构化 JSON 持久化）；tool requirement 不建 ToolRecord/
  不装 adapter/不执行；validator capability 负例 fail closed；未知 authority manifest 阶段拒；
  四种 mutation 无 `pack.manage` 全部 DENIED 零写入；跨公司 mutation 拒；含 `pack.manage` 的
  pack role 不自动分配（无 self-grant）；缺依赖/disabled 依赖/cycle 均 fail closed（无 auto-install）；
  同 tuple 同 fingerprint 跨进程重放零重复；同命令异语义 ⇒ `PACK_COMMAND_FINGERPRINT_CONFLICT`；
  PackVersion 身份冲突 ⇒ `PACK_VERSION_CONFLICT` 且共享一行跨两公司；disable 后 new-use 全拒
  （直调 authz.assign / saveDraftGraph / publishRevision / fork / createRun），历史全保留；
  re-enable 零重复物化；依赖在用 ⇒ `PACK_DEPENDENCY_IN_USE`；upgrade 原子（participant 爆炸时
  v1 不动、无半写 v2）；role 跨版复用（any-live-owner）与改写冲突；R1=v1 / R2=v2 / disable 后
  新 Run 拒而旧 Run 不变；真实 close/reopen + fresh graph 后 provenance 精确恢复，recovery 与
  drive 的 resolver 调用为 0；EvidenceGuard 双半（缺证据拒/真实证据过，升级+停用后不变）；
  corrupt `canonical_manifest_json` ⇒ 新 Run fail closed 而既有 Run 不重读 PackVersion；packless
  工作流 `{}` 且正常执行；结构锁（无动态代码/loader/marketplace/vendor 字段/新 IPC/renderer/
  新 authority/新 migration）；事件四词汇仅在真实状态变化时出现、重放不重复、payload 白名单。

### Task-15-07 Sprint 15 Full Regression / Closeout
- **Goal**：全量门禁（只增不减）+ 架构一致性审计 + 文档收口 + tag `sprint-15.0.0`（依 G6 惯例）。
- **Dependencies**：全部。

## Deferred Work（只记录，不实现）

destructive uninstall/GC；signature/marketplace/remote 信任；executable Pack 安全模型；optional 依赖；
semver solver；pack.read/catalog 公开面；Renderer 暴露；Generic Templates 若 GAP 则待规划书补充。
