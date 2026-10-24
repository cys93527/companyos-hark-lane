# ADR-0025：Pack Versioning and Installation Lifecycle（Sprint 15 — Task-15-01 Architecture Decision）

> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：`TASK-15-01 APPROVED` 指令全文）**。
> 配套：ADR-0024（域模型）· ADR-0006/0013（不可变/注册先例）· `docs/sprint15/S15_PACK_CONTRACT.md`。

## Context

PackVersion（不可变声明）已由 ADR-0024 冻结；本 ADR 冻结 company 内的安装/启用/停用/升级生命周期，
并澄清 roadmap AC15.3 "卸载后能力全部消失不留残迹" 的精确含义。

## Decision 1：Company 作用域

**PackInstallation 是 companyId-scoped。** Company A install/disable Pack X 不得改变 Company B。
Pack definition/catalog 可以是共享声明，但 installation/availability 是 **COMPANY LOCAL**。

## Implementation Addendum（T15-03）

持久化由 opt-in `pack` 链落地（migration pack/0001）：`pack_versions`（INSERT-only，qualified
fingerprint CHECK）/ `pack_installations`（两态 CHECK + creation_command_id UNIQUE +
(company,pack,version) UNIQUE + one-enabled partial index）/ `pack_content_refs`（(installation,
kind,key) 主键、nullable materialized ref、JOIN 锚定所有权）。无 FK、无 delete/GC 面、授权仍属
T15-04。

## Implementation Addendum（T15-04 — PackService 生命周期编排）

`packages/engine/src/pack/pack-service.ts` `createPackService(deps)` 落定 Decision 3/4/6/7/8/9：

- **install 管道（冻结序）**：authorize `pack.manage`（company scope：decide 带 scopeId + actor 须
  持该公司角色，否则 `PACK_COMPANY_SCOPE_DENIED`）→ canonical PackVersion（manifest 校验 +
  `sha256:<64hex>` manifestFingerprint）→ 命令永久身份 → 依赖闭包 → preflight → ONE UnitOfWork
  （packVersions.put → installation create → 物化 → PackContentRefs → 事件 → commit）。
- **永久身份**：ledger 为重试缓存；installation 的 `creation_command_id`/`creation_command_fingerprint`
  为真相。同命令异 manifest ⇒ `PACK_COMMAND_FINGERPRINT_CONFLICT`；同 tuple 异命令 ⇒ 重放；
  PackVersion 行指纹不一致 ⇒ `PACK_VERSION_CONFLICT`（零写入）；同 PackVersion 跨公司复用。
- **物化**：roles 经 `authorization.defineRole`（仅定义、绝不分配用户）；workflowTemplates 经
  `lifecycle.createTemplate` + `saveDraftGraph`（公司域 draft，不改写已发布版本）；其余七类 pack-native，
  `materializedEntityRef = null`。每声明项恰一条 contentRef（1:1）。
- **role key** = 扁平化命名空间键（`<packId>:<name>` → `<packId>-<name>`）；本 pack 早前版本物化过的
  role 仅在逐字节相同声明下被升级复用，否则 `PACK_ROLE_CONFLICT`（Decision 8 NO IMPLICIT OVERRIDE）。
- **disable**：不删除任何 durable 事实；live availability 以 status 为唯一来源；被已装 pack 依赖的
  exact 版本拒绝 disable（`PACK_DEPENDENCY_IN_USE`）。
- **re-enable**：完整重验证依赖闭包 + preflight，且不重复物化（contentRefs 保留）。
- **upgrade**：v2 install + v1 disable 同 UoW（先置旧版 disabled 再插新版，保 one-enabled 不变式
  在每次可见提交时一致）；存在依赖 exact 旧版的已装 pack ⇒ `PACK_DEPENDENCY_IN_USE`；重放幂等。
- **事件**：`pack.installed` / `pack.enabled` / `pack.disabled` / `pack.upgraded`，payload 白名单，
  仅 UoW 提交成功后发射。

## Implementation Addendum（T15-04 corrective — PACK_LIVE_CAPABILITY_DISABLE_GAP）

Boss review 指出：`PackInstallation.status` 只是 Pack 自己的可用性来源，不能证明被物化到
Role / WorkflowTemplate 子系统里的实体会尊重该状态。只读 recon 证实两个权威 new-use 入口
均无 Pack 感知：`AuthorizationService.assign(roleId)` 只按 roleId 查角色，
`WorkflowLifecycle.createRun/saveDraftGraph/publish/publishRevision/fork(templateId)` 只按
templateId 查模板——disable 后仍可分配给新成员、仍可新选择/新发布/新起 Run。修正如下：

- **Availability 端口（Core，无新迁移）**：`packages/core/src/ports/pack.ts`
  `PackAvailabilityPolicy.isMaterializedContentAvailable({companyId, contentKind, entityId})`。
  语义为 **derived（不新增任何状态字段/migration）**：`PackContentRef`（provenance）→
  `PackInstallation.status`（availability）。
- **Any-live-owner 语义（公司域）**：无 contentRef 指向该实体 ⇒ 非 Pack 内容，永不拦截；
  至少一个 owning installation 为 `installed` ⇒ live；所有 owning installation 均
  `disabled` ⇒ 不可用于新工作。因此 v1 disabled + v2 installed 且二者共享同一物化 Role 时，
  该 Role 仍可分配（v2 是 live owner）。
