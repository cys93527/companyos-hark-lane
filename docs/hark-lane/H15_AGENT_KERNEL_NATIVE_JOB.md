# H15 — 打包 DSH 内核 + native.job 生产接线（Hark lane）

状态：**Hark self-review PASS（进行中，以 CI 结果为准）**。独立评审：**未授予**。用户批准：2026-10-26 08:39（ROADMAP #10 DSH 运行时 + native.job 生产接线；实时 DeepSeek 调用在 CNY 1 运营上限内）。

## H15a — 打包内核（@0d36374，修复 @ddee1b4）
- 仅 deepseek-ai/deepseek-harness 固定 SHA 639ed015397290b3745d163aafe02ffee4aa3f84（dsh-v0.2.0-rc.2，MIT），exact pin；安装到 `resources/agent-kernel/dsh-v0.2.0-rc.2/`：闭包文件、官方 node v24.19.0（SHASUMS256 校验）、CycloneDX SBOM、许可证索引、denylist、可重定位 manifest；首启健康检查（版本回读）；PONG 冒烟（本地回环脚本化模型，零凭据零网络）。
- 首次失败（保留于 lane/evidence/H15-ci）：
  - hark-installer 40254706132：上游 host `tsc -b tsconfig.host.json` 在 Windows runner 默认 2 GiB 堆 OOM。**根治**：按上游 `build:lib:host` 原样调用（`node --max-old-space-size=4096 node_modules/typescript/bin/tsc -b tsconfig.host.json`），测试锁定该调用。
  - hark-ubuntu 40254706085：execution-safety-process「captures actual timeout」在慢 runner 上 800ms 截止先于 pid 行触发。**根治**：截止只在夹具打印 pid 行后触发（与 H14 bounded-cleanup 同一模式），不再依赖墙钟。
- 修复后：hark-windows 40257829046 ✓、hark-ubuntu 40257828903 ✓、hark-installer 40257828899（内核 materialize/pack/健康/PONG 步骤通过）。

## H15b — native.job 生产接线（@9c19293）
- `apps/desktop/src/executor/native-lifetime/native-job-composition.ts`：唯一生产装配点。仅 win32/x64；koffi 精确 3.3.3，作为安装资源随包发布于 `resources/native/koffi-3.3.3/`，加载前按 `binding-manifest.json` 重算每个文件 sha256、目录不得有未列文件；Job 适配器 ATOMIC_REQUIRED + launchPinning REQUIRED + 有界管道捕获。任何不满足 → 类型化拒绝（NATIVE_JOB_UNSUPPORTED_PLATFORM / NATIVE_JOB_BINDING_REFUSED / NATIVE_JOB_OPERATION_INVALID），**绝不回退到无界 spawn**。
- `core-services.ts`：新选项 `nativeJob`（可信部署数据），动态 import 组合模块后注册 `native.job` provider；`nativeJobStatus` 暴露注册结果与原因。
- `production-composition.ts`：读取安装包内 `resources/native/operations.json`（构建时由 `scripts/hark/pack-native-job.mjs` 生成；资源相对路径 + sha256 钉住），把 `companyos:native-inventory` 路由到 `native.job` 并经 provider 分派（工作区绑定校验不变）。
- 首个生产操作 `workspace-inventory`：用随包内核 node.exe 运行 CompanyOS 自有脚本，在工作区写出真实文件工件 `companyos-inventory.json`（每个文件路径/字节/sha256），stdout 给出结构化结果（工件 sha256）。
- 合约 C12：操作环境中的 `{workspace}` 前缀按请求替换为可信工作区根（TEMP/TMP 落在工作区内，launch-pins 本就拒绝工作区外的 profile 目录）。
- 架构守卫改为「单一接缝」：只有 core-services.ts 可动态 import native-job-composition；production-composition.ts 只可出现一次路由键。
- 安装器：koffi 与 hark-windows 同一 sha512 完整性校验抓取 → 打包 resources/native → stage → `native-job-smoke.mjs` 用**随包模块**在 Job Object 中跑真实操作并核对工件；篡改的 binding 副本必须被拒。安装冒烟检查 resources/native 已安装。
- 本地首次失败（lane/evidence/H15b-gates）：操作路径校验用宿主 `path.isAbsolute`，非 Windows 宿主把 `C:\…` 判为相对 → **根治**为 win32 语法判断。
- 门禁（沙箱）：offline 138/138，typecheck/边界/架构 0，变更文件 eslint 0，定向 vitest 通过。

