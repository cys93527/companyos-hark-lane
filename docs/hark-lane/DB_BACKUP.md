# DB-BACKUP：本地 SQLite 备份与恢复

状态：Hark 开发线实现（分支 `feat/db-backup`，基于 v0.1.3 `a4938b9`），Hark self-review；未经独立审查，未在真机验收。

## 1. 备份放在哪里

| 项 | 位置 |
|---|---|
| 活动数据库 | `<userData>/data/companyos.sqlite`（Windows：`%APPDATA%\CompanyOS\data\companyos.sqlite`） |
| 备份目录 | `<userData>/backups/`（Windows：`%APPDATA%\CompanyOS\backups\`） |
| 文件名 | `companyos-<tag>-YYYYMMDDTHHMMSSmmmZ[-n].sqlite`，UTC 时间，无 `:`（Windows 安全），可按名排序；同一毫秒重名时追加 `-1`、`-2` |
| 待恢复请求 | `<userData>/backups/restore-request.json`（`companyos/db-restore-request/1`） |

`<tag>`：`start`（启动）、`pre-migration`（迁移前）、`periodic`（定时）、`pre-restore`（恢复前的安全副本）、`manual`。

只备份 SQLite 数据库本身。产物内容库 `<userData>/artifacts`（CAS）、`budget/`、`provider/` 等不在备份内；恢复较旧的数据库后，启动时的 CAS 完整性检查仍照常运行（缺失内容会使启动失败关闭，而不是静默继续）。

## 2. 何时备份

| 时机 | 行为 | 失败时 |
|---|---|---|
| `pre-migration` | `openDurableDatabase` 打开连接后、应用第一个待执行迁移前（`beforeMigrations` 钩子）；仅当文件已有已应用迁移（已有数据）且存在待执行迁移时。全新数据库、无待执行迁移、或数据库来自更新版本（降级拒绝先发生）时不做。 | **强制**：迁移被拒绝，连接关闭，数据保持旧 schema 原样；外壳照常打开并显示 `OPEN_FAILED` 横幅（`升级数据库前的备份失败，未执行迁移…`）。属可重试失败：之后的懒加载路径会重新尝试（先备份再迁移）。 |
| `start` | 每个进程一次，数据库首次打开成功后立即进行（即上一次会话留下的状态，早于启动恢复对数据库的修改）。 | 尽力而为：记录日志 + 诊断，不阻塞启动。 |
| `periodic` | 应用运行期间每 `COMPANYOS_DB_BACKUP_INTERVAL_HOURS` 小时一次（默认 6；`0` 关闭定时备份）。定时器 `unref`，退出时停止。 | 尽力而为：记录日志 + 诊断，应用继续运行。 |

决定理由：迁移是唯一会不可逆改写 schema 的步骤，“没有备份就不迁移”比“带着风险升级”安全；其余时机的失败（磁盘满、权限）不应让用户打不开应用。

## 3. 一致性与写入方式

- 用 SQLite `VACUUM INTO ?`，经过**单独的只读连接**读取活动文件（驱动：`node:sqlite`，见 ADR-0001；仓库不使用 better-sqlite3，未引入新依赖，未使用 Litestream）。
- `VACUUM INTO` 是一个读事务：得到该时刻所有**已提交**数据的一致快照（含 WAL 帧），任何连接上未提交的事务都不会进入备份；WAL 模式下读者不阻塞写者，写者也不阻塞它；不像分页备份 API 那样会在持续写入下反复重启。
- 只读连接不参与应用连接的写顺序栅栏（`writeFence`），不会捕获、阻塞或被应用事务捕获，也永远不会写活动文件。
- 目标路径作为绑定参数传入，用户目录中的空格、引号、中文无需转义。
- 写入流程：`.<文件名>.partial`（同目录）→ fsync → `PRAGMA integrity_check` 必须为 `ok` → 原子 rename 为正式文件 → 轮换。失败时删除临时文件并抛出 `PERSISTENCE_FAILED`（`details.kind = DATABASE_BACKUP_FAILED`）；遗留的 `.partial` 在下一次备份时清除，列表永远只含完整且校验过的备份。
- 代价：`node:sqlite` 是同步 API，备份期间阻塞主进程事件循环（数据库为 MB 级时为毫秒到百毫秒级）。

## 4. 轮换

每个 tag 各自保留最新 `COMPANYOS_DB_BACKUP_KEEP` 个（默认 10，范围 1..100），新备份落盘成功后才删除旧的；轮换失败不影响刚写好的备份。不同 tag 互不影响（例如频繁的 `periodic` 不会挤掉 `pre-migration`）。

## 5. 配置

在应用的运行环境中设置（主进程启动时读取，非法值回退默认并写入 warn 日志）：

| 变量 | 默认 | 取值 |
|---|---|---|
| `COMPANYOS_DB_BACKUP_INTERVAL_HOURS` | `6` | `0`（关闭定时）或 `0.25`..`168` |
| `COMPANYOS_DB_BACKUP_KEEP` | `10` | 整数 `1`..`100`（每个 tag） |

## 6. 如何恢复

恢复是**暂存 + 下次启动时执行**：请求只写 `restore-request.json`，从不触碰活动数据库，因此应用开着时也可以安全地发出请求；CompanyOS 下次启动时，在打开数据库**之前**（活动数据库此时必然已关闭）执行恢复，然后由正常启动流程重新打开（较旧的备份会按正常流程再迁移，迁移前同样先做 `pre-migration` 备份）。

Windows（PowerShell，已安装版）：

```powershell
$app = "$env:LOCALAPPDATA\Programs\CompanyOS"
$env:ELECTRON_RUN_AS_NODE = '1'
# 列出备份（最新在前）以及是否有待执行的恢复
& "$app\CompanyOS.exe" "$app\resources\setup\restore-database.mjs" list --user-data "$env:APPDATA\CompanyOS"
# 暂存恢复（文件名取自 list 的 file 字段）
& "$app\CompanyOS.exe" "$app\resources\setup\restore-database.mjs" request --user-data "$env:APPDATA\CompanyOS" --backup companyos-periodic-20261105T020000000Z.sqlite
# 取消暂存的恢复 / 查看状态
& "$app\CompanyOS.exe" "$app\resources\setup\restore-database.mjs" cancel --user-data "$env:APPDATA\CompanyOS"
& "$app\CompanyOS.exe" "$app\resources\setup\restore-database.mjs" status --user-data "$env:APPDATA\CompanyOS"
Remove-Item Env:ELECTRON_RUN_AS_NODE
# 然后退出并重新启动 CompanyOS
```

每条命令输出一行 JSON（`ok: true|false`）。`request` 会立即校验备份；校验不通过直接拒绝，不写请求。

启动时执行的恢复步骤（`restoreDatabaseFromBackup`）：

1. **校验备份**：能作为 SQLite 打开、`PRAGMA integrity_check = ok`、存在且非空的 `schema_migrations`、所有已应用迁移都是本版本发布的（来自更新版本的备份按降级规则拒绝）。拒绝类型：`BACKUP_NOT_FOUND` / `BACKUP_CORRUPT` / `BACKUP_NOT_COMPANYOS` / `BACKUP_FROM_NEWER_VERSION`。
2. **保留当前数据库的安全副本**：一个经过校验的 `pre-restore` 备份；若当前文件损坏到无法快照，则把文件及其 `-wal`/`-shm` 原样复制到 `backups/pre-restore-raw-<时间>/`；两者都失败则中止，活动数据库不动。
3. **暂存**：复制备份到 `companyos.sqlite.restore-partial`，fsync，再次 `integrity_check`。
4. **交换**：删除活动数据库的 `-wal`/`-shm`/`-journal`（旧 WAL 重放到另一个数据库会损坏它），再把暂存文件原子 rename 为 `companyos.sqlite`。

请求文件在执行前即被消费：无法恢复的备份只报告一次（日志 `database restore refused`、提示框、`databaseStatus.backup.lastRestore`），不会在每次启动时重复尝试；被拒绝时当前数据库保持不变。

## 7. 诊断

- 日志 `desktop.log`：`database snapshot written` / `database snapshot failed (app continues)` / `database pre-migration snapshot written|failed` / `database restored from backup` / `database restore refused`。
- IPC `databaseStatus` 新增可选字段 `backup`：`dir`、`intervalHours`、`keep`、`lastSnapshot`、`lastError`、`consecutiveFailures`、`lastRestore`。渲染端暂未展示（无 UI 改动）。

## 8. 代码位置

| 文件 | 内容 |
|---|---|
| `packages/persistence/src/db.ts` | `snapshotDatabaseFile`（VACUUM INTO，只读连接）、`inspectDatabaseFile`（integrity + 迁移名）；仍是唯一接触 `node:sqlite` 的模块 |
| `packages/persistence/src/backup.ts` | 命名、列表、轮换、`createDatabaseSnapshot`、`validateDatabaseBackup`、`restoreDatabaseFromBackup` |
| `packages/persistence/src/durable/index.ts` | `openDurableDatabase({ beforeMigrations })` 钩子 |
| `apps/desktop/src/db-backup.ts` | 策略：设置、调度器、强制迁移前备份钩子、暂存/执行恢复 |
| `apps/desktop/src/main.ts` | 接线：启动前执行暂存恢复 → 打开（迁移前钩子）→ `start` 备份 + 定时器；退出时停止 |
| `scripts/hark/setup/restore-database.mjs` | 恢复助手（随 `resources/setup` 一起发布） |
| `packages/persistence/tests/db-backup.test.ts`、`apps/desktop/tests/db-backup.test.ts` | 测试 |

## 9. 未覆盖 / 后续

- 没有应用内“恢复”按钮或 IPC/控制面动作，也没有开始菜单快捷方式；恢复通过上面的命令行助手 + 重启完成。
- 只备份数据库，不备份 CAS 产物内容与其他 userData 文件。
- hark-windows 工作流不运行 vitest 目录，因此这些测试目前只在 hark-ubuntu（完整 vitest）中运行；Windows 路径行为以 `path.win32` 命名测试与含空格/中文的真实目录测试覆盖，真实 Windows 上的 rename/删除语义尚未在 CI 上直接验证。