- **Role authoritative 入口**：`createAuthorizationService` 接受可选 `packAvailability`；
  `assign` 对新分配 fail closed（`POLICY_DENIED` / `reason=PACK_MATERIALIZED_CONTENT_UNAVAILABLE`，
  不含他公司安装详情）。既有 assignment、role 行、历史事件/grant 记录全部保留可读
  （disable 不删除；`decide`/`effective` 不改语义——历史授权解释不受影响）。
- **Workflow authoritative 入口**：`createWorkflowLifecycle` 接受可选 `packAvailability`；
  仅 **new-use** 入口 guard：`saveDraftGraph` / `publish` / `publishRevision` / `fork` /
  `createRun`。读路径（`readTemplate` / `readSnapshot` / `eventsOf`）永不拦截，既有 Run /
  既有 WorkflowVersion 的历史解析与恢复路径不受影响。
- **不新增状态**：不加 `Role.status`、不加 `WorkflowTemplate.disabledByPack`、不 delete 任何
  PackContentRef / Role / Template / Version；disable 仍只写 `pack.disabled`。
- **Tool 不受影响**：Tool/Validator 是全局 registry 实体，Pack disable 只撤该 Pack 的
  requirement/declaration 的 live 性，不禁用 registry 中的 Tool。
- **生产组合**：`apps/desktop/src/main.ts` 在 quiescent startup 构造**一个** policy 实例
  （pack chain 已注册，两 store 均在），注入 authz 与 lifecycle，随 CoreServices 复用
  ——guard 无法靠绕开 PackService 直接调子系统 API 绕过。
- **边界**：未实现 Run Pack pinning（T15-05 范围；测试断言新建 Run 的
  `RunSnapshot.packVersions` 仍为 `{}`）；未加 IPC/renderer/authority/migration。

## Decision 2：无独立 PackActivation 实体

既有 `PackInstallation.status ∈ {installed, disabled}` 已足够表达 Sprint 15 activation 语义：

```text
installed = enabled / available for new resolution
disabled  = unavailable for new resolution
```

**NO PackActivation entity / NO PackActivation table。**

## Decision 3：Install 语义（PREVALIDATE FIRST, FAIL BEFORE VISIBILITY）

Install 必须依次完成，全部 PASS 后才进入可见 installed 状态：

```text
validate manifest → validate core compatibility → validate dependencies →
validate conflicts → validate privileges → validate declarations → prepare all materialization
```

禁止半安装（Role created / Workflow missing / Installation marked installed）。多 durable 对象的
install 必须经 **既有 UnitOfWork** 保证 SQLite 范围 all-or-nothing visibility。

## Decision 4：Disable 语义与 AC15.3 "No Residue" 澄清

**no residue = no LIVE CAPABILITY RESIDUE**，不是 erase historical audit/provenance。

disable 后必须不存在：新 Pack selection、新 Pack workflow catalog 暴露、新 Pack role/capability
availability、新 Pack materialization use。**允许且必须保留**：历史 Run snapshots、历史
WorkflowVersions、Events、Artifacts、Validations、Tool provenance、审计所需 Pack provenance。
disable 不得 delete/rewrite 任何历史实体。

## Decision 5：Sprint 15 "Unload" = 非破坏性 Disable

roadmap 的 unload/uninstall 在 Sprint 15 framework 语义中实现为 **disable/deactivate live capability**。
禁止 hard delete pack history、GC 物化历史内容、erase provenance。真正 destructive uninstall/GC：
**Deferred，requires future ADR**。

## Decision 6：Re-enable

同一已安装 PackVersion disabled→installed 可重新启用，前提是 manifest 仍有效、依赖仍满足、无冲突
——**不能跳过重新验证**。

## Decision 7：Upgrade（v1→v2）

升级不是修改 v1，而是：**install immutable v2 → validate v2 → v2 active for future resolution →
v1 disabled for future resolution**（v1 remains historically addressable）。禁止 automatic upgrade。

## Decision 8：One-Active-Version 不变量

同一 `companyId + packId` 同时最多 **一个 status=installed 版本**；其他版本必须 disabled
（避免新 Run 选择歧义）。DB unique/index + service enforcement 的组合由 T15-03 落地。

## Decision 9：既有 Run 在升级/停用期间

已存在的 Run：**不切换 Pack 版本、不重解析 active Pack、不因 Pack disabled 而失败**——继续使用
创建时 pinned context（与 ADR-0027 联动；Sprint 14 恢复独立性先例延续）。

## Rejected

- PackActivation 实体/表（两态 status 足够）。
- 自动升级 / 最新版解析（reproducibility 风险）。
- 破坏性卸载/GC（历史可解释性优先；Deferred）。
- 跨 company 全局启用状态（租户渗漏）。

## Consequences

- T15-04 的 PackService 按本 ADR 实现 install/enable/disable/upgrade（fail-closed + UoW 原子）。
- T15-06 的 E2E 必须同时证明 live capability disappearance **与** historical audit retention。
