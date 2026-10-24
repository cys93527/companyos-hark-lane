# Sprint 13 Closeout — Artifact + Validation（T01–T12）

> 状态：**CLOSED**（本文为 Sprint 13 最终收口记录；独立评审 = Boss 逐 Task review，最终以
> `TASK-13-12 APPROVED` + Final Review 为准）。真实 commit hash 见本文与 `PROJECT_HANDOFF.md`。

## 1. Mission（任务使命）

按 Sprint 13A 冻结契约（`S13_ARTIFACT_CONTRACT.md` · `S13_VALIDATION_CONTRACT.md` ·
`S13_WORKFLOW_INTEGRATION.md` · ADR-0015/0016）把规划书 §三十一（Artifact）、§三十二（Validator/Validation）、
§三十六（Risk 复用）落成**真实实现**：durable Artifact（不可变、CAS 支撑）、durable Validation（targetRef 绑定、
证据化）、evidence-backed `VALIDATION.PASS` 质量门、四大引用写入面的 durable 引用校验、
startup CAS reconciliation，以及 production composition 接线。**零 Sprint 0–12 冻结面破坏**。

## 2. Delivered Capabilities（交付能力清单 → IMPLEMENTED / TESTED / DOCUMENTED）

| # | Capability | 实现 | 测试证据 | 文档 |
|---|---|---|---|---|
| 1 | Artifact domain/contracts | `packages/core/src/domain/{artifact,validation,event}.ts`、`ports/artifact*.ts` | sprint13 artifact-service 套件、ports-frozen | ADR-0015 |
| 2 | Artifact persistence（第 12 链 `artifact`：0001+0002） | `sqlite-artifact-store.ts`（listAll 仅启动对账） | `tests/sprint13/artifact-validation-stores.test.ts` | ADR-0015、PERSISTENCE |
| 3 | Validation persistence + targetRef（ADR-0017） | `sqlite-validation-store.ts`、migrations 0002 | 同上 + validation-service 套件 | ADR-0017 |
| 4 | filesystem CAS（hard-link no-clobber、reparse 拒绝、fsync 门） | `persistence/src/content/cas-store.ts` | `tests/sprint13/cas-*`（含 symlink/junction 注入） | ADR-0015 |
| 5 | ArtifactService（三级幂等、authorize 全路径、单 UoW） | `engine/src/artifact/artifact-service.ts` | artifact-service 20 用例 | ADR-0015 D15 |
| 6 | ValidatorResolver（Sprint 9 Registry 复用，capability 门） | `engine/src/validation/validator-resolver.ts` | validator-resolver 9 用例 | ADR-0016 |
| 7 | ValidationService（one command→one target→N validators、replay） | `engine/src/validation/validation-service.ts` | validation-service 33+ 用例 | ADR-0016/0018/0019 |
| 8 | durable Tool replay output（tools/0004） | `tools/registry.ts` snapshot/replay | `tests/sprint13/tool-replay-output.test.ts` | ADR-0018 |
| 9 | Tool version provenance（tools/0005，legacy null 不回填） | 同上 | validation-service §23/legacy 套件 | ADR-0019 |
| 10 | legacy approval fail-closed（WAITING null 版本不可执行） | `tools/registry.ts` approve 门 | validation-service legacy approval 套件 | ADR-0019 |
| 11 | Evidence-backed VALIDATION.PASS（ADR-0020） | `engine/src/validation/evidence-guard.ts` + `engine.ts` validationGate | evidence-guard 30+ 用例（§38 十二项锁定） | ADR-0020 |
| 12 | Memory ARTIFACT/VALIDATION provenance（identity-only） | `engine/src/memory/artifact-validation-provenance.ts` | memory-provenance 19 用例 | MEMORY_ARCHITECTURE |
| 13 | Durable reference resolver（resolve-all-before-write） | `engine/src/validation/durable-references.ts` | durable-references + write-path-integration | ADR-0015 D4 |
| 14 | Agent/Tool/Handoff/Decision 写入面强制 | 四服务 `durableReferenceResolver` seam（main.ts 注入） | `tests/sprint13/write-path-integration.test.ts` | 同上 |
| 15 | CAS startup diagnostics + reconciliation（detect/report only） | `persistence/src/content/cas-diagnostics.ts` + `engine/src/validation/cas-reconciler.ts` | cas-reconciler 套件（orphan/staging/fatal/symlink） | ADR-0015 D11（PATH 2 裁定） |
| 16 | Production composition + startup ordering（fatal fail-closed） | `apps/desktop/src/artifact-stack.ts` + `main.ts` | `tests/sprint13/composition-wiring.test.ts` 18 用例 | 本文 §4/§5 |
| 17 | Real authorization（Role→Authority，无 allow-all） | AUTHORITIES +4；服务层 authorize 门 | composition-wiring + sprint6 套件 | `S13_VALIDATION_CONTRACT.md` §12 |
| 18 | IPC boundary closed（Sprint 13 服务 = main-process 内部能力） | workflows.ts 零 Sprint 13 op（corrective 57eaabe） | composition-wiring boundary lock 2+3 用例 | 本文 §6 |

