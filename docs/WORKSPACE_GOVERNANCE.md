# CompanyOS 工作区治理（Workspace Governance）

> 依据：用户 STEP 1 裁定（Sprint 0 汇报审阅结论）+ ADR-0004。
> 本文件定义**谁可以在同一工作区里写文件**，防止并发写入导致的互相覆盖与"来源不明的修改"。

## 1. 背景（为什么需要这条规则）

Sprint 0 收尾期间实测到：**同一仓库目录被第二个 Agent 会话并行写入**，表现为同一份文档在
数十秒内被反复重写（同一次动作内连续读取 `docs/OPEN_SOURCE_RESEARCH.md` 得到 160 / 229 / 297 行
三种内容），`git status --porcelain` 在空与非空之间闪烁。后果：

- 验证结论失效：`pnpm check` 的结果只对某个瞬间的树成立；
- 提交不可信：`git add -A` 会把另一个会话的半成品一并提交；
- 覆盖风险：两个会话可能同时改写同一文件，后写者静默丢弃前者的工作。

## 2. 规则（强制）

| # | 规则 | 判定方式 |
|---|---|---|
| G1 | **同一 Workspace 同一时间最多只能有一个 Writer Agent。** | 开工前先做写入漂移采样（见 §3）；有漂移即视为存在第二个 Writer |
| G2 | **Reviewer 默认只读。** 评审者不得写入任何文件，包括"顺手修一下"。 | 评审报告只以返回文本/消息形式给出；`git status` 在评审期间必须保持为空 |
| G3 | **QA 默认只读。** 除测试自身产生的临时文件（系统临时目录、被 `.gitignore` 覆盖的构建产物）外，不得修改源码。 | QA 结束后 `git status --porcelain` 必须为空；不得出现被改动的 `src/**` |
| G4 | **需要多个 Writer 并行时，必须使用独立 Git Worktree**，禁止共享同一工作目录。 | `git worktree list` 能看到各自目录；每个 Writer 只在自己的 worktree 内提交 |
| G5 | **发现来源不明的修改：立即停止写入**，先列出差异并判断来源，交用户裁决。 | 执行 `git status --porcelain` + `git diff`，逐文件判断归属（时间戳、内容风格、是否符合本会话动作） |
| G6 | **禁止**用 `git reset --hard` / `git clean -fd` 掩盖差异。 | 仅在获得明确人工批准后允许；执行前必须先把差异导出留档 |

## 3. 开工前的写入漂移采样（可复制执行）

```powershell
# 采样窗口内本会话不得写文件。changed 必须为 0，否则判定存在第二个 Writer。
cd <repo>
$exclude = '\\node_modules\\|\\\.git\\|\\dist\\|\\coverage\\'
function Snap { Get-ChildItem -Recurse -File -Force | Where-Object { $_.FullName -notmatch $exclude } |
  ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.ToString('o'))" } | Sort-Object }
$before = Snap; Start-Sleep -Seconds 120; $after = Snap
(Compare-Object $before $after | Measure-Object).Count      # 期望 0
git status --porcelain                                       # 期望空
git rev-parse HEAD                                           # 期望等于冻结基线
```

Sprint 1 开工前的实测结果：`files sampled 140 -> 140`、`changed = 0`、`git status` 空、
`HEAD = 76d7bd733c7531f2ccb20d4cf29e0eb69a8312e9` —— 该窗口内**无第二个 Writer 活动**。
注意：这只证明"采样窗口内没有写入"，**不证明另一个会话已终止**；因此 G1–G6 依然生效。

## 4. 角色权限矩阵

| 角色 | 允许写 | 禁止写 | 备注 |
|---|---|---|---|
| **Writer（实现者）** | 本 Sprint 范围内的源码、测试、文档、ADR | 冻结基线之外的既有提交历史；他人的工作目录 | 同一工作区同一时间仅 1 个 |
| **Reviewer** | —（只读） | 一切文件 | 结论以文本给出；由 Writer 决定是否采纳 |
| **QA** | 测试临时产物 | `src/**`、`docs/**`、配置、锁文件 | 真实工具运行（tests/lint/typecheck/build/diff） |
| **用户（老板）** | 一切 | — | 唯一有权批准 `reset --hard` / `clean -fd` 与宪法修订 |

## 5. 隔离方案（未来并行时）

| 方案 | 适用 | 要求 |
|---|---|---|
| 单 Writer（默认） | Sprint 0–1 | 本文件的全部规则 |
| Git Worktree | 需要 2 个以上并行 Writer | 每个 Writer 一个 worktree + 一个分支；合并由用户或 Chief 决策；禁止跨 worktree 直接改文件 |
| 容器/沙箱（规划书 §四十七 V3） | 远程或高风险任务 | 每个 Agent 独立文件系统；产物以 Artifact 形式回传 |

## 6. 与审计的关系

每一次写入都应当能回答「谁写的、什么时候、为什么」（规划书 §四十四）。因此：

- Writer 在 `PROJECT_HANDOFF.md` 记录本轮动作与验证结果；
- Reviewer 的结论与 QA 的命令输出必须留档（评审记录、Validation Result）；
- 任何被判定为"来源不明"的修改，在未裁决前**不得提交**，且必须在 Handoff 的 Open Risks 中登记。
