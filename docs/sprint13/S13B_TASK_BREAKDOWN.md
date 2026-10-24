# Sprint 13B Task Breakdown（Sprint 13A 冻结产物 — 只分解，不执行）

> 状态：FROZEN（Proposed）。按最终依赖图排序（非机械照抄 §35 示例）；
> 每个 Task 足够小、可独立 review/验证、不跨过多 trust boundaries、有回滚策略。
> **禁止在本阶段执行任何 Task-13-XX。**

## 依赖图

```text
T01 Domain reconciliation
  ├─ T02 Migration #12 + SQLite stores ──┐
  ├─ T03 Filesystem CAS ─────────────────┤
  │                                      ├─ T04 ArtifactService（需 T02+T03）
  └─ T05 Validator registration/resolution（需 T01）
                                          ├─ T06 ValidationService（需 T04+T05）
                                          ├─ T07 Evidence guard（需 T06）
T08 Memory provenance（需 T02 存在性校验面）
T09 Agent/Tool/Handoff/Decision reference integration（需 T04/T06）
T10 Startup reconciliation / integrity diagnostics（需 T02+T03）
T11 Desktop composition wiring（需 T04/T06/T10）
T12 Full regression + closeout（全部）
```

---

### Task-13-01 Domain/contract reconciliation（**已完成：commit 946ecc5 + corrective e4c61e6**）
- **Goal**：Core 增加 `ArtifactStorePort`/`ValidationStorePort`/`ReportArtifactDescriptor`；`MEMORY_SOURCE_TYPES` +`ARTIFACT`。
- **Why**：全部后续任务的契约前置；纯类型零行为。
- **Scope**：core ports + memory 闭集 +导出。**Out of scope**：任何实现/适配器。
- **Dependencies**：无。 **Files**：`packages/core/src/ports/artifact.ts`、`ports/validation.ts`、`domain/memory.ts`、index 导出。
- **Acceptance**：typecheck/lint/boundaries 绿；既有测试零改动全绿；词表测试仍绿。
- **Required Tests**：ports-frozen 套件增补；memory 闭集测试增补（ARTIFACT 接受、未知仍拒）。
- **Security**：无新攻击面（纯类型）。 **Failure/Recovery**：纯加法，revert commit 即回滚。
- **Gate**：`pnpm check` 5×PASS。

### Task-13-02 Migration #12 + SQLite stores（**已完成：commit 4ca0714 + corrective 0002/ADR-0017**）
- **Goal**：`migrations/artifact/0001_artifact_validation.sql`（artifacts+validations，DDL 按冻结草案，**两表各含 permanent creation identity 列对 `creation_command_id`+`creation_command_fingerprint` 及 partial unique index**——artifacts 按 `creation_command_id`、validations 按 `(creation_command_id, validator_id)`，`WHERE creation_command_id IS NOT NULL`，tools 链先例同构）+ **`0002_validation_target_ref.sql`（ADR-0017 corrective：validations 增 nullable `target_ref` + `idx_validations_target`）** + 两个 SQLite store 适配器（含 `listByTargetRef`）+ 链注册。
- **Why**：durable 层地基；row-level permanent creation identity（Option B）的载体。
- **Scope**：persistence 包 + `expected-chains.ts`（11→12，一行）。**Out of scope**：CAS、服务层、组合根。**仍只有两张表**（Option B 不加第三张）。
- **Dependencies**：T01。 **Files**：`packages/persistence/migrations/artifact/0001_*.sql`、`src/durable/sqlite-artifact-store.ts`、`sqlite-validation-store.ts`、`durable/index.ts`、`tests/shared/expected-chains.ts`。
- **Acceptance**：既有 11 链 checksum 不动（测试锁定）；新链 opt-in；未启用时 store 显式失败；partial unique index 生效（同 commandId 二次插入 → UNIQUE 冲突可被服务层翻译）。
- **Required Tests**：migration integrity（fresh/存量 DB/checksum/重试）；store insert/read；跨链无 FK 断言；creation-identity 列写入/读回。
- **Security**：DDL CHECK 约束按冻结草案，不得放宽。 **Failure/Recovery**：迁移失败 → 打开失败（既有 fail-closed）；回滚 = revert（新链从未上生产）。
- **Gate**：`pnpm check` + 组合根守卫负向 mutation（删 `'artifact'` → 红）。

