# H16 — Windows 文件/网络隔离（Hark lane）

状态：**完成（Hark self-review PASS，非独立评审）**。H16a 探测、H16b-2 生命周期、H16b-3a 生产接线、H16b-3b 安装后隔离 PONG + 负例 + 卸载回读均在 GitHub Windows runner 上通过（b6c85cc 全部工作流绿）。独立评审：**未授予**（由用户/评审人按 H17 资料执行）。用户批准：2026-10-26 08:39（ROADMAP #11）。只在 GitHub Windows runner 上验证，**从不改动用户本机**；真机验证属 H17。

设计与探测原始记录：`lane/H16_DESIGN.md`（含 PROBE RESULT），证据 `lane/evidence/H16-ci/`（保留每次首次失败）。

## 目标与边界
- 随包代理内核（DSH）整棵进程树以**专用本地账户**运行，而不是以用户本人身份运行。
- 文件：该账户只能写工作区与内核状态目录，只能读执行内核安装目录；CompanyOS userData（数据库、凭据、账本）显式拒绝。
- 网络：该账户只能连到 CompanyOS 自己的模型 broker（127.0.0.1 固定端口）；broker 以用户身份运行，只放行 provider 主机并校验每个内核请求的预算准入。
- Job Object 只负责生命周期（KILL_ON_JOB_CLOSE、无残留），**不冒充隔离**（SECURITY.md）。

## 架构（以探测结果为准）
| 层 | 实现 | 证据 |
|---|---|---|
| 账户 | 提权一次性 setup 创建 `CompanyOSAgent<6hex>`（本地账户名 ≤ 20 字符，原 `CompanyOSAgent-xxxxxx` 21 字符被拒 → 类型化 `ACCOUNT_NAME_INVALID`）；随机密码由非提权应用生成并以 DPAPI(CurrentUser) 保存于 `userData/isolation/agent-credential.dpapi`，setup 读后删除交接文件、从不记录密码；创建账户 profile（CreateProfile） | lifecycle L1、L8 |
| 启动 | `companyos-isolated-launch.exe`（安装器内用系统自带 csc 编译）：CreateProcessWithLogonW + LOGON_WITH_PROFILE，身份环境变量（HOME/TEMP/APPDATA）改指账户 profile，CREATE_SUSPENDED 后放入 Job Object（KILL_ON_JOB_CLOSE），stdin/stdout/stderr 透传，退出码透传；凭据坏/profile 缺失 → 120–125 类型化退出 | lifecycle L3b |
| 文件 | 工作区 FullControl（内核内层 shell 沙箱 grantWrite 需要 WRITE_DAC+WRITE_OWNER，见根治 10）；内核状态目录 Modify；内核目录 ReadAndExecute；userData Deny；每个授权目录的每一级祖先目录加"仅此文件夹 ReadAttributes, Synchronize"（探测 F1：node realpath 会 lstat 祖先）；profile 列目录仍拒绝 | lifecycle L3.file.* |
| 网络 | 持久 WFP 过滤器（固定 provider/sublayer GUID，ALE_AUTH_CONNECT_V4/V6，条件 ALE_USER_ID = 账户 SID；V4 放行仅 broker 端口，V6 全阻断；BLOCK + CLEAR_ACTION_RIGHT，sublayer 权重 0xFFFF）。Windows 防火墙规则**从不匹配回环**（探测 F3：本机代理如 127.0.0.1:7890 就能出网），因此不用防火墙 | lifecycle L3.net.*、L3.child.* |
| 状态 | `setup.ps1 -Action status` 输出 `ISOLATED / ISOLATION_DEGRADED / NOT_CONFIGURED`；WFP 对象带显式 SD（BA/SY 完全控制，读者 SID 只读），非提权应用可读状态（探测 L4b 曾为 0x5 拒绝 → 根治） | lifecycle L2、L4b、L5、L6 |
| 应用接线 | `apps/desktop/src/executor/isolation/`：`isolation-status-runner.ts`（无 `userData/isolation/state.json` → NOT_CONFIGURED；否则非提权调用 setup.ps1 status，失败即关闭）、`isolated-launch-seam.ts`（ISOLATED → 经启动器启动内核，argv 原样；NOT_CONFIGURED → 保持现状并标"未隔离"；DEGRADED 或启动器/凭据缺失 → 拒绝派发，**绝不静默回退为不隔离**）；broker 绑定 state 中的固定端口，端口被占用则失败关闭 | tests/hark/h16b-*.test.ts；installer 40360476317 |

