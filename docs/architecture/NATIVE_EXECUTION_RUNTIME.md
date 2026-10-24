# NATIVE EXECUTION RUNTIME — boundary freeze (§23/§24)

## 1. createProcessExecutorProvider 只读侦察（源码为准）

| 问题 | 答案（源码实证） |
|---|---|
| 消费什么输入 | `ExecutorExecutionRequest`（携带 canonical attempt 身份：attemptId/dispatchKey/taskText/workspace/timeoutMs/signal） |
| 什么语义载荷到达 | Work Package 投影文本（`workPackageTextOf`→taskText）；**不含自由 argv** |
| executable 路径归谁 | 适配器配置（`config.executable`，绝对路径）——**绝不来自模型输出** |
| argv 归谁 | 适配器（`baseArgv`+`buildArgs(request)`）；从 canonical 任务内容只能派生**文本参数**（如 taskText），不能派生可执行/新旗标 |
| cwd 归谁 | 请求的工作区（经 Sprint25 预检分量边界校验）或声明的 fail-closed fallback |
| argv 可否安全派生自 canonical Task 内容 | 仅作为**数据参数**（S24 冻结语义） |
| stdin | 支持（capabilities 声明） |
| 结构化 stdout | 支持（`parseResult` 钩子；malformed 不结算成功 §32） |
| 取消 | AbortSignal → kill-tree（REQUEST 非证明；退出证据才是） |
| stdout/stderr 有界 | 8MiB 上限 + OUTPUT_LIMIT 终止 |
| shell:false | 是（无 shell 语法可达） |
| 工作区/预检集成 | provider-dispatch 编排（claim COMMIT 后、六阶段预检、副作用前） |
| Artifact/Evidence 集成 | 经引擎结算信封（无第二真相） |
| canonical 结算集成 | 事务 B 由引擎执行（provider 在写事务外） |

**分类：PROVIDER_HELPER_ONLY（今日）** —— 它是引擎内供**适配器复用**的通用进程机制（dsh 适配器即建于其上）：不可被路由（无部署注册的 providerKey）、无自有 providerKey 生命周期。成为 NATIVE_FOUNDATION 只差一个薄壳注册（类型化配置+providerKey+能力描述符）——**本任务不实施**（§23 明令）。

## 2. Native 边界（§24 冻结）

**Native Runtime ≠ Agentic Executor。** Native = CompanyOS 自有的**确定性**执行能力；开放自主多步 = AGENTIC 类外部适配器（可选，永不强制）。

未来可拥有（概念，不现在全建）：Process / Files / Git（读）/ HTTP / Data / 未来 Browser。

## 3. Native 能做 / 不能做的真实工作类别

| 能做（确定性） | 需要 agentic 推理 |
|---|---|
| 跑测试/构建/脚本；文件读写/转换；git 状态/差异（读）；HTTP 抓取与 API 调用（既定契约）；数据清洗/统计 | 研究并撰写内容；开放式调试与代码修改决策；跨步骤自主规划；模糊需求的澄清与取舍 |

**裁定**：Bug Bash 中“机械可定义”的工作项可由未来 native 适配器执行；“内容/研究”类实质仍需 agentic 执行器（或模型推理直接产出的明确产品语义）。
