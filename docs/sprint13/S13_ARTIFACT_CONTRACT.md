# S13 Artifact Contract（Sprint 13A Freeze）

> 状态：FROZEN（Proposed — 待 Boss 架构评审 + ADR Acceptance 后生效；生效前禁止实现）。
> 配套：`S13_EXISTING_CONCEPT_MAP.md`（证据底稿）· `S13_VALIDATION_CONTRACT.md` · `S13_WORKFLOW_INTEGRATION.md`
> · `S13_TEST_STRATEGY.md` · `S13_RISK_REGISTER.md` · `../spec/S13_ARTIFACT_VALIDATION_CANONICAL_REQUIREMENTS.md`
> · ADR-0015（Artifact Model）· ADR-0016（Validation Framework）。
> 总原则（Boss 裁定）：优先兑现 Sprint 1 冻结契约，保持 backward compatibility，除非有明确不可兼容证据。

## 0. Artifact 侧决策总表

| # | 决策 | 结论 |
|---|---|---|
| D-01 | 领域契约 | **复用 Sprint 1 `Artifact`（`packages/core/src/domain/artifact.ts`）原样；新增字段：无**（companyId 候选被拒：经 runId→run 可达，复制维度违反单一 SoT） |
| D-02 | 不可变性 | **Option A：immutable**。无 mutable revision、无 artifact_versions、无 supersession、无删除 API |
| D-03 | 三重区分 | **artifactId（业务身份）≠ contentHash（内容身份）≠ contentRef（内容定位引用）**，三者不得混淆；`artifactId ≠ contentHash` 强制 |
| D-04 | contentRef 格式 | **沿用既有 `sha256:<hex>`**（文档层既有契约：MEMORY_ARCHITECTURE M6:26/:80、HANDOFF_PROTOCOL:98/144/434）；Core 保持 opaque 不解析；格式解释在 CAS 适配器层。**撤销**早期 `cas:sha256:` 提案 |
| D-05 | Provenance / Lifecycle | **Primary provenance = Workflow Run**；**lifecycle semantics = Artifact 子系统 / ArtifactService**；**ArtifactStore = persistence port only**（不得拥有 lifecycle/provenance/validation policy 或业务语义）；其余模块只持 reference。禁止"Run 删除 → Artifact 必须删除" |
| D-06 | 类型系统 | Core 无 type 枚举；`kind` = pack 定义不透明字符串；适配器层最小支撑 text / json / file-reference |
| D-07 | 内容存储 | **Option B：SQLite 元数据 + filesystem CAS**；SQLite=业务/元数据真相，CAS=不可变内容 bytes 真相 |
| D-08 | 持久化 | 第 12 条迁移链 `artifact`（命名符合既有单数领域名词惯例），owning `artifacts` 单表；不建 artifact_versions / artifact_relations |

## 1. 身份与三重区分（冻结）

```text
Artifact identity    = artifactId（品牌化 ULID，artifact_ 前缀）—— 审计与引用主体
Content identity     = contentHash（小写 sha256 hex）—— 字节是什么；integrity + CAS 寻址/去重
Content locator      = contentRef（sha256:<hex> 或 workspace 路径）—— 字节在哪里
```

- 两次运行产出相同字节 → **两个 artifactId、同一 contentHash**（存储层去重，身份层不去重）：
  `Artifact A → contentHash X` 与 `Artifact B → contentHash X` **合法且受支持**。
- 引用（Handoff/Decision/Memory/Validation evidence）永远指向 **artifactId**。
- contentHash 不承担 command identity / Artifact 业务身份 / Workflow identity 中的任何一个。
- 禁止"按 hash 更新 artifact"类伪 API（构造上不存在）。

### 1.1 contentRef 格式核对结论（Boss 修正 1，实证记录）

| 层 | 现状 | 证据 |
|---|---|---|
| 文档层 | `sha256:<hex>` 已是稳定格式契约 | MEMORY_ARCHITECTURE M6（`contentRef = sha256:<hex>`，:26）、MemoryRecord 注释（`sha256:<64 hex>`，:80）、HANDOFF_PROTOCOL（:98/:144/:434） |
| Core 代码/测试 | 完全 opaque（仅非空校验） | `artifact.ts:48`；测试值 `workspace/reports/1.md` |
| 结论 | **沿用 `sha256:<hex>`**；CAS 适配器解释 `sha256:<hex>` → filesystem object；Core 不解析。**写入契约双轨分离（Boss 收紧 3）**：S13 managed CAS write path 只产 trusted `sha256:<hex>`（实算）；workspace-style ref 仅为 **legacy/read compatibility**（Sprint 1 兼容读取，**不是** managed write format，不得扩大为新安全入口）；file-reference 是独立 trust model（§8），opaque 身份不豁免 path validation | — |

