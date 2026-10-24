# Sprint 17 — Repository Runtime 任务分解（T17-01 冻结）

> 状态：**FROZEN**（T17-01 输出；严格线性依赖，逐 Task Boss 批准后执行）。
> 上游：ADR-0028、`docs/sprint17/S17_REPOSITORY_RUNTIME_CONTRACT.md`、`docs/EXECUTION_ROADMAP.md`
> Sprint 17 段。

## Scope Ruling（BOSS-FROZEN）

Sprint 17 = 在既有 Tool Registry / ToolInvocation / Artifact / Validation / EvidenceGuard / Recovery
之上，交付**被 Workspace + 路径策略 + 固定命令表 + 权限/风险/审批 + 输出上限 + revision anchor
共同包住的 Repository Runtime**。**不给 Agent 任意 shell。**

## Tasks

### T17-01 Repository Runtime V1 Architecture & Security Freeze（**已完成**）

ADR-0028（Repository Runtime V1 Trust, Workspace and Execution Boundaries）+ 本目录三份文档；
Planning Recon 7 项 gap 全部关闭；零 production/test/migration 改动。零 tag。

### T17-02 Workspace Context & Path Policy（**已完成**）

- **Placement 结论（Placement Recon，零 framework 改动）**：generic workspace/path 契约与
  FS-backed 实现均落 **`packages/engine/src/repository/`**（`workspace.ts` + `path-policy.ts`）。
  依据：engine 已持有 OS runtime primitive（`node:crypto`、`node:async_hooks`），而 boundary gate
  LAW 1b 禁止 Core/Contracts 引入 `node:` 内建；Core 保持纯 domain。CAS 的 reparse-point 拒绝
  先例（`persistence/src/content/cas-store.ts`）作为技术模式复用（fail closed on symlink），非复制。
  **无 `WORKSPACE_LAYER_PLACEMENT_GAP`。**
- **已实现**：
  - `WorkspaceManager`（process-local，0/1 active）：`openWorkspace({root, commandProfile})`
    （root 必须非空绝对路径 + realpath 成功 + 是目录；失败 taxonomy `REPOSITORY_ROOT_*`）、
    同 canonical root + 同 profile ⇒ 幂等重开、不同 root ⇒ `REPOSITORY_WORKSPACE_ALREADY_OPEN`、
    profile 变化 ⇒ `REPOSITORY_COMMAND_PROFILE_MISMATCH`（不静默替换安全策略）、
    `closeWorkspace()` 仅清 process-local 状态、`require({workspaceId})` 拒绝 stale/mismatch handle
    （`REPOSITORY_WORKSPACE_MISMATCH`/`REPOSITORY_WORKSPACE_NOT_OPEN`）。
  - `workspaceId` = `sha256:<64 lowercase hex>`（`sha256Ref(canonicalRoot)`）；同一 real root 的
    两个别名（symlinked root）⇒ 同 id；无时钟/随机/pid/company 输入。
  - `WorkspaceContext` = `{workspaceId, canonicalRoot, commandProfile}`；`canonicalRoot` 仅模块内
    可见，公开面只给 workspaceId/relativePath（错误只带 relativeInput + reason + workspaceId，
    **不泄漏 physical root**，测试断言）。
  - `RepositoryCommandProfile`/`RepositoryCommandDescriptor`（commandKey/executable/baseArgv/
    cwd:'workspace-root'/safeEnvAdditions）；模型不可修改 profile。
  - `RepositoryPathPolicy`（唯一权威入口）：relative-only（拒绝 absolute POSIX / drive `C:\`,`C:/` /
    UNC `\\srv\share`,`//srv/share` / device `\\?\`,`\\.\` / NUL / 空段 / `..`（both
    separators，normalization 后判定，非 startsWith））；`.` 仅 allowRoot 操作可表 root；
    platform-aware containment（case-fold on win32，非字符串 prefix——`/tmp/repo-evil` 对
    `/tmp/repo` 判外侧）；**两层**：lexical + 逐 existing segment 的 symlink/junction/reparse
    fail-closed（指向 root 内的 link 也拒）；已存在 target 追加 realpath containment；
    `.git` 作为真实 segment（`.gitignore`/`my.git.txt` 不误伤，大小写不敏感）；operation-aware
    （READ/WRITE/SEARCH，SEARCH 可枚举 `.git` 周边；无 DELETE/RENAME/CHMOD）；不存在的写目标
    以 existing-segment 集合验证。
  - 受控结果类型 `{workspaceId, relativePath, internalAbsolutePath}`；internalAbsolutePath 不进
    Tool output。
- **不写** Tool adapters、process/git、validator、migration、authority。
- **Tests**：
  - `tests/sprint17/workspace-path-policy.test.ts`（19 项）：fresh manager 无 active workspace；
    canonicalization；别名同 id；missing/file/relative root 拒绝；single-workspace（幂等重开 /
    异 root 拒绝）；profile 不静默替换 + close 后可换；close 仅清本地；stale handle 拒绝；
    relative 接受（含 `./` 与反斜杠归一）；absolute/drive/UNC/device 全拒（每类一例）；
    `..` 六形态全拒；empty/non-string/NUL/空段拒绝；prefix-collision 场景；Unicode；`.` 语义；
    symlink 逃逸拒、指向 root 内的 link 也拒；不存在写目标祖先验证；`.git` read/write 拒 +
    `.gitignore` 放行 + 大小写；错误不泄漏 physical root。
  - `packs/dev-company/tests/path-escape.test.ts`（roadmap 命名，AC17.2 证据；3 项）：12 种逃逸
    输入全部拒绝 + 合法 in-workspace 读写放行 + policy 与 pack 身份无关。
