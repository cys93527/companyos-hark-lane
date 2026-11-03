# CompanyOS Hark v0.1.2 — 真实验收 run 7 根治修复（Hark 自审）

v0.1.1 发布后用真实 DeepSeek 模型做了两次真实验收（hark-live-goal，样例工作区 shop-inventory）。run 7 在全部工作检查通过的情况下仍以 INCOMPLETE 结束，暴露 3 个缺陷；每个缺陷先写回归测试再从根上修复（单独提交），随后 run 8 在修复后的提交上完整通过。仅 Hark 自审；普通用户真机验收与独立评审仍由用户/评审方执行。

## 根治修复（根因记录：lane/evidence/v011-acceptance/RUN7_ROOT_CAUSE.md）
- **96293f1 AUDIT-RUN7-1 Windows 验证器临时目录**：未配置隔离时，验证器为每个被重定向的环境变量都执行 mkdir，包括 HOMEDRIVE（`C:`，一个盘符）和 HOMEPATH（盘内相对路径）；Windows 上递归 mkdir 盘符根目录报 EPERM，导致每次 `repo.test-check` 都是 status=error，`npm test` 根本没有运行。现在只创建目录型变量（USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP，POSIX 的 HOME/TEMP/TMP），HOMEDRIVE/HOMEPATH 由其推导。D1 的安全意图不变（未配置 = 标注「未隔离」+ 可信状态保护）。测试 `tests/hark/audit-run7-validator-scratch.test.ts`。
- **f24cd73 AUDIT-RUN7-2 验证闸门覆盖每个阶段**：VALIDATING 的证据闸门只取“最新一行”所在阶段的必需验证器，早期阶段的两条阻断性错误没进入闸门 → 越过失败的验证进入 FINALIZING。现在必需验证器是所有有记录阶段的并集，判定与监督器相同：全运行范围内每个验证器取最新一行（已被消费的失败仍需重新验证）。测试 `packages/engine/tests/audit-run7-validation-gate.test.ts`。
- **80f7c32 AUDIT-RUN7-3 有未完成任务时拒绝 DELIVERY.COMPLETE**：纠正工作完成后，引擎在后代复核任务仍为 PENDING 时发出 DELIVERY.COMPLETE，目标的成功条件（所有任务终态）永远无法满足 → AUTONOMY_STALLED。引擎闸门现以类型化冲突 `RUN_DELIVERY_OPEN_WORK {openTaskIds}` 拒绝；drive() 对“FINALIZING 但仍有未完成任务”改为 DELIVERY.FAIL（列出未完成任务 id），不再静默交付或停滞。测试 `packages/engine/tests/audit-run7-delivery-open-work.test.ts`。

## 真实验收证据
| 运行 | 提交 / 安装包 | 结果 | 调用 | 费用 |
|---|---|---|---|---|
| run 7 hark-live-goal 41641255275 | 088de0b（v0.1.1）/ installer 41488820818 | INCOMPLETE：13 项工作检查全部通过，但 driverCompleted=false（AUTONOMY_STALLED）→ 上述 3 项根治 | 135 次，全部 KNOWN | 3 375 852 micros（约 CNY 3.38） |
| run 8 hark-live-goal 41653476981 | 80f7c32 / installer 41649334682 | **PASS**：EXECUTED_ARTIFACT_CAS_VALIDATION_HANDOFF，14/14 检查通过（含 driverCompleted、npm test、validationPass、handoff、withinCap） | 93 次，全部 KNOWN | 2 125 508 micros（约 CNY 2.13） |

费用台账：installer/budget/pool-cny14-ledger.json（提交 7031f21、648a14d）。证据：lane/evidence/v011-acceptance/run7-41641255275、run8-41653476981。

## 80f7c32 的 CI（全部成功）
hark-ubuntu 41649334506 · hark-windows 41649334575 · hark-installer 41649334682 · hark-isolation 41649408614 · hark-restart 41652012753 · hark-upgrade 41652012827。

## 结论口径
仅 **Hark self-review PASS**（CI + 真实模型验收 run 8）。普通用户真机验收（H17_REAL_PC_ACCEPTANCE_CHECKLIST.md）与独立评审（H17_INDEPENDENT_REVIEW_PACKET.md）**尚未进行**。安装包未做代码签名。