## 2. 不可变性（Option A，冻结）

| 维度 | A：immutable（**选定**） | B：mutable+revision | C：logical+versions |
|---|---|---|---|
| revision 乐观并发 | 无冲突 | 产物不需要的并发控制 | 逻辑层需要 |
| commandId 幂等 | INSERT-only 天然契合 | 重放语义模糊 | 契合但多一层 |
| append-only 事件 | 仅 `artifact.created` | 需 update 事件族 | 需 version 事件族 |
| supersession | 互补（supersession 属"活状态"） | 概念重复 | 概念重复，零消费方 |
| 证据完整性 | 替代=新 id 新行，旧证据永在 | 旧证据可覆盖——审计灾难 | 可行但无需求 |

"修正" = 新 Artifact（新 id，锚定纠正它的 run）。**revisitWhen**：出现跨 run 逻辑文档身份需求 → 附加层（artifact_groups）另立 ADR。

## 3. Provenance 与 Lifecycle（Boss 修正 2 + 收紧 4，冻结）

```text
Artifact provenance          = Workflow Run（runId 必填 + taskId + producedBy）
Artifact lifecycle semantics = Artifact 子系统 / ArtifactService（不可变 ⇒ 无更新/删除生命周期）
ArtifactStore                = persistence port only（create/get/list；不拥有 lifecycle/provenance/
                               validation policy 或任何业务语义——否则 persistence adapter 反向成为
                               业务 owner）
References                   = Agent / Tool / Handoff / Memory / Decision 只持 reference，永不第二 SoT
```

从既有表反推：`agent_execution_artifacts` / `tool_invocation_artifacts`（`(source_id, artifact_ref)` UNIQUE）、
`AgentExecution.resultRef`、`handoff_refs kind=artifact`、`decisions.related_artifact_refs_json` —— 全部是引用形态；
Sprint 1 契约 `runId NOT NULL` 是唯一 provenance 锚点（它明确的是**来源**，不是生命周期归属）。
术语纪律：统一优先 **source / provenance**；"owner" 仅指生命周期归属。

## 4. 持久化（冻结草案）

### 4.1 表结构

只建 **`artifacts`** 一表（validations 归 Validation 契约 / 同链 0001 迁移，见 `S13_VALIDATION_CONTRACT.md` §5）。
**0002 corrective（ADR-0017）**：validations 增 nullable `target_ref` 列 + `idx_validations_target`
索引——被验证 Artifact 的 durable 身份绑定（与 evidence_refs 严格分离），legacy null 兼容。
不建：`artifact_versions`（D-02）、`artifact_relations`（关系归引用方，§5）、`artifact_supersession`（D-02）、`artifact_gc`（§28）。

```sql
-- migrations/artifact/0001_artifact_validation.sql（Sprint 13B 实现，本阶段只设计）
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id  TEXT PRIMARY KEY,                -- ArtifactId
  run_id       TEXT NOT NULL,                   -- primary provenance（D-05）
  task_id      TEXT,                            -- NULL = stage 整体产出
  kind         TEXT NOT NULL,                   -- pack 定义，不透明
  content_ref  TEXT NOT NULL,                   -- sha256:<hex>（CAS）或 workspace 路径
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 0),
  produced_by  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  -- permanent creation identity（Option B，Boss Blocker 裁定；persistence metadata，非 domain 字段）
  creation_command_id         TEXT,             -- 创建该行的 commandId
  creation_command_fingerprint TEXT            -- 命令内容指纹（窗口外 CONFLICT 判定依据）
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run  ON artifacts (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts (content_hash);
-- permanent idempotency：一个 commandId 至多创建一个 Artifact（ledger trim 后仍可恢复与判重）
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_creation_command
  ON artifacts (creation_command_id) WHERE creation_command_id IS NOT NULL;
```