- **Dependencies**：T17-01。

### T17-03 Filesystem & Search Tools（**已实现**，commit `feat: add repository filesystem tools`）

- **实现**（`packages/engine/src/repository/repository-tools.ts`，导出经 `packages/engine/src/index.ts`）：
  - `repo.file-read`（LOW / `read` / IDEMPOTENT_KEY，version `1.0.0`，providerKind `repository`）：
    严格 UTF-8（fatal `TextDecoder`）解码，非 UTF-8 ⇒ `UNSUPPORTED_BINARY`；仅 regular file
    （目录 ⇒ `NOT_A_FILE`）；**上限 `MAX_TEXT_FILE_BYTES = 4 MiB`** ⇒ `FILE_SIZE_LIMIT_EXCEEDED`；
    symlink ⇒ `REPOSITORY_PATH_REPARSE_POINT`；输出 `{workspaceId, relativePath, sizeBytes, sha256, content}`
    （`sha256` = `sha256:<64hex>` 字节摘要）。
  - `repo.file-write`（MEDIUM / `write` / COMMAND_ID，version `1.0.0`）：仅 UTF-8 text；同 4 MiB 上限；
    **原子替换**（同目录 `.companyos-<uuid>.tmp` → fsync → rename，非原地截断）；**父目录必须已存在**
    ⇒ `PARENT_MISSING`（V1 不自动创建目录，见契约 §4.1 偏差记录）；目标是目录/symlink ⇒ 拒绝；
    `.git/**` 写拒；输出 `{workspaceId, relativePath, sizeBytes, sha256, created}`。
  - `repo.search`（LOW / `read` / IDEMPOTENT_KEY，version `1.0.0`）：**literal-only 查询**（非 regex，
    无 glob）；`caseSensitive` 选项；默认路径 `.`；`SEARCH` 操作经同一 path policy；遍历跳过
    `.git`/`node_modules`/`.next`/`target`，**从不跟随 symlink**；binary 文件与 >4 MiB 文件跳过并
    分别计数（`skippedBinaryFiles`/`skippedOversizeFiles`）；**上限**：`MAX_SEARCH_FILES = 10_000`
    扫描文件 / `MAX_SEARCH_MATCHES = 1_000` 匹配 / `MAX_MATCH_LINE_PREVIEW_BYTES = 512` 单行预览，
    任一达限 ⇒ `truncated: true`（仍返回已收集结果）；输出按 `relativePath → line → column` 确定性排序。
  - **所有** adapter 的路径决策统一走 T17-02 的 `RepositoryPathPolicy`（无第二套校验）；未 open
    workspace ⇒ `WORKSPACE_NOT_OPEN` fail closed。
- **不实现** process/git/validator（T17-04~T17-06）。
- **生产注册**（`apps/desktop/src/main.ts`，`composeCoreServices`）：process-local
  `repositoryWorkspace = createWorkspaceManager()` + 三个 `ToolRecord` + 三个 `ToolPort` adapter
  （`workspace: () => repositoryWorkspace.current()`）。**仅此三个** repository 工具进 production registry；
  V1 无应用侧 openWorkspace 调用 ⇒ repo tools 在生产中保持 fail closed 直到受信 seam 打开 workspace。
- **Tests**（`tests/sprint17/repository-tools.test.ts`，**20 项**）：读 happy path + 输出无绝对路径；
  Unicode；missing/dir/symlink 分类；binary + oversize；`.git`/absolute/escape/no-workspace 拒；
  写 create/overwrite + 原子 + digest + `created`；`.git`/escape/absolute/symlink/`PARENT_MISSING`/
  目录目标/oversize/no-workspace 拒；search literal 排序 + `caseSensitive` + scoped path + 匹配上限
  `truncated` + 不跟随 symlink + escape/no-workspace 拒；真实 `ToolRegistry` 全链（authority →
  risk → input/output schema → adapter → durable ToolInvocation，含 toolVersion/inputDigest/
  outputDigest 且无 root 泄漏）；无 `tool.invoke` actor ⇒ `PERMISSION_DENIED`；风险/能力/幂等冻结断言；
  restart 语义（新 manager ⇒ `WORKSPACE_NOT_OPEN`，受信重开后可用且 invocation 历史不变）；
  源码结构断言（无 child_process/exec/spawn/process.env/fetch/http.request）。
- **Dependencies**：T17-02。

### T17-04 Controlled Process Runtime & QA Command Tools（**已实现**，commit `feat: add controlled repository process tools`）

