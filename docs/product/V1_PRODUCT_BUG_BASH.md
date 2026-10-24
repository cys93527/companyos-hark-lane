# COMPANYOS V1 — FINAL PRODUCT BUG BASH（功能 Client/Core/DSH）与发布候选状态

状态：**FUNCTIONAL_PRODUCT_BUG_BASH = PASS（本主机）**；**VISIBLE_NON_HEADLESS_WINDOWS_SMOKE = EXTERNAL_BLOCKED**；**PRODUCT_FINAL_GATE_READY = NO**（仅被可见冒烟阻塞）。
基线：c52148f。本文件由 Final Product Bug Bash 执行轮次写入/更新；不宣告 V1 冻结。

## 0. 主机与环境裁定（承接原生崩溃取证）

- 本主机（Windows 10.0.22631 x64，RTX 4060 Ti + GameViewer Virtual Display Adapter）复现机器级 Chromium GPU 进程 AV（0xC0000005）→ 浏览器进程 0x80000003 退出（exit 3）。
- 决定性对照：repo 外最小 Electron 44.5.1 可见应用（零 CompanyOS 代码）两次运行全部同崩 → **HOST_ENVIRONMENT**，**COMPANYOS_SPECIFIC_EVIDENCE = NO**（Boss 已裁定 ACCEPTED）。
- 本主机可见 Electron 测试被 Boss 明令禁止继续（不改 GPU 配置、不禁用 GameViewer、不加 GPU 旗标、不升降级 Electron）。
- 功能 Bug Bash 按既有已接受路径执行：真实 Electron main + preload + renderer DOM + node:sqlite + 真实规划器 + 真实嵌入式 DSH + 真实 canonical 运行时（无 CLI 驱动推进）。

## 1. BB1 — 通用知识/数据工作（PRESERVED，不重跑）

- Goal：`run_01M462NGYQZ9XD3HEWRWCXJ498`（执行运行 `run_f0b7bb641dd0e9a2c4bf5bf1e0`），userData `companyos-bb-ud`（已归档至 `companyos-crash-forensic/bb1-archive/`）。
- 链：plan → 2 work tasks（各 1 attempt，动态角色 drole_e673dec44c19fc…/drole_fee0849191cde0…）→ 2 个 blocking `evidence.grounding-check` **PASS** → Handoff `ho_exa_960d3bf8e…` READY → run.delivered/completed。
- Oracle PASS：report.md 全部事实与 fixture 一致（5 单、总额 5365、delivered/pending/cancelled=4085/850/430、区域 1630/1525/2210、最大 A-1004=2210、备注三线全对）。
- 人工干预 0；wall ≈ 101s。

## 2. 工作区切换取证与修复（WORKSPACE_SWITCH_TARGET_CONSISTENCY）

发现（BB2 准备期）：在会话内对已打开 A 的运行时 `workspaceOpen(B)` 被引擎拒绝（`REPOSITORY_WORKSPACE_ALREADY_OPEN`，V1 单活动工作区为**有意设计**），而 Settings/Composer 的「更换工作空间」仅弹出选择器后**丢弃所选路径**——用户意图被静默吞掉，无显式拒绝（Boss 临时分类 P1 PENDING FORENSIC）。

取证结论（架构缝）：
- CANONICAL_WORKSPACE_OWNER：引擎 `createWorkspaceManager`（单活动、进程内、T17-07 租约守护 close）。
- OPEN 缝：IPC `companyos:workspace-open`；GOAL 绑定：`goal.create` **不接收渲染进程工作区**，运行锚定 canonical `currentWorkspace()`（anchorIdentity→workspaceId；内核 fs-sandbox 以 canonical 根为界）——渲染进程陈旧值**不可能**改写执行目标。
- UI_DISPLAY_SOURCE：Settings「当前工作空间」与 composer 均源自 canonical 读回（`workspaceCurrent`），仅在 canonical 成功后更新。

裁定：**P1_FIXED**（错误工作区变异可能 = NO—— accident 期间 显示A=canonical A=执行A，从不假显 B）。

修复（最小因果）：
- 新增 canonical 切换命令 IPC `companyos:workspace-switch`（main 进程，`apps/desktop/src/workspace-switch.ts`）：close（租约守护，失败则 A 保持 canonical）→ open B → 失败则**先恢复 A 再报错**（fail-closed 原子）；成功写 persisted selection。拒绝码取引擎 `details.reason`（如 `REPOSITORY_ROOT_MISSING`）。
- Renderer：Settings 与 Composer 共用 `changeWorkspace`：选择器 → `workspaceSwitch` → 成功仅从 canonical 结果更新显示；失败显示 typed 拒绝（「无法切换…已保持在当前工作空间」）。
- 预加载白名单 + channels.ts + parity 测试同步。

