# Sprint 16 — DevCompany / CodeFleet Product Contract（T16-01 冻结）

> 状态：**CLOSED**（Task-16-01 冻结；T16-02~T16-06 已交付并收口，见 `docs/SPRINT16_CLOSEOUT.md`）。Task-16-01 docs/product-spec only；无产品代码、无 manifest 实现、无测试代码、
> 无 migration、无 IPC、无 renderer、无 runtime 框架变更）。
> 上游依据：`docs/EXECUTION_ROADMAP.md` Sprint 16 段（Mission/T16.1–T16.6/AC16.1–16.3/Tests/Git
> Checkpoint）、`docs/V1_1_RECONCILIATION.md` §十七–§二十二、`docs/PROJECT_CONSTITUTION.md`、
> ADR-0024~0027 与 `docs/sprint15/S15_PACK_CONTRACT.md`。
> **来源标注纪律（§50）**：本文所有条目分两类——`SOURCE-DEFINED`（repo/规划书已有权威来源）与
> `BOSS-FROZEN DERIVATION`（Boss 在 TASK-16-01 裁定、由 ZCode 从既有职责清单推导）。不得把
> BOSS-FROZEN DERIVATION 伪装成原规划书内容。

## 1. Sprint 16 Product Scope（§1 裁定）

Sprint 16 目标 = **DELIVER FIRST-PARTY DEVCOMPANY PACK PRODUCT DEFINITION**：一份 first-party、
build-valid、canonical、versioned 的行业 Pack **产品定义**（§42）。**不是** Repository Runtime /
Terminal / Git runtime / marketplace / Pack UI / Pack IPC / 自动安装 / Prompt runtime engine /
Risk rule runtime engine。

## 2. Pack Identity（§9/§10 冻结）

| 字段 | 值 | 标注 |
|---|---|---|
| packId | `dev-company` | BOSS-FROZEN（§9） |
| packVersion | `1.0.0` | BOSS-FROZEN（§9） |
| name | `DevCompany` | BOSS-FROZEN（§9） |
| internal codename | `CodeFleet` | BOSS-FROZEN（§9）——**仅可出现在 DevCompany package/docs/tests**；MUST NOT 进入 Core 泛型语义；**不向 canonical PackManifest schema 增加 codename 字段** |
| manifestVersion | `PACK_MANIFEST_VERSION`（= 1，`packages/core/src/registry/pack-manifest.ts`） | SOURCE-DEFINED（T15 canonical constant） |
| coreApi | `PACK_API_VERSION`（= '1'） | SOURCE-DEFINED（T15 canonical constant） |

codename 属于包内文档/命名，不是 manifest 字段。

## 3. Five Canonical Roles（§11–§16 冻结）

### 3.1 角色键与职责

| logical key | 角色 | 职责（逐条） | 标注 |
|---|---|---|---|
| `dev-company:cto` | CTO / Chief | understand requirement · analyze existing project · select/design Workflow · define Sprint · define Task · define Acceptance Criteria · define Capability Requirement · determine risk · perform final acceptance · propose SOP improvements。**DOES NOT OWN CONTINUOUS SCHEDULING**（不得扩大为永久 orchestrator） | SOURCE-DEFINED（§12；V1_1_RECONCILIATION §十八） |
| `dev-company:developer` | Developer | coding · UI implementation · API implementation · CRUD · bug fixes · ordinary refactoring · test additions · file modifications | SOURCE-DEFINED（§13；§十九） |
| `dev-company:reviewer` | Reviewer | code review · architecture consistency · potential bugs · boundary correctness · state consistency · concurrency · async correctness · security · missing tests · unrelated diff detection | SOURCE-DEFINED（§14；§二十） |
| `dev-company:qa` | QA | tests · lint · typecheck · build · git diff · git status（六项真实命令）；**事实来源 = REAL TOOL / VALIDATION EVIDENCE，不是 LLM 自述** | SOURCE-DEFINED（§15；§二十一） |
| `dev-company:documentation` | Documentation | README · API Docs · CHANGELOG · User Guide · Technical Documentation · Decision Summary | SOURCE-DEFINED（§16；§二十二） |

