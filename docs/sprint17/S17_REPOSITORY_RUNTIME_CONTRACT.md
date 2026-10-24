# Sprint 17 — Repository Runtime 契约（T17-01 冻结）

> 状态：**IMPLEMENTED / FROZEN**（ADR-0028 仍 Accepted；T17-01~T17-09 全部 CLOSED，closeout 见
> `docs/SPRINT17_CLOSEOUT.md`）。本文件是 ADR-0028 的实现级展开（冲突时以 ADR-0028 为准）；
> 历史决策未重写， corrective 记录保留在 `S17_TASK_BREAKDOWN.md`。
> 上游：`docs/EXECUTION_ROADMAP.md` Sprint 17 段（Mission/T17.1–T17.6/AC17.1–17.3/Tests/Git
> Checkpoint `sprint-17`）、`docs/V1_1_RECONCILIATION.md`、ADR-0013/0019/0015/0017/0020/0023、
> ADR-0024~0027（Pack）、Sprint 16 closeout（DevCompany 冻结 tool IDs）。

## 1. Mission 与范围

**Mission**：让 Agent 能真正打开项目仓库并使用文件系统、搜索、终端、Git（roadmap 原文）。
**V1 范围**（source-supported）：Open Repo（trusted workspace root）→ 读/写 UTF-8 文本 → 搜索 →
受控命令执行（固定命令表）→ Git 只读（status/diff/baseline）→ Task 开始基线 → QA 证据链。
**不在范围**：Renderer UI、IPC、多 Workspace、worktree、parallel Agent、Git mutation、
container/VM/OS 隔离、marketplace、remote repository、Pack 内 executable 代码。

## 1.1 实现落点（T17-02 已落地）

- `packages/engine/src/repository/workspace.ts`：`createWorkspaceManager()`（process-local
  0/1 active）、`WorkspaceContext {workspaceId, canonicalRoot, commandProfile}`、
  `workspaceIdOf()`（`sha256:<64hex>`）、`RepositoryCommandProfile`/`RepositoryCommandDescriptor`、
  `RepositoryOperation`（READ/WRITE/SEARCH）。
- `packages/engine/src/repository/path-policy.ts`：`createRepositoryPathPolicy()`（唯一路径权威）、
  `ResolvedRepositoryPath {workspaceId, relativePath, internalAbsolutePath}`。
- 放置依据：engine 已持 OS runtime primitive（`node:crypto`/`node:async_hooks`），Core/Contracts
  禁 `node:`（boundary gate LAW 1b）；CAS reparse-point 拒绝为技术模式先例。Core 不含 fs/path。
- 错误 taxonomy（`INVALID_ARGUMENT` + `details.reason`）：`REPOSITORY_ROOT_NOT_ABSOLUTE` /
  `REPOSITORY_ROOT_MISSING` / `REPOSITORY_ROOT_NOT_DIRECTORY` /
  `REPOSITORY_WORKSPACE_ALREADY_OPEN` / `REPOSITORY_COMMAND_PROFILE_MISMATCH` /
  `REPOSITORY_WORKSPACE_NOT_OPEN` / `REPOSITORY_WORKSPACE_MISMATCH` /
  `REPOSITORY_PATH_NOT_STRING` / `REPOSITORY_PATH_EMPTY` / `REPOSITORY_PATH_NUL` /
  `REPOSITORY_PATH_ABSOLUTE` / `REPOSITORY_PATH_DRIVE_QUALIFIED` / `REPOSITORY_PATH_UNC` /
  `REPOSITORY_PATH_DEVICE` / `REPOSITORY_PATH_EMPTY_SEGMENT` /
  `REPOSITORY_PATH_PARENT_ESCAPE` / `REPOSITORY_PATH_OUTSIDE_ROOT` /
  `REPOSITORY_PATH_REPARSE_POINT` / `REPOSITORY_PATH_GIT_INTERNAL`。错误只携带
  `relativeInput` + `reason` + `workspaceId`（不泄漏 physical root）。

## 2. Workspace 与 Root 权威（ADR-0028 D2–D5）

- root = **trusted application/composition 配置**（`openWorkspace({ root, commandProfile })` 语义；
  命名按 repo 风格）；model/prompt/Tool input/PackManifest/RunSnapshot 都不能提供或覆盖 root。
- `WorkspaceContext`（process-local，至少）：`canonicalRoot`、`workspaceId`、`commandProfile`。
- `workspaceId` = `sha256:<64 lowercase hex>`，由 canonical real root 派生；Tool output/event 只出现
  workspaceId，**不出现原始绝对路径**。
- root canonicalization：必须存在、必须是目录、`realpath(root)`、platform-normalized canonical
  absolute path；创建后不可被 Agent 修改。