测试：`apps/desktop/tests/workspace-switch.test.ts`（WS-02 成功 A→B canonical B；WS-03 租约拒绝 A 保持+typed 错误；fail-closed 恢复 A；同根幂等；空根拒绝）+ channels parity（10/10 PASS）。

复现（真实客户端，新 userData `companyos-repro-ud`，ws-a/ws-b）：
- WS-01 打开 A → canonical A → Settings 显示 A = canonical ✓
- WS-03 拒绝路径：switch 到不存在目录 → `{ok:false, error:REPOSITORY_ROOT_MISSING}`，canonical 保持 ✓
- WS-02 成功切换 A→B → canonical B + Settings 显示 B（match=true）✓
- WS-06 重启 → boot 从 persisted selection 复原 B ✓
- WS-05/WS-10 代码+结构证明（goal.create 无渲染工作区字段；显示仅从 canonical 结果更新）

## 3. BB2 — 小型软件工作（multiply 缺陷修复）

- 工作区：全新 `companyos-bb2-ws`（package.json + src/math.ts `multiply` 返回 a-b 的确定性缺陷 + tests/math.test.ts 断言 multiply(4,3)=12——初始 `node --test` 确定性 FAIL）。
- 进入方式：**canonical switch** 到 bb2-ws（WS-04 活证：切换后 Goal 执行于 B）。
- Goal：`run_01M465E3NK45NW8REZB3EMHJ0T`（执行运行 `run_54a8bb74def110a434dc9b7e37`），真实 UI 提交（工作区操作）。
- 链：plan → 2 work tasks（各 1 attempt，动态角色 drole_b4c5cad6…/drole_36ca11b9…）→ **409 次 kernel 工具调用**（真实 DSH：编辑 + 测试执行）→ 2 个 blocking `evidence.grounding-check` PASS → Handoff READY → delivered/completed。Wall ≈ 6m53s。人工干预 0。
- Oracle PASS：`multiply` 改为 `a*b`（multiply(4,3)=12 ✓）；`add` 原样 ✓；`node --test tests/math.test.ts` **4 pass / 0 fail**（模型还补充了 0/负数用例）；`VERIFICATION.md` 独立复核报告（只读审阅、逐条复算）。

### 验证器审计（BB2）
- 映射（记录于 compiled work node）：`goalWorkProfile.validatorIds = ['evidence.grounding-check']` → 两个 work item 均 grounding-check（blocking，均 PASS）。
- **SPECIALIZED_SOFTWARE_VALIDATION_PRESERVED = YES**：软件验证由真实测试执行承载（kernel 内 `node --test`，409 次工具调用 + executor.tool_invocation_requested 持久证据）+ 独立复核角色产出 VERIFICATION.md；grounding-check 校验的是交付物事实声明与工作区的一致性，**没有替代**测试执行。
- 架构未退化证据：validatorIds 是 per-profile 声明（引擎无通用写死）；`TOOL_CAPABILITY_VALIDATOR` 工具缝开放（grounding 即由此注册）；repo-QA（`repo.validation-evidence`→`resolveQaEvidenceCause`）与 review-finding 纠正因路径原样（autonomous-supervisor 128 项 + fixture 全绿）。V1 部署未注册软件专用 canonical validator 工具——这是部署边界（Stage-4 §14.1 已记录），非本 bash 回归。

## 4. BB3 — 权威/失败边界（只读拒绝 → 工作区允许）

- 工作区：全新 `companyos-bb3-ws`（空），canonical switch 进入。
- STEP A（只读）：Goal `run_01M465YJFVNQVB8NR1NXXFAS9K`（执行 `run_d96179674e1a11c10abaeb2e65`）要求创建 result.txt。
  - canonical 证据：run-goal 工件持久绑定 `accessPolicy: "READ_ONLY"`；内核只读模式下模型的 `write` 工具调用全部被拒（8 次 executor.tool_invocation_requested 持久记录）；
  - 结果：3 个 attempt 全部有界失败（600s 帽）→ 工作任务 FAILED → 执行运行/Goal **FAILED**（诚实失败，无假 COMPLETED）；**工作区始终为空**（零变异）；driver 终态 `NON_RECOVERABLE_FAILURE`（有界，无循环）。Wall ≈ 31min。
  - READ_ONLY_AUTHORITY = PASS；UNAUTHORIZED_MUTATION = NO。
  - 观察记录（P3，非阻塞）：只读拒绝在 attempt 层表现为 TIMEOUT/INVALID_OUTPUT 而非专门的 authority-refusal 码——真实但诊断性较弱；拒绝本体由内核强制、canonical、可审计。