## CI 结果（只列真实运行；不跨运行累加）
| 阶段 | 运行 | 结论 |
|---|---|---|
| H16a 探测 | hark-isolation 40334964921 @b6cd9bd | ISOLATION_PROBE_PASS 25/25（首次失败 run1–run5 保留：BOM/stderr 包装、::1 单地址被拒、祖先 lstat EPERM、防火墙不匹配回环 ×2） |
| H16b-2 生命周期 | hark-isolation 40352982060 @d80af91 | ISOLATION_LIFECYCLE_PASS 43/43（安装、新进程状态、隔离子进程身份/网络/文件、启动器 8 项、非提权状态、WFP/ACL 篡改 → DEGRADED、修复不重复、卸载回读）。首次失败 run 7 40347340358（36/40，子进程 os.userInfo() ENOMEM：未加载 profile）→ 根治 d80af91 |
| H16b-3a 生产接线 | hark-installer 40360476317 @939655c | 绿：启动器编译、resources/isolation 入包 |
| H16b-3b 安装后隔离 | hark-installer 41199673358 @b6c85cc | INSTALLED_ISOLATION_PONG_PASS 13/13（P1 提权安装 ISOLATED + 交接文件删除；P2 生产接缝判定隔离启动；P3 打包内核健康 + 隔离账户 PONG + pwsh 工具调用 + 产出文件属主为隔离账户；N1 凭据缺失拒绝派发；N2 ACL 篡改 → 拒绝派发；N3 卸载、NOT_CONFIGURED 标"未隔离"、账户已删除）；安装冒烟 36/36（含 h16-isolation-* 7 项与 h16-uninstall-removed-isolation）。同一提交：hark-windows 41199673369、hark-ubuntu 41199673359、hark-isolation 41199673425、hark-restart 41201181182 均绿。首次失败保留：41182921120（userData lstat）、41184110972（工作区 WRITE_DAC）、41189442900（5.1 弯引号）、41191287370 / 41194007074 / 41195872992（卸载未移除隔离） |