## 3. Architecture Decisions（Accepted，零改动封存）

ADR-0015（Artifact Model）· ADR-0016（Validation Framework）· ADR-0017（Target Binding）·
ADR-0018（Durable Replay Output）· ADR-0019（Version Provenance）· ADR-0020（Gate Evidence Selection）——
六份均 **Accepted**，实现与其一致；`S13_VALIDATION_CONTRACT.md` §12 的实现状态注记已在 read-authority
reconciliation（commit `0d79b54`）中纠正（词汇表冻结不变）。

## 4. Security Invariants（收口时点全部成立）

- caller（含 renderer）不可选 identity/hash/CAS 路径/provenance；`contentRef=sha256:<64hex>` 严格。
- CAS-first → SQLite-second 写序；no-clobber hard-link publish；metadata→CAS missing = FATAL。
- Reconciliation **detect/report only**：无 delete/unlink/remove/gc/repair API（端口层即无此能力）。
- `VALIDATION.PASS` verdict 字段结构性不可读；evidence 必须来自 durable latest batch（ADR-0020）。
- `blocking` 恒来自 trusted command plan / Stage snapshot，**caller 永不可决定**（T11 IPC corrective 裁定）。
- 授权覆盖所有路径（含 replay）；未知 authority → INVALID_ARGUMENT fail closed；
  `artifact.read`/`validation.read` 为 catalog reservation，**无 reachable 执行点**（≠ exposed capability）。
- 日志仅 summary/count（CAS 对象清单、内容字节、secrets 永不入日志/事件/ledger）。

## 5. Composition & Startup Ordering（冻结）

`userData/artifacts`（稳定 CAS 根）→ quiescent reconcile（fatal → 关库 + fail startup closed）→
composeSprint13Application（ArtifactService/ValidatorResolver/ValidationService/run-pinned EvidenceGuard/
DurableReferenceResolver/引擎 validationGate 必接，单 DB/单 UoW/单 EventStore/单 Ledger）→
之后才暴露 window/IPC。Sprint 13 服务无任何 renderer IPC operation。

## 6. Migration Summary

`artifact` 链：`0001_artifact_validation.sql`（两表 + permanent creation identity 列对 + partial unique）
→ `0002_validation_target_ref.sql`（nullable target_ref + 索引）。`tools` 链追加
`0004_invocation_replay_output.sql`、`0005_invocation_version_provenance.sql`（均 additive nullable）。
空库 12 链一次通过（T12 §20 证据：artifact 0001+0002、tools 0001–0005、组合成功）；
legacy 兼容语义（targetRef=null / toolVersion=null / replay snapshot=null）由既有套件锁定。

## 7. Test Evidence（收口时点）

- `pnpm check`：5× PASS（lint / typecheck / boundaries / test / build）。
- vitest：**112 test files / 1224 test cases，全绿**（较 T11 基线 111/1206 只增不减）。
- `pnpm test:scripts`：23/23。`git diff --check`：clean。
- Sprint 13 全部 touched 文件 UTF-8 有效、0 U+FFFD。
- Fresh-DB 迁移：空库 12 链 + 全部期望表/列/索引 + composition 成功（T12 验证记录）。

## 8. Known Limitations（诚实记录 — 有意范围/延后能力，非缺陷）

1. Memory provenance verifier **无 run-scope 锚**（verify() 契约仅 sourceType/sourceRefs/companyId；
   Artifact/Validation 无 companyId）——记录于 `MEMORY_ARCHITECTURE.md`，future consideration。
2. `artifact.read` / `validation.read`：authority catalog **reserved vocabulary**，当前无执行点
   （执行点属 future contract；禁止以 renderer IPC 重新引入）。
3. CAS orphan/staging 清理**有意延后**（ADR-0015 detect/report only，PATH 2 裁定）。
4. Artifact 无 delete/version/GC（Option A 不可变，架构性排除）。
5. Sprint 13 服务无 renderer IPC 暴露（IPC boundary corrective；wire ≠ expose）。
6. WorkflowEngine 于组合中以 Sprint 2 规定的 stub handlers 持有；engine dispatch 未暴露 IPC。

## 9. Deferred Work（只记录，不实现）

- 未来正式的 artifact/validation read API（需先冻结 op 级 payload ownership 契约）。
- 自动 validator 注册 / DevCompany 内建 validator 登记面（roadmap T13.5/T13.6 的产品化层）。
- Memory run-scoped provenance、CAS 清理策略（需新 ADR）。
- Renderer UX 接入 Artifact/Validation 视图。

## 10. Final Record

- Final closeout commit：见 `PROJECT_HANDOFF.md` Commit 段（`chore: close sprint 13`）。
- Tag：`sprint-13.0.0`（依 EXECUTION_ROADMAP G6「结束时打 tag `sprint-N`」+ Sprint 13 Git Checkpoint
  `sprint-13` + sprint-1.0.0…sprint-12.0.0 十二例先例推导），指向 closeout HEAD；未 push。
- Sprint 13 任务链：T01–T11 全部 CLOSED（逐 Task 独立 commit + corrective，未 amend），
  T12 = 本文 + 文档收口 + 最终回归 + tag。
