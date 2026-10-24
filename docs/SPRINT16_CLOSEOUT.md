# Sprint 16 Closeout — DevCompany Pack（T16-01–T16-06）

> 状态：**CLOSED**（本文为 Sprint 16 最终收口记录；独立评审 = Boss 逐 Task review，T16-01~T16-05 均
> 获 `PASS / CLOSED`，T16-06 以本文 + 最终回归 + checkpoint 为准）。真实 commit hash 见本文 §12 与
> `PROJECT_HANDOFF.md`。**未 push、未 release。**

## 1. Mission（roadmap 冻结原文）

交付**第一个行业 Pack：DevCompany（内部代号 CodeFleet）**（来源：规划书 §五十九 Sprint 16、§十七–§二十二）。

## 2. Delivered Product（→ IMPLEMENTED / TESTED / DOCUMENTED）

| # | 交付物 | 实现 | 测试证据 | 文档 |
|---|---|---|---|---|
| 1 | DevCompany 产品合同冻结 | `docs/sprint16/S16_DEVCOMPANY_PRODUCT_CONTRACT.md`（身份/五角色/最小权限 authorities/workflow/五 prompt/tool-validator-artifact-risk 声明/model policy 裁定/安装入口裁定/non-goals；全程标注 `SOURCE-DEFINED` vs `BOSS-FROZEN DERIVATION`） | — | 本文 §3–§8 |
| 2 | First-party Pack package | `packs/dev-company/`（`@companyos/pack-dev-company`，inert readonly 数据，唯一内部依赖 `@companyos/core: workspace:*`） | `packs/dev-company/tests/boundary.test.ts` 22 项 | §9 |
| 3 | Canonical manifest | `packs/dev-company/src/manifest.ts` → `DEVCOMPANY_MANIFEST`（`as const satisfies PackManifest` + contracts canonical parser + Core 语义校验器双重 PASS；九类 24 项声明） | `manifest.test.ts` 17 项 + `product-contract.test.ts` 30 项 | §4–§8 |
| 4 | 产品内容验证 | 五角色 authority 精确集合、workflow graph 保真、五 prompt 职责覆盖、QA 禁 LLM 自证、六 tool requirements、validator、五 artifact kinds、risk rule | `product-contract.test.ts` 30 项 | §5–§8 |
| 5 | Pack Framework 集成 | 真实 PackService 成功安装 → 物化（5 Role + 1 WorkflowTemplate，6 非空 ref / 18 null ref）→ 真实 Run 创建 → `packVersions = {dev-company: 1.0.0}` | `tests/sprint16/devcompany-framework-integration.test.ts` 16 项 | §9 |
| 6 | 模型绑定验证 | 经**真实 Model Registry + Router** 解析 developer=`toolCalling`、reviewer=`reasoning`，两个不同 modelKey，写入 `RunSnapshot.modelBindings`；创建后不重解析 | 同上 | §8 |
| 7 | 预 Sprint17 fail-closed | 空 registry ⇒ `PACK_TOOL_MISSING`；全 tool 通过而 validator 能力缺失 ⇒ `PACK_VALIDATOR_MISSING`；均零 durable 写入 | `tests/sprint16/devcompany-pre-sprint17-install.test.ts` 2 项 | §10 |

## 3. Pack Identity（ADR-0024 DATA/CONFIG ONLY）

`packId = dev-company` · `packVersion = 1.0.0` · `name = DevCompany`；`manifestVersion`/`coreApi` 直接引用
Sprint 15 canonical constants。内部代号 **CodeFleet 仅存在于包内注释/文档，不是 canonical manifest 字段**
（`'codename' in DEVCOMPANY_MANIFEST === false`）。fingerprint 由 `packManifestFingerprint` 派生
（`sha256:<64 小写 hex>`，确定性稳定，未 hardcode 进产品数据）。

## 4. Nine Declaration Categories（无第十类）

roles 5 / workflowTemplates 1 / prompts 5 / tools 6 / validators 1 / artifacts 5 / riskRules 1 /
capabilityRules 0 / templates 0 —— **总 declarations = 24**；`capabilities: []`、`dependsOn: []`。
Constitution 强制的六类（Roles/Workflow Templates/Tools/Validators/Artifacts/Risk Rules）全部非空；
CapabilityRules 与 GenericTemplates 按裁定为空（不为凑九类造数据）。

## 5. Five Roles & Authorities（T16-01 §3.2 精确锁定）