- **实现**：
  - `packages/engine/src/repository/repository-process-runner.ts`：generic internal
    **`RepositoryProcessRunner`**（唯一 spawn 点）——`spawn(executable, argv, { shell: false,
    cwd: canonical workspace root, env: <filtered> })`；**filtered env**（Windows `PATH`/
    `PATHEXT`/`SystemRoot`/`WINDIR`/`TEMP`/`TMP`；POSIX `PATH`/`TMPDIR`/`LANG`/`LC_*`，绝不
    `env: process.env`）+ trusted profile `safeEnvAdditions`（密钥形状一律 fail closed）；
    `RepositoryProcessEnvironmentPolicy` = `buildFilteredProcessEnvironment`；**capture 8 MiB/stream**
    （达限立即终止进程树 + `OUTPUT_LIMIT_EXCEEDED`）+ **inline preview 16 KiB/stream**（UTF-8 字节
    口径，按码点边界回退，绝不产生 lossy 文本）；完整字节经既有 **Artifact/CAS content store**
    外置（`sha256:<64hex>`，不建第二套 blob store，不写 workspace）；分 stream `sha256`；
    timeout 由 composition 注入 timer（engine 不持定时器，boundary gate）；cancel 经
    `ToolPort.cancel`，按 `executionId` 定位活跃进程（`Map<executionId, RunningProcess>`）。
  - `packages/engine/src/repository/repository-process-tools.ts`：五个薄 ToolPort adapter
    （`repo.terminal` HIGH / `repo.test-runner`·`repo.linter`·`repo.typechecker`·`repo.builder`
    MEDIUM；capability `side_effect`；idempotencyMode `NONE`（NO automatic retry）；
    timeout 300000/600000/300000/300000/600000 ms；version `1.0.0`；authority 仅 `tool.invoke`）。
    QA 工具 input schema 为**空对象**（不接受任何参数）；`repo.terminal` input 仅
    `{ commandKey }`，executable/argv/cwd/env 全部来自 trusted `RepositoryCommandProfile`。
    未 open workspace ⇒ `WORKSPACE_NOT_OPEN`；未知 commandKey ⇒ `REPOSITORY_COMMAND_NOT_ALLOWED`
    （spawn 前）；非 0 exit ⇒ FAILED 且保留结构化证据（previews/digests/byteCounts/artifactRefs）。
  - **T17-04 CORRECTIVE（Boss 裁定 `PROCESS_FAILURE_EVIDENCE_GAP`，commit
    `fix: persist repository process failure evidence`）**：失败证据改为 durable-first——
    tools 层把有界 evidence 对象（schema `companyos/repository-process-evidence/1`）写入既有 CAS，
    refs（evidence + 分 stream 全字节）由 registry FAILED terminal write 经既有
    `tool_invocation_artifacts` 关系幂等链接；timeout/cancel 走 `ToolPort.cancel` →
    `runner.cancelAndAwait` 路径发布并链接（registry 的 timeout race 会丢弃 adapter 错误，
    本机实测确认）。零 migration、零新列、`replay_output_json` 语义不变、FAILED 重放仍为 FAILED。
  - **Tests（corrective，`tests/sprint17/repository-process-failure-evidence.test.ts`，10 项）**：
    非 0 exit 的 durable 重建（含双 stream refs）+ CAS 字节精确；preview 有界 ≤ 16 KiB 且
    evidence 对象 < 64 KiB；timeout 证据 durable；output-limit 证据 durable（含 ≤ 8 MiB 已捕获
    字节）；cancel 证据 durable（含取消前输出）；**fresh service graph 重启后恢复证据**；FAILED
    重载后仍是 FAILED 且 NONE 幂等 ⇒ 不可重放；证据归属精确 invocation（无跨 invocation 冒用、
    无 CAS 扫描）；成功 run 不产生 failure evidence。
  - **Tests（FINAL VERIFICATION，`tests/sprint17/failed-evidence-ref-integrity.test.ts`，9 项）**：
    伪造 `artifact:art_does_not_exist` ⇒ 拒绝链接且 invocation 仍 FAILED；合法同 run ref ⇒
    精确链接一次；重复上报 ⇒ 关系不重复；畸形 ref/非字符串 ⇒ 拒绝、CAS ref 仅格式校验；
    **跨 run ref ⇒ 拒绝（provenance 隔离）**；COMPLETED managed-ref 规则不变（合法链接 /
    缺失 ⇒ OUTPUT_INVALID FAILED）；timeout/cancel 路径经注入的 validating linker（ refusing
    linker ⇒ 零链接）；链接写失败时终态已 durable、只可能少链接（无半提交）；fresh graph
    保留已校验链接且 artifact 行仍在。
  - **生产注册**（`apps/desktop/src/main.ts`）：与三个 filesystem/search 工具共用同一 process-local
    `repositoryWorkspace` + 同一个 runner（contentStore = 既有 CAS；cancel 的 invocationId→
    executionId 解析走 durable `toolInvocations.get`）。production repo 工具集 = **8 个**
    （file-read/file-write/search/terminal/test-runner/linter/typechecker/builder）；V1 仍无
    openWorkspace caller ⇒ 全部 fail closed。
- **不实现** git / validator / RepositoryRevisionAnchor（T17-05/T17-06；本轮 `preAnchor/postAnchor`
  缺席且不伪造）；无 DevCompany 特判、无 migration、无 authority、无 IPC/renderer。
- **Tests**（`tests/sprint17/repository-process-tools.test.ts`，**32 项**）：env allowlist + 密钥
  形状拒绝 + 名称/值非法拒绝；工具规格冻结断言（id/risk/capability/idempotency/timeout/slot）；
  源码结构断言（无 repo.git/validator/DevCompany/execSync/shell:true）；成功全证据 + 无 root 泄漏；
  无 workspace fail closed（QA 工具 `WORKSPACE_NOT_OPEN`；terminal 先被审批门拦住，批准后 adapter 拒绝）；
  未知 commandKey / executable·argv·cwd·env 覆盖尝试（pre-spawn）；QA 工具固定 slot；cwd = canonical
  root；父进程密钥对 child 不可见 + trusted addition 可见；非 0 exit FAILED 证据；stdout/stderr 分别
  外置 + digest 一致 + replay 有界；binary `binary=true` + 全字节外置；8 MiB stdout/stderr 各自终止；
  timeout 真终止 + 进程消失；cancel 真终止；**进程树清理（grandchild 一并终止）**；无 `tool.invoke`
  pre-spawn 拒绝；HIGH 审批 pre-spawn + 批准后 spawn；MEDIUM 直接执行；spawn 失败净化（无 host 路径）；
  record 风险/幂等/authority 落库；workspace 无污染；production 集合恰为 8 个（结构断言）。