禁止增加第六角色（Product Manager / Designer / DevOps / Security Engineer 等）——无权威来源（§11）。

### 3.2 Role authorities（§17–§19：BOSS-FROZEN DERIVATION，最小权限，仅用既有 43 项 AUTHORITIES）

推导原则：只授予履行该角色明确职责所需 authority；禁 owner-like wildcard / all authorities /
bootstrap owner 等价；无角色获得 `pack.manage`（无角色管理 Pack）。执行类角色获得
`agent.execute` + `tool.invoke` + `tool.read`（工具执行边界由调用时点的 tool risk/authority 决定，
不由角色决定）；指导类角色只获只读子集。

| 角色 | authorityRefs | 职责→authority 依据 | 为何不给更宽 |
|---|---|---|---|
| `dev-company:cto` | `workflow.draft.create` `workflow.publish` `artifact.create` `artifact.read` `decision.create` `decision.read` `memory.read` `tool.read` `validation.read` | 设计 SOP=create+ publish（使其可运行）；Plan/Task/AC/Risk 产物=artifact.create；记录验收/风险决定=decision.create/read；分析既有项目=memory.read+artifact.read；定义 Capability Requirement 需知工具面=tool.read；最终验收需读证据=validation.read | 无 `run.start`/`agent.execute`/`tool.invoke`（CTO 不做连续调度、不执行）；无 fork/deprecate/archive/lock（不改他人 SOP 生命周期）；无 pack.manage |
| `dev-company:developer` | `agent.execute` `tool.invoke` `tool.read` `artifact.create` `artifact.read` `memory.create` `memory.read` `handoff.create` `handoff.read` `validation.read` | 编码/CRUD/重构等经 agent.execute 执行并调用工具；产物=implementation-change artifact；工作记忆=memory.create/read；交棒 Reviewer=handoff.create/read；交付前查证据=validation.read | 无 workflow.*（不改 SOP）；无 run.start（见 §7 安装入口）；无 decision.*（不裁决）；无 handoff.accept/reject（接收方权利） |
| `dev-company:reviewer` | `agent.execute` `tool.invoke` `tool.read` `artifact.create` `artifact.read` `memory.read` `validation.read` `handoff.read` `handoff.accept` `handoff.reject` `handoff.create` | 独立 review 经 agent.execute + 读代码工具（Sprint 17 提供读取面）；review-report=artifact.create；查测试证据=validation.read；接受/拒绝 Developer 交付=handoff.accept/reject；必要时回退或前送 QA=handoff.create | 无 workflow.*/run.*/decision.*；无 memory.create（review 产物走 artifact）；无 pack.manage |
| `dev-company:qa` | `agent.execute` `tool.invoke` `tool.read` `artifact.create` `artifact.read` `memory.read` `validation.record` `validation.read` `handoff.read` `handoff.accept` `handoff.reject` `handoff.create` | 六项真实命令经 agent.execute+tool.invoke 执行（可执行面=Sprint 17）；**记录 durable validation 证据=validation.record（AC16.2 关键）**；qa-report=artifact.create；失败回退 Developer / 通过前送 Documentation=handoff.accept/reject/create | 无 workflow.*/decision.*；无 memory.create（证据走 validation+artifact）；无 tool.register/enable/disable（不管理 registry） |
| `dev-company:documentation` | `agent.execute` `tool.invoke` `tool.read` `artifact.create` `artifact.read` `memory.read` `decision.read` `handoff.create` `handoff.read` | 写档经 agent.execute（Sprint 17 提供写面）；文档产物=artifact.create；Decision Summary 需读决策=decision.read；交付回传=handoff.create/read | 无 validation.*/workflow.*/run.*；无 handoff.accept/reject（末站不回退准入）；无 memory.create |

**`DEVCOMPANY_AUTHORITY_GAP`: NO** —— 五角色全部职责可由既有 43 项 AUTHORITIES 以最小权限表达；
未新增任何 authority（§17 边界满足）。