### Task-13-03 Filesystem CAS（ArtifactContentStore）（**已完成：commit 69da23f + publication corrective 5c685a1（hard-link no-clobber）**）
- **Goal**：CAS 适配器：staging（write temp→实算 sha256→verify）→ **race-safe no-clobber final publication**（MUST NOT overwrite 已发布对象；目标已存在→verify hash→match=reuse/mismatch=fail closed）→ get（hash 校验）→ verify。primitive（exclusive-create / hard-link publish / COPYFILE_EXCL / 其它 Node v24+NTFS 适用机制）**在本 Task 实测择定**（ADR-0015 决策 13 禁止 13A 凭理论指定）。
- **Why**：内容真相层；崩溃模型与 TOCTOU 防护的前提。
- **Scope**：persistence 适配器。**Out of scope**：ArtifactService、IPC、UI。
- **Dependencies**：T01。 **Files**：`packages/persistence/src/content/cas-store.ts` + tests。
- **Acceptance**：实算 hash（伪造 hash 拒）；重复 put 幂等复用不覆盖；staging 命名可识别；**no-clobber publication 通过 Windows 实机并发 publication test**。
- **Required Tests**：TEST_STRATEGY §2 CAS 组 + **Windows 实机并发 publication test（Writer A+B 同 contentHash 并发 publish → 只有合法完整对象、不覆盖、无 partial final object、两个调用都得到正确结果；已有 target 内容不符期望 hash → fail closed）** + §8 路径负例（`../`、UNC、盘符、`file://`）。
- **Security**：R-01/R-02/R-14（TOCTOU）/R-15 主战场（symlink/junction 检测）。 **Failure/Recovery**：Case C/D 行为；orphan 无害。
- **Gate**：`pnpm check`。

### Task-13-04 ArtifactService + command idempotency（**已完成：commit c455262 + authorization corrective 225506b（deny 覆盖 replay 全路径）**）
- **Goal**：engine 服务：create（content→row→event 同 UnitOfWork）/get/listByRun/listByHash；commandId 幂等 = **双轨三级 lookup**（① ledger outcome 快照 → ② 行级 `creation_command_id` 命中（trim 后）→ ③ 新建；fingerprint 异常 CONFLICT fail closed）。
- **Why**：唯一物化入口（Validator/Agent/Provider 输出都经它）；permanent idempotency 执行点。
- **Scope**：engine + authorities +4 中 artifact.* 的执行点。**Out of scope**：validation、组合根。
- **Dependencies**：T02+T03。 **Files**：`packages/engine/src/artifact/artifact-service.ts`、`role-authority.ts`、事件发射方改指。
- **Acceptance**：`artifact.created` durable 落库且白名单 payload；**commandId→artifactId durable idempotency proof**：CreateArtifact 成功后行上 identity 列 + ledger outcome 均含 artifactId，row+event+ledger 同一 UnitOfWork；**ledger trim 后同 commandId retry → 行级命中返回既有 artifactId，不创建第二个**；同 key 异 fingerprint → CONFLICT（ADR-0015 决策 15，Case 1–5）。
- **Required Tests**：TEST_STRATEGY §2 重试组 + **ledger trim scenario** + §10 审计脱敏断言。
- **Security**：R-02/R-05 执行点；authority 检查拒绝时零写入。
- **Failure/Recovery**：Case A/B/E 语义；事务回滚无半行。
- **Gate**：`pnpm check`。

### Task-13-05 Validator registration/resolution（**已完成：commit 43636dc**；TOOL_CAPABILITY_VALIDATOR + createValidatorResolver）
- **Goal**：validator capability 声明面 + 解析器（validatorId → Tool Registry 记录 + validatorVersion 填充）；capability 过滤 fail closed。
- **Why**："不是所有 Tool 自动是 Validator"的强制点。
- **Scope**：engine registry 层。**Out of scope**：具体 Pack validator、执行编排。
- **Dependencies**：T01。 **Files**：`packages/engine/src/validation/validator-resolver.ts`、tool registry capability 字段。
- **Acceptance**：未声明 capability 的 Tool 被 validatorIds 引用即拒；version 从 Tool 记录填充。
- **Required Tests**：§3 identity 组 + §8 unknown/unauthorized validator 负例。
- **Security**：R-03 主战场。 **Failure/Recovery**：解析失败 = 无执行，无持久化副作用。
- **Gate**：`pnpm check`。