- **Dependencies**：T17-03。

### T17-05 Git Read-Only & Repository Revision Anchor（**已实现**，commit `feat: add read-only repository git runtime`）

- **实现**：
  - `packages/engine/src/repository/repository-git.ts`：`RepositoryRevisionAnchor`（workspaceId/
    headSha|null/branch|null/workingTreeFingerprint/dirtyFiles）+ `computeRepositoryAnchor` +
    `createRepositoryRevisionAnchorProvider`（`getCurrentAnchor()`，按当前 workspace 解析，无
    workspace ⇒ `WORKSPACE_NOT_OPEN`）。**所有 Git CLI 调用复用 T17-04 的
    `RepositoryProcessRunner`**（无第二 spawn）；固定安全前缀 `--no-pager -c core.fsmonitor=false
    -c core.untrackedCache=false` + diff 专用 `--no-ext-diff --no-textconv --no-color`，trusted
    env `GIT_OPTIONAL_LOCKS=0`/`GIT_TERMINAL_PROMPT=0`；Git executable 来自 trusted composition
    （production `git`，经 filtered PATH 解析），模型不可覆盖。
  - **边界**（fail closed + 稳定 reason）：`NOT_A_GIT_REPOSITORY`、`GIT_BARE_REPOSITORY_UNSUPPORTED`、
    `GIT_ROOT_OUTSIDE_WORKSPACE`（`rev-parse --show-toplevel` 必须**精确等于** canonicalRoot）、
    `GIT_WORKTREE_UNSUPPORTED`（`--absolute-git-dir` 必须在 workspace 内）、
    `GIT_SUBMODULE_UNSUPPORTED`（`ls-files --stage` 出现 160000）、
    `GIT_NESTED_REPOSITORY_UNSUPPORTED`（untracked 目录内发现 `.git`，绝不递归）、
    `GIT_PATH_ENCODING_UNSUPPORTED`（`-z` 路径严格 UTF-8，无 replacement decode）、
    `GIT_STATE_LIMIT_EXCEEDED`（Boss 冻结 **MAX_GIT_STATE_ENTRIES = 10,000**）、
    `GIT_COMMAND_FAILED`（错误只带 command/exitCode/workspaceId，不含 raw stderr host 路径）。
  - **Anchor 算法**：`sha256("companyos/repository-anchor/2" + head + branch + 每个 entry 的
    XY/path/kind + 工作树内容摘要)`；工作树内容摘要对 regular file 用**流式** sha256（≥4 MiB 也不
    整体读入）、symlink 只读 link 目标文本（不 traverse）、untracked 目录递归（跳过 `.git`）、
    deleted ⇒ `absent`。**只对内容敏感，不对 mtime 敏感**（git 自身也是内容判定，实测确认）。
    ignored 文件**不**纳入 fingerprint（写明的 limitation）；anchor 不是 durable 实体，进
    structured Tool output 由既有 ToolInvocation 持久化。
  - `packages/engine/src/repository/repository-git-tools.ts`：`repo.git`（version `1.0.0`、
    capability `read`、risk `LOW`、idempotency `IDEMPOTENT_KEY`、authority 仅 `tool.invoke`、
    timeout 300000）；input 严格 `{op: status|diff|baseline}`（additionalProperties false，
    无 args/gitArgs/command/executable/cwd/path/env/push）；output 只含 workspace 相对路径 +
    anchor + T17-04 有界 stream（16 KiB preview / 8 MiB capture / CAS 外置），无 canonicalRoot。
  - `RepositoryProcessRunner.run` 增加 **opt-in `includeStreamBytes`**（同一 capture 机制，
    ≤8 MiB/stream，仅内部解析用，绝不进入 tool output）——Git 需要解析 porcelain 输出。
  - **QA 4 工具接入 pre/post anchor**：success output 增 `preAnchor`/`postAnchor`（含进
    replay_output_json，重启可恢复）；**非受支持 git 仓库 ⇒ fail closed**（不返回无法证明
    freshness 的 QA success）；`pre != post` 只记录事实（本任务不改 invocation 状态，T17-06 负责
    fail closed）；`repo.terminal` 不强制 git（已在文档说明区别）。
- **不实现** repo.validation-evidence、自动 task-start baseline（T17-07）、任何 Git mutation、
  IPC/renderer/migration/authority、DevCompany 修改。
- **CORRECTIVE（Boss 裁定 `REPOSITORY_INDEX_FINGERPRINT_GAP`，commit
  `fix: anchor staged repository state`）**：fingerprint 增加 **INDEX 层独立输入**——porcelain v2
  的 `mH/mI/mW/hH/hI`（HEAD mode/oid、INDEX mode/oid、worktree mode）与 rename 的 origPath 全部
  纳入（schema `companyos/repository-anchor/3`）。修复前：HEAD=A/INDEX=B/WT=C 时把 index 改成 D
  （WT 仍 C、XY 仍 `MM`）会得到**相同** fingerprint ⇒ T17-06 可能把旧 evidence 误判为 fresh。
  修复后三层各自敏感；`repo.git`、QA pre/post anchor、`getCurrentAnchor()` 共用同一算法
  （无 per-consumer 变体）。fixture 用真实 Git mutation（`hash-object -w` /
  `update-index --cacheinfo` / `--chmod=+x`）构造状态，production 仍 read-only。
