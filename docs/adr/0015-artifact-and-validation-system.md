# ADR-0015：Artifact Model（Sprint 13A — 只冻结设计，不实现）

> 归属：Sprint 13A；规划书 §三十一（Artifact System，repository-native 摘要见
> `../spec/S13_ARTIFACT_VALIDATION_CANONICAL_REQUIREMENTS.md`）。
> 上游：ADR-0002（Core 词表与端口冻结）、ADR-0003（状态分层）、ADR-0006（UnitOfWork 与幂等）。
> 姊妹篇：ADR-0016（Validation Framework）。配套契约：`../sprint13/S13_ARTIFACT_CONTRACT.md`（字段级细节）。
> **本 ADR 只冻结架构决策；Sprint 13A 不交付任何实现（实现属 Sprint 13B，需另行批准）。**

## Status

**Accepted（2026-09-18，Sprint 13A 最终架构评审）**。Acceptance basis：Sprint 1 frozen Artifact/Validation
contracts preserved · CAS crash model frozen · Windows no-clobber publication requirement frozen ·
immutable Artifact model frozen · SQLite metadata + filesystem CAS frozen · Workflow Run = provenance ·
ArtifactService = lifecycle semantics owner · ArtifactStore = persistence-only port ·
managed contentRef security boundary frozen · permanent creation idempotency Option B frozen
（bounded-retention conflict closed）· no architecture-blocking open questions remain。
实现属 Sprint 13B（已批准，逐 Task 审核制）。

## Context

侦察（`../sprint13/S13_EXISTING_CONCEPT_MAP.md`）证实：Sprint 1 已在 Core 冻结 `Artifact` 领域契约
（不可变、contentRef + sha256 contentHash），但生产零接线；系统存在七类隐式产物载体
（agent/tool 引用表、resultRef、outputDigest、Handoff refs、Decision refs、Memory 内联 content、
Provider 瞬态输出），事件目录预留 `artifact.created`（登记 `runtime:S8`，从未发射）。
Boss 裁定：**优先兑现既有契约、additive integration、保持 backward compatibility**（兼容性审计：
无不可兼容项）。权威原始需求来自仓库外规划书 `最终1.1.txt` §三十一——已按 §34 入库为规范化摘要。

## Existing Sprint 1 Contract

`packages/core/src/domain/artifact.ts`：`Artifact { id, runId(必填), taskId|null, kind, contentRef,
contentHash(64-hex 校验), sizeBytes, producedBy, createdAt }`；`isArtifactIntact`（哈希指纹即验证）；
Core 永不读内容（外环重算摘要，结论记为 Validation）。**本 ADR 全部决策以此为起点，字段零变更。**

## Decision（12 项冻结）

1. **复用 Sprint 1 Artifact contract**（字段零变更；companyId 候选被拒——经 runId→run 可达）。
2. **Artifact is immutable**（Option A）：无 mutable revision、无 artifact_versions、无 supersession、
   S13 无删除 API。修正 = 新 Artifact 新 id。
3. **artifactId ≠ contentHash ≠ contentRef**：artifactId=业务身份（引用主体）；contentHash=内容身份
   （integrity + CAS 寻址/去重）；contentRef=内容定位引用。`artifactId ≠ contentHash` 强制；
   同 contentHash 多 artifactId 合法且受支持。
4. **Workflow Run = primary provenance**（runId+taskId+producedBy 记录来源）；**Artifact lifecycle
   semantics = Artifact subsystem / ArtifactService**（不可变 ⇒ 无更新/删除生命周期）；**ArtifactStore =
   persistence port only**——Store 不得拥有 lifecycle/provenance/validation policy 或任何业务语义
   （否则 persistence adapter 会反向成为业务 owner）。其余模块只持 reference。
   **禁止推出「Run 删除 → Artifact 删除」**。术语统一优先 source/provenance。
