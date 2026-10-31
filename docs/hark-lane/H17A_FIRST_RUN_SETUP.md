# H17a — 普通用户首次配置（DeepSeek API Key + 每个目标的预算）

状态：完成（Hark self-review PASS，不是独立评审结论）。Windows 安装冒烟 h17a-* 8 项在 hark-installer 41199673358 @b6c85cc 全部通过（安装冒烟 36/36）。普通用户真机执行属 H17 验收清单。

## 缺口
已安装版只从进程环境变量（COS_MODEL_* / COMPANYOS_MODEL_API_KEY）和运营者写入的 `userData/budget/approvals.json` 读取模型与预算；普通用户没有受支持的配置方式（界面显示"提供商凭证不在界面中管理"）。

## 设计（遵守 V1_DESKTOP_SUPPORTED_BOUNDARY §2：渲染进程不碰凭据）
| 部分 | 文件 | 说明 |
|---|---|---|
| 受信助手 | `scripts/hark/setup/configure-deepseek.ps1` → 安装到 `resources/setup/`；开始菜单"CompanyOS 首次配置" | 以当前用户运行、无需管理员；`Read-Host -AsSecureString` 读 Key，校验格式，DPAPI(CurrentUser) 加密写入 `%APPDATA%\CompanyOS\provider\model-api-key.dpapi`；Key 不进命令行、环境变量、日志或任何明文文件。`-Remove` 移除。`-KeyFromStdin` 供安装冒烟。 |
| 非机密写入 | `scripts/hark/setup/configure-provider.mjs`（用应用自身运行时 ELECTRON_RUN_AS_NODE 运行）+ `apps/desktop/src/provider-setup-write.ts`（源码不含任何厂商名；厂商/模型/价格资料是部署数据 `scripts/hark/setup/provider-profile.json` → 安装后 `resources/setup/provider-profile.json`，严格形状校验，缺字段/多字段/非 https 一律拒绝） | 写 `provider/model.json`（companyos:provider-setup:1：model.deepseek / https://api.deepseek.com / deepseek-flash / 4096 / json_object）以及用户自己的预算批准 + 价格证明（与 CI 的 make-budget-approval.mjs 同格式；上限 0.1–100 元；价格证明 30 天有效，重跑配置即重新确认）。写完用应用自己的解析器读回校验，失败则撤销 Key。只删除自己写的批准，不删运营者批准。 |
| 主进程读取 | `apps/desktop/src/provider-setup.ts`、`provider-setup-dpapi.ts`、`main.ts applyInstalledProviderSetup()` | 启动时、任何组合之前：NOT_CONFIGURED / CONFIGURED / INVALID（类型化原因：MODEL_INVALID、KEY_MISSING、KEY_UNREADABLE、UNPROTECT_UNAVAILABLE），失败即不配置（fail closed）。部署环境只要声明了任一模型变量就整体优先，不混用。DPAPI 解密走已随安装包发布并按清单校验的 koffi 3.3.3（无新依赖），仅在存在 Key 文件时通过动态 import 加载（native-lifetime 单入口守卫已显式扩展到此文件）。日志只记状态和数量，不记任何值。 |
| 安装器 | `installer/companyos.iss` [Icons]、`scripts/hark/stage-desktop.mjs` | 新增开始菜单快捷方式；staging 总是复制 `resources/setup`。 |

## 测试与门禁（本地，2026-10-27）
- `tests/hark/h17a-provider-setup.test.ts` 13 项：环境 > 文件优先、部分/损坏/他人 DPAPI/无解密能力 → INVALID 不写环境、报告不含 Key、写入的批准被 deployment-budget-proof 信任且 identify/select 命中、价格证明过期、上限范围、移除只删自己的批准、koffi DPAPI 调用形状（明文清零 + LocalFree/HeapFree）、PS 脚本静态检查（SecureString、CurrentUser、无智能引号、Key 不传给 node）。
- offline 138/138，typecheck 0，boundaries 0，architecture 0，eslint（改动文件）0，tests/hark + apps/renderer/tests 41 文件 354 项全过。证据 lane/evidence/H17a-gates。

## CI（hark-installer 41199673358 @b6c85cc 通过）
hark-installer 检查：在已安装应用上 `configure-deepseek.ps1 -KeyFromStdin -CapCny 1 -NoPause`（假 Key）→ 启动应用 → 日志出现 `provider setup` source=provider-setup setupState=CONFIGURED → 证据中搜不到假 Key → `-Remove` 后 NOT_CONFIGURED。


## 修复记录（2026-10-31）

hark-ubuntu 41178043110 暴露 3 个真实缺陷，已根治（未加基线）：发布源码 provider-setup-write.ts 硬编码厂商资料 → 违反 sprint6/sprint7 厂商边界测试，改为部署数据 provider-profile.json + parseProviderSetupProfile；测试假 Key 形如 `sk-…` 触发凭据扫描 → 改为 fake-key-for-h17a-…。
