# Workflow 绩效系统

> 依据：规划书 §十二（Workflow Performance System）、§十三（Workflow 优化机制）、
> §十四（Workflow Evolution）、§六十四（长期自学习体系）。
> 代码事实来源：`packages/core/src/lifecycle/metrics.ts`（只读投影，永不反写 Workflow 状态）。

## 指标清单

规划书 §十二 要求每个 Workflow Template 至少持续记录 14 项指标。下表的「口径」列与 `metrics.ts`
的公式一一对应（`round4` 表示四舍五入到 4 位小数以保持 diff 稳定）。

| # | 指标 | 口径 / 实现 |
|---|---|---|
| 1 | 运行次数 | `runCount` = 样本数 |
| 2 | 成功率 | `successRate = succeeded / (succeeded + failed + cancelled)` |
| 3 | 失败率 | `failed / (succeeded + failed + cancelled)` |
| 4 | 平均完成时间 | `p50DurationMs`（最近秩百分位，样本为各 Run 的 `durationMs`） |
| 5 | 平均成本 | `totalCostUsd / runCount`（成本来自 Cost Engine，Sprint 27） |
| 6 | 平均 Token | `tokensIn`、`tokensOut` 汇总后除以 `runCount` |
| 7 | 平均返工次数 | 返工轮次总量 / `runCount`（返工由 Sprint 22 产生并计数） |
| 8 | 人工介入率 | `humanInterventions / runCount`（审批、人工纠偏、人工交付确认） |
| 9 | 最容易失败的 Stage | `nodeFailureRates` 中失败率最高的节点（并列时按 id 排序，保证确定性） |
| 10 | 最慢 Stage | 按节点累计 `durationMs` 取最大 |
| 11 | 最贵 Stage | 按节点的 token/成本分摊取最大（分摊口径见下） |
| 12 | 常用模型 | `providerId/modelId` → 调用次数直方图 |
| 13 | Reviewer 退回率 | `reviewReturnCount / runCount`（`REQUEST_CHANGES` 次数） |
| 14 | 最终用户满意度 | `satisfactionScore`（用户在交付后评分；未评分时为 `null`，不得伪造） |

补充口径（实现中的固定选择，避免跨机器差异）：

- **百分位**采用「最近秩」而非线性插值：`rank = ceil(p/100 × n)`，`p50`/`p95` 因此是样本中的真实值；
- **成本分摊**：以节点为单位累计 token，再按 Provider 单价换算；无法归属的公共开销记入 Run 级而非某个 Stage；
- **样本约束**：`computeWorkflowMetrics` 拒绝混合其它版本的样本（返回 `VALIDATION_FAILED`），
  因此指标永远属于**某一个确定版本**；
- **只读性**：指标是投影。任何写入指标的行为都不得改变 Workflow / Run 状态。

## 汇总口径

- **粒度**：`(workflowVersionId, window)`。窗口 `MetricsWindow { from, to }` 显式记录，避免“上周到底算几天”的歧义。
- **时间语义**：默认按 `startedAt` 落入窗口；跨窗口的长 Run 记入**开始时间**所在窗口，并在下一次汇总时以完成态覆盖该样本。
- **空窗口**：`emptyMetrics()` 返回全 0 且 `successRate = 0`，用于版本尚未运行时的 UI 展示（不返回 `null` 以免调用方分支爆炸）。
- **确定性**：所有 `Record` 键按字典序输出；所有比值 `round4`；同一批样本在任何机器上得到相同结果。
- **可追溯**：每个指标可下钻到产生它的 Run 与 Event（规划书 §四十三 / §四十四）。

## Workflow 优化机制

Chief 不应只凭主观感觉修改 SOP，而应结合历史数据（规划书 §十三）。规划书给出的对照示例：

| Workflow | 成功率 | 平均成本 | 平均返工 |
|---|---|---|---|
| A | 96% | $2.80 | 0.4 次 |
| B | 89% | $1.10 | 1.8 次 |

系统据此按业务目标选择 **质量优先 / 成本优先 / 速度优先**。对应当前实现的
`scoreForBias(metrics, 'quality' | 'cost' | 'speed')`：

- `quality`：成功率 ×（1 − 人工介入率）——既要跑通，也不要总是麻烦老板；
- `cost`：`1 / (1 + 平均成本)`——成本越低分越高；
- `speed`：`1 / (1 + p50 耗时/分钟)`——越快分越高。

注意：`scoreForBias` 只是**建议排序**，不构成自动切换 SOP 的授权。切换必须走 Change Proposal。

## Workflow Evolution（规划书 §十四）

闭环：

```
执行 → 记录 → 分析 → 发现瓶颈 → Chief 建议优化 → Change Proposal
     → Draft 新版本 → A/B 或小范围测试 → Publish
```

硬性约束：

1. 优化**不得**原地修改已发布版本（`WORKFLOW_VERSIONING.md` §Deprecate 与 Archive）；
2. 新版本必须带 `changeProposalId` 以保留“为什么改”的证据链；
3. 优化前后必须可比较：同一 `(version, window)` 口径下的成功率/成本/返工/人工介入率；
4. 只有经过真实 Run 验证的改进才允许发布为 Template 新版本；
5. 最终目标（规划书 §十四）：**SOP 本身会越来越成熟**。

## 长期自学习体系（规划书 §六十四）

每次任务记录：Industry、Workflow、Version、Role、Model、Task Type、Complexity、Risk、Success、
Review、Validation、Rework Count、Cost、Latency、User Result。逐步形成：

- **Model Performance Graph**：哪种任务适合哪个模型；
- **Workflow Performance Graph**：哪套 SOP 最稳定、哪个 Stage 最容易出问题、哪套 SOP 性价比最高。

这两张图同时服务 Model Router（Sprint 10）的排序输入与 Chief 的优化建议（Sprint 28），
是「历史绩效数据 → 更好的调度与更成熟的 SOP」这一正反馈的唯一来源。