| logical key | 角色 | authorities（exact set） |
|---|---|---|
| `dev-company:cto` | CTO | workflow.draft.create, workflow.publish, artifact.create/read, decision.create/read, memory.read, tool.read, validation.read（9） |
| `dev-company:developer` | Developer | agent.execute, tool.invoke/read, artifact.create/read, memory.create/read, handoff.create/read, validation.read（10） |
| `dev-company:reviewer` | Reviewer | agent.execute, tool.invoke/read, artifact.create/read, memory.read, validation.read, handoff.read/accept/reject/create（11） |
| `dev-company:qa` | QA | agent.execute, tool.invoke/read, artifact.create/read, memory.read, **validation.record**, validation.read, handoff.read/accept/reject/create（12） |
| `dev-company:documentation` | Documentation | agent.execute, tool.invoke/read, artifact.create/read, memory.read, decision.read, handoff.create/read（9） |

**无角色持有 `pack.manage` / `secret.*` / wildcard / owner-equivalent**；安装零自动用户分配
（唯一 assignment = bootstrap owner）。

## 6. Workflow & Gates

唯一主 workflow `dev-company:delivery-cycle`，节点 `cto → developer → reviewer → qa → documentation`
（4 条线性边，无 retry loop / deployment / release / CI orchestration / 永久 scheduler）。
每 stage 绑定对应 Role；stage config 仅 frozen 四键（roleId/validatorIds/riskLevel/approval）。
**reviewer 与 qa = `riskLevel HIGH` + `approval {required:true,mode:'owner'}`**（graph-validation 强制
HIGH 必须有 required approval ⇒ runtime 不可绕过）；qa 另带 `validatorIds: ['repo.validation-evidence']`。
CTO 是 requirements/planning/acceptance 阶段，**DOES NOT OWN CONTINUOUS SCHEDULING**（无审批门、无回边）。

## 7. Prompts / Tools / Validator / Artifacts / Risk

- **Prompts**：恰好五个（`dev-company:{cto,developer,reviewer,qa,documentation}-prompt`），仅含
  mission/responsibilities/hard boundaries/expected outputs/evidence requirements/handoff target。
  QA prompt 硬规则：**"NEVER claim a command passed from model reasoning alone"** + 六命令 +
  durable tool/validation evidence。Prompt 是 inert 声明数据，**无 PromptEngine / 无 runtime consumer**。
- **Tools**：六项 declarative requirements（tests/lint/typecheck/build/git diff/git status → Sprint 17
  tool identities `repo.test-runner`/`repo.linter`/`repo.typechecker`/`repo.builder`/`repo.git`）；
  git diff/status 为不同 requirement（共享 toolId，capability null——不为 Sprint17 工具发明词汇）。
- **Validator**：唯一 `dev-company:qa-evidence-validator` → `repo.validation-evidence`（须携带
  `validation:validator` capability；**生产 provider deferred to Sprint 17**）。
- **Artifacts**：五种 kind vocabulary；**安装时创建 0 个 Artifact 实例**（真实实例 per Run 经 ArtifactService）。
- **Risk Rule**：`dev-company:gate-no-bypass`（declarative/provenance）；真正 enforcement 在 stage 级
  `riskLevel + approval`，不得把 Pack RiskRule 本身当作 runtime enforcement authority。

## 8. Model Policy（out-of-manifest companion product policy）

`DEVCOMPANY_MODEL_POLICY`：developer → `toolCalling`、reviewer → `reasoning`、
`reviewerMustDifferFromDeveloper: true`（capability token 派生自 `ModelCapabilityProfile`）。
**NOT in PackManifest / NOT 第十类 / NOT generic Core contract**。真正 authority = Model Registry +
Router + `RunSnapshot.modelBindings`。T16-05 证明：经真实 `deriveRouterPolicyView`（call-site
requiredCapabilities）→ `applyHardFilters`（REQUIRED_CAPABILITIES_FILTER）→ `router.recommend` 得到两个
不同 modelKey，各自 capabilityProfile 满足要求，并写入 RunSnapshot；generic Router 零 DevCompany 特判。

## 9. Pack Framework Integration Evidence（T16-05）