- **FINAL INTEGRATION CORRECTIVE（Boss 裁定 `GIT_EVIDENCE_INVOCATION_ANCHOR_GAP`，commit
  `fix: anchor repository git evidence`）**：`repo.git op=status`/`op=diff` 增加
  `preAnchor`/`postAnchor`（同一个 `RepositoryRevisionAnchorProvider`，单一算法；pre 在读前、
  post 在读后；`pre != post` 只记录事实，invocation 仍 COMPLETED——verdict 归 T17-06）。
  既有字段与 diff 边界（16 KiB/8 MiB/CAS/binary/failure evidence）不变；baseline anchor 契约不变；
  caller 不能提供 anchor/args；production 工具集仍 9 个、仍只读三 op、仍只走 T17-04 runner。
  六条 QA 证据链的数据自此齐全。
- **Tests（final integration，`tests/sprint17/repository-git-evidence-anchoring.test.ts` 10 项）**：
  status/diff 各有 pre/post anchor（且为完整 `RepositoryRevisionAnchor` 形状）；未变更仓库 ⇒
  status/diff 的 pre == post；注入交替 provider ⇒ 真实 pre != post 被保留且工具仍 COMPLETED；
  status/diff 的 post anchor 与 `getCurrentAnchor()` 逐字节一致（单一算法）；anchor 经
  `replay_output_json` durable 恢复；caller 伪造 anchor/args/op 全部被拒（INVALID_ARGUMENT）；
  diff 边界不变（16 KiB preview / truncated / CAS ref）；Git 只读安全回归（外部程序未执行、
  HEAD/index 不变）；六条证据（含 baseline）同一 workspaceId + 同一 fingerprint 且各自 durable。
- **Tests（corrective，`tests/sprint17/repository-anchor-index.test.ts` 10 项 +
  `tests/sprint17/repository-anchor-algorithm.test.ts` 2 项）**：index-only 内容变化改变
  anchor（HEAD/WT/XY/path 全不变）；index mode-only 变化改变 anchor；unstaged 内容、同状态
  不同字节、rename（两个方向互异）、deletion、untracked 内容变化均改变 anchor；mtime-only 稳定；
  确定性重复一致；**§26：anchor 不可能由 HEAD+branch+XY+path+工作树字节重建**（index 对象身份
  是真正输入）；QA pre/post 与 provider 使用同一修正算法且经 replay_output_json 重启可恢复。
- **Tests**：`tests/sprint17/repository-git.test.ts`（30 项：契约冻结、拒绝集合、unknown op/字段、
  无 workspace、non-git、parent repo escape、bare、worktree、submodule、nested repo、
  status clean/dirty + 相对路径、真实 unstaged diff、diff 外置 + digest + ToolInvocation durable、
  baseline、anchor 确定性/HEAD/staged/unstaged/同状态不同字节/untracked 路径与内容/deletion/
  mtime 稳定/unborn/detached/10k 上限、外部 diff+fsmonitor+pager 不执行、HEAD/index/refs 不变、
  无 authority 拒绝、9 个工具集合）+ `tests/sprint17/repository-qa-anchoring.test.ts`（3 项：
  pre/post anchor + 重启恢复、mutating 命令 pre≠post、非 git 工作区 fail closed）+
  `tests/sprint17/devcompany-install-after-t17-05.test.ts`（1 项：真实 9 工具 registry 下
  DevCompany 安装到达 `PACK_VALIDATOR_MISSING` 且零 durable 写入）+
  `packs/dev-company/tests/git-baseline.test.ts`（roadmap 命名，2 项：generic runtime baseline +
  parent repo escape）。
- **Dependencies**：T17-04。

### T17-06 QA Evidence / Validation（**已实现**，commit `feat: add repository validation evidence`）

- **实现**：
  - `packages/engine/src/repository/command-fingerprint.ts`：
    `repositoryCommandDescriptorFingerprint(descriptor)` = `sha256:<64hex>` over canonical
    `{purpose, commandKey, executable, baseArgv order, cwd policy, safeEnvAdditions}`。只 durable
    摘要，绝不 durable executable 路径 / env / workspace root（Boss 预批的
    `RepositoryCommandDescriptorFingerprint`）。
  - `packages/engine/src/repository/repository-process-tools.ts`：五个 process 工具的成功
    output 增加 `commandDescriptorFingerprint`（schema 同步，既有字段不动）。
  - `packages/engine/src/repository/qa-evidence.ts`：**verifier-only** 校验内核 +
    `RepositoryEvidenceSource` / `RepositoryEvidenceToolRecordReader` 两个 trusted 端口 +
    `repositoryQaEvidenceReport()`（canonical JSON 报告）。零 child_process / fs / network。
  - `packages/engine/src/repository/validation-evidence-tools.ts`：`repo.validation-evidence`
    ToolPort/ToolRecord（version `1.0.0`、capability `validation:validator`、risk `LOW`、
    authority `['tool.invoke']`、idempotency `IDEMPOTENT_KEY`、timeout 120000）。