- STEP B（工作区操作）：新显式 Goal `run_01M467S7EB9142FN50RZC8XJEA`（执行 `run_a75d4e6573b0544e56aafc4b3e`），经真实访问选择器切到 工作区操作 后提交。
  - 结果：2 work tasks（各 1 attempt）→ `result.txt` 写入工作区（内容逐字 `CompanyOS authority test`）→ 2 个 blocking grounding-check **PASS** → delivered/completed。Wall ≈ 60s。工作区外零写入。

## 5. 恢复（PHASE D）

- BB3 STEP B 完成后完全关闭（Electron 进程数归零）→ 重启（accepted headless 路径，同一 userData）：
  - canonical 工作区 bb3-ws 从 persisted selection 复原 ✓；autonomy resume=0（全部终态，正确）✓
  - 重启前后投影**逐字段一致**：Goal 状态/执行运行状态/2 条 Validation（同 id）/Task 行/事件链 ✓
  - Goal 运行总数 = 3（BB2 + BB3 deny + BB3 allow），**零重复** ✓
- 附加活证：PHASE A 复现中一次真实重启复原（切换后的 ws-b 经 persisted selection 复原）。

## 6. 审计汇总（PHASE E–H）

- 自治：BB1/BB2/BB3 全程 0 人工 Continue/分解/选角色/重试；driver 每 Goal 恰一次启动（共 3 次：2×COMPLETED + 1×NON_RECOVERABLE_FAILURE 即 BB3-A 诚实失败）；provider/invalid-output 重试有界（2×INVALID_OUTPUT）；无 busy loop、无 submission replay、无重复 Task/Validation/settlement。
- 纠正回归（PHASE F）：确定性纠正 fixture `stage4p1-corrective-fixture` 3/3 PASS（FAIL→finding→纠正→独立复验 PASS→Outcome）。live Goal 均首试成功/诚实失败——按 Boss 预授权不制造 live 纠正。
- 安全/真相（PHASE G，活体检查）：渲染进程 `require`/`process` = undefined（contextIsolation 生效）；bridge 恰 11 个 typed 方法（无通用 FS/SQLite/密钥面）；artifact 面活体：traversal id / 未知 id / 未知操作 → 全 typed 拒绝；`PREVIEWABLE_KINDS` 白名单内 kind 预览 ok=true，之外 typed `ARTIFACT_PREVIEW_UNSUPPORTED`；Settings 显示工作区 = canonical 工作区（match=true）；authority 内核层强制（BB3-A，`accessPolicy:"READ_ONLY"` 持久绑定 + 零变异）。
- 遥测（PHASE H，活体弹层）：上下文 128,000（catalogue 已知值）；剩余/已使用/生成速度/缓存命中/会话费用 全部 `--`，附显式文案「暂无可用遥测（未知值显示 --）」；无假 0、无假百分比、无推断缓存命中。

## 7. 结论

- FUNCTIONAL_PRODUCT_BUG_BASH：**PASS**（BB1 保留 + BB2 + BB3 + 工作区一致性修复 + 恢复）。
- Open Product P0 = 0；Open Product P1 = 0（工作区切换 P1 已修复并回归）。
- **PRODUCT_FINAL_GATE_READY = NO**——唯一阻塞：VISIBLE_NON_HEADLESS_WINDOWS_SMOKE = EXTERNAL_BLOCKED（主机环境，另机执行）。

## 8. BB2 专项验证终极取证（SOFTWARE_SPECIALIZED_VALIDATION_CANONICALITY，提交轮追加）

Boss 裁定 BB2 报告的矛盾（"仅 evidence.grounding-check" vs "SPECIALIZED=YES"）需证据裁决。

### 8.1 取证结论（Rule B：P1 成立）
BB2（run_01M465E3N…）canonical 真相：
- 编译节点 validatorIds 确实**仅** `['evidence.grounding-check']`；
- grounding 验证报告 `checkedPaths:0, checkedRows:0`——**空洞 pass**，对软件行为零断言；
- VERIFICATION.md 由第 2 个 work task（模型角色，独立 kernel 会话）写出——**模型工件，非 canonical 验证权威**；
- "tests pass" 的最终归属=实现任务自身的 pwsh 执行+复核角色重推导——均非独立 canonical 验证。
→ **P1 真实缺口成立**（Boss Rule B）。

