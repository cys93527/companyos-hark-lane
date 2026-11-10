# CompanyOS Hark v0.1.4 — 真实需求实测根因修复 + 合同自动填写目标完成（Hark 自审）

v0.1.3（a4938b9）之上的修复版本。用真实需求「开发一个跨平台的合同自动填写软件，支持手机和电脑端……确保合同格式和原有排版保持不变」在 Windows CI 机器上通过已安装的 CompanyOS 图形界面（hark-live-goal，DeepSeek）反复实测；每一轮暴露的 CompanyOS 缺陷都在根上修复并补回归测试，最终第 18 轮 `GOAL_COMPLETED_CLEAN`。另含测试提速、SQLite 数据库备份和 Windows 黑屏修复。本版本提交本身无真实模型调用、无新依赖（Vitest 3.2.7 → 5.1.0 为 v0.1.3 之后唯一的依赖变更，见 TEST_SPEED.md）。仅 Hark 自审；普通用户真机验收与独立评审仍由用户/评审方执行。安装包未做代码签名（SmartScreen 会提示「未知发布者」）。

## 内容
- **Windows 黑屏修复（1a80f47）**：模型目录与实时 `/models` 列表不一致时不再使组合失败——目录按审计记录对齐（`provider.catalogue_reconciled`），无法访问时保留快照；描述漂移仍拒绝（除非新适配器声明 `supersedes`）；被拒的模型适配器以 DEGRADED 组合；所有视图显示服务失败横幅；缺少 renderer 构建时显示内置错误页；窗口背景为纸色。详见 [PROVIDER_DESCRIPTOR_RECONCILE.md](./PROVIDER_DESCRIPTOR_RECONCILE.md)。
- **测试提速（6ffe870）**：Vitest 5.1.0、packages 项目 `isolate:false`、`test:full/since/changed/shard`；完整测试仍是打 tag/发布前的强制门禁（lane/h18-release.sh 校验）。详见 [TEST_SPEED.md](./TEST_SPEED.md)。
- **SQLite 数据库备份（23cacbc，a84af1a 合并）**：VACUUM INTO 快照（启动 / 迁移前强制 / 定期）、轮换、校验后的分阶段恢复；hark-windows 在真实 NTFS 卷上运行备份测试。详见 [DB_BACKUP.md](./DB_BACKUP.md)。
- **真实目标驱动（74a136d、d010489、efd967b、64f0806）**：hark-live-goal `mode=custom` 通过已安装 GUI（CDP）驱动用户目标，每轮 CNY 8 上限 + 账本，完整监控；安装包可在同一工作流内构建；无 artifact 时把关键截图与摘要写入日志。
- **合同自动填写实测根因修复（第 2–17 轮）**，主要包括：
  - 第 2–5 轮：内核输出上限（提示 + 类型化原因 + 续写恢复）、目标用量计入执行与内核用量、中文阻塞原因、`COS_MODEL_THINKING` 默认关闭与 `PROVIDER_REASONING_EXHAUSTED`、尝试截止时排空而非杀掉进行中的模型调用、引导内核使用成熟库。
  - [第 6 轮](./LIVE_CONTRACT_FILL_RUN6_FIXES.md)：压缩大小按 4096 上限、内核错误完整捕获、重试从精简尝试笔记恢复、每步花费上限、用量覆盖读取已结算账本、证据排除依赖缓存。
  - [第 7 轮](./LIVE_CONTRACT_FILL_RUN7_FIXES.md)：提示缓存命中按缓存价计费；用量解析移出 Core 到适配器层。
  - [第 8 轮](./LIVE_CONTRACT_FILL_RUN8_FIXES.md)：计划步骤知道自己的位置与范围，第 1 步不再试图完成整个目标。
  - [第 9 轮](./LIVE_CONTRACT_FILL_RUN9_FIXES.md)：运行机安装 LibreOffice 并列出检测到的工具；收尾（wrap-up）作为 broker 机制；超时/封顶尝试已验证的工作计入进度；依赖环境的能力单独成步。
  - [第 10 轮](./LIVE_CONTRACT_FILL_RUN10_FIXES.md)：无法推进的尝试像截止一样提前结束（静默看门狗 `COS_KERNEL_SILENCE_MS`）。
  - [第 11 轮](./LIVE_CONTRACT_FILL_RUN11_FIXES.md)：调用守卫不按最坏 token 估算；任务文本列出工作区已有成果；可从上一轮续跑；独立检查使用 UTF-8。
  - [第 12 轮](./LIVE_CONTRACT_FILL_RUN12_FIXES.md)：`repo.test-check` 子进程固定 UTF-8；溯源检查接受工作区源码逐字引用的名称（docx 包成员）。
  - [第 13 轮](./LIVE_CONTRACT_FILL_RUN13_FIXES.md)：`repo.test-check` 合同截止时间在工具上限内、输出尾部不缓冲、Windows 系统环境；引擎经单调时钟接缝计时（引擎边界无 `Date.now`）。
  - [第 14 轮](./LIVE_CONTRACT_FILL_RUN14_FIXES.md)：校验器临时目录清理为尽力而为，`EPERM` 不再覆盖测试结论。
  - [第 15 轮](./LIVE_CONTRACT_FILL_RUN15_FIXES.md)：无阻塞窗口只允许 CONTINUE，已消费的失败被标记。
  - [第 16 轮](./LIVE_CONTRACT_FILL_RUN16_FIXES.md)：整轮截止前的收尾窗口内不再开启新的模型回合。
  - [第 17 轮](./LIVE_CONTRACT_FILL_RUN17_FIXES.md)：纠正任务能看到校验器的失败详情；校验器保留输出尾部。
- **本提交**：版本号 0.1.3 → 0.1.4（apps/desktop、apps/renderer、packages/*、installer/companyos.iss 默认值）与发布文档。

## 结果
第 18 轮 hark-live-goal 42756324973（135c3a8，续跑第 17 轮）：`GOAL_COMPLETED_CLEAN`，目标 COMPLETED；一次纠正后两个校验器通过，评审通过并交付。CNY 1.495868（213 次调用，全部 KNOWN）；18 轮合计 CNY 42.001。生成的应用：导入 Word 模板识别字段、手动/粘贴输入自动匹配填写、预览编辑、导出 DOCX/PDF（PDF 需 LibreOffice）、排版保持、手机/电脑自适应网页界面，自带测试 89/89。总结见 [LIVE_CONTRACT_FILL.md](./LIVE_CONTRACT_FILL.md)。

## CI
135c3a8（第 18 轮所用代码）全部成功：hark-windows 42752831627 · hark-ubuntu 42752831311 · hark-installer 42752831645 · hark-restart / hark-upgrade 成功。发布提交的 CI 运行号与安装包 sha256 见发布说明（lane/evidence/v014-release/notes.md）与 PROJECT_HANDOFF.md。

## 结论口径
仅 **Hark self-review PASS**（CI + 真实目标实测）。普通用户真机验收（H17_REAL_PC_ACCEPTANCE_CHECKLIST.md）与独立评审（H17_INDEPENDENT_REVIEW_PACKET.md）**尚未进行**。安装包未做代码签名。