5. **SQLite = metadata SoT；filesystem CAS = content bytes SoT**（互不替代）。
6. **contentRef remains `sha256:<hex>`**（文档层既有契约：MEMORY_ARCHITECTURE M6:26/:80、
   HANDOFF_PROTOCOL:98/144/434；Core 层 opaque 仅非空校验）——**拒绝** `cas:` 前缀提案（Boss 修正 1）；
   格式解释在 CAS 适配器层。**写入契约双轨分离（Boss 收紧 3）**：
   - **S13 managed CAS write path**：ArtifactService 新写入**只能**生成 trusted `sha256:<hex>`
     contentRef（hash 由 ArtifactContentStore 对实际 bytes 实算）；caller/Renderer/Provider/Tool
     传入 workspace/绝对路径/UNC/file:// 等字符串**冒充 managed contentRef 一律拒绝**；
   - **legacy opaque refs**：workspace-style ref 仅作 **legacy/read compatibility**（Sprint 1 兼容
     读取），**不是** S13 managed CAS write format——兼容逃生舱不得扩大为新安全入口；
   - **file-reference ≠ CAS-managed Artifact content**：独立 resolver / trust policy（见决策 10），
     opaque 身份不豁免 path validation。
7. **Core treats contentRef as opaque**：Core 不知 fs/SQLite/Electron/`%APPDATA%`/Windows path/CAS 目录。
8. **content-first / metadata-second** 写序（见 Failure/Recovery Model）。
9. **no artifact_versions / no relation table**：关系由引用方表达（handoff_refs、
   agent/tool `artifact_ref` 表、decision `related_artifact_refs_json`、memory provenance）——
   中心化关系表 = 第二 SoT（rejected alternatives）。
10. **CAS/path trust boundary**：CAS 物理路径永不接受外部输入（Renderer/Provider/Tool/Validator）；
    contentHash 必须由 trusted side 实算；file-reference 与 CAS-managed 是两个 trust model
    （file-reference 仅限组合根注册 workspace root 内相对路径，不构成任意文件读取后门）。
11. **startup integrity reconciliation**：orphan CAS / staging 残留 / metadata→CAS missing（fail closed）/
    CAS→metadata 孤儿，S13 **只 detect/report，不自动删除**。
12. **第 12 条迁移链 `artifact`**（命名符合既有单数领域名词惯例），owning `artifacts` 单表
    （validations 同链同迁移文件，归 ADR-0016）；DDL 见契约 §4.1；无跨链 FK（仓库先例：全部既有链
    跨链引用列均无 FK，同链内才有——裁定基于真实先例非偏好）。
13. **CAS final publication = race-safe no-clobber（Boss 收紧 1）**：Staging 与 Final Publication
    是两个阶段——staging（write temp → close → 实算 SHA-256 → verify）之后，把对象发布到
    `sha256:<hex>` 正式地址必须采用 **race-safe / no-clobber publication semantics**；
    冻结原则：**`CAS final publication MUST NOT overwrite an already-published object.`**
    目标已存在 → verify existing object hash → matching = reuse / mismatch/corruption = fail closed。
    `pre-check + rename` **不能作为唯一保护**（check 与 rename 之间存在 TOCTOU race；Node v24/win32
    的 renameSync 会静默覆盖已存在目标——2026-09-18 实测）。具体 no-clobber primitive
    （exclusive-create / hard-link publish / COPYFILE_EXCL / 其它 Node v24+NTFS 适用机制）
    **不在 13A 指定**，由 13B 实机并发测试择定（Task-13-03）。
14. **`artifact.created` 发射方改指 = event producer implementation ownership correction**：
    event name 不变 · 语义不变 · 基础设施不变（仍走 defineEvent + events.append）· payload 契约不变
    （S13 白名单是该既有语义的第一次真实使用，非扩展）；未来若需扩展 payload 必须 additive
    （新可选字段），破坏性变更需新 ADR。
