# Sprint 16 — DevCompany Pack 任务分解（T16-01 冻结）

> 状态：**FROZEN**（Task-16-01 输出；线性依赖，逐 Task Boss 批准后执行）。
> 上游：`S16_DEVCOMPANY_PRODUCT_CONTRACT.md`（产品合同）、`docs/EXECUTION_ROADMAP.md` Sprint 16 段
> （Mission / AC16.1–16.3 / Tests / Git Checkpoint `sprint-16`）、`S16_TEST_STRATEGY.md`。

## Scope Ruling（BOSS-FROZEN）

Sprint 16 = deliver first-party DevCompany Pack **product definition**（contract + package + 内容 +
边界/静态合同测试 + 框架集成验证）。**不是** Repository Runtime、Terminal、Git runtime、marketplace、
Pack UI、Pack IPC、自动安装、Prompt runtime engine、Risk rule runtime engine。

## Tasks

### T16-01 DevCompany Product Contract Freeze（**已完成：本目录三份文档**）

- **Goal**：把 Planning Recon 暴露的产品语义缺口一次冻结（身份/五角色/职责/authorities/workflow/
  prompts/tools/validators/artifacts/risk/空类裁定/安装入口裁定/non-goals）。
- **Deliverables**：`S16_DEVCOMPANY_PRODUCT_CONTRACT.md` + 本文件 + `S16_TEST_STRATEGY.md`
  （+ INDEX/roadmap 状态）。零产品代码、零测试代码、零 migration、零 IPC、零 renderer。
- **Dependencies**：Sprint 15 收口（tag `sprint-15.0.0`）。

### T16-02 DevCompany Pack Package & Manifest（**已完成**）

- **Package**：`packs/dev-company/`，name `@companyos/pack-dev-company`（repo 既有 industry-pack
  命名约定 `@companyos/pack-*`，由 boundary gate 的 `@companyos/pack-` 前缀规则印证）；private、
  `type:module`、`sideEffects:false`、dist exports、`tsc -b` composite build；唯一内部依赖
  `@companyos/core: workspace:*`（lockfile 仅新增该 workspace link，零外部依赖增量）。
- **Workspace 接线**：`pnpm-workspace.yaml` 的 `packs/*` glob 本已存在（未改）；新增
  vitest include `packs/*/tests/**` + alias、root tsconfig include `packs/*/{src,tests}` +
  `paths` 映射、`tsconfig.build.json` reference——新包完整参与 typecheck/build/check。
- **Manifest**：`src/manifest.ts` 导出 `DEVCOMPANY_MANIFEST`（`as const satisfies PackManifest`
  ——Core 语义模型 readonly 形状 + contracts canonical parser 运行时验证）。身份
  `dev-company@1.0.0` / name `DevCompany`；version 字段直接用 `PACK_MANIFEST_VERSION` /
  `PACK_API_VERSION` constants（不复制 magic value）。九类：Roles 5 / WorkflowTemplates 1 /
  Prompts 5 / Tools 6 / Validators 1 / Artifacts 5 / RiskRules 1 / CapabilityRules [] /
  GenericTemplates []；`capabilities: []`、`dependsOn: []`（T16-01 未冻结，不发明）。
- **Schema 映射结论（TASK-16-02 recon）**：T16-01 全部产品概念无损映射到 canonical 字段，
  **唯一缺口 = 模型分离无法入 manifest**（canonical schema 无 model capability requirement
  载体）→ Boss 裁定 **OPTION 1**：模型分离是 **DevCompany 产品绑定策略**，不属于 PackManifest，
  不改 Core/contracts、不塞 node.config、不冒充 Tool capability。
- **Model policy**：`src/model-policy.ts` 导出 `DEVCOMPANY_MODEL_POLICY`（inert companion
  product policy：developer 需 `toolCalling`、reviewer 需 `reasoning`、
  `reviewerMustDifferFromDeveloper: true`；capability 名从 `ModelCapabilityProfile` 派生）。
  非第十类、不入 manifest、无 runtime consumer；T16-05 用既有 Model Registry/Router/绑定 API
  验证并在 `RunSnapshot.modelBindings` 记录真实绑定。
