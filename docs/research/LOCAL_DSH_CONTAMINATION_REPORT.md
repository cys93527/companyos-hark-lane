# LOCAL DSH CONTAMINATION REPORT — 本机安装版证据污染审计(Stage 1)

> 目的:按 Boss Stage 1 令,把上一轮 DeepSeek Harness 研究中"本机已修改桌面版"的证据降级为
> **LOCAL_COMPATIBILITY_SAMPLE**,并量化它与官方上游的差异,划清哪些结论保留、哪些必须重证。
> 基线 `b34f02f`。官方对照:`OFFICIAL_UPSTREAM_KERNEL_COMPARISON.md` §0 钉住的证据。

---

## 1. 本机安装版是什么(实证)

- 位置:`E:\DeepSeek.Harness\DeepSeek Harness\resources\runtime`(node 运行时+npm 树)+桌面壳(Electron,仅附 Electron/Chromium 许可)。
- 根 CLI 包:`@deepseek-ai/dsh` **`0.1.6-max`**。
- 子包版本抽验:`@deepseek-ai/dsh-agent-loop` = **`0.1.6-alpha.2`**(与官方 tag `dsh-v0.1.6-alpha.2` 精确一致)。
- 形态:官方仓携带 **TypeScript 源**(`packages/<domain>/<pkg>/src/`);本机是**编译产物**(`lib/*.js`,publish 构建输出)。
- 符号级一致性抽查(官方 0.1.6-alpha.2 `src` vs 本机 `lib`):
  - `maxParallelToolCalls`:官方 src 命中 2 文件 / 本机 lib 命中 11 处 ✅
  - `TOOL_ABORTED_BEFORE_DISPATCH`:1 文件 / 2 处 ✅
  - `agent/inbox/spliced`(durable inbox 事件):1 文件 / 2 处 ✅
- **结论:本机版=官方 tag `dsh-v0.1.6-alpha.2` 的构建分发包,根版本后缀 `-max` 为发行变体标记(官方 tag 体系中不存在),未见源码篡改迹象。**

## 2. 与官方上游的差异清单

| 维度 | 本机(LOCAL sample) | 官方(PINNED `639ed01`/`dsh-v0.2.0-rc.2`) | 性质 |
|---|---|---|---|
| 版本线 | 0.1.6-alpha.2 构建(根 `-max`) | 0.2.0-rc.2(其间还有 0.1.7-rc.2) | **落后两个 minor 线** |
| 包布局 | 扁平 `dsh-*` npm 包名(node_modules 展平 ~250 项) | 域目录 `packages/<domain>/<pkg>`(~320 包) | **上游大重构**(名字未变,位置变了) |
| DeepSeek 模型路线 | `dsh-llm-deepseek`(单一包) | 拆为 `llm-deepseek-account` 与 **`llm-deepseek-api-key`** | 架构演进(BYO-key 分包,利好) |
| session format | 至 v3(`session-format-v2-to-v3` 在本机清单) | 至 **v4**(`v3-to-v4` 在官方) | 演进 |
| 分发后缀 | 根 `0.1.6-max` | 无 `-max` tag | 发行变体标记 |
| 安装级注入(历史已知) | `INSTALLATION_OWNED_PROFILE_TUPLES` 把 web-app 注入具名 headless profile(见 `docs/provider-recovery/DSH_CURRENT_RUNTIME_RECON.md`) | n/a(安装配置,非源码改动) | **本地配置污染**(S24 侦察已裁定 profileName 配置层修复) |

## 3. 证据等级重划(哪些结论保留/重证)

### 3.1 保留为 LOCAL_COMPATIBILITY_SAMPLE(只证明"本机构建的行为")
- S24 冻结的 `dsh-headless` NDJSON 契约实证(PONG 3/3、session 续作、无 invocation-id/无 status-query/无 same-invocation-recovery/无 provider idempotency)——**全部是对该安装版的探针结论**;
- `REFERENCE_CAPABILITY_MAP.md` Sprint24 区段的 probe 行(保持原状,标注为 local);
- 本机 auth 失效(OPTIONAL_PROVIDER_UNAVAILABLE_AUTH)——运营事实,与上游架构无关。

### 3.2 已在官方源重新证实(上轮结论升级为 UPSTREAM 证据)
- MIT 逐包许可;`dsh-llm` provider-neutral seam;`dsh-llm-pi-ai` OpenAI 兼容网关/自托管/逐请求路由;`dsh-tools` allow/deny/ask+per-agent 可见集;`sandbox-policy` fail-safe read-only;`fs-sandbox` 三模式;`sandbox-windows-acl` partial 诚实披露;`user-approval` fail-closed;`bundle/sdk-minimal`(模型来自 SDK init);`bundle/headless` one-shot NDJSON。
- 官方新增事实:`SAFETY.md` experimental/未审计声明;account/api-key 路线分包。

### 3.3 必须重证/作废
- 任何以本机包路径/版本号写死的引用(上轮研究文档中的 `node_modules/@deepseek-ai/...` 路径)→ 已在本轮文档改为官方域目录路径;
- **上轮"ZCode 专有无源"结论作废**(根因:只查本机桌面分发,未查官方仓库;官方 `zai-org/ZCode` 为 Apache-2.0 全源)。

## 4. 对后续 Stage 的约束(进入 Stage 3 前提)

1. Kernel 锚点=**官方 tag**(pinned SHA),永不以本机 `-max` 分发版为架构依据;
2. S24 契约升级门必须设计"官方新版本 NDJSON 契约回归"步骤(本机版证过的行为在上游新版本需重跑);
3. 本机安装保留唯一用途:LOCAL_COMPATIBILITY_SAMPLE(CompanyOS 桌面同机共存的兼容性探针),不参与选型证据;
4. 上游 experimental 声明(SAFETY.md)进入 Profile Spec 风险节与升级门(安全通告跟踪)。
