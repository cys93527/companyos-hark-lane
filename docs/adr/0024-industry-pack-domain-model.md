# ADR-0024：Industry Pack Domain Model（Sprint 15 — Task-15-01 Architecture Decision）

> **Status: Accepted（2026-09-26，Boss Architecture Decision——acceptance authority：`TASK-15-01 APPROVED` 指令全文）**。
> 配套：ADR-0002（Core 边界）· ADR-0006（WorkflowVersion 不可变）· ADR-0025/0026/0027 ·
> `docs/sprint15/S15_PACK_CONTRACT.md`（运行时契约全文）。

## Context

Sprint 15 目标（roadmap 冻结）：让行业能力以 Pack 方式扩展，Core 保持行业无关（AC15.1 九类声明 /
AC15.2 Core 无行业词 / AC15.3 卸载无残迹 + 版本固定进 Run Snapshot）。Planning recon 证实 Core 已有
**休眠脚手架**：`packages/contracts` zod manifest（5 provides 类）、`packages/core/src/registry/pack-manifest.ts`
语义模型、`packages/core/src/domain/pack.ts` PackInstallation、Company.packInstallationIds 面、
`RunSnapshot.packVersions`（durable），以及 CORE_BOUNDARIES §4 设计表——**三套 manifest 语义并行**，
且九类中 Prompts/Risk Rules/Capability Rules/Templates 无模型。本 ADR 收敛为一。

## Decision 1：Industry Pack 定义

**Industry Pack = immutable versioned declarative configuration bundle（不可变、可版本化的声明式配置束）。**

- **Pack is: DATA / CONFIG ONLY。** Pack 永远不得携带：JavaScript/TypeScript 可执行模块、Python、
  shell、native executable、eval code、dynamic import target、MCP server implementation、任意 callback。
- **Pack is NOT：plugin / code module / runtime execution object / dynamic extension。**
- Sprint 15 Pack Loader：**validates data + resolves declarations + never executes Pack-supplied code**。
  任何未来 executable Pack 必须独立 ADR / security model（本 ADR 不授权）。
- 无 filesystem payload：install 不复制可执行文件、不解包二进制、不建立文件系统运行时——因此
  不引入 SQLite+filesystem 双写事务（与 ADR-0015 CAS 场景不同）。

## Decision 2：九类 Canonical 声明（不加不减）

```text
1. Roles            2. Workflow Templates   3. Prompts          4. Tools
5. Validators       6. Artifacts            7. Risk Rules       8. Capability Rules
9. Templates（Generic，≠ Workflow Templates，≠ Prompts）
```

- **Workflow Templates 与 Templates（Generic）是两个独立类别**，T15-02 必须分别建模；若规划书对
  Generic Templates 字段语义不足，T15-02 返回 `PACK_GENERIC_TEMPLATE_SCHEMA_GAP`，不得猜。
- **Agent 不是 Pack 内容**（九类中无 Agent Definition）：AgentExecution=运行时实例；Sprint 15 不引入
  AgentDefinition 模型；Pack 的人员/执行角色表达经 Role declarations + Workflow configuration 完成。
- 各类边界：Prompts=声明式数据（不引入新 runtime prompt engine，Sprint 8 prompt-assembly 不变）；
  Risk Rules=声明式 policy 数据（不绕过 RiskLevel/Tool risk policy/authorization/approval）；
  Capability Rules=required/exposed capability 关系数据（不得授予权限或创建可执行 capability）；
  Artifacts=artifact kind 词汇/期望声明（不创建 Artifact 子类或可变 schema——ADR-0015 权威）。

## Decision 3：单一 Canonical Manifest 语义权威

**`packages/core` 的 PackManifest 语义模型 = semantic authority。**

```text
packages/core        = semantic authority（语义权威）
packages/contracts   = transport / validation projection（zod 传输投影）
CORE_BOUNDARIES §4   = documentation of the same contract（同一契约的文档）
```

三处不得存在独立业务语义；T15-02 必须保证 Core 语义 manifest ↔ Contracts transport schema **一一对应**
（Core accepts A ⇒ Contracts 不得静默丢 A；Contracts permits B ⇒ Core 必须有 B 的语义），并以
conformance tests 锁定。

### 字段收敛表（canonical 命名，禁止永久双命名）

| 概念 | Canonical | Legacy alias（T15-02 收敛处理） |
|---|---|---|
| Manifest 自身 schema 版本 | `manifestVersion` | contracts `schemaVersion` |
| Pack 身份 | `packId` | contracts `id` |
| 发布版本 | `packVersion` | contracts `version`；CORE_BOUNDARIES `packVersion` 一致 |
| Core API 兼容 | `coreApi`（S15 为精确版本串；range 语义 Deferred——无 semver solver） | core `apiVersion`；contracts `coreApi`；CORE_BOUNDARIES `coreApiRange` |
| 展示名 | `name` | `displayName` 不另立（presentation 用 name） |
| 能力声明 | `capabilities: PackCapability[]`（core registry 模型为基） | CORE_BOUNDARIES `CapabilityDescriptor[]` 同义 |
| Pack 依赖 | `dependsOn`（T15-02 正规化为 exact-version 表达，见 ADR-0026） | — |
| 九类内容 | 九类 canonical declarations（T15-02 建模） | contracts `provides.*` 五键映射入九类 |

