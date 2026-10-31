# H17 — 独立评审材料包（Hark lane）

给独立评审人的入口。Hark 只提供材料与复现方法；**评审结论由评审人给出**，Hark 文档中所有 PASS 均为 "Hark self-review PASS"，不是独立评审。评审人与 Hark lane、Codex lane 的开发者不应是同一主体。

## 1. 评审对象
| 项 | 值 |
|---|---|
| 仓库 / 分支 | github.com/cys93527/companyos-hark-lane，分支 `hark-lane` |
| 评审版本 | H18 打 tag 时的 commit（release 页给出 commit 与 tree 哈希）；本文写成时最新已推送 commit 为 bd9d75a |
| 安装包 | release 附件 `CompanyOS-Hark-Setup-<版本>-x64.exe`（未签名）+ `SHA256SUMS`；同一文件也是对应 hark-installer 运行的 artifact |
| 产品目标 | `pkg/handoff/PRODUCT_TARGET.md`；比较准则 `COMPARISON_ACCEPTANCE.md`；安全 `SECURITY.md` |
| 阶段地图 | `docs/hark-lane/ROADMAP.md`（每项的阶段文档、CI run id、状态） |

## 2. 请评审人核验的问题（按 COMPARISON_ACCEPTANCE 八项）
| 项 | 要核验的说法 | 材料 | 建议核验方式 |
|---|---|---|---|
| 可复现性 | 安装包由该 commit + 锁文件在 CI 上构建，SHA256 一致 | `.github/workflows/hark-installer.yml`、`pnpm-lock.yaml`、H8 文档 | 对 tag commit 重新运行 hark-installer，比对 stage-manifest 与安装包哈希（Inno 打包含时间戳时以 stage-manifest 为准，并说明差异） |
| 用户体验 | 草稿保存/恢复、明确提交、真实进度/费用/失败原因/产物 | `H11_BUDGET_UI.md`、渲染进程 `apps/renderer/src/`；用户真机清单 `H17_REAL_PC_ACCEPTANCE_CHECKLIST.md` | 读用户回传的清单与截图；自行在一台 Windows 上按清单第 2–4 节操作 |
| 业务闭环 | 同一离线 fixture 目标产生精确文件，经 Validation 后 Handoff；失败不伪装完成 | `scripts/hark/acceptance-fixture`、`scripts/hark/live-goal-execute.mjs`、H15 文档、证据 `lane/evidence/H15d-ci/` | 查看 hark-live-goal 验收运行的 artifact `live-goal.json`（checks 每项、validations、handoff）；确认 INCOMPLETE 的运行没有被写成 PASS |
| 生命周期 | 分配前暂停；绑定失败不执行；取消/超时/崩溃后进程树归零 | H4–H7、H12、H12B、H15b 文档；`native-job-smoke.mjs`、`restart-unknown.mjs` | 重跑 hark-windows（native 门）、hark-restart；读 active-zero 证据 |
| 预算与身份 | 模型/上游/账户/价格/token 上界与费用授权一致；UNKNOWN 不退款不重放 | H10、H12C 文档；`installer/budget/*.json`；broker `apps/desktop/src/executor/embedded-dsh-runtime.ts` | 抽查每次真实运行的账本条目与 artifact 中 reservations 一致；UNKNOWN 按上界计入 |
| 安全 | 未授权 Provider/DSH/网络/系统变更为 0；Job Object 不冒充隔离；无跨线数据或凭据 | `SECURITY.md`、`H16_WINDOWS_ISOLATION.md`、`scripts/hark/isolation/`、hark-isolation 运行 | 重跑 hark-isolation（探测 + 生命周期）；读 lifecycle 每项；检查 workflow 中密钥只来自 secret 且有泄漏检查 |
| 持久化恢复 | 重启一致、取消终态不被迟到成功覆盖、不自动重放未知付费调用 | H12、H12B、H12C、H13 文档 | 重跑 hark-restart、hark-upgrade |
| 质量 | 定向回归、完整门按范围、安装卸载独立证据；保留首次失败 | H14 文档、`scripts/hark/ubuntu-vitest-baseline.json`（仅环境绑定项，附原因）、`lane/evidence/*/run1-*` | 重跑 hark-ubuntu；核对基线中没有产品缺陷被当作基线；核对每阶段首次失败证据存在 |

## 3. 真实花费（DeepSeek，人民币）
- H10/H15c 冒烟（CNY 1 上限账本 `installer/budget/h15c-real-spend-ledger.json`）、H15d 验收（CNY 5 账本 `h15d-acceptance-ledger.json`，2026-10-26 22:47 关闭于 ¥1.786）、此后 CNY 10 池（`pool-cny10-ledger.json`，2026-10-31 15:15 关闭于 ¥5.818）、再后 CNY 14 池（`pool-cny14-ledger.json`，用户 2026-10-31 15:15 批准）。UNKNOWN 一律按上界计入，因此账本 ≥ 实际账单。
- 评审人可要求用户提供 DeepSeek 控制台账单与账本对照。

## 4. Hark 自认的已知限制（请评审人判断是否阻断）
1. 未签名：SmartScreen 警告（用户决定，不签名）。
2. H17a：已安装版尚无面向普通用户的模型/Key/预算配置入口（截至 2026-10-27），由 H17a 补齐前，普通用户无法独立完成真实目标。
3. 隔离残留：DNS 查询；其他卷根默认可读；启用隔离需一次管理员提权。
4. 只在 GitHub windows-2022 runner 上验证；家用版 Windows、杀毒软件、域策略下的行为以用户真机清单为准。
5. 内核为固定上游 deepseek-ai/deepseek-harness 639ed015（dsh-v0.2.0-rc.2，MIT），以 SBOM + 许可证随包；上游代码未修改，CompanyOS 侧修正都在自有 guard/配置中。

## 5. 评审结论模板（评审人填写）
```
评审人：            日期：            评审版本（commit / tag）：
安装包 SHA256：
逐项结论（PASS / FAIL / 未运行 / 受阻，附理由与证据链接）：
  可复现性：
  用户体验：
  业务闭环：
  生命周期：
  预算与身份：
  安全：
  持久化恢复：
  质量：
阻断问题（P0/P1）：
非阻断问题：
总体结论：
```
填写后的结论由用户放入仓库 `docs/hark-lane/H17_INDEPENDENT_REVIEW_RESULT.md`（Hark 不创建此文件）。