- **六条必需证据（精确）**：`repo.test-runner`(commandKey `tests`) / `repo.linter`(`lint`) /
  `repo.typechecker`(`typecheck`) / `repo.builder`(`build`) / `repo.git` op=`status` /
  `repo.git` op=`diff`。`repo.git` op=`baseline` **不是**六条之一（属 T17-07 Task-start
  provenance）。
- **PASS 条件（全部同时成立）**：六条 latest durable terminal invocation 均 COMPLETED（QA 还需
  exitCode 0）；toolVersion == 当前注册 ToolRecord.version；QA commandKey 正确；QA 的
  commandDescriptorFingerprint == 当前 trusted descriptor 指纹；各自 preAnchor == postAnchor；
  六条 anchor 核心 identity（workspaceId/headSha/workingTreeFingerprint）完全相等；同一
  workspace/run/task；**currentAnchor（验证末尾最后读取）== evidenceAnchor**。
- **反作弊**：latest terminal（old success + new failure ⇒ FAIL，不 cherry-pick）；
  run/task/workspace 交叉 ⇒ FAIL；缺任意 slot ⇒ FAIL 并列出 `missingSlots`；status/diff
  op 身份来自 durable output（baseline 不能冒充）；无 active workspace ⇒ FAIL
  （`WORKSPACE_NOT_OPEN`，绝不拿旧 invocation PASS）。
- **verdict vs error**：证据不满足 ⇒ ToolInvocation **COMPLETED** + `output.verdict='fail'`；
  仅基础设施失败（store 不可用等）才让 ToolInvocation FAILED。
- **ValidationService/EvidenceGuard 集成（§47/§48）**：validator 经既有 registry.invoke 路径
  执行（authority/risk/idempotency/replay 全部继承）；`report` 经既有 ArtifactService 物化为
  `artifact:art_<id>`（同一 run）并进入 evidenceRefs ⇒ durable provenance 走既有
  `artifact:` 命名空间，**不发明新 reference namespace**；targetRef 仍必须是
  `artifact:art_<ulid>`；Validation batch 记录继续走 `validation.record` 权限。
  EvidenceGuard 语义零改动（latest durable batch wins、无 fallback、非 required 行不决定 gate）。
- **不实现**：自动 task-start baseline（T17-07）、scheduler/Task hook、任何 Git mutation、
  新 authority/migration/table/IPC/Renderer、DevCompany 改动。
- **Tests**：`tests/sprint17/repository-validation-evidence.test.ts`（15 项：契约/能力/风险/
  authority/幂等、caller 无法选择证据、源码审计零 process/fs/network、六条齐全 PASS、
  缺 slot + baseline 不能冒充、timeline 反作弊、版本漂移、commandKey 错配、descriptor 漂移
  （close/reopen 同 root 换命令）、错 toolId、QA 改变源码、跨 run/task、stale、FAIL 仍
  COMPLETED）+ `tests/sprint17/repository-validation-integration.test.ts`（7 项：真实
  ValidationService durable PASS batch、EvidenceGuard accepts、改仓库后新 FAIL batch +
  guard denies、validation.record authority、fresh service graph 重启存活、production 10 工具
  集合、validator 零重执行）+ `tests/sprint17/devcompany-install-after-t17-06.test.ts`
  （1 项：**DevCompany 1.0.0 在 production-style 十工具 registry 下真实安装成功**，
  PackContentRefs=24 / 5 roles + owner / 0 auto-assignment，且安装 ≠ QA PASS）。
- **Dependencies**：T17-05。

### T17-07 Task-Start Baseline & Serial Agent（**已实现**，commit `feat: integrate repository task baseline`）

- **实现**（全部 engine 侧，零框架语义改动）：
  - `packages/engine/src/repository/workspace-lease.ts`：`createWorkspaceExecutionLease()`
    （process-local 0/1 lease；绑定 workspaceId/runId/taskId/executionId；第二执行 ⇒
    `REPOSITORY_AGENT_BUSY`；`heldByOther()`；release 幂等）+ `workspaceInUseError()`
    （`WORKSPACE_IN_USE`）。
  - `packages/engine/src/repository/task-baseline.ts`：`createTaskBaselineService()` +
    `taskBaselineIdempotencyKey()`。**exactly-once 靠 registry 自身幂等**：deterministic key
    `task-baseline:<runId>:<taskId>` 使重试/重入/恢复都 **replay 原始 invocation**，
    绝不产生第二条 authoritative baseline；`get(runId,taskId)` 只读返回
    `{invocationId, toolVersion, workspaceId, branch, headSha, dirtyFiles,
    workingTreeFingerprint}`（无新表、无 migration）。后续人工 `repo.git baseline`
    （不同 key）不替换它。
  - **CORRECTIVE（Boss 裁定 `TASK_BASELINE_LEASE_ORDERING_RACE`，commit
    `fix: lease workspace before task baseline`）**：顺序由 "availability probe → baseline →
    acquire" 改为 **acquire → workspace 复检 → baseline → workspaceId 校验 → work →
    finally release**。lease 覆盖 baseline 采样到 work 开始的整个窗口，消除"A 采样后、
    acquire 前被 B 改写仓库"的竞态（该错误会因 exactly-once replay 而无法自愈）。
    acquire 失败 ⇒ 无 baseline invocation、无 workspace 触碰、无 work；baseline 失败/取消/
    抛异常 ⇒ finally 释放 lease（不会永久 BUSY）。首次 vs 恢复由 **durable invocation**
    决定（capture 内部 capture-or-replay），不靠 attempt 号。
  - `packages/engine/src/repository/repository-agent.ts`：
    `createRepositoryStageHandler()` —— **挂在 engine 既有权威 seam**：task loop 在
    `step(task,'START')` 之后调用 `StageHandlerRegistry.resolve(kind).execute(ctx)`。
    执行顺序：① active WorkspaceContext 必须存在（不自动开、不硬编码路径）⇒ 失败
    ② lease 可用性探测（busy ⇒ 拒绝，**不采 baseline、不碰 workspace**）
    ③ `repo.git op=baseline` 经**真实 ToolRegistry.invoke**（完整 authority/risk/schema/
    toolVersion/ToolInvocation/runId/taskId/outputDigest provenance）
    ④ baseline 的 workspaceId 必须等于当前 workspace（⇒ 否则拒绝，`TASK_WORKSPACE_MISMATCH`
    语义：恢复不得在不同 workspace 上继续）
    ⑤ acquire lease ⇒ ⑥ 执行 repository 工作 ⇒ ⑦ `finally` release（success/failed/
    cancelled/抛异常全部释放，绝不泄漏永久 BUSY）。
  - `packages/engine/src/repository/workspace.ts`：`createWorkspaceManager({busy})` 可选
    守卫——leased 期间 `closeWorkspace()` ⇒ `WORKSPACE_IN_USE`（因此 close→open 绕不开）。
    既有调用方不传该参数，行为不变。