真实链：`DEVCOMPANY_MANIFEST` → real PackService → 受控 test registry → 成功安装 → 物化 → 真实 Run。
PackContentRefs：**total 24 / non-null 6（5 Role + 1 WorkflowTemplate）/ null 18**；tool 行不复制、
validator 不复制、安装零 Artifact 行、零自动分配。`RunSnapshot.packVersions = {"dev-company":"1.0.0"}`
（dependsOn 空，调用方不可注入）。disable ⇒ 新 Run `POLICY_DENIED`、旧 Run pinned 状态不变；
re-enable ⇒ 零重复物化。真实 SQLite close/reopen + fresh graph 后全部保留；packless workflow 仍 `{}`。
受控 test tools **仅存在于测试 fixture registry**（零 tool_invocation、desktop 零引用）。

## 10. Sprint 17 Boundary（诚实声明）

以下 production runtime **未实现，归属 Sprint 17**：Repository / Terminal / Git 可执行 runtime；
tests/lint/typecheck/build 真实执行；real QA evidence validator 生产 provider。
Sprint 16 证明的是：Pack 产品合同、静态合法性、框架安装与物化、Run pinning、模型分离的**绑定层**证明。
**不得**表述为 "DevCompany fully operational end-to-end coding company"；QA 的 AC16.2 是
**contract-level**（要求真实证据 + 禁 LLM 自证），可执行兑现 = Sprint 17。

## 11. Tests（收口时点）

- `pnpm check` 5× PASS（lint/typecheck/boundaries/test/build）；`pnpm test:scripts` 23/23；
  `git diff --check` clean；Sprint 16 touched 文件 UTF-8 有效、0 U+FFFD、0 NUL。
- vitest **127 文件 / 1474 用例全绿**（Sprint 15 收口基线 122/1387 → +5 文件 +87 用例，只增不减；
  零测试删除、零 .skip/.only/todo、零弱化断言）。
- 新增：`packs/dev-company/tests/{manifest,product-contract,boundary}.test.ts`（17+30+22）、
  `tests/sprint16/{devcompany-pre-sprint17-install,devcompany-framework-integration}.test.ts`（2+16）。
- Sprint 13/14/15 既有套件全绿（sprint13/14/15 目录合计 18 文件 314 用例）。

## 12. Known Limitations（诚实记录 — 有意范围/延后，非缺陷）

1. 无 Repository Runtime（Sprint 17）。
2. 无 Terminal Runtime / Git 执行（Sprint 17）。
3. 无可执行 QA validator 生产 tool（Sprint 17）。
4. 无 automatic Pack installation / startup auto-install（安装入口待未来批准）。
5. 无 Pack UI、无 Pack IPC。
6. 无 marketplace / signature / remote import / loader / scanner。
7. 无 Prompt runtime consumer（Prompt = 声明数据/provenance）。
8. 无 RiskRule runtime consumer（enforcement 在 workflow stage 控制）。
9. 无 CapabilityRule 内容、无 Generic Template 内容与 runtime。
10. CTO 完整编排（SOP 选择/微调）deferred to Sprint 18。
11. 六项 tool/validator requirement 的 toolId 为**未来身份候选**，Sprint 17 定稿前可调整。
12. Generic Router 对"两个 stage 必须不同模型"无内置强制：由产品 policy + 绑定层验证表达。

## 13. Deferred Work（只记录，不实现）

Sprint 17 Repository/Terminal/Git runtime + 可执行 QA evidence validator；Sprint 18 CTO Workflow SOP
与编排；未来如批准：Pack UI / Pack IPC / marketplace / signature / remote import。

## 14. Final Record

- **Commit 链**（基线 `fff6491` = tag `sprint-15.0.0`）：
  `8aaa814`（T16-01 产品合同冻结）→ `81274f9`（T16-02 Pack 包 + canonical manifest）→
  `db64189`（T16-03 产品内容验证）→ `78eaccd`（T16-04 边界/隔离/静态安全）→
  `4187444`（T16-05 框架集成 + 模型绑定验证）→ closeout commit（本文，见 `PROJECT_HANDOFF.md`）。
- **Checkpoint/Tag**：`sprint-16`（**annotated**）——roadmap Sprint 16 段 `Git Checkpoint: sprint-16`
  为权威契约；Boss 在 TASK-16-06 明确要求按权威 checkpoint 名创建、不得替换为其它名字。
  历史 tag 采用 `sprint-N.0.0` 形式，本次按权威 contract 使用精确名 `sprint-16`（recon 记录见
  `PROJECT_HANDOFF.md`；未 push）。
- T16-01–T16-05 全部 CLOSED（逐 Task 独立 commit + review）；T16-06 = 本文 + 架构审计 + 文档收口 +
  最终回归 + checkpoint。
- **Sprint 17**：`pending`（Repository Runtime），未经批准不得开工。
