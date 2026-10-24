# Sprint 17 — Repository Runtime 测试策略（T17-01 冻结）

> 状态：**IMPLEMENTED / FROZEN**（T17-01~T17-09 全部 CLOSED）。上游：ADR-0028、
> `S17_REPOSITORY_RUNTIME_CONTRACT.md`、roadmap Sprint 17 Tests（`packs/dev-company/tests/
> {workspace,path-escape,git-baseline}.test.ts`）。

## 分层

| 层 | 内容 | 位置（建议） |
|---|---|---|
| L1 Workspace/Path（**T17-02 已实现：22 项**） | openWorkspace 合同、workspaceId、path policy、逃逸拒绝、restart 语义 | `tests/sprint17/workspace-path-policy.test.ts`（19 项）+ `packs/dev-company/tests/path-escape.test.ts`（3 项，roadmap 命名 AC17.2 证据） |
| L2 Filesystem/Search（**T17-03 已实现：20 项**） | read/write/search、binary 拒绝、`.git` 拒绝、output schema、restart fail-closed | `tests/sprint17/repository-tools.test.ts`（20 项） |
| L3 Process（**T17-04 已实现：32 项 + corrective 10 项**） | argv 固定/env 过滤/无 shell、capture+preview+CAS 外置、timeout/cancel/process tree、审批门、durable 失败证据 | `tests/sprint17/repository-process-tools.test.ts`（32 项）+ `tests/sprint17/repository-process-failure-evidence.test.ts`（10 项） |
| L4 Git（**T17-05 已实现：36 项**） | status/diff/baseline、unborn HEAD、fingerprint 覆盖、push 不可表达、root 精确匹配、worktree/submodule/nested 拒绝、外部程序抑制 | `tests/sprint17/repository-git.test.ts`（30）+ `tests/sprint17/repository-qa-anchoring.test.ts`（3）+ `tests/sprint17/devcompany-install-after-t17-05.test.ts`（1）+ `packs/dev-company/tests/git-baseline.test.ts`（2） |
| L5 QA Evidence（**T17-06 已实现：23 项**） | verifier-only、required set、freshness/stale、anti-forgery、EvidenceGuard 不变、command descriptor 指纹、production install | `tests/sprint17/repository-validation-evidence.test.ts`（15）+ `tests/sprint17/repository-validation-integration.test.ts`（7）+ `tests/sprint17/devcompany-install-after-t17-06.test.ts`（1） |
| L6 Pack E2E | roadmap 三文件 + 真实临时 Git repo 全链 + DevCompany production installability | `packs/dev-company/tests/{workspace,path-escape,git-baseline}.test.ts` |

## 必须覆盖的断言矩阵（按 Task）

### T17-02（Workspace & Path）
1. openWorkspace：root 不存在/非目录 ⇒ fail closed；成功 ⇒ WorkspaceContext（canonicalRoot 为
   realpath 规范化绝对路径、workspaceId 为 `sha256:<64hex>`、commandProfile 引用同一对象）。