- **Serial Agent V1 语义**：同一时刻最多一个 repository-capable execution 持有 lease
  （跨 run/task 全域串行）；第二执行 **fail closed / BUSY，不排队**。主 gate 在 Agent
  lifecycle（handler），不靠每个 tool 各自加锁。
- **Recovery**：lease 不 durable ⇒ crash 后自然消失，恢复时 trusted reopen 同 workspace ⇒
  校验 workspaceId 相同 ⇒ **复用原 baseline**（不重采）⇒ 重新 acquire。恢复**不要求**
  currentAnchor == task baseline（任务本来就会改代码）。
- **Repository-capable 判定**：generic —— 由 composition 在 `StageHandlerRegistry` 为该
  task kind 注册 repository handler 即表示其 repository-capable；**无 packId/role 特判**
  （`REPOSITORY_EXECUTION_CLASSIFICATION_GAP = NO`）。
- **不实现/不改**：新工具（仍 10 个）、新 authority、migration/新表、Git mutation、
  validator 语义、DevCompany、IPC/Renderer、scheduler/Task 状态机、自动 QA。
- **Tests（corrective，`tests/sprint17/repository-task-baseline-race.test.ts`，14 项）**：
  lease 先于首次 baseline 取得；第二 task/第二 run 在 lease 持有期间**不采 baseline、不碰
  workspace**（含第一方 paused 在 baseline 与 work 之间时）；同 task 并发 start 只有一条
  baseline 且只有一次 work；baseline 失败/work 失败/取消（抛异常）均释放 lease 且可立即
  再启动；baseline 期间 close/switch 被拒；baseline→work 窗口全程排他；**work-entry anchor
  == 刚采样的 baseline**（fixture 内无外部改写）；恢复先 acquire 再复用原 baseline 且不重采
  （源码已变）；无历史成功 baseline 的 retry 只在 acquire 成功后才采第一条；人工后续
  baseline 仍不替换；fresh process 无 lease 但 durable baseline 仍在；并显式记录 lease 是
  process-local 互斥而非 OS 锁（用"绕过 lease 直接改仓库"的 fixture 证明它不作此声称）。
- **Tests**（`tests/sprint17/repository-task-baseline.test.ts`，14 项）：baseline durable
  且绑定真实 run/task；顺序 baseline→work；重复/并发 start 只有一个 authoritative baseline；
  人工后续 baseline 不替换；baseline 失败阻止 agent 启动；restart 后原 invocation 不变；
  跨 run/task 不复用；第二并发执行被拒且不采 baseline、不碰 workspace；不同 run 同样被拒；
  leased 期间 close/switch 被拒且同 context 稳定；success/failed/blocked/抛异常均释放且
  之后可立即再启动；fresh process 无 lease 可重新 acquire；恢复复用原 baseline 且允许源码
  变化（不重采）；错误 workspace 恢复被拒且不产生第二 baseline。
- **Dependencies**：T17-06。

### T17-08 Production Composition & E2E（**已实现**，commit `feat: wire repository runtime production e2e`）

- **实现**（`apps/desktop/src/repository-runtime.ts`，新增）：`composeRepositoryRuntime(deps)`
  —— production repository runtime 的**唯一** composition 模块：
  - `toolPorts`：十个 repository ToolPort（T17-03×3 / T17-04×5 / T17-05 repo.git /
    T17-06 repo.validation-evidence），全部用真实 WorkspaceContext / 真实
    `RepositoryProcessRunner`（shell:false、filtered env、真实 Artifact/CAS contentStore）/
    同一个 `RepositoryRevisionAnchorProvider`；
  - `registerTools(actorId)`：十条 ToolRecord 幂等注册（restart 安全）；
  - `evidenceSource` / `toolRecords`：对**既有** `tool_invocations` / `tool_records` 表的
    只读查询（无新表、无 migration）；
  - `handlers()`：T17-07 `createRepositoryStageHandler` 按**部署声明的 kind** 惰性构建；
  - 受信 seam：`openWorkspace({root, commandProfile})` / `closeWorkspace()` /
    `currentWorkspace()` —— **不是 Tool、不是 IPC、不是 Renderer API**；
  - `lease`：T17-07 process-local workspace lease（含 `closeWorkspace` 的 `WORKSPACE_IN_USE`
    守卫）。
