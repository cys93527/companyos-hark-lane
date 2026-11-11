# CompanyOS Hark v0.1.6 — UI-AUDIT-3：设置里的「模型服务」、输入框精简、整体合理性整理（Hark 自审）

v0.1.5（b1f1268）之上的界面版本。来源是用户在 v0.1.5 上的反馈：希望在应用里直接填 API Key（不再只能用开始菜单的“首次配置”），并要求把输入框周围用不上的东西都放进设置、把不合理的地方整理掉。修复内容与完整清单见 [UI_AUDIT_3.md](./UI_AUDIT_3.md)（f4a61be）。本版本无真实模型调用、无新依赖。仅 Hark 自审；**未在真实电脑上测试**，普通用户真机验收与独立评审仍由用户/评审方执行。安装包未做代码签名（SmartScreen 会提示「未知发布者」）。

## 内容
- **设置 → 模型服务**：选择推荐服务（安装包自带的 `provider-profile.json`，价格已填好）或其他 OpenAI 兼容服务（https 地址、对话模型 id、每百万 tokens 输入/输出价格）；粘贴 API Key；填写每个目标最多花多少钱（预算）；「测试连接」（`GET {地址}/models`，只列模型，不消耗 tokens，不是模型调用）；「保存」；「移除」。保存后需要**重启 CompanyOS 才生效**，页面提供「立即重启」按钮。
- **Key 的安全**：Key 只在密码输入框里，不进界面状态、不进本地存储；保存时经专用通道 `companyos:provider-settings` 单向交给主进程，用 DPAPI（当前用户）加密写入与“首次配置”相同的文件；界面最多显示“****末 4 位”，日志只记操作名和结果码。
- **预算批准 / 提高、移除、重启都要你在系统确认框里点击确认**；智能体、运行时、工具没有任何途径调用这些操作（有测试）。部署环境变量（`COS_MODEL_*`）声明了模型时仍优先，设置页显示“由部署环境提供”。开始菜单“CompanyOS 首次配置”继续可用。
- **输入框精简**：只保留输入框、工作空间、模型、发送（以及“上一次提交尚未确认”和预算为 0 的拦截提示）。权限、文件交付要求、审批说明移到「设置 → 新目标默认」；「工具」按钮和会话费用删除（运行面板已有费用）；保存/恢复草稿改为静默自动保存和自动填回。
- **整体合理性整理**：设置顺序改为 模型服务 · 模型 · 新目标默认 · 工作区 · 关于 · 高级与技术信息（默认折叠）；运行面板只在“对话与任务”显示，重复项和技术细节收进提示或折叠区；输入框只在首页和“对话与任务”出现。
- **本提交**：版本号 0.1.5 → 0.1.6（apps/desktop、apps/renderer、packages/*、installer/companyos.iss 默认值）与发布文档；docs/INDEX.md 补上 UI_AUDIT_3.md 与本文链接。

## 测试
- `apps/renderer/tests/ui-audit-3.test.ts`、`tests/hark/ui-audit-3-provider-settings.test.ts`
- 安装包冒烟、重启、升级 CI（hark-installer / hark-restart / hark-upgrade）

## CI
f4a61be（UI-AUDIT-3）与发布提交的 CI 运行号、安装包 sha256 见发布说明（lane/evidence/v016-release/notes.md）与 PROJECT_HANDOFF.md。

## 限制
- 「设置 → 模型服务」（包括 DPAPI 写入、系统确认框、立即重启）**尚未在真实电脑上手动验证**，只有 CI 与单元测试覆盖。
- 自定义 OpenAI 兼容服务的价格由用户自行确认，CompanyOS 无法核实。

## 结论口径
仅 **Hark self-review PASS**（CI）。普通用户真机验收（H17_REAL_PC_ACCEPTANCE_CHECKLIST.md）与独立评审（H17_INDEPENDENT_REVIEW_PACKET.md）**尚未进行**。安装包未做代码签名。
