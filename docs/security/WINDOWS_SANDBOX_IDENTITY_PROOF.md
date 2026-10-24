# WINDOWS DEDICATED SANDBOX IDENTITY PROOF — 实测记录

机制选型（Boss §5 源码优先比较）：

| 候选 | 独立 SID | Node/Git 兼容 | 无密码 | 可 ACL | 网络身份绑定 | Job | 单安装 |
|---|---|---|---|---|---|---|---|
| A. 专用本地账户 | ✓ | ✓ (完整 Win32) | ✓ (CPWL/LSA) | ✓ | ✓ (Firewall -LocalUser) | ✓ | ✓ |
| B. 虚拟账户 | ✓ | ? | ✓ | ✓ | ? | ✓ | 需服务 |
| C. 服务 SID | ✓ | ? | ✓ | ✓ | ✓ | ✓ | 需服务 |
| D. restricted token | ✗ (同用户) | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ |

**选定：A（专用本地低权账户）+ per-attempt 随机密码（内存）+ Windows Firewall 身份级出站规则**

D（restricted token）被排除因网络无法绑定身份（无独立 SID）；叠加 restricting SID 可做纵深防御但需 elevated broker（本轮 lab 无法演示，生产由 SYSTEM broker 补充）。

## 实测结果（scripts/win-sandbox-identity/probe.cjs 逐向量）

### Toolchain 硬门（AppContainer 的失败点）
- **Node v24.19.0**：--version ✓ / JS 执行 ✓ / ws 读 ✓ / ws 写 ✓ / child_process ✓
- **Git 2.47.1**：version ✓ / status ✓ / add ✓ / commit ✓ / diff ✓ / -C ws ✓
- **PowerShell 5.1**：read ✓ / write ✓

### 文件隔离
- Outside Read（sibling/ssh/git/CompanyOS tree）：**BLOCKED**（EPERM / Permission denied）
  - 注：E:\ 盘 package.json READ-POSSIBLE——E: 卷根默认 ACL 含 Authenticated Users RX，属环境 ACL 非机制缺陷（生产 workspace 树正确 ACL）
- Outside Write（modify/create/delete/rename）：**BLOCKED**（canary 字节原样）
- Junction Static（read/write）：**BLOCKED**
- Junction TOCTOU Race：待补（race harness 需专用 lab root）

### 网络（Firewall -LocalUser <SID> 出站 Block）
- Invoke-WebRequest LAN/Loopback：**BLOCKED**
- Raw TCP（.NET TcpClient）：canary 0 命中
- Git ls-remote：**BLOCKED**（超时）
- Node http.get：**BLOCKED**（exit 1）
- **DNS：POSSIBLE**（已知限制：DNS Client Service 以 SYSTEM 身份代行查询，per-identity firewall 无法拦截；生产缓解：HTTPS 阻断覆盖 DoH，或 DNS policy）
- Canary 命中：0/0

### 进程树
- Cancel（job close）：**零残留**
- Timeout：**零残留**

### 身份隔离
- Cross Task（A ws → B ws）：**BLOCKED**
- Cross Company：**BLOCKED**
- Environment：allowlist 外零可见（SECRET-SEEN=False）
- Home Isolation：真实 ~/.gitconfig **BLOCKED**

### 权限需求
- 安装：Admin（创建账户 + 防火墙规则）
- 每 Task 运行：**无需 UAC**（CreateProcessWithLogonW 走 seclogon，零特权要求——与 runas 同机制）

### 性能（桌面产品数量级判断）
| 操作 | 延迟 |
|---|---|
| Account create | ~1.6s |
| Firewall rule | ~2.6s |
| ACL grant（3 paths + read-back） | ~0.6s |
| Process launch | ~10ms |
| ACL revoke | ~0.6s |
| Firewall remove | ~3.2s |
| Account delete | ~1.4s |
| **Setup 总计** | ~6s |
| **Teardown 总计** | ~5s |

桌面可接受：首次 attempt ~6s setup（可优化为安装级 identity + per-attempt ACL grant/revoke ~1s）；每命令 launch ~10ms。

### 已知限制
1. **DNS 经 DNS Client Service 绕过**——per-identity firewall 不覆盖 SYSTEM 服务代行的 UDP 53；生产缓解：DoH 已被 HTTPS 阻断覆盖、或部署级 DNS policy
2. **Lab root 需正确 ACL**——新建目录默认含 Authenticated Users（本轮已修正 lab root 为 Admins/SYSTEM only；生产 workspace 部署时同样处理）
3. **restricting token 叠加需 elevated broker**——纵深防御（deny-by-default 覆盖 Authenticated Users/Everyone），lab 环境无法演示；生产由 CompanyOS SYSTEM broker 服务执行（安装级一次启用）

### 密码生命周期
- 随机 24-byte 密码仅存于 lab 进程内存（§9 全禁面零命中）
- 生产：安装级 identity + LSA-backed secret（写入一次 by installer，运行时 SYSTEM broker 读取）