- **接入**：
  - `apps/desktop/src/main.ts`：`composeCoreServices` 用 `composeRepositoryRuntime` 取代表07-03~
    T17-06 的散装接线（workspace/runner/anchor/evidence/linker 各只建一次），
    `registerTools(SESSION_ACTOR)` 幂等注册；`composeSprint13Application` 新增可选
    `stageHandlers`，与既有 `createScriptedRegistry` **合并**（repository kind 优先，其余
    仍走 scripted handler）——engine 本身零改动。
  - **repository-capable kind**：generic `work`（本仓 manifest / Sprint 13/14 engine 测试
    一直使用的 generic task kind）。判定机制 = composition 的
    `repositoryCapableKinds` 配置（**默认空** ⇒ 无 kind 变成 repository-capable，fail
    closed），**不是** packId/role 特判。`review`/`validation` 等其它 kind 不受影响。
  - production 默认 `repositoryCapableKinds: []` ⇒ V1 无 openWorkspace caller，
    repository tools 保持 fail closed（§73：Desktop 无 workspace 也能正常启动）。
- **不实现/不改**：新工具（仍 10 个）、新 authority、migration/新表、IPC/Renderer、
  DevCompany 1.0.0、scheduler/Task 状态机、自动安装 DevCompany、`process.cwd()` 自动开
    workspace、多 workspace、并行 Agent、Git mutation。
- **Tests**（`tests/sprint17/repository-production-e2e.test.ts`，10 项，全部走真实
  production composition + 真实 Git repo + 真实 SQLite/CAS）：
  1. compose 出十个工具；无 workspace ⇒ `repo.file-read` fail closed（runtime 本身正常启动）；
  2. trusted open ⇒ workspaceId + command profile + 只声明 kind 是 repository-capable；
  3. DevCompany 在真实 registry 下安装成功（**PackContentRefs 24 / Pack roles 5 / workflow
     template 1 / owner system role 1 / 自动角色分配 0**——Sprint 16 冻结不变量逐条复证）；
  4. repository-capable Task 经 **engine.drive → advance（START 路径）**：task DONE、
     baseline 是真实 `repo.git op=baseline` invocation（runId/taskId 正确）、lease 已释放；
  5. read/write/search 走真实 registry；四个 QA COMPLETED、stdout >16 KiB 且 CAS 可读回、
     pre==post anchor；
  6. 六条 evidence 同一 stable anchor ⇒ `repo.validation-evidence` 经真实
     ValidationService ⇒ **PASS batch（blocking）⇒ EvidenceGuard accepts**；
  7. 负链：证据后经 `repo.file-write` 改源 ⇒ validator **FAIL（STALE_EVIDENCE）**⇒ 新 FAIL
     batch ⇒ EvidenceGuard **deny**（latest batch 规则真实工作）；
  8. restart：关库/销毁 process-local 状态 ⇒ fresh composition ⇒ workspace 与 lease **都不
     恢复**、repo tools fail closed；durable 的 baseline / validation batch / ToolInvocations /
     CAS 字节全部仍在；trusted reopen 同仓库后 **复用原 baseline invocation**；
  9. 负链：无 workspace 时 repository Task ⇒ 'failed'、agent work 不执行、无 baseline；
  10. 负链（anti-cherry-pick）：同 slot 旧 success + 新 failure ⇒ validator FAIL + guard deny。
- **Dependencies**：T17-07。


### T17-09 Final Audit, Closeout & Annotated Tag（**CLOSED**，closeout commit `chore: close sprint 17`）

- **只读终审**：十个 repository 工具的 risk/capability/idempotency/version 精确复核（§4 表）；
  anchor 算法版本 = `companyos/repository-anchor/3`；Sprint 17 范围内 **migration = 0**、
  authority 集未变、IPC/Renderer/UI = 0、`packs/dev-company/src` 自 tag `sprint-16` 起零改动；
  DevCompany 不变量（PackContentRefs 24 / Pack roles 5 / owner 1 / workflow 1 / 自动分配 0）复证；
  packless Run 复证；closeout 期间 **production runtime code changed = NO**。
- **Closeout**：`docs/SPRINT17_CLOSEOUT.md`（Mission=ACHIEVED / 最终架构 / 交付能力 / 九任务状态 /
  安全边界 / 工具清单 / anchor / QA 证据链 / baseline·lease·recovery / production composition /
  E2E / DevCompany 兼容 / 已知限制 / 延后 / 测试证据 / commit·tag）。
- **状态更新**：`docs/EXECUTION_ROADMAP.md` Sprint 17 ⇒ **CLOSED**（未提前标记 Sprint 18）；
  本文件 T17-01~T17-09 全部 CLOSED；`S17_REPOSITORY_RUNTIME_CONTRACT.md` 标
  **IMPLEMENTED / FROZEN**；`S17_TEST_STRATEGY.md` 记录终值（145 files / 1689 cases /
  production E2E 14 项 + 负链 + restart）；`docs/INDEX.md` 注册 `SPRINT17_CLOSEOUT.md`。
- **Tag**：annotated tag **`sprint-17`**（非 `sprint-17.0.0`）指向 closeout commit；
  `git rev-parse HEAD` == `git rev-list -n 1 sprint-17`，本地创建，**未 push**。
- **ADR**：ADR-0028 仍 **Accepted**；**New ADR = NO**。
- **Dependencies**：T17-08。
