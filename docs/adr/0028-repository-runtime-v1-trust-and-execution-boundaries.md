# ADR-0028：Repository Runtime V1 — Trust, Workspace and Execution Boundaries

> 归属：Sprint 17（Repository Runtime）；规划书 §五十九 Sprint 17、§四十六、§四十七、§二十一、§三十六、§五十四。
> 上游：ADR-0013/0019（Tool Registry 与调用 provenance）、ADR-0015/0017/0020（Artifact/Validation/EvidenceGate）、
> ADR-0023（Recovery Path Scope）、ADR-0024~0027（Industry Pack）。本 ADR 由 TASK-17-01 一次冻结；
> Sprint 16 裁定的 7 项 Planning Recon gap 全部在此关闭（逐条标注）。

## 状态

** accepted（Accepted）** — TASK-17-01 冻结（Boss 逐条裁定）。**本 ADR 只是契约：Sprint 17 实现任务
（T17-02~T17-09）未获各自批准前不得开工。**

---

## Decision 1：不加 Durable Repository / Workspace 实体（Boss 裁定 §1）

Sprint 17 V1 **不新增** Repository 表 / Workspace 表 / 任何 migration。理由：roadmap 冻结 V1 =
单 Workspace + 串行 Agent；现有 `ToolInvocation`（执行+attempt lineage+toolVersion）、`Artifact`（CAS
内容）、`Validation`（证据批次）、`Event`（审计）、Run/Task 归属已足够承担执行、审计与证据。
延后至未来 ADR：多 Workspace、workspace 持久化/自动重开、remote repository binding、per-company
repository catalog。**若实现阶段发现无 migration 无法满足本契约 ⇒ HARD STOP 报
`REPOSITORY_PERSISTENCE_GAP`。**

## Decision 2：Workspace Root Authority（关闭 `REPOSITORY_ROOT_AUTHORITY_GAP`）

**workspace root 是 trusted application/composition 配置**，不是 model input、prompt input、
Tool input 绝对路径、PackManifest 字段或 RunSnapshot 字段。V1 新增 generic application/runtime seam
（语义形如 `openWorkspace({ root, commandProfile })`，具体命名按 repo 风格），由 composition root
（`apps/desktop/src/main.ts` 或其下 adapter composition 模块）调用。Agent/模型只能提供
**workspace-relative paths**；禁止 absolute / drive-qualified / UNC / device path / root override。
adapter 永远从 trusted WorkspaceContext 取得真实 root。

## Decision 3：WorkspaceContext 与 workspaceId（Boss 裁定 §3）

openWorkspace 成功后生成 **process-local** `WorkspaceContext`，至少包含 `canonicalRoot`、
`workspaceId`、`commandProfile`。`workspaceId` = 由 canonical real root 派生的 **qualified SHA-256
身份**（`sha256:<64 lowercase hex>`，复用 T15-02 既有 hash 约定）。**普通 Tool output / event 不得
暴露原始绝对路径**（用 workspaceId 代替）。

## Decision 4：Restart 语义（Boss 裁定 §5）

V1 WorkspaceContext **不 durable**：进程重启后 repo tools **unavailable，直到 trusted application
重新 openWorkspace**。禁止从旧 ToolInvocation 反推物理路径；已有 Run/Recovery 数据仍可读取，再次调用
repo tools 前必须重新打开同一 workspace。这是 V1 明确限制（非缺陷）。

## Decision 5：Root Canonicalization 与 Relative-Path 输入（Boss 裁定 §8/§9）

