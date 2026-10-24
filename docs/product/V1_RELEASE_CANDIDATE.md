# COMPANYOS V1 — RELEASE CANDIDATE

状态：**PRODUCT_RELEASE_CANDIDATE = YES（功能面）**；**PRODUCT_FINAL_GATE_READY = NO（唯一阻塞：可见 Windows 冒烟 EXTERNAL_BLOCKED）**。
不宣告 V1 冻结；本文随 Final Product Bug Bash 轮次更新。

## 1. 基线与链路

- 基线 HEAD：本轮提交 `fix(runtime): close final v1 correctness blockers`（parent `6e0016c`，F1–F4 首轮闭合 + 第二轮 Codex 复审 F1 再验证锚定/F3 链接遏制与依赖保真/F4 TOCTOU）。
- 已验证产品链（真实组件，全 canonical）：用户打开 CompanyOS → 选择工作区 → 选择访问权限/模型 → 一次输入自然语言 Goal → 规划 → 动态专业工作/角色 → 嵌入式 DSH 执行 → 工件/证据 → 独立验证（ValidationService 批次 + ADR-0020 门）→（需要时）纠正自治（含对纠正后代工件的再验证批次）→ Handoff → Outcome → Goal 终态。用户零手工编排。

## 2. 各阶段验收状态

| 项 | 状态 |
|---|---|
| Core Runtime | PASS（此前 Boss 裁定） |
| Desktop Stage 1–4 | PASS（此前 Boss 裁定） |
| Dynamic Validation Closure | PASS |
| Corrective Autonomy Closure | PASS（c52148f）+ 第二轮复审：**再验证批次锚定闭合**（应用器消费规则 + 每轮对对应后代工件的新批次）+ 持久化非法提案预算 + blockingValidations 入合法性与投影同一派生 |
| Final Release Blockers F1–F4 | **CLOSED**（首轮 6e0016c + 复审轮：F1 锚定/预算持久化、F3 链接遏制+依赖保真、F4 执行/验证期钉住绑定） |
| Final Release Blocker F5 | **CLOSED**（supervisor in-flight 有界结算 / autonomy single-flight：turn 结算所有权 + deadline 竞速 + 无 Decision 的 RUNNING 回合不发新轮；F5-01..10 确定性回归 + INCIDENT 回归全绿） |
| BB1 通用数据工作 | PASS（PRESERVED：run_01M462NGY…，Oracle 全对） |
| BB2 软件工作 | PASS（run_01M465E3N…，multiply(4,3)=12、add 保持、测试 4/4）；专项验证器 repo.test-check（验证时亲跑工作区自声明测试契约、快照内执行）+ 约束生成 taskKind 分类；纠正链确定性回归全绿（FAIL→REQUEST_CORRECTIVE→纠正执行→**第 2 批对纠正后代工件 PASS**→COMPLETED；多轮真耗尽 PAUSED） |
| BB3 只读拒绝 / 工作区操作 | PASS / PASS（记录见 V1_PRODUCT_BUG_BASH.md §4） |
| 工作区切换一致性 | P1_FIXED（canonical switch 命令 + fail-closed + typed 拒绝；WS 回归 10/10） |
| RESTART_RECOVERY | PASS（同 Goal/Outcome/工件/Validation，零重复；本轮另证：重启将 in-flight RUNNING 结算 INTERRUPTED 后按 durable truth 恢复） |
| Open Product P0 / P1 | 0 / 0 |
| VISIBLE_NON_HEADLESS_WINDOWS_SMOKE | **EXTERNAL_BLOCKED**（主机 GPU 环境缺陷：裸 Electron 44.5.1 对照同崩 0x80000003/0xC0000005；Boss 已裁定 HOST_ENVIRONMENT） |

## 3. 已知边界（诚实记录，非阻塞）

- 部署级验证器绑定：默认 kind 保持通用基线 evidence.grounding-check；软件 kind（companyos:software-work）绑定专用 repo.test-check（加性 grounding）——per-kind 静态部署策略、约束生成分类、无任何文本/文件名/角色信号。
- 验证器快照：链接物化/出界 typed 拒绝、node_modules 纳入（上限 150k 文件/1GiB，超界 typed 环境不可用）；绝对路径写入属进程 OS 权限边界（快照不沙箱化，诚实记录）。
- 单活动工作区：V1 设计即单活动；变更走 canonical switch 命令，失败 fail-closed 保持原工作区；执行/验证全程钉住 Goal 绑定（TOCTOU 闭合）。
- 会话内一次性发现：BB2 准备期的 exploratory Goal 落入当时显示且 canonical 的工作区 A——事故根因是操作者忽略类型化拒绝，产品无假显；据此完成切换缝修复。
- 可见冒烟：EXTERNAL_BLOCKED——需在正常 Windows 图形环境执行最终可见验收（唯一遗留）。
- supervisor in-flight 边界（F5 后）：live 结算覆盖调用仍存活的窗口；真崩溃窗（进程死亡）仍由既有
  重启恢复结算 INTERRUPTED。不做敌意 provider 沙箱化，不归因网络栈。

## 4. V1.1 优先级（保持，不在本轮）

Session & Context Runtime、usage accounting 完整化、pre-start audit/ack、event retention、provider bookkeeping accrual——均维持既有 backlog 裁定，不在 V1 冻结前实施。
