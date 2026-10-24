# Sprint 17 Closeout — Repository Runtime

> 状态：**CLOSED**（T17-01 ~ T17-09 全部 CLOSED；annotated tag `sprint-17`，本地未 push）。
> Baseline：`56b9d80`（T17-08 final corrective）→ closeout commit 见 §12。
> 上游：`docs/EXECUTION_ROADMAP.md` Sprint 17 段、`docs/adr/0028-repository-runtime-v1-trust-and-execution-boundaries.md`
> （仍 **Accepted**，本 Sprint 未创建新 ADR）、`docs/sprint17/` 三份契约文档、Sprint 16 closeout
> （DevCompany 1.0.0 冻结）。

## 1. Mission

**让 Agent 能真正打开项目仓库并使用文件系统、搜索、受控命令执行与 Git，同时保持 workspace 边界、
authority/risk、durable evidence、recovery、QA freshness 与 production composition。**

判定：**Mission = ACHIEVED**（§4~§9 的能力均由真实 production composition + 真实 Git repo + 真实
SQLite/CAS 的 E2E 证明，无 fake/test-only wiring；唯一保持 fail closed 的是"生产默认不打开
workspace / 不声明 repository-capable kind"这一受信配置默认值，属安全默认而非能力缺失）。

## 2. Final Architecture

```
apps/desktop/src/core-services.ts   ← production entry（composeCoreServices，electron-free）
  ├─ composeRepositoryRuntime()      ← 唯一接线模块（10 个 toolPorts + 幂等 registerTools）
  │   ├─ WorkspaceManager（T17-02，0/1 active，close 受 lease 守卫）
  │   ├─ RepositoryProcessRunner（T17-04：唯一 spawn 点，shell=false、filtered env）
  │   ├─ RepositoryRevisionAnchorProvider（T17-05：唯一算法）
  │   ├─ evidenceSource / toolRecords（只读既有表）
  │   └─ repository-capable StageHandlers（T17-07）
  ├─ composeSprint13Application()    ← Engine + ValidationService + EvidenceGuard（合并 handlers）
  └─ ToolRegistry（10 个 repository 工具 + mock 工具）
```

分层不变：Core（纯领域/端口）← Contracts（schema）← Engine（应用服务 + OS primitive：
`node:fs`/`node:child_process`）← Persistence（SQLite + CAS）← Desktop（composition root）。
**Core/Contracts 不引入 `node:`、物理路径、child_process 或 Git 实现**（boundary gate LAW 1b 全绿）。

## 3. Task 状态

| Task | 主题 | 状态 |
|---|---|---|
| T17-01 | Architecture & Security Freeze（ADR-0028 + 三份契约） | CLOSED |
| T17-02 | Workspace Context & Repository Path Policy | CLOSED |
| T17-03 | Filesystem & Search Tools | CLOSED |
| T17-04 | Controlled Process Runtime & QA Command Tools（+ durable failure evidence + ref-integrity corrective） | CLOSED |
| T17-05 | Git Read-Only Runtime & RepositoryRevisionAnchor（+ index-aware anchor corrective + invocation anchoring） | CLOSED |
| T17-06 | Durable QA Evidence Validator | CLOSED |
| T17-07 | Task-Start Baseline & Workspace Lease（+ lease-ordering corrective） | CLOSED |
| T17-08 | Production Composition & E2E（+ production-configuration corrective） | CLOSED |
| T17-09 | Final Audit, Closeout & Annotated Tag | CLOSED |

完整 corrective 历史保留在 `docs/sprint17/S17_TASK_BREAKDOWN.md`（未删除任何 corrective 记录）。

## 4. Delivered Capabilities / Production Tool Inventory（精确 10 个）