## 4. Canonical Workflow（§20–§23 冻结）

| 项 | 值 | 标注 |
|---|---|---|
| workflow logical key | `dev-company:delivery-cycle` | BOSS-FROZEN（§20） |
| name | `DevCompany Delivery Cycle` | BOSS-FROZEN |
| 产品链 | CTO → Developer → Reviewer → QA → Documentation | SOURCE-DEFINED（roadmap Phase 3 “DevCompany 全角色链”） |
| stages | `cto` → `developer` → `reviewer` → `qa` → `documentation`（每 stage 绑定对应 Role，线性边，无环） | BOSS-FROZEN（§22） |
| stage config | 仅用既有 `STAGE_CONFIG_KEYS` = `roleId` / `validatorIds` / `riskLevel` / `approval`；**不增加新 workflow schema key** | §22 硬约束 |

**Workflow 保持最小（§21）**：不得加入复杂 CTO retry loop、automatic developer/reviewer cycling、
release deployment、production rollout、repository branching strategy、CI pipeline orchestration
（Sprint 18 才有 CTO Workflow SOP 工作）。**`DEVCOMPANY_WORKFLOW_MODEL_GAP`: NO** —— 现有
`WorkflowTemplate/Version + stage graph + roleId/validatorIds/riskLevel/approval` 完全可表达；
无需 Core/Engine 扩展。

### 4.1 Reviewer / Developer 模型分离（§23/§14，SOURCE-DEFINED 要求 + BOSS-FROZEN 表达方式）

产品规则：**Reviewer 默认模型 ≠ Developer 默认模型**（AC16.2；规划书 §二十）。表达方式（不写厂商名，§24）：
Developer stage 的 logical model requirement = **`toolCalling`**（需调工具完成编码/文件修改）；
Reviewer stage 的 logical model requirement = **`reasoning`**（独立评审）。二者是 `ModelCapabilityProfile`
的既有 logical capability 字段，默认经 Router/选择策略解析到不同 model binding；
运行期落点在既有 `RunSnapshot.modelBindings`。**不新增 workflow config key**（§22），
**不写死任何厂商**（§24）。

## 5. Prompt Contracts（§25–§29 冻结，BOSS-FROZEN DERIVATION）

Prompt 声明 = **declarative product content only**（§4 裁定解除 `DEVCOMPANY_PROMPT_CONSUMPTION_GAP`
作为 Sprint 16 blocker：不需要新 Prompt runtime / Agent runtime 修改 / Core 变更；真正接入运行时=
未来独立批准）。每个 Prompt 只允许包含：role mission · responsibilities · hard boundaries ·
expected outputs · evidence requirements · handoff target（§26）。Prompt keys（§27）：

| key | role | 必须包含的硬边界 |
|---|---|---|
| `dev-company:cto-prompt` | CTO | 不承担持续调度；不得自行扩大 orchestrator 权力 |
| `dev-company:developer-prompt` | Developer | 只做来源内职责（编码/UI/API/CRUD/Bug Fix/普通重构/测试补充/文件修改） |
| `dev-company:reviewer-prompt` | Reviewer | **独立 review implementation；检查 unrelated diff、tests、concurrency/async/state/security boundaries；记录“默认模型 ≠ Developer”** |
| `dev-company:qa-prompt` | QA | **永不因模型推理单独宣称命令通过；tests/lint/typecheck/build/git diff/git status 结论必须来自 durable tool/validation evidence** |
| `dev-company:documentation-prompt` | Documentation | 只产出六类文档；不改产品代码 |

字段按 T15 真实 `PromptDeclaration { key, template, version }`（key 为 pack-qualified；version 可空）。

## 6. QA Evidence Contract（§2/§3/§15/§28 冻结）

- Sprint 16 = **contract-level AC16.2**：DevCompany 必须声明 QA 职责、QA prompt policy、QA validator
  requirements、QA required evidence semantics，并明确：**PASS 需真实 validator/tool evidence；
  禁止 LLM narrative 自证**。
