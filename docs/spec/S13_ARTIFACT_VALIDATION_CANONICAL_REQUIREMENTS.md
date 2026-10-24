# Canonical Requirements — Artifact + Validation（Sprint 13A 入库规范化摘要）

> 状态：FROZEN（Proposed）。性质：**repository-native normative summary**——把 Sprint 13 的原始需求
> 从仓库外迁入仓库，使未来 Agent 无需访问外部文件即可理解本 Sprint 的需求边界。
> Source Provenance 见 §7；不复制规划书原文大段内容，只保留规范化摘要。

## 1. Normative Requirements（规划书 §三十一 / §三十二 / §三十六 的规范化摘要）

**Artifact System（原 §三十一）**

- N-AR-1：所有阶段（Stage）都可以产生 Artifact。
- N-AR-2：**Core 只认识 Artifact 抽象**；具体类型属 Industry Pack
  （规划书例：DevCompany = Code Diff / Test Result / Build Result / Commit / Architecture Document；
  ContentCompany = Article / Research Report / Image / Publishing Package——这些是 Pack 层 kind 值示例，
  不是 Core 类型）。
- N-AR-3：Artifact 可追溯、可引用（MVP_SCOPE 概念 #20）。

**Validation System（原 §三十二）**

- N-VA-1：每个 Stage 可以定义 Validator。
- N-VA-2：**Core 负责三件事：运行 Validator → 记录 Result → 决定是否允许下一 Stage**。
  （注：第三件的"决定"在本仓架构中落在 Workflow/Policy 层——Validator 产生证据、transition 由
  L1 既有转移执行；此裁定见 `../sprint13/S13_WORKFLOW_INTEGRATION.md`。）
- N-VA-3：Validator 运行并记录结果，作为质量门（MVP_SCOPE 概念 #21）。
- N-VA-4：验证失败阻断流转，事实来自真实结果而非 Agent 自述（T13.1 AC / 规划书 §二原则 7）。

**Risk System（原 §三十六，T13.7 对齐）**

- N-RK-1：四级：LOW 自动 / MEDIUM 自动+强制 Review / HIGH 执行前审批 / CRITICAL 强制明确确认。
- N-RK-2：语义与 Tool Registry 既有 `RISK_POLICY`（Sprint 9）一致——**复用，不重造**。

## 2. Concept Definitions（本仓冻结语义）

```text
Artifact      = 运行产生的不可变 durable 产物/证据（metadata 行 + CAS 内容）
Validation    = Validator 执行结果的可寻址 durable 证据记录
Validator     = 确定性证据生产者（不是流程决策者）
Quality Gate  = blocking Validation 全部 pass（无 blocking 不算通过）
Provenance    = 产出来源（Workflow Run + taskId + producedBy）
targetRef     = 被验证 Artifact 的身份（artifact:art_<ulid>，ADR-0017）——与 evidence 严格分离
evidenceRefs  = 支持 Validation 结论的证据引用（非 target）
CAS           = 内容寻址存储（sha256 → 不可变 bytes）
```

## 3. Existing Sprint 1 Frozen Contract（实现起点）

- `Artifact`：`artifactId/runId(必填)/taskId(可空)/kind/contentRef/contentHash/sizeBytes/producedBy/createdAt`；
  不可变；Core 不解引用 contentRef（`packages/core/src/domain/artifact.ts`）。
- `Validation`：`pass/fail/error/skipped` 闭集、证据门（pass 需 exitCode 0 或 ≥1 evidenceRef）、
  blocking 质量门、`artifact:<id>`/`command:<name>` 可寻址证据（`packages/core/src/domain/validation.ts`）。

## 4. Sprint 13 Required Realization（冻结结论索引）

| 需求 | 冻结位置 |
|---|---|
| Artifact 身份/不可变/存储/持久化/CAS/崩溃模型 | `../sprint13/S13_ARTIFACT_CONTRACT.md` |
| Validator 边界/状态语义/幂等/持久化/SoT | `../sprint13/S13_VALIDATION_CONTRACT.md` |
| Workflow 集成/evidence guard/兼容性矩阵/Memory 边界 | `../sprint13/S13_WORKFLOW_INTEGRATION.md` |
| 测试矩阵 | `../sprint13/S13_TEST_STRATEGY.md` |
| 风险分级与排除范围 | `../sprint13/S13_RISK_REGISTER.md` |
| 架构决策 | `../adr/0015-artifact-and-validation-system.md` · `../adr/0016-validation-framework.md` |

## 4b. Provenance Realization（Task-13-08）

- Memory `ARTIFACT` source → verifier confirms durable Artifact identity
  (`artifact:art_<id>`)；`VALIDATION` source → verifier confirms durable Validation
  identity (`val_<id>`). Identity only — no content copy, no gate re-evaluation,
  no lifecycle ownership transfer. Stores not wired ⇒ fail closed.

## 5. Explicit Constraints（硬约束）

词汇法（Core 无行业名词）· Core 零运行时依赖/零 fs/SQLite/Electron 感知 · 既有 11 迁移链 checksum
不动（新链 #12 `artifact`）· Sprint 0–12 全部冻结面不得重开（Router/Handoff/Memory 主体/状态分层）·
测试数量只增不减 · additive integration。

## 6. Out Of Scope

见 `../sprint13/S13_RISK_REGISTER.md` §3（18 项明文排除 + 无 aggressive GC）。

## 7. Source Provenance

| 内容 | 来源 |
|---|---|
| N-AR-1/2、N-VA-1/2、N-RK-1 | 外部规划书 `最终1.1.txt` §三十一（:1304）/ §三十二（:1336）/ §三十六（:1455）——**仓库外文件，本文件入库后为规范化摘要载体** |
| N-AR-3 / N-VA-3 | `docs/MVP_SCOPE.md` 概念 #20/#21 |
| N-VA-2 第三件的架构裁定 | 本仓 ADR-0016（Workflow/Policy 层控制 transition） |
| Sprint 1 契约 | 仓库内 `packages/core/src`（代码即真相） |

> 本摘要由 Zcode 于 Sprint 13A（2026-09-18）从上述来源整理。**Boss 裁定（2026-09-18，OQ-1 CLOSED）：
> 外部规划书 `最终1.1.txt` 不整体入库**——本文件为**永久 repository-native normative summary**
> （保留 source provenance / 规范要求 / 与 Sprint 1 契约的关系，不复制大段原文）；
> 未来 Agent 以本文件 + sprint13/ 契约文档为需求真相，不依赖桌面外部文件。