## H15b CI 首次失败与根治（@9c19293 → 下一提交）
- hark-installer 40257828899（@ddee1b4）：内核 materialize/pack/PONG 通过，但**按用户安装中途中止**——Inno Setup 日志 `Defaulting to Abort for suppressed message box`，目标文件路径超过 Windows MAX_PATH 260（pnpm 虚拟仓库目录名如 `.pnpm/@earendil-works+pi-ai@0.87._<hash>` 使内核相对路径达 213 字符）。**根治**：`pack-agent-kernel.mjs` 将每个 `.pnpm/<store>` 段改为确定性短 id（排序后 base36 序号；文件、junction、许可证副本一致改名；原名保存在 closure-manifest `derivation.pnpmStoreRemap`），内核内最长相对路径 252→135，超过 `KERNEL_RELATIVE_PATH_BUDGET=150` 拒绝打包；工作流新增 `measure-stage-paths.mjs`（整包相对 `{app}` 最长路径 >179 拒绝），并以 `/DMaxRelPath` 传入安装器，安装器在选目录时拒绝超过 `259 - MaxRelPath - 1` 的安装路径（中文提示），不再半途失败。
- hark-installer 40258572797（@9c19293）：native.job 冒烟 8/9 通过（Job Object 内真实写出 `companyos-inventory.json`），唯一失败是冒烟脚本按裸对象读取结果，而 provider 契约返回 `{ schema: 'companyos/native-result/1', value }` → 冒烟脚本按契约读取并新增 schema 断言（测试代码缺陷，产品行为正确）。
- 证据：lane/evidence/H15b-ci/run1-installer-*；回归测试 tests/hark/h15-path-budget.test.ts。

## H15c 真实目标首次失败与根治
- hark-live-goal 40263437730（mode=execute，安装包来自 hark-installer 40262297248）：真实 DeepSeek 规划成功（2 次调用，约 ¥0.0115），计划两个工作项；第一个工作项派发到随包内核前被**执行准入拒绝**（`GOAL_ADMISSION_REFUSED`，原因被吞掉）。根因两处：① 同一个运营凭据有两种写法——模型配置用 `vault://COMPANYOS_MODEL_API_KEY/live`，内核回退路由的预算绑定用 `env:COMPANYOS_MODEL_API_KEY`，可信预算按身份精确比较 → 不认；② 部署声明的 max_tokens 为 8192，而预算证明的输出上界为 8000 → 准入按设计拒绝。**根治**：新增唯一的 `envCredentialRef()`（models/credential-ref.ts），模型池与内核回退绑定都经由它；预算模板输出上界改为与部署声明一致的 8192（最坏情况 H10 6 次 ¥0.681、H15c 8 次 ¥0.908，均 ≤ ¥1）；派发拒绝时在持久 dispatch 行记录类型化原因（`NOT_INVOKED:GOAL_ADMISSION_REFUSED(<reason>)`）。回归测试 tests/hark/h15c-admission.test.ts 用真实部署模板 + 生产路由验证准入。证据 lane/evidence/H15c-ci/run1-live-40263437730。

## 价格核对（H15c 前置）
- 2026-10-26 官方价格页：模型名 `deepseek-flash`（DeepSeek-V4.1-Flash-1017），`deepseek-chat` 已不在列。CNY 高峰：输入未命中 2 元/M、输出 8 元/M——与 `installer/budget/deepseek-flash.approval-template.json` 一致。Search/Fetch 自 2026-11-01 起 5 元/千次（含经 Harness 的服务端工具调用）→ H15c 内核 profile 保持网页搜索/抓取关闭。

## 未完成 / 下一步
- 根治提交的 CI（hark-installer 全流程 + hark-restart/hark-upgrade）。
- H15c：在 CI 上用真实 DeepSeek（≤ CNY 1）经随包内核跑一个真实目标，产出文件 Artifact/CAS/Validation/Handoff。
