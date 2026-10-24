# S15 Test Strategy（Sprint 15 测试矩阵冻结 — Task-15-01）

> 状态：**FROZEN**（Accepted：`TASK-15-01 APPROVED` 指令 §75，2026-09-26）。
> 本文只定义**未来**测试矩阵（T15-02+ 实现）；Task-15-01 零测试代码。
> 先例：`S13_TEST_STRATEGY.md` / `S14_TEST_STRATEGY.md`；真实对象图（真实 SQLite + 组合模块）为默认形态；
> 测试 fixture 一律 industry-neutral（如 `pack.fixture`），不创建真实行业 Pack。

## A. Manifest / 契约（T15-02）

| # | 场景 | 关键断言 |
|---|---|---|
| A1 | canonical manifest conformance（Core ↔ Contracts 一一对应） | Core accepts ⇔ Contracts accepts；无双命名泄漏 |
| A2 | 九类声明全部可解析 | 每类独立解析 + 组合解析 |
| A3 | unknown field handling | 未知字段拒绝/忽略语义按冻结契约；不静默吞 |
| A4 | invalid manifest | 结构/类型/pattern 违例 fail closed（untrusted 边界） |
| A5 | same (packId, packVersion) different canonical content | CONFLICT；不 silently replace |
| A7 | manifestFingerprint 格式 | qualified SHA-256 ref `^sha256:[0-9a-f]{64}$`；裸 hex 拒绝（NO dual compatibility）；等价语义/键序/legacy alias 同指纹；语义/数组序变更异指纹 |
| A6 | Generic Templates 契约 | **已实现**：Boss OPTION 2 最小契约（TASK-15-02 裁定，非规划书）；key/kind/内容 JSON 安全/未知字段拒绝/元数据不加 |

## B. 安装/生命周期（T15-03/04）

| # | 场景 | 关键断言 |
|---|---|---|
| B1 | install idempotency | 同命令同 fingerprint → 同结果零重复行 |
| B2 | dependency missing | install/enable fail closed（零物化） |
| B3 | dependency cycle | reject |
| B4 | exact-version dependency | 无 range 解析；版本不匹配即失败 |
| B5 | transitive closure | 全闭包验证（非仅第一层） |
| B6 | conflict detection | 同 logical key ⇒ CONFLICT，无 last-writer-wins |
| B7 | single active version | companyId+packId 至多一个 installed |
| B8 | partial install rollback / fail-closed | 预检失败零可见性；UoW all-or-nothing |
| B9 | disable | live capability 消失（无新 selection/catalog/role/materialization） |
| B10 | re-enable | 完整重验证通过才可用 |
| B11 | upgrade v1→v2 | v2 供未来解析；v1 disabled 且历史可寻址 |

## C. 租户与安全（T15-04/06）

| # | 场景 | 关键断言 |
|---|---|---|
| C1 | company isolation | Company A install/disable 不影响 B |
| C2 | Pack cannot create authority | authority 名 ∉ AUTHORITIES ⇒ 拒 |
| C3 | Pack cannot assign owner/roles | 安装本身零 assignment |
| C4 | Pack cannot execute code | DATA-ONLY 结构锁（无动态加载面） |
| C5 | Tool requirements do not install adapters | 仅存在性验证；registry 门禁全保留 |
| C6 | Provider requirement vendor-neutral | vendor 名拒；logical capability 才合法 |
| C7 | pack.manage 授权执行点 | 未授权 actor 拒；manage 不越权 |

## D. Run Pinning / 可复现（T15-05/06）

| # | 场景 | 关键断言 |
|---|---|---|
| D1 | run pack pinning | 创建时写入 used-pack 传递闭包（非全部 enabled） |
| D2 | transitive dependency pinning | 闭包内依赖版本一并固定 |
| D3 | pack disabled after Run creation | Run 继续按 pin 执行/恢复，不失败不重解析 |
| D4 | old Run reproducibility（升级后） | 旧 pin + 历史 provenance 解释；不自动变 v2 |
| D5 | no current-Pack lookup during recovery | 恢复路径零 PackInstallation 读取 |
| D6 | legacy packless workflow | 无 Pack 的模板/Run 完全不受影响（一等公民） |
| D7 | EvidenceGuard 独立 | gate 只读 run-pinned WorkflowVersion |

## E. 审计与卸载语义（T15-06）

| # | 场景 | 关键断言 |
|---|---|---|
| E1 | live capability disappearance after disable | AC15.3 no-live-residue |
| E2 | historical audit retained | Run/Event/Artifact/Validation/Tool/Pack provenance 全保留 |
| E3 | 事件词汇 | 仅冻结候选（pack.installed/disabled 等）；未冻结不新增 |

## 持久化链（T15-03 已实现）

