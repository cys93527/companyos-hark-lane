# DSH KERNEL DISTRIBUTION / UPDATE SPEC — 分发、可复现基线与升级门(Stage 3 冻结)

> 目的:冻结内核的**可复现基线门(REPRODUCIBLE_RUNTIME_BASELINE gate)**、分发/SBOM、升级门与退出策略记录。
> 铁律:RESEARCH_BASELINE ≠ SHIPPING/IMPLEMENTATION_BASELINE;研究版本不得自动成为 Shipping 基线(官方处于 rc/developer-preview)。

---

## 1. 基线区分(冻结)

| 基线 | 值 | 用途 |
|---|---|---|
| RESEARCH_BASELINE | `639ed015397290b3745d163aafe02ffee4aa3f84`(`dsh-v0.2.0-rc.2`) | 本阶段规格事实来源 |
| IMPLEMENTATION_BASELINE | 由 §2 门裁决(候选=研究基线或最近可干净复现的官方 tag) | Stage 4 起的分发锚点 |
| 禁止形态 | local `-max` 分发版/未提交工作树/私人 fork/用户改动版 | 任何用途皆禁 |

## 2. REPRODUCIBLE_RUNTIME_BASELINE GATE(记录)

环境:Windows 11(本机);node `v24.19.0`(engines `^22.19.0 || >=24.0.0` ✓);pnpm `11.7.0`(= packageManager 精确匹配)。禁止项全部遵守:未用本机 node_modules/本机 DSH/历史 profile/本机 config/`~/.dsh` 凭证;`DSH_HOME` 指向 scratch。

| 门步骤 | 结果 |
|---|---|
| Fresh clone(官方 URL,pinned SHA `639ed015397290b3745d163aafe02ffee4aa3f84`) | **PASS**(clean tree) |
| Clean install(`pnpm install --frozen-lockfile`) | **PASS**(59.4s;1394 .pnpm 条目;仅 Windows bin-shim 预构建 WARN) |
| Minimal build(官方 host 路径 `tsc -b tsconfig.host.json`+`tsdown --env.DSH_BUILD_FACE host`,**未改 upstream**) | **PASS**(exit 0;全部 lib 产出含 `apps/cli/lib/bin.js`) |
| Minimal composition(research-only profile `companyos-minimal`) | **PASS**(`--dump-config` 合成树验证 + 实跑) |
| Headless start / Health(PONG 等价) | **PASS**(NDJSON 流:session→turn→step→text→usage→final=`PONG`,exit 0) |
| Clean shutdown | **PASS**(正常退出 exit 0;SIGINT 中断→typed `TRANSPORT` 错误→诚实收尾后退出) |

### 2.1 执行记录(研究产物位于 CompanyOS 仓外 `E:\DeepSeek.gzq\kernel-research\`;`gate/` 目录持有 mock 端点与 overlay 原件)

- **克隆/环境**:fresh clone 至 `dsh-repro`(SHA 精确=pinned);node v24.19.0/pnpm 11.7.0(=engines/packageManager);`DSH_HOME=gate/dsh-home-scratch`(**未用**本机 node_modules/本机 DSH/历史 profile/本机 config/`~/.dsh` 凭证)。
- **最小组合形态**(=DEFAULT_KERNEL_PROFILE_V1 的 research 原型):bundle `@deepseek-ai/dsh-sdk-minimal` + profile patch 层:禁用 `llm-deepseek`/`sdk-jsonrpc-server`/`sdk-app-startup`;挂 `dsh-llm-pi-ai`(hand-declared route `mock-openai`:`api: openai-completions`+`baseURL http://127.0.0.1:8642/v1`+`apiKeyEnv MOCK_KEY`+单模型元数据);挂 `dsh-agent-default-model`(provider/model 钉死);挂 `dsh-headless/startup`+`dsh-headless`(one-shot runner);`sandbox-policy mode: read-only`。
- **受控模型缝**:本机 loopback mock OpenAI 兼容端点(SSE chunk 流)——零凭证、零账号、零远端。
- **运行结果**:`final text = "PONG"`;usage(inputTokens 5/outputTokens 1/totalTokens 6)来自 mock;**零组合告警**(对照:dsh-base 全树 headless 同任务有 3 条 typert/api-gateway 失败条目——最小组合更干净)。
- **取消/中断**:慢端点(8s)+4s SIGINT → 流中断→typed `TRANSPORT: Stream ended without finish_reason`→turn 诚实收尾→进程退出(外部终止下无悬挂)。
- **附带再证**:官方 0.2.0 构建的 NDJSON 契约形状(session/status/text/usage/final)与 S24 冻结契约一致(session 格式已 v3→v4,升级门必查项)。
- **IMPLEMENTATION_BASELINE 裁定**:**= RESEARCH_BASELINE**(`639ed015…`,`dsh-v0.2.0-rc.2`)——门内全 PASS;仍属 rc,Stage 4 起每次更新走 §4 二十项升级门,SAFETY experimental 声明持续跟踪。