- **Tool/Validator requirements**：六个 `dev-company:tool-req-*`（ Sprint 17 tool identities
  `repo.test-runner`/`repo.linter`/`repo.typechecker`/`repo.builder`/`repo.git`）与
  `dev-company:qa-evidence-validator`（`repo.validation-evidence`）均为 DECLARATIVE
  REQUIREMENT：静态 manifest 合法；生产 install 在这些 tool 未注册时 **预期 fail closed**。
- **Dependencies**：T16-01。

### T16-03 DevCompany Product Content Verification & Contract Tests（**已完成**）

- **Goal**：逐项验证 T16-02 交付的产品内容真正符合 T16-01 冻结合同，并补齐内容级测试
  （不重复实现内容；发现偏差只允许改 `packs/dev-company/**` 与 Sprint16 docs）。
- **Content audit 结果（零偏差）**：
  - 五角色 authority 集合与 T16-01 §3.2 **逐项精确相等**（9/10/11/12/9 项；无缺失、无额外）；
    无角色持有 `pack.manage` 或 `secret.*`；manifest 无任何用户身份/分配/bootstrap 字段
    （结构键扫描，`approval.mode:'owner'` 是合法值故只查键）。
  - workflow = 单一 `dev-company:delivery-cycle`，五节点线性链（cto→developer→reviewer→
    qa→documentation），stage→role 精确绑定，stage config 仅 frozen 四键；reviewer/qa =
    `riskLevel HIGH` + `approval {required:true,mode:'owner'}`（不可绕过门的实际强制点）；
    CTO 无审批门、无回边（不是 scheduler）。
  - 五 prompt 职责覆盖全（CTO 九项 + 调度边界；Developer 八项；Reviewer 十项；QA 六命令 +
    禁 LLM 自证 + 需 durable evidence；Documentation 六交付物）。
  - 六 tool requirements（git diff/status 共享 `repo.git` 但为**不同 requirement key**，
    capability 均为 null——不为 Sprint17 工具发明 capability 词汇）；一 validator；五 artifact
    kinds；一 risk rule（declarative， enforcement 在 stage 级，已在测试与文档明确区分）。
- **Tests added**：`packs/dev-company/tests/product-contract.test.ts`（30 项内容矩阵：五角色
  精确 authority 集合、无 pack.manage/secret、无身份字段、workflow 形状与绑定、config 闭集、
  reviewer/qa 门、CTO 边界、五 prompt 覆盖、tool/validator/artifact/risk、九类计数、model
  policy 结构与“不在 manifest 内”、四方一致性）+ `tests/sprint16/devcompany-pre-sprint17-install.test.ts`
  （真实 PackService + 空 registry ⇒ `PACK_TOOL_MISSING`；全 tool 通过而 validator 缺失 ⇒
  `PACK_VALIDATOR_MISSING`；两者均零 durable 写入、无 `pack.installed` 事件）。
- **Dependencies**：T16-02。

### T16-03 Roles / Workflow / Prompt / Validator / Artifact / Risk Content

- **Goal**：按合同落地五角色（logical keys `dev-company:{cto,developer,reviewer,qa,documentation}`
  与 §3.2 authorities）、`dev-company:delivery-cycle` 五 stage 线性链（stage config 仅 roleId/
  validatorIds/riskLevel/approval，无新 key）、五 prompt 合同（含 QA/reviewer 硬边界）、QA evidence
  validator requirement、五 artifact kinds、最小 risk rule。
- **模型分离**：Developer stage = logical `toolCalling`；Reviewer stage = logical `reasoning`；
  默认解析到不同 model binding（既有 Router + `RunSnapshot.modelBindings`；无厂商名、无新 config key）。
- **Dependencies**：T16-02。

### T16-04 DevCompany Package Boundary, Industry Isolation & Static Safety Audit（**已完成**）

- **Goal**：证明 DevCompany 是隔离的 first-party 产品包——只依赖 generic contracts/types、
  不污染 generic Core/Contracts/Engine、只含 inert data、正确参与 workspace/build/test。
