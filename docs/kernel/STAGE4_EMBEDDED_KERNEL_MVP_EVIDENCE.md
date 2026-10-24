# STAGE 4 — EMBEDDED DSH KERNEL MVP EVIDENCE(实现证据,lab-only)

> 基线 `60e896b`。本文件是 Stage 4 的仓内证据索引;**PRODUCTION_SECURITY_CERTIFIED = NO**(Stage 5 未执行)。
> 官方上游:pinned `639ed015397290b3745d163aafe02ffee4aa3f84`(`dsh-v0.2.0-rc.2`,MIT)。本机修改版 DSH/其 node_modules/~/.dsh/账号态**从未**被用作 runtime。

## 交付物

| 组件 | 位置 |
|---|---|
| 物化脚本(官方 pinned 源→构建→manifest+checksums;gitignore 产物) | `scripts/materialize-embedded-dsh.mjs` |
| 嵌入式运行时缝(manifest 校验/exact-pin checksum/fail-loud/**模型代理 broker**) | `apps/desktop/src/executor/embedded-dsh-runtime.ts` |
| 既有 S24 Provider 的嵌入式模式(**零第二 Provider**;envelope 全投影;kernel 诊断摘要经 artifactContent 合法缝) | `apps/desktop/src/executor/dsh-executor-provider.ts` |
| 生产接线(嵌入式默认;外部 runtime 仅显式 opt-in;typed config 只带非秘密身份字段;组合武装 timer) | `apps/desktop/src/core-services.ts` |
| 独立内核门(真实外部 runtime 套件,顺序执行) | `pnpm test:kernel`(`vitest.kernel.config.ts`) |
| 测试套件 | `tests/kernel/`(E2E/失败门/隔离证明/守卫 ×4 文件) |

## 关键裁定(实现中固化)

1. **复用既有 Provider**(§3):嵌入式=同一 `dsh-headless` 适配器的新 launch 模式,零 `EmbeddedDshExecutorProvider` 之类的第二 Provider;S24 冻结契约(argv/NDJSON/漂移签名/会话语义)全部保持——`tests/sprint24/` 52/52 全绿。
2. **密钥法**(§15):S25 的 secret-shaped env 拒绝(设计如此)使"把 key 放进子进程 env"不可行且不合法——**模型凭证经每调用 loopback 代理**注入上游 Authorization;内核只见本地 URL+非秘密常量。金丝雀扫描证明 key 零进入 durable 状态。
3. **§19 证明**:agent 声称成功≠CompanyOS 成功——E2E #2:坏实现+agent 文本"All tests pass"→agent 任务 DONE,但 canonical native verify 任务跑真实 `node test.js` 退出 1→**FAILED**;裁决权在真实测试证据。
4. **失败门**:取消(Signal→子树终止证明)/超时(组合武装 timer)/内核崩溃(会话后 exit 1→诚实失败,零伪造)/malformed NDJSON(`EXECUTOR_NDJSON_MALFORMED` typed,绝不猜成功)。
5. **隔离证明**:resolver 只认 managed root(exact-pin checksum);缺失=typed `EXECUTOR_EMBEDDED_RUNTIME_MISSING`(绝不 PATH fallback);外部模式仅 `COMPANYOS_DSH_EXTERNAL_RUNTIME=1` sentinel;守卫锁死(无 ~/.dsh/homedir/PATH dsh;worldview 包结构性缺席;Core/Engine 环零 kernel 名渗透)。
6. **Windows 实测**(§26,本机 Win11):全部 fixture 路径含空格+Unicode(`companyos kernel … 実験-`);真实 pwsh 工具调用;git repo fixture;进程树取消;临时工作区清理(容错)。

## 门禁记录(2026-10-01,本机 Windows 11)

- `pnpm test:kernel`:**17/17 × 5 连续**(顺序文件执行;一次并行轮的 flaky 后固化顺序)
- `pnpm check`:**5 连续 6×PASS**
- 确定性全套件:2752 用例零 skip(内核/provider 套件按纪律独立门)
- `pnpm test:scripts`:23/23;`git diff --check`:CLEAN
- **Live model operator smoke:`LIVE_MODEL_EXTERNAL_BLOCKED`**——本机无合法配置的真实模型 profile(BB-002 记录:待用户提供端点/key;不伪造 PASS)→ **STAGE_4_DECISION = DETERMINISTIC_EMBEDDING_READY**(非 REAL_AGENT_MVP_FULLY_PROVEN)