- 无跨链 FK（**仓库先例裁定**：handoff/memory/agent/tools 等链的跨链引用列均无 FK
  ——如 `handoffs.run_id`、`memories.company_id`、`agent_executions.execution_id` 引用侧表；
  同链内才有 FK，先例 `handoff_refs` → `handoffs`）。存在性由服务层校验（§22/§9）。
- 无 version/revision 列（D-02）。created_at 一次写入不可变。
- **`creation_command_id`/`creation_command_fingerprint` 是 persistence metadata**（幂等归属行），
  **不是 domain 字段**——Sprint 1 `Artifact` 类型与 `createArtifact` 工厂零变更；由
  ArtifactService 在 store 层注入。partial unique index 与 tools 链
  `idx_tool_invocations_idempotency`（`WHERE idempotency_key IS NOT NULL`）同构。
- **Migration #12 仍只有两张表**（validations 同链同文件，增列同理）——Option B 不引入第三张表。

### 4.2 删除 / 保留

- **无删除 API**（S13）。provenance ≠ 生命周期所有权：Run 记录的未来清理策略**不得级联** artifacts。
- 保留：与引用方同寿命；备份 = SQLite 文件 + artifacts CAS 目录（ARCHITECTURE §9.6 承诺）。
- **无 aggressive GC**：orphan 只 detect / report / diagnose（§24 Case A），自动清理推迟。

## 5. 与其它模块的引用边界（§17 / §18 / §19，冻结）

| 模块 | 关系 | 冻结规则 |
|---|---|---|
| **Decision（§17）** | Decision → Artifact = **evidence/reference** | **Option A：沿用 `related_artifact_refs_json`**（不为关系正规化扩 schema——现有 JSON refs 已满足 evidence traceability + immutable reference + 服务层存在性校验）。拒绝 Option B（relation 表 = 第二 SoT）与 Option C（跨链 FK，违反仓库先例）。Decision 不拥有 Artifact 生命周期；Artifact 不因 Decision 删除而删除；Decision 不复制 content |
| **Handoff（§18）** | Handoff = coordination/transport；Artifact = durable output/evidence | Handoff 可 reference Artifact（既有 `kind='artifact'` ref）；**不拥有、不复制 content、不负责 Artifact/Validation persistence**；Handoff 独立领域语义不吞并。既有**非 artifact 类 refs 不迁移**；统一 refs 若构成 breaking migration 则推迟 |
| **Agent Runtime（§19）** | 产生待物化输出 → 获得 reference | 可在 execution record 存 artifactRefs；**不直写 artifacts 表、不操作 CAS** |
| **Tool Invocation（§19）** | 同上 | `artifactRefs` / `outputDigest` 保持引用/摘要语义 |
| **Provider（§19）** | 只返回 raw invocation result | **禁止 Provider Adapter → ArtifactStore / ValidationStore / CAS / SQLite**。**Provider output ≠ 自动 Artifact**——是否物化由 Application 层决定 |

职责链（§19 冻结）：

```text
Provider → raw InvocationResult
Agent/Tool application layer → 解释结果，决定哪些输出需要物化
ArtifactService → 决定/物化选定的 durable 输出
ArtifactStore / ArtifactContentStore → 持久化 metadata + content
AgentExecution / ToolInvocation → 在执行记录中保存 Artifact reference
```

## 6. 事件（§20，冻结）

`artifact.created` 只能**在 Artifact durable 建立之后**可观察：

```text
CAS content durable → Artifact metadata durable（同 UnitOfWork）→ 既有 event append 机制成功 → artifact.created 可观察
```

禁止 emit 后再持久化（phantom Artifact）。复用既有 `defineEvent` + `events.append` + UnitOfWork；
发射方登记由 `runtime:S8`（从未发射）改指 `artifact-service:S13`（ADR-0015 记录的元数据修正）。
payload 白名单：artifactId/runId/taskId/kind/contentHash/sizeBytes/producedBy/traceId——无内容正文。
不引入 event bus / queue / outbox / broker（既有机制充分）。

## 7. Source of Truth（§21，冻结）

```text
Artifact metadata（artifactId/runId/kind/contentRef/contentHash/producedBy/createdAt…）→ SoT = SQLite
Artifact content bytes                                                              → SoT = filesystem CAS
```

SQLite **不是**内容 bytes 的 SoT；CAS **不是**业务身份的 SoT。两端不可互相替代。