15. **commandId 幂等 = ledger 快照（有界窗口）+ row-level permanent creation identity（双轨，Boss
    Blocker 裁定 = Option B）**。真实 retention 语义核查（2026-09-18）：`command_ledger` durable 但
    **每次 engine dispatch 后同步 trim**（engine.ts:491），默认 `maxLedgerEntries ?? 1_000`
    （engine.ts:173），按数量 rowid 最旧先出（非时间，Sprint 3 review LOW-1），全局单表无分区、
    无 tombstone——**ledger 幂等窗口有界（1000 条）**，窗口内同 key 异内容 CONFLICT（engine.ts:396-401），
    **窗口外无挡板**。因此：
    - **Command Ledger = retry/result cache + transactional command record**（有界窗口内快速恢复）；
    - **Artifact / Validation row = permanent creation identity**：两表各增
      `creation_command_id TEXT` + `creation_command_fingerprint TEXT`（persistence metadata，**非
      domain 字段**——Sprint 1 类型与工厂零变更）+ partial unique index
      `UNIQUE(creation_command_id) WHERE creation_command_id IS NOT NULL`（**仓库先例**：tools 链
      `idx_tool_invocations_idempotency` 同构）；
    - 服务 retry lookup 三级顺序（冻结）：① ledger.get 命中 → fingerprint 比对（同 → 返回 outcome /
      异 → CONFLICT）→ ② ledger miss（已 trim）→ 按 `creation_command_id` 查行（命中 → fingerprint
      比对：同 → 返回既有 identity，**不创建第二个**；异 → CONFLICT）→ ③ 都 miss → 正常创建；
    - **不加第三张表**；ledger bounded 语义零改动；trim 后 Case 3 见 Failure/Recovery Model。
    - **Creation cardinality（Accepted contract 补充）**：one CreateArtifact commandId →
      **exactly one Artifact identity**（partial unique index 强制）。若未来需要
      one command → multiple Artifacts，必须重新设计 batch creation identity 并另立 ADR +
      contract change——Sprint 13 不隐式支持。

## Alternatives Considered

| 议题 | 备选 | 裁定理由 |
|---|---|---|
| 不可变性 | B: mutable+revision；C: logical+immutable versions | B 需要产物不需要的并发控制且破坏证据完整性；C 零消费方（DevCompany 类型均 per-run）；A 与 revision/commandId/append-only/supersession 全部同构（对比表见契约 §2） |
| 内容存储 | A: SQLite 全内联（违反 ARCHITECTURE §9.4、卡顿同步 API）；C: 全 filesystem（失去事务纪律） | B 与既有文档设计（MEMORY_ARCHITECTURE M6 / ARCHITECTURE §7.11、§9.4、§9.6）完全一致——判定为现行设计非历史草案 |
| contentRef 格式 | `cas:sha256:<hex>` 前缀 | 撤销：`sha256:<hex>` 已是既有格式契约，加前缀破坏兼容性 |
| ownership 表述 | "primary owner = Workflow Run" | 修正为 provenance 语义：runId 明确的是来源不是生命周期（Boss 修正 2） |
| 关系建模 | relation 表 / 跨链 FK | JSON refs + 服务层校验已满足 traceability/immutable reference/存在性校验；仓库先例无跨链 FK |
| Validator 创建报告 | Validator 直写 ArtifactStore | 收紧为 ReportArtifactDescriptor → 服务层物化（Boss 修正 3，详见 ADR-0016） |
| commandId 幂等载体 | **A: bounded ledger 独力承载**（trim 后同 commandId 重试会创建第二个 artifact——对 immutable audit evidence 不可接受）；**C: selective permanent ledger retention**（现有 CommandLedgerPort 无 selective 机制，需改 Sprint 3 冻结架构且 ledger 无界增长） | **B: row-level permanent creation identity**（裁定，见决策 15）——两表各 +2 列 + partial unique index（tools 链先例同构），ledger 语义零改动，无第三张表 |

## Consequences

- 正面：七类隐式载体获得统一身份与 SoT；Handoff/Decision/Memory 引用从悬空字符串升级为可校验引用；
  `artifact.created` 首次真实发射；零既有测试删除（纯加法）。
- 代价：备份从单文件变为 db + artifacts 目录（ARCHITECTURE §9.6 已有承诺）；CAS 与 DB 双介质带来
  崩溃一致性设计负担（下节模型消化）；报告物化经服务层中转（换取 Validator 解耦）。

## Compatibility