### Task-13-06 ValidationService + durable records（**已完成：commit 9048583 + ADR-0018 corrective 86bcf1e（durable replay output）+ ADR-0019 corrective 8d48728（version provenance）+ legacy approval corrective 11a78e4（WAITING null 版本 fail-closed）+ 3d80e15（chore 清理）**；含两项实现澄清——① Sprint 9 WAITING_APPROVAL 以 err(APPROVAL_REQUIRED) 返回，ValidationService 穿透为整命令 APPROVAL_REQUIRED/零写入，approve 后 retry 经幂等 key 复用 invocation；② 已报告 architecture gap：Sprint 9 durable invocation 只存 output digest，replay output=null ⇒ crash-retry 的 verdict 不可恢复，service 对该场景 fail-closed（VALIDATION_VERDICT_UNRECOVERABLE，零写入），待 Boss 裁定）
- **Goal**：编排：resolve → 逐 validator 执行（命令型走 Tool Registry）→ 报告物化（经 ArtifactService）→ Validation 行组 + 事件（**行组同一 UnitOfWork**：一次 RunValidation 的 N 个 validator 行 + 事件 + ledger outcome 同事务）。
- **Why**：V-04/V-08 的核心兑现；permanent idempotency 执行点。
- **Dependencies**：T04+T05。 **Files**：`packages/engine/src/validation/validation-service.ts`、authorities validation.* 执行点。
- **Acceptance**：same-command retry 无第二组；intentional re-validation（新 commandId）成功；error/fail 区分落库；**commandId→validationIds durable idempotency proof（双轨）**：行组携带 `creation_command_id/fingerprint` + ledger outcome 含整组 validationIds；**ledger trim 后同 commandId retry → 行组命中返回既有 validationIds，不产生第二组**；同 key 异 fingerprint → CONFLICT（ADR-0016 决策 13，Case 1–5）。
- **Required Tests**：§3 全组（含 ledger trim scenario）+ §4 workflow 前置组。
- **Security**：R-06/R-08 执行点（status 只来自 durable；evidence 绑定校验）。
- **Failure/Recovery**：单 validator 失败不回滚其他证据；崩溃后按双轨幂等恢复（ledger → 行组）。
- **Gate**：`pnpm check`。

### Task-13-07 VALIDATION_PASSED evidence guard（**已完成：commit ccb4d0f + ADR-0020**）
- **Goal**：引擎命令载荷守卫：11 项证据校验（WORKFLOW_INTEGRATION §3），拒绝即 `VALIDATION_FAILED`/`INVALID_ARGUMENT`。
- **Why**：R-06 的最后防线；L1 转移唯一新增点。
- **Dependencies**：T06。 **Files**：`packages/engine/src/engine.ts`（载荷校验扩展）+ evidence resolver。
- **Acceptance**：正例放行 + 8 类负例全拒（no evidence/wrong artifact/wrong run/missing validator/blocking fail/ERROR/forged status/stale）；纯 Core 状态机不新增 SQL 查询（resolver 在 App/Engine 服务层）。
- **Required Tests**：§5 正负矩阵全量。
- **Security**：guard 是信任边界终点。 **Failure/Recovery**：拒绝零写入。
- **Gate**：`pnpm check` + 既有 run 全套零回归。

### Task-13-08 Memory provenance integration（**已完成：commit 008ede4**；verifyArtifactMemoryProvenance / verifyValidationMemoryProvenance + main.ts 两个 verifier 分支；store null → fail closed，T11 接链后自动生效）
- **Goal**：组合根 verifier +2 分支（ARTIFACT/VALIDATION 存在性校验，VERIFIED 门）。
- **Dependencies**：T02。 **Files**：`apps/desktop/src/main.ts` verifier 分支（或其抽取模块）。
- **Acceptance**：指向存在对象 → VERIFIED；悬空 → 拒绝；Memory content/写语义零变化。
- **Required Tests**：§7 recovery 组 provenance 部分 + Sprint 12 A–AZ 零回归。
- **Security**：R-13 悬空引用防护。 **Failure/Recovery**：拒绝不落库。 **Gate**：`pnpm check`。

