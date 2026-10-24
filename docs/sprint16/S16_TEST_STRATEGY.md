# Sprint 16 — DevCompany Pack 测试策略（T16-01 冻结）

> 状态：**FROZEN**（未来测试规划，非测试代码；T16-01 本身零测试代码）。
> 上游：`S16_DEVCOMPANY_PRODUCT_CONTRACT.md`（产品合同）、`docs/EXECUTION_ROADMAP.md` Sprint 16 段
> 的 Tests（`packs/dev-company/tests/roles.test.ts`、`packs/dev-company/tests/prompt-validator.test.ts`、
> Core 无行业词边界测试）。

## 分层

| 层 | 内容 | 位置（建议） |
|---|---|---|
| L1 静态合同 | manifest 过 canonical parser；identity/九类计数/空类裁定 | `packs/dev-company/tests/contract.test.ts` |
| L2 产品内容 | 五岗位定义与职责覆盖（对齐 roadmap `roles.test.ts`）；Prompt/Validator/Risk/Artifact 声明可装载（对齐 `prompt-validator.test.ts`）；authority 闭集与最小权限断言 | `packs/dev-company/tests/roles.test.ts`、`prompt-validator.test.ts` |
| L3 边界 | Core/contracts/engine → DevCompany 反向依赖=0；Core 无行业词（含新包）；manifest inert data（无回调/无 fs/无 spawn/无 import） | `packs/dev-company/tests/boundary.test.ts` 或扩展现有 guards |
| L4 框架集成 | 真实 PackService install → 九类 refs → 物化（Role/Template 真实实体 ref，七类 null）→ disable/re-enable → tenant 隔离 → run pinning 继承 | `tests/sprint16/pack-integration.test.ts` |

## 矩阵（必须覆盖）

| # | 场景 | 关键断言 |
|---|---|---|
| 1 | manifest validity | canonical parser 通过；`manifestVersion`/`coreApi` 用 Sprint 15 constants；packId `dev-company` / packVersion `1.0.0` |
| 2 | 九类声明实际使用 | Roles 5 / WorkflowTemplates 1 / Prompts 5 / Tools 6 / Validators 1 / Artifacts 5 / RiskRules ≥1 / CapabilityRules 0 / GenericTemplates 0；PackContentRef 数 = 声明项数 |
| 3 | 五岗位定义 | 五 logical keys 存在；label；**authorityRefs ⊆ AUTHORITIES 且逐角色等于合同 §3.2 冻结集**（最小权限回退防护） |
| 4 | 职责覆盖 | 每角色 prompt 含合同 §5 规定的硬边界（QA：禁 LLM 自证；Reviewer：独立 review/unrelated diff/tests/concurrency-async-state-security） |
| 5 | workflow 物化 | `dev-company:delivery-cycle` 五 stage 线性链；stage config 仅 `roleId`/`validatorIds`/`riskLevel`/`approval`；无新 config key |
| 6 | 模型分离（合同级） | Developer stage 声明 logical `toolCalling`；Reviewer stage 声明 logical `reasoning`；无厂商名 |
| 7 | tool requirements | 六项 requirement 声明存在且标记 DECLARATIVE REQUIREMENT；**未声称 registry 已有** |
| 8 | validator requirement | `dev-company:qa-evidence-validator` 声明存在；validatorId 指向携带 `validation:validator` capability 的 tool（Sprint 17 注册） |
| 9 | artifact vocabulary | 五个 kind 存在；**install 不创建 Artifact 实例** |
| 10 | risk rule | reviewer/qa 门不可绕过的最小语义可表达；schema 未扩 |
| 11 | 边界（Core 无行业词） | `Developer`/`CTO`/`CodeFleet` 等不出现在 Core/contracts/engine 泛型框架；仅存在于 packs/dev-company |
| 12 | 边界（依赖方向） | Core/contracts/engine 不 import DevCompany；DevCompany → generic contracts 单向 |
| 13 | inert data | manifest 模块无 install callback / fs / spawn / network / dynamic import |
| 14 | 安装集成（真实 PackService） | install → 9 类 refs → Role/Template 真实 entityRef → 其余 null ref |
| 15 | unmet requirement 行为 | 生产 Tool Registry 无对应 tool 时 install fail closed（`PACK_TOOL_MISSING`/`PACK_VALIDATOR_MISSING`），零写入；受控 test registry 下可完成框架验证 |
| 16 | disable / re-enable | new-use 拒绝（直调 assign/saveDraftGraph/publish/publishRevision/fork/createRun）+ 历史保留 + re-enable 零重复物化 |
| 17 | tenant 隔离 | 同 PackVersion 一行、两 Company 两 installation、各自 refs；A disable 不影响 B |
| 18 | run pinning 继承 | DevCompany workflow 创建 Run ⇒ `packVersions` 含 `dev-company` + 依赖闭包；packless ⇒ `{}` |
| 19 | 框架回归 | Sprint 13/14/15 既有语义零变更（不修改冻结面） |
| 20 | 无 UI/IPC creep | Sprint 16 无 Pack IPC / renderer 变更 / 自动安装 / startup auto-install（结构断言） |

