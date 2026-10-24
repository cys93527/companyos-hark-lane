# DSH KERNEL SECURITY BOUNDARY — 权限/审批/沙箱边界(Stage 3 冻结)

> 目的:冻结 CompanyOS ↔ DSH Kernel 的权限分层、审批唯一真相关系、permission mode profile、Windows 执行语义。
> 铁律:官方 SAFETY.md 自称 experimental/未审计/不可作唯一安全边界 → **本文件只允许 defense-in-depth 表述;禁止任何"DSH sandbox 保证 Agent 安全"式声明**。

---

## 1. 双层边界模型(冻结)

```
[CompanyOS Outer Boundary — 权威与证明]                 [DSH Inner Enforcement — 内核内执行约束]
S25 六阶段预检(config/secret 指针/信任根/cwd/能力/授权)   sandbox 三模式(fs/process 逐调用拒绝)
workspace trust + path containment(ARCH-034)           tool visibility(挂载集+per-agent 收窄)
capability negotiation(required ⊆ advertised)          approval interception(ask 策略逐请求)
SecretRef 指针 + 子进程 env 允许清单(ARCH-033)          output bounds/timeout/kill-tree
approval provenance(组合策略|已批准审批)                compaction/spill(上下文防爆)
process bounds + settlement + 不确定语义                 session(subordinate runtime state)
```

外层决定"是否允许发生这件事";内层决定"发生时机械收窄到什么范围"。**外层失效≠内层兜底承诺**——两层都可能被绕过(SAFETY 明示),所以 CompanyOS 的权威判定(settlement/uncertainty)永远不依赖内核自证。

## 2. APPROVAL 重新定界(单一真相关系,冻结)

- **CompanyOS Approval/Decision/Authority = 唯一业务授权 Truth**(现有 approvals 机制,APPROVAL.GRANT)。
- **DSH user-approval = 内核内部 enforcement seam**:策略(ask/never)、拦截、审计、fail-closed answerer 语义——**不拥有"用户是否批准"的判定权**。
- **实现映射(Stage 4)**:CompanyOS adapter 在 kernel 组合内注册 `approval/request` cordis 事件 answerer(作用域瀑布,官方 types.ts 证据)→ 该 answerer 只做一件事:把请求转译为 CompanyOS 审批查询并回传结果。

**COMPANYOS_APPROVAL → DSH_ENFORCEMENT 映射表**:

| CompanyOS 侧状态/裁定 | DSH answerer 返回 | 内核内效果 |
|---|---|---|
| 已存在有效批准(provenance 引用) | approve(带审计引用) | 动作放行,审计记录 |
| 审批被拒绝 | deny(reason) | 工具调用失败(同轮升级提示),Agent 自行调整 |
| 无审批且策略=ask 而无可用 answerer | (内核自身语义)unavailable | **fail-closed 拒绝**(官方语义:answerer 缺失=拒绝) |
| 高风险永不询问 | policy=never | 直接拒绝 |
| 审批等待超时/取消 | deny(signal) | 请求取消 |

**禁止**:DSH 内任何组件写入/创建 CompanyOS 审批;answerer 是只读桥+结果回传。

## 3. PERMISSION MODE PROFILE(冻结)

- 可用模式(官方语义):`read-only`(fail-safe 默认)/ `workspace-write` / `danger-full-access`;approval:`ask`/`never`。
- **V1 规则**:①组合默认=`read-only`;②按 Task 由 CompanyOS(经 profile 生成器)提权至 `workspace-write`(workspaceRoot=该 attempt 预检证明的信任根);③**`danger-full-access` 不出现在任何 CompanyOS 生成的 profile 中**(生成器不产出该值;守卫:Stage 4 源级探针——CompanyOS 侧 profile 生成代码禁含该字面量);④模式由组合配置决定,Agent/模型运行期**无切换接口**(官方:模式经 session 事件切换需要挂相应 UI/命令面——我们不挂)。
- **权限升级请求**:模型只能通过被拒绝的工具调用观察"当前模式+同轮升级提示"(官方 fs-sandbox 语义)→ 产生**请求**(经 approval answerer 上行)→ CompanyOS 决定;**升级永不自效**。

