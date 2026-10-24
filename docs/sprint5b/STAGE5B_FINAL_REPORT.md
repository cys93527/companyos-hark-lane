# STAGE 5B — EMBEDDED AGENT SECURITY CLOSURE REPORT

Baseline:
b10e515

Final HEAD:
（见下方 Commits 后续 0e86bd5 + 报告 docs 提交；HEAD 以 git log 为准）

Commits:
- 8aba606 fix: close embedded runtime integrity gap (Stage 5B §2-§8)
- 4a6e514 test: prove windows agent process isolation state (Stage 5B §9-§17)
- 3fafdca test: close embedded agent security gate (Stage 5B §5-§7, §18-§19)
- e05eeac docs: record stage 5b security closure measurements
- 0e86bd5 test: harden boundary measurements (Stage 5B follow-up)

Runtime Files:
59,886（物化树全量；仅作背景，不再作为完整性依据）

Runtime Execution Closure Files:
15,439 critical（EXECUTABLE_CRITICAL 12,919 / CONFIG_CRITICAL 1,497 / NATIVE_CRITICAL 1,023；
709 个闭包包；5,984 条 junction 链接；NON_EXECUTION_ASSET 文档/测试/map/TS 源按分类不验证）

Runtime Integrity:
FULL_EXECUTION_CLOSURE_VERIFIED

Sampling Used For Critical Runtime:
NO

Post-Verification Tamper:
BLOCKED
（三个机械证明：closure 单边篡改=resolve FAIL；stage 篡改=下次 attempt 100% 门禁 FAIL；
源树篡改=篡改字节不可执行——child 只读 stage，且重新物化产生新 generation 强制重 staging）

Filesystem File Tool:
PASS

Shell Outside Read:
POSSIBLE

Shell Outside Write:
BLOCKED

Agentic Process Boundary:
PRODUCTION_NOT_SAFE
（§10 规则：shell 读 workspace 外=POSSIBLE 即触发；写全 DENIED、读 POSSIBLE、树泄漏、网络开放）

PowerShell Network:
POSSIBLE

Curl Network:
POSSIBLE

Node Network:
POSSIBLE

Git Network:
POSSIBLE

Network Classification:
NETWORK_ISOLATION_GAP
（全部 5 条非 loopback 向量实测可达 canary：HTTP-OK CANARY-REACHED / TCP-DATA 200 OK /
git ls-remote hits=2；windows-acl runner 的文件效果词表不含网络——源码与实测一致）

Model Broker Still Works:
YES
（同一 invocation 内 session 协议推进；loopback broker 路由与任意出口同时开放——loopback
本身也是开放面，属同一 gap）

Foreign Local Process Uses Broker:
NO
（nonce 未知=401；跨 attempt nonce=401；旧 token 重放=端口死/401；猜测形状全 401；自身路由 200）

Junction Static Escape:
BLOCKED

Junction TOCTOU Race:
POSSIBLE
（同名覆盖逃逸两次机械取证：专用跑 PWNED-1 + 官方全套跑再次逃逸；
最终 check 跑中 20Hz 新文件 race 亦逃逸一次——新建文件与覆盖两个形态均有实证）

Windows Reparse Boundary:
GAP
（同名覆盖 race 穿透翻转中的 junction 实际改写 outside canary=PWNED-1；新文件/Move-Item race
未逃逸；fs-sandbox 自述"NOT a kernel boundary"，write 工具运行于内核进程非 restricted token，
无 OS 级兜底——机械闭合需要架构变更，交 Boss）

Cancel Process Tree:
FAIL

Timeout Process Tree:
FAIL
（Start-Process/Start-Job 后代在 cancel/timeout 后存活，marker 残留=1；普通 shell sleep 取消正常）

Secret Canary:
PASS
（parent env / HOME / DSH_HOME canary 全零匹配；DB canary 零持久化；broker 日志零 secret）

Production Security Certified:
NO

External Audit Required To Enter Stage 6:
NO

External Audit Future Pre-release Item:
YES

Second Authority Truth:
NO

Second Sandbox Truth:
NO

Open P0:
1. NETWORK_ISOLATION_GAP — agent shell 任意网络出口全开（5/5 向量）。
   可能方向（均需 Boss 单独裁定，本轮未实现）：shell 级网络过滤/代理强制、Job Object +
   WFP/防火墙规则、受限 token 网络侧写、或接受为 V1 已知边界并改威胁模型。
2. WINDOWS_REPARSE_TOCTOU_GAP — write 工具同名覆盖 race 逃逸（fs 工具进 restricted token /
   handle-based 安全打开 / OS 级兜底，均为架构变更）。
3. 进程树泄漏 — cancel/timeout 后 Start-Process/Start-Job 后代存活（树杀机制升级：Windows
   Job Object kill-on-close）。

Open P1:
1. Shell 读越界=POSSIBLE（DSH windows-acl 文档化 partial；与写不对称）。
2. Loopback 任意端口开放（非 broker 的本地服务对 agent 可达）。
3. DNS 向量未单独实测（TCP 全开背景下推定开放）。
4. 生产 packaged-runtime 分发形态需携带闭包契约（当前 dev 物化树 + 升级脚本）。

STAGE_5_DECISION:

SECURITY_ARCHITECTURE_BLOCKED

依据 §22：三问题中 A（Runtime Integrity）已机械闭合；B（网络/进程树）与 C（junction race）
实测为开放缺口。按令未降标准、未自动关闭 Shell、未新增 Process Broker、未换 Kernel、
未引入容器/VM——全部架构选项留 Boss 裁定。

Next Stage:

SECURITY_REDESIGN_REQUIRED

Tests:
- tests/security-agent-attack.test.ts: 17/17 PASS（8 类篡改 FAIL-LOUD + 缓存审计 + TOCTOU 双门 + 真实树零抽样 + Stage5 原有攻击；旧 loopback 观察测试因伪断言删除，测量并入 boundary 网络组）
- tests/security-broker-security.test.ts: 7/7 PASS（+ token 复用/跨 attempt/猜测回归）
- tests/kernel/**（pnpm test:kernel）: 17/17 PASS（staging 迁移后 E2E/isolation/failures 全绿）
- tests/security-process-boundary.test.ts（官方全套跑 21 用例）: 10/21 PASS（文件边界 5/5 + 普通
  sleep 取消 1 + race 静态 junction/Move-Item/50Hz 新文件 3+）；FAIL 11 项即发现本身：网络 0/6
  （外部 5 全部 hits=1、git hits=2、loopback 任意端口 hits=1）、进程树 4（cancel/timeout/node/job
  后代残留）、race 逃逸（同名覆盖两次取证 + 20Hz 新文件一次）

Required Skips:
0

pnpm test:kernel:
1/1 run PASS（17/17 用例）

pnpm check:
FAIL at step test（官方最终跑：lint PASS 7.1s / typecheck PASS 6.8s / boundaries PASS 0.2s /
architecture PASS 3.3s / test FAIL 830.3s；2,784 passed / 13 failed——11 个为实测缺口（见上），
1 个 docs 索引缺本报告条目（已补），1 个 T17-05 entry-limit 为并行负载 flake（隔离复跑 30/30
全绿，与本轮改动无关）。5 连续 PASS 在缺口闭合前不可达，按 §22 不降标准）

pnpm test:scripts:
PASS

git diff --check:
CLEAN

Working Tree:
CLEAN（4 提交已落，未 push、未 tag、未 amend）
