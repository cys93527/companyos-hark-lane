# UI-AUDIT-2：模型选择、预算为 0、整体界面复查（2026-11-11）

来源：用户在已安装的 v0.1.4 上反馈——输入框的模型下拉列出了上游服务的全部模型（包括“待注册”、图像/视频模型也能选），
一个对话目标因预算为 0 失败，界面只显示“未归类的失败原因（POLICY_REFUSED）”。用户要求：只显示自己用 API Key 注册的模型，并复查整个界面体验。

基线 68adac6（v0.1.4）。不改版本号、不打 tag、不调用真实模型、不新增依赖。仅 Hark 自查；真实电脑验收与独立审查未进行。

## 根因
1. 模型适配器把上游返回的每个模型都标成“可结构化输出的对话模型”。
2. 输入框把“上游目录 + 已注册”合并列出。
3. 设置页模型区直接打印原始列表和 `EXPLICIT_USER_CHOICE` 之类的枚举。
4. 没有 `budget/approvals.json` 时，准入上限费用为 0，所有付费调用都被拒绝，且要等发送后才知道。
5. 首次配置只支持 DeepSeek。
6. `GOAL_ADMISSION_BOUND_UNPROVEN` 原因没有写进 `agent.execution_failed` 审计行，界面没有 POLICY_REFUSED 的中文说明。

## 修复
- 新增模型类型判断（`apps/desktop/src/models/model-modality.ts`），只有对话模型可执行目标；把非对话模型设为公司模型会被拒绝（`MODEL_NOT_CHAT_CAPABLE`）。
- 输入框只列出“已注册、有 Key、能执行目标”的模型，底部“管理模型”进入设置。
- 新增 `budget.readiness`：发送前就知道预算为 0，直接拦住并给出“设置预算”按钮。
- 首次配置菜单：1 = DeepSeek，2 = 其他 OpenAI 兼容服务（填写地址、对话模型 id、每百万 tokens 价格），同样写入预算批准与价格证明；`-Remove` 两种都能移除。
- 失败原因写入审计行；POLICY_REFUSED / 准入拒绝显示中文说明和修复按钮；错误代码收进“详情”。
- 活动时间线改成中文描述；状态、运行 id 等改为提示信息。
- 运行状态说明不再显示原始 id（例如“DeepSeek · 连接正常”“默认模型：deepseek-chat”）。
- 审批卡“请求方”显示“执行器（代码执行）/ 系统 / 你 / AI 员工”，原始 id 放在悬停提示。
- 运行面板“模型”一栏显示本目标实际使用的模型（来自任务记录），尚未调用时才显示默认模型。

完整问题表（16 项：高 5、中 7、低 4）见 `lane/evidence/UI-AUDIT-2/AUDIT.md`（仓库外的 Hark 证据目录）。

## 测试
- `apps/renderer/tests/ui-audit-2.test.ts`
- `tests/hark/ui-audit-2-model-budget.test.ts`
- `scripts/hark/installer-smoke.ps1` 中的 `uiaudit2-custom-setup-*` 检查（CI 安装包冒烟）

## 未做 / 限制
- 自定义服务的配置菜单尚未在真实电脑上手动验证。
- 自定义服务的价格由用户自行确认，CompanyOS 无法核实。
