# STAGE 5B — 嵌入式 Agent 安全闭合（实现与实测记录）

状态：实测完成；三个安全缺口如实上报（见 STAGE 5B 最终报告）。基线 `b10e515`。

## A. RUNTIME INTEGRITY — EXECUTION CLOSURE（已闭合）

### 分类器（`scripts/lib/runtime-execution-closure.mjs`）
从真实 package/runtime 图派生，非全树文件猜测：

1. **种子**：CLI 编译块 + 组合声明的包（bundle patch `name:`、JSON `"name":`、
   scoped 字面量 `bundles: [...]`）+ home/patch 模板。
2. **静态 import/require 追踪**（build output + 包根 JS，junction/realpath 感知）到不动点。
3. **每包保守联合**：整包 no-follow 遍历 + 分类器排除 docs/tests/maps/TS 源。
4. **native 绑定包**：.pnpm store 中被闭包包声明且含 `.node` 的包全树入闭包
   （native 按 dlopen 构造名解析，静态追踪天然不可见）。
5. **hoisted 宇宙**：`node_modules/.pnpm/node_modules`（261 文件）入闭包。
6. **junction links 表**：两个 node_modules 根枚举 reparse 条目（5,984 条），
   staged 树重建为**指向 stage 内部**的自包含链接。

分类：EXECUTABLE_CRITICAL（JS/MJS/CJS）、CONFIG_CRITICAL（package.json/JSON/非 i18n YAML）、
NATIVE_CRITICAL（.node/.exe/.dll/.ps1/.cmd/.bat）、NON_EXECUTION_ASSET（文档/测试/map/TS 源——不哈希不验证）。

### 生产闭包（当前 dev 树实测）
- **15,439 critical 文件**（exec 12,919 / config 1,497 / native 1,023），**samplingUsed=false**
- 709 个解析闭包包；5,984 条 junction 链接；manifest.json 记录 `closureGeneration = sha256(closure-manifest.json)`

### Resolver 门禁（`apps/desktop/src/executor/embedded-dsh-runtime.ts`）
1. **RESOLVE（每次调用）**：closure-manifest.json 字节哈希 === manifest.closureGeneration
   （单边篡改 = CLOSURE_DRIFT FAIL-LOUD）；samplingUsed=true 的闭包直接拒绝。
2. **ATTEMPT STAGE**：闭包全部文件复制到随机 stage + junction 重建 + **100% 闭包哈希验证**
   （链接必须指向 stage 内部，指向源树 = TAMPERED）。
3. **共享 stage 缓存（Boss §6 合法语义）**：键 = managedRoot + **closureGeneration**
   （可证明完整性版本，非路径）；每次 attempt 仍 100% verifyStaged；
   stage 被篡改 → 下次 attempt 门禁 FAIL；源树被篡改 → 篡改字节永不可执行
   （child 只读 stage）；重新物化（新 generation）→ 新 stage。
4. **pre/post-spawn 双门**（provider 层）：spawn 前后各 100% 验证一次。

### 已删除的旧机制
- ~~`integrityManifest` 全树清单~~（59,886 文件含 README/LICENSE/map——非执行资产混入）
- ~~10k 文件以上确定性抽样~~（Boss §4 明令禁止用于 critical runtime）
- ~~managedRoot 路径键控 verdict 缓存~~（verify-once/trust-forever）

## B. WINDOWS AGENTIC PROCESS BOUNDARY（实测，如实上报）

源码证据（`packages/sandbox/sandbox-windows-acl/src/runner.ts` + `sandbox-local`）：
- **owner = DSH windows-acl restricted-token runner**（WRITE_RESTRICTED token +
  workspace/temp capability-SID write 授权；enforcement 自报 **partial**）
- **管**：ACL 可寻址的写效果（workspace + 私有 temp 外的写被拒）
- **不管**：读（"reads stay unconfined"）、网络（"Network and process visibility are
  outside this vocabulary"）、NTFS hard-link 别名、AppContainer ACL 树不可读

实测（真实内核 + 可处置 canary，`tests/security-process-boundary.test.ts`）：
- **写越界（PS Set-Content/Copy-Item/New-Item/Remove-Item、Node fs.writeFileSync、git commit）= 全部 DENIED** ✓
- **读越界（PS Get-Content、cmd type、Node readFileSync）= POSSIBLE**（与源码文档一致）
- **外部网络（Invoke-WebRequest/curl.exe/Node http/Node net.Socket/git ls-remote →
  169.254.x canary）= 全部可达**（HTTP-OK CANARY-REACHED / TCP-DATA 200 OK 实证）
- **进程树**：cancel/timeout 后 Start-Process/Start-Job 后代存活（marker 残留 =1）
- **broker 路由可用性对照**：同一 invocation 内 session 协议推进 ✓（loopback broker 正常）

## C. JUNCTION/REPARSE TOCTOU（实测，如实上报）
- 静态 junction 写：DENIED ✓（Stage 5 结论保持）
- race 写新文件（20Hz/50Hz 翻转 ×30-40 次）：未逃逸
- **race 同名覆盖：逃逸**（write 工具穿透翻转中的 junction 将 outside canary 改写为 PWNED-1）
- race rename（pwsh Move-Item）：未逃逸
- 残余机制研究：fs-sandbox 是可信代码中的 policy check（源码自述"NOT a kernel boundary"）；
  write 工具运行于内核进程（非 restricted token），无 OS 级兜底 →
  **WINDOWS_REPARSE_TOCTOU_GAP**，交 Boss 裁定

## 测试资产
- `tests/security-agent-attack.test.ts`：18 用例（8 类篡改 + 缓存审计 + TOCTOU 双门 + 真实树 + 原有攻击）
- `tests/security-process-boundary.test.ts`：20 用例（文件 5 + 网络 5 + 进程树 5 + race 5）
- `tests/security-broker-security.test.ts`：7 用例（+token 复用/跨 attempt 回归）
- `tests/kernel/support/fixture-closure.ts`：fixture 闭包升级助手（复用生产派生器）
- `scripts/write-runtime-execution-closure.mjs`：已物化树原位升级（dev 便利；正式路径 = 重新物化）
