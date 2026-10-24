# WINDOWS AGENT SANDBOX PROOF REPORT

Mechanism:
AppContainer / LowBox（`CreateAppContainerProfile` 每_attempt 唯一身份 + 零网络 capability +
`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`（attr 0x00020009，cbSize=24——本机 Win11 22631 实测值））
+ Windows Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，无 breakaway 许可，CREATE_SUSPENDED→Assign→Resume）
+ DACL 授权（FFI `SetEntriesInAclW`：仅 workspace(F)/per-attempt home(F)/受信 toolchain roots(RX)；REVOKE_ACCESS 回收）。
宿主实现：`scripts/win-sandbox/lowbox.cjs`（koffi FFI 骑 pinned DSH runtime 自带 koffi@3.1.1，零新 CompanyOS 依赖）。

Outside Read:
**BLOCKED**（sibling workspace / fake HOME ~/.ssh / fake SecretVault / CompanyOS 仓库 package.json，4/4 canary 均不可读）

Outside Write:
**BLOCKED**（Set-Content 新建/改写、New-Item 目录、Remove-Item 删除，canary 字节原样、无新对象）

Network:
**BLOCKED（全部向量，零 capability）**
- PowerShell Invoke-WebRequest → 非 loopback：BLOCKED；任意 loopback 非 broker 端口：BLOCKED
- Raw TCP（System.Net.Sockets.TcpClient.ConnectAsync）：TCP=False（未连接）
- DNS（Resolve-DnsName github.com）：BLOCKED
- canary listener 命中 0/0（loopback+LAN 双监听）
（curl.exe 向量因 PS 内引号解析未单独取得输出；IWR+raw-TCP 已覆盖 HTTP 与传输层）

Junction:
**BLOCKED**（静态：junction 指向 outside 的 read/write/create/rename 全 OS-DENY；
TOCTOU race：4ms 翻转 × 120 次 PS 循环 read/write/create/Move-Item——RACE-DONE=true 完整执行，outside canary=SAFE-RACE、无逃逸文件；race 命中时由 OS token 边界兜底，P0-3 关闭）

Job Tree:
**PASS**（Cancel：job close 后 Start-Process/Start-Job 后代 marker=0；Timeout：TerminateJobObject 后 marker=0；P0-4 关闭）

Normal Node:
**NO** —— node.exe v24.19.0 在 AppContainer 内确定性崩溃：`node::InitializeOncePerProcess` 原生栈 + exit 134。
已排除变量：镜像位置（Program Files 与 workspace 副本）、环境（继承/batch-set/最小集）、capability（零与 internetClient 均崩）、命令行（--version/--help/脚本）。
对照：同一 node 在 DSH restricted-token（write-restricted token）下 `--version` 正常（v24.19.0, exit 0）→ 崩溃特定于 AppContainer/LowBox token 形态。

Normal PowerShell:
**YES**（Windows PowerShell 5.1 完整运行：脚本/Test-Path/Get-ChildItem/Start-Process/Start-Job/net 套接字/DNS 探测全部可用）

Normal Git:
**NO** —— msys git（E:\GIT\Git，含 cmd/ 与 mingw64/bin/ 直启）在 AppContainer 内 `fatal: could not open '/dev/null' for reading and writing: Permission denied`（exit 128，全部 git 子命令）。
机制：msys-2.0.dll 运行时依赖 BaseNamedObjects/共享节等 AppContainer 默认拒绝的内核对象——与 MSYS2 系工具在 AppContainer 的已知不兼容同类；非 ACL 可修（已证明 FFI 授权使 git.exe 可见可执行，仍失败于 msys 初始化）。

Failure Reason:
Phase A 隔离机制本身全部成立（§18 矩阵的隔离/树/网络/junction 行全 PASS，四个 P0 中的 P0-1/P0-3/P0-4 被该机制机械关闭）；
但 **toolchain 可用性行 FAIL**：Node（Agent 开发任务核心运行时）与 Git（版本控制）均无法在该容器内运行。
按 Boss §5（"如果无法满足 CompanyOS Agent 开发任务的基本执行能力"）与 §19（禁止自动 fallback 到防火墙/WSL/VM/换内核/写 Process Broker）：

**WINDOWS_OS_SANDBOX_PROOF = FAILED（仅因 toolchain；隔离面 PASS）**

附带工程发现（供 Boss 裁定参考）：
1. AppContainer 显式 lpEnvironment 经本 FFI 路径被拒（ERROR_ENVVAR_NOT_FOUND；OS 生成块 err 2）→ lab 用 batch `set` 注入 env（我们生成 batch，allowlist 由我们写入强制）。
2. icacls 不可作安全原语：/grant 静默篡改越界 subauthority、大树不传播；/remove 返回 ERROR_NONE_MAPPED/ERROR_INVALID_SID（留下已扩大的 ACL——§31 风险，已发现并清理了实验残留 ACE）。正确原语=SetEntriesInAclW（写后复读验证传播与回收）。
3. AppContainer SID 必须 CreateAppContainerProfile 注册（仅 Derive 未注册 SID → CreateProcess err 2）；每 attempt 独立 profile=天然 per-attempt isolation identity（§30 已证：A 读 B workspace OS-DENY）。
4. Environment 隔离：allowlist 之外零可见（COMPANYOS_TEST_SECRET 不可见；HOME/USERPROFILE 指向 per-attempt home）。
5. Cross-company：不同 scratch 树 OS-DENY（§32）。

Architecture Decision Required:
YES

（候选方向，均需 Boss 单独裁定，本轮未实现：Node/Git 以受限 token 沙箱（DSH 现成 windows-acl，已证 node 可跑）+ AppContainer 网络隔离的混合形态；或 Node/Git 的非 msys/非 node 原生替代；或接受受限工具集；或 OS 级其他机制——按 §19 本轮不自行选择。）

Phase B：**未进入**（按 §3/§20）。

Tests:
tests/sandbox-lab/phase-a-matrix.test.ts 官方跑 **13/16 PASS**（workspace/outside R/W/静态 junction/TOCTOU race/树 cancel+timeout/env/cross-task/cross-company/PS 基线/node+git 诚实测量行）；
3 个网络 vitest 用例因 harness worker 挂起超时（300s）未在套件内完成——同一向量的机械测量由 `node scripts/win-sandbox/lab.cjs net-ps` 完成并记录于本报告（LAN/LOOP/TCP/DNS 全 BLOCKED，canary 0 命中）
scripts/win-sandbox/lowbox.cjs + lab.cjs（net-ps/git/node/where/junction 探针）
门禁：pnpm test:sandbox（kernel config 顺序跑）；koffi 零新依赖（解析自 pinned DSH runtime）。

—— HARD STOP，等待 Boss 架构裁定。