### 8.2 修复（最小、全既有机制）
- **新专用验证器工具 `repo.test-check`**（packages/engine/src/validation/repo-test-check-tool.ts，沿用 evidence-grounding-tool 的 ToolPort/record/validator-output 契约）：验证时**亲自执行**工作区自声明的测试契约（package.json scripts.test → `npm test`）——实现的自报与本轮运行一概不采信；无测试契约 fail-closed。进程执行走组合注入端口（apps/desktop/src/repo-test-process.ts：**常量命令** `npm test`、ADR-0028 D12 环境白名单、有界输出、组合武装 deadline——引擎无定时器）。
- **确定性选择**：WorkProfile 新增 `validatorIdsByTaskKind`（同一 closed set）；control-plane 规格构建经 `validatorIdsForTaskKind(profile, taskKind)` 一行选择——输入仅有部署策略+闭集 kind，零文件名/目标文本/角色名信号。软件 kind=`companyos:software-work`（部署声明，validatorIds=['repo.test-check','evidence.grounding-check']，grounding ADDITIVE）；默认 kind 映射不变（SV-06）。
- **约束生成分类**：部署声明 kinds 时，planner 输出契约派生 taskKind REQUIRED + 闭集 enum（结构化输出保证分类确定性；prompt 同步广告闭集）；control-plane 仍按同一闭集校验。kind 全链贯通（stage handler/provider seam/route/repository-capable）。

### 8.3 测试（SV-01..10 + PART E）
`apps/desktop/tests/software-validator-selection.test.ts` 13/13 PASS：SV-01/02（软件 kind→['repo.test-check','evidence.grounding-check']，additive）；SV-03/03b/04/05（自报不可 PASS、超时 FAIL、失败契约 FAIL、修正后 PASS——注入端口）；PART E **真实进程端口**（npm test 实跑：multiply 错→FAIL、修正→PASS）；SV-06/07/08（默认映射不变/无字符串信号/确定性）；SV-09/10（同一 TOOL_CAPABILITY_VALIDATOR 注册契约/组合单点接线）。

### 8.4 BB2 重跑（PART F）——验证链全通，纠正轮被 provider 挂起阻塞（诚实非终态）
- 全新净仓 bb2r-ws（初始 multiply 缺陷+确定性失败测试）+ 新 userData；真实 UI 提交。
- **约束分类生效**：3/3 plan items 声明 `taskKind=companyos:software-work`；编译 SPEC validatorIds=`["repo.test-check","evidence.grounding-check"]`（3/3）。
- **专项验证器真实运行且抓到真实缺陷**：实现模型修了 multiply（a*b）并补了测试，但其自增的 commutativity 用例存在 `−0 ≠ 0` 边界缺陷——`repo.test-check` 亲跑 `npm test` 判 **FAIL**（8 pass/1 fail）；每 item 3 组 durable FAIL 行；grounding 各自 pass（additive）。
- **治理链全通**：validation.recorded ×6 → `run.validation_failed` → `run.rework_ready`（证据门/REWORK 语义对专用验证器原样生效）。
- **纠正轮未完成（诚实阻塞）**：REWORK 后 supervisor 轮先提出非法 CONTINUE（语义校验拒绝、零假决策），一轮受控重启后 autonomy resume（resumedRuns=1）再试时 **provider 调用挂起**（supervisor executions RUNNING 超 600s attempt 期限未结算）；driver 按 40-step 预算**有界停止**（`AUTONOMY_BUDGET_EXHAUSTED`，无 busy loop、无假完成）。Goal 保持非终态 EXECUTING（真值保留）。
- 结论：**专项软件验证 canonicality 缺口已修复并有活体 FAIL 证据**；BB2 重跑的 COMPLETED 未达成——阻塞点是纠正窗口内 supervisor 模型提案可靠性 + provider 挂起未按期限结算（新发现，非本 P1 范畴）。