additive integration（矩阵详见 `../sprint13/S13_WORKFLOW_INTEGRATION.md` §5）：Engine 仅加证据守卫
（载荷校验扩展）；Router 零交互（不得知道 CAS/ArtifactStore）；Agent Runtime 零改动（物化在 App 层）；
Tool Registry 加 validator capability 声明面；Handoff/Decision 零 schema 变更；Memory 仅 provenance
闭集 +ARTIFACT；组合根 chains 11→12 + 新服务 wiring；Persistence 纯加法。**无 breaking change。**

## Security

风险登记册（20 项分级 + 8 项 Must Solve）：`../sprint13/S13_RISK_REGISTER.md`。
Must Solve：R-01 路径注入（路径闭集 + root 约束）· R-02 hash 伪造（trusted side 实算）·
R-03 validator 注入（capability 注册面，归 ADR-0016）· R-04/R-19 dangling ref（写序 + 对账 fail closed）·
R-05 重放（既有 command ledger）· R-06 caller 自报 PASS（evidence guard，归 ADR-0016）·
R-07 不安全 file-reference（双 trust model）· R-08 错误证据复用（绑定校验）。

## Failure / Recovery Model

**明文：filesystem CAS + SQLite 不构成 ACID transaction；任何文档不得宣称跨两者原子提交。**

写入顺序（两阶段发布；决策 13；Windows 语义已实测）：

```text
— Staging —
1 receive bytes → 2 staging 临时文件（<hash>.staging-<uuid>）→ 3 实算 SHA-256（不信 caller）
→ 4 close/flush + verify
— Final CAS Publication（race-safe no-clobber，决策 13）—
5 publish 到 sha256:<hex> 正式地址：MUST NOT overwrite 已发布对象。
   目标已存在 → verify existing hash：match = reuse（幂等）；mismatch/corruption = fail closed。
   pre-check + rename 不得作为唯一保护（TOCTOU race，见下）；具体 primitive（exclusive-create /
   hard-link publish / COPYFILE_EXCL / 其它）由 13B 实机并发测试择定，13A 不凭理论指定（Task-13-03）。
— SQLite —
6 begin UnitOfWork → 7 写 artifacts 行 → 8 append artifact.created
→ 9 put command ledger entry（outcome 携带 artifactId，决策 15）→ 10 COMMIT（row+event+ledger 同事务）
```

**Windows/Node 实证（2026-09-18，Node v24.19.0 / win32，temp 探针）**：`fs.renameSync` 到已存在目标
**静默覆盖成功**（MoveFileEx REPLACE），到不存在目标正常成功。⇒ `exists?→verify→rename` 序列在
check 与 rename 之间存在 **TOCTOU race**（另一 writer 可在窗口内创建/替换目标），**不得作为唯一保护**；
no-clobber publication primitive 由 13B 实机并发测试实证择定（Writer A+B 同 hash 并发 publish →
只有合法完整对象、不覆盖、无 partial final、两调用都成功；已有 target 内容不符期望 hash → fail closed），
并在 Electron 运行时复测。

崩溃案例（ADR 必答八问的权威答案）：

| 问 | 答 |
|---|---|
| 1. CAS 成功、DB 失败？ | **Case A orphan CAS object**：orphan ≠ 业务 Artifact（无 metadata 即不存在）；正常 lookup 不可达；启动对账 detect/report；**S13 只检测不自动删除** |
| 2. DB 有 ref、CAS missing？ | **Case B 严重完整性错误**：写序从源头压概率；对账发现 → fail closed（diagnostic + integrity verification 失败 + Validation 不允许以它 PASS + Workflow 不当有效 evidence）。**不加 mutable `corrupt` 状态**——以 integrity verification + diagnostic + Validation ERROR 表达 |
| 3. temp file crash？ | **Case C**：staging 非正式 contentRef 目标；可识别命名；启动 detect；自动清理推迟（Risk Register 裁定） |
| 4. duplicate content？ | **Case D**：publication 幂等——同 bytes → 同 content identity；no-clobber publish 复用已有对象（verify hash），不覆盖、不重复占用；并发发布由 13B 实测机制保证 no-clobber/no-partial（决策 13） |
| 4b. **ledger 被 trim 后同 commandId 重试？**（Blocker Case 3，Option B 裁定） | ledger miss → 按 `creation_command_id` 查 artifacts 行：命中 + fingerprint 相同 → 返回既有 artifactId（**不创建第二个**，permanent idempotency 不依赖 ledger 窗口）；fingerprint 不同 → `CONFLICT` fail closed（行上存有 fingerprint，窗口外同样可判） |
| 5. startup reconciliation 做什么？ | 四类 detect+report：orphan CAS、staging 残留、metadata→CAS missing（fail closed）、CAS→metadata 孤儿 |
| 6. 哪些自动修复？ | **S13：无** |
| 7. 哪些只 report / fail closed？ | report：orphan/staging/孤儿；fail closed：metadata→CAS missing |
| 8. 哪些 deferred？ | 自动 GC/清理、corrupt 状态机、跨机 CAS、对账修复动作（→ Out of Scope / Later） |