- **Audit 结论（全部通过，零 framework corrective）**：
  - **依赖方向**：pack → `@companyos/core`（generic 类型 + canonical constants + 语义校验器，仅此一项
    `workspace:*`）；`core/contracts/engine/persistence/desktop` 的 package.json 与 **全部生产源码**
    对 `@companyos/pack-dev-company` / `dev-company` / `CodeFleet` 零引用；build graph 中 pack 是叶子
    （无 generic 项目引用它）。
  - **行业隔离**：DevCompany 产品词（DevCompany/CodeFleet/CTO/Developer/Reviewer/QA/Documentation）
    在 core/contracts/engine 生产源码的 code-only 视图（注释+字符串剥离，与权威 gate 同语义）零命中；
    既存 `scripts/check-boundaries.mjs`（LAW1/LAW2）继续 PASS，未放宽任何 allowlist。
  - **无特殊路径**：engine 源码无 `'dev-company'` 字面量（无 packId 特判、无专用 union/authority/
    materialization 路径）。
  - **静态安全**：pack src 零 `eval/new Function/node:vm/child_process/exec/spawn/fetch/http/https/
    process.env/node:fs/readFileSync/writeFileSync/require/import(/PackService/.install(/.enable(/
    .disable(`；model-policy 无 Router/ModelRegistry/binding 等运行时引用（仅 doc 注释提及，
    code-only 视图零命中）；无 vendor 名/credential/secret。
  - **Schema 权威**：pack 不复制任何 generic schema/interface（无 zod、无本地 PackManifest 副本）；
    manifest 走 `as const satisfies PackManifest`（Core 语义模型）+ contracts canonical parser
    运行时验证；model policy 以 `ModelCapabilityProfile` 派生 capability token。
  - **Workspace 完整性**：`@companyos/pack-dev-company` 在 package.json / tsconfig paths /
    vitest include+alias / build reference / lockfile importer 五处一致（无第二套命名）；vitest include
    与 root tsconfig include 覆盖 `packs/*/{src,tests}`；`git ls-files` 证明只跟踪源码（dist/
    node_modules/.tsbuildinfo 未被跟踪）。
  - **无 creep**：desktop/IPC/renderer 零改动；migration 仍只有 `0001_pack_persistence.sql`；
    无 marketplace/loader/scanner；无 startup auto-install；lockfile 仅 T16-02 的 workspace link
    增量（零第三方依赖）。
- **Tests added**：`packs/dev-company/tests/boundary.test.ts`（22 项静态矩阵）。
- **Dependencies**：T16-03。

### T16-05 DevCompany Pack Framework Integration & Model Binding Validation（**已完成**）

- **Goal**：真实产品 manifest 走真实 Sprint 15 pack framework 全链（install → 物化 → new-use →
  Run 创建 → RunSnapshot.packVersions/modelBindings），并用**真实 Model Registry + Router**
  证明模型分离策略。
- **Model binding recon 结论**：现有层足够，无 `DEVCOMPANY_MODEL_BINDING_RUNTIME_GAP`。
  `deriveRouterPolicyView({policy, requiredCapabilities})`（call-site 声明能力要求）→
  `assertDerivedPolicyView` → `applyHardFilters`（`REQUIRED_CAPABILITIES_FILTER` 按
  `model.capabilities[cap] === true` 过滤）→ `router.recommend` → `ModelRecommendation.selectedModelKey`；
  `createRun({modelBindings})` 由**可信 application 调用方**提供已解析绑定并写入
  `RunSnapshot.modelBindings`。test harness 即该"trusted binding coordinator"，**不是** production
  runtime consumer（产品包仍 inert，generic framework 零改动）。
- **Integration 结果**：成功安装（identity `dev-company@1.0.0`、status installed、fingerprint 与
  `packManifestFingerprint(DEVCOMPANY_MANIFEST)` 一致）→ 24 个 PackContentRef（6 个非空：
  5 Role + 1 WorkflowTemplate；18 个 null：5 prompt + 6 tool + 1 validator + 5 artifact + 1 riskRule）
  → 5 个 Role 经真实 authorization 物化、**零自动分配** → workflow 物化且 graph 保真
  （stage ids/roleId/validatorIds/riskLevel/approval/edges 与 manifest 一致）→ 新 Run 创建，
  `packVersions = {dev-company: 1.0.0}`（dependsOn 空，无其它 Pack）。
- **模型分离证据（AC16.2）**：developer 需 `toolCalling`、reviewer 需 `reasoning`（token 派生自
  `ModelCapabilityProfile`）；经真实 Router 解析得到两个**不同 modelKey**，且各自
  `capabilityProfile` 满足要求；绑定写入 RunSnapshot 后，unregister 一个模型**不改变**已固定
  绑定（无重解析）。
