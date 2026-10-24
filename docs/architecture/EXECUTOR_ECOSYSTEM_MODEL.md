# EXECUTOR ECOSYSTEM MODEL — frozen architecture design (V1, design-only)

> 状态：**架构设计冻结**——本文只定义边界与契约，不实现任何适配器/路由器。
> 基线 `1c536f3`。上位文档：`EXECUTION_CAPABILITY_MODEL.md`（能力/路由原则）、`NATIVE_EXECUTION_RUNTIME.md`（Native 边界）、`ROLE_MODEL.md`。
> 机械守护：ARCH-003/007/013（单一真相）、ARCH-037（外Provider≠权威+零厂牌入内环）、ARCH-038（推理≠执行）、ARCH-039（自然语言≠可执行体）。

---

## 1. CompanyOS Executor Philosophy

> **CompanyOS does not own intelligence. CompanyOS owns orchestration, truth, authority and outcome.**

智能（推理、探索、领域专长）永远来自外部能力——模型、原生操作、未来 agent、人。
CompanyOS 拥有的是让智能**可信地变成结果**的那一层：编排、真相、权威、结局。

### CompanyOS responsibilities（单一属主，永不外包）

| 职责 | 冻结属主 |
|---|---|
| Goal（意图） | run-owned canonical Artifact（lifecycle） |
| Planning（规划编排） | PlannerRuntime + T20-02 严格验证（模型只提案） |
| Task decomposition | PlanCompiler → 钉定 WorkflowVersion → materializer |
| Capability matching | 部署闭集 + 两段式路由（能力路由→提供者路由） |
| Authorization | authz / Decision / Approval / S25 六阶段预检 |
| Execution lifecycle | ExecutionAttempt + engine claim/settle 三事务时间线 |
| Validation | ValidationService + validatorIds（证据守卫） |
| Evidence | dispatch 行 / invocation / 批次（durable） |
| Artifact | ArtifactService + CAS（不可变内容寻址） |
| Handoff | HandoffService（唯一 durable 交接权威） |
| Outcome | canonical 结算 + Observation 投影 |

### External executor responsibilities（能力，非权威）

- reasoning（推理：模型/agent）
- tool usage（工具使用：agent 的受信操作）
- specialized execution（专项执行：服务/原生操作）
- domain expertise（领域专长：人工/专业服务）

**外部执行器永远不拥有**：Task/Run 状态、验证结论、工件权威、进度真相、任何 canonical 语义（§7 逐条冻结）。

---

## 2. Executor Taxonomy（四类）

### 2.1 Native Executor —— `native.process`（已实现）

- **Examples**: scripts（分析/清洗/codemod）、programs（构建/测试）、local processing（文件/数据变换）、deterministic APIs、deterministic tools。
- **Properties**: predictable（字面 argv+typed inputs）、bounded（timeout/输出界/取消树）、**no autonomous decision**。
- **Capabilities**: execute / transform / produce artifact。
- **NOT**: planning / deciding / changing workflow truth。
- **机制**: 受信部署操作表（taskKind→{executable, 字面 argv, 界}）+ Task.inputs 作 DATA；ARCH-039 禁自由文本→argv。

### 2.2 Agentic Executor —— INTERFACE ONLY（未实现，未来可选适配器）

- **Examples**: Codex、DeepSeek Harness (DSH)、ZCode、其他 agent runtime。
- **Properties**: autonomous reasoning / exploration / multi-step action。
- **Capabilities**: analyze / create solution / adapt。
- **Restrictions（冻结）**:
  - **Agent output is NOT canonical truth** —— 一切经引擎结算（provider 成功 ≠ Task 完成，S24 冻结）。
  - Agent cannot own: Task state、Run state、Validation result、Artifact authority。
  - Agent 会话语义 ≠ CompanyOS Session 真相（ADR-0030）。
  - 不确定外部结果 + 无幂等证明 = UNCERTAIN，零自动重放（S21/S24 冻结）。
- **集成形态**: 每个 agent = 一个 ExecutorProvider 适配器（§3 契约），经同一注册表/S25 预检/settlement 管线。

### 2.3 Service Executor —— 未来

- **Examples**: search、email、CRM、cloud API。
- **Properties**: 外部确定性/专业服务；有契约（API）、有边界（配额/权限）。
- **与 Native 的区别**: 副作用在外部系统而非本地工作区；凭证经 SecretRef；结果仍走 canonical 结算。

### 2.4 Human Executor —— 已实现（canonical 决策面）

- **Examples**: approval、decision、exception handling。
- **Properties**: 唯一拥有最终权威的"执行器"；经 Decision/Approval canonical 机制（EXPECTED_USER_AUTHORITY）。
- **Restrictions**: 只响应 typed 决策面，不做手工状态编辑（§7）。

---

## 3. Adapter Contract（设计，不实现）

未来任何执行器（含 agentic）以**一个 ExecutorProvider 适配器**进入，契约即现有冻结端口：

