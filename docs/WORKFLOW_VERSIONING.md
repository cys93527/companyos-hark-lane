# Workflow 版本系统

> 依据：规划书 §六（三大核心形态）、§七（其他状态）、§九（版本系统）、§十（Template 不允许直接修改）、
> §十一（Run Snapshot）、§五（Workflow Lifecycle）。
> 代码事实来源：`packages/core/src/lifecycle/version.ts`、`template.ts`、`machine.ts`、`snapshot.ts`。
> **文档与代码不一致时以代码为准；改代码必须同步改本文档。**

## 版本语义

所有正式 SOP 必须版本化（规划书 §九）。示例（原文）：

| 版本 | 流程 |
|---|---|
| `ContentArticleWorkflow v1.0` | 选题 → 写作 → 审核 → 发布 |
| `ContentArticleWorkflow v1.1` | 选题 → 调研 → 写作 → 审核 → 发布 |
| `ContentArticleWorkflow v2.0` | 选题 → 调研 → 写作 → Fact Check → Image → 审核 → 发布 |

规则：

- 首个发布版本固定为 `1.0.0`（`INITIAL_SEMVER`）。
- 修订产生 **新版本**，不修改旧版本：`1.2.0` → 打开草稿 `1.3.0-draft` → 发布为 `1.3.0`。
- 版本号只前进（`bumpMinor` / `bumpPatch`）；`releaseSemver('1.3.0-draft') === '1.3.0'`。
- 一个 `WorkflowVersion` 一旦创建即为不可变（`immutable: true`），并且**内容寻址**。
- 运行中的 Run 固定引用某个版本；Template 升级不影响它（规划书 §六 3. RUNNING）；见 `Run Snapshot`。

三大形态与其它状态（规划书 §六 / §七）：

| 形态 / 状态 | 含义 |
|---|---|
| **DRAFT / 设计态** | 第一次遇到新业务类型时由 Chief 创建；可定义 Stage、Role、Task Type、Tool/Capability Requirement、Validator、Risk Rule、Approval Rule、Transition、Retry、Branch、Loop、Artifact Requirement、完成条件。此时还不是公司正式 SOP。 |
| **PUBLISHED / 模板态** | Draft 完成 Review 与验证后发布为 Workflow Template（如 `DevFeatureWorkflow v1.0`）。属于正式 SOP，**不能直接覆盖修改**。 |
| **RUNNING / 执行态** | 有实际业务任务时，从 Published Template 创建 Workflow Run，并获得一份 Template Snapshot；此后使用固定版本执行。 |
| **DEPRECATED** | 旧版本停止用于创建新 Run，但历史数据保留、正在运行的任务继续执行。 |
| **ARCHIVED** | 彻底归档，仅供查看、审计与历史分析（终态，只读）。 |
| **FORKED** | 从现有成熟 Workflow 创建新变种，例如 `ContentArticleWorkflow v2` Fork 成 `XiaohongshuArticleWorkflow Draft`。 |

## contentHash

`contentHash` 是版本的**内容指纹**，使历史运行可精确复现与校验（实现见 `packages/core/src/lifecycle/version.ts`）：

- 计算对象：规范序列化后的 `{ templateId, semver, graph }`；
- 规范序列化 `canonicalJson`：对象键递归字典序、去掉 `undefined`、保留 `null`、无空白、数组保持顺序；
- 摘要算法：`sha256`，输出 64 位小写十六进制；
- `recomputeContentHash(version)` 可重算；`isVersionIntact(version)` 判断是否被篡改。

由此得到两条硬性结论：

1. **同一内容 + 同一 semver ⇒ 同一 contentHash**（与创建时间、创建者无关）；
2. **任何图结构改动都会改变 contentHash**，因此“偷偷改已发布版本”必然被检测出来。

`RunSnapshot` 保存并校验该哈希（见下），`MigrationChecksumError` 同理保护 SQL 迁移文件。

## Fork