### 8.5 Backlog 追加（对账）
- **READ_ONLY_MUTATION_FAILS_TOO_LATE = P2**（BB3 只读拒绝耗 3 attempts/31min 才诚实失败；authority 可预知却消耗 provider attempts；不修，挂起）。
- **SUPERVISOR_CORRECTIVE_WINDOW_RELIABILITY = P2**（REWORK 窗口内 supervisor 模型未在预算内提出合法 REQUEST_CORRECTIVE；且 provider 挂起时 attempt 期限未结算 RUNNING 执行。有界、真实、无假真值——确定性纠正 fixture 仍是权威负路径覆盖；V1 安全理由：无假成功、无重复、无越权）。
- Open Product P0=0；P1=0（canonicality 已修复验证）。

## 9. V1 RELEASE BLOCKER CLOSURE（F1–F4，提交轮追加）

Codex 独立发布审计裁定 4 个 P1：F1 SUPERVISOR_CORRECTIVE_WINDOW_RELIABILITY、
F2 PROVIDER_TIMEOUT_SETTLEMENT_STUCK_RUNNING、F3 SOFTWARE_VALIDATOR_AUTHORITY_CONTAINMENT_BYPASS、
F4 GOAL_WORKSPACE_BINDING_NOT_DURABLE。本轮回合全部在既有 canonical owner 内闭合（零第二真相）。

### 9.1 F4 — 持久 Goal 工作区绑定（CLOSED；第二轮复审残留竞态已闭合）
- **Owner/表示**：goal.create 将 **不透明 workspaceId**（`sha256:<root>` 规范身份）写入 run-goal
  structured payload（与 accessPolicy 同一持久真值；绝不出现本机路径——通过 run-goal 内容守卫）。
  绑定源=MAIN 进程 canonical 活动工作区；渲染器载荷无工作区字段且被忽略（F4-08）。
- **解析**：执行 dispatch 前与验证器调用（repo.test-check/grounding）统一走
  `resolveRunWorkspaceContext(runId)`：读 Goal→绑定并对照当前打开工作区；**不匹配 fail-closed**
  （typed GOAL_WORKSPACE_MISMATCH，attempt 记录真实失败消息）；无绑定 → GOAL_WORKSPACE_NOT_OPEN
  （goal.create 本身拒绝——无工作区不建 Goal）。
- **TOCTOU 闭合（第二轮 Codex 复审）**：绑定只解析**一次**并贯穿该次执行——`workspaceOf` 返回
  入口处钉住的 `runContext.root`（执行期不再二次读取全局 currentWorkspace）；grounding 验证器
  生产接线 `resolveRunContext`，其读取只走绑定根（resolver 已接线时全局 holder 不再是回退：
  无绑定即 typed GOAL_WORKSPACE_NOT_BOUND），切换工作区无法把执行/验证重定向到另一工作区。
- **测试**：F4 集成（切换 B 后 Goal A 拒绝执行、执行器从未触及 B、新 Goal 绑定 B、重启后绑定持久、
  stale 渲染值不入持久载荷）；sprint26/agentic 夹具全部改为"先开工作区再 goal.create"。

### 9.2 F3 — 验证器权威/工作区遏制（CLOSED；第二轮复审后含链接遏制与依赖保真）
- **策略源**：Goal 的 accessPolicy + 绑定工作区（run-scoped context，F4 同一解析器）。
- **遏制机制**：`repo.test-check` **绝不在用户 canonical 工作区上执行**——每次验证在**有界快照副本**
  （新临时目录，运行后删除）中运行工作区自声明测试契约。
- **链接遏制（第二轮 Codex 复审 F3 残留：cpSync 逐字复制链接的逃逸）**：快照改为**手工有界复制**，
  永不保留出界链接——工作区内 **symlink/junction 解析落界内则物化真实内容**（穿链写入留在快照内），
  **落界外/悬空/成环 → typed 拒绝**（VALIDATION_ENVIRONMENT_UNAVAILABLE +
  snapshotReason=WORKSPACE_SYMLINK_ESCAPES_ROOT/UNRESOLVABLE/CYCLE），拒绝发生在任何进程启动前。
- **依赖保真**：`node_modules` **纳入**快照（此前排除会让已装依赖项目误判 FAIL）；仅 VCS 元数据
  `.git` 排除。快照上限 150,000 文件 / 1 GiB（可注入测试缝），超界 → typed
  VALIDATION_ENVIRONMENT_UNAVAILABLE + snapshotReason=SNAPSHOT_BOUND_EXCEEDED（绝不部分执行）。
  诚实边界：绝对路径写入属进程 OS 权限问题（快照无法沙箱化），快照保证的是"副本内不保留任何出界链接"。
