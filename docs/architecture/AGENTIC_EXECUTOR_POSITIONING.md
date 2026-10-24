# AGENTIC EXECUTOR POSITIONING — frozen positioning design (V1, design-only)

> 状态：**定位设计冻结**——不连接、不实现、不排障任何 agent。均记录为 OPTIONAL_AGENTIC_EXECUTOR_CANDIDATE。
> 基线 `1c536f3`。上位：`EXECUTOR_ECOSYSTEM_MODEL.md`（适配器契约+第二真相保护）。评估基于本机实证侦察（S24 recon + Live Capability Selection Gate）与公开形态，不夸大。

---

## Codex

- **Strength**: software engineering / repository reasoning / code modification（repo 内多文件推理与编辑）。
- **Suitable tasks**: refactoring（跨模块重构）、debugging（失败定位）、implementation（新功能落地）。
- **Unsuitable**: deterministic batch processing（确定性批处理——Native 毫秒级完成，用 agent 是纯浪费+不确定性）；无需推理的数据变换。
- **本机现状**: 未安装（`E:\Codex` 仅 Store 安装器；PATH 无 codex CLI）。
- **集成定位**: 未来一个 ExecutorProvider 适配器（CLI/API headless 面）；适合 Project-B 类"开放式软件工程"工作；与 Native codemod 互补——**确定性迁移用 Native，开放式调试/设计用 agentic**。

## DeepSeek Harness (DSH)

- **Strength**: general agent execution / lower cost reasoning / automation（通用 agent 执行，成本较低，headless NDJSON 契约完整：会话身份+续作）。
- **Suitable tasks**: research（调研整理）、documentation（文档撰写）、general workflows（通用多步流程）。
- **Unsuitable**: 高精度确定性变换（Native 更快更稳）；需要 GUI 的场景。
- **本机现状**: 已装（0.1.6-max）且 CompanyOS 适配器已实现并实证（S24 冻结时真实集成+§17 生产链 3/3）；**当前 OPTIONAL_PROVIDER_UNAVAILABLE_AUTH**（外部账户凭证失效，未排障 per Boss 令）。
- **集成定位**: 已有一个适配器（`dsh-headless`），auth 恢复即活；开放式内容/研究类工作的最现成候选。

## ZCode

- **Strength**: desktop interaction / GUI operation（桌面与图形界面操作）。
- **Suitable tasks**: applications without API（无 API 的应用自动化）、visual workflows（视觉流程）。
- **Unsuitable**: headless 批处理；文本/代码推理深度任务。
- **本机现状**: GUI 应用（`D:\zcode` = ZCode.exe + app.asar）；**无 CLI、无文档化稳定自动化面**（S24 契约排除 + 本机复查）。
- **集成定位**: 需先存在稳定自动化接口（CLI/协议）才可能成为适配器；在此之前仅是候选记录。

---

## 共同约束（对所有 agentic 候选，冻结）

1. 以 EXECUTOR_ECOSYSTEM_MODEL §3 适配器契约进入——同一注册表/预检/结算管线，零特殊路径。
2. Agent 输出非 canonical 真相；不拥有 Task/Run/验证/工件权威。
3. 会话语义 ≠ CompanyOS Session；不确定结果零自动重放。
4. 反膨胀：入职只加 适配器+配置+描述符+测试。
5. **无任一 agent，CompanyOS 完整运转**（三项目 Bug Bash 设计全原生 ELIGIBLE 已证）。

## 选型速查（能力匹配，非厂牌偏好）

| 工作形状 | 首选类 | 备注 |
|---|---|---|
| 确定性变换/构建/测试/数据处理 | Native | 已实现 |
| 开放式软件工程（调试/设计/跨文件重构） | Agentic→Codex 类 | 需先落地安装与适配器 |
| 研究/文档/通用多步内容 | Agentic→DSH 类 | 适配器已备，待 auth |
| 无 API 的桌面/GUI 自动化 | Agentic→ZCode 类 | 需自动化接口先存在 |
| 最终批准/例外裁定 | Human | 已实现（canonical） |
