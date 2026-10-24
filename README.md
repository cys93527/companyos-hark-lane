# CompanyOS

**按行业 SOP 组织多个可替换 AI 模型、Agent 与真实工具，协同完成业务目标的 AI 工作操作系统。**

模型是员工，Agent 是岗位，Tool 是生产工具，Workflow 是 SOP，用户是老板。
本仓库当前处于 **Sprint 0：Foundation（P0 地基）**——只交付基础设施与接口，不含任何业务功能。

## 快速开始

```powershell
# Node >= 22.5（仓库开发环境为 24.x）、pnpm 11.25
pnpm install --frozen-lockfile

# 唯一的总门：lint → typecheck → boundaries → test → build
pnpm check

# 单步
pnpm lint
pnpm typecheck
node scripts/check-boundaries.mjs
pnpm test
pnpm build

# 工具链自检（node --test）
pnpm test:scripts
node scripts/check-workspace.mjs

# 启动桌面外壳（需要 Electron 运行时二进制；首次运行会下载）
pnpm dev
```

## 仓库结构

```text
apps/
  desktop/     Electron 主进程（加固基线、类型化 preload 桥）+ 安全测试
  renderer/    React 19 + Vite 渲染层（只通过 window.companyos 通信）
packages/
  core/        行业无关的内核：kernel、workflow lifecycle、ports（零运行时依赖）
  contracts/   跨边界 JSON 契约（zod schema：事件信封、Pack manifest、IPC、契约版本）
  persistence/ SQLite（node:sqlite）EntityStore + 校验和迁移执行器
  observability/ 结构化 JSONL 日志：脱敏、关联 id、控制台 + 轮转文件 sink
scripts/       质量门：边界检查、工作区校验、聚合 check、仓库卫生
docs/          设计与执行文档（见 docs/INDEX.md）
```

## 架构法（自动化强制）

**`@companyos/core` 不得依赖或命名：** `Coding` · `Git` · `Repository` · `Developer` · `CTO` ·
`Article` · `Video` · `Ecommerce`。这些属于 Industry Pack。持久化端口叫 **`EntityStore`**，
永远不叫 `Repository`；`@companyos/core` 保持零运行时依赖。

依赖方向：`core/contracts/observability` ← `persistence` ← `apps`，`packs/*` → Core（永不反向）。
违反时 `scripts/check-boundaries.mjs` 与 `packages/core/tests/sprint0-guardrails.test.ts` 会让 CI 变红。

## Sprint 0 明确不做

`Model Router` · `Agent Runtime` · `DevCompany` · `Coding Agent` · `Workflow Designer` ·
`多模型调度`。核心中只允许这些能力以**类型**形式存在。

## 文档

- 施工守则：`AGENTS.md`
- 文档地图：`docs/INDEX.md`
- 执行路线：`docs/EXECUTION_ROADMAP.md`
- 当前交接状态：`PROJECT_HANDOFF.md`