- **测试**：F3-01..15（cwd 内写/父目录逃逸/策略上下文/正常 npm test/契约失败 CANONICAL FAIL/
  无契约 fail-closed/不匹配零执行/内部 junction 物化/外部 junction typed 拒绝+零执行+目标字节不变/
  嵌套外链不可洗白/node_modules 依赖通过/超界 typed 拒绝）13/13 + 集成。

### 9.3 F2 — 超时→持久结算（CLOSED）
- **缺口（根因）**：调用者 signal 已到 adapter fetch，但 **catalogue preflight 的
  `registry.models→provider.listModels()` 未携带 signal**；且 `models()` 会把 provider 的
  CANCELLED **误分类为可重试 AGENT_UNAVAILABLE**（放大挂起）。
- **修复**：port/registry/adapter 全链 `listModels(signal?)` 贯通调用者取消；`models()` 对 CANCELLED
  原样透传（不洗白）；invoke 在 preflight 后、调 provider 前检查 `signal.aborted` → CANCELLED 即返。
  启动恢复既有 RUNNING→INTERRUPTED 语义不变。
- **测试**：F2-01..04 registry 级（挂起目录以致命期限返回 CANCELLED·有界、signal 达到 listModels、
  preflight 期间取消则 provider 零调用、正常路径不变）+ F1+F2 组合生产级回归（挂起→无 RUNNING 残留、
  无假 COMPLETED、有界、恢复后行为真值）。

### 9.4 F1 — 纠正窗口 supervisor 可靠性（CLOSED：机制 + 再验证锚定 + 有界真值）
- **法律窗口派生**：`allowedActions` 由 canonical 生命周期派生（blocking → [REQUEST_CORRECTIVE,ESCALATE]；
  完成证成 → [CONTINUE,COMPLETE]；否则三动作窗口），并驱动**结构化输出模式 action 枚举收窄**与
  system prompt 的当前合法集陈述；validateProposal 仍是唯一权威（零 prompt 法律化）。FINALIZING
  （完成证成且有 durable provenance）窗口收窄为 **[COMPLETE]**——CONTINUE 在该相位无工作单元、其
  应用会硬停；窗口即应用会执行的真值。
- **验证上下文=同一派生（第二轮 Codex 复审）**：context 的验证投影改为
  **每 validator 最新行（latest-per-validator）且排除已消费失败**——不再取任意 `listByRun()[0]`
  （同批另一 validator 的 PASS 行可能掩盖失败，反之亦然）；`validationPassing`/blocking 条件/
  `blockingValidations` 全部来自这同一集合，corrective 合法性（validateProposal）也改为
  **只接受 blockingValidations 中的可执行失败行**（已消费的不再可作 cause）——投影、合法性、应用器
  三方零分歧。
- **ref 语法修复**：program 通告的 pattern 原为 `art_val_|artifact:art_`（**val_ 永不可匹配**）——修为
  `^(art_|val_|artifact:art_)`，与 canonical 解析语法一致。
- **已消费 cause 规则（应用器侧闭合）**：失败验证行已有引用它的纠正子任务（血缘 causeEvidenceRefs
  命中）为 **CONSUMED**——既不阻塞 CONTINUE，也**不被证据应用器重放**：纠正轮完成后 run 回到
  VALIDATING 时应用器不再发 VALIDATION.FAIL（旧行为会抢先推进 REWORK，使"对纠正后代的再验证"永远
  没有机会发生，最终 REWORK.EXHAUST）。已消费失败既不算失败也不放行——门等待**再验证批次**
  （ok(null)），再由 VALIDATING 门单元对**纠正子任务**的最终工件执行**新批次**（新 commandId=新行）。
- **EXECUTING 门**：全部 pinned 工作 terminal-successful 而 run 仍在 EXECUTING（如纠正轮在门阶段外完成）→
  门推进发引擎自身 `EXECUTION.COMPLETE`（此前会 `AUTONOMOUS_NO_LEGAL_WORK` 循环烧预算）。
- **有界非法提案（预算已持久化）**：连续 ≥3 次 `SUPERVISOR_PROPOSAL_*` 语义拒绝 → typed
  `SUPERVISOR_INVALID_ACTIONS_EXHAUSTED` 终止。预算**由 durable 行派生**（supervisor 身份 FAILED
  INVALID_OUTPUT 且 traceId 不匹配任何已记录 Decision 的**尾随连续段**；合法轮——其 execution
  COMPLETED 或与 Decision 同 traceId——durably 重置）——跨 autonomy 调用不重置（纯函数
  `consecutiveIllegalProposalCount` 单测 + 生产级三次跨调用回归）。
