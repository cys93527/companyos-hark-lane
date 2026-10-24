# ADR-0026：Pack Dependencies and Conflict Resolution（Sprint 15 — Task-15-01 Architecture Decision）

> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：`TASK-15-01 APPROVED` 指令全文）**。
> 配套：ADR-0024（域模型）· ADR-0013（Tool Registry 门禁）· ADR-0016/0020（validator/evidence）·
> `docs/sprint15/S15_PACK_CONTRACT.md`。

## Context

Recon 证实 dependsOn 已在 core manifest 声明（`readonly string[]`，无版本表达、无 resolver），capability
面已有 `capabilityOwner/missingCapabilities`（Company 域）。本 ADR 冻结依赖类别、解析与冲突规则。

## Decision 1：依赖类别——仅 REQUIRED

Sprint 15 只支持 **REQUIRED dependencies**。不引入 optional / recommended / peer / soft dependencies
（后续需要时单独扩展）。

## Decision 2：Pack→Pack 依赖

- 必须显式声明；**no automatic install**；依赖缺失 ⇒ install/enable **fails closed**。
- **精确版本依赖**：依赖必须表达 exact Pack version（或 manifest 契约可表达的等价精确约束）。
  **禁止 semver-range solver**（`^1.2` / `>=1` / `latest` / compatible-newest 均不允许）。
  现有 `dependsOn: string[]` 结构无法表达 exact version ⇒ **T15-02 必须正规化 dependency contract**
  （如 `<packId>@<exactVersion>` 或对象形式——语法由 T15-02 定，语义在本 ADR 冻结）。
- Install/enable 时必须验证 **full transitive required dependency closure**（禁止只验第一层）。
- **Dependency cycles（A→B→A）必须 reject**，不得循环解析。

## Decision 3：Capability 依赖与 Pack 依赖分离

Capability requirement（capability ids / tool requirements / validator requirements / model capabilities）
与 Pack dependency 是**两个不同字段/概念**，不得混一。可依赖既有 capability 解析面
（`<packId>:<name>` 命名空间 capability id + capabilityOwner/missingCapabilities）。

## Decision 4：Provider 依赖——Vendor 中立

Pack **不得** require OpenAI / Anthropic / DeepSeek / 任何 specific provider vendor。只能 require
**logical model capability**，由既有 provider/model binding（logical slot + capability）解析——Pack
vendor lock-in 被结构性排除。Pack 不注册 Provider 凭据；secret/credential 管理保持原系统。

## Decision 5：Tool 声明 = 需求，不是实现

Pack Tools 是 **REQUIREMENTS, NOT EXECUTABLE TOOL IMPLEMENTATIONS**：可声明 required toolId /
required capability；**不得** ship adapter implementation、replace ToolRegistry、bypass authorization /
approval / idempotency。Pack Loader 对 Tool requirement 只做**存在性验证**——缺失 ⇒ pack unavailable /
install fails（install 不安装 adapter、不下载 Tool、不注册任意可执行实现）。

## Decision 6：Validator 声明 → pinned WorkflowVersion

Validator 继续 = Tool Registry capability（`validation:validator`，ADR-0016）。Pack 声明 validator
requirement，最终进入**物化后的 WorkflowVersion `stage.config.validatorIds`**（seed → draft → publish
路径）。运行时 EvidenceGuard（ADR-0020）继续只读 **run-pinned WorkflowVersion**，绝不查 active Pack
latest——Pack latest 永远改不了已发布版本的 gate。

## Decision 7：Role 声明与权限边界

Pack 可声明 Role archetype / role definition data，但其引用的每个 **authority name 必须 ∈ 既有闭集
AUTHORITIES**（`isAuthority` fail-closed + `validateRoleAuthorities` 复用）。Pack 不得：创造新 authority
词汇、自动给用户分配角色、自动授予 owner、修改 bootstrap owner。**安装 Pack 本身 MUST NOT 给任何
用户分配角色**——Role assignment 继续走既有 authorization 流程。

## Decision 8：冲突策略——NO IMPLICIT OVERRIDE

两个 Pack 尝试 materialize 相同 logical key 且不允许共存 ⇒ **CONFLICT**（fail closed）。禁止
last-writer-wins。

## Decision 9：命名空间

Pack-owned logical names 使用 **pack-qualified namespace `<packId>:<name>`**（既有 capability 先例）。
注意：这是 **logical key / namespace**，不替换现有 branded database IDs——**不发明新 ULID 格式**。

## Decision 10：无继承/无覆盖

**NO Pack inheritance / NO extends / NO override chain**（Pack A extends B、A overrides B.workflow 均禁）。
组合只通过 **required dependency**，不通过继承。

## Implementation Addendum（T15-04 — 依赖解析与冲突检测）

- **availability = installed status**：依赖必须在目标公司处于 installed；disabled 安装不暴露任何能力，
  不可作为依赖（`PACK_DEPENDENCY_MISSING`）。重新 enable 后恢复可解析。
- **环检测先于 availability**：循环图无论安装状态如何都是畸形图；候选（含自身自依赖，已在 canonical
  manifest 阶段先行拒绝）纳入遍历图；仅在 stores 层才能构造的 durable 环 ⇒ `PACK_DEPENDENCY_CYCLE`。
- **码表**：`PACK_DEPENDENCY_MISSING`（未装/disabled）/ `PACK_DEPENDENCY_UNKNOWN`（已装但 canonical
  行不可读，durable 不一致）/ `PACK_DEPENDENCY_CYCLE` / `PACK_DEPENDENCY_SELF` / `PACK_DEPENDENCY_IN_USE`
  （disable 与 upgrade-away 守卫，防止 stranded 依赖）。
- **无 auto-install、无 range 解析**：版本不匹配即 fail closed（`PACK_DEPENDENCY_MISSING`），闭包含候选。
- **conflict 面**：role key 冲突（含本 pack 旧版逐字节不同声明）⇒ `PACK_ROLE_CONFLICT`；同 tuple 异
  manifest ⇒ `PACK_VERSION_CONFLICT`；均零写入、无 last-writer-wins。

## Rejected

- semver-range solver / optional 依赖（复杂度与可复现性风险，未获授权）。
- 自动安装依赖包（隐式副作用）。
- last-writer-wins 冲突（静默覆盖）。
- 继承/覆盖链（破坏可复现性）。
- Vendor-specific provider requirement（lock-in）。

## Consequences

- T15-02：dependency contract 正规化（exact version）+ 九类声明中的 requirement 语义建模。
- T15-04：closure/cycle/conflict 检测实现；T15-06：对应负向 E2E（缺失/环/冲突/闭包）。
