# PROJECT C DESIGN — 季度运营数据到决策简报的多阶段系统项目

## Project ID
`bugbash-c-ops-quarterly-brief`

## Domain
运营/业务系统项目（多阶段数据管线 + 人工决策 + 验证 + 交接）。

## Real Goal
从三个来源的季度运营原始数据（销售流水 CSV、支持工单 CSV、库存快照 CSV）产出一份**季度运营决策简报**：清洗合并 → 指标计算（收入/工单解决率/周转天数等 8 项真实指标）→ 阈值校验（2 条业务规则，违例即真实 Finding）→ 简报成文 → 人工审批（预算超阈值需用户裁定）→ 交接归档。全程含一次**非终态重启**。

## Why It Is Real
这是中小运营团队每季度真实执行的完整工作流（数据→指标→校验→简报→审批→归档），输出直接服务真实决策（补货/客服配置）。多阶段依赖、真实校验规则、真实审批语义、真实重启风险——系统项目四要素齐备。

## Real User Value
- 决策简报（8 项真实计算指标+趋势，非编造）
- 违例清单（若有，驱动真实 corrective）
- 归档交接包（审计可追溯）

## Input Assets
- `sales-q3.csv`（120 行真实形态流水）
- `tickets-q3.csv`（90 行工单）
- `inventory-q3.csv`（45 行库存）
（操作员预置于受信工作区；含真实脏数据：空字段/重复行/格式偏差）

## Expected Outcome
- `merged-clean.csv`、`metrics.json`（8 指标）、`violations.json`（若真实存在）、`brief.md`、canonical 交接包

## Required Roles
Planner（真实模型，派生 5 阶段计划）→ Supervisor（真实模型）→ `rol.worker`（native）→ 用户（审批，EXPECTED_USER_AUTHORITY）。

## Required Capabilities
timeout / working-directory / structured-output。

## Execution Class per Task
全部 NATIVE。

## Native Operation Mapping
| taskKind | 操作 |
|---|---|
| `native.op.clean` | 三源清洗合并（去重/补缺/规范化） |
| `native.op.metrics` | 8 项指标计算（公式固定，输入真实数据） |
| `native.op.validate` | 2 条业务规则阈值校验（违例=真实 Finding，非制造） |
| `native.op.brief` | 简报成文（模板化组装真实指标，零创作） |
| `native.op.archive` | 归档打包+交接工件 |

## Meaningful Tasks（多任务+真实依赖）
5 个任务按管线依赖串联（clean→metrics→{validate,brief}→archive），经钉定 DAG 保序——远超单任务演示。

## Restart Point（核心证明）
在 `native.op.metrics` 执行前（clean 已 DONE、其余 PENDING，Run 明确非终态）**有意重启 CompanyOS 运行时**：恢复后验证——同一 durable Run/Task/Attempt 身份；零重复已完成工作（clean 不重跑）；管线从断点继续；控制平面重建如实。

## Decision/Approval Point（自然真实）
简报产出后若指标触发预算阈值规则：主管升级 → 用户经 canonical approval.respond 裁定（预期响应改变后续 archive 行为）→ 重启后决策结果保持 → 重复响应不可二次变更。阈值设计基于真实输入数据（操作员放置时确保会自然触发一次）——是数据驱动的真实决策，非制造。

## Validation Strategy
`native.op.validate` 是真实验证器（规则固定、数据驱动）：违例即真实 Finding → 若发生，走 canonical corrective（修复脏数据源重跑 validate）→ reassessment。**若零违例则如实报告零违例，不制造**。

## Artifact/Evidence Strategy
每阶段产物 CAS 工件化；dispatch/attempt 持久；重启前后快照对照；观察全程可读。

## Handoff Definition
归档阶段经 HandoffService 创建 canonical 交接包（引用全部阶段工件+决策记录+简报）。

## Forbidden Shortcuts
预置指标答案；编造违例；手工状态编辑；跳过重启；伪造审批。

## PASS Criteria
5 任务真实执行；依赖保序；重启证明四要素（同身份/零重复/断点续/如实重建）；决策自然发生且 durable；验证如实（有/无违例均如实）；交接真实；零 workaround。