- **生产组合纠正集成回归（REQUIRED，零手工注入）**：真实组合——软件 WorkProfile→defective 执行→
  `repo.test-check` 真实 FAIL（第 1 批）→合法 REQUEST_CORRECTIVE（引用验证行）→纠正子任务 provision+
  执行（磁盘上 `a*b`）→**第 2 批**对**纠正后代的工件**（targetRef=纠正子 stageOutput artifactRefs[0]）
  →PASS→grounding 同批再跑→证据门→Handoff/Outcome→**Goal COMPLETED**；断言：恰好 1 个
  REQUEST_CORRECTIVE、旧 FAIL 历史留存但未被再应用（causeEvidenceRefs 命中旧行、不命中新行）、
  run.delivered=1、无 rework_exhausted。
- **多轮真耗尽回归**：缺陷始终不修（correctiveFixes=false）→每轮对**对应后代工件**产生**各自新批次**
  （targetRef 两两不同、全部诚实 FAIL）→轮数上限后 PAUSED（无假 COMPLETED、无 delivered）。
- **F1+F2 组合**：supervisor 模型不可用→回合以 durable CANCELLED 结算（无 RUNNING 残留、无假决策）；
  冻结 §28（CANCELLED attempt 终止，不自动重入）下 run 停在 EXECUTING 待人工 resume——有界、无忙轮。

### 9.5 真实软件 Goal E2E（headless 已接受路径；本轮复跑记录）
全新 userData + 全新小型仓（multiply 缺陷，`node --test` 契约）→ 真实 UI 提交（deepseek-v4.1-flash，
WORKSPACE_OPERATIONS）→ **Goal COMPLETED / 执行 run COMPLETED**（run_01M4950KZ… / run_8c6a8fc9…，
墙钟 ≈13 分钟）：
- 事件链全 canonical：goal run `started→snapshot_pinned→plan_ready→route_resolved→delivered→completed`；
  执行 run `execution_done→review_passed→validation_passed→delivered→completed`。
- 约束分类生效：软件 item 走 `companyos:software-work`；验证 **repo.test-check PASS + grounding PASS**
  （各 artifact 独立 durable 报告：companyos/repo-test-check-report + companyos/evidence-grounding-report）；
  第二个 item（默认 kind）grounding PASS——per-kind 验证器映射 live 生效。
- 独立 oracle：工作区 `node --test` **7 pass / 0 fail**（multiply(4,3)=12 且 add 保持并补了回归用例；
  实现还把 `−0` 乘积归一为 `+0`）；handoff=READY；run-goal 绑定工件在案（F4）；本 run 对 stale
  RUNNING=0；人工继续=0。
- 部署注记：当日上游模型显著变慢（kernel 回合 ~5 分钟/次），按既有 typed 部署旋钮
  `COS_EXECUTION_ATTEMPT_TIMEOUT_MS=1800000` 执行（前一轮 E2E 在 600s 默认下即完成；非代码改动）。
- 同日纠正窗口实测（负空间证据）：两个更早的 Goal 真实走到 grounding FAIL→REWORK（纠正语义 live
  生效、应用器不再重放旧 FAIL），随后进入 §9.6 NEW 的纠正窗口 supervisor 回合爆发（上游对 supervisor
  类调用不响应）→ 两个 Goal 有界停止（AUTONOMY_BUDGET_EXHAUSTED）、零假真值、重启恢复
  RUNNING→INTERRUPTED 后按 durable truth 恢复；E2E 最终以本 Goal 的全绿 COMPLETED 为准。

### 9.6 剩余 backlog（truthful）
- **CLOSED（本轮）**：`SUPERVISOR_CORRECTIVE_WINDOW_RELIABILITY` 的两部分均已闭合——再验证批次锚定
  （§9.4：应用器消费规则 + 新批次对纠正后代工件）与 provider 挂起回合的持久结算（§9.3 F2）。

### 9.7 F5 — supervisor in-flight 有界结算 / autonomy single-flight（CLOSED）
Boss 裁定 §9.6 的"纠正窗口 supervisor 回合爆发"为 **P1 release blocker（F5）**；本轮在既有 canonical
owner 内闭合（零第二调度器、零影子锁、零 provider 定制）。

