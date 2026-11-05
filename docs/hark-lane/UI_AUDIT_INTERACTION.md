# UI-REDESIGN — Paper-Ink 交互审计 (INTERACTION_AUDIT)

- 分支：`ui/paper-ink`（基于 `hark-lane` fbd139c），工作树 `lane/wt/ui-paper-ink`
- 日期：2026-11-05 (CST)
- 范围：UI paper-ink 视觉重做 + 交互缺陷修复（renderer）与 main 侧 `approval.respond` / `decisions.pending` 修复（`apps/desktop/src/control-plane.ts`）。
- 未做：merge / push / 截图渲染；无真实模型调用；无新依赖下载。
- file:line 均按提交时的代码核对（行号指向修复处或其 UI-AUDIT 注释）。

## 发现与修复

| id | 严重度 | file:line | 问题 | 修复 | 测试 |
|---|---|---|---|---|---|
| UI-AUDIT-01 | 高 | apps/renderer/src/composer.tsx:259（isSubmitShortcut），:319（onKeyDown） | 输入框回车行为不安全：Enter 直接发送，中文输入法确认候选词的 Enter 会误发送目标 | Ctrl/⌘+Enter 发送，Enter/Shift+Enter 换行；`isComposing` 或 keyCode 229（Chromium IME 确认键）一律不发送；Alt/Shift 组合不发送；`aria-keyshortcuts="Control+Enter"` | apps/renderer/tests/ui-paper-ink-interaction.test.ts「UI-AUDIT-01/02 composer keyboard + empty input」（纯函数 + App 内 Ctrl+Enter 只发一次、组合输入 Enter 不发） |
| UI-AUDIT-02 | 中 | apps/renderer/src/composer.tsx:277（canSend） | 只含空白的输入仍可点「发送」，结果静默无反应 | `canSend` 要求 `draft.trim() !== ''`；按钮与快捷键共用同一判定 | 同上「App: a whitespace-only draft leaves 发送 disabled」 |
| UI-AUDIT-03 | 高 | apps/renderer/src/App.tsx:1141（startNewGoal） | 「新建目标」会丢弃尚未确认的提交意图并清空输入，用户重新提交可能造成重复 Goal | 新建目标不清除未确认提交（保留「上一次提交尚未确认」+ 重试/放弃），不清空草稿；提交进行中时不切换 | 「UI-AUDIT-03 新建目标 keeps an unconfirmed submission and the typed text」 |
| UI-AUDIT-04 | 高 | apps/renderer/src/approvals.tsx:91；apps/renderer/src/App.tsx:929；apps/desktop/src/control-plane.ts:1225-1245 | `approval.respond` 只带 runId：用户看到的审批若已被处理/被新请求取代，决定会落到当前另一条 pending 审批上 | renderer 携带所见审批行的 `approvalId`；main 校验其仍为该 run 的 pending 行，否则返回 `CONFLICT` `APPROVAL_STALE`（含 currentApprovalId），不恢复任何工作；UI 解释为「已被处理或已被新的请求取代」（approvals.tsx:100） | tests/hark/ui-paper-ink-control-plane.test.ts「UI-AUDIT-04 …」（当前行批准、被取代拒绝、已决定行拒绝、非法 approvalId）；renderer「批准 names the approval row…」「a stale approval refusal is explained…」 |
| UI-AUDIT-05 | 高 | apps/desktop/src/control-plane.ts:1247-1256；apps/renderer/src/approvals.tsx:160 | Goal 取消后仍可「批准」，会恢复已承诺不再启动新工作的 run | main：存在持久取消意图时 approve 返回 `CANCELLED` `APPROVAL_GOAL_CANCELLED`（deny 仍允许）；UI：取消后审批只展示、不提供按钮，提示「无需处理」 | tests/hark/ui-paper-ink-control-plane.test.ts「UI-AUDIT-05 …」；renderer「after a cancel request the approval is shown but not actionable」 |
| UI-AUDIT-06 | 中 | apps/renderer/src/App.tsx:202（approvalInFlight） | 快速双击「批准」会发送两次决定 | `useRef` 单飞守卫（不依赖异步 state 更新） | 「批准 names the approval row the user saw; a double click sends ONE decision」 |
| UI-AUDIT-07 | 中 | apps/renderer/src/approvals.tsx:122-170；apps/renderer/src/App.tsx:1127 | 审批卡焦点与主次不清、风险等级显示英文枚举 | 无按钮默认聚焦、无全局批准快捷键；新请求出现时卡片本身（tabIndex=-1）聚焦一次；「批准」为主按钮、「拒绝」为次按钮；风险显示 低/中/高（format.ts:93 riskWord），原等级保留在 title | 「UI-AUDIT-07 approval card focus and emphasis」；riskWord 用例。注：App 的「聚焦一次」effect 依赖 `document.querySelector`，mini-dom 未实现，该 effect 本身未被自动化覆盖 |
| UI-AUDIT-08 | 中 | apps/renderer/src/cancel-control.tsx:60-80 | 取消确认文案不说明待批准操作的结局；默认焦点/Esc 行为不安全 | 有待批准时文案写明「等待批准的操作不会执行」；默认聚焦安全选项「继续执行」；Esc 关闭（忙碌时不响应）；Enter 不会触发取消 | 「UI-AUDIT-08 cancel confirmation」；既有 audit-renderer-cancel.test.ts |
| UI-AUDIT-09 | 中 | apps/renderer/src/App.tsx:1349-1350（横幅），:1338（发送禁用原因） | 数据库失败只在首页显示，其它视图照常可发送 | 数据库失败横幅在所有视图显示；发送禁用并给出原因 | 「a database failure is visible on every view and blocks 发送 with a reason」 |
| UI-AUDIT-10 | 中 | apps/renderer/src/App.tsx:1018 | 打开的 Goal 不在最近列表时页面空白（回退到空提示） | 以打开 Goal 自身的 canonical objective 为准，不依赖最近列表 | 「an open Goal missing from the recent list still shows its own objective」 |
| UI-AUDIT-11 | 中 | apps/renderer/src/App.tsx:459，:1295 | 「首页」与「对话与任务」内容重复 | 拆分：首页 = 开始提示 + 目标列表；对话与任务 = 打开的 Goal；首页发送后自动进入新 Goal | 「首页 shows the start prompt + goal list, 对话与任务 shows the open Goal」 |
| UI-AUDIT-12 | 低 | apps/renderer/src/shell.tsx:42（sortRecentNewestFirst）；apps/renderer/src/format.ts:35（goalStateWord） | 最近列表顺序不稳定、状态显示原始枚举 | 最新在前（有界 30 条）；中文状态词（结束态用 typed outcome 标签） | 「UI-AUDIT-12 sidebar order and state words」 |
| UI-AUDIT-13 | 中 | apps/renderer/src/App.tsx:1197（模型卡），:1340；apps/renderer/src/shell.tsx:280 | 模型卡常驻每个 Goal；设置页配置指引过时 | 仅在未选模型或刚选择后的反馈时显示模型卡；设置/提示文案指向开始菜单「CompanyOS 首次配置」 | 「UI-AUDIT-13/15/19 goal page in the app」（选中模型无卡、未选有卡）；「UI-AUDIT-13/14 settings text」；stage3-client.test.ts:339 |
| UI-AUDIT-14 | 低 | apps/renderer/src/shell.tsx:270-322（SettingsView） | 设置页英文标签、未知值显示 `-` | 中文标签；未知值统一 `--` | 「UI-AUDIT-13/14 settings text」 |
| UI-AUDIT-15 | 低 | apps/renderer/src/App.tsx:178-179；apps/renderer/src/runtime-panel.tsx:383 | 右侧运行面板默认收起，折叠按钮无状态语义 | 默认展开；折叠按钮带 `aria-expanded` | 「a running Goal: right panel open (aria-expanded)…」 |
| UI-AUDIT-19 | 中 | apps/renderer/src/runtime-panel.tsx:326（outcomeWord）；apps/renderer/src/chat.tsx:80 | 运行中的 Goal 显示「结果 · 未交付」 | 结果只对已结束 Goal 显示已交付/未交付；运行中为「进行中」，未知为 `--` | 「a running Goal … its result reads 进行中, never 未交付」 |
| UI-AUDIT-22 | 中 | apps/desktop/src/control-plane.ts:1506-1514 | `decisions.pending` 只看前 100 个 run（子 run 也计数），较早的活跃 Goal 的审批永远不出现 | 与 home.summary 相同的分页遍历全部 run | tests/hark/ui-paper-ink-control-plane.test.ts「UI-AUDIT-22 decisions.pending sees every live run」 |
| UI-AUDIT-23 | 低 | apps/renderer/src/App.tsx:1152；apps/renderer/src/shell.tsx:84 | 侧栏宣称的 Ctrl+N 不生效 | 全局 Ctrl/⌘+N → 新建目标；输入法组合中不触发；不动草稿 | 「Ctrl+N opens a new goal page (no Goal open) and leaves the draft alone」 |
| UI-AUDIT-25 | 低 | apps/renderer/src/composer.tsx:315 | 提交中输入框 disabled，键盘焦点丢失 | 提交中改为 readOnly（+ aria-busy），焦点留在输入框 | 「UI-AUDIT-25 composer stays focusable while sending」 |
| UI-AUDIT-26 | 中 | apps/renderer/src/format.ts:106（sessionCostText）；apps/renderer/src/App.tsx:1085；apps/renderer/src/composer.tsx:375 | 会话费用永远显示 `--`（renderer 自己的模型快照不带币种） | 使用 main 的 canonical usage 投影：带币种（¥/$/€），ESTIMATED 前缀 `≈`，不可证明时 `--`。本次提交把该逻辑从 App 内联抽成纯函数 `sessionCostText` 以便测试 | 「UI-AUDIT-26 session cost」；既有 audit-renderer-session-cost.test.ts |

