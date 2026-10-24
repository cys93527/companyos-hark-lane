# ADR-0008：Workflow Designer 的 UI 边界、IPC 契约与单一真相源

> 归属：Sprint 5（Workflow Designer，P2）；规划书 §五十九、§四十七（IPC 最小权限）、§十（禁止原地修改）；
> 上游 ADR-0003（状态分层）、ADR-0006（持久化）、ADR-0007（生命周期治理）。

## 状态

**已接受（Accepted）** — Sprint 5 交付。

## 背景

Sprint 4 把 Workflow 变成了受治理的 SOP 资产（Draft/Review/Publish/版本/锁/提案/快照），但没有任何 UI：
用户无法在一个会话里创建、修改、校验、发布一个 Workflow。Sprint 5 要补这一层，同时守住四条红线：

1. Renderer 不得触达 SQLite；
2. Renderer 不得复制 Core 业务规则；
3. UI 不得成为第二套状态真相源；
4. 所有写入必须经过现有 `WorkflowLifecycle`。

另外 Sprint 0 冻结了一条 IPC 安全契约：allow-list 只有 3 条通道，且有测试精确匹配。

## 决策

### 1. 一个通道、一个入口、先校验后执行

新增 `companyos:workflow`（**唯一的 feature channel**），preload 只暴露 `workflowRequest(request)`。
`createWorkflowApi().handle(raw)` 的第一件事是 `parseWorkflowRequest(raw)`：operation 白名单 + 逐
operation 字段/类型/长度校验，失败一律 `INVALID_ARGUMENT`。**这是契约变更**：allow-list 由 3 条变 4 条，
`channels.test.ts` 的断言从"精确匹配 3 条"改为"精确匹配 4 条 + 只有一个 feature channel"——
断言强度不降（仍是精确匹配，不允许新增悄悄溜过），并在 `PROJECT_HANDOFF.md` 记录为用户 STEP 3 授权的变更。

### 2. 应用层不拥有规则

`workflows.ts` 只做三件事：校验传输形状、调用 `WorkflowLifecycle`、把 `Result` 格式化。
图编辑的唯一写路径是 **Core `applyChangeOps` → Core `validateWorkflowGraph` → `lifecycle.saveDraftGraph`**；
没有第二条写入路径，也没有任何本地状态被信任。

### 3. 图编辑是纯函数批处理

`applyChangeOps` 不可变、确定、原子（首个非法 op 整体失败）、无 IO。Publish 前必须过
`validateWorkflowGraph`（10 类检查），失败即 `VALIDATION_FAILED`——门在应用层与 service 层各设一道，
UI 提示不构成边界。

### 4. Renderer 只做投影

`designer-model.ts` 把 IPC 响应变成视图数据（纯函数）；组件不做状态机判断、不缓存权威状态，
每次操作后重新 `draft.open` 拉真相。因此"UI 是第二真相源"在结构上不成立。

### 5. 治理数据库由 main.ts 惰性打开

`openDurableDatabase({ chains: ['core','engine','lifecycle'] })` 只在主进程打开，且失败不致命
（结构化错误回给渲染层）。Renderer 侧不存在任何持久化依赖。

## 后果

**收益**

- 用户可在桌面完成 Draft → Review → Publish → Fork → Compare → Deprecate → Archive 全链路；
- 规则仍单点在 Core（有 O/P 边界测试证明 Renderer 没有复制品）；
- 非法 IPC 输入在执行任何领域代码之前被拒（Q 组覆盖每类输入）；
- 版本与快照的回归有 E2E 证据（N 组）。

**代价与限制**

- allow-list 从 3 条增至 4 条（显式契约变更；`channels.test.ts` 与 `designer-boundary.test.ts` 双重锁定）；
- 无拖拽/画布/自动布局/多人协同/AI 生成（Sprint 5 §8 明确禁止）；
- `ChangeOp`（Proposal 的 ops）仍是记录性质，未自动落到图上：修订图由 Designer 显式提交；
- Industry Pack 列固定 `generic`（pack 绑定属后续 Sprint）；
- **授权是"会话级"而非"角色级"**（评审 MEDIUM-2）：主进程用 `SESSION_ACTOR` 覆盖渲染层自述的 actorId，
  并要求 `authorize` 放行该 actor；真正的 `workflow.publish` / `archive` 权限矩阵等 Role 存储落地后再深化；
- **`defaultRequireRole` 在生产为 true**（评审 MEDIUM-1）：测试与生产走同一规则，不再出现"测试覆盖了
  一个生产不生效的校验"；调用方若要放宽必须显式传 `requireRole: false`；
- **`proposal.list` 返回真实提案**（评审 MEDIUM-3），不再拿模板列表冒充；
- **传输层有上限**（评审 LOW-2）：文本 512 字符、Stage 200 / Edge 500 / Schema 列表 64 / ops 200，
  超限即 `INVALID_ARGUMENT`；
- **同一 SQLite 文件有两个 durable 句柄**（评审 LOW-1）：外壳库（core+engine 链）与治理库
  （core+engine+lifecycle 链）。二者写不同的表，但跨句柄互斥只靠 SQLite 锁——合并句柄列入后续 Sprint；
- Renderer 无端到端浏览器测试（Electron 二进制在本环境无法下载），边界与投影层由单测覆盖。

**被否决方案**

| 方案 | 否决理由 |
|---|---|
| Renderer 直接连 SQLite（better-sqlite3 / IPC 传 SQL） | 违反红线，且把存储暴露给不可信上下文 |
| 每个操作一个 IPC 通道（20 个） | allow-list 爆炸，攻击面变大；单通道 + operation 白名单更小更可测 |
| 用 JSON Schema 库做校验 | 增加依赖；手写严格解析同样可测，且能给出字段级细节 |
| UI 里判断"published 不可改" | UI 不是安全边界（测试 G 证明绕过 UI 仍被拒） |
| 引入拖拽库 | 会造成架构锁定且消耗 Sprint 时间（§8 明确禁止） |
| Renderer 缓存权威状态 | 会形成第二真相源，重启/并发下必然分叉 |
