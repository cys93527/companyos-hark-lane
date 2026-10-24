# Hark lane H2 — 依赖安装与全量回归（2026-10-24 HKT）

状态：候选，待独立审查；不是验收结论。主机 Linux aarch64、Node 22.23.3、pnpm 11.25.0（非 Windows，原生未运行）。

## 授权
用户 2026-10-24 批准：本线内 `pnpm install --frozen-lockfile --ignore-scripts`；Windows 验证走 CI runner。
未批准：koffi、Electron 二进制、真实 Provider/DSH、push/tag/release。

## 执行与结果（原始输出见 lane/evidence/H2-deps/）
| 步骤 | 结果 |
|---|---|
| install（独立 store/cache，ignore-scripts） | exit 0，217 包，lockfile 未变 |
| typecheck 首次 | exit 2：owner-watchdog.ts(153) TS7022（Hark 代码缺类型注解）→ 已修正 |
| typecheck 复跑 | exit 0 |
| eslint（Hark 文件）首次 | exit 1：fake-windows-kernel.ts no-this-alias → 改为箭头函数 |
| eslint（Hark 文件）复跑 / 全仓 `pnpm lint` | exit 0 / exit 0 |
| Hark 离线测试 | 65/65，exit 0 |
| check-boundaries / check-architecture | exit 0 / exit 0 |
| vitest 全量（Hark tree） | 304 文件 17 失败；3741 用例 42 失败；exit 1 |
| vitest 全量（基线 f12244e3 worktree） | 304 文件 17 失败；3741 用例 39 失败；exit 1 |

## 差异归因
- 仅 Hark 失败 5 例（CAS 长输出 ×2、T17-04 1-3、T17-08 14-18、execution-safety cleanup 时序）；基线定向复跑这 4 个文件时 5 例全部失败（10/64 失败），Hark 复跑 9/64 失败，失败集合每轮漂移 → 本机进程流捕获/计时不确定，非 Hark 回归。
- 仅基线失败 2 例：worktree 的 .git 文件触发 `unreviewed-gitdir-indirection`（环境），以及同类 T17-08 31-37 流捕获漂移。
- 共同失败类别：缺 dist（未 build）、Windows 路径/pwsh 相关 S24/S25 用例、新根仓库无 `sprint-11.0.0` tag、docs-links 用 `\\` 分隔符（仅 Windows 有效）。
- POSIX 等价 index 检查：基线已缺 `adr/0033-trusted-budget-proof-binding.md`（预存缺陷，未改）；Hark 新文档已加入 docs/INDEX.md。

## 新增 CI
`.github/workflows/hark-windows.yml`：仅 workflow_dispatch；windows-2022、Node 24.19.0、pnpm 11.25.0；ignore-scripts 安装、typecheck、scoped lint、Hark 离线测试、架构门禁；无 secrets、无原生、无 Electron；证据 artifact 总是上传。尚未运行（需仓库与推送授权）。

## 待独立审查
本阶段修改：owner-watchdog.ts 类型注解、fake kernel 箭头函数化、INDEX 两行、CI 工作流。
