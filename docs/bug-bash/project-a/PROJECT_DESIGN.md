# PROJECT A DESIGN — 团队知识库标签规范化与统计管线（非软件）

## Project ID
`bugbash-a-kb-normalization`

## Domain
非软件 / 运营数据与文档处理（知识管理运维）。

## Real Goal
将团队知识库导出的 40 条混乱条目（中英混排、标签大小写不一、重复标签、空行、字段缺失）清洗为规范数据集，产出：①规范化条目集（标准标签词汇表约束）；②标签使用统计报告（真实派生数据）；③可直接使用的汇总文档。

## Why It Is Real
任何以笔记/工单/文档为中心的团队都持续面对标签腐化（`Python`/`python`/`PYTHON` 三重标签）。本项目的输出（规范词汇表+统计+清洗数据）是真实运营资产，执行后可直接服务内容治理决策。规模（40 条 × 多字段变换 × 词汇表收敛 × 统计）远超演示级。

## Real User Value
- 一份机器可用的规范条目集（后续检索/分析的地基）
- 标签频率报告（识别应合并/废弃的标签）
- 治理建议文档（基于真实统计，非编造）

## Input Assets（真实输入，执行前由操作员放置于受信工作区）
- `kb-export.jsonl`：40 条真实形态条目（标题/正文摘要/标签数组/作者/日期），含故意保留的真实脏数据形态（空标签数组、同义异拼、空白、缺日期）

## Expected Outcome
- `kb-normalized.jsonl`（40 条，全部通过词汇表校验）
- `tag-stats.json`（每标签频次+合并建议，真实派生）
- `report.md`（人类可读治理报告）
- 三者均为 canonical Artifacts（既有 CAS 机制）

## Required Roles
Planner（真实模型）→ Supervisor（真实模型）→ `rol.worker`（native 执行）。无软件角色依赖。

## Required Capabilities
timeout / working-directory / structured-output（native.process 诚实集）。

## Execution Class per Task
全部 NATIVE（确定性数据处理操作）。

## Native Operation Mapping（部署声明，字面 argv）
| taskKind | 操作 | 输入（typed Task/管线数据） |
|---|---|---|
| `native.op.normalize` | 词汇表收敛+字段清洗（node 确定性脚本） | kb-export.jsonl → kb-normalized.jsonl |
| `native.op.stats` | 标签频次统计+合并检测 | kb-normalized.jsonl → tag-stats.json |
| `native.op.report` | 汇总文档生成（模板化，零创作） | tag-stats.json → report.md |

多操作经 **per-item taskKind 提案 + 部署闭集验证**（本任务新增的通用生产能力）。

## Model Participation
真实 StepFun 后端（已证 5/5 规划）：从本 Goal 文本派生三阶段计划（含依赖顺序与验收标准）；监督轮真实推理。模型**零**写文件/执行命令——只提案与监督。

## Validation Strategy
计划层：T20-02 严格验证（验收标准≥1/项）。执行层：normalize 操作内置断言（输出 40 条、零未收敛标签、词汇表闭集）——任何断言失败即真实 Finding。报告层：stats 与 report 数字一致性由 report 脚本自查（失败=exit 1=诚实失败）。

## Artifact/Evidence Strategy
每任务产出经既有 `companyos:executor-output` CAS 工件；dispatch 行+attempt 持久；观察读回核对。

## Decision/Approval Point
设计：normalize 完成后、stats 开始前设置一个**真实产品语义的审批等待**——若 normalize 报告了丢弃条目数 > 0，主管升级为人工确认（EXPECTED_USER_AUTHORITY）。若零丢弃则自然通过（不制造决策）。

## Restart Point
在 `native.op.stats` 执行前（非终态：任务 1 DONE、任务 2 PENDING）重启运行时——恢复后 durable 身份不变、无重复工作、控制平面重建如实。

## Handoff Definition
全链完成后经既有 HandoffService 创建 canonical packet（内容=真实产物引用+统计摘要），观察可读。

## Forbidden Shortcuts
无预置答案脚本；无手工 SQLite；无 AI 中继；无 renderer 权威；自由文本→argv 禁止（ARCH-039）；不为凑覆盖制造 Finding/决策。

## PASS Criteria
Goal canonical；Plan 真实派生；版本钉定；三任务真实执行（真实进程真实文件）；工件真实且互相一致；验证如实（通过或真实失败+如实呈现）；重启/决策（若自然发生）证据齐全；交接真实；零 PRODUCT_WORKAROUND / INTERNAL_DEBUG_INTERVENTION。