`packages/persistence/tests/pack-persistence.test.ts`（25 项）：fresh DB 建三表/索引、Sprint14
schema 升级不重复应用、Manifest/fingerprint qualified 往返、同 identity 同 fingerprint 幂等、
同 identity 异 fingerprint CONFLICT 不覆盖、损坏 manifest / 损坏 fingerprint 读 fail closed、
安装缺 PackVersion fail closed、creation command 永久身份（同命令同指纹 replay / 异指纹
CONFLICT）、(company,pack,version) 唯一、one-enabled partial index、v1 disabled→v2 installed
同 UoW 升级序列、Company A/B 隔离与 disable 不影响、两态闭集、PackContentRef 往返 + nullable
materialized + duplicate 拒 + company 隔离、三 store 同 UoW 提交/回滚、结构锁（无 DELETE/DROP
语句 / 无授权面）。

## 执行点矩阵（T15-04 已实现）

`tests/sprint15/pack-service.test.ts`（29 项；真实 SQLite pack chain + 真实 authorization/lifecycle/tool
registry，一个行业中立 fixture 携带**全部九类**声明）：

- **授权与租户**：`pack.manage` 授权 install 成功；未授权 ⇒ PERMISSION_DENIED 且零写入；
  跨公司 ⇒ `PACK_COMPANY_SCOPE_DENIED`；同一 PackVersion 跨公司复用（1 行 PackVersion / 2 行安装）。
- **九类 happy path**：一 installation + 九条 contentRef（kind 闭集全覆盖）；role/template 经既有服务
  物化（真实实体 id）；pack-native（prompt/tool/validator/artifactType/riskRule/capabilityRule/template）
  `materializedEntityRef = null`；安装绝不分配用户（唯一 assignment = bootstrap owner）；`pack.installed` 事件。
- **依赖**：传递闭包 A→B→C 全链验证；缺依赖（精确版本在他公司已装而本公司未装）⇒
  `PACK_DEPENDENCY_MISSING` 零写入；版本不匹配不当 range 匹配；自依赖在 canonical manifest 阶段即拒；
  durable 环（仅 stores 可构造）⇒ `PACK_DEPENDENCY_CYCLE`（候选含入图）；disabled 依赖不可用，
  重新 enable 后恢复。
- **preflight 零写入**：tool 未注册 ⇒ `PACK_TOOL_MISSING`；validator 缺 `validation:validator` ⇒
  `PACK_VALIDATOR_MISSING`；未知 authority 在 manifest 阶段拒；外来命名空间 capability 在 manifest 阶段拒；
  role key 与既有角色冲突 ⇒ `PACK_ROLE_CONFLICT`（无 last-writer-wins）。
- **永久幂等（S13 模式）**：同命令同指纹重放零重复；同命令异 manifest ⇒
  `PACK_COMMAND_FINGERPRINT_CONFLICT`；ledger 裁剪后仍按永久身份重放；同 tuple 异命令返回既有安装；
  same-tuple 异内容 ⇒ `PACK_VERSION_CONFLICT`（零改写）。
- **disable/enable/upgrade**：disable 保留全部 durable 事实并停 live availability；被已装 pack 依赖 ⇒
  `PACK_DEPENDENCY_IN_USE`；enable 重新验证且不重复物化；upgrade v1→v2 同 UoW 原子（v2 installed /
  v1 disabled / 单 enabled），被依赖的旧版拒绝升级；upgrade 重放幂等（单 `pack.upgraded` 事件）。
- **边界结构锁**：`pack.manage` 仍是唯一 pack authority（无新增 authority）；PackService 源码无 raw SQL /
  无 DELETE/DROP / 无动态代码 / 无 electron/IPC；participant 失败整装回滚（零 installation/ref/version/
  template，仅存 bootstrap owner，且无 `pack.installed` 事件）；packless 工作流不受影响。

## Disable live-capability corrective（T15-04 corrective — PACK_LIVE_CAPABILITY_DISABLE_GAP）

`tests/sprint15/pack-service.test.ts` corrective 矩阵（5 项；fixture 以生产组合方式注入共享
availability policy，并持有 guarded authorization / lifecycle 直调入口）：

- **Role direct new-use**：installed 时直调 `authz.assign` 成功；disable 后直调（绕开
  PackService）=> POLICY_DENIED + `PACK_MATERIALIZED_CONTENT_UNAVAILABLE`（不含他公司详情）；
  角色行与既有 assignment 仍可读；re-enable 后恢复可分配且 0 重复角色、0 重复 contentRef。
- **Shared role（v1 disabled + v2 installed）**：upgrade 复用同一物化 Role；v1 已 disabled 但
  v2 为 live owner => 仍可分配；v2 也 disable => 新分配被拒（any-live-owner）。
- **Workflow every new-use API**：disable 后 `saveDraftGraph` / `publishRevision` / `fork` /
  `createRun` 全部拒绝；`readTemplate` / `readSnapshot` / run 行 / version 行保留；既有 Run
  的 snapshot 仍可读且 `packVersions` 仍为 `{}`（未提前实现 T15-05）。
- **Company scope**：company_default disable 不影响 company_other 的同类内容；非 Pack 角色
  在公司内永不拦截。
- **Provenance immutable**：disable 不删/不改任何 contentRef 或 PackVersion；事件仅
  `pack.installed` + `pack.disabled`；tool requirement 不停用全局 Tool；pack 迁移仍只有
  `0001_pack_persistence.sql`（无新 migration）。

