# CompanyOS 决策系统

> 依据：规划书 §三十（Decision Memory）。
> 目的：让后来的模型不会不停推翻已经验证过的决策。

## Decision Record 结构

每个关键技术或业务决策必须保存以下五项（规划书 §三十 原文要求）：

| 规划书要求 | 字段 | 说明 |
|---|---|---|
| 为什么这样决定 | `rationale` | 目标、约束、当时的证据（可引用 Run / Metrics / Event id） |
| 替代方案是什么 | `alternatives[].option` | 至少一个真实被考虑过的方案，不得留空 |
| 为什么否决 | `alternatives[].rejectedBecause` | 否决理由必须具体到可验证的事实 |
| 哪些地方禁止重新设计 | `frozenAreas[]` | 后续 Agent **不得**再讨论/改动的范围（文件、模块、契约、命名） |
| 什么时候允许重新评估 | `revisitWhen` | 触发条件（例如“某 Stage 失败率 > 20%”“provider 下线”“出现更优方案且有数据”） |

完整字段建议（落地于 Sprint 12，表名 `decisions`，见规划书 §五十六）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✓ | 形如 `dec_<ULID>` |
| `scope` | `company \| industry \| workflow \| task` | ✓ | 决策影响层级 |
| `title` | string | ✓ | 一句话决策 |
| `status` | `proposed \| accepted \| frozen \| superseded \| revisited` | ✓ | 见下一节 |
| `decidedBy` | string | ✓ | 人（老板）或经批准的 Chief |
| `decidedAt` | ISO-8601 | ✓ | 决策时间 |
| `rationale` | string | ✓ | 为什么这样决定 |
| `alternatives` | array | ✓ | 替代方案与否决理由 |
| `consequences` | string[] | – | 已知代价与副作用 |
| `frozenAreas` | string[] | ✓ | 禁止重新设计的范围 |
| `revisitWhen` | string | ✓ | 允许重新评估的条件 |
| `evidenceRefs` | string[] | – | 关联的 Run / Metrics / Artifact / Event id |
| `supersedes` / `supersededBy` | string \| null | – | 取代关系 |

## 决策生命周期

```
proposed ──accept──▶ accepted ──freeze──▶ frozen
    │                    │                  │
    │                    │                  └──revisit(满足 revisitWhen)──▶ revisited ──▶ (新决策)
    │                    └──supersede──────▶ superseded
    └──reject──▶ (关闭，保留记录)
```

- **proposed**：可由 Chief 或任何 Agent 提出，但**不生效**；不得据此改代码或改 SOP。
- **accepted**：经用户（老板）或其授权角色批准，成为当前依据。
- **frozen**：其 `frozenAreas` 被锁定；后续 Agent 若想改动，必须先走 Change Proposal。
- **revisited**：仅在 `revisitWhen` 条件被真实满足时允许发起（必须有证据，不接受“我觉得可以了”）。
- **superseded**：被新决策取代；旧记录**永不删除**，`supersededBy` 指向新记录。

与 Change Proposal 的分工：

| | Decision Record | Change Proposal |
|---|---|---|
| 回答 | 为什么当初这样定 | 现在要怎么改一套已发布的 SOP |
| 对象 | 架构、边界、命名、技术选型、长期规则 | Workflow Template / Version |
| 出口 | `frozenAreas` 锁定、`revisitWhen` 解锁 | `accepted` 后 → `open_revision` → 新版本 |
| 关系 | 决策可以成为提案的依据 | 提案必须引用它要挑战的决策（若有） |

## 禁止反复推翻

规划书 §三十 的核心目的：**后来的模型不会不停推翻已经验证过的决策。** 可执行机制：

1. **冻结区先查**：Agent 在改动任何模块前，必须先查 `frozenAreas` 命中情况；命中即停止实现，
   改为提交 Change Proposal。
2. **Review 必查**：Reviewer（Sprint 20）必须对照 Decision Record 检查本次 Diff 是否触碰冻结区，
   未声明即判定 Review 失败。
3. **提示词注入**：Agent Runtime（Sprint 8）在构造上下文时，必须把当前生效的
   `frozenAreas` 与 `revisitWhen` 一并注入，而不是让模型凭记忆猜。
4. **无证据不得重开**：重新评估必须附证据（Run id / Metrics 快照 / Tool Result），
   否则 Orchestrator 直接拒绝进入 `revisited`。
5. **违反判定**：出现「同一问题被第二次以相反方案实现」且无 `supersedes` 链条时，
   视为决策系统失效——必须补齐 Decision Record，并把该范围标记为 `frozen`。

与其他文档的关系：决策是组织记忆的一部分（`MEMORY_ARCHITECTURE.md`），
其变更通常伴随 SOP 版本演进（`WORKFLOW_VERSIONING.md`），并最终体现在
Workflow Metrics 的对比上（`WORKFLOW_METRICS.md`）。

## 2026-10-12 — Windows primary / Ubuntu independent release gates

- status: ACCEPTED BY BOSS; local implementation pending independent review.
- decidedBy: ChatGPT Boss, Windows First Release Gates & Ubuntu CI Convergence.
- rationale: Windows desktop artifact delivery needs Windows evidence; Ubuntu
  environment compatibility must be reported independently without weakening
  shared correctness, security or required remote checks.
- alternatives: local Ubuntu VM rejected because no authorized execution
  environment exists; deleting or ignoring Ubuntu CI rejected because it would
  conceal failures; equating offline freeze with release rejected because live
  business, Medium-user permissions and installer acceptance remain missing.
- frozenAreas: canonical Runtime, Budget, Cancellation, Artifact/Handoff,
  Guard, real DSH approval, E source and Windows security descriptors.
- revisitWhen: native Ubuntu compatibility evidence or a shared P0/P1 is found;
  remote required-check changes need separate owner/Boss authorization.
- evidenceRefs: `WINDOWS_V1_RELEASE_GATES.md`; local convergence delta review
  package; historical Windows gate remains tied to its original candidate.
