# ADR-0001：采用 pnpm workspaces 单仓与 `node:sqlite` 持久化

> 归属：规划书 §五十四（技术栈）、§五十六（数据库）、§五十五（推荐目录）。
> 适用范围：整个仓库（apps + packages + packs）。

## 状态

**已接受（Accepted）** — Sprint 0（P0 地基）落地。

## 背景

CompanyOS 要交付的是一个**本地优先**的桌面产品（规划书 §四十七 V1 单 Workspace、串行 Agent），
而不是一个云服务。这带来几条硬约束：

1. **多包协作**：Core、契约、持久化、可观测性、Pack、桌面壳需要独立演进并共享类型；
2. **跨平台可复现**：Windows / macOS / Linux 上 `pnpm check` 必须得到同样的结果；
3. **数据库必须嵌入**：需要 WAL、Foreign Keys、Transactions、Migrations（规划书 §五十六），
   但不应引入需要本地编译的原生依赖——CI 与用户机器上都不应出现 node-gyp 工具链；
4. **TypeScript 严格**：类型契约（事件信封、Handoff、Pack manifest）必须跨进程共享同一份定义；
5. **可审计**：迁移必须可追溯，禁止“某台机器上悄悄改了 schema”。

## 决策

1. **单仓 + pnpm workspaces**：`packages/*`、`apps/*`、`packs/*` 三个 glob；根 `package.json`
   `private: true`，`packageManager` 固定 `pnpm@11.25.0`，`engines.node >= 22.5.0`。
   内部依赖一律使用 `workspace:*`，由 `scripts/check-boundaries.mjs` 强制依赖方向。
2. **持久化使用 Node 内置 `node:sqlite`**（Node ≥ 22.5 提供，仓库开发环境为 Node 24），
   放在 `@companyos/persistence` 中，且**只有 `src/db.ts` 允许 import 它**。
   连接固定开启：`journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`、
   `synchronous = NORMAL`。
3. **迁移用编号 SQL 文件 + 校验和**：`migrations/NNNN_name.sql`，由
   `schema_migrations(name, checksum, applied_at)` 记录；已应用的迁移被修改时抛
   `MigrationChecksumError`（错误码 `HASH_MISMATCH`）；每个迁移在事务中执行。
4. **不用 ORM**：Core 定义 `EntityStore<T>` 端口，Sprint 0 用 JSON 文档表（`entities(kind, id)`）
   实现，领域模型由各自的有界上下文在 Sprint 1+ 逐步正规化。
5. **TypeScript strict + ESM**：`module/moduleResolution: NodeNext`，`composite` 项目引用，
   构建产物为 `dist/`（声明文件随包发布）。

## 后果

**收益**

- 零原生编译：`pnpm install` 不需要 node-gyp/Python/VS Build Tools；CI 只有安装 + 检查两步有意义的开销；
- 单一语言与单一类型系统贯穿渲染层、主进程、Core 与工具链；
- 迁移校验和让“环境之间 schema 漂移”变成构建期可见的硬失败；
- 工作区边界即架构边界，可被机器检查（词汇法 + 方向法），而不是只写在文档里；
- 本地优先：默认无网络调用，符合规划书 §五十三（MVP 不做 Cloud SaaS）。

**代价与限制**

- 依赖 Node ≥ 22.5；`node:sqlite` 的 API 仍在演进，升级 Node 需回归 `@companyos/persistence` 测试；
- 无 ORM 意味着要自己写行↔对象映射（Sprint 0 用 JSON 文档表过渡，代价是查询能力弱）；
- `node:sqlite` 目前不支持浏览器/Vite 转译场景，测试运行器需认识该内置模块
  （本仓库因此将 Vitest 升级到 3.x / Vite 6 线）；
- WAL 模式会产生 `-wal` / `-shm` 附带文件，`.gitignore` 必须覆盖（已覆盖）。

**被否决的方案**

| 方案 | 否决理由 |
|---|---|
| `better-sqlite3` | 需原生编译与 `electron-rebuild`，跨平台 CI 成本高，且与 Electron ABI 耦合 |
| Prisma / Drizzle ORM | 引入代码生成与运行时体重；Sprint 0 只需要端口 + 迁移，收益不足 |
| `electron-store` / JSON 文件 | 无事务、无并发保护、无迁移机制，无法承载 Run/Task/Event 这类高频写入 |
| 云数据库（Postgres 等） | 与“本地优先、单机、无云依赖”的 MVP 定位直接冲突 |
| npm / yarn workspaces | pnpm 的内容寻址存储与严格的 workspace 隔离更契合“边界即架构”的诉求 |

**后续影响**

- 若将来需要 V2 Git Worktree / V3 Docker Sandbox（规划书 §四十七），持久化层无需改动：
  `EntityStore` 是端口，实现可替换；
- 若 `node:sqlite` 出现破坏性变更，替换面被限制在 `packages/persistence/src/db.ts` 与迁移执行器；
- ADR 的修订必须走 Change Proposal（见 `../DECISION_SYSTEM.md`）。