- Sprint 17 = **executable fulfillment**：提供 tests / lint / typecheck / build / git diff / git status
  对应的 Repository / Terminal / Git 可执行 runtime。Sprint 16 **不得**为满足 QA 提前实现 Sprint 17。
- Closeout 必须写明：**Executable QA command fulfillment: Deferred to Sprint17**（非 blocker）。

## 7. Tool Requirements（§30–§32 冻结）

真实 `ToolRequirementDeclaration { key, toolId, capability }`——requirement-only（ADR-0026：不实现、
不装 adapter、不执行）。Sprint 16 只冻结 **required future tool capabilities**（来源=QA 六项真实命令）：

| requirement key | 语义（来源） | 状态 |
|---|---|---|
| `dev-company:tool-req-tests` | 运行 tests | DECLARATIVE REQUIREMENT；RUNTIME PROVIDER DEFERRED TO SPRINT17 |
| `dev-company:tool-req-lint` | 运行 lint | 同上 |
| `dev-company:tool-req-typecheck` | 运行 typecheck | 同上 |
| `dev-company:tool-req-build` | 运行 build | 同上 |
| `dev-company:tool-req-git-diff` | git diff | 同上 |
| `dev-company:tool-req-git-status` | git status | 同上 |

toolId 值 = Sprint 17 将注册的 logical tool id（候选形如 `repo.terminal`/`repo.git`），**T16-02 冻结
具体 toolId 前必须核对 Sprint 17 命名**；不得声称 registry 已有。**正式 DevCompany v1 可静态合法，
但在需要这些工具的生产 Company 中尚不可 runtime-installable**（§32）——closeout 不得虚报
“full runtime-ready”。

## 8. Validator Requirement（§33/§34 冻结）

| 项 | 值 |
|---|---|
| validator logical key | `dev-company:qa-evidence-validator`（§33） |
| 语义 | QA success requires validator evidence derived from real command results |
| schema | 真实 `ValidatorDeclaration { key, validatorId }`（validatorId 指向带 `validation:validator` capability 的 tool） |
| 运行时边界 | **Sprint 17 must provide/register the executable validator tool**（§34）；Sprint 16 不实现 adapter |

## 9. Artifact Vocabulary（§35/§36 冻结，BOSS-FROZEN DERIVATION）

真实 `ArtifactTypeDeclaration { key, label, description }`——kind/vocabulary only（ADR-0015 权威）；
**不得在 install 时创建 Artifact 实例**（§36）：真实实例继续 per Run 经 ArtifactService 创建。

| artifact key | label |
|---|---|
| `dev-company:requirements-analysis` | Requirements Analysis |
| `dev-company:implementation-change` | Implementation Change |
| `dev-company:review-report` | Review Report |
| `dev-company:qa-report` | QA Report |
| `dev-company:documentation` | Documentation |

## 10. Risk Rule（§37/§38 冻结）

最小产品语义：**Reviewer 与 QA 门不得被绕过**（对于被 Workflow 分类为需要这些 stage 的工作）。
映射到真实 `RiskRuleDeclaration { key, riskLevel, description }`：reviewer 与 qa stage 的
`riskLevel` 与既有 `requiresHumanApproval`（HIGH/CRITICAL 需人工批准）共同表达“门不可绕过”。
**`DEVCOMPANY_RISK_RULE_SCHEMA_GAP`: NO** —— T15 schema 足以表达该最小语义，不扩 schema。

## 11. Capability Rules / Generic Templates（§39/§40 冻结）

- `declarations.capabilityRules = []`（默认 EMPTY；除非 T16-01 在权威职责中发现必须表达且已有明确
  语义——未发现）。
- `declarations.templates = []`（Generic Templates 默认 EMPTY；不得为凑九类造内容）。
- capability ≠ authority ≠ tool capability ≠ provider/model capability（§19 纪律）。

## 12. Nine Categories — 不必全非空（§8 裁定）

