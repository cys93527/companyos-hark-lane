# PROJECT B DESIGN — 孤立仓库的确定性代码迁移（真实软件工程）

## Project ID
`bugbash-b-codemod-migration`

## Domain
软件工程 / 确定性源代码迁移（codemod + 测试验证）。

## Real Goal
对孤立 git 仓库 `legacy-utils`（真实提交历史的真实 Node 工具库）执行一次**合法可复用的工程迁移**：将废弃的 CommonJS 工具模块迁移到新的命名空间导出 API（迁移映射表驱动），同步更新全部引用点，跑通真实测试套件，产出迁移报告与 diff 证据。

## Why It Is Real
命名空间化/去废弃 API 是每个长期维护代码库的真实重复性工程负担。本迁移是**真实可复用的确定性变换**（映射表驱动 codemod——正是工业界 jscodeshift 类工具的工作方式），非一次性演示：换一份映射表即可服务下一个仓库。

## Real User Value
- 迁移后的仓库（测试全绿）
- 迁移映射表（可复用资产）
- 迁移报告：改动点数/残留引用数/测试结果（真实证据）

## Input Assets
- 孤立仓库 `legacy-utils`（操作员预先创建：3 个 CJS 模块、6 个引用点、12 个真实测试用例、含 2 个迁移前就失败的用例作为真实基线——不伪装全绿）
- `migration-map.json`（旧 API→新 API 确定性映射，受信部署数据）

## Expected Outcome
- 源码真实变更（git diff 可证）
- 测试真实执行（迁移用例转绿；基线失败用例保持失败并如实报告——迁移不修复无关缺陷）
- canonical Artifacts：codemod 报告、测试输出、迁移 diff

## Required Roles
Planner（真实模型）→ Supervisor（真实模型）→ `rol.worker`（native）。

## Required Capabilities
timeout / working-directory / structured-output。

## Execution Class per Task
全部 NATIVE（确定性工程操作）。

## Native Operation Mapping
| taskKind | 操作 | 说明 |
|---|---|---|
| `native.op.codemod` | 映射表驱动源迁移 | 解析-替换-校验零残留；输出变更清单 |
| `native.op.test` | 真实测试运行 | `node --test`；通过/失败如实；报告 JSON |
| `native.op.diffreport` | git diff 证据捕获 | 真实 git 只读命令产出 diff 工件 |

## Substantive Source Change（§7 门槛）
是——codemod 产生**真实源码转换**（6 个引用点重写 + 模块导出重构），git diff 实证。非"仅跑测试"。

## Is Transformation Legitimately Reusable
**YES**——映射表驱动的 API 迁移 codemod：输入换映射表即服务任意同类迁移，是标准工程实践（非 Bug Bash 专用答案脚本）。

## Bug-Bash-Only Answer Script
**NO**——脚本只含通用变换逻辑（AST 级映射替换），不含本仓库的目标输出；映射表是声明式数据。

## Model Participation
真实模型规划（目标→三阶段计划：迁移→验证→取证）+ 真实监督。模型不写源文件、不生成命令——`native.op.codemod` 的 argv 来自部署操作表字面量，数据参数仅为文件路径（ARCH-039）。

## Validation Strategy
codemod 内置断言（零未映射残留、引用点计数匹配）；test 操作输出真实通过/失败计数（预期：迁移相关用例全绿、2 个基线失败用例保持失败——若 codemod 意外"修复"它们反而是可疑信号，如实记录）；diffreport 与 codemod 变更清单一致性校验。

## Artifact/Evidence Strategy
三产物全部经既有 CAS 工件化 + dispatch/attempt 持久 + 观察读回。

## Decision/Approval Point
若测试出现**迁移引入的**新失败（非基线失败）：主管升级人工裁定回滚或修正映射（EXPECTED_USER_AUTHORITY，若真实发生）；零失败则自然通过。

## Restart Point
codemod 完成后、test 执行前（非终态）重启——恢复后不重复迁移（attempt 权威）、测试照常。

## Handoff Definition
迁移报告+diff 工件经 HandoffService canonical packet 交接。

## Forbidden Shortcuts
预置答案脚本；手工改源；手工标记测试通过；改 git 历史；制造失败凑决策。

## PASS Criteria
真实源变更（diff 证实）；测试真实执行且如实（基线失败如实保留）；工件一致；零 workaround；模型零执行权威。

## PROJECT_B_REQUIRES_AGENTIC_EXECUTOR = NO（本设计成立性声明）
确定性映射迁移是合法可复用工程操作（工业标准实践）。若 Boss 认为本项目未达"软件工程"原意（如需要开放式调试/设计判断），则该判断本身即为 agentic 需求——如实上报，不弱化门槛。
