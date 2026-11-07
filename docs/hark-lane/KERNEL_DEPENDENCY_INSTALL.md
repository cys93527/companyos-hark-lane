# 智能体内核安装项目依赖（live contract-fill run 5 之后）

背景：run 5（hark-live-goal 42367067423）中内核用一整次 10 分钟尝试手写 zip 解压、XML 解析和 docx 读取（零依赖），而不是安装成熟的库。

## 现在的做法
- 内核任务文本（`ENGINEERING_PRACTICE_DIRECTIVE`，apps/desktop/src/executor/dsh-executor-provider.ts）要求：用项目自己的包管理器（npm/pnpm、pip …）从官方源安装成熟的开源库并写入清单和锁文件（例如 docx 模板用 docxtemplater + pizzip 或 docx 包；PDF 导出用 LibreOffice 无界面转换或同等的维护中的库）；不手写 zip/XML/docx/PDF 等格式的解析器；装不上就在最终回答里说明，而不是自己重写。
- 规划器合约（packages/engine/src/planning/planner-runtime.ts）：计划文字跟随目标语言（中文目标 → 中文计划），软件工作以成熟库为基础。
- CompanyOS 自身不新增任何依赖；这些依赖只装进用户的项目工作区。

## 网络策略（不变，按现有安全模型）
- 未启用 Windows 隔离（默认、CI live 运行）：V1 标准执行安全模型（docs/security/V1_STANDARD_EXECUTION_SECURITY_MODEL.md §4）明确 HOST_NETWORK_ISOLATION 不保证，内核的 shell 可以访问网络，因此 `npm install` 可直接从官方源安装。run 6 的证据用于确认这一点（若内核 shell 沙箱阻止了 npm 缓存或网络，会在 run 6 的日志中看到并据此根治）。
- 启用 Windows 隔离（H16，WFP 只放行模型代理端口）：隔离账户无法直接访问官方源，依赖安装会失败。这是隔离的设计结果；若要在隔离下安装依赖，需要经模型代理增加固定目标（registry.npmjs.org，仅 GET）的转发并在内核 HOME 写入 .npmrc，属于后续工作，尚未实现。