## 8. 信任边界（§22 Artifact 侧 + Boss 收紧 3，冻结）

- **contentHash 必须由 trusted side 对实际 bytes 计算**；caller 提供的 hash 声明一律不信
  （ArtifactContentStore.put 实算并返回；调用方自报 hash = `INVALID_ARGUMENT`/忽略并以实算为准）。
- **S13 managed CAS write path（新写入唯一合法格式）**：ArtifactService 新建 CAS-managed Artifact 时
  contentRef **只能**由服务端生成 trusted `sha256:<hex>`。Renderer / Provider / Tool / caller 传入
  `workspace/xxx`、`C:\xxx`、`..\xxx`、`file://xxx`、UNC 等字符串**冒充 managed contentRef 一律拒绝**
  （负例测试见 TEST_STRATEGY §8）。
- **Legacy opaque refs = legacy/read compatibility**：workspace-style ref 仅保留 Sprint 1 兼容**读取**，
  **不是** S13 managed CAS write format；兼容逃生舱不得扩大成新的安全入口。
- **contentRef / CAS 物理路径**：外部输入不得指定 CAS physical path。防护闭集：
  `../`、`..\`、盘符（`C:\`）、UNC（`\\server\`）、`file://`、绝对路径、任意 user-controlled 存储路径。
- **file-reference ≠ CAS-managed Artifact content**（两个独立 trust model）：file-reference 需要独立
  resolver / trust policy——仅限组合根显式注册 workspace root 之下的相对路径，解析使用 real-path
  检查不逃逸 root（含 symlink/junction/reparse-point 防护）；**不得把 raw filesystem path 直接交给
  Core 或 Validator**；不能因为 contentRef 是 opaque 就绕过 path validation；不构成 arbitrary file
  read 后门。
- Renderer 只能提交 schema 验证过的 intent/DTO；不得决定 CAS path / contentHash / trusted provenance / durable identity。

## 9. Ports（§23 Artifact 侧，冻结）

```text
packages/core/src/ports/artifact.ts（Core）
  ArtifactStorePort：create / get / listByRun / listByHash —— 只读 + 创建；无 update/delete
packages/persistence（外环；Core 保持内容盲：不知 node:fs / SQLite / Electron / %APPDATA% / Windows path / CAS 目录）
  ArtifactContentStore：put(bytes) → { contentRef: 'sha256:<hex>', contentHash, sizeBytes }（实算 hash）
                        get(contentRef) → bytes（按 contentHash 校验）
                        verify(artifactId) → integrity verdict（诊断用）
```

不设独立 ArtifactRunner 之类端口（无消费方）；Windows CAS 布局细节属适配器实现。

## 10. 事务 / 崩溃一致性（§24，冻结）

**明文：filesystem CAS + SQLite 不构成一个 ACID transaction。** 任何文档不得宣称跨两者"原子提交"。

### 10.1 推荐写入顺序（两阶段发布；Windows 语义已实测）

```text
— Staging —
1. receive content bytes
2. write staging/temp file（可识别 staging 命名，如 <hash>.staging-<uuid>）
3. compute SHA-256 from actual bytes          ← 实算，不信 caller（§8）
4. close / flush + verify
— Final CAS Publication（race-safe no-clobber）—
5. publish 到 sha256:<hex> 正式地址：MUST NOT overwrite an already-published object。
   目标已存在 → verify existing object hash → matching = reuse（幂等）；
   mismatch/corruption = fail closed。
   ⚠ pre-check + rename 不能作为唯一保护（TOCTOU：check 与 rename 之间存在窗口，另一 writer 可
   创建/替换目标；Node v24/win32 renameSync 实测会静默覆盖已存在目标）。具体 no-clobber primitive
   （exclusive-create / hard-link publish / COPYFILE_EXCL / 其它 Node v24+NTFS 适用机制）不在 13A
   指定——由 13B Windows 实机并发 publication test 择定（Task-13-03）。
— SQLite —
6. begin SQLite UnitOfWork
7. persist Artifact metadata row
8. append artifact.created（既有 defineEvent + events.append）
9. put command ledger entry（outcome 携带 artifactId —— §11 绑定契约）
10. COMMIT（row + event + ledger 同一事务）
```