canonical 九类必须存在 ≠ 每类必须有条目。DevCompany v1 只为有真实产品内容的类别填充：
Roles(5) / WorkflowTemplates(1) / Prompts(5) / Tools(6 requirements) / Validators(1) /
Artifacts(5) / RiskRules(最小 1) / CapabilityRules(0) / GenericTemplates(0)。constitution 强制的
六类（Roles/WorkflowTemplates/Validators/Tools/Artifacts/RiskRules）全部非空 ⇒ 合规。

## 13. Installation Entry Point（§41–§43 裁定）

正式解除 `DEVCOMPANY_INSTALLATION_ENTRYPOINT_GAP` 作为 Sprint 16 blocker：
- Sprint 16 **不加自动安装、不加 Pack IPC、不加 Renderer 安装 UI、不在 startup 自动安装**。
- “交付 DevCompany Pack” = first-party / build-valid / canonical / versioned 产品包（§42）。
- 真正 `PackService.install(...)` 装入某 Company = 等未来 application entrypoint 批准后执行（§43）。
- T16 测试**可以**用 PackService 做 integration validation；生产 startup 不自动安装。

## 14. Product Location / Boundary / Representation（§44–§47 冻结）

- 位置：`packs/dev-company/`（§44：roadmap Tests 已引用该路径 + `pnpm-workspace.yaml` 已含 `packs/*`）。
- 依赖方向（§45）：DevCompany → generic platform contracts/types；**禁止** Core → DevCompany、
  Contracts → DevCompany、Engine 泛型 Pack 框架 → DevCompany。需 boundary test。
- 表示（§46）：**inert compile-time TypeScript data**，语义如
  `export const DEVCOMPANY_MANIFEST = ...`（T16-01 不创建；T16-02 实现时 `readonly` + `as const` +
  `satisfies canonical transport/domain shape`，并由 canonical parser 在 tests/build 验证）。
- 无动态执行（§47）：即使使用 `.ts` 产品文件，也只允许导出 inert data；不得 install callbacks /
  读文件系统 / spawn process / 连网 / dynamic import。

## 15. Sprint 17 Runtime Dependency（§2/§3 冻结）

DevCompany 的 Tool/Validator requirements 的可执行面（tests/lint/typecheck/build/git diff/git status
的 Repository/Terminal/Git runtime + executable validator tool）由 Sprint 17 提供。Sprint 16 交付
**产品合同与声明**，Sprint 17 交付**可执行兑现**。

## 15.1 Implementation Mapping（TASK-16-02 已交付，记录真实位置/命名/证据）

- **Package**：`packs/dev-company/`（name `@companyos/pack-dev-company`，repo industry-pack 命名
  约定 `@companyos/pack-*`）；private / `type:module` / `sideEffects:false` / dist exports /
  `tsc -b` composite；唯一内部依赖 `@companyos/core: workspace:*`（lockfile 零外部依赖增量）。
- **Manifest**：`packs/dev-company/src/manifest.ts` → `DEVCOMPANY_MANIFEST`
  （`as const satisfies PackManifest` + contracts canonical parser 运行时验证）。九类填充：
  Roles 5（§3.2 authorities）/ WorkflowTemplates 1（`dev-company:delivery-cycle`，五节点线性链，
  reviewer/qa stage `riskLevel: 'HIGH'` + `approval {required:true,mode:'owner'}` = 门不可绕过的
  **实际强制点**）/ Prompts 5 / Tools 6 / Validators 1 / Artifacts 5 / RiskRules 1 /
  CapabilityRules [] / GenericTemplates []；`capabilities: []`、`dependsOn: []`。
- **Model policy（Boss OPTION 1 冻结）**：`packs/dev-company/src/model-policy.ts` →
  `DEVCOMPANY_MODEL_POLICY`。**不是 PackManifest 声明、不是第十类、不是 Core 契约**；inert
  readonly data；capability 名从 `ModelCapabilityProfile` 派生（`toolCalling` / `reasoning`）；
  无 runtime consumer。真正绑定由既有 Model Registry / Router / `RunSnapshot.modelBindings`
  负责（T16-05 验证）。正确表述：*DevCompany product contract requires Developer and Reviewer
  to resolve to different default model bindings; the requirement is enforced/validated at the
  existing model-binding layer, not represented in PackManifest.*