## Clarification（TASK-15-02 implementation ruling — Generic Templates 最小契约）

The ninth category (Generic Templates) was NAMED by repository sources (roadmap
AC15.1, V1_1_RECONCILIATION) but its FIELD SCHEMA was defined nowhere in the
repository — the original planning document is not present in the repo. TASK-15-02
reported `PACK_GENERIC_TEMPLATE_SCHEMA_GAP` and stopped; the Boss ruled
（OPTION 2 — freeze the minimal schema; schema source: **TASK-15-02 architecture
ruling**, NOT the planning document）:

```ts
GenericTemplateDeclaration { key: PackQualifiedKey; kind: string; content: JsonValue }
```

- `kind` — an opaque non-empty type token; Core never interprets or switches on it
  (NOT authority / capability / executable handler / module name).
- `content` — JSON-safe inert data only (functions/undefined/bigint/symbols/class
  instances/Dates/Buffers/non-finite numbers rejected at validation); string content
  that *looks like* code is still inert data — Sprint 15 has no generic template
  runtime (no renderTemplate/execute/service in T15-02）。
- V1 is minimal (`key/kind/content` only): no metadata/description/tags/schema/
  variables/renderer fields; future extensions are separate contracts.
- Categories stay separate: workflow-graph content belongs to
  `declarations.workflowTemplates` (lifecycle/versioning path), prompt-shaped
  content to `declarations.prompts` — generic templates are not a substitute。

Fingerprint participation (§18-20 of the ruling): object keys are recursively
sorted (equivalent key order → SAME fingerprint); ARRAY order is preserved
(array order is template-data semantics → DIFFERENT fingerprint)。

## Decision 4：PackVersion vs PackInstallation（两概念，不得合一）

- **PackVersion / Pack Manifest**：immutable；全局身份 `(packId, packVersion)`；代表版本化声明内容。
- **PackInstallation**：company-scoped；mutable lifecycle binding；代表某 Company 是否启用某 PackVersion。
- **版本身份完整性**：同一 `(packId, packVersion)` 若 canonical manifest 内容不同 → **CONFLICT**，
  不得 silently replace。实现形式为 canonical manifest fingerprint/hash（T15-02/T15-03 落地）。

## Decision 5：信任模型与导入

- **manifest input is untrusted data at validation boundary**——即使来源是 first-party/本地注册/测试
  fixture，也必须完整 schema/domain validation（既有 `installPack` "Untrusted input — validated" 先例）。
- Sprint 15 **不实现**：signature verification、marketplace trust、remote download trust、第三方
  executable sandbox（全部 Deferred）。**Import/Marketplace OUT OF SCOPE**：禁止 install from URL、
  zip import、marketplace、remote catalog、plugin store、signature infrastructure。

## Decision 6：Legacy 兼容（Additive）

**Pack is ADDITIVE**：现有 WorkflowTemplate 与 `packVersions={}` 的 Run 继续是一等公民。禁止把存量
工作流迁入默认 Pack、禁止要求每个 Run 有 Pack、禁止创建隐藏默认 Pack。

## Rejected

- Plugin/可执行 Pack（无授权、无动态加载先例、安全面不可控）。
- Agent 定义作为第十类（roadmap 九类冻结）。
- 三套 manifest 并行演化（漂移根源）。
- Pack 强制容器化存量工作流（重大迁移，无授权）。

## Consequences

- Core 保持行业盲（`INDUSTRY_OWNED_NOUNS` + check-boundaries 继续强制；Core 只认识 Pack/九类声明的
  行业无关语义）。
- Sprint 15 无真实行业 Pack：DevCompany=Sprint 16；测试只用 industry-neutral fixture（如
  `pack.fixture` 命名，遵守真实 schema）。
- T15-02 交付：canonical manifest（九类齐）+ 校验/normalization + PackVersion/PackContentRef 域契约
  + `pack.manage` 入 AUTHORITIES 目录（本 ADR 仅冻结语义，代码改动属 T15-02）。


## Corrective（TASK-15-02 fingerprint 格式统一）

`PackVersion.manifestFingerprint` 的规范表示为 **qualified SHA-256 ref**：
`sha256:<64 lowercase hex>`（algorithm-qualified digest，非裸 hex）——沿用仓库既有的
qualified SHA-256 标识惯例（`kernel/hash.ts`: `sha256Ref/isSha256Ref/parseSha256Ref`，
构建于既有 `sha256Hex`，无第二套实现）。canonicalization 语义不变（对象键递归排序、
数组保序、dependencies/capabilities 按键排序、legacy alias 归一化）；T15 尚未持久化，
故为一次性修正窗口——**NO legacy bare-hash compatibility shim**。