**若任一步失败**:不修 upstream;分类 `UPSTREAM_REPRODUCIBILITY_BLOCKED`;比较最近官方稳定可复现 tag 重跑本门;仍败 → `KERNEL_PROFILE_BLOCKED` 返回 Boss。

## 3. 分发(冻结设计)

- **形态**:官方 host 构建产物 + CompanyOS Profile 包(`cordis.patch.yml` + 路由表生成器产物 + env 清单)+ pinned `node` 运行时(版本=门环境主版本)。目标目录:`<CompanyOS 安装>/resources/agent-kernel/`(版本子目录,支持并排回滚)。
- **版本清单(manifest,冻结字段)**:upstream repo/SHA/tag、profile 版本、node 版本、包面清单(=Profile Spec §3.1 分发面)、传递依赖锁切片、license 汇总+全部包级 LICENSE 文件、SBOM。
- **SBOM**:pnpm lockfile 切片(仅闭包包面)+ vendored 依赖(THIRD_PARTY_NOTICES 合并)。
- **首启健康检查**:kernel spawn→initialize/ping→版本回读=manifest 声明(不符=拒用+诊断)。
- 用户单动作:只安装 CompanyOS。无第二下载/第二桌面/手工 prompt 往返/会员。

## 4. 升级门(UPDATE GATE;任何 DSH 更新必须全过)

1. Exact upstream SHA 记录与 diff 范围;2. License 复核(含新增包);3. Third-party notice/SBOM 增量;4. **Package allowlist diff**(新包逐个裁决入/拒);5. **Denylist diff**(worldview 包不得潜入——含传递依赖扫描);6. 传递依赖 diff;7. 最小组合冒烟(research 目录重跑 §2 门);8. Model bridge 回归(pi-ai 路由 schema 变更检测);9. Secret 泄漏探针(env 注入面/日志回显);10. 工具限制回归(未挂载不可见/调用即拒);11. Workspace 逃逸探针;12. Process bounds;13. Cancel/kill-tree;14. Crash→uncertainty 语义;15. Windows 全项(SECURITY_BOUNDARY §6);16. Result mapping 回归;17. ExecutorProvider 契约套件(既有 dsh NDJSON 面);18. Real Agent smoke;19. SAFETY/安全通告审查(上游 experimental 声明跟踪);20. 性能/资源回归(内存/启动)。

## 5. 禁止自动更新(冻结)

生产禁 `latest`/`^`/`~`/独立 auto-update;**必须 exact pin**(manifest SHA+tag);更新=人工过 §4 全门后发新版本目录。

## 6. 本机版定位(LOCAL_COMPATIBILITY_SAMPLE)

本机 `0.1.6-max` 分发版仅用于最终兼容性对照(Stage 1 污染审计结论);不参与 profile 设计/依赖图/API/安全/模型缝的任何事实来源。

## 7. READY_TO_IMPLEMENT_EMBEDDED_KERNEL 判定(§38 十三项)

| 判定项 | 状态 |
|---|---|
| Package dependency closure known | YES(§3.5 闭包证据) |
| Worldview denylist complete | YES(Profile Spec §3.4) |
| Model ownership CompanyOS | YES(Bridge Spec,V1=OPTION B) |
| Secret ownership CompanyOS | YES(Bridge Spec §5) |
| Approval ownership CompanyOS | YES(Security Boundary §2 映射表) |
| Tool visibility controllable | YES(Profile Spec §4 机械链) |
| Workspace mechanically constrained | YES-设计(外层结构性+内层 fs-sandbox;Stage 4/5 实测) |
| Windows path/process semantics acceptable | YES-设计(windows-acl=诚实 PARTIAL;Landlock 不计入) |
| Minimal clean composition reproducible | YES(§2.1:dump-config 合成+实跑 PONG+中断收尾全过) |
| Managed runtime lifecycle defined | YES(Profile Spec §11) |
| Crash semantics defined | YES(Profile Spec §12) |
| Result mapping complete | YES(Profile Spec §9) |
| Upgrade gate complete | YES(§4 二十项) |
| Exit strategy PASS | YES(Profile Spec §14;anti-coupling 已证) |

**综合判定:YES(READY_TO_IMPLEMENT_EMBEDDED_KERNEL = YES)**——十三项全 YES;§2.1 门全 PASS;IMPLEMENTATION_BASELINE=研究基线(rc,升级门约束下使用)。
