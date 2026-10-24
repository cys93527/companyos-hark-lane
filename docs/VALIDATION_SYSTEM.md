# CompanyOS 验证系统

> 依据：规划书 §三十二（Validation System）、§二十一（QA）、§七原则 7（真实结果优先于 AI 自述）、
> §四十六（Git 策略）。
> 核心立场：**PASS 只能由可复现的真实结果给出，不能由任何模型的一句话给出。**

## Validator 类型

每个 Stage 可以定义 Validator（规划书 §三十二）。**Core 只认识 Validator 抽象**，
具体 Validator 属于 Industry Pack（规划书 §四 / §十五）。

| 层 | 内容 |
|---|---|
| Core | `Validation` 概念：`{ validatorId, stageId, targetArtifactIds, status, startedAt, finishedAt, exitCode, evidence }`——只描述结果，不包含行业逻辑 |
| DevCompany Pack（首个落地行业） | `UnitTestValidator`、`BuildValidator`、`LintValidator`、`TypecheckValidator`、`GitDiffValidator` |
| 未来 ContentCompany Pack | `FactCheckValidator`、`StyleValidator`、`PolicyValidator`、`FormattingValidator` |

通用要求：

- 每个 Validator 必须声明：输入（Artifact / 文件 / 命令）、期望结果、失败时的错误码、是否为阻塞门；
- Validator 必须**可重复执行**且结果确定；不确定性检查（如模型评审）只能作为**辅助信号**，
  不能替代命令级证据；
- Validator 的注册与版本随 Workflow Version 一起快照（`WORKFLOW_VERSIONING.md` §Run Snapshot）。

### DevCompany 的 Validator ↔ 真实命令（本仓库即已自证）

| Validator | 实际命令 | 通过标准 |
|---|---|---|
| LintValidator | `pnpm lint` | Exit Code 0，0 error |
| TypecheckValidator | `pnpm typecheck` | Exit Code 0，0 error |
| UnitTestValidator | `pnpm test` | Exit Code 0，0 failed |
| BuildValidator | `pnpm build` | Exit Code 0，产物存在（如 `apps/renderer/dist/index.html`） |
| GitDiffValidator | `git status --porcelain` / `git diff --stat` | 与预期 Diff 一致，无无关改动 |

## Quality Gate

质量门决定「能不能进入下一 Stage」以及「能不能 Commit」。

```text
Stage 产物
   │
   ├─ Validator 全部通过 ──────────────▶ 允许进入下一 Stage
   │
   └─ 任一阻塞 Validator 失败 ──▶ REWORK（自动返工，最多 3 次）──▶ 仍失败 ──▶ PAUSED（交 Chief / 用户）
```

- **进入下一 Stage 的门**：该 Stage 声明的所有阻塞 Validator 必须 PASS。
- **Commit 的门**（规划书 §四十六）：必须同时满足
  `Review PASS` + `QA PASS` + `Acceptance PASS` + `Expected Diff`，才允许 Commit。
- **MVP 策略**：允许自动 Commit，**禁止默认 Push**；生产部署（CRITICAL）永不自动执行。
- **QA Fail**（规划书 §六十 Case 5）：**禁止 Commit**，Run 不得进入 FINALIZING。
- **High/Critical 风险**：即使 Validator 通过，仍需按 Risk System 走审批（`SECURITY_MODEL.md`）。

### 与「AI 自述」的边界（规划书 §七原则 7）

| 不可作为 PASS 依据 | 可以作为 PASS 依据 |
|---|---|
| 「测试已经通过」 | `pnpm test` Exit Code 0 的输出 |
| 「代码没问题」 | Reviewer 结论 **+** Validation Result **+** Diff **+** Tool Result **+** Rule |
| 「我检查过了」 | Artifact 内容 / Audit 记录 / 命令 stdout |

Reviewer 的结论是**输入之一**，不是判决本身；判决由 Gate 规则给出。

## 结果记录

每次验证必须落盘（Sprint 13，表名 `validations`），以便回答「谁在什么时候用什么标准判定通过」。

| 字段 | 说明 |
|---|---|
| `id` | `val_<ULID>` |
| `stageId` / `runId` / `taskId` | 归属定位 |
| `validatorId` + `validatorVersion` | 哪个 Validator（含版本，随 Workflow Version 快照） |
| `command` | 实际执行的命令（可复制重跑） |
| `exitCode` | 数字；`null` 表示未执行完 |
| `stdoutDigest` | 输出摘要（可截断，但必须含关键行；禁止记录含密钥的内容） |
| `status` | `pass \| fail \| skipped \| error` |
| `durationMs` | 耗时 |
| `evidenceArtifactIds` | 证据产物引用（日志、报告、Diff） |
| `startedAt` / `finishedAt` | 时间区间 |
| `blocking` | 是否为阻塞门 |
| `waiver` | 若被人为豁免：`{ by, reason, approvedAt }`（必须留痕，不允许静默跳过） |

记录规则：

1. **不可变**：验证结果一经写入不得修改；重跑产生新记录并保留历史；
2. **可重放**：仅凭 `command` + 快照版本即可重放验证；
3. **脱敏**：日志与输出摘要遵循 `SECURITY_MODEL.md` 的脱敏规则；
4. **可审计**：与 `events`、`audit` 关联，形成完整证据链（规划书 §四十四）。