## 说明（有意为之）

- 占位文字为「描述一个新目标…（Ctrl+Enter 发送）」（composer.tsx:311）：每次发送都会创建一个新 Goal，而非在当前 Goal 内续聊。
- 故意不提供 Alt+Y 等批准快捷键：误触键盘绝不应批准操作（UI-AUDIT-07）。
- designer / registry 视图从导航不可达，本次只做通用样式适配，未做专门设计。
- 编号空缺（16/17/18/20/21/24）不在本审计表范围内；代码中可见 UI-AUDIT-16（riskWord）与 UI-AUDIT-17（已结束 Goal 可把描述带回输入框，不自动发送）的注释，分别随 07 与 chat.tsx:108 实现。

## 本次审计过程中修复的门禁失败

1. `tsc` 失败（6 处 TS2322，apps/renderer/tests/ui-paper-ink-interaction.test.ts 计划步骤用例）：测试夹具对象字面量被推断为联合类型（`RUNNING?: undefined`），不满足 `Readonly<Record<string, number>>`。根因修复：夹具显式标注为 `ExecutionOverviewInput`（源码类型正确，未改动断言）。
2. 审计表中 07/08/13/14/15/19/25/26 原先没有直接测试：补充了 8 组测试；为 26 把会话费用逻辑抽为 `format.ts` 纯函数 `sessionCostText`（行为不变，App 改为调用它，移除 App 中不再使用的 `formatMoney` 导入）。