**Windows/Node 实证（2026-09-18，Node v24.19.0 / win32，temp 目录探针）**：
`fs.renameSync` 到**已存在目标会静默覆盖成功**（MoveFileEx REPLACE 语义），到**不存在目标**正常成功。
因此 `exists?→verify→rename` 序列存在 **TOCTOU race**：check 与 rename 之间另一 writer 可创建/替换
目标，最终覆盖他人已发布对象。**race-safe no-clobber publication 是冻结原则**（机制 13B 实测择定：
Writer A+B 同 contentHash 并发 publish → 只有合法完整对象、不覆盖、无 partial final object、两个调用
都得到正确结果；已有 target 内容不符期望 hash → fail closed），实现期还需在 Electron 运行时复测。

### 10.2 崩溃案例矩阵（ADR-0015 §8 的权威答案表）

| Case | 场景 | 结果与处置 |
|---|---|---|
| **A** | CAS 写成功，SQLite rollback/崩溃 | **orphan CAS object**：orphan ≠ 业务 Artifact（无 metadata 即不存在业务 Artifact）；正常 lookup 不可达；启动对账 **detect/report**；**S13 只检测不自动删除**（GC 误删风险 → 自动清理推迟，§28） |
| **B** | SQLite 有 metadata，CAS content 缺失 | **严重完整性错误**。写序（content first → metadata second）从源头压概率；启动对账发现 → **fail closed**：emit diagnostic、integrity verification 失败、Validation 不允许以该 Artifact 为证据 PASS、Workflow 不得将其当有效 evidence。**不给 immutable Artifact 加 mutable `corrupt` 状态**——以 integrity verification + diagnostic + Validation ERROR 表达 |
| **C** | temp/staging 写一半崩溃 | staging 文件不是正式 contentRef 目标；可识别命名（`*.staging-*`）；启动 detect；自动清理由 Risk Register 裁定（默认推迟） |
| **D** | 相同 contentHash 重复写 | publication 幂等：相同 bytes → 相同 content identity；no-clobber publish 复用已有对象（verify hash），不覆盖、不重复占用；**并发发布**由 13B 实测的 no-clobber primitive 保证不覆盖/无 partial final/双调用成功（§10.1） |
| **E** | SQLite commit 后立即崩溃 | final CAS 对象已存在 + metadata 已 commit + 事件语义一致 → 重启后 Artifact 完整可用（无需修复动作） |

### 10.3 启动对账范围（S13）

detect + report：orphan CAS 对象（计数/列表）、staging 残留、metadata→CAS missing（fail closed）、
CAS→metadata 孤儿（informational）。**自动修复：无**（全部推迟，见 Risk Register R-08/R-09）。

## 11. 幂等与 commandId 绑定（§25 + Boss 收紧 2，冻结）

| identity | 职责 | 禁止混用 |
|---|---|---|
| `commandId` | 业务操作身份 / retry identity | 复用既有 command ledger + UnitOfWork + duplicate-command handling；**不为 S13 建平行幂等系统** |
| `artifactId` | Artifact 业务实体身份 | 不得被 contentHash 替代 |
| `contentHash` | content identity / integrity / CAS 寻址去重 | 不承担 command / business / workflow identity |
| `runId` | provenance 锚点 | — |

### 11.1 commandId 幂等双轨制（Blocker 裁定 = Option B，冻结）

**STEP 1 retention 语义核查（真实代码证据，2026-09-18）**：

| 问题 | 真实答案（证据） |
|---|---|
| 何时 trim | **每次 engine dispatch put 后同步执行**（`engine.ts:491 await ledger.trim(maxLedgerEntries)`）——非后台/定时 |
| 按数量还是时间 | **按数量**：`DELETE … ORDER BY rowid ASC LIMIT excess`（sqlite-command-ledger.ts）——插入序 rowid 为权威（Sprint 3 review LOW-1：不用调用方时钟） |
| 谁触发 | WorkflowEngine dispatch 路径（唯一调用点） |
| 默认 retention | `deps.maxLedgerEntries ?? 1_000`（engine.ts:173） |
| restart 后 | 保留（SQLite durable，Sprint 3 requirement 11） |
| workflow/run close 清理 | **无**——无按 run 清理逻辑 |
| 按 run 分区 | **无**——全局单表，`run_id` 列仅审计用途 |
| tombstone / 永久 identity | **无**——trim 直接 DELETE，不留墓碑 |
| 依赖"trim 后可再执行"的模块 | **无显式依赖**；但窗口内同 key 异内容 → CONFLICT（engine.ts:396-401），**窗口外无任何挡板**（Blocker 的根源） |