**Case E**（SQLite commit 后即崩）：final CAS 已存在 + metadata 已 commit → 重启后 Artifact 完整，无需修复。
Validation 事务边界：**不做**跨"Artifact 创建+Validator 执行+Workflow transition"的超长事务
（分三段，见 ADR-0016）。

## Risks

- CAS 与 DB 双介质一致性（缓解：写序 + 只读校验 + 启动对账）；
- publication TOCTOU race（缓解：决策 13 no-clobber 冻结原则 + 13B 实机并发测试择定 primitive）；
- Windows rename 覆盖语义（缓解：no-clobber 机制；Electron 运行时复测列入 T03）；
- `artifact.created` 发射方登记改指（`runtime:S8` 从未发射 → `artifact-service:S13`）= event producer
  implementation ownership correction（决策 14：name/语义/基础设施/payload 契约均不变）；
  实现期加事件目录一致性测试；
- orphan GC 未来误删（缓解：S13 只 report；自动化推迟并需独立 ADR）。

## Rejected Alternatives

`cas:` contentRef 前缀（破坏既有格式契约）· SQLite 全内联（违反 blob 不进 DB）· 全 filesystem 无事务 ·
mutable revision / artifact_versions / supersession / 删除 API（破坏证据完整性，且零消费方）·
artifact_relations 中心表（第二 SoT）· 跨链 FK（违反仓库先例）· Provider/Validator 直写 Store/CAS ·
Run 级联删除 Artifact · 事件总线或 outbox（既有 UnitOfWork+append 充分）·
aggressive CAS GC（误删风险）· mutable corrupt 状态（不可变对象上引入可变状态）·
**pre-check + rename 作为唯一 publication 保护（TOCTOU）** · **ArtifactStore 拥有 lifecycle/policy**
（Store = persistence port only）· **caller 提供 workspace/路径类 ref 冒充 managed CAS contentRef**
（managed write path 只产 trusted `sha256:<hex>`）· **commandId→resultId 第三张映射表**
（现有 ledger outcome 快照即载体）· 整体规划书入库（OQ-1 裁定 NO，规范化摘要为准）。

## Open Questions

| # | 问题 | 状态 |
|---|---|---|
| OQ-1 | 外部规划书 `最终1.1.txt` 是否整体入库 | **CLOSED（2026-09-18 Boss 裁定：NO）**——不复制整份规划书入仓；`../spec/S13_ARTIFACT_VALIDATION_CANONICAL_REQUIREMENTS.md` 为永久 repository-native normative summary（保留 provenance / 规范要求 / 与 Sprint 1 契约的关系，不复制大段原文） |
| IVI-1（原 OQ-2） | Node v24+NTFS no-clobber publication primitive 实测择定 + 并发 publication test + Electron 运行时复测 | Implementation Verification Item（13B Task-13-03），非架构阻塞 |
| IVI-2（原 OQ-3） | file-reference workspace root 的注册面形态（组合根配置 vs 设置表） | Implementation Verification Item（13B Task-13-03/T11），非架构阻塞 |

> 原 OQ-4（Tool version 列，ADR-0016）与 OQ-5（capability IPC 面）同样降级为 Implementation
> Verification Item，见 ADR-0016。