```
ExecutorProvider Adapter
├─ Input（来自 canonical 运行时，执行器不可选择/伪造）
│   ├─ Task（canonical 身份与不可变 inputs）
│   ├─ WorkPackage（有界投影：objective/taskInputs/criteria/依赖）
│   ├─ Capability requirement（requiredCapabilities ⊆ 声明闭集，协商前 fail-loud）
│   ├─ Workspace（S25 预检证明的 canonical cwd+root）
│   └─ Authority（S25 授权来源引用 + typed config 指纹）
├─ Output
│   ├─ ExecutionResult（typed outcome 六类：succeeded/provider-failed/
│   │     transport-failed/cancelled/timeout/uncertain）
│   ├─ Evidence（stdout/stderr 有界捕获 / 会话身份（如有，仅诊断））
│   ├─ Artifact references（候选——必须经既有 CAS/结算信封物化，非自动权威）
│   └─ Diagnostics（typed reasonCode，可审计）
└─ MUST NOT return
    ├─ fake Task state（状态由引擎唯一结算）
    ├─ fake success（malformed 结构化输出 = provider-failed）
    └─ workflow mutation（零 canonical 写权限——结构性：端口无写缝）
```

**适配器入职清单（反膨胀法，冻结）**：新增一个外部执行器正常只新增 适配器 + 类型化配置 + 能力描述符 + 适配器自有测试；零新 Task 模型/Workflow/Run truth/Artifact truth/Session truth/Authority/Validation 体系；厂牌逻辑只在外环。

---

## 4. 路由：Capability Matching Model（规则式，非智能）

两段式（EXECUTION_CAPABILITY_MODEL 冻结）+ MOST APPROPRIATE 序：

```
Goal → Plan（真实模型提案，含可选 per-item taskKind 请求·闭集验证）
     → Required Capability（钉定节点 taskProfile/能力需求）
     → Execution Class（Native / Agentic / Service / Human）
     → Available Executor（部署注册 + 可用性 + 策略）
     → Cost / Quality / Latency Policy（部署/用户策略优先）
```

示例：

| Task | Capability | Class → 选择 | 不选 |
|---|---|---|---|
| "转换 10000 条 CSV 记录" | data transformation | **Native**（毫秒级、确定、零成本） | Agent（杀鸡用牛刀且引入不确定性） |
| "重构支付架构" | software architecture reasoning | **Agentic**（Codex 类） | Native（无推理） |
| "手动操作 Photoshop" | desktop interaction | **Agentic**（ZCode 类 GUI 能力） | — |
| "批准超预算方案" | final authority | **Human**（canonical Approval） | 任何机器冒充 |

---

## 5. Smart Router 边界（不实现）

- **V1（现在）**: Rule-based —— 钉定能力需求 × 部署闭集 × 显式策略（`providerRoutes`/`COMPANYOS_EXECUTOR_PROVIDER`/MANUAL 模型选择）。已实现。
- **V2+**: Adaptive routing —— 因子：cost、latency、historical success、capability score、reliability。**仅演进记录，不建。**
- 永不：默认多 provider 锦标赛/投票（太贵，非 CompanyOS 政策）；学习型 governor（V1 后再议）。

---

## 6. Second-Truth Protection（架构规则，冻结）

外部 Agent（或任何执行器）**MUST NOT** 创建：

- ❌ Task system（Task 唯一属主=engine/materializer）
- ❌ Workflow system（钉定 WorkflowVersion 唯一）
- ❌ Artifact system（CAS+ArtifactService 唯一）
- ❌ Memory authority（Memory 服务唯一；agent 会话仅上下文）
- ❌ Progress authority（进度=canonical Task/Attempt 状态投影，非 agent 自报）

**CompanyOS remains the single source of truth。** 机械保障：执行器端口零 canonical 写缝（结构性）；agent 产物只作为结算信封载荷进入；验证结论只来自 validatorIds 证据链。

---

## 7. Anti-Bloat Review（§8 检查，逐项）

| 检查 | 本设计 |
|---|---|
| Second workflow? | **NO**（零新工作流；一切经钉定版本） |
| Second task system? | **NO** |
| Vendor dependency? | **NO**（厂牌只出现在外环适配器与部署数据；Core/Engine 零厂牌=ARCH-037） |
| Prompt-based hidden logic? | **NO**（提示只描述契约；规则在 schema/验证器/闭集） |
| New execution truth? | **NO**（结算唯一=引擎） |
| 第二能力/会话/内存权威？ | **NO** |

---

## 8. 当前态与结论

- Native: **READY**（`native.process` 生产就绪：超时双保险+多操作路由）。
- Model: **READY**（OpenAI 兼容适配器，实况 5/5+3/3）。
- Agentic: **INTERFACE ONLY**（契约即本模型 §3；零实现；DSH=OPTIONAL_PROVIDER_UNAVAILABLE_AUTH）。
- **CompanyOS can operate without any single vendor** —— 移除任一/全部外部 agent，产品语义、真相与原生执行完好（已证：三项目 Bug Bash 设计全原生 ELIGIBLE）。