- `fork` 只允许从 `published` 或 `deprecated` 触发（`machine.ts` 的 `TRANSITIONS`），且必须存在源版本。
- Fork 的结果是一个**新的 Template**，处于 `draft`，并记录血缘 `forkedFrom { templateId, versionId, semver, forkedAt, forkedBy }`。
- **源 Template 不被修改**（只有审计事件产生）：`forkTemplate` 的测试断言了源对象在 Fork 前后 JSON 完全一致。
- `global` 锁会阻止 Fork；`run` 锁不会（见 Template Lock 语义）。

典型用法（规划书 §七）：某行业内容流程 `ContentArticleWorkflow v2` Fork 成
`XiaohongshuArticleWorkflow Draft`，随后独立演进、独立发布、独立积累绩效数据。

## Deprecate 与 Archive

- `deprecate`：`published → deprecated`。要求提供**非空原因**；拒绝新 Run；若存在未发布的草稿版本，
  会被丢弃（`draftVersionId` 置空，并在事件 `workflow.template.deprecated` 的
  `discardedDraftVersionId` 中留痕）。**已签发的 Run 快照继续按原版本执行。**
- `archive`：`deprecated → archived`，是**吸收态**：没有任何出边，永久只读，仅供审计与历史分析。
- 二者都保留全部历史版本内容与哈希，因此任何时候都能回答「当时的 SOP 到底是什么样」。

## Run Snapshot

每次创建 Run 时保存 Template Snapshot（规划书 §十一），至少包含：

| 快照字段 | 对应 Core 实现（`RunSnapshot`） |
|---|---|
| Template ID | `templateId` |
| Template Version | `workflowVersionId` |
| Stage Definitions | 图节点中的 stage（由 Pack 定义语义，Core 只保存图） |
| Role Definitions | 角色绑定（Pack 定义，随版本内容进入 `contentHash`） |
| Validators | 版本内容的一部分（同上） |
| Risk Rules | 版本内容的一部分（同上） |
| Tool Bindings | 版本内容的一部分（同上） |
| Capability Requirements | 版本内容的一部分（同上） |
| Prompt Version | `promptVersion`（当前实现位于 pack 版本与 prompt 版本绑定） |
| 行业 Pack 版本 | `packVersions`（packId → 精确版本） |
| 模型绑定 | `modelBindings`（Sprint 7 起由 Router 填充） |
| 记忆视图 | `memoryViewRef`（冻结的记忆视图句柄） |
| 锁引用 | `templateLockId`（必须指向该版本上的**活跃**锁） |

不变量（已在测试中验证）：

1. 只有**不可变版本**才能被快照固定；草稿版本被拒绝；
2. 必须固定一个**活跃的** Template Lock，且该锁的 `versionId` 必须等于被固定的版本；
3. `snapshotHashOf` 只覆盖被固定的字段（组织、模板、版本、锁、pack 版本、模型绑定、记忆视图），
   不含 id 与时间戳；`verifyRunSnapshot` 校验它，任何篡改都报 `SNAPSHOT_MISMATCH`；
4. 因此「未来即使 Template 已经升级，也可以准确复现当时为什么这样执行」。

## Template Lock 与 Change Proposal（与版本系统的接口）

- **Template Lock**：`scope = run | global`。`run` 锁阻止结构性变更（`publish_revision`），
  `global` 锁额外阻止 `fork`。锁是独立聚合，**不改变 Template 状态**。
- **Change Proposal**：修改已发布版本的**唯一合法入口**。流程（规划书 §十）：
  `发现流程问题 → Chief 提交 Change Proposal → Fork 当前 Template → 创建新 Draft → 修改 → 测试 → Review → Publish 新版本`。
  只有 `accepted` 的提案（且其 `baseVersionId` 等于当前版本、当前无草稿）才能 `open_revision`。
- 结论：**v1.0 不能直接变成另一个内容不同的 v1.0；必须产生 v1.1 或 v2.0。**