### Task-13-09 Agent/Tool/Handoff/Decision reference integration（**已完成：commit 7649012 + write-path integration corrective 2c4549a**）
- **Goal**：执行/调用产物经 ArtifactService 物化并回填真实 artifactId；引用消费侧存在性校验。
- **Dependencies**：T04/T06。 **Files**：engine runtime/tools 调用侧（App 层）、handoff/decision 引用消费校验。
- **Acceptance**：Provider/Tool 输出不自动物化（App 层显式决定）；handoff artifact ref 指向存在对象。
- **Required Tests**：§6 边界组（Provider 不触 Store/CAS）+ 引用校验正负例。
- **Security**：R-17/R-13。 **Failure/Recovery**：物化失败 → 执行记录保持引用为空/原状，不半写。
- **Gate**：`pnpm check`。

### Task-13-10 Startup reconciliation / integrity diagnostics（**已完成：commit 74ea764 + corrective 5358dbb（diagnostics 导出补齐）+ f6c730c（symlink/reparse 遍历拒绝）；detect/report only（PATH 2 裁定）**）
- **Goal**：启动 detect+report：orphan CAS、staging 残留、metadata→CAS missing（fail closed）、CAS→metadata 孤儿。**无自动修复/删除。**
- **Dependencies**：T02+T03。 **Files**：persistence 诊断模块 + 组合根启动调用（先例：router 对账）。
- **Acceptance**：四类可观测（结构化日志/诊断事件）；Case B fail closed。
- **Required Tests**：§7 recovery 全组。
- **Security**：R-04/R-09/R-19；诊断不含内容正文。 **Failure/Recovery**：对账自身失败不阻塞启动（先例 router 对账容错），但 Case B 必须阻断使用。
- **Gate**：`pnpm check`。

### Task-13-11 Desktop composition wiring（**已完成：commit fd78aac + IPC boundary corrective 57eaabe（Sprint 13 服务保持 main-process 内部能力，四个 renderer IPC op 移除）+ read-authority reconciliation 0d79b54（CASE C：read 两项为 catalog reservation）**）
- **Goal**：组合根装配新服务 + chains +`artifact`（第 12 链）+ expected-chains 同步 + 新服务 IPC operation 白名单（artifact.create/read、validation.record/read 等，经既有 workflow 单通道）。
- **Dependencies**：T04/T06/T10。 **Files**：`apps/desktop/src/main.ts`、`workflows.ts`、`tests/shared/expected-chains.ts`。
- **Acceptance**：单 durable 句柄 12 链；组合根无业务策略；IPC schema 校验全覆盖；守卫负向 mutation 红。
- **Required Tests**：§6 边界 + 组合根接线断言（真实 executable source guard）+ **security negative：legacy opaque refs（workspace/路径类）作为 managed create 输入必须拒绝（不得进入 managed CAS write path）** + **boundary：ArtifactStore 只是 persistence port（适配器无 lifecycle/provenance/validation policy 代码）**。
- **Security**：Renderer 不可指定路径/自报 PASS（IPC 层拒绝）。 **Failure/Recovery**：wiring 缺失 → 服务显式失败（先例 main.ts:441）。
- **Gate**：`pnpm check`。

### Task-13-12 Full regression + closeout（**已完成：SPRINT13_CLOSEOUT.md；全量门禁 5×PASS、112 文件/1224 用例全绿、空库 12 链迁移验证、tag sprint-13.0.0**）
- **Goal**：全量门禁 + 迁移 integrity + 独立评审 + PROJECT_HANDOFF/roadmap 状态更新 + tag 流程。
- **Dependencies**：全部。 **Gate**：DoD 四项 + Independent Review（BLOCKER 0/HIGH 0）+ 测试规模只增不减。

## Task 设计原则核查

每个 Task：单一 trust boundary 层次（T01 纯类型 / T02-T03 持久化 / T04-T07 服务 / T08-T11 接线）；
独立可 review；失败回滚 = revert 该 commit（无跨任务半状态）；Sprint 0–12 冻结面零触碰
（T07 是既有载荷校验扩展点，非引擎重写）。