## 根治过的问题（摘要）
1. 本地账户名超长（21 > 20）→ 名称规则 + 类型化错误。
2. 防火墙不匹配回环 → 改用 WFP 按账户 SID 过滤。
3. node 祖先 lstat 被拒 → 祖先目录仅此文件夹 ReadAttributes。
4. 非提权读 WFP 对象 0x5 → 对象显式安全描述符。
5. 子进程 profile 未加载导致 ENOMEM、TEMP 指向安装用户 profile → CreateProfile + LOGON_WITH_PROFILE + 环境改写。
6. PowerShell 报告 ConvertTo-Json OOM（Get-Content 字符串带 ETS 注解）→ 记录时即快照为有界纯字符串。
7. userData 显式 Deny FullControl 连文件夹本身的 ReadAttributes 也拒绝 → node realpath 对位于 userData 内的内核状态根 lstat EPERM（hark-installer 41182921120）→ Deny 拆分：文件夹本身拒绝除 ReadAttributes/Synchronize 外的一切，子项 FullControl 仅继承拒绝；状态检查校验继承/传播标志。
8. 目标工作区不在已授权根目录下时内核会以无权写入的账户运行 → 设置状态记录 workspaceDirs，`planIsolatedLaunch` 以 `workspace:notGranted` 拒绝（按路径段、忽略大小写）。
9. 安装/升级重建 resources/ 会丢失对 resources/agent-kernel 的授权 → 改为对安装目录 {app} 授予 ReadAndExecute（升级后仍在）。
10. 内核内层 shell 沙箱（上游 sandbox-windows-acl grantWrite）以隔离账户身份给工作区加能力 SID ACE 与 Low 完整性标签，需要 WRITE_DAC + WRITE_OWNER；Modify 不含 → 每次 pwsh 工具调用 Win32 5（hark-installer 41184110972）→ 工作区根目录授予 FullControl（继承），状态目录仍 Modify。
11. 开始菜单「CompanyOS 隔离设置」脚本在 Windows PowerShell 5.1 上解析失败：PowerShell 把中文弯引号 U+201C/U+201D 当作普通双引号，双引号字符串里的“已隔离”提前结束字符串（hark-installer 41189442900 安装冒烟 h16-*）→ 改用「」，并加 tests/hark/h16b-ps1-quote-chars.test.ts：scripts/hark 下所有 PowerShell 脚本禁止 U+2018–U+201E，含非 ASCII 必须带 UTF-8 BOM。
12. 卸载时未移除隔离（账户/状态/凭据残留；hark-installer 41191287370、41194007074 输出为空，41195872992 捕获到真实错误）：卸载程序由运行在 PowerShell 7 中的父进程启动时，把 pwsh 的 PSModulePath 传给 Windows PowerShell 5.1，5.1 随后自动加载 PowerShell 7 版的 Microsoft.PowerShell.Security / Utility 失败（`Get-Acl ... module could not be loaded`；早先 `*> 文件` 重定向依赖 Utility，所以连输出都没有）。8817dec 的 RedirectionGuard 推断是错的，已恢复 Inno 默认值。根治：所有随包发布的 5.1 脚本（configure-isolation.ps1、configure-deepseek.ps1、isolation/setup.ps1）在第一条命令前 `Repair-WindowsPowerShellModulePath` 恢复 Windows PowerShell 模块路径（子进程继承修复后的值）；已提权调用方直接运行 helper 并捕获 stdout/stderr/退出码；每次结果写入 %APPDATA%\CompanyOS\isolation-setup.log；tests/hark/h16b-uninstall-removal.test.ts。

## 诚实残留（不宣称已关闭）
- DNS：名字解析由 DNS Client 服务（NetworkService）代发，按账户 SID 的过滤看不到 → DNS 查询仍可作为外泄信道。
- 其他卷根（如 D:\）对 Authenticated Users 默认可读 → 隔离账户可列/读这些位置中未单独收紧的数据。
- 隔离需要一次管理员提权（UAC）；普通标准用户无管理员凭据时无法启用，应用保持"未隔离"标签并照常可用。
- 只在 GitHub windows-2022 runner 上验证；真机（家用版、杀毒软件、域策略）未运行，属 H17 用户验收项。

## H16b-3b 收尾说明（原"剩余工作"）
1. 安装冒烟隔离 PONG + 负例 + 卸载回读：**已完成**（见 CI 表 H16b-3b 行）。
2. 启用/移除隔离的入口：按 V1 边界（渲染进程不接触凭据、不发起提权）改为开始菜单「CompanyOS 隔离设置 / 移除隔离」助手（scripts/hark/setup/configure-isolation.ps1，UAC 提权运行 setup.ps1，账户密码只经 DPAPI，结果写 %APPDATA%\CompanyOS\isolation-setup.log）；卸载时自动移除。应用内只读显示隔离状态，不提供提权按钮——这是有意的边界，不是遗漏。
3. `.dsh-stages` 收紧为只读：**不做**，理由：隔离账户本身就是运行该内核代码的身份；每次尝试派发前 verifyStaged 对 stage 做 100% 闭包重新哈希（embedded-dsh-runtime.ts），篡改在下次尝试即失败关闭，因此不会出现"被篡改的 stage 被信任执行"。