| toolId | risk | capability | idempotency | 说明 |
|---|---|---|---|---|
| `repo.file-read` | LOW | `read` | IDEMPOTENT_KEY | UTF-8 text，relative only，≤ 4 MiB |
| `repo.file-write` | MEDIUM | `write` | COMMAND_ID | 原子替换，父目录必须存在，禁 `.git` |
| `repo.search` | LOW | `read` | IDEMPOTENT_KEY | literal-only，有界遍历 |
| `repo.terminal` | HIGH | `side_effect` | NONE | allowlisted commandKey only |
| `repo.test-runner` | MEDIUM | `side_effect` | NONE | 固定 slot `tests` |
| `repo.linter` | MEDIUM | `side_effect` | NONE | 固定 slot `lint` |
| `repo.typechecker` | MEDIUM | `side_effect` | NONE | 固定 slot `typecheck` |
| `repo.builder` | MEDIUM | `side_effect` | NONE | 固定 slot `build` |
| `repo.git` | LOW | `read` | IDEMPOTENT_KEY | op ∈ {status,diff,baseline}，只读 |
| `repo.validation-evidence` | LOW | `validation:validator` | IDEMPOTENT_KEY | verifier-only |

capability 词汇未扩展（仍 `read`/`write`/`side_effect`/`validation:validator`）。

## 5. Security Boundaries（终审确认）

- **Tool 安全**：十个工具全部经 `tool.invoke` + company scope + requiredAuthorities + risk/approval
  路径；`repo.terminal` HIGH 未经审批不得 spawn（真实顺序断言）；无 `tool.invoke` 的 actor 一律
  `PERMISSION_DENIED`（pre-spawn）。
- **Workspace**：one active `WorkspaceContext` per process；root 只来自 trusted application/
  composition（`repositoryRuntime.openWorkspace`）；不持久化、不自动重开、不接受 model/pack/
  RunSnapshot 提供的 root。
- **路径**：relative-only；absolute / drive-qualified / UNC / device / `..` / 空段 / NUL /
  prefix-collision 全部拒绝；symlink 与 junction/reparse 一律 fail closed；`.git` 普通写拒绝。
- **进程**：`shell=false` + 固定 argv；模型不可选 executable/argv/cwd/env；filtered env
  （Windows `PATH/PATHEXT/SystemRoot/WINDIR/TEMP/TMP`；POSIX `PATH/TMPDIR/LANG/LC_*`）；
  SecretVault 不桥接；16 KiB preview / 8 MiB capture per stream，达限即终止进程树；
  timeout/cancel 真实终止（含进程树清理）。
- **The registry semantic extension（准确记录）**：**FAILED invocation persistence 现支持
  "经过校验的 durable artifact linkage"**——上报的 managed ref 经共享 `durableReferenceResolver`
  校验存在性与同 run 归属后才链接；跨 run/伪造/缺失 ref 一律拒绝且不链接；replay 语义未变
  （`replay_output_json` 仍只属 COMPLETED；FAILED 重放仍为 FAILED）。status/replay/timeout/
  approval/idempotency 语义未变。
- **Git**：仅 status/diff/baseline；input schema 无任何 mutation 操作；root 精确匹配
  （`rev-parse --show-toplevel` 必须等于 canonicalRoot）；parent repo / bare / external
  worktree / submodule / nested repo 一律拒绝；`--no-ext-diff --no-textconv --no-color` +
  `core.fsmonitor=false` + `GIT_OPTIONAL_LOCKS=0` + `GIT_TERMINAL_PROMPT=0`。
- **持久化**：Migration Added = **NO**；无 Repository/Workspace/Baseline/Anchor/QAResult 表；
  继续复用 `ToolInvocation` / `Artifact/CAS` / `Validation`。Authority Added = **NO**。
  IPC = **NO**；Renderer = **NO**；UI = **NO**。

## 6. RepositoryRevisionAnchor

算法版本：**`companyos/repository-anchor/3`**（T17-05 corrective 后的 index-aware 版本）。
覆盖：`workspaceId`、HEAD identity（unborn ⇒ null）、branch（detached ⇒ null）、HEAD mode/object、
**INDEX mode**、**INDEX object identity**、WORKTREE mode、WORKTREE content identity、
rename original path、untracked path/content、deletion state。流式 SHA-256，不整体读入大文件；
symlink 只读 link 目标文本；mtime-only 不变；**ignored files 排除**；state entry 上限
**10,000**（超限 `GIT_STATE_LIMIT_EXCEEDED`，不截断后声称完整）。