- model 只能提供 **workspace-relative path**；拒绝 absolute / drive-letter / UNC / `\\?\` device /
  `..` / NUL / 空或非法 segment；`.` 仅在操作明确允许 root 时。
- **Restart**：WorkspaceContext 不 durable ⇒ 重启后 repo tools unavailable 直到重新 openWorkspace；
  禁止从旧 ToolInvocation 反推物理路径；已有 Run/Recovery 数据仍可读。

## 3. 路径策略 `RepositoryPathPolicy`（ADR-0028 D6/D7）

- containment：`resolvedTarget is inside canonicalRoot`，platform-aware（Windows 按文件系统语义
  大小写不敏感），**不是字符串 prefix**。
- symlink/junction：**V1 fail closed**——已有路径段 `lstat`/`realpath` 验证不逃逸；待创建文件检查
  nearest existing parent 真实位于 root 内。
- `.git/**`：普通 filesystem write 禁止；read/search 默认排除；Git 内部只经 `repo.git`。

## 4. Filesystem / Search V1（ADR-0028 D8/D9）

| 能力 | V1 契约 |
|---|---|
| `repo.file-read` | UTF-8 text；relative only；`.git` 排除；binary ⇒ explicit `UNSUPPORTED_BINARY`（fail closed，不 base64 塞模型） |
| `repo.file-write` | create/overwrite UTF-8 text；relative only；atomic replace where practical；parent 过 path policy；可建缺失父目录（root 内、无 symlink 逃逸）；禁 `.git/**` |
| `repo.search` | root-scoped、read-only、text/code；同一路径边界；默认忽略 `.git`、`node_modules`、trusted 配置的 generated/build 目录；不 shell out |
| 不做 | delete / rename / move / chmod / symlink 创建 / binary 编辑 / 任意目录 mutation |

## 4.1 实现落点与冻结边界（T17-03 已落地）

- **代码**：`packages/engine/src/repository/repository-tools.ts`（导出经 `packages/engine/src/index.ts`）；
  测试 `tests/sprint17/repository-tools.test.ts`（20 项）。
- **Tool 规格（冻结）**：三个 ToolRecord 均为 version `1.0.0`、`providerKind: 'repository'`、
  `requiredAuthorities: ['tool.invoke']`；`repo.file-read`（LOW / capability `read` /
  idempotencyMode `IDEMPOTENT_KEY`）；`repo.file-write`（MEDIUM / `write` / `COMMAND_ID`）；
  `repo.search`（LOW / `read` / `IDEMPOTENT_KEY`）。input schema **不含** `cwd`/`absolutePath`/
  `workspaceRoot`/env/process 任何字段；路径决策 100% 走 §3 的 `RepositoryPathPolicy`。
- **冻结上限**（Boss 裁定，T17-03）：`MAX_TEXT_FILE_BYTES = 4 MiB`（read+write，
  `FILE_SIZE_LIMIT_EXCEEDED`）；`MAX_SEARCH_FILES = 10_000`；`MAX_SEARCH_MATCHES = 1_000`；
  `MAX_MATCH_LINE_PREVIEW_BYTES = 512`（任一达限 ⇒ 结果带 `truncated: true`，仍返回已收集部分）。
- **输出形状**：read ⇒ `{workspaceId, relativePath, sizeBytes, sha256, content}`；write ⇒
  `{workspaceId, relativePath, sizeBytes, sha256, created}`；`sha256` = `sha256:<64hex>` 的内容字节摘要。
  **不出现**绝对路径 / cwd / 宿主目录名；错误只带 `{relativePath?, workspaceId, reason}`。
- **workstation 状态**：未 `openWorkspace` ⇒ 三个工具一律 `WORKSPACE_NOT_OPEN`（fail closed）；
  WorkspaceContext 仍是 process-local，重启后不恢复（§2 Restart）。
- **注册位置**：`apps/desktop/src/main.ts` 的 `composeCoreServices`（T17-02 同处）——process-local
  `repositoryWorkspace` manager + 三个 ToolRecord + 三个 ToolPort adapter（`workspace: () =>
  repositoryWorkspace.current()`）。**production registry 只注册这三个** repository 工具；
  V1 无应用侧 openWorkspace 调用 ⇒ repo tools 在生产环境保持 fail closed，直到受信 seam 打开
  workspace。无 IPC / renderer / migration / authority 变更。
- **两处冻结表与实现的偏差（如实记录，非放松）**：
  1. §4 表原写 write"可建缺失父目录"——**实现取更严口径：父目录必须已存在**
     （`PARENT_MISSING` fail closed）；V1 不自动创建目录树（防误建、减少竞态面）。
  2. §4 表原写 search 忽略"trusted 配置的 generated/build 目录"——**V1 实现为硬编码跳过**
     `.git`/`node_modules`/`.next`/`target`，暂不支持 trusted-config 生成目录清单（留给后续任务，
     不静默放宽扫描范围）。
- **TOCTOU 限制（已知，非 V1 缺陷修复项）**：path policy 的 reparse 检查与 adapter 的 `statSync`/
  `open` 之间、以及 search 遍历与单文件读取之间存在竞态窗口（根在受信应用手中，但宿主进程理论上可
  在两次系统调用之间替换路径）。V1 缓解：所有路径经同一 policy、symlink 一律拒绝（而非"链接指回
  root 内则放行"）、workspace root 由受信组合层提供且不可被 Agent 修改。**这不是 OS 级隔离声明**。

## 5. 受控命令执行（ADR-0028 D10–D12）

- **no model-controlled shell string**；执行模型 = native executable + `argv[]` + `shell=false`。
- `RepositoryCommandProfile`（trusted，随 WorkspaceContext）定义允许命令槽位（至少 tests/lint/
  typecheck/build + 未来受控 generic slot）；descriptor = `executable` / `argv` / `cwd policy` /
  `safe env allowlist additions`；模型不可覆盖 executable/base argv/workspace 外 cwd/env/shell flag。
- **默认 no free-form extra args**；将来参数必须 descriptor 内 typed/validated/allowlisted。
- Windows wrapper：禁用 `cmd.exe /c`、`powershell -Command`、`sh -c`、`bash -c`；`.cmd/.bat` 必须解析为
  explicit interpreter + fixed script path + fixed argv。
- **env = filtered only**（禁 wholesale 继承）：Windows 最小集 `PATH`/`PATHEXT`/`SystemRoot`/`WINDIR`/
  `TEMP`/`TMP`；POSIX `PATH`/`TMPDIR`/`LANG`/`LC_*`（when required）。
- **secrets 绝不自动传入**（API keys/cloud creds/`SSH_AUTH_SOCK`/GitHub token/npm token/provider
  creds/SecretVault values）；SecretVault 不自动桥接。
- **sandbox**：V1 不声称 OS 级隔离；host execution 仅当 9 项前提全部成立（trusted root / fixed
  profile / no model executable / no shell / workspace cwd / filtered env / no auto secrets /
  bounded output / timeout+cancel / Tool Registry authority+risk+audit）。arbitrary terminal = NOT IN
  SCOPE；generic terminal（若实现）= allowlisted-command executor（`repo.terminal { commandKey }`）。
- **network**：无 OS 隔离 ⇒ 不声称"不可能"；产品规则 = runtime 无网络工具 + profile 不故意配网络命令；
  host executable 技术上可联网 = **已知限制**。

## 5.1 实现落点与冻结边界（T17-04 已落地）

- **代码**：`packages/engine/src/repository/repository-process-runner.ts`（唯一 spawn 点）
  + `packages/engine/src/repository/repository-process-tools.ts`（五个薄 adapter）；测试
  `tests/sprint17/repository-process-tools.test.ts`（32 项）。
- **执行模型**：`spawn(executable, argv, { shell: false, cwd: canonical workspace root,
  env: <filtered> })`；executable/argv/cwd/env 只来自 trusted `RepositoryCommandProfile`。
  QA 工具 input schema 为**空对象**（不接受任何参数）；`repo.terminal` input 仅 `{ commandKey }`。
- **Tool 规格（冻结）**：version `1.0.0`、`providerKind: 'repository'`、`requiredAuthorities:
  ['tool.invoke']`、auditPolicy `STRICT`；`repo.terminal` HIGH / `side_effect` / `NONE` /
  timeout 300000；`repo.test-runner` MEDIUM / `side_effect` / `NONE` / 600000；`repo.linter`
  300000；`repo.typechecker` 300000；`repo.builder` 600000。timeout 由 composition 注入 timer
  （engine 不持定时器——boundary gate）。
- **环境**：Windows `PATH`/`PATHEXT`/`SystemRoot`/`WINDIR`/`TEMP`/`TMP`；POSIX
  `PATH`/`TMPDIR`/`LANG`/`LC_*`；**绝不** `env: process.env`；SecretVault 不桥接（runner 无 vault
  引用）；`safeEnvAdditions` 只信 trusted profile，且密钥形状（TOKEN/SECRET/PASSWORD/CREDENTIAL/
  KEY/AUTH 与显式名单）**fail closed**。
- **输出**：分 stream `{byteCount, sha256, binary, preview, truncated, artifactRef}`；
  `preview` ≤ 16 KiB（UTF-8 字节口径，按码点边界回退，不产生 lossy 文本）；binary ⇒ `binary=true`
  且 `preview=''` 且全字节外置；capture ≤ 8 MiB/stream，达限**立即终止进程树** +
  `OUTPUT_LIMIT_EXCEEDED`；完整字节经既有 Artifact/CAS content store 外置
  （`sha256:<64hex>`；不建第二套 blob store，不写 workspace，不落临时文件）。
- **取消**（recon 发现，如实记录）：registry 的 timeout 路径调用 `ToolPort.cancel(invocation.id)`，
  而 `ToolRequest` 只暴露 `executionId`——两者无法在 adapter 内直接对应。实现**未修改任何
  registry 语义**：runner 以 `executionId` 为键维护活跃进程表，`cancel(invocationId)` 经
  composition 注入的只读 durable invocation 查找（production 为 `toolInvocations.get`）解析
  invocationId→executionId 后终止进程树；无法解析 ⇒ `PROCESS_CANCEL_UNRESOLVED`（诚实失败，
  不静默丢kill）。
- **进程树终止**：Windows 用 `taskkill /pid <pid> /T /F`（固定 argv、shell:false，由 runtime
  自身发起，非模型可控），**必须先于**直接 kill——先杀父进程会把孙子进程变成孤儿（本机实测）。
  POSIX 用 detached 进程组 + `process.kill(-pid, SIGKILL)`。taskkill 失败才回退直接 kill。
- **失败证据持久化**（T17-04 CORRECTIVE 已落地，Boss 裁定 `PROCESS_FAILURE_EVIDENCE_GAP`）：
  一旦 process 实际启动，无论 COMPLETED/FAILED/TIMEOUT/CANCELLED/OUTPUT_LIMIT_EXCEEDED，
  都必须能从 durable 数据重建：invocation 身份、workspaceId、commandKey、exitCode|signal|
  duration、分 stream `{byteCount, sha256, binary, preview, artifactRef}`、失败分类。
  实现：失败时 tools 层把一个**有界** evidence 对象（schema
  `companyos/repository-process-evidence/1`，previews 已各自 ≤ 16 KiB，整体 < 64 KiB）写进既有
  CAS，并把 `[evidenceRef, stdoutRef?, stderrRef?]` 一起交给 registry；registry 的 FAILED
  terminal write 通过**既有** `tool_invocation_artifacts` 关系（`UNIQUE(invocation_id,
  artifact_ref)`、无 status 列、`toolInvocations.get/list` 会带出）幂等链接这些 ref。
  - **timeout 专用路径**：registry 的 timeout race 用它自己的 verdict 作答并丢弃 adapter 的
    错误（本机实测确认：durable 行只留 registry 的 message、无 artifactRefs），因此
    `ToolPort.cancel` 路径（registry 超时唯一调用者）通过 `runner.cancelAndAwait` 等待 run
    沉淀后发布并链接证据；TIMEOUT 与 CANCELLED 按"取消是否落在该 run 自身 deadline 上"分类。
  - **零 migration / 零新列 / 零新表 / 零第二 blob store**；`replay_output_json` 仍只属于
    COMPLETED（Sprint 14 冻结不变，FAILED 重放仍为 FAILED）；`error_message`/`error_code`
    不承载结构化证据（Boss §9/§10）。
  - **引用完整性（FINAL VERIFICATION，Boss 裁定 `FAILED EVIDENCE REFERENCE INTEGRITY`）**：
    FAILED 上报的 refs **不得仅因出现在 `DomainError.details.artifactRefs` 而被信任**。
    规则与 COMPLETED 路径**逐条等价**，并由**同一个**共享组件
    `createFailureEvidenceLinker`（`packages/engine/src/tools/failure-evidence.ts`）执行：
    managed refs（`artifact:art_...`）必须经共享 `durableReferenceResolver` 解析到 durable
    Artifact 行且属于该 invocation 的 run；CAS refs（`sha256:<64hex>`）只做格式校验（与
    COMPLETED 一致—— opaque content identity）；畸形/缺失/跨 run ⇒ **拒绝且永不链接**；
    无 resolver 时 managed 文法 fail closed（同 COMPLETED）。两条链接路径都用它：
    registry 的 FAILED terminal write，以及 process tools 的 cancel/timeout 路径
    （registry 超时 race 会丢弃 adapter 错误，故该路径必须自己发布+链接）。
    返回给调用方的 error 只 advertise **已校验**的 refs，并显式带
    `rejectedArtifactRefs` / `evidenceRefValidation`；链接幂等（`UNIQUE(invocation_id,
    artifact_ref)` 先去重再插入）；**终态先写、链接后写**，因此不存在"有链接无终态"的半提交。
    registry 无 transaction seam（deps 全是 EntityStore，既有设计如此），故沿用既有顺序写形状。
  - COMPLETED 的结构化输出继续走 `replay_output_json`；FAILED 走 CAS evidence 对象。
    T17-06 validator 必须：COMPLETED 读 `replayOutput`，非 COMPLETED 读 relation → CAS。
- **preAnchor/postAnchor**：本轮未实现（T17-05/T17-06），输出中缺席且不伪造。

## 6. Git V1（ADR-0028 D13/D14）

- **READ-ONLY**：`status` / `diff` / `baseline`（baseline = branch + HEAD + git status + dirty files +
  revision anchor）。不做 add/commit/checkout/switch/branch/reset/clean/merge/rebase/push/pull/fetch/tag/
  stash mutation；不默认 Push（AC17.2）。
- **one ToolRecord `repo.git`**，typed input `op: status | diff | baseline`；argv 完全由 adapter 固定；
  input schema 不存在 `push`。**不新增 capability token**（继续用 `read`）。
- 每个 repository command 记录 `preAnchor`/`postAnchor`/`workspaceId`；QA 六命令若
  `preAnchor != postAnchor` ⇒ validator 默认 FAIL CLOSED。

## 6.1 实现落点（T17-05 已落地）

- **代码**：`packages/engine/src/repository/repository-git.ts`（anchor 算法 + 边界检查 +
  provider）、`repository-git-tools.ts`（`repo.git` 薄 adapter）；T17-04 runner 增加 opt-in
  `includeStreamBytes`（同一 capture 机制，≤8 MiB/stream，仅内部解析）。
- **唯一 spawn 点**：所有 Git CLI 调用复用 T17-04 `RepositoryProcessRunner`（无第二 spawn/exec/
  shell）。executable 来自 trusted composition（production `git`，经 filtered PATH 解析）；
  模型只能选 `op`。
- **安全前缀（每次调用）**：`--no-pager -c core.fsmonitor=false -c core.untrackedCache=false`；
  diff 额外 `--no-ext-diff --no-textconv --no-color`；trusted env `GIT_OPTIONAL_LOCKS=0`、
  `GIT_TERMINAL_PROMPT=0`。⇒ read-only 查询不会因 optional refresh 写 index、不会弹交互 prompt、
  不会启动仓库配置里的外部程序（测试实证：恶意 `diff.external`/`core.fsmonitor`/`core.pager`
  均未执行，HEAD/index/refs 不变）。
- **root 精确匹配（本 Task 关键边界）**：`git rev-parse --show-toplevel` 的 canonical real path
  必须**等于** active WorkspaceContext canonicalRoot；workspace 只是更大父仓库的子目录 ⇒
  `GIT_ROOT_OUTSIDE_WORKSPACE` 拒绝，绝不操作父仓库。`--absolute-git-dir` 必须在 workspace 内
  ⇒ linked worktree / external git dir ⇒ `GIT_WORKTREE_UNSUPPORTED`；bare ⇒
  `GIT_BARE_REPOSITORY_UNSUPPORTED`；`ls-files --stage` 出现 160000 ⇒
  `GIT_SUBMODULE_UNSUPPORTED`；untracked 目录内发现 `.git` ⇒ `GIT_NESTED_REPOSITORY_UNSUPPORTED`
  （绝不递归进另一个仓库）。
- **锚点算法（T17-05 CORRECTIVE 后 = schema v3，三层独立输入）**：
  `sha256("companyos/repository-anchor/3" + head + branch + 每个 entry 的
  XY/path/kind/origPath + headMode:headOid + indexMode:indexOid + worktreeMode + 工作树内容摘要)`。
  **HEAD、INDEX、WORKING TREE 是三个独立输入**：porcelain v2 的 `mH/mI/mW/hH/hI` 全部纳入，
  因此"只改 staged blob、工作树与 XY 都不变"也必然改变 fingerprint（Boss 反例已实测并固化为
  测试）；index mode（可执行位）变化同样改变 fingerprint；rename 的 origPath 单独纳入
  （`-z` 模式下它是紧随其后的 NUL 记录）。对内容敏感（HEAD/staged/unstaged/untracked 路径与
  内容/deletion），对 mtime 不敏感；regular file 流式 sha256；symlink 只读 link 目标文本；
  untracked 目录递归（跳过 `.git`）；deleted ⇒ `absent`（不哈希不存在的字节）。
  **ignored 文件不纳入**（写明的 limitation）；clean tracked 文件不进入 entry 集合，
  故 `MAX_GIT_STATE_ENTRIES = 10,000` 仍只数 dirty/untracked 条目。
- **Anchor 不是 durable 实体**：进 structured Tool output，由既有 ToolInvocation 持久化；
  `repo.git op=baseline` 即 durable Task-start 证据（带 runId/taskId）。**自动 task-start
  baseline wiring = T17-07**，本任务不改 Task/Workflow/scheduler。
- **QA 4 工具**：success output 含 `preAnchor`/`postAnchor`（进 replay_output_json，重启可恢复）；
  非受支持 git 仓库 ⇒ fail closed（不返回无法证明 freshness 的 QA success）；`pre != post` 只记录
  事实，本任务不改 invocation 状态（T17-06 validator 负责 fail closed）。`repo.terminal` 不强制
  git（generic terminal 与 QA evidence 的差别已写明）。
- **错误 taxonomy**（现有体系词汇）：`WORKSPACE_NOT_OPEN`、`NOT_A_GIT_REPOSITORY`、
  `GIT_UNAVAILABLE`、`GIT_ROOT_OUTSIDE_WORKSPACE`、`GIT_BARE_REPOSITORY_UNSUPPORTED`、
  `GIT_WORKTREE_UNSUPPORTED`、`GIT_SUBMODULE_UNSUPPORTED`、`GIT_NESTED_REPOSITORY_UNSUPPORTED`、
  `GIT_PATH_ENCODING_UNSUPPORTED`、`GIT_STATE_LIMIT_EXCEEDED`、`GIT_COMMAND_FAILED`；
  失败错误只带 command/exitCode/workspaceId，raw stderr 不进 DomainError message（host 路径），
  原始 stream evidence 仍按 T17-04 CAS 规则外置。
- **invocation anchoring（T17-05 FINAL INTEGRATION）**：`repo.git op=status` 与 `op=diff` 现在都
  durable 输出 `preAnchor`/`postAnchor`（类型即唯一正式 `RepositoryRevisionAnchor`，取值来自
  **同一个** `RepositoryRevisionAnchorProvider`——QA 工具、`getCurrentAnchor()`、baseline 共用，
  不存在第二算法）。顺序：`preAnchor = getCurrentAnchor()` → 执行只读 git 命令 →
  `postAnchor = getCurrentAnchor()`，因此"命令执行期间仓库被并发改变"可被检测。
  `repo.git` **只记录事实**：`pre != post` 时 ToolInvocation 仍为 COMPLETED（freshness verdict 属于
  T17-06）。既有字段（workspaceId/branch/headSha/isDirty/dirtyFiles/processOutput）全部保留；
  baseline 的 `anchor` 契约不变（T17-07 baseline contract 不动）。input schema 仍只有 `op`，
  caller 无法提供 anchor/args（测试实证）。diff 的 16 KiB preview / 8 MiB capture / CAS 外置 /
  binary / failure evidence 全部不变。⇒ **T17-06 的六条证据（test-runner/linter/typechecker/
  builder/git diff/git status）现在都带 revision anchor evidence**。
- **production 工具集**：9 个 repository 工具（3 filesystem + 5 process + repo.git）；
  `repo.validation-evidence` 仍未注册 ⇒ DevCompany 1.0.0 安装仍 fail closed 于
  `PACK_VALIDATOR_MISSING`（真实 9 工具 registry 测试实证）。

## 7. RepositoryRevisionAnchor 与 QA 证据（ADR-0028 D15–D17）

- anchor（generic concept，**非新表**）：`workspaceId`、`headSha | null`、`workingTreeFingerprint`
  （+ 可选 `branch`、`dirtyFiles` 审计字段）。
- fingerprint 覆盖 HEAD identity + staged + unstaged + untracked（**不能只 hash status 文件名**）；
  推荐 `git diff --binary --cached HEAD` + `git diff --binary` + sorted untracked path+content hash 的
  streaming SHA-256；unborn HEAD ⇒ `headSha = null` 仍覆盖当前状态；不把巨大 diff 全文持久化。
- **Task 开始基线**（T17.5）：`repo.git op=baseline` 记为 durable ToolInvocation（**不建
  task_git_baseline/repository_baseline 表**）。
- `repo.validation-evidence` = **VERIFIER ONLY**：不 rerun 任何命令；验证 ToolInvocation 记录
  （toolId/toolVersion/status/structured output/revision anchors/artifact refs）+ required invocations
  （same run / same task-stage / same workspaceId / SUCCESS / exitCode success / matching anchor）+
  **验证前重读 currentAnchor == evidenceAnchor**（否则 STALE EVIDENCE / FAIL）→ 交既有
  ValidationService 记 batch → EvidenceGuard unchanged。LLM 文本永不为证据（anti-forgery）。

## 8. 输出边界（ADR-0028 D18/D19）

- process tool 结构化输出至少：`exitCode`、`signal`、`durationMs`、`stdoutPreview`、`stderrPreview`、
  `stdoutArtifactRef?`、`stderrArtifactRef?`、`preAnchor`、`postAnchor`、`workspaceId`（以真实 output
  schema 规范化）。
- **inline preview = 16 KiB/stream**（超出不进 `replay_output_json`）；**capture = 8 MiB/stream**
  （达上限 ⇒ terminate + `OUTPUT_LIMIT_EXCEEDED` 或等价 fail-closed）。
- 完整输出 > preview 且 ≤ capture ⇒ **现有 Artifact/managed ref/CAS 外置**（不建第二套 blob store）；
  二进制 ⇒ 原始 bytes 外置 + inline 预览空 + `binary=true`；`outputDigest` 保留。
- timeout 复用 `ToolRecord.timeoutMs` + registry timeout 路径；cancel 经 `ToolPort.cancel?`（或既有
  等价）；timeout/cancel 必须实际终止 child process tree（Windows/POSIX）。

## 9. Tool 规格矩阵（ADR-0028 D21–D25）

| ToolRecord | 能力 | riskLevel | idempotency | 说明 |
|---|---|---|---|---|
| `repo.file-read` | `read` | LOW | read/idempotent | UTF-8 text，相对路径，排除 `.git` |
| `repo.file-write` | `write` | MEDIUM | deterministic command-idempotent write | atomic replace；禁 `.git` |
| `repo.search` | `read` | LOW | read/idempotent | root-scoped 只读 |
| `repo.terminal` | `read`/`write` 按命令槽位裁定 | HIGH | **NO automatic retry** | allowlisted commandKey only |
| `repo.test-runner` | `read` | MEDIUM | NO automatic retry | command profile slot：tests |
| `repo.linter` | `read` | MEDIUM | NO automatic retry | slot：lint |
| `repo.typechecker` | `read` | MEDIUM | NO automatic retry | slot：typecheck |
| `repo.builder` | `write`（按裁定） | MEDIUM | NO automatic retry | slot：build |
| `repo.git` | `read` | LOW | read/idempotent | op ∈ {status,diff,baseline} |
| `repo.validation-evidence` | `validation:validator` | LOW | read/verifier idempotent | verifier-only |

- **T17-04 已实现**（上表前 5 行）：`repo.terminal` HIGH、四个 QA 工具 MEDIUM，均 `side_effect`、
  idempotencyMode `NONE`（NO automatic retry），timeout 按 Boss 冻结值（见 §5.1）。后 5 行
  （`repo.git`/`repo.validation-evidence`）**未实现**。
- **NO NEW AUTHORITY**：全部经 `tool.invoke` + company scope + requiredAuthorities + risk/approval。
- capability 词汇仅复用 `read`/`write`/`side_effect`/`validation:validator`；发现 schema 强制需要新
  token ⇒ HARD STOP。
- `RepositoryProcessRunner` = 多个 ToolPort adapter 共用的 OS 执行 primitive（不是新 Tool runtime
  系统）；QA tools 是对 command profile slot 的薄 adapter；`repo.git` 用同一 runner 但 argv 固定。

## 10. Recovery / Workspace 语义 / 组合（ADR-0028 D20/D27/D28）

- Recovery：Sprint 14 语义不变（STARTED→INTERRUPTED；no auto external retry；explicit retry only）。
- **one active WorkspaceContext per process**；同 workspace 的 repository-mutating 操作 **serial**；
  V1 可全部串行（不要求 read-parallel/write-lock）。
- production OS bindings 位于 `apps/desktop/src/main.ts`（或其下 adapter composition 模块）；
  Generic Core 不知道 fs/child_process/git/物理 root。
- **New IPC = NO；Renderer change = NO**（roadmap 无 UI 要求；OpenRepo 是 internal/application seam）。
- AC17.3 解释：Core generic；OS/repo adapters 在 infrastructure/application boundary；Pack 只声明
  `repo.*` requirements（Pack 仍 DATA/CONFIG ONLY）；generic runtime 禁 DevCompany 特判。

## 10.1 Durable QA Evidence Validator（T17-06 已落地）

- **代码**：`packages/engine/src/repository/command-fingerprint.ts`（
  `repositoryCommandDescriptorFingerprint`）、`repository-process-tools.ts`（QA output 增加
  `commandDescriptorFingerprint`）、`qa-evidence.ts`（verifier-only 校验内核 + 两个 trusted
  端口 + canonical report）、`validation-evidence-tools.ts`（`repo.validation-evidence`）。
- **Tool 规格**：toolId `repo.validation-evidence`、version `1.0.0`、capability
  `validation:validator`（`TOOL_CAPABILITY_VALIDATOR`）、risk `LOW`、authority
  `['tool.invoke']`、idempotency `IDEMPOTENT_KEY`、timeout 120000、providerKind `repository`。
  Input schema 只接受 ValidationService 固定下发的 `targetRef/artifactId/runId/kind/contentRef/
  contentHash/sizeBytes`；**不能**传 invocationIds / anchor / stdout / expectedResult
  （additionalProperties false ⇒ pre-spawn 前拒绝）。scope（runId/taskId）来自 trusted
  invocation context（ToolRequest），不是 payload。
- **六条必需证据**：`repo.test-runner`/`repo.linter`/`repo.typechecker`/`repo.builder`（各需
  匹配 commandKey 与当前 descriptor 指纹 + exitCode 0）+ `repo.git` op=`status` +
  `repo.git` op=`diff`。`baseline` 不是六条之一。
- **verifier-only**：零 child_process / fs / network / 命令重执行；只读 durable ToolInvocation
  + 当前 ToolRecord + currentAnchor（**最后读取**）。evidence 来自 trusted
  `RepositoryEvidenceSource`（composition 拥有的只读查询），且**每行都重新按 runId/taskId
  复验**，因此 source 无法制造 provenance。
- **PASS 需同时满足**：六条 latest terminal 且 COMPLETED；版本匹配；commandKey 匹配；
  descriptor 指纹匹配当前 trusted profile；各自 pre==post；六条 anchor 核心 identity 全等；
  同一 workspace/run/task；currentAnchor == evidenceAnchor。否则 FAIL（含
  `missingSlots`/`reasons`，不泄露 host 信息）。
- **durable provenance**：validator 输出的 `report` 经**既有** ArtifactService 物化为
  `artifact:art_<id>`（同一 run）并进 evidenceRefs；Validation 记录的 targetRef 仍必须是
  既有 `artifact:art_<ulid>` 文法。**不发明新 reference namespace、不建新表、不加 migration、
  不改 EvidenceGuard/ValidationService 语义**。
- **产品里程碑**：DevCompany 1.0.0 在 production-style 十工具 registry 下**真实安装成功**
  （六 tool 需求 + validator 能力全部满足；PackContentRefs 24 / **Pack roles 5** /
  **owner system role 1** / workflow template 1 / 自动角色分配 0；packless Run 继续支持）。
  **安装 ≠ QA PASS**：新 run/task 无六条证据 ⇒ validator 仍 FAIL。
- **不实现**：自动 task-start baseline（T17-07）、scheduler/Task hook、任何 Git mutation、
  IPC/Renderer、DevCompany 改动。

## 10.2 Task-Start Baseline & Serial Agent V1（T17-07 已落地）

- **权威 seam**：engine task loop 在 `step(task,'START')` 后调用
  `StageHandlerRegistry.resolve(kind).execute(ctx)`；repository-capable handler 即挂在此处
  （composition 注册 ⇒ generic 能力标记，无 pack/role 特判）。
- **顺序（冻结，T17-07 CORRECTIVE 后）**：active workspace 必须存在 → **acquire lease** →
  defense-in-depth workspace 复检 → `repo.git op=baseline`（真实 registry.invoke；
  deterministic key `task-baseline:<runId>:<taskId>` ⇒ exactly-once，重试/重入/恢复均
  replay 原始 invocation）→ baseline 的 workspaceId 必须等于当前 workspace → repository 工作
  → `finally` release。**lease 覆盖 baseline 采样到 work 开始的整个窗口**（corrective 前是
  "availability probe → baseline → acquire"，两者之间存在第二 Agent 改写仓库的竞态窗口；
  且 exactly-once key 会持续 replay 旧 baseline，错误无法自愈）。
- **Lease 作用域（诚实声明）**：lease 是 **process-local 的 CompanyOS 执行互斥**，
  不是 OS/文件系统锁。OS 外部进程或用户直接改仓库不在 lease 管辖范围内。
- **Workspace lease**：process-local 0/1；绑定 workspaceId/runId/taskId/executionId；第二
  执行（任何 run/task）⇒ `REPOSITORY_AGENT_BUSY`（不排队）；leased 期间 close ⇒
  `WORKSPACE_IN_USE`（close→open 因此绕不开）；release 覆盖 success/failed/cancelled/抛异常。
- **Recovery**：lease 不 durable ⇒ crash 后自然消失；恢复 = trusted reopen 同 workspace +
  workspaceId 相同 ⇒ 复用原 baseline（不重采）→ 重新 acquire；不同 workspace ⇒ 拒绝；
  **不要求** currentAnchor == task baseline（任务会改代码）。
- **未做**：自动 QA scheduler、Task final diff、rollback、并行 Agent、多 workspace、
  worktree、新工具/authority/migration/表、IPC/Renderer、DevCompany 改动。

## 10.3 Production Composition（T17-08 已落地）

- **production entry**：`apps/desktop/src/core-services.ts` 的
  `composeCoreServices(db, logger, { artifactFoundation, repositoryRuntime? })`（从 `main.ts`
  抽出的 electron-free 模块；桌面启动与生产 E2E **同一入口**）。`repositoryRuntime.
  repositoryCapableKinds` 是唯一可信配置 seam，**默认为空 ⇒ fail closed**；模型 / agent
  payload / workflow payload / pack manifest 均不可触达。
- **接线模块**：`apps/desktop/src/repository-runtime.ts` →
  `composeRepositoryRuntime({db, registry:()=>…, contentStore, clock, ids, actorId,
  repositoryCapableKinds})`，返回 `{toolPorts, registerTools, evidenceSource, toolRecords,
  handlers, openWorkspace, closeWorkspace, currentWorkspace, workspace, lease, anchors,
  getBaseline}`；由上述 production entry 调用。E2E 与桌面启动**同一入口**（只参数化 db path /
  CAS root / command profile / kind 集合 / clock·ids）。
- **engine 零改动**：`composeSprint13Application` 接受可选 `stageHandlers`，与既有
  `createScriptedRegistry` 合并（repository kind 优先，其余不变）。
- **repository-capable kind**：generic `work`（本仓 manifest 与 Sprint 13/14 engine 测试
  一直使用的 generic task kind）。判定 = production entry 的可信参数
  `repositoryRuntime.repositoryCapableKinds`（**默认为空** ⇒ 无 kind repository-capable，
  fail closed）；无 packId/role 特判；非声明 kind 仍走 scripted handler。
- **受信 seam**：`openWorkspace({root, commandProfile})` 只接受 trusted host 调用；
  不是 Tool / IPC / Renderer；禁止 `process.cwd()` 自动开、记忆 last path、或从
  ToolInvocation 反推 root。无 workspace ⇒ 运行时正常启动、repo tools fail closed。
- **V1 未接线**：production 仍无 openWorkspace caller 与 repository-capable kind ⇒
  repository 工具在生产保持 fail closed；`repo.git`/validator 的真实使用由 T17-07 handler
  在部署声明 kind 后生效。
- **E2E（10 项）**：正链（open → DevCompany install → run pin → engine START →
  lease-before-baseline → baseline invocation → read/write/search → 四 QA → git status/diff →
  六条同一 anchor → ValidationService PASS → EvidenceGuard accepts）+ 负链（STALE 改源、
  anti-cherry-pick、无 workspace、restart 后 workspace/lease 不恢复而 durable 状态全在）。
  **不标 T17-09 完成**：closeout / `sprint-17` annotated tag 属于 T17-09。

## 11. Sprint 17 完成态（ADR-0028 D29）

production Tool Registry 含十个 repository 工具（3 filesystem + 5 process + repo.git +
repo.validation-evidence）⇒ DevCompany 1.0.0 可真实安装（Sprint 17 T17-06 已达）；
QA PASS 仍需真实命令执行 → durable invocation evidence → same RepositoryRevisionAnchor →
validator 验证 → Validation batch PASS → EvidenceGuard accepts。**Pack 安装成功 ≠ QA PASS**：QA PASS = 真实命令执行 → durable
invocation evidence → same RepositoryRevisionAnchor → validator 验证 → Validation batch PASS →
EvidenceGuard accepts。`DEVCOMPANY_TOOL_ID_CONTRACT_CONFLICT = NO`；DevCompany remains 1.0.0。

## 12. 已知限制（诚实记录）

1. V1 无 OS 级 sandbox：host executable 技术上可能联网/读宿主文件（受 command profile + path
   policy + env 过滤 + 审批约束，但非隔离证明）。
2. WorkspaceContext 不 durable：重启后必须重新 openWorkspace。
3. fingerprint 为内容哈希，不替代 Git 对象身份（headSha 另行记录）。
4. evidence freshness 以"验证时重读 currentAnchor"实现，不防止 anchor 读取与命令执行之间的竞态
   （V1 串行执行缓解）。
5. filesystem/search 存在 TOCTOU 窗口（path policy 检查与 `stat`/`open`/遍历之间；详见 §4.1）；
   V1 以"统一 policy + 一律拒绝 symlink + 受信 root"缓解，不声称消除。
5. QA 六命令的真实可执行内容（tests/lint/typecheck/build 的实际命令）由 T17-01 之后的 command
   profile 裁定落定，本契约只冻结"固定命令表 + 禁 shell"模型。
6. 进程树终止尽力而为：Windows 依赖 `taskkill /T`、POSIX 依赖进程组；若子进程自行脱离组/被重新
   父化，可能残留（V1 不声称 OS 级隔离）。
7. `repo.terminal`/QA 工具 idempotencyMode 为 `NONE`：核心层据此把 idempotencyKey 置为 null，
   因此 process invocation **不可重放**（重放路径对该类工具不可达）——失败重试必须显式发起新
   invocation，这同时保证 corrective 不会借重放改写失败语义。
7. `repo.terminal` 在 V1 生产环境无 openWorkspace caller ⇒ 与 filesystem 工具一同 fail closed；
   commandKey 的真实内容（tests/lint/typecheck/build 具体命令）由受信 application profile 落定，
   本任务不硬编码任何仓库命令。

## 13. Checkpoint

Sprint 17 closeout **annotated tag = `sprint-17`**（Boss 裁定；同 Sprint 16 先例，不用 `sprint-17.0.0`）。