- **根因（durable 行取证，非 HTTP 症状推断）**：supervisor turn 对其 deferred 执行**没有结算所有权**。
  生产爆发的确切链：模型提案被 Decision 权威**拒绝**（引用了 durable truth 中不存在的 evidence
  artifact）→ `recorded.ok=false` 的 return 路径**不结算执行行** → 悬空 RUNNING；同一 turn 身份的
  replay 查找落空（无 Decision 可重放）→ 每次 autonomy step 都把同一逻辑轮当作**新执行**重启
  （实测 ≈2.5s/步）。次要放大：一次 autonomy run 的**全部 turn 共享一个 traceId**，持久化非法提案
  预算的 decision-trace 重置把同一 trace 的拒绝误判为"合法轮"→ 欠计数。provider 调用本身均成功
  （agent.provider_invoked durable）——泄漏在 turn 的结算所有权，不在网络栈。
- **修复 1（结算所有权，supervisor-runtime turn）**：`prepare` 之后本 turn 拥有该执行行，**每一条**
  return 路径都必须留下终态：sink 拒绝 → FAILED/INVALID_OUTPUT（带 SUPERVISOR_PROPOSAL_SINK_REFUSED
  + sink 的 typed reason，可被持久预算计数）；模型调用结果错误 → 同型结算；abort-after-commit →
  用**真实 provider 结果**尽力 COMPLETED（不虚构：turn 仍报 CANCELLED，Decision 按身份重放）。截止期
  与取消经 **模型调用竞速**（`awaitModelOrDeadline`）先行结算——晚到/永不返回的 provider promise 既
  挂不住 turn 也再无 writer 可达。
- **修复 2（SINGLE-FLIGHT，autonomous-supervisor loop）**：同一 run 存在 durably RUNNING 的
  supervisor 执行（无对应 durable Decision）→ loop **不发新回合**，typed `supervisor_inflight` 停止。
  仲裁例外=冻结的 Task-18-08 崩溃窗契约：执行行的 traceId 已有 durable Decision（`hasDecisionForExecution`
  经 T18-03 reader）→ 该回合按命令身份**零模型调用重放**，不受 single-flight 阻断。无等待、无新恢复
  机制——真崩溃窗仍归启动恢复（INTERRUPTED）。
- **修复 3（预算判据精化）**：FAILED/INVALID_OUTPUT 行**永不**作为 decision-bearing 重置点（decision
  轮必然 COMPLETED）；崩溃窗重置仅对非 FAILED 行的 trace 命中成立。生产组合补接 `decisionHistory`
  （此前 autonomous deps 未接线，预算与仲裁都读不到 Decision 历史）。
- **测试/evidence**：`tests/production/supervisor-inflight-settlement.test.ts` 8/8——
  F5-01（永不返回→deadline 终态结算、RUNNING=0）、F5-02/10（in-flight 期间重复 advance：durable
  执行数/interval 不相交 + provider 调用数=执行数，零重叠）、F5-03（无视取消的晚到结果零写入）、
  F5-04（先取消→恰好一次终态结算）、F5-05（timeout vs 完成竞速→恰好一个赢家）、F5-06（重启→**既有**
  startup recovery 结算 INTERRUPTED，原 composition 的迟到结算被状态机拒绝）、F5-07/09（慢但在限内
  → 纠正链照常 COMPLETED）、INCIDENT（权威拒绝的纠正提案→每轮 durable 结算+持久预算第三次 typed
  `SUPERVISOR_INVALID_ACTIONS_EXHAUSTED`）；纯函数预算判据新增共享-trace 欠计数形状回归。
  **F5-08**（完整 F1 纠正流）由 `corrective-software-validation.test.ts` 全绿覆盖。
- **诚实边界**：不做敌意 provider 沙箱化；不归因网络栈；真崩溃窗（进程死亡）仍由重启恢复结算
  INTERRUPTED——live 结算只覆盖调用仍存活的窗口。
- 其余在案 P2/P3 保留：MODEL_USAGE_ACCOUNTING_INCOMPLETE、INNER_TOOL_AUDIT_PRESTART_ACK_GAP、
  TEST_ENV_HERMETICITY_RISK、STAGE9B_LOAD_SENSITIVE_FLAKE、KERNEL_E2E_ORDERING_INSTABILITY、
  EVENT_RETENTION_ABSENCE、PROVIDER_BOOKKEEPING_EVENT_ACCRUAL、READ_ONLY_MUTATION_FAILS_TOO_LATE。
- **P0/P1 = 0**（本回合目标闭合；9.6 的残留项待 Boss 终审严重度裁量）。
- VISIBLE_NON_HEADLESS_WINDOWS_SMOKE 仍 EXTERNAL_BLOCKED（主机 GPU 环境，见 §0/取证记忆）。