2. workspaceId 确定性：同一 root 两次 open ⇒ 同 id；不同 root ⇒ 不同 id。
3. Tool output/event 不出现原始绝对路径（只出现 workspaceId）。
4. relative-only：absolute / drive-letter / UNC / `\\?\` / `..` / NUL / 空段 ⇒ 拒绝（逐类一例）。
5. containment：平台感知（Windows 大小写不敏感）；非字符串 prefix（构造大小写/分隔符变体）。
6. symlink/junction：指向 root 外的 symlink 目标 ⇒ fail closed（Windows junction 同规则）。
7. `.git/**`：普通 write 拒绝；read/search 默认排除。
8. restart：未 openWorkspace ⇒ 全部 repo tools fail closed；已有 Run/Recovery 数据仍可读；
   不从旧 ToolInvocation 反推物理路径。

### T17-03（Filesystem & Search）— **已实现**（`tests/sprint17/repository-tools.test.ts`，20 项）
9. read UTF-8 文本；relative path；越界拒绝；输出仅 `{workspaceId, relativePath, sizeBytes, sha256, content}`
   （断言序列化结果不含 temp root 绝对路径）；Unicode 内容往返；missing ⇒ `PATH_OUTSIDE_ROOT` 分类、
   目录 ⇒ `NOT_A_FILE`、symlink ⇒ `REPOSITORY_PATH_REPARSE_POINT`；非 UTF-8 ⇒ `UNSUPPORTED_BINARY`；
   **> 4 MiB ⇒ `FILE_SIZE_LIMIT_EXCEEDED`**。
10. write create/overwrite；**atomic replace**（同目录 temp + fsync + rename）；摘要与 `created` 正确；
    `.git`/escape/absolute/symlink/目录目标/`PARENT_MISSING`/oversize 拒；
    **父目录必须已存在**（偏差：冻结表原写"可建缺失父目录"，实现取更严的 fail-closed 口径，
    见契约 §4.1）。
11. binary ⇒ `UNSUPPORTED_BINARY`（不 base64 塞模型）；read/write 均为严格 UTF-8。
12. search root-scoped；**literal-only**（无 regex/glob）；`caseSensitive` 选项；忽略 `.git`/
    `node_modules`/`.next`/`target`（硬编码，非 trusted-config generated 目录——见契约 §4.1 偏差）；
    **不跟随 symlink**；binary/oversize 文件跳过并计数；上限 10,000 文件 / 1,000 匹配 / 512 字节
    预览 ⇒ `truncated: true`；输出按路径→行→列确定排序；不 shell out（源码结构断言）。
13. 所有输出过 ToolRecord.outputSchema；未 open workspace ⇒ `WORKSPACE_NOT_OPEN`；
    重开 workspace 后可用且 invocation 历史不变；registry 幂等重放语义如实记录
    （同一 idempotency key 重放已记录结果，含 FAILED，绝不伪装成功）。

### T17-04（Process & QA command tools）— **已实现**（`tests/sprint17/repository-process-tools.test.ts`，32 项）
14. **无 shell string**：executable + argv[] + shell=false；模型不可选 executable/覆盖 argv/cwd/env
    （QA 工具 input schema 为空对象、terminal 仅 `{commandKey}`；攻击性覆盖字段被 schema 拒绝）。
15. env filtered：仅 allowlist（Windows `PATH`/`PATHEXT`/`SystemRoot`/`WINDIR`/`TEMP`/`TMP`；
    POSIX `PATH`/`TMPDIR`/`LANG`/`LC_*`）；**SecretVault 不桥接**（runner 无 vault 引用；父进程
    `TEST_SECRET_TOKEN`/`TEST_PASSWORD`/`GITHUB_TOKEN`/API_KEY 对 child 不可见，trusted
    `COMPANYOS_TEST_SAFE` 可见；safeEnvAdditions 密钥形状 fail closed）。
16. inline preview ≤ 16 KiB/stream（UTF-8 **字节**口径，边界按码点回退）；capture ≤ 8 MiB/stream
    ⇒ 达限 terminate + `OUTPUT_LIMIT_EXCEEDED`（stdout/stderr 各一例）；完整输出外置既有
    Artifact/CAS（`sha256:<64hex>`，回读字节与 digest 一致）；分 stream `sha256` 保留。
17. binary 输出：原始 bytes 外置 + inline 预览空 + `binary=true`，无 lossy text claim。
18. timeout 复用 ToolRecord.timeoutMs（composition 注入 timer——engine 不持定时器，boundary gate）；
    cancel 经 `ToolPort.cancel?`（invocationId→executionId 经 durable invocation 读解析）；
    timeout/cancel 后 child process tree 实际终止（Windows 实测 grandchild 一并终止；taskkill 必须先于
    直接 kill，否则孙子进程被孤立——见契约 §5.1）。
19. commandKey 白名单外 ⇒ `REPOSITORY_COMMAND_NOT_ALLOWED`（spawn 前）；QA 工具无 free-form args。
20. 非 0 exit ⇒ FAILED 且保留结构化证据（exitCode/signal/previews/digests/artifactRefs）；
    FAILED 行 **durable 持久化边界**如实记录（见契约 §5.1：行内 error kind/code/timing，
    完整证据由 CAS 承载，不压成单一 error message）。
21. preAnchor/postAnchor **本轮未实现**（T17-05/T17-06），输出中缺席且不伪造；本轮无
    `.cmd/.bat` wrapper 需求：trusted profile 直接给 executable + 固定 argv（测试用
    `process.execPath` + 受控 fixture 脚本，不经 shell）。
22. HIGH `repo.terminal` 审批门：未批准 ⇒ 无 spawn；批准后按 commandKey 执行（真实顺序断言）。
23. **失败证据引用完整性（T17-04 FINAL VERIFICATION，`failed-evidence-ref-integrity.test.ts` 9 项）**：
    FAILED 上报的 refs 走与 COMPLETED 等价的校验（同一 `createFailureEvidenceLinker`）：
    伪造/缺失/畸形/跨 run ref 一律拒绝且不链接，invocation 仍 FAILED；合法 ref 精确链接一次
    （幂等）；timeout/cancel 路径不得绕开校验（注入 refusing linker ⇒ 零链接）；终态先写后链接
    ⇒ 无"有链接无终态"半提交；COMPLETED 规则不变。
24. **失败证据 durable（T17-04 CORRECTIVE，`repository-process-failure-evidence.test.ts` 10 项）**：
    非 0 exit / timeout / output-limit / cancel 均能仅凭 durable 数据重建（invocation 行 + 关系
    refs → CAS evidence 对象，schema `companyos/repository-process-evidence/1`）；preview ≤ 16 KiB
    且 evidence 对象 < 64 KiB；CAS 字节与 digest 精确；**fresh service graph（关库、无 adapter）
    重启后仍可恢复**；证据只归属其 invocation（无跨 invocation 冒用、无 CAS 扫描/文件名推断）；
    COMPLETED 仍走 `replay_output_json`，FAILED 仍为 FAILED（NONE 幂等 ⇒ process 工具不可重放）。

### T17-05（Git & Revision Anchor）— **已实现**
24. `op ∈ {status,diff,baseline}` 三态 happy path；input schema **不存在** `push`（结构化拒绝）。
25. argv 由 adapter 固定（model 不可提交 raw git argv）；cwd = workspaceRoot；不越工作区边界。
26. baseline 记 durable ToolInvocation；**不建** task_git_baseline/repository_baseline 表。
27. `RepositoryRevisionAnchor`：HEAD identity + staged + unstaged + untracked 覆盖；**内容变化**
    （同文件名不同内容）⇒ fingerprint 变化；unborn HEAD ⇒ headSha=null 且仍覆盖。
28. fingerprint 为 streaming SHA-256；不把巨大 diff 全文持久化。

### T17-06（QA Evidence）
29. verifier-only：不 rerun tests/lint/build/git（spy 计数为 0）。
30. required set 全满足（same run/task-stage/workspaceId/SUCCESS/toolId+toolVersion/exitCode/
    anchor）⇒ Validation batch PASS → EvidenceGuard accepts。
31. 缺 evidence / 错 validator / 错 anchor / **stale anchor（验证前重读 current≠evidence）** ⇒ 拒绝。
32. LLM 文本 "tests passed" 永不作为证据（anti-forgery）：只能来自 durable ToolInvocation/Artifact/
    Validation。**FAILED 调用的证据经 invocation 的 artifactRefs → CAS evidence 对象读取**
    （T17-04 corrective），COMPLETED 读 `replayOutput`。
33. source mutation（pre≠post）⇒ fail closed。
34. EvidenceGuard 既有语义不变（latest batch wins / pinned stage / 无 requirement 不自动通过）。

### T17-07/T17-08（Integration & E2E）
35. one active WorkspaceContext per process；第二次 open 不同 root 的行为按契约（替换或拒绝——按
    实现裁定记录）。
36. 同 workspace repository-mutating 操作串行（并发写被串行化/拒绝，按实现记录）。
37. **DevCompany 1.0.0 production installability**：production 风格 registry（六个冻结 tool/validator）
    ⇒ PackService.install 成功（不再依赖 test fixture）。
38. **Pack 安装成功 ≠ QA PASS**：安装后仍需真实命令 + evidence + validator + EvidenceGuard 才能
    QA PASS（负例：声称通过但无 durable evidence ⇒ gate 拒绝）。
39. restart/recovery：真实 SQLite close/reopen 后已有 Run/ToolInvocation/Validation 保留；repo tools
    在重开 workspace 前 unavailable；Sprint 14 恢复语义不变（STARTED→INTERRUPTED、无自动重试）。

### 回归与边界
40. Sprint 13/14/15/16 既有套件全绿；Core 无行业词 gate 不放宽；generic runtime 无 DevCompany 特判
    （结构断言）；零新 migration / 零新 authority / 零新 capability token / 零 IPC / 零 renderer 变更
    （结构断言 + git 审计）。

### T17-06（QA Evidence）— **已实现**

29. verifier-only：不 rerun tests/lint/build/git（spy 计数为 0，且 source audit 断言零
    child_process/spawn/exec/fs/network）。
30. required set 全满足 ⇒ PASS；缺任意 slot ⇒ FAIL + `missingSlots`；`repo.git` op=`baseline`
    **不属于**六条，不能冒充 status/diff（durable output 的 `op` 是身份来源）。
31. **latest terminal**：old success + newer failure ⇒ FAIL（不 cherry-pick）；
    run/task/workspace 交叉 ⇒ FAIL；无 active workspace ⇒ FAIL（绝不拿旧 invocation PASS）。
32. toolVersion == 当前注册版本；QA commandKey 正确；QA `commandDescriptorFingerprint` == 当前
    trusted descriptor 指纹（close/reopen 同 root 换命令 ⇒ `STALE_COMMAND_PROFILE`）。
33. 各自 `preAnchor == postAnchor`；六条 anchor 核心 identity 全等；
    **currentAnchor 在验证末尾最后读取并必须 == evidenceAnchor**（否则 `STALE_EVIDENCE`）。
34. verdict vs error：证据不满足 ⇒ ToolInvocation COMPLETED + `verdict:'fail'`；仅基础设施
    失败才 FAILED。
35. durable provenance：validator 的 `report` 经既有 ArtifactService 物化为
    `artifact:art_<id>`（同一 run）进 evidenceRefs；targetRef 仍为 `artifact:art_<ulid>`；
    不发明新 reference namespace。Validation 记录仍走 `validation.record`。
36. EvidenceGuard：latest durable batch wins（PASS 后新 FAIL batch ⇒ gate DENIES），
    既有语义零改动。
37. **DevCompany 1.0.0 在 production-style 十工具 registry 下真实安装成功**（24 content refs /
    **Pack roles 5 / owner system role 1 / PackContentRefs 24 / workflow template 1 / 自动角色
    分配 0**（Sprint 16 冻结不变量逐条复证）；安装 ≠ QA PASS（新 run/task 无证据 ⇒ 仍 FAIL）。

### T17-07（Task-Start Baseline & Serial Agent）— **已实现**

38. **Task baseline 语义**：`repo.git op=baseline` 经真实 registry 捕获，deterministic
    idempotency key `task-baseline:<runId>:<taskId>` ⇒ exactly-once；重试/重入/恢复都
    **replay 原始 invocation**；后续人工 baseline（不同 key）不替换它；权威选择按 key，
    不按"latest repo.git baseline"。
39. **顺序（T17-07 CORRECTIVE 后）**：workspace 检查 → **acquire lease** → workspace 复检
    → baseline（durable COMPLETED）→ 同 workspace 校验 → repository 工作 → release。
    **lease 覆盖 baseline 采样到 work 开始的整个窗口**（corrective 前为 "probe → baseline →
    acquire"，其间的窗口可让第二 Agent 改写仓库，且 exactly-once replay 使该错误无法自愈）。
    acquire 失败 ⇒ 无 baseline invocation、无 workspace 触碰、无 work；任何终态（含 baseline
    失败、取消、抛异常）都释放 lease。
40. **Workspace lease**：process-local、**不 durable**，且是 **CompanyOS 执行互斥，不是 OS/
    文件系统锁**（外部进程/用户直接改仓库不在管辖内）；绑定 workspaceId/runId/taskId/
    executionId；第二执行（含不同 run/task）⇒ `REPOSITORY_AGENT_BUSY`（不排队、不采
    baseline、不碰 workspace）；leased 期间 close ⇒ `WORKSPACE_IN_USE`，switch 亦被拒
    （close→open 绕不开）；success/failed/cancelled/抛异常全部释放。
41. **Recovery**：trusted reopen 同 workspace + workspaceId 相同 ⇒ 复用原 baseline
    （不重采）→ 重新 acquire；不同 workspace ⇒ 拒绝；**不要求** currentAnchor == baseline。
42. Repository-capable 判定 = composition 在 StageHandlerRegistry 为该 kind 注册
    repository handler（generic，无 pack/role 特判）。仍 10 个工具、零新 authority、
    零 migration、零 Git mutation、零 validator 变更。

### T17-08（Production Composition & E2E）— **已实现**

43. **Production composition**：`apps/desktop/src/repository-runtime.ts` 的
    `composeRepositoryRuntime` 是唯一接线点（十个 toolPorts + 幂等 registerTools + 只读
    evidence/toolRecord 查询 + 惰性 stage handlers + 受信 openWorkspace seam）；
    desktop `composeCoreServices` 复用它，`composeSprint13Application` 通过可选
    `stageHandlers` 与 scripted registry 合并（engine 零改动）。
44. **repository-capable kind = generic `work`**，由 production entry
    （`apps/desktop/src/core-services.ts` 的 `composeCoreServices`）的可信参数
    `repositoryRuntime.repositoryCapableKinds` 声明（**默认为空 ⇒ fail closed**）；无
    packId/role 特判；非声明 kind 仍走原 scripted handler；模型/agent/workflow/pack
    均无法触达该参数（schema + 结构断言）。
45. **受信 seam**：root 与 command profile 只能来自 trusted host 调用；不是 Tool/IPC/
    Renderer；不 `process.cwd()` 自动开、不记忆 last path；无 workspace ⇒ runtime 正常启动
    且 repo tools fail closed。
46. **E2E（14 项，同一 production entry + 真实 Git repo + 真实 SQLite/CAS）**：
    正链 = trusted open → DevCompany 安装 → run pin → engine START → lease-before-baseline →
    `repo.git op=baseline`（durable，runId/taskId 正确）→ read/write/search → 四 QA（>16 KiB
    CAS 外置、pre==post）→ git status/diff → 六条同一 anchor → ValidationService PASS batch
    → EvidenceGuard accepts。
47. **负链**：证据后 `repo.file-write` 改源 ⇒ FAIL(STALE) + 新 FAIL batch ⇒ guard deny；
    同 slot 旧 success + 新 failure ⇒ FAIL（无 cherry-pick）；无 workspace ⇒ Task 'failed'
    且无 baseline；restart ⇒ workspace/lease 均不恢复、durable 状态全在、trusted reopen 后
    复用原 baseline。

## 最终测试证据（T17-09 closeout 记录）

- 规模：**145 files / 1689 cases**（`pnpm check` 5× PASS；`pnpm test:scripts` 23/23 PASS）。
- production E2E：`tests/sprint17/repository-production-e2e.test.ts` **14 项**（同一 production
  entry：compose → trusted open → DevCompany install → run pin → Engine START → lease → baseline →
  read/write/search → 四 QA（CAS 外置）→ git status/diff → 六条同一 anchor → ValidationService
  PASS → EvidenceGuard accepts）。
- negative E2E：STALE 改源（validator FAIL + 新 FAIL batch + guard deny）、anti-cherry-pick
  （同 slot 旧 success + 新 failure ⇒ FAIL）、无 workspace ⇒ Task 'failed' 且无 baseline。
- restart E2E：关库/销毁 process-local 状态 ⇒ fresh composition 后 workspace 与 lease 均不恢复、
  repo tools fail closed；durable 的 baseline / validation / ToolInvocations / CAS 全部仍在；
  trusted reopen 后复用原 baseline invocation。
- `tests/sprint17/` 合计 **218 项**；既有 Sprint 8/9/10B composition 断言随
  `apps/desktop/src/core-services.ts` 抽取同步更新（零删除）。

## 诚实声明（closeout 必须保留）

- Git 只读语义的边界：`rev-parse --show-toplevel` 必须**精确等于** workspace canonicalRoot；
  linked worktree / external git dir / 已登记 submodule / untracked 嵌套仓库一律 fail closed；
  `--no-ext-diff --no-textconv --no-color` + `core.fsmonitor=false` + `GIT_OPTIONAL_LOCKS=0`
  抑制仓库配置驱动的外部程序与 index 写入（测试实证外部程序未执行、HEAD/index/refs 不变）。
- workingTreeFingerprint 只对**内容**敏感（mtime-only 稳定），且 **HEAD / INDEX / WORKING TREE
  三层各自独立输入**（INDEX mode+object id、HEAD mode+object id、worktree mode、rename origPath 全部
  纳入；T17-05 corrective 修复了"只改 staged blob 而 fingerprint 不变"的 blocker）；覆盖
  staged + unstaged + untracked（路径与内容）；**ignored 文件不纳入**（写明的 limitation）；
  `MAX_GIT_STATE_ENTRIES = 10,000` 超限 fail closed；大文件流式哈希，不整体读入。
- Anchor 不是 durable 实体：进 structured Tool output，由既有 ToolInvocation 持久化；T17-06 需
  在验证前重读 `getCurrentAnchor()`。
- **六条 QA 证据的 anchor 覆盖**（T17-05 final integration）：repo.test-runner/linter/typechecker/
  builder 带 preAnchor/postAnchor；`repo.git op=status`/`op=diff` 亦带 preAnchor/postAnchor
  （同一 provider、单一算法）；`repo.git op=baseline` 带完整 anchor。`repo.git` 只记录事实，
  `pre != post` 不改变 invocation 状态（freshness verdict 属 T17-06）。
- Sandbox：V1 不声称 OS 级隔离；host executable 技术上可能联网（已知限制，见契约 §12）。
- WorkspaceContext 不 durable：重启后须重新 openWorkspace。
- Sprint 17 完成态 = production registry 含六个冻结 ID（DevCompany 可安装）；**不等于**"DevCompany
  fully operational coding company"——QA PASS 必须由真实命令证据链产生。