- **Sprint 17 requirements（declarative）**：tool requirements 指向 `repo.test-runner` /
  `repo.linter` / `repo.typechecker` / `repo.builder` / `repo.git`；validator 指向
  `repo.validation-evidence`（须携带 `validation:validator` capability）。静态 manifest 合法；
  生产 install 在这些 tool 未注册时**预期 fail closed**。
- **边界**：Core/contracts/engine 不依赖本包（测试回锁）；generic Pack framework 不读取
  model policy（无新增 generic `PackModelPolicy` 之类）。

## 15.2 Framework Integration Evidence（TASK-16-05）

- **真实安装**：`DEVCOMPANY_MANIFEST` 经真实 PackService 成功安装（受控 test tool/validator
  registry 仅满足 preflight，零执行）；identity/status/fingerprint 如 §2；24 refs（6 非空 +
  18 null）；5 Role 物化、零自动分配；workflow 物化且 graph 保真。
- **模型分离证明**：现有 Model Registry + Router 足够表达策略——`deriveRouterPolicyView`
  的 call-site `requiredCapabilities` → `applyHardFilters` 的 `REQUIRED_CAPABILITIES_FILTER`
  → `router.recommend` 的 `selectedModelKey`；`createRun({modelBindings})` 由可信 application
  调用方写入 `RunSnapshot.modelBindings`。**无 generic framework 改动**；test harness 是
  trusted binding coordinator，不是 production runtime consumer。
- **运行时边界**：绑定创建后不重解析（unregister 已绑定模型不改变 snapshot）；disable 后新 Run
  被拒、旧 Run 全部 pinned 状态不变；re-enable 零重复物化。
- **仍然成立**：Sprint17 executable fulfillment pending（Repository/Terminal/Git runtime +
  executable validator tool）；成功安装**不代表** QA 能真实运行 tests/lint/build/git。

## 16. Non-Goals（Sprint 16）

Repository Runtime / Terminal / Git runtime 实现；marketplace / signature / remote import / download；
Pack UI / Pack IPC / renderer 变更；automatic installation / startup auto-install；Prompt runtime
engine（PromptEngine/PromptRenderer/Prompt resolver）；Risk rule 或 Capability rule runtime engine；
Generic Template runtime；新 Pack 类别（第十类）；Core 行业词；新 authority；新 migration；
Codename 进 canonical schema；“fully operational end-to-end coding company” 类宣称（§54）。

## 17. Gap Closure Summary（相对 Planning Recon）

| Recon gap | T16-01 状态 |
|---|---|
| `DEVCOMPANY_PRODUCT_SPEC_GAP` | **CLOSED**（本文冻结五角色/key/authorities/workflow/prompts/tools/validators/artifacts/risk） |
| `DEVCOMPANY_AUTHORITY_GAP` | **CLOSED**（§3.2 最小权限推导，43 项既有 authority 足够；未新增） |
| `DEVCOMPANY_WORKFLOW_MODEL_GAP` | **CLOSED**（现有 workflow 模型可表达；无 schema 扩展） |
| `DEVCOMPANY_PROMPT_SPEC_GAP` | **CLOSED**（§5 五 prompt 合同，BOSS-FROZEN DERIVATION） |
| `DEVCOMPANY_PROMPT_CONSUMPTION_GAP` | **CLOSED as blocker**（§5：declarative-only；接入运行时=未来独立批准） |
| `DEVCOMPANY_INSTALLATION_ENTRYPOINT_GAP` | **CLOSED as blocker**（§13：无自动安装/无 IPC/无 UI；entrypoint 未来批准） |
| `DEVCOMPANY_RISK_RULE_SCHEMA_GAP` | **CLOSED**（NO——T15 schema 可表达最小语义） |