`repo.git status/diff/baseline` 与四个 QA 工具的 success output 均携带 `preAnchor`/`postAnchor`
（同一 provider、单一算法），`getCurrentAnchor()` 供 T17-06/调用方只读复用。

## 7. QA Evidence Chain

```
durable ToolInvocations（×6）
  → repo.validation-evidence（verifier-only，latest terminal 选择）
  → report Artifact（既有 ArtifactService，materialize 为同一 run 的 artifact:art_…）
  → ValidationService（既有 validation.record 权限、既有 UnitOfWork）
  → Validation batch（latest durable batch wins，无 fallback）
  → EvidenceGuard（既有语义零改动）
```

required evidence 恰为 6 项：`repo.test-runner` / `repo.linter` / `repo.typechecker` /
`repo.builder` / `repo.git op=status` / `repo.git op=diff`。**`repo.git op=baseline` 不是六条之一**
（属 Task-start provenance）。PASS 需同时满足：六条 latest terminal 且 COMPLETED、QA exitCode 0、
toolVersion 匹配当前注册、commandKey 匹配、**commandDescriptorFingerprint 匹配当前 trusted
profile**、各自 `preAnchor == postAnchor`、六条 anchor 核心 identity 全等、同一 workspace/run/task、
且 **currentAnchor == evidenceAnchor**（验证末尾最后读取）。任一不满足 ⇒ `verdict: 'fail'`
（ToolInvocation 仍 COMPLETED，属业务裁决而非运行错误）。

## 8. Task Baseline / Lease / Recovery

- Task-start baseline = `repo.git op=baseline`，经 **真实 ToolRegistry.invoke**；权威 identity =
  deterministic idempotency key `task-baseline:<runId>:<taskId>` ⇒ **exactly-once**；重试/重入/
  恢复均 replay 原 invocation；人工后续 baseline 不替换；`getTaskRepositoryBaseline(runId, taskId)`
  只读返回原 provenance（无新表）。
- **Lease 顺序（frozen）**：workspace check → **ACQUIRE lease** → baseline capture/replay →
  workspaceId verification → repository Agent work → `finally` release（corrective 后不得退回
  baseline→acquire）。
- Lease = **process-local CompanyOS 执行互斥**：阻止并发 CompanyOS repository Agent；**不锁
  文件系统、不阻止外部编辑器/用户/进程修改**。
- Recovery：workspace / lease **不 durable**；task baseline / ToolInvocation / Validation /
  Artifact·CAS **durable**。restart 后须 trusted reopen，同 workspaceId 才能 resume；原 baseline
  复用不重采；**不要求** currentAnchor == task-start baseline。

## 9. Production Composition & E2E

- 正式入口：`apps/desktop/src/core-services.ts` 的
  `composeCoreServices(db, logger, { artifactFoundation, repositoryRuntime? })`；可信配置 seam
  `repositoryRuntime.repositoryCapableKinds`，**默认为空 ⇒ fail closed**；桌面启动与生产 E2E
  **同一入口**。engine 零改动（`composeSprint13Application` 仅新增可选 `stageHandlers`，与既有
  `createScriptedRegistry` 合并）。
- **repository-capable kind = generic `work`**（本仓 manifest 与 Sprint 13/14 engine 测试一直
  使用的 generic task kind），仅可经上述可信参数启用；**不全局硬编码、无 DevCompany/role 特判**。
- E2E（`tests/sprint17/repository-production-e2e.test.ts`，14 项，真实 production entry + 真实
  Git repo + 真实 SQLite/CAS）：production compose → trusted open → DevCompany install →
  run pin → Engine START（`drive` + `advance`）→ lease-before-baseline → read/write/search →
  四 QA（>16 KiB CAS 外置）→ git status/diff → 六条同一 anchor → ValidationService PASS batch →
  EvidenceGuard accepts；负链：STALE 改源、anti-cherry-pick、无 workspace、restart
  （workspace/lease 不恢复而 durable 状态全在、reopen 复用原 baseline）。