## T16-02 静态合同矩阵（已实现：`packs/dev-company/tests/manifest.test.ts`，17 项）

| # | 断言 | 证据 |
|---|---|---|
| 1 | canonical contracts parser 零 issue 通过 | `canonicalPackManifestSchema.safeParse` PASS 且投影等价 |
| 2 | Core 语义校验器通过（语义权威一致） | `validatePackManifest` PASS |
| 3 | 版本字段用 canonical constants（无 magic value 复制） | `PACK_MANIFEST_VERSION` / `PACK_API_VERSION` 断言 |
| 4 | 产品身份冻结 | packId `dev-company` / packVersion `1.0.0` / name `DevCompany` |
| 5 | 无 codename、无安装身份字段 | 序列化不含 `CodeFleet`；不含 companyId/installationId/creationCommandId/status 等 |
| 6 | 恰好九类声明键 | `Object.keys(declarations)` = 九类 |
| 7 | 六类宪法强制非空 + prompts 5 + 两类裁定为空 | roles/workflowTemplates/validators/tools/artifacts/riskRules 非空；capabilityRules/templates = [] |
| 8 | 五角色 keys + authority ∈ 闭集 + 无 pack.manage/wildcard | 逐角色断言 + `isAuthority` |
| 9 | 单一五阶段 workflow，stage config 仅 frozen keys，reviewer/qa HIGH + required approval | 节点/边/配置断言 |
| 10 | 六 tool requirements + QA validator 为 declarative requirement | key/toolId/validatorId 断言 |
| 11 | 五 artifact kinds + 一条最小 risk rule | 断言 |
| 12 | QA prompt 含禁 LLM 自证硬边界 | 文本断言 |
| 13 | model policy：toolCalling/reasoning + reviewerMustDifferFromDeveloper，且**不在 manifest 内** | policy 断言 + manifest 序列化不含 policy 字段 |
| 14 | fingerprint = qualified sha256 且同导入确定性一致 | `packManifestFingerprint` 两次相等 + 格式断言 |
| 15 | 源码 inertness（code-only 扫描：无 fs/child_process/vm/eval/fetch/process.env/PackService/install/import/require） | 结构锁 |
| 16 | 依赖方向单向：包仅依赖 `@companyos/core`；core/contracts/engine 不依赖本包 | package.json + 源码回锁 |
| 17 | 包完整参与 workspace（vitest include / tsconfig paths / build reference） | 本套件被 root gate 执行即证 |

## T16-03 产品内容矩阵（已实现）

`packs/dev-company/tests/product-contract.test.ts`（30 项）+ `tests/sprint16/devcompany-pre-sprint17-install.test.ts`（2 项）：

- **Roles（精确集合）**：五角色 keys 与顺序；每角色 authority 集合与 T16-01 §3.2 **逐项相等**（exact-set，非 contains）；无 `pack.manage`/`secret.*`；manifest 无用户身份/分配/bootstrap 字段（结构键扫描）。
- **Workflow**：单 `dev-company:delivery-cycle`；五节点线性链且无 retry/deploy/release/security/devops/manager/loop；stage→role 精确绑定；stage config 仅 `roleId`/`validatorIds`/`riskLevel`/`approval`；reviewer/qa = HIGH + required owner approval；CTO 无审批门、无回边。
- **Prompts**：恰好五个；CTO/Developer/Reviewer/Documentation 职责覆盖；QA 禁 LLM 自证 + 六命令 + durable evidence；无 prompt runtime 宣称。
- **Declarations**：六 tool requirements；git diff/status 为不同 requirement（共享 toolId、capability null）；一 validator；五 artifact kinds；一 risk rule；capabilityRules/templates = []；九类计数精确（5/1/5/6/1/5/1/0/0）。
- **Model policy**：toolCalling/reasoning + reviewerMustDifferFromDeveloper；结构上不在 manifest 内；仍九类（无第十类）。
- **一致性**：identity/counts/空类裁定与合同文档一致。
- **预 Sprint17 安装**：真实 PackService + 空 registry ⇒ `PACK_TOOL_MISSING`（toolId `repo.test-runner`）；全 tool 通过、validator 能力缺失 ⇒ `PACK_VALIDATOR_MISSING`；两者均 0 installation / 0 PackVersion / 0 contentRef / 0 template / 0 非 owner role / 无 `pack.installed` 事件。成功安装属 T16-05。

## T16-04 边界矩阵（已实现：`packs/dev-company/tests/boundary.test.ts`，22 项）

- **身份与 workspace**：包名唯一（package.json/tsconfig paths/vitest alias/build reference 五处一致，
  无第二套 `@companyos/dev-company-pack`）；vitest include + root tsconfig include 覆盖
  `packs/*/{src,tests}`；package exports 仅 `.`；`git ls-files` 证明无 dist/node_modules/.tsbuildinfo
  被跟踪。
- **依赖方向**：pack 仅依赖 `@companyos/core: workspace:*`（无 devDependencies/peerDependencies）；
  core/contracts/engine/persistence/desktop 的 manifest 与**全部生产源码**（code-only）对 pack 零引用；
  build graph 无 generic → pack 引用。
