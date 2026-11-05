# 模型提供商描述符对账 + 启动可见性（2026-11-05）

用户在 Windows 上从源码（`F:\ziji`，hark-lane 检出）启动，窗口整片深色、没有任何界面。日志里有四个独立问题，逐个从根上修复。

## 1. `Provider "model.openai-compatible" is persisted with a different descriptor (models)`

**现象**：已有用户数据库（`%APPDATA%\@companyos\desktop\data\companyos.sqlite`，schemaVersion 9）在核心服务组合时抛错，组合整体失败，目标与运行都不可用。

**根因**：`packages/engine/src/providers/registry.ts` 的重绑定（restart rebind）把“持久化的模型目录快照”和“这次启动时上游 `GET /models` 返回的实时列表”逐项比较，不一致就拒绝。但：

- OpenAI 兼容适配器的目录是**上游实时数据**，不是适配器身份。v0.1.0–v0.1.3 以及更早的源码版本里，描述符形状从未变过（`kind: openai-compatible`、`displayName: OpenAI-compatible endpoint`，每个上游模型 id 一行 `provider_models`；见 `git show hark-v0.1.0:apps/desktop/src/models/openai-compatible-provider.ts`）。
- 快照**只增不减**：首次注册写入，之后每次 `providers.models()`（每次调用的 preflight）都 upsert，从不删除。
- 所以只要上游下线或改名了一个模型，或者用户把 `COS_MODEL_BASE_URL` 指向了另一个端点，下次启动就永久失败。离线 / 401 / 5xx 启动时 `listModels` 失败同样会拒绝重绑定。
- 这次的 provider id 是默认的 `model.openai-compatible`，说明模型配置来自环境变量 `COS_MODEL_BASE_URL` + `COS_MODEL_ID`（未设 `COS_MODEL_PROVIDER_ID`；环境变量整体优先于「CompanyOS 首次配置」，推断）。

**修复**（有意、可审计，不静默、不砖化）：

| 情况 | 处理 | 审计事件 |
| --- | --- | --- |
| 目录与上游一致 | 直接重绑定 | `provider.rebound` {catalogueVerified: true} |
| 上游目录变了 | 快照替换为上游当前列表（新增 upsert，下线的删除） | `provider.catalogue_reconciled` {phase: rebind, added, removed} |
| 会话中 `models()` 读到新目录 | 同样替换而非并集 | `provider.catalogue_reconciled` {phase: catalogue} |
| 启动时目录不可达（离线 / 401 / 5xx） | 保留已持久化快照并绑定；每次调用仍走实时 preflight | `provider.rebound` {catalogueVerified: false} |
| 描述符（kind / displayName）不同 | **仍然拒绝**（T18-07 B6：同 id 下的不同适配器），CONFLICT 并写明不一致字段 | `provider.failed` |
| 新版本有意替换旧描述符 | 仅当新适配器 `describe().supersedes` **精确列出**持久化的旧描述符时更新行 | `provider.descriptor_updated` {version, fields, from, to} |

描述符被拒绝时，应用**降级启动**而不是整体失败：`apps/desktop/src/core-services.ts` 不再 throw，`CoreServices.modelAdapterStatus = { state: 'REFUSED', providerId, code, message }`，适配器保持未绑定（模型调用由 provider-binding 守卫 fail-closed），其余核心服务照常组合。

回归测试 `tests/hark/provider-descriptor-reconcile.test.ts`（真实生产组合 + 真实持久化库，按已发布版本的行形状预置数据，回环假端点，CNY 0）：R1 上游目录变化后可启动且审计 added/removed；R2 目录未变无对账事件、端点不可达仍可启动；R3 描述符漂移被拒（降级）、仅精确 `supersedes` 才更新；R4 kind 不同仍拒绝但组合成功并给出原因；R5 会话中目录替换而非并集。R1/R2 在旧代码上失败（已验证）。

## 2. 组合失败不能是一片黑

`databaseStatus` 新增 `services`（`CORE_SERVICES_UNAVAILABLE` = 组合失败；`MODEL_PROVIDER_REFUSED` = 无模型提供商降级运行），渲染层 `apps/renderer/src/services-failure.tsx` 在每个视图顶部显示中文横幅（role=alert，带原因与处理方式），与数据库失败横幅并列。就绪度里“提供商”一行只把**本进程已绑定**的提供商算作已注册，被拒时显示拒绝原因。测试 `apps/renderer/tests/services-failure.test.ts`、`apps/desktop/tests/startup-visible.test.ts`。

## 3. 渲染层未构建：`ERR_FILE_NOT_FOUND` + 未处理的 Promise 拒绝

**根因**：根 `pnpm dev` 只执行 `@companyos/desktop dev`（只编译桌面端），从不构建 `apps/renderer/dist`，而且桌面端 tsconfig 不引用 `packages/engine`，引擎的 dist 也可能是旧的。`createMainWindow()` 直接 `await loadFile(...)`，拒绝无人处理。

**修复**：

- `apps/desktop/src/renderer-entry.ts`：先判断入口（开发服务器 / `dist/index.html` / 缺失）。缺失或加载失败时加载内置页面（data: URL，无脚本、无网络，纸色背景），写明原因和**确切命令**；`loadFile`/`loadURL` 的拒绝都被捕获并记录日志。
- 源码一键启动：根 `pnpm dev` / `pnpm start` = `pnpm run build && pnpm --filter @companyos/desktop start`（先构建 packages、渲染层、桌面端，再启动 Electron）；`apps/desktop` 的 `dev` 改为 `pnpm -w run build && electron .`。

## 4. 启动深色闪屏

`BrowserWindow.backgroundColor` 由旧的 `#0f1115` 改为纸墨界面的应用背景 `--paper-1` `#f1eee9`（`security.ts` `WINDOW_BACKGROUND`，测试锁定与 `styles.css` 一致）。

## 用户数据

无需删除或修改 `%APPDATA%\@companyos\desktop`：首次用新代码启动时，目录快照自动对账并写审计事件；描述符本身没有变化，不会触发拒绝。每次启动前的自动快照仍在 `%APPDATA%\@companyos\desktop\backups\`（见 DB_BACKUP.md）。
