# WINDOWS SANDBOX IDENTITY PROOF CLOSURE — 实测记录

## 1. Restricted Token Bisect 结果（Boss §3-§4）

| Test | 机制 | 结果 |
|---|---|---|
| CPWL（无 restricted token） | CreateProcessWithLogonW | **OK**（exit 0） |
| CPWT（无 restricted token） | LogonUser→CreateProcessWithTokenW | **OK**（exit 0） |
| CPWT（restricted token = sandbox SID S-1-4-x） | LogonUser→CreateRestrictedToken→CreateProcessWithTokenW | **FAIL err=5**（ACCESS_DENIED） |

**裁定**：Windows 11 22631 拒绝 CreateProcessWithTokenW 使用仅含 S-1-4 synthetic restricting SID 的 restricted token。这不是可修复的 bug——它是 Windows 内核安全子系统的限制（restricted token 中不含已登录的 Users group SID，且 S-1-4 空间不由 LSA 识别为有效 restricting SID 上下文）。因此：

**DEDICATED_IDENTITY + RESTRICTING_SID = 不可行**

### 5D-A 账户-only 的实际覆盖范围（非 restricted token）

| 场景 | 结果 | 归类 |
|---|---|---|
| C:\CompanyOS-SandboxLab（lab root `/inheritance:r` 仅 Admins/SYSTEM） | outside read/write **BLOCKED** | MECHANISM_PROOF |
| E:\ 盘用户数据（卷根默认 ACL 含 Authenticated Users RX） | **READ-POSSIBLE** | **GAP**（Boss §2 判定标准） |
| C:\Users\Administrator\.ssh | **BLOCKED**（用户 profile 含 Users DENY） | MECHANISM_PROOF |

Boss §27 要求：Users/Authenticated Users/Everyone readable outside 全部 BLOCKED。
**裁定：Dedicated Account alone 不能满足——Windows 默认 ACL 把 Authenticated Users RX 继承到几乎所有卷根目录。加 restricting SID 不可行（err=5）。**

## 2. DNS 身份链（Boss §11-§16）

Sandbox process → Win32 `Resolve-DnsName` → DnsQuery API → **ALPC/RPC → DNS Client Service (svchost, NT AUTHORITY\NetworkService)** → outbound UDP 53。

Windows 防火墙 `-LocalUser` 规则匹配的是**发起网络连接的用户 SID**。但 outbound UDP 53 的发起者是 **NetworkService**（DNS Client Service 服务身份），不是 sandbox 账户。因此 per-LocalUser 防火墙规则无法命中——不是配置错误，是架构事实。

**DNS_IDENTITY_ISOLATION_GAP 确认。**

要按 sandbox identity 阻断 DNS 需要：
- WFP callout driver（拦截并检查原始查询的 calling process）→ 需要自研 kernel driver（Boss §16 禁止）
- 或关闭整台机器 DNS Client Service → 破坏所有用户 DNS（Boss §15 禁止）
- 或 DNS policy（GPO）→ 全局影响（Boss §15 禁止）

**无 identity-scoped DNS enforcement 可行。**

## 3. 账户生命周期（Boss §17-§19）

PoC 用 per-attempt account。两种 lifecycle 比较：

| 维度 | A. per-attempt account | B. install-level account |
|---|---|---|
| create/delete 需要 | Admin（每次） | Admin（仅安装时） |
| per-attempt 隔离 | 好（唯一 SID） | 需要 restricting SID（不可行）或 ACL 时窗 |
| setup 延迟 | ~3s（account create） | ~0s（仅 ACL grant） |
| cleanup | 全部可回收 | ACL revoke + read-back |
| credential | 随机密码仅内存 | LSA-backed secret |
| crash recovery | 需扫描 orphan accounts（可做） | 需扫描 stale ACLs（可做） |
| cross-task 隔离 | 天然（不同 SID） | 不天然（同账户，需 ACL 时窗） |

**裁定**：如果 dedicated identity 路线可行（不考虑 restricted token gap），Option B 优于 A（减少 admin 需求、更快 startup）。但路线本身已有 GAP，此比较仅供参考。

## 4. Final 证明状态

| Boss §25 矩阵项 | 结果 | 备注 |
|---|---|---|
| Node/Git/PS works | PASS (CPWL, no restricting) | Stage 5D 已证 |
| Users-readable Outside | **POSSIBLE**（E: 盘卷根 ACL 继承） | GAP |
| AuthUsers-readable Outside | **POSSIBLE**（同上） | GAP |
| Everyone-readable Outside | **POSSIBLE**（同上） | GAP |
| DNS | **POSSIBLE**（DNS Client Service 身份绕过） | GAP |
| restricting token | **不可行**（CPWT err=5） | 架构发现 |
| 所有其他隔离行 | PASS | Stage 5D 已证 |

## WINDOWS_SANDBOX_IDENTITY_PROOF = FAILED

### Open P0
1. **World-readable outside data**：专用账户从 Authenticated Users 默认 ACL 继承读能力，restricted token 不可行——需第三路线
2. **DNS identity isolation gap**：DNS Client Service 以 SYSTEM/NetworkService 发包，per-identity firewall 无法阻断

### Open P1
- restricting SID + AppContainer 混合（AppContainer 网络天然隔离但 toolchain 不兼容）
- Windows Sandbox (WDAG) / Hyper-V container——隔离彻底但部署重

### Next: BOSS_ARCHITECTURE_DECISION

Boss 需选择的架构方向：
1. 接受账户-only + 限制 workspace 树 ACL（`icacls C:\ /remove Users:RX`）→ 侵入用户系统（Boss §4 禁止）
2. WFP callout driver（kernel mode，需签名/WHQL）→ 工程量大
3. WSL2 / Hyper-V container / Docker（隔离彻底、部署重）
4. 接受网络 gap（DNS-only）+ workspace 树 ACL 方案 → 不满足 Boss §27/§26
5. 其他
