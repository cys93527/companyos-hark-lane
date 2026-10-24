# Open Model Research & Benchmark（Sprint 7.5）

> 本 Sprint 的产出是**研究结论 + 基准方法 + 元数据契约**，而**不是** Router。
> 所有分数只作为 **Model Performance Metadata**：用于展示、选型讨论与后续 ADR，**绝不参与自动决策**
> （`tests/sprint7-5/selection-policy.test.ts` 的 R 组做结构性保证）。

## 1. 方法与诚实声明

- 本轮**没有**真实适配器、**没有**网络调用、**没有**在本进程内跑模型：下表的规格来自公开资料，
  标注为 `public`；凡是无法从公开资料确证的一律写 `unverified`，不猜测；
- 真正可比较的分数必须由 **Benchmark Harness** 跑出来（§3），结果落到 `benchmark_results` 表，
  `source='harness'`（外部报告记 `source='external'`，UI 必须标注"未验证"）；
- 规格会过期：每个条目都应带 `asOf` 日期，过期即重新研究（尚未自动提醒，记入限制）。

## 2. 研究对象（覆盖用户要求的全部类别）

> 列：Model｜Provider/Source｜License｜Params｜Ctx｜MaxOut｜Tool｜JSON｜Vision｜Reasoning｜Coding｜
> CodeReview｜Chinese｜LongCtx｜InstrFollow｜Latency｜VRAM｜RAM｜Quant｜Ollama｜llama.cpp｜vLLM｜Cloud｜
> API Cost｜8GB fit｜Known Weakness｜Recommended Role
> 说明：`yes/no/partial` 为能力判断；延迟/显存/内存为**量级**（`small/mid/large`），非实测数字。

| Model | Source | License | Params | Ctx | Tool | JSON | Vision | Reason | Coding | CN | LongCtx | Latency | VRAM | Quant | Ollama | llama.cpp | vLLM | Cloud | Cost | 8GB fit | Weakness | Role |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| DeepSeek-V3 系列（开放权重） | DeepSeek | 开放权重许可（须复核） | 600B+ MoE | 64K+ | yes | yes | no | yes | strong | yes | yes | large | very large | yes(4bit) | partial | partial | yes | yes | paid API | no | 自托管成本高、显存门槛极高 | 高能力推理/编码主力（云） |
| DeepSeek-R1 系列（推理） | DeepSeek | 开放权重许可（须复核） | 数十B–600B | 64K+ | partial | partial | no | strong | strong | yes | partial | large | very large | yes | partial | partial | yes | yes | paid API | no | 思维链冗长、成本高 | 架构/难题推理（人工指定） |
| DeepSeek 蒸馏小模型（7B/8B 级） | DeepSeek | 开放权重 | 7–8B | 32K+ | partial | partial | no | good | good | yes | partial | small | ~5–6GB(4bit) | yes | yes | yes | yes | yes | 低（云） | **yes** | 复杂架构弱 | 本地默认执行者（8GB 档） |
| Qwen2.5/3 系列（7B/14B/32B/72B） | Alibaba | Apache-2.0（多数）/ 部分自有 | 7–72B | 32K–128K | yes | yes | partial(有 VL 变体) | good | strong | yes | yes | small–mid | 5GB–40GB+ | yes | yes | yes | yes | yes | 低–中 | 7B 档 yes | 大参数档 8GB 不fit | 通用主力 + 中文 + 工具调用 |
| Qwen2.5-Coder 系列 | Alibaba | Apache-2.0 | 1.5B–32B | 32K–128K | yes | yes | no | mid | strong | good | yes | small–mid | 3–24GB | yes | yes | yes | yes | yes | 低 | 7B 档 yes | 长上下文档显存吃紧 | 编码/重构/单测 |
| Llama 3.x 系列（8B/70B/405B） | Meta | Llama 社区许可 | 8–405B | 8K–128K | yes | partial | no | good | good | partial | partial | small–large | 6GB–200GB+ | yes | yes | yes | yes | yes | 低–中 | 8B 4bit yes | 中文与结构化输出略弱 | 通用备选（英文优先） |
| Mistral / Mixtral 系列 | Mistral AI | Apache-2.0（多数） | 7B–8x22B | 32K–128K | yes | yes | no | good | good | partial | yes | small–large | 6GB–100GB+ | yes | yes | yes | yes | yes | 低–中 | Mixtral 不fit | 中文偏弱 | 结构化输出/函数调用 |
| Kimi 开放模型（K2 等） | Moonshot | 开放权重（须复核） | 大（MoE） | 128K+ | yes | partial | no | strong | good | yes | yes | large | very large | yes | partial | partial | partial | yes | paid API | no | 自托管门槛极高 | 长上下文/中文研究（云） |
| 编码专用（Coder 类，如 Qwen-Coder / Codestral 系） | 各开源方 | 多为 Apache-2.0 | 1.5B–32B | 32K–256K | yes/partial | yes | no | mid | strong | good | yes | small–mid | 3–24GB | yes | partial | partial | yes | yes | 低 | 7B 档 yes | 通用对话与推理弱 | 编码/审查（人工指定） |
| 工具调用强（Qwen / Mistral / Llama 的 instruct 变体） | 各开源方 | Apache-2.0 / 社区 | 7B–72B | 32K–128K | **yes** | yes | no | good | good | partial | partial | small–mid | 5–40GB | yes | yes | yes | yes | yes | 低 | 7B 档 yes | 严格 schema 下偶发多余字段 | Agent 工具调用执行者 |
| 结构化输出强（Mistral / Qwen / Llama 的 JSON 训练变体） | 各开源方 | Apache-2.0 / 社区 | 7B–32B | 32K–128K | yes | **yes** | no | mid | good | partial | partial | small–mid | 5–20GB | yes | yes | yes | yes | yes | 低 | 7B 档 yes | 长 JSON 偶发截断 | 表单/契约输出 |
| 本地可部署小模型（3B–8B 通用） | 多方开源 | Apache-2.0 / MIT 系 | 3–8B | 8K–128K | partial | partial | partial | mid | mid | partial | partial | **small** | **3–6GB** | yes | yes | yes | yes | yes | **0（本地）** | **yes** | 复杂推理弱 | 8GB 显卡本地草稿/分类 |
| 长上下文专用（128K+ 开放模型） | 多方开源 | Apache-2.0 / 社区 | 7B–72B | **128K–1M** | partial | partial | no | mid | mid | partial | **yes** | mid–large | 8–64GB | yes | partial | partial | yes | yes | 低–中 | 不fit（除量化小模型） | KV cache 吃显存、注意力退化 | 长文档摘要/检索 |
| 视觉多模态（Qwen-VL / Llama-Vision 系） | 多方开源 | Apache-2.0 / 社区 | 7B–72B | 32K–128K | partial | partial | **yes** | mid | mid | yes | partial | mid | 8–48GB | yes | partial | partial | yes | yes | 困难（小 VL 可试） | 图像细节与版面理解不稳 | 截图/图表理解（人工指定） |

