# S13 Test Strategy（Sprint 13A Freeze — 本阶段只冻结测试矩阵，不写实现测试）

> 状态：FROZEN（Proposed）。适用对象：Sprint 13B 实现的验收矩阵。
> 纪律沿用 AGENTS.md §4：真实 SQLite + 真实服务行为测试（先例 sprint11/12 套件）；
> 禁止 skip/only/删除测试制造 PASS；测试数量只增不减；边界断言用已修复的
> executable-source guard（`sourceWithoutComments`），禁止注释文本假绿。

## 1. Domain Tests（Core 纯函数层）

| 组 | 必须覆盖 |
|---|---|
| Artifact invariants | createArtifact 全部既有校验（kind/contentRef 非空、hash 格式、sizeBytes 非负）零回归 |
| Artifact immutable semantics | 无任何 API 可变更行；update/delete 路径不存在（负向源码断言 + 类型层不存在） |
| identity 分离 | 同 bytes → 两 id 同 hash 合法；`artifactId ≠ contentHash` 无 API 可混用；contentRef 为 `sha256:<hex>`（适配器解析）与 workspace 路径双形态 |
| Validation invariants | 既有证据门（空口 pass 拒、非零 exitCode pass 拒、fail 带 0 拒）零回归 |
| pass / fail / error / skipped 语义 | 四态逐一；error ≠ fail（validator 自身失败 vs 目标不满足） |
| blocking quality gate | `qualityGatePassed`：无 blocking → false；全部 pass → true |
| non-blocking fail（WARNING） | `fail`+`blocking:false` 不影响门；组合语义锁定测试 |
| evidence addressability | `artifact:<id>` / `command:<name>` 模式；空/畸形拒绝 |

## 2. Artifact Persistence Tests（真实 SQLite + 真实 CAS 目录）

| 组 | 必须覆盖 |
|---|---|
| metadata insert/read | artifacts 行 1:1 落库读回；字段与 Sprint 1 契约一致 |
| CAS write/read | put → contentRef `sha256:<hex>`；get 按行 hash 校验通过 |
| actual-byte SHA-256 verification | caller 自报错误 hash → 以实算为准/拒绝（R-02） |
| same content → same CAS identity | 同 bytes 两次 put → 同 contentRef，存储单份 |
| same content → different Artifact IDs | 两个 artifactId 共享一个 CAS 对象，双方 lookup 均完整 |
| same command retry → no duplicate logical Artifact | command ledger 复用，重试不产新行 |
| **ledger trim scenario（Artifact 侧，STEP 6 必测）** | create with commandId X → durable success → **simulate trim/retention expiry**（`maxLedgerEntries: 2` fixture 先例或直接删 ledger 行）→ retry X → 行级 `creation_command_id` 命中 → fingerprint 同 → 返回既有 artifactId（**不创建第二个**）；fingerprint 异 → CONFLICT fail closed——行为精确匹配契约（Option B 双轨制，ADR-0015 决策 15） |
| invalid hash claim rejected | 非 64 hex / 大写 / 短哈希声明拒绝 |
| missing CAS content detected | 行在、CAS 缺 → integrity fail（Case B，fail closed） |
| CAS hash mismatch detected | CAS 对象字节被改 → verify 失败（fail closed） |
| duplicate CAS write safe | Case D：重复 put 复用已有对象、integrity 验证、**不静默覆盖**（Windows rename 实证：覆盖会成功，见 ADR-0015 §8） |
| **concurrent publication（no-clobber）** | **Writer A + Writer B，同 contentHash，并发 publish**：最终只有合法完整对象、不覆盖、无 partial final object、两个调用都得到正确结果（机制由 13B 实测择定——exclusive-create / hard-link / COPYFILE_EXCL 等） |
| **existing target mismatch fail closed** | 已发布 target 内容不符期望 hash → fail closed，不覆盖不修复 |
| temp/staging file crash handling | staging 命名可识别；启动 detect（Case C） |

## 3. Validation Persistence Tests

| 组 | 必须覆盖 |
|---|---|
| durable insert/read | validations 行 1:1 落库读回 |
| same command retry | 同 commandId 重试 → 无新行/无第二组（ledger 语义） |
| **targetRef binding（ADR-0017）** | record/get/listByRun/getByCreationCommand 全 round-trip 保留 targetRef；**listByTargetRef 返回精确属于该 Artifact 的 validations（deterministic）**；same run + 同 validator + Artifact A/B 仍可区分；mixed targetRef batch → VALIDATION_BATCH_TARGET_MISMATCH fail closed；legacy targetRef=null 可重建但 ≠ targeted evidence（永不入 target 查询） |
| **commandId→validationId durable binding** | RunValidation 成功 → 行组携带 `creation_command_id/fingerprint` + ledger outcome 含整组 validationId；**同 UnitOfWork**；崩溃后同 commandId retry → 恢复同一组 validationId，不产生第二组 |
| **ledger trim scenario（Validation 侧，STEP 6 必测）** | RunValidation with commandId Y → durable success → simulate trim → retry Y → 行组按 `creation_command_id` 命中 → fingerprint 同 → 返回既有组（不产生第二组）；fingerprint 异 → CONFLICT fail closed——行为精确匹配契约（Option B 双轨制，ADR-0016 决策 13） |
| **same commandId + different fingerprint** | 窗口内（ledger 命中）与窗口外（行 fingerprint 判定）两条路径都 CONFLICT fail closed |
| intentional re-validation | 新 commandId → 新 durable evidence 成功；**无 UNIQUE(artifactId, validatorId) 阻止** |
| target Artifact existence | evidence 指向不存在 artifact → 拒绝（杜绝悬空引用） |
| validator identity / version | validatorId 解析 + validatorVersion 来自 Tool Registry 记录 |
| evidence references | 可寻址格式校验延续到持久化层 |
| report artifact materialization path | ReportArtifactDescriptor → ValidationService → ArtifactService 唯一路径；Validator 绕过路径不存在 |