- **生命周期**：disable ⇒ 新 Run `POLICY_DENIED` 拒绝、旧 Run 的 packVersions/modelBindings/
  workflow 行不变；re-enable ⇒ 同一 installation/refs/roles 复用（零重复物化）、新 Run 恢复。
- **真实重启**：close → 同 dataDir → fresh object graph 重开，PackInstallation/refs/workflow/
  RunSnapshot.packVersions/modelBindings 全部保留。
- **边界保持**：packless workflow 仍 `{}`；generic 生产代码零 DevCompany 特判；Sprint17 runtime
  零新增（受控 test tools 仅存在于 fixture registry、零 tool_invocation、desktop 零改动）。
- **Dependencies**：T16-04。

### T16-06 Sprint 16 Final Architecture Audit / Regression / Documentation Closeout / Checkpoint（**已完成**）

- **Goal**：全量架构审计 + 只增不减回归 + 文档收口 + `docs/SPRINT16_CLOSEOUT.md` + checkpoint。
- **必须准确写明（§54）**：DevCompany Pack product delivered · Pack framework compatibility proven ·
  **Repository/Terminal/Git executable fulfillment pending Sprint17**；不得宣称 fully operational
  end-to-end coding company。
- **审计结论（全部通过，零 closeout defect、零 production defect）**：
  - **Tag/Checkpoint recon**：roadmap Sprint 16 段权威 `Git Checkpoint: sprint-16`；历史 tag 为
    `sprint-N.0.0` 形式（32 个，全 annotated，无 `sprint-N` 形式先例）。按 TASK-16-06 明确裁定
    ——权威 contract 名优先——创建 annotated tag **`sprint-16`**（不替换为 `sprint-16.0.0`）。
    不存在 `SPRINT16_TAG_CONTRACT_GAP`（权威源无歧义；差异为历史惯例 vs 本轮明确指令，已在收口
    文档记录）。
  - **Commit 审计**：`fff6491` 之后 5 个 commit（8aaa814 → 81274f9 → db64189 → 78eaccd →
    4187444）线性可达、无 amend/rewrite、无 detached work、无隐藏 patch。
  - **产品审计**：identity `dev-company@1.0.0`/name DevCompany、codename 非 manifest 字段；
    九类计数 5/1/5/6/1/5/1/0/0（总 24）；六类宪法强制非空；五角色 authority exact-set 与
    T16-01 一致、无 pack.manage/secret/wildcard；workflow 五阶段线性链 + reviewer/qa HIGH+
    required approval + qa validatorIds；五 prompt；六 tool requirements；唯一 validator；
    五 artifact kinds；一 risk rule（declarative）；model policy 三值且不在 manifest。
  - **边界/安全**：generic 生产代码（core/contracts/engine/persistence/desktop src）DevCompany
    引用 = 0；pack src 零动态代码/进程/网络/fs/env/DB/PackService（"bypass" 命中均为描述
    "门不可绕过"的注释/字符串，非授权绕过）；无 allowAll。
  - **测试完整性**：零 .skip/.only/todo、零测试删除、零弱化断言；127 文件/1474 用例
    （Sprint 15 基线 122/1387 → 只增不减）；Sprint 13/14/15 套件全绿（18 文件 314 用例）。
  - **工件**：lockfile 自 Sprint 15 起仅 +6 行 workspace importer/link（零第三方依赖）；
    packs/ 下零 dist/node_modules/.tsbuildinfo 被跟踪。
- **Git Checkpoint**：`sprint-16`（annotated tag，本地；按权威 roadmap checkpoint 名，未 push）。
- **Dependencies**：T16-05。

## Deferred Work（只记录，不实现）

Repository/Terminal/Git 可执行 runtime 与 executable validator tool（Sprint 17）；CTO Workflow SOP
（Sprint 18）；Pack UI / Pack IPC / 自动安装 / startup auto-install（未来批准）；Prompt runtime 接入
（未来批准）；marketplace / signature / remote import；hard uninstall/GC；optional 依赖；semver range。

## Framework Change Expectation（§55）

**确认（T16-02）：Sprint 15 framework changes required = NONE** —— T16-02 零 Core/Engine/contracts
schema 改动（`pnpm check` boundaries + 依赖方向回锁测试证明）。唯一配置增量是 workspace 接线
（vitest/tsconfig globs + build reference + lockfile workspace link），不改变任何框架语义。
