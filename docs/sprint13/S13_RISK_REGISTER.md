# S13 Risk Register（Sprint 13A Freeze）

> 状态：FROZEN（Proposed）。分类：**Must Solve In Sprint 13 / Mitigate In Sprint 13 / Later / Out Of Scope**。
> 配套：`S13_ARTIFACT_CONTRACT.md`（信任边界与崩溃模型）· `S13_TEST_STRATEGY.md`（负例矩阵）· ADR-0015。

## 1. 风险登记（§27 全 20 项）

| # | 风险 | 分类 | 处置（冻结） |
|---|---|---|---|
| R-01 | **Arbitrary Path Injection**（`../` `..\` 盘符 UNC `file://` 绝对路径） | **Must Solve In Sprint 13** | CAS 物理路径永不接受外部输入；file-reference 仅限组合根注册 workspace root 内相对路径，解析不逃逸 root；负例测试矩阵（TEST_STRATEGY §8） |
| R-02 | **Hash Spoofing** | **Must Solve** | contentHash 永远由 trusted side 对实际 bytes 实算；caller 声明不信；ArtifactContentStore.put 返回实算值 |
| R-03 | **Validator Injection**（不可信 payload 注入 arbitrary executable validator） | **Must Solve** | 显式 validator capability registration；未声明 capability 的 Tool 不可被 validatorIds 引用（fail closed）；Renderer/外部不可动态注入 |
| R-04 | **Dangling DB → CAS Reference** | **Must Solve（预防+检测）** | 写序 content first → metadata second 压概率；启动对账 detect；命中即 fail closed（Case B）；**不给 Artifact 加 mutable corrupt 状态** |
| R-05 | **Duplicate Command Replay** | **Must Solve** | **双轨幂等（Option B，Blocker 裁定）**：Command Ledger = retry/result cache（有界窗口：每 dispatch 后 trim，默认 1000 条）；Artifact/Validation 行 = permanent creation identity（`creation_command_id`+`creation_command_fingerprint` 列 + partial unique index，tools 链先例同构）。row+event+ledger 同一 UnitOfWork ⇒ 无中间态；**trim 后重试由行级 identity 命中恢复同一 result**（fingerprint 异常 CONFLICT fail closed）——永久幂等不依赖 ledger 窗口；不建平行幂等系统、不加第三张表 |
| R-06 | **Caller-declared PASS** | **Must Solve** | status 以 durable 行为准；VALIDATION_PASSED 必须 evidence-backed（guard 11 项） |
| R-07 | **Unsafe file-reference** | **Mitigate In Sprint 13** | 双 trust model（CAS-managed vs file-reference）；root 约束 + 相对路径 + 逃逸检查；不构成任意文件读取 API |
| R-08 | **Wrong Evidence Reuse**（跨 Artifact/Run/validator 错绑） | **Must Solve** | evidence 绑定校验（targetRef + runId + validator identity）；guard 负例 9/10 + TEST_STRATEGY §4 |
| R-09 | **Orphan CAS object** | Mitigate | 只 detect/report/diagnose；**不做 aggressive GC**；自动删除推迟（误删风险） |
| R-10 | Resource exhaustion（oversized artifact） | Mitigate | size 上限沿用既有 IPC 传输上限先例 + 适配器层上限；超限 `INVALID_ARGUMENT` |
| R-11 | JSON bomb / deeply nested structured data | Mitigate | 结构化输出物化前经确定性校验（深度/体积上限）；复用 schema 校验器先例 |
| R-12 | Unsafe metadata | Mitigate | metadata 字段白名单 + 长度上限（先例：handoff 4000 字符纪律） |
| R-13 | Stale artifact reference（引用方指向已不存在对象） | Mitigate | 引用消费侧存在性校验（verifier + guard）；S13 无删除 API → 产生概率低 |
| R-14 | TOCTOU（check 与 publish 之间的窗口） | **Must Solve In Sprint 13**（Boss 收紧 1 升级） | 冻结原则：**CAS final publication MUST NOT overwrite an already-published object**；`pre-check + rename` 不得作为唯一保护（Node v24/win32 renameSync 静默覆盖已存在目标——实测）；no-clobber primitive（exclusive-create/hard-link/COPYFILE_EXCL 等）由 13B Windows 实机并发 publication test 择定（Writer A+B 同 hash 并发 → 不覆盖/无 partial/双调用成功）；已有 target hash 不符 → fail closed |
| R-15 | Windows symlink / junction / reparse-point abuse | Mitigate | CAS 目录内拒绝 reparse point（写入与校验时检测）；file-reference root 解析使用 real path 检查 |
| R-16 | Circular reference（结构化数据自引用） | Mitigate | 物化前校验器拒绝环（深度上限天然覆盖） |
| R-17 | Malicious Provider output | Mitigate | Provider 输出不自动物化（App 层决定）；物化经实算 hash + 上限 + schema 校验 |
| R-18 | Forged validation evidence | Mitigate | 证据链校验（durable 行 + 归属绑定 + guard 11 项）；R-02/R-06 叠加 |
| R-19 | Missing CAS object | Must Solve（同 R-04 检测面） | Case B fail closed |
| R-20 | Validator 执行超时/资源（间接风险） | Mitigate | 复用 Tool Registry timeoutMs / 风险门 / 审计（S9 既有） |

## 2. §24 八问的登记映射

| 问题 | 答案位置 |
|---|---|
| 1. CAS write 成功、DB 失败？ | Artifact 契约 §10.2 Case A：orphan 可存在，只 detect/report |
| 2. DB 有 ref、CAS missing？ | Case B：fail closed + Validation ERROR 表达 |
| 3. temp file crash？ | Case C：staging 命名 + detect |
| 4. duplicate content？ | Case D：幂等复用 + integrity 验证，不覆盖 |
| 5. startup reconciliation 做什么？ | Artifact 契约 §10.3：orphan/staging/dangling/missing 四类 detect+report |
| 6. 哪些自动修复？ | **S13：无**（全部推迟） |
| 7. 哪些只 report / fail closed？ | report：orphan、staging、CAS→metadata 孤儿；fail closed：metadata→CAS missing |
| 8. 哪些 deferred？ | 自动 GC/清理、corrupt 状态机、跨机 CAS、对账修复动作 |

## 3. Out of Scope（§28，明文排除）

```text
Cloud object storage · Distributed artifact storage · Cross-device sync · Artifact CDN ·
Large binary asset management · Video processing · Image processing · Media transcoding ·
LLM-as-a-judge · Provider-based semantic validation · User-defined arbitrary executable validators ·
Validator plugin marketplace · Collaborative Artifact editing · Mutable Artifact revision history ·
Artifact supersession system · Global content GC · Cross-machine CAS · Remote CAS replication
```

Sprint 13 不做 aggressive CAS garbage collection：orphan 优先 detect / report / diagnose；自动删除推迟。