## 门禁结果（提交前最后一次运行）

| 门禁 | 结果 |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | 0 错误 |
| `npx eslint .` | 0 |
| `node scripts/check-boundaries.mjs` | PASSED（exit 0） |
| `node scripts/check-architecture.mjs` | PASSED，0 violations（exit 0） |
| `node scripts/hark/test-hark-offline.mjs` | 138/138 pass |
| vitest apps/renderer/tests | 27 文件 / 277 测试通过 |
| vitest tests/hark + tests/sprint26/s26-renderer-boundary + tests/architecture + tests/sprint6/boundary + tests/stage9b | 56 文件 / 414 测试通过 |
| vitest apps/desktop/tests | 24 文件 / 266 测试通过 |
| 额外（grep 命中 renderer/control-plane/approval.respond/decisions.pending 等的其它测试）：tests/sprint26（全部）、sprint5/designer-boundary、sprint7/registry-boundary、sprint7-5/selection-policy、sprint9/tool-boundary、tests/agentic、tests/final-audit | 14 文件 / 99 测试通过 |
| 额外：tests/production 中 17 个相关文件 | 全部通过（65 + 36 + 18 + 26 + 7 测试，分批运行） |
| 额外：tests/stage8b、stage8c、stage9/stage9-goal-outcome-autonomy | 35 + 18 测试通过 |
| `cd apps/renderer && npx vite build` | 成功；`apps/renderer/dist/` 被 `.gitignore:9 dist/` 忽略 |

备注：沙箱只有 2 核且负载较高时，`smart-router-production` 与 `v1-reachability` BB-001 在大批量并行中各出现一次 30s 超时；单独/小批量重跑均通过（BB-001 单跑 4.2s），与本改动无关（不触及 renderer/approval 路径）。
