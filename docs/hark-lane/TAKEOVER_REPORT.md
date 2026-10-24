# Hark lane — TAKEOVER REPORT (2026-10-24 HKT)

## 身份与完整性
- `verify_package.py`：PASS（1014 package files / 923 SOURCE files / commit `7c86f2a681cc4d348c0238a4b6119931c74e423f` / tree `c2973b1acc5099325a644a51d27814e44d9fcd28`）。
- Hark lane 根：从 SOURCE 复制到独立目录后 `git init`，根提交 `f12244e3b68feed450a8415b46cd464a3d3380ca`，其 tree **恰为** `c2973b1acc5099325a644a51d27814e44d9fcd28`（与 checkpoint tree 字节一致）。这是新根提交，**不是**原 checkpoint 的 ancestry（无 bundle）。
- 唯一 Writer：Hark agent；路径仅限 Hark 工作区 `lane/`；凭据为空；无共享缓存、userData、端口、数据库。
- 未写源仓库、冻结仓库、E 盘、Codex lane（本机环境本就无法访问这些路径）。

## 测试主机（事实）
- Linux 6.12 **aarch64**，Node v22.23.3（内置 TS type stripping），pnpm/npm 存在但**未运行安装**；无 node_modules、无 TypeScript/ESLint/Vitest、无 Windows。
- 结论：Windows x64 原生 Job Object、koffi、Electron、安装包在本机均**不可执行**；只能做无依赖离线契约/失败注入开发。

## 未提交候选的隔离
- `reference-unaccepted/`（working-tree 与 late-source-update）只读审查，未复制进 lane；本 lane 3B-3E 实现为独立编写。源会话 24/26 native PASS 未在本 lane 复测，不计入本 lane 验收。
- 候选审查发现（供独立审查参考，未修改候选）：
  1. 先 CreateProcess(SUSPENDED) 再 Assign：owner 在两步之间崩溃会留下 Job 外挂起孤儿；可用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子入 Job。
  2. Job 在进程创建**之后**才 configure；应在任何进程存在前完成 configure + read-back。
  3. `members()` 只读 `NumberOfProcessIdsInList`，不与 `NumberOfAssignedProcesses` 比较，截断列表可能被当成完整。
  4. 正常退出但有未观察到的快速子进程时，completeIdentities 永不成立 → 只能等到超时再判 STOP_UNPROVEN（把可证明的“已排空”误报成超时/未证明）。
  5. 环境块用 `localeCompare` 排序；Windows 要求序数、大小写不敏感顺序。
  6. 允许 `NODE_OPTIONS` 进入子环境（即使有正则约束）是代码注入面。
  7. 若引入独立 watchdog 持有 Job 句柄，kill-on-close 在 owner 崩溃时**不再触发**；watchdog 必须把 owner 退出本身作为终止触发。

## 基线门（本主机，checkpoint 原样）
- `check-boundaries` exit 0；`check-architecture` exit 0（0 violations）；`check-workspace` exit 0。
- `node --test scripts/tests/*.test.mjs`：31 tests / 20 pass / 11 fail，exit 1。失败原因均为环境：缺 `eslint` 包（ERR_MODULE_NOT_FOUND）与 `OFFLINE_RESOURCE_PREPARATION_DENIED: unowned-or-writable-path`（离线资源准备拒绝本主机路径属性）。非本 lane 代码引起；保留首失败。
- lint / typecheck / vitest / build：NOT RUN（无依赖，未获下载授权）。

## 最小实施计划（已执行 H1，见 3B3E_OFFLINE_RESULT.md）
H1 离线：Port 类型 + 启动身份钉扎 + 生命周期适配器 + 独立 owner-hang watchdog 契约 + 确定性模拟内核失败注入 + 零依赖离线测试入口。原生绑定、真实 watchdog 进程、DuplicateHandle、lease 传输 BLOCKED。
