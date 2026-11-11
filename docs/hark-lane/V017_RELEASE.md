# CompanyOS Hark v0.1.7 — 热修复：系统环境变量不再锁死「设置 → 模型服务」（Hark 自审）

v0.1.6（5947c16）之上的热修复。来源：用户在 Windows 上安装 v0.1.6 后，「设置 → 模型服务」只显示“模型服务由部署环境提供，这里的设置不会生效。”、“API Key 未保存”、“每个目标最多花费 未设置（预算为 0）”，**没有任何输入框和按钮**，无法填写 Key 和预算。本版本无真实模型调用、无新依赖。仅 Hark 自审；**未在真实电脑上测试**。安装包未做代码签名（SmartScreen 会提示「未知发布者」）。

## 原因
用户电脑上残留了早期手动配置时设置的系统/用户环境变量（`COS_MODEL_BASE_URL`、`COS_MODEL_ID`、`COS_MODEL_PROVIDER_ID` 等），但没有 `COMPANYOS_MODEL_API_KEY`。v0.1.6 的规则是“只要环境里有任意一个 `COS_MODEL_*` / Key 变量，模型就由部署环境接管”：
- `apps/desktop/src/provider-setup.ts` `applyProviderSetupOverlay` 直接返回 `source: 'environment'`，忽略用户自己的设置；
- `apps/desktop/src/provider-settings.ts` 保存时返回 `ENVIRONMENT_MANAGED` 拒绝；
- `apps/renderer/src/provider-settings-view.tsx` 在 environment 模式下隐藏整个表单和预算编辑。
结果：一个没有 Key、根本不能用的环境声明把用户锁死。

## 修复（从根上改优先级）
- **用户自己的设置永远优先**：只要「设置 → 模型服务」或开始菜单“首次配置”保存过完整设置，启动时所有模型字段（服务商、地址、模型 id、Key、超时、最大输出、结构化输出、思考模式）都取自这份设置，环境里其余 `COS_MODEL_*` 值一律移除——不会出现“环境的地址 + 设置的 Key”混用。保存后重启即生效，与环境变量无关。
- **环境变量只在没有用户设置时使用，且必须完整**：地址 + 模型 id + Key 都有才算可用的模型服务；缺 Key 的残留声明不算，残留值会从运行环境中移除，应用显示“未配置”。
- **设置页永远不是死胡同**：任何情况下都能打开表单填写服务、Key 和预算。检测到环境变量时只显示一行小提示“检测到系统环境变量 COS_MODEL_*，保存后以这里的设置为准。”。
- 保存不再因环境变量被拒绝（`ENVIRONMENT_MANAGED` 删除）；预算批准与之前一样，只能由你在系统确认框里点击。
- 开始菜单“首次配置”的提示同步改为“这里保存的设置会优先于环境变量”。
- Key 的安全处理不变：DPAPI（当前用户）加密，不进界面、不进日志。

## 本提交
修复 + 版本号 0.1.6 → 0.1.7（apps/desktop、apps/renderer、packages/*、installer/companyos.iss 默认值）+ 本文、INDEX 链接、PROJECT_HANDOFF。

## 测试
- `tests/hark/h17a-provider-setup.test.ts`：环境变量存在 + 用户设置 → 设置胜出、全部字段来自设置；环境无 Key + 无设置 → 未配置、残留值移除；环境完整 + 无设置 → 使用环境。
- `tests/hark/audit-desktop-d3-key-env.test.ts`、`tests/hark/ui-audit-3-provider-settings.test.ts`（环境变量存在时保存成功、预算可设置）。
- `apps/renderer/tests/ui-audit-3.test.ts`：三种情况下表单 / 预算都能编辑，界面不再出现“不会生效”。
- 安装包冒烟、重启、升级 CI。

## 结论口径
仅 **Hark self-review PASS**（CI）。普通用户真机验收与独立评审**尚未进行**。安装包未做代码签名。