**裁定：Option B —— row-level permanent creation identity。**

```text
Command Ledger    = retry/result cache + transactional command record（有界窗口内快速恢复）
Artifact row      = permanent creation identity（窗口外仍可恢复与判重）
```

`artifacts` 表增 `creation_command_id` + `creation_command_fingerprint`（persistence metadata，
非 domain 字段）+ partial unique index（§4.1）。`CreateArtifact(commandId=X)` 成功 ⇒ 同一 UnitOfWork
内写 artifacts 行（含 identity 列）+ 事件 + ledger outcome 快照。

**服务 retry lookup 三级顺序（冻结）**：

```text
① ledger.get(X) 命中 → fingerprint 比对：同 → 返回 outcome.artifactId（duplicate replay）；
                        异 → CONFLICT fail closed
② ledger miss（已 trim）→ SELECT artifacts WHERE creation_command_id = X（unique 至多一行）：
                        命中 → fingerprint 比对：同 → 返回既有 artifactId，不创建第二个；
                              异 → CONFLICT fail closed（行上有 fingerprint，窗口外同样可判）
③ 都 miss → 正常创建（新 artifactId + identity 列落行 + ledger put，同一 UnitOfWork）
```

**五个 Case 的最终答案**：

| Case | 场景 | 结果 |
|---|---|---|
| 1 | row + ledger 都成功 → retry | 任一级命中 → **同一 artifactId**（不创建第二个） |
| 2 | 事务 rollback | row 与 ledger 都不存在（同一 UnitOfWork，原子） |
| 3 | **ledger 后来被 trim → 同 commandId 重试** | ② 级行命中 → fingerprint 同 → **既有 artifactId，永不创建第二个**（permanent idempotency 不依赖 ledger 窗口——Blocker 关闭点）；fingerprint 异 → CONFLICT |
| 4 | intentional re-validation | **新 commandId** → ③ 正常创建 → 新 validationId（append-only）；**禁止** `UNIQUE(artifactId, validatorId)` 类永久阻止（re-validation 语义在 Validation 契约 §6） |
| 5 | same commandId + different fingerprint | **CONFLICT fail closed**——窗口内由 ledger fingerprint（engine.ts:396-401 语义）、窗口外由行上 `creation_command_fingerprint` 判定 |

**为什么 A（bounded 承认）对 immutable evidence 不可接受**：artifact/validation 是 durable 不可变
审计证据——trim 后同 commandId 重试将产生"同一命令两个产物"（同内容不同 id 的两行证据），污染证据层
唯一性；evidence creation 是低频长周期操作，"重试必须落在最近 1000 条命令内"是隐性正确性条件。
Option C（selective permanent retention）被拒：现有 CommandLedgerPort 无 selective 机制，实现需改
Sprint 3 冻结架构且引入无界增长/GC 复杂度。Option B 双轨职责不同、互不重复：ledger 管"快"与
"事务内命令记录"，行 identity 管"永久"——persistence metadata 成本为每行 2 个 TEXT 列 + 1 个
partial unique index（tools 链先例同构）。

## 12. 版本化（§26，冻结）

四类版本区分：Artifact domain schema version（由 migration 链管理，**不进行**）/ Artifact content version
（**无**——immutable）/ Validator implementation version（**复用 Tool Registry identity**，见 Validation 契约）/
Validation contract version（**不加**——domain contract 已冻结、migration 管理 schema、无跨版本反序列化需求）。
**不出现**无语义的 version/revision/schemaVersion/formatVersion/contractVersion 列堆砌。
Logical artifact versioning（v1→v2→v3）不做；未来需求出现再 ADR。

## 13. 测试锚（详见 S13_TEST_STRATEGY.md）

Artifact 侧验收骨架：invariants / immutable 负向（无 update/delete 路径）/ 三重区分（同 hash 双 id、
hash 声明拒绝、CAS mismatch 检测）/ CAS 崩溃 Case A–E / 幂等重试 / staging 崩溃 / trust 负例
（路径遍历、UNC、伪造 hash）/ 启动对账 detect / 边界（Core 不 import fs/SQLite/Electron；Provider/Validator 不触 Store/CAS）。
