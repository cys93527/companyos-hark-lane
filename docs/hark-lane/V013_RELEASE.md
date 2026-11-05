# CompanyOS Hark v0.1.3 — 「纸与墨」界面重做 + 交互审计修复（Hark 自审）

v0.1.2（fbd139c）之上的界面版本：renderer 视觉整体重做为「纸与墨」浅色设计，并修复交互审计发现的 20 项问题（其中审批相关 3 项在 main 进程 `apps/desktop/src/control-plane.ts` 修复）。引擎、执行器、隔离与安装逻辑与 v0.1.2 相同。本版本无真实模型调用、无新依赖。仅 Hark 自审；普通用户真机验收与独立评审仍由用户/评审方执行。安装包未做代码签名（SmartScreen 会提示「未知发布者」）。

## 内容
- **38071cf 「纸与墨」浅色界面**：暖灰纸面 + 墨黑文字 + 唯一强调色「朱」（只表示“正在进行 / 需要你处理”）；层级靠字重、字号、灰度和 1px 细线，无卡片阴影、无彩色状态徽章。设计记录 [UI_PAPER_INK.md](./UI_PAPER_INK.md)。
- **交互修复（UI-AUDIT 01–15/19/22/23/25/26，全文 [UI_AUDIT_INTERACTION.md](./UI_AUDIT_INTERACTION.md)）**，主要包括：
  - Ctrl/⌘+Enter 发送，Enter 换行；中文输入法组合中（`isComposing` / keyCode 229）不发送；空白输入不可发送。
  - `approval.respond` 携带用户所见审批的 `approvalId`，main 校验其仍为当前待批准行，否则返回 `CONFLICT APPROVAL_STALE`，不会把决定落到另一条审批上；批准单飞（双击只发一次）。
  - Goal 取消后不再允许批准（`CANCELLED APPROVAL_GOAL_CANCELLED`，UI 只展示「无需处理」）；取消确认说明待批准操作不会执行，默认焦点为「继续执行」。
  - 数据库失败横幅在所有视图显示，并禁用发送、给出原因。
  - 全局 Ctrl/⌘+N 新建目标（不丢草稿、不丢未确认提交）。
  - 会话费用改用 main 的 canonical usage 投影（带币种，估算加 `≈`，不可证明时 `--`）。
  - `decisions.pending` 与 home.summary 相同分页遍历全部 run，较早 Goal 的审批不再丢失。
  - 其它：首页 / 对话与任务拆分、最近列表排序与中文状态词、右侧运行面板默认展开、运行中结果显示「进行中」、提交中输入框保持焦点。
- **本提交**：版本号 0.1.2 → 0.1.3（apps/desktop、apps/renderer、packages/*、installer/companyos.iss 默认值）与发布文档。

## CI
14efff1（UI 重做 + 文档）全部成功：hark-windows 41939016576 · hark-ubuntu 41939016544 · hark-installer 41939016547 · hark-restart 41941529395 · hark-upgrade 41941529523。发布提交的 CI 运行号与安装包 sha256 见发布说明（lane/evidence/v013-release/notes.md）与 PROJECT_HANDOFF.md。

## 结论口径
仅 **Hark self-review PASS**（CI）。普通用户真机验收（H17_REAL_PC_ACCEPTANCE_CHECKLIST.md）与独立评审（H17_INDEPENDENT_REVIEW_PACKET.md）**尚未进行**。安装包未做代码签名。