## Run Pack Pinning（T15-05 — ADR-0027）

`tests/sprint15/pack-run-pinning.test.ts`（23 项；真实 SQLite + 真实 PackService / availability
policy / provenance resolver / lifecycle，计数 spy 包住 resolver）：

- **pinning basics**：packless 模板 ⇒ `{}`；单 Pack ⇒ exact 版本；root + 直接依赖；传递闭包
  A→B→C；按 packId 确定性排序（DB 行 JSON 键序一致）；每新 Run 恰好一次解析。
- **live-owner 语义**：disabled 历史 owner 不成为新 Run provenance；多 live owner 全部 pin
  （不随机选）；公司域隔离（错公司查询 ⇒ 无 owner ⇒ `{}`）。
- **fail closed**：依赖缺失（stores 构造的损坏态）⇒ `PACK_DEPENDENCY_MISSING` 且 0 Run /
  0 RunSnapshot；durable cycle ⇒ `PACK_DEPENDENCY_CYCLE` 同样零写入。
- **caller authority**：`CreateRunInput` 已无 `packVersions` 字段（`@ts-expect-error`
  编译期证据）+ 源码结构断言 `input.packVersions` 不存在；resolver 值是唯一权威。
- **immutability / upgrade / disable**：R1 在 v1；升级后 R2 得 v2、R1 不变；disable 后 R1
  不变且新 Run 被 `POLICY_DENIED` 拒绝；依赖版本随升级保留（R1 a1/b1、R2 a2/b2）；真实 DB
  close/reopen 后 snapshot 原样恢复；升级+停用后 `pack_versions_json` 字节不变。
- **runtime / recovery 独立性**：StartupRecoveryOrchestrator 运行后 resolver 调用数不变；
  引擎 drive 既有 Run 后调用数仍不变（engine 无 pack 依赖）；EvidenceGuard 以 run-pinned
  WorkflowVersion 为权威——缺证据被拒、真实证据通过，且升级+停用后判定不变。
- **边界**：pack 迁移仍只有 `0001_pack_persistence.sql`；无新 authority / IPC / renderer；
  pack 源码无 UPDATE/DELETE（快照永不被改写）；Tool/Artifact provenance 不受影响。

## Industry Pack Framework E2E（T15-06）

`tests/sprint15/industry-pack-framework-e2e.test.ts`（26 项；全部真实 infra：SQLite + 迁移 +
pack stores + UoW + authorization + PackService + lifecycle + ToolRegistry + EventStore +
availability policy + run provenance resolver；仅 mock 外部 provider 行为）：

- **Scenario A**：foundation→fixture 依赖链安装；九类声明 → 九 refs（role/template 真实实体
  ref、七类 null ref）；Generic Template JSON 持久化；tool requirement 零 ToolRecord/零 adapter/
  零执行；真实 provider/model 注册共存且 vendor 字段被 manifest 拒绝。
- **Scenario B**：缺依赖 / 未知 authority / validator 缺 capability / 无 `pack.manage` 四类
  mutation / 跨公司 mutation —— 全部 fail closed 且零 durable 写入；含 `pack.manage` 的 pack role
  不自动分配；durable cycle 无栈溢出。
- **Scenario C**：disable 后直调五个 new-use 入口全部 `POLICY_DENIED`；历史读与全部 durable 事实
  保留；re-enable 零重复物化且 new-use 恢复；依赖在用拒绝 disable；disabled  dependency 不能
  支撑安装。
- **Scenario D**：R1=v1、R2=v2、v1 保留 disabled、one-enabled 不变式；role 跨版本复用（同实体、
  any-live-owner）与改写冲突（`PACK_ROLE_CONFLICT`）；upgrade 原子（participant 失败 ⇒ v1 不动）；
  跨进程重放 / 命令冲突 / PackVersion 身份冲突 / 同版本跨公司共享一行。
- **Scenario E**：真实 close/reopen + fresh graph；snapshot 精确恢复；disable 后 recovery 与
  engine drive 的 resolver 调用为 0；EvidenceGuard 双半；corrupt `canonical_manifest_json`
  ⇒ 新 Run fail closed、既有 Run 不重读；同 packId 两版本 root ⇒ `PACK_MULTIPLE_INSTALLED_VERSIONS`。
- **Scenario F**：packless 工作流 `{}` + advance/recovery 正常；结构锁（动态代码/loader/
  marketplace/vendor/新 authority/IPC/renderer/新 migration）；事件四词汇仅真实变化、重放不重复、
  payload 白名单（无 manifest 正文/prompt/template 内容）；fresh DB 全迁移 + pack 链可用。

## F. 回归

全部既有套件只增不减（Sprint 14 收口基线 116 files / 1258 cases 为下限；T15-04 后 **120 files /
1333 cases**）；`pnpm check` 5×PASS；`pnpm test:scripts` 23/23；docs guards 全绿；Core 无行业词
边界测试继续。
