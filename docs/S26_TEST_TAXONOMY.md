# Sprint26 测试分类 — V4 确定性真理 vs 实时外部兼容性

## 分类原则（Boss V4 §6-§11）

Sprint26 完成了**确定性产品正确性**与**实时外部 provider 兼容性**的分离：

### 1. 确定性必需门禁（`pnpm check` — step 5 = `vitest run --exclude tests/provider/**`）

- ExecutorProvider 契约（S24/S25）
- 类型化配置 + 六阶段预检管道（S25）
- Provider 注册表 + 能力协商
- ExecutionAttempt 规范权威（S26）
- Provider dispatch settlement（S24）
- RunObservationService 只读投影（S23/S26）
- Product Control Plane provider-agnostic E2E（S26，3/3 tests）
- Provider swap proof（S26）
- 全部架构法则（ARCH-001..ARCH-036）
- S18-S26 完整回归（210 files / 2655 passing / 0 skips）

### 2. 实时外部 provider 兼容性（`pnpm test:provider:dsh:live`）

- 真实 DSH headless runtime 调用（3 smoke tests）
- 适配器能力真实性
- 会话续作证明
- 证据清理
- **当前状态**: BLOCKED_EXTERNAL_RUNTIME（DSH 0.1.6-max CLI 拒绝冻结的 `--json` 标志，启动时挂起）
- **历史事实**: Sprint24+Sprint25 在冻结时成功证明了 DSH 集成（记录在 S24_PROVIDER_EXECUTOR_RECON.md）
- 外部 provider 宕机/漂移**不**追溯否定 Product Control Plane 正确性

## 关键原则（V4 §9）

**仓库正确性 ≠ 外部 provider 当前可用性**。即使实时 DSH 兼容性探针报告 BLOCKED，Product Control Plane 语义仍然有效。

## DSH Runtime 身份审计（V4 §2-§4）

| 维度 | 冻结 S24 证据 | 当前 Runtime | 匹配 |
|------|--------------|-------------|------|
| **可执行路径** | `E:\DeepSeek.Harness\DeepSeek Harness\resources\node\node.exe` + `resources\runtime\lib\bin.js` | 相同 | **YES** |
| **版本** | 0.1.6-max | 0.1.6-max | **YES** |
| **bin.js SHA256** | （冻结时未记录） | `69c49c871735dc7ee81ec51f266bbec129f075fd5066e046374f4b13ab02a705` | UNKNOWN |
| **--help 包含 --json** | YES（S24 recon：`dsh --profile headless [--json]`） | **NO**（当前 `--help` 省略该标志） | **NO** |
| **--json 被接受** | YES（S24 实时探针成功） | **NO**（`error: unknown option '--json'`） | **NO** |
| **直接调用完成** | YES（S24/S25 smoke tests 通过） | **NO**（拒绝 `--json` 后挂起） | **NO** |

**分类**: **RUNTIME_INTERFACE_DRIFT**（V4 §4）。本地安装的 DSH runtime 在**相同版本标签**下经历了就地接口变更。CompanyOS 适配器代码保持不变且已冻结。这是外部 runtime 侧证据，不是 CompanyOS 适配器回归。

## 测试运行规则

1. **日常开发**: `pnpm check` — 确定性必需门禁，5 连续通过后方可提交
2. **外部兼容性**: `pnpm test:provider:dsh:live` — 实时 DSH provider 健康检查，独立于 pnpm check
3. **Live 结果分类**:
   - **PASS**: 本地 DSH 健康 + CompanyOS 兼容性完整
   - **FAIL**: CompanyOS 适配器回归破坏了先前工作的集成
   - **BLOCKED_EXTERNAL_RUNTIME**: 本地 DSH 接口变更或不可用
   - **BLOCKED_EXTERNAL_AUTH**: 认证/凭证缺失
   - **BLOCKED_EXTERNAL_NETWORK**: 网络/连接性需要但不可用

## 文档版本

V4 Final（2026-09-30）