**角色建议（供人参考，不自动执行）**：本地 8GB 档 —— 小参数通用/编码模型；云端主力 —— 高能力通用 + 推理；
审查/架构 —— 人工指定高能力模型；工具调用/结构化 —— 选**该能力最强且显存可承受**的型号。

## 3. Benchmark Harness（统一、可复现、无 LLM-as-judge）

- `BenchmarkSuite` = 一组 `BenchmarkCase`，每例含 `category` + `prompt` + **可判定的期望**
  （`contains` / `not_contains` / `regex` / `json_keys` / `manual`），因此**评分是确定性的**，
  不需要"让另一个模型打分"（那会引入不可复现的判断）；
- 14 个类别（A–N）：`CODING`、`BUG_FIX`、`REFACTOR`、`ARCHITECTURE`、`REVIEW`、`REASONING`、`CHINESE`、
  `TOOL_CALLING`、`STRUCTURED_OUTPUT`、`LONG_CONTEXT`、`INSTRUCTION_FOLLOWING`、`LATENCY`、`COST`、
  `LOCAL_DEPLOYMENT`；
- 结果 `BenchmarkResult { modelKey, suiteId, caseId, category, score(0..1|null), measuredValue, source, recordedAt }`；
  `score=null` 用于"测量了但未评分"（延迟/成本样本）；
- 聚合 `summarizePerformance()` 产出 `ModelPerformanceMetadata`（按类均值 + 无权重总均值 + 样本数 + 来源），
  **不打分排序、不标记"最佳"**；
- 运行方式：`selectionPolicyService.recordBenchmarkResults(results, actor)`（授权 `model.write` + 审计事件
  `benchmark.result_recorded`）。真实跑分需要适配器（用户批准后），本轮不跑。

## 4. 本轮结论（可执行的决策建议）

1. **本地 8GB 档**：只放小参数通用/编码模型（3B–8B，4bit 量化），承担草稿、分类、单测补全；
   不要指望它做架构级推理。
2. **云端主力**：高能力通用 + 推理模型（成本与上下文更优），承担架构、审查与长上下文任务；
3. **能力分工**：工具调用与结构化输出必须按 `capabilities` 显式声明**选型**，不能靠"大模型就行"；
4. **中文与长上下文**：默认用中文强的开放模型；长上下文要按 KV cache 实测显存，不能只看标称窗口；
5. **一切分数只是元数据**：任何"按分数自动选"都必须先立 Router ADR（评分口径、失败语义、成本/延迟权重），
   当前**被禁止**。

## 5. 已知限制

- 规格来自公开资料（`public`），未在本进程验证；标注 `unverified` 的字段必须复核后才能写入注册表；
- 没有真实适配器 ⇒ `benchmark_results` 目前为空（表与 Harness 已就绪，等待批准后跑分）；
- 显存/内存/延迟为量级估计，不与具体量化方案、批大小、KV cache 配置绑定；
- 许可条款会变，接入前必须逐条复核（尤其"开放权重"≠"OSI 开源"）。