- **行业隔离**：六个 DevCompany 产品名词在 core/contracts/engine 生产源码 code-only 视图零命中；
  engine 无 `'dev-company'` 特判字面量。
- **静态安全**：src 零动态代码/进程/网络/fs/env/DB/require/dynamic import；零 PackService import 与
  install/enable/disable/upgrade 调用；无 installDevCompany/bootstrapDevCompany/registerDevCompany/
  DevCompanyService；产品数据（manifest + policy）无 runtime identity 字段（companyId/installationId/
  creationCommandId/status/installedAt/actorId…）；无 vendor 名/credential/secret。
- **Schema 权威**：pack 无 zod/本地 schema 副本；manifest `as const satisfies PackManifest`；
  policy 派生自 `ModelCapabilityProfile`；model policy 不在 manifest、仍九类。
- **Surface 与 data 形状**：index 只导出 inert data/constants/derived types（无 function/class/async）；
  product data 编译期 readonly（无 runtime deep-freeze）。
- **无 creep**：desktop main.ts 与 desktop manifest 零 DevCompany 引用；pack 迁移仍只有一个；
  无 marketplace/loader/scanner（word-boundary 扫描 glob/scan/load/fetch）。

## T16-05 集成矩阵（已实现：`tests/sprint16/devcompany-framework-integration.test.ts`，16 项）

真实基础设施（SQLite + pack 迁移 + 真实 authorization/UoW/EventStore/pack stores/lifecycle/
availability policy/run provenance resolver + **真实 Model Registry 与 Router**）；仅 Sprint17
provider 为受控 test fixture（满足 preflight，零执行）。

| # | 断言 | 结果 |
|---|---|---|
| 1 | 受控 test registry 下真实 manifest 安装成功 | PASS |
| 2 | identity `dev-company@1.0.0` + status installed + fingerprint = canonical 产品指纹 | PASS |
| 3 | 24 个 PackContentRefs | PASS |
| 4 | 6 个非空 materialized refs（5 role + 1 workflowTemplate） | PASS |
| 5 | 18 个 null refs（5 prompt + 6 tool + 1 validator + 5 artifact + 1 riskRule） | PASS |
| 6 | 5 个 Role 经真实 authorization 物化（key 扁平化） | PASS |
| 7 | 零自动角色分配（唯一 assignment = bootstrap owner） | PASS |
| 8 | workflow 物化 | PASS |
| 9 | graph 保真（stage ids/edges/roleId/validatorIds/riskLevel/approval） | PASS |
| 10 | tool 行不复制（ fixture 6 条不变） | PASS |
| 11 | validator tool 不复制（`repo.validation-evidence` 仅 1 条） | PASS |
| 12 | 安装时零 Artifact 行 | PASS |
| 13 | installed 时 new-use 允许（真实 publish 入口 + 角色可分配） | PASS |
| 14 | 从物化 workflow 创建真实 Run（真实 createRun 路径） | PASS |
| 15 | `packVersions = {dev-company: 1.0.0}`（无其它 Pack，caller 未提供 provenance） | PASS |
| 16 | developer 经真实 Router 解析 `toolCalling` 模型 | PASS |
| 17 | reviewer 经真实 Router 解析 `reasoning` 模型 | PASS |
| 18 | developer/reviewer modelKey 不同（AC16.2 核心证据） | PASS |
| 19 | `RunSnapshot.modelBindings` 持久化解析结果 | PASS |
| 20 | model policy 不在 PackManifest（结构性） | PASS |
| 21 | pack 事件 payload 白名单（无 prompt/workflow/model policy/凭据泄漏） | PASS |
| 22 | disable ⇒ 新 Run `POLICY_DENIED` | PASS |
| 23 | 旧 Run 的 packVersions/modelBindings/workflow 行不变 | PASS |
| 24 | re-enable ⇒ 零重复物化、新 Run 恢复 | PASS |
| 25 | 真实 close/reopen + fresh graph 保留 installation/refs/Run/bindings | PASS |
| 26 | packless workflow 仍 `{}` | PASS |
| 27 | generic 生产代码零 DevCompany 引用（递归扫描 core/contracts/engine/persistence/desktop src） | PASS |
| 28 | 零 Sprint17 runtime（受控 tools 仅在 fixture、零 invocation、desktop 零引用） | PASS |

## 回归边界

Sprint 13 Artifact/Validation、Sprint 14 Recovery、Sprint 15 Pack Framework 全部继续全绿；不得修改
冻结语义（除非发现明确 blocker 并先 HARD STOP 分类）。基线门禁：`pnpm check` 5×PASS、
`pnpm test:scripts`、`git diff --check`、UTF-8/0 U+FFFD、用例只增不减。

## 诚实声明（closeout 必须保留）

DevCompany Pack product delivered · Pack framework compatibility proven ·
**Executable QA command fulfillment: Deferred to Sprint17**（Repository/Terminal/Git runtime +
executable validator tool）。不得宣称 fully operational end-to-end coding company。
