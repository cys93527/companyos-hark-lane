# CompanyOS Hark v0.1.5 — UI-AUDIT-2：模型选择、预算为 0 提前拦截、整体界面复查（Hark 自审）

v0.1.4（02d98e5）之上的界面修复版本。来源是用户在已安装的 v0.1.4 上的反馈：输入框的模型下拉列出了上游服务的全部模型（包括图像/视频模型），一个对话目标因预算为 0 失败，界面只显示「未归类的失败原因（POLICY_REFUSED）」。修复内容与完整问题表见 [UI_AUDIT_2.md](./UI_AUDIT_2.md)（a24b0d6）。本版本无真实模型调用、无新依赖。仅 Hark 自审；普通用户真机验收与独立评审仍由用户/评审方执行。安装包未做代码签名（SmartScreen 会提示「未知发布者」）。

## 内容
- **模型选择只显示已注册的对话模型**：新增模型类型判断（`apps/desktop/src/models/model-modality.ts`），只有对话模型能执行目标；把非对话模型设为公司模型会被拒绝（`MODEL_NOT_CHAT_CAPABLE`）。输入框只列出「已注册、有 Key、能执行目标」的模型，底部「管理模型」进入设置。
- **预算为 0 时发送前就拦住**：新增 `budget.readiness`；没有预算批准时不再等发送后失败，而是直接提示并给出「设置预算」按钮。
- **失败原因说人话**：准入拒绝的原因写入 `agent.execution_failed` 审计行；POLICY_REFUSED / 准入拒绝显示中文说明和修复按钮。
- **首次配置支持其他 OpenAI 兼容服务**：配置菜单 1 = DeepSeek，2 = 其他 OpenAI 兼容服务（填写地址、对话模型 id、每百万 tokens 价格），同样写入预算批准与价格证明；`-Remove` 两种都能移除。
- **原始代码收进「详情」**：错误代码、运行 id、状态枚举等不再直接显示；活动时间线改为中文描述；运行状态说明显示「DeepSeek · 连接正常」「默认模型：deepseek-chat」之类；审批卡「请求方」显示「执行器（代码执行）/ 系统 / 你 / AI 员工」，原始 id 在悬停提示；运行面板「模型」显示本目标实际使用的模型。
- **本提交**：版本号 0.1.4 → 0.1.5（apps/desktop、apps/renderer、packages/*、installer/companyos.iss 默认值）与发布文档。

## 测试
- `apps/renderer/tests/ui-audit-2.test.ts`、`tests/hark/ui-audit-2-model-budget.test.ts`
- `scripts/hark/installer-smoke.ps1` 中的 `uiaudit2-custom-setup-*` 检查（CI 安装包冒烟）

## CI
a24b0d6（UI-AUDIT-2）：hark-windows 42953163867 · hark-ubuntu 42953163954 · hark-installer 42953163918 成功。发布提交的 CI 运行号与安装包 sha256 见发布说明（lane/evidence/v015-release/notes.md）与 PROJECT_HANDOFF.md。

## 限制
- 自定义 OpenAI 兼容服务的配置菜单尚未在真实电脑上手动验证；其价格由用户自行确认，CompanyOS 无法核实。

## 结论口径
仅 **Hark self-review PASS**（CI）。普通用户真机验收（H17_REAL_PC_ACCEPTANCE_CHECKLIST.md）与独立评审（H17_INDEPENDENT_REVIEW_PACKET.md）**尚未进行**。安装包未做代码签名。