## 10. DevCompany Compatibility

| 不变量 | 值 |
|---|---|
| packId / version | `dev-company` / **1.0.0** |
| PackContentRefs | **24** |
| Pack Roles | **5**（cto / developer / reviewer / qa / documentation） |
| System/Owner role | **1**（预先存在，不属于 Pack；观察到的总角色数 6） |
| Workflow Template | **1** |
| Automatic role assignment | **0** |
| Manifest / content changed since Sprint 16 | **NO**（自 tag `sprint-16` 起 `packs/dev-company/src` 零改动） |
| Production install（10 工具 registry） | **PASS**（六个 tool 需求 + validator 能力全部满足） |
| install == QA PASS | **NO**（新 run/task 无六条 evidence ⇒ validator 仍 FAIL） |
| Packless Run（`packVersions = {}`） | **PASS**（E2E 复证） |

## 11. Known Limitations（诚实记录）

1. **无 OS 级 sandbox**：无 container/VM/受限 OS 用户/network namespace；`RepositoryCommandProfile`
   与 filtered env 是 **application-level containment**，不是 OS isolation。
2. **网络**：无 network tool；profile 不应故意配置网络命令；但 host executable 技术上可联网
   （known limitation）。
3. **TOCTOU 未完全消除**：path 校验与后续 OS open/write 之间、Git 采样与读取之间存在竞态窗口
   （V1 以统一 policy + 一律拒绝 symlink + 受信 root 缓解）。
4. **CAS contentRef 只做格式检查**：既有框架语义（managed `artifact:art_` ref 才做存在性/同 run
   校验）；如需更强存在性语义属未来工作。
5. **进程树终止尽力而为**：Windows `taskkill /T` / POSIX 进程组；自行脱离组或被重新父化的进程
   可能残留。
6. **ignored files 不纳入 anchor fingerprint**（写明的语义，非缺陷）。
7. **生产默认无 openWorkspace caller、`repositoryCapableKinds: []`** ⇒ repository 工具在生产
   保持 fail closed，直至受信应用显式配置。

## 12. Deferred Work（均非 Sprint 17 blocker）

OS-level sandbox、network isolation、multi-workspace、parallel repository Agents、Git worktrees、
Git mutation/commit/push、automatic workspace UI/open-folder 流、IPC/Renderer repository UI、
remote runners / distributed execution、external filesystem mutation prevention、更强 CAS 存在性语义。

## 13. Final Test Evidence

- `pnpm check`：**5× PASS**（lint / typecheck / boundaries / test / build）。
- `pnpm test:scripts`：**23/23 PASS**。
- 测试规模：**145 files / 1689 cases**（不低于 145/1689；既有测试零删除；`git diff --check` PASS；
  所有触碰文件 UTF-8 有效、U+FFFD = 0、NUL = 0、无 BOM）。
- E2E：`tests/sprint17/repository-production-e2e.test.ts`（14 项，正链 + STALE/anti-cherry-pick/
  无 workspace/restart 负链）全绿；`tests/sprint17/` 合计 **218 项**。
- Sprint 17 相关既有回归（Sprint 8/9/10B composition 断言、Sprint 13/14/15/16 Pack/Run pinning、
  recovery）全绿。

## 14. Commit / Tag

- Closeout commit：`chore: close sprint 17`（仅文档/roadmap/status；**production runtime code
  changed = NO**）。
- **Annotated tag**：`sprint-17`（**不是** `sprint-17.0.0`），指向上述 closeout commit（HEAD）；
  `git rev-parse HEAD` == `git rev-list -n 1 sprint-17`；本地创建，**未 push**。

## 15. Final State

| 项 | 值 |
|---|---|
| Sprint17 Mission | **ACHIEVED** |
| Sprint17 | **CLOSED** |
| Implementation Blockers | **NONE** |
| Closeout Blockers | **NONE** |
| Push | **NO** |
