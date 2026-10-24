# S14 Test Strategy（Sprint 14 测试矩阵冻结 — Task-14-01）

> 状态：**FROZEN**（Accepted：`TASK-14-01 APPROVED` 指令 §38，2026-09-26）。
> 本文定义 Sprint 14 测试矩阵。**状态**：A/B（T14-02 已实现）· C（T14-03 已实现：crash-recovery-e2e.test.ts 7 用例）· D（T14-04 已实现：dependency-failure-recovery.test.ts 8 用例）· E（T14-05 已实现：tool-failure-recovery.test.ts 6 用例）· F/G（部分随 T14-02/03 落地，其余随后续任务）。
> 先例：`S13_TEST_STRATEGY.md`。真实对象图测试（真实 SQLite + electron-free 组合模块）为默认形态。

## A. 启动编排（Orchestrator）

| # | 场景 | 关键断言 |
|---|---|---|
| A1 | startup no residue（干净库） | report 全零；启动健康；零恢复事件 |
| A2 | agent `RUNNING` | → INTERRUPTED；`agent.execution_interrupted`（previousStatus=RUNNING）；provider calls=0 |
| A3 | agent `WAITING_EXTERNAL` | → INTERRUPTED；同上 |
| A4 | tool `STARTED` | → INTERRUPTED；`tool.invocation_interrupted`；不自动 retry（即使幂等） |
| A5 | tool `WAITING_APPROVAL` | 原样保留；report 计入 waitingApproval；零事件 |
| A6 | run crashable 全集（PLANNING…FINALIZING 六态） | engine.recover → resumePoint；`run.crash_detected`+`run.recovered`；不执行 stage handler |
| A7 | run `RECOVERING` 跨重启 | 仅 `RECOVERY.COMPLETE`；**不重发** CRASH_DETECTED |
| A8 | run `PAUSED` | skip + report；状态不变；零事件 |
| A9 | 恢复顺序 | agent → tool → run（副作用归档先于 run 恢复） |
| A10 | Approval `pending` / run `WAITING_APPROVAL` | 零触碰（不 approve/reject/retry/expire） |
| A11 | Task `RUNNING` | 启动零改写；后续 drive 时 dead-attempt 语义（attempts 计数） |

## B. 失败策略与幂等

| # | 场景 | 关键断言 |
|---|---|---|
| B1 | store 枚举错误（注入） | fail startup closed：IPC/window 不暴露 |
| B2 | 恢复事件写入失败（注入） | 同上 |
| B3 | corrupt durable row / 非法转移（注入） | 同上 |
| B4 | 部分恢复（agent 成功 → tool 失败） | fail closed；agent interruption 不回滚 |
| B5 | second startup（新进程、残留已清） | 剩余状态继续收敛；report 反映新扫描 |
| B6 | 同一 orchestrator 实例二次调用 | 返回首次 report；0 new actions；零新事件（single-flight） |

## C. Crash Recovery E2E（T14-03）

| # | 场景 | 关键断言 |
|---|---|---|
| C1 | 全链 residue → 重启 → resumePoint → continue | run 到达终态；事件流含 crash/recovered |
| C2 | 已完成 Stage 不重跑 | steps/attempts/artifact 数不增（AC14.2 / T14.6） |
| C3 | EvidenceGate 恢复后仍强制 | 无证据 VALIDATION.PASS 仍拒（不绕 gate） |
| C4 | 事件可查（AC14.3） | EventStore 中 run.crash_detected / run.recovered 可回放 |
| C5 | 上下文保全 | run/task identity、snapshot、handoff/artifact refs 不变；不要求用户重述目标 |

## D. 依赖故障（T14-04，ADR-0022）

| # | 场景 | 关键断言 |
|---|---|---|
| D1 | API Error（注入 provider 失败） | attempt 终止 + durable 留痕；零后台重试 |
| D2 | Quota（LIMIT_EXCEEDED 注入） | 不自动重试；无 WAITING_QUOTA/RETRY_SCHEDULED 类状态 |
| D3 | 显式 continuation 后恢复 | 从既有 Run/Task context 继续；已完成工作不重复；用户零重述 |

## E. Tool Failure E2E（T14-05）

| # | 场景 | 关键断言 |
|---|---|---|
| E1 | INTERRUPTED + 人工 retryInvocation | run 继续；attempt 链递增；同根 idempotency |
| E2 | no duplicate side effect | 幂等命中/replayOutput 复用；副作用计数不增 |
| E3 | 非幂等工具 | 不可 retry（fail closed） |

## F. 边界 / 安全负例

| # | 场景 | 关键断言 |
|---|---|---|
| F1 | 恢复不得触发外部副作用 | provider/adapter 调用计数=0（A2/A6 强化） |
| F2 | WAITING_APPROVAL 版本漂移 | approve 仍 fail-closed（ADR-0019 回归） |
| F3 | renderer 无法触达 orchestrator | 无恢复 IPC op（白名单不含；结构锁） |
| F4 | ledger 缺席不推导实体不存在 | 恢复判定基于行/事件，不基于有界 ledger |

## G. 回归

全部既有套件只增不减（Sprint 13 收口基线 112 files / 1224 cases 为下限）；`pnpm check` 5×PASS；
`pnpm test:scripts` 全绿；docs guards（spec-traceability / docs-links / handoff / agents-md /
workspace-governance）全绿。