## 4. Workflow Tests（L1 集成）

| 组 | 必须覆盖 |
|---|---|
| enter VALIDATING | REVIEW_PASSED → VALIDATING（既有转移真实到达） |
| required blocking PASS | 全部 blocking pass → guard 放行 → FINALIZING |
| blocking FAIL | → VALIDATION_FAILED → REWORK（返工预算管辖） |
| non-blocking fail / warning | 不阻断，仅记录 |
| ERROR | 不放行 |
| skipped | 不计入门 |
| missing validator evidence | stage 要求的 validator 无 durable Validation → 拒绝 |
| evidence from wrong Artifact / wrong Run / wrong validator | 三类错绑全部拒绝 |
| duplicate evidence | 同 evidence 重复提交不产生重复门效应 |
| caller-declared pass rejected | 请求体自报 status=pass 不被信任 |

## 5. VALIDATION_PASSED Guard Tests（正负例矩阵）

**Positive**：当前 Artifact 所需 blocking validators 全部 durable PASS → transition allowed。

**Negative（每条 → transition rejected）**：

```text
no durable validation（无任何证据）
wrong Artifact（证据绑其它 artifact）
wrong Run（跨 run 证据）
missing required validator（stage 声明的 validator 缺验证）
blocking FAIL
ERROR
forged status（请求声明 pass 但 durable 行非 pass）
stale evidence（validationId 不存在于当前 run 上下文）
```

## 6. Boundary Tests（executable-source guard + 行为断言）

| 断言 |
|---|
| Renderer cannot choose CAS physical path（IPC 层拒绝路径类字段） |
| Renderer cannot declare Validation PASS |
| Provider cannot write ArtifactStore / CAS（源码级：provider 适配器无 Store/CAS import 通道） |
| Validator cannot write ArtifactStore directly / cannot write CAS directly / cannot transition Workflow |
| Persistence cannot decide quality policy（persistence 包无 blocking/transition 决策代码） |
| **ArtifactStore is persistence port only**（store 适配器无 lifecycle/provenance/validation policy 代码——策略只存在于 ArtifactService/ValidationService） |
| **legacy opaque refs cannot enter managed CAS write path**（workspace/路径类 ref 作为 create 输入 → 拒绝；仅 read compatibility 放行） |
| Core imports no fs / no SQLite / no Electron（既有 guardrails 延续 + 新 ports 文件纳入扫描） |

## 7. Recovery Tests

| 组 | 必须覆盖 |
|---|---|
| CAS final object created + DB rollback | Case A：orphan 产生、lookup 不可达、启动对账 detect+report |
| staging file left after crash | Case C：detect |
| SQLite metadata → missing CAS | Case B：fail closed + Validation 不允许 PASS + Workflow 不当有效 evidence |
| retry Artifact creation | 崩溃后重试同 command → 幂等完成（不重复行、CAS 复用） |
| retry Validation creation | 同上（Validation 侧） |
| startup reconciliation detects orphan / dangling reference | 两类报告均可观测（S13 只 report 不 auto-delete） |

## 8. Security Negative Tests

| 组 | 必须覆盖 |
|---|---|
| `../` traversal / `..\` traversal / absolute Windows path / UNC path | contentRef/路径类输入全部拒绝（R-01/R-07） |
| malformed contentRef | 非 sha256 格式且非注册 root 内路径 → 拒绝 |
| forged contentHash | 实算不符 → 拒绝（R-02） |
| unknown validator / unauthorized validator | 未注册 capability / 无 authority → 拒绝（R-03） |
| oversized input / malformed JSON / deeply nested JSON | 资源耗尽类防护（R-10/R-11；上限沿用既有 IPC 传输上限先例） |
| stale Artifact reference / wrong-run evidence | R-08 错绑复用拒绝 |

## 9. Migration Integrity Tests（13B 实现时）

fresh DB → 全 12 链应用；existing Sprint 12 DB → artifact 链恰好应用一次；checksum 校验；
重启 retry 不重复应用；迁移顺序稳定；artifacts/validations 表存在；expected-chains（11→12）
负向 mutation 验证（删 `'artifact'` → 组合根守卫红）。

## 10. 规模纪律

基线 97 文件 / 972 用例只增不减；新增套件建议落位 `tests/sprint13/`（行为级）+
`packages/core/tests`/`packages/persistence/tests`（域与适配器级）+ 边界测试进既有
`sprint5/8/9` 式组合根断言文件（expected-chains 复用）。零既有测试删除。