openWorkspace 时：root 必须存在、必须是目录、`root = realpath(root)`、并规范化为 platform-normalized
canonical absolute path；canonical root 创建后不可由 Agent 修改。repo filesystem/search inputs 必须
**只接受相对路径**；拒绝 `..`、absolute、drive-letter absolute、UNC、`\\?\` device path、NUL、空/非法
segment；`.` 仅在操作明确允许 workspace root 时可接受。

## Decision 6：Containment 与 Symlink/Junction（关闭 `REPOSITORY_PATH_BOUNDARY_GAP`）

必须实现独立 generic **`RepositoryPathPolicy`**（或 repo 同等命名）。所有目标最终必须满足
`resolvedTarget is inside canonicalRoot`——**platform-aware path containment，不是字符串 prefix**；
Windows 比较按文件系统语义大小写不敏感。**V1 对 symlink/junction traversal FAIL CLOSED**：目标已有
路径段须 `lstat`/`realpath` 验证不经 symlink/junction/reparse point 逃逸；待创建文件必须检查
nearest existing parent 仍真实位于 canonical root 内。

## Decision 7：`.git` 文件系统边界（Boss 裁定 §12）

普通 filesystem **write 不得写 `.git/**`**；Git 内部操作只能经 `repo.git`。V1 filesystem
read/search 同样**默认排除 `.git/**`**（避免模型直接读取/修改 Git 内部数据库）。

## Decision 8：Filesystem V1 Scope 与 Binary（Boss 裁定 §13–§15）

正式允许：**read UTF-8 text file / write-create-overwrite UTF-8 text file / search text-code**。
不包含：delete、rename、move、chmod、symlink 创建、binary 编辑、任意目录 mutation。
write 语义：workspace-relative、atomic replace where practical、parent 必须过 RepositoryPathPolicy；
可创建缺失父目录（仅限 root 内且无 symlink/junction traversal）。
binary 文件：fail with explicit `UNSUPPORTED_BINARY`（或既有等价 fail-closed error）；**不得把任意
binary base64 塞给模型**。

## Decision 9：Search（Boss 裁定 §16）

root-scoped、read-only、text/code；复用同一路径边界；默认忽略 `.git`、`node_modules`、以及按 trusted
配置的 generated/build 目录；**不得 shell out 到任意 grep command**。

## Decision 10：Terminal 执行模型（关闭 `TERMINAL_EXECUTION_MODEL_GAP`）

**NO MODEL-CONTROLLED SHELL STRING。** V1 执行模型 = **native executable + argv[] + shell=false**。
模型不能选择 executable path；`WorkspaceContext` 持有 trusted **`RepositoryCommandProfile`**（允许
命令槽位，至少服务 tests/lint/typecheck/build，以及未来受控 generic command slot）。每个 trusted
command descriptor 语义：`executable` / `argv` / `cwd policy` / `safe env allowlist additions`；模型
**不能覆盖** executable、base argv、workspace 外 cwd、environment、shell flag。
**默认 NO FREE-FORM EXTRA ARGS**；将来某命令需要参数必须在 descriptor 中定义 typed/validated/
allowlisted 参数，不得把任意字符串追加 argv。
**Windows wrapper 规则**：V1 不允许模型控制 `cmd.exe /c`、`powershell -Command`、`sh -c`、`bash -c`；
若 Windows package manager 只有 `.cmd/.bat` wrapper，trusted command profile 必须解析成
explicit interpreter/executable + fixed script path + fixed argv，不得退化成 untrusted shell string。

## Decision 11：Sandbox 立场（关闭 `TERMINAL_SANDBOX_BOUNDARY_GAP`）

**V1 DOES NOT CLAIM OS-LEVEL SANDBOXING**：不实现 container / restricted OS user / VM / network
namespace / Docker。host process execution 仅在以下**全部成立**时允许：trusted workspace root、
fixed command profile、no model-controlled executable、no shell string、workspace cwd only、
filtered env、no automatic secrets、bounded output、timeout/cancel、Tool Registry
authority/risk/audit。因此 **arbitrary unrestricted terminal = NOT IN SCOPE**。
Generic terminal tool（若实现）只能是 **allowlisted-command executor**（语义形如
`repo.terminal { commandKey }`，commandKey 必须来自 trusted command profile；不接受
`command: "anything..."`）。

## Decision 12：Environment / Secret / Network（Boss 裁定 §26–§29）

**filtered environment only**——禁止 wholesale 继承 `process.env`。trusted composition 可传递 OS
运行最小字段（Windows：`PATH`/`PATHEXT`/`SystemRoot`/`WINDIR`/`TEMP`/`TMP`；POSIX：`PATH`/`TMPDIR`/
`LANG`/`LC_*` when required；具体集合写入契约文档）。**绝不自动传入** API keys、cloud credentials、
`SSH_AUTH_SOCK`、GitHub token、npm token、provider credentials、SecretVault values——
**SecretVault 不自动桥接进 repository process environment**（未来需要某个 secret 必须独立批准）。
**Network**：V1 无 OS network sandbox，不能声称"网络不可能"；产品规则 = runtime exposes no network
tool + command profile 不得故意配置网络命令；host executable 技术上可能联网——**作为已知限制记录**。

## Decision 13：Git V1 Scope（Boss 裁定 §30/§31；`GIT_MUTATION_AUTHORITY_GAP = NO`）

**READ-ONLY GIT ONLY**：允许 `status` / `diff` / `baseline`（baseline 含 branch、HEAD、git status、
dirty files、repository revision anchor）。不包含 add/commit/checkout/switch/branch/reset/clean/
merge/rebase/push/pull/fetch/tag/stash mutation。**无需新增 authority**（不默认 Push——AC17.2）。

## Decision 14：`repo.git` 单一 ToolRecord（关闭 `REPO_GIT_CAPABILITY_VOCAB_GAP`）

正式冻结 **one ToolRecord: `repo.git`**，通过 typed input `op: status | diff | baseline` 区分操作。
DevCompany 1.0.0 对 `repo.git` 的 requirement capability = null，因此 **不新增
`repo.git.readonly` capability token**；ToolRecord 继续使用已有 generic `read` capability。
Git adapter 使用同一安全 process runner，但 argv 完全由 adapter 固定（不来自 command profile/model）；
`input schema` 中**根本不存在** `push`（不是"默认 false 但还能传 true"）。
DevCompany 中 git diff / git status 保持不同 requirement keys、相同 toolId（Sprint 17 不修改）。

## Decision 15：RepositoryRevisionAnchor（关闭 `REPOSITORY_EVIDENCE_FRESHNESS_GAP`）

新增 generic concept **`RepositoryRevisionAnchor`**（**不是新数据库 entity**）。至少包含
`workspaceId`、`headSha | null`、`workingTreeFingerprint`；可含 `branch`、`dirtyFiles` 作为审计字段。
`workingTreeFingerprint` 必须覆盖 **HEAD identity + staged tracked changes + unstaged tracked changes
+ untracked files**——不能只 hash `git status` 文件名（内容变化可能不改变 status shape）。推荐确定性
输入：`git diff --binary --cached HEAD`、`git diff --binary`、sorted untracked path + content hash，
做 streaming SHA-256（或等价且测试证明覆盖相同状态的实现）；**不得把巨大 diff 全文持久化仅为了
fingerprint**。unborn HEAD ⇒ `headSha = null`，fingerprint 仍必须覆盖当前 tracked/untracked state。

## Decision 16：命令证据锚点与 Source Mutation Detection（Boss 裁定 §41/§42）

每个 repository command 执行至少记录 `preAnchor` / `postAnchor` / `workspaceId` 于 structured Tool
output。QA 六命令若 `preAnchor != postAnchor`（命令改变了 source repository state）⇒ validator
默认 **FAIL CLOSED**（除非未来特定命令 contract 明确允许）。

## Decision 17：QA Evidence Freshness 与 Validator 角色（Boss 裁定 §43–§48）

`repo.validation-evidence` 只有在全部 required invocation 满足 **same run / same task-stage /
same workspaceId / SUCCESS / expected toolId+toolVersion / exitCode success / matching revision
anchor** 时才能 PASS。validator 验证前必须**重新读取一次 current RepositoryRevisionAnchor**，要求
`currentAnchor == evidenceAnchor`，否则 **STALE EVIDENCE / FAIL**。
**`repo.validation-evidence` = VERIFIER ONLY**：不 rerun tests/lint/build/git；它验证
ToolInvocation records、tool version、status、structured output、revision anchors、artifact/log refs，
然后让**既有 ValidationService 记录 Validation batch**；**EvidenceGuard 继续 unchanged**。
LLM 文本（"tests passed"）永远不能成为 QA PASS evidence——只有 trusted durable ToolInvocation /
Artifact refs / Validation batch 可作为证据。**不新增 validation 表。**

## Decision 18：Output Boundary（关闭 `TOOL_OUTPUT_BOUNDARY_GAP`）

真实命令输出必须 **BOUNDED**。process tools 至少返回（以真实 output schema 规范化）：
`exitCode`、`signal`、`durationMs`、`stdoutPreview`、`stderrPreview`、`stdoutArtifactRef?`、
`stderrArtifactRef?`、`preAnchor`、`postAnchor`、`workspaceId`。
**Inline preview limit = 16 KiB per stdout/stderr**（超过部分不得继续塞进 `replay_output_json`）。
**Capture limit = 8 MiB per stream**（达到上限 ⇒ cancel/terminate process +
`OUTPUT_LIMIT_EXCEEDED` 或既有等价 fail-closed error）；不得无界内存增长。
完整输出大于 inline preview 且未超 capture limit ⇒ 用**现有 Artifact / managed artifact ref / CAS**
外置完整 bytes（不新增第二套 blob store）。二进制输出：原始 bytes 外置 artifact/CAS，inline 文本预览
可为空并标记 `binary=true`（no lossy text claim）。`outputDigest` 继续保留（Tool provenance，不被
artifact externalization 取代）。

## Decision 19：Timeout / Cancellation / Process Tree（Boss 裁定 §56–§58）

**复用** `ToolRecord.timeoutMs` 与 Tool Registry 既有 timeout 路径（不设计第二套 timeout）。Process
runner 必须支持 `ToolPort.cancel?`（或 repo 现有等价取消路径）；timeout/cancel 后必须**实际终止
child process**，并考虑 Windows/POSIX 的 **child process tree 清理**（不能只结束 parent 却留下
build/test child）——实现细节由 T17-04 完成并测试。

## Decision 20：Recovery（Boss 裁定 §59）

Sprint 14 语义保持：`STARTED → INTERRUPTED` after crash、no automatic external-call retry、explicit
retry only。Sprint 17 不得改变。

## Decision 21：Idempotency 矩阵（Boss 裁定 §60；使用现有 enum 真实名称）

| Tool | 语义 |
|---|---|
| `repo.file-read` / `repo.search` | read / idempotent |
| `repo.git` status/diff/baseline | read / idempotent |
| `repo.file-write` | deterministic command-idempotent write |
| QA process commands（test-runner/linter/typechecker/builder） | **NO automatic retry** |
| generic controlled `repo.terminal` | **NO automatic retry** |
| `repo.validation-evidence` | read / verifier idempotent |

不得因"test 通常安全"而自动重跑。

## Decision 22：Risk 矩阵与 Approval（Boss 裁定 §61/§62；使用现有 RiskLevel）

| Tool | riskLevel |
|---|---|
| `repo.file-read` / `repo.search` / `repo.git`(read-only) / `repo.validation-evidence` | LOW |
| `repo.file-write` | MEDIUM |
| `repo.test-runner` / `repo.linter` / `repo.typechecker` / `repo.builder` | MEDIUM |
| generic controlled `repo.terminal` | HIGH |

继续复用既有 Risk policy / Approval（HIGH 按现有策略要求审批）；**不创建 Terminal 专用确认系统**。

## Decision 23：Authority（关闭 `REPOSITORY_AUTHORITY_GAP`）

Sprint 17 **NO NEW AUTHORITY**。所有 repo tools 仍经 `tool.invoke` + company scope +
`ToolRecord.requiredAuthorities` + risk/approval。

## Decision 24：Tool Capability 词汇（Boss 裁定 §64）

V1 仅复用已存在 capability：`read` / `write` / `side_effect` / `validation:validator`。**不得发明**
`repository.read` / `git.readonly` / `terminal.execute`。若 T17 implementation 发现真实 schema 强制
需要新 capability ⇒ **HARD STOP**。

## Decision 25：Tool IDs（Boss 裁定 §65/§66）

generic V1 product IDs：`repo.file-read`、`repo.file-write`、`repo.search`、`repo.terminal`
（必须满足 `TOOL_ID_PATTERN`）。DevCompany 冻结 ID 不变：`repo.test-runner`、`repo.linter`、
`repo.typechecker`、`repo.builder`、`repo.git`、`repo.validation-evidence`——**Sprint 17 不得修改
DevCompany Pack 1.0.0**。

## Decision 26：Process Runner 架构（Boss 裁定 §67–§70）

不为每个 QA tool 复制 child_process 逻辑：应有 generic internal **`RepositoryProcessRunner`**
（或 repo 惯例等价 abstraction）——它不是新的 Tool runtime 系统，只是多个 ToolPort adapter 共用的
OS 执行 primitive。QA tool adapters 是对 trusted command profile slot 的薄 adapter；`repo.terminal`
同样只执行 trusted commandKey；`repo.git` 使用同一 runner 但 argv 完全由 adapter 固定。

## Decision 27：Task 开始 Baseline 与 Workspace 语义（Boss 裁定 §71–§76）

T17.5 冻结：Task 开始时执行 `repo.git op=baseline`，记录 Branch/HEAD/Git Status/Dirty Files/
RepositoryRevisionAnchor 为 durable ToolInvocation——**不新建 task_git_baseline / repository_baseline
表**。T17.7 冻结：**one active WorkspaceContext per process/application**；对同 workspace 的
repository-mutating Agent/tool 操作 **serial execution**；V1 为简单与 evidence 正确性可全部 repository
tool 调用串行（不要求 read-parallel/write-lock 优化）。多 Workspace / parallel Agent / worktree =
future scope。

## Decision 28：Production Composition 与 UI 边界（Boss 裁定 §78–§81）

repo runtime 的 production OS bindings 位于 `apps/desktop/src/main.ts`（或其下符合现有架构的
adapter composition 模块）。Generic Core 不知道 fs / child_process / git executable / physical root。
**New IPC: NO；Renderer change: NO**（Sprint 17 roadmap 无 UI 要求；OpenRepo 是 internal/application
seam）。AC17.3 正式解释：Core remains generic；OS/repository adapters 位于 infrastructure/application
boundary；DevCompany Pack 只声明 `repo.*` requirements——**不要求把 executable adapter 代码塞进 Pack；
Pack 仍 DATA/CONFIG ONLY**。generic runtime 禁止 `if packId == dev-company` / `if role == qa`
特判（DevCompany 只是第一个消费者）。

## Decision 29：Sprint 17 完成态与 QA Runtime Truth（Boss 裁定 §82–§85）

Sprint 17 完成后 production Tool Registry 至少包含六个 DevCompany 冻结 ID，使 **DevCompany 1.0.0
不再因 missing tool/validator fail preflight**。但 **Pack 安装成功 ≠ QA PASS**：QA PASS 必须
execute required real commands → capture durable invocation evidence → same RepositoryRevisionAnchor
→ `repo.validation-evidence` verifies → Validation batch PASS → EvidenceGuard accepts。
`DEVCOMPANY_TOOL_ID_CONTRACT_CONFLICT = NO`；**DevCompany remains 1.0.0**（不创建 1.0.1/1.1.0）。

## Decision 30：Sprint 17 Checkpoint（Boss 裁定 §86）

Sprint 17 权威 roadmap checkpoint = `sprint-17`；Sprint 16 已按同类明确 checkpoint 使用
`sprint-16`。因此 **Sprint 17 closeout annotated tag = `sprint-17`**（不得替换为 `sprint-17.0.0`）。

## Decision 31：Planning Recon 7 项 Gap 关闭清单

| Gap | 状态 | 关闭方式 |
|---|---|---|
| `REPOSITORY_ROOT_AUTHORITY_GAP` | **CLOSED** | Decision 2/3（trusted composition root + WorkspaceContext + workspaceId） |
| `REPOSITORY_PATH_BOUNDARY_GAP` | **CLOSED** | Decision 5/6/7（canonicalization + RepositoryPathPolicy + symlink fail-closed + `.git` 边界） |
| `TERMINAL_EXECUTION_MODEL_GAP` | **CLOSED** | Decision 10/11（no shell string；executable+argv；trusted command profile；no free-form args） |
| `TERMINAL_SANDBOX_BOUNDARY_GAP` | **CLOSED** | Decision 11/12（V1 不声称 OS sandbox；host execution 的 9 项前提 + env/secret/network 规则；作为已知限制记录） |
| `REPO_GIT_CAPABILITY_VOCAB_GAP` | **CLOSED** | Decision 14（one ToolRecord `repo.git` + typed op；不新增 capability token） |
| `TOOL_OUTPUT_BOUNDARY_GAP` | **CLOSED** | Decision 18/19（16 KiB inline / 8 MiB capture / CAS 外置 / digest / timeout+cancel） |
| `REPOSITORY_EVIDENCE_FRESHNESS_GAP` | **CLOSED** | Decision 15/16/17（RevisionAnchor + pre/post anchor + currentAnchor 复核 + verifier-only validator） |

另两项 Planning Recon 待裁项一并裁定：**Repository/Workspace durable entity = NO / New Migration = NO**
（Decision 1）；**tag = `sprint-17`**（Decision 30）。

## Rejected（明确不做）

model-controlled shell string；任意 executable/任意 argv；wholesale env 继承；SecretVault 自动桥接；
OS sandbox 声称（V1）；Git mutation（含默认 Push 开关）；第二套 blob store / validation 表 / baseline 表；
第二套 timeout / 确认系统 / Tool runtime；新 authority；新 capability token（repository.read/git.readonly/
terminal.execute）；DevCompany 特判；多 Workspace / worktree / parallel Agent；Pack 内 executable adapter
代码；为 QA 把 validator 与 executor 混为一体。

## Consequences

- T17-02 实现 WorkspaceContext + openWorkspace seam + RepositoryPathPolicy + workspaceId + path escape
  测试（不写 Tool adapters）。
- T17-03 实现 `repo.file-read` / `repo.file-write` / `repo.search`。
- T17-04 实现 `RepositoryProcessRunner` + `repo.terminal` + 四个 QA command tools。
- T17-05 实现 `repo.git`（status/diff/baseline）+ RepositoryRevisionAnchor + Task-start baseline。
- T17-06 实现 `repo.validation-evidence`（verifier-only，ToolInvocation → Validation batch → EvidenceGuard）。
- T17-07 单 Workspace + 串行 repository 执行 + task-start baseline 编排。
- T17-08 production composition（apps/desktop）+ E2E（真实临时 Git repo）+ DevCompany production
  installability 证明。
- T17-09 全量回归 + 文档收口 + annotated tag `sprint-17`。