## 4. FILESYSTEM 边界(enforcement chain,冻结)

目标:内核 fs 只触达 ①CompanyOS 授权 workspace(=该 attempt 的预检证明根)②合法 materialized input artifact(Stage 4:引用→读经 canonical artifact read seam 落地为 scratch 内文件)③平台临时根。
**链**:S25 预检证明 root(外层)→ spawn 时 cwd=canonical root → sandbox-policy workspaceRoot=同根 → fs-sandbox read-only/workspace-write 逐调用拒绝(内层)→ windows-acl 进程写收窄(Windows 内层,partial)。
**不可达**(由外层结构性保证):CompanyOS DB/SecretVault/其他 workspace/用户全盘——内核进程根本拿不到这些路径的授权与注入;profile/scratch 目录在 attempt 结束销毁。

## 5. PROCESS/SHELL owner(冻结)

- **Native deterministic execution**(native.process)保留现状:确定性操作走 CompanyOS 自有 ProcessExecutorProvider+S25 预检——**不因内核存在而改变**。
- **Agentic shell**:kernel 内 persistent pwsh/bash,经 bash-sandbox/pwsh-sandbox+windows-acl+timeout/kill-tree。理想链已达成:CompanyOS Authority(任务边界+审批)→ policy translation(sandbox-policy/workspace-write/工具挂载集)→ DSH constrained process executor。**两套限制的关系**:CompanyOS 侧管"是否/在哪/多久"(外层证明),DSH 侧管"进程内写/网络工具的机械收窄"(内层)——不是重复,是纵深;不一致风险由单一 workspaceRoot 源头(CompanyOS 预检)消除。

## 6. WINDOWS FIRST(执行语义清单,冻结验证项)

| 项 | 官方机制(证据) | V1 判定 |
|---|---|---|
| Node/工具链 | engines ^22.19\|\|>=24;pnpm@11.7.0 | PASS(门禁环境精确匹配) |
| PowerShell | dsh-tool-pwsh(-persistent)+terminal-bash pwsh 方言(win32 启用) | PASS(一等) |
| cwd/路径规范化 | workspace/canonical 路径组件 | Stage 4 实测 |
| symlink/junction | sandbox 路径规范化+reparse 检查(sandbox 族) | Stage 4 实测 |
| 进程树取消 | kill-tree(win32 taskkill 语义,dsh-win32-process) | Stage 4 实测 |
| 信号行为 | abort→终止树;Windows 无 POSIX 信号面 | Stage 4 实测 |
| 文件系统沙箱 | fs-sandbox(workspace-write) | PASS(机制在;实测 Stage 4) |
| ACL 能力 | sandbox-windows-acl(**诚实 partial**:hardlink 限制;失败阻启) | **PARTIAL(如实)** |
| 临时目录 | 平台临时根策略 | Stage 4 实测 |
| 长路径 | 路径规范化组件 | Stage 4 实测 |
| 子进程生命周期 | subprocess-local(spawn helper postinstall) | PASS(install 实证) |
| Linux-only 项 | Landlock(landlock-run addon) | **不计入 Windows PASS**(诚实披露) |

**判定规则(冻结)**:凡 Linux-only enforcement 不得计入 Windows PASS;windows-acl 以其自报 partial enforcement level 如实记录。

## 7. 网络边界(冻结)

V1 内核**不挂载任何网络工具**(web/search/fetch/browser 包不在组合面)→ 网络=不可用而非被禁(结构性缺席,最强形态)。未来挂载时:webfetch 预批准 URL 规则+proxy 策略(launch-environment/http-proxy)进入升级门评审。
