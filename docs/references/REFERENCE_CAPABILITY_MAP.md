# CompanyOS — Reference Capability Map

> Companion to `REFERENCE_ADOPTION_POLICY.md`. Every row is backed by LOCAL
> CompanyOS documentation only (docs/, handoff notes, a Boss execution order).
> Where a name exists but its mechanism is not locally documented:
> `DETAILS_NOT_YET_VERIFIED` — nothing is invented here.

## Registered references

| Reference Project | Source / local note | Capability | Mechanism (as locally documented) | CompanyOS Mapping | Decision | Target Phase | Forbidden Copy | Status |
|---|---|---|---|---|---|---|---|---|
| DeepSeek Harness | `PROJECT_EXECUTION_HANDOFF_TO_CODEX.md` (the former executor handoff); Sprint23 order §7-§15 | Runtime observability patterns | durable-vs-projection separation; restart reconstruction from persisted facts; live-event ≠ durable state; event map; typed projection seam; runtime inspector; capability-graph presentation | `RunObservationService` / `TaskObservation` / `RunBlocker` / `TimelineEntry` projections over canonical SQLite truth | **ADAPT (SELECTIVE)** | Sprint 23 | Cordis as Core; DeepSeek Session as workflow truth; Agent Teams Task DAG/status; second queue/scheduler/state machine; "everything is a plugin" Core | ACTIVE (Sprint23) |
| Paperclip | `docs/sprint20/T20_07_SPRINT20_CLOSEOUT.md` §41; `docs/sprint21/S21_GENERIC_ORCHESTRATION.md` Paperclip section; Sprint23 order §16 | Control plane, executor adapters, governance, budgets, runtime visualization, parallel-agent locks | recorded as capability AREAS only (REFERENCE_NOT_FETCHED — no external access) | future Product Control Plane / executor-adapter separation; runtime-visibility presentation concepts | **DEFER** (reference only) | Product Control Plane | AI-employee product model; org-chart authority; second Task/Workflow/execution truth | REGISTERED, NOT ADOPTED |
| Hindsight | T20-07 §41 | learned long-term memory (retain/recall/reflect, observations, mental models) | capability note only | future memory layer — always behind ARCH-030 (Memory ≠ Authority) | **DEFER** | POST-V1 | any memory mutation of canonical truth without command paths | REGISTERED |
| StateComp | T20-07 §41 | context compression timing | capability note only | future context-budget refinement | **DEFER** | POST-V1 | — | REGISTERED |
| PaMER | T20-07 §41 | short/long-term memory + recall | capability note only | future memory layer | **DEFER** | POST-V1 | — | REGISTERED |
| DRSR | T20-07 §41 | safe context deletion / pruning | capability note only | future context lifecycle | **DEFER** | POST-V1 | — | REGISTERED |
| Orca | `docs/sprint20/T20_01_PLANNING_HANDOFF_RECON.md` §16-§17 (external research table) | obligations/evidence orchestration principles | obligations as checkable done-conditions; evidence requirements + reconciler; context projections; durable event log + resume | CONFIRMED the native design (Validation/EvidenceGuard/bounded projectors/durable ledger already cover it); obligations principle fed T20-01's goal→criteria compilation | **ADAPT (principle-level, already landed)** | Sprint 20 (done) | importing its orchestration runtime | CLOSED (landed in Sprint 20) |
| GitHub Spec Kit | T20_01 §"GitHub Spec Kit" | ordered-artifact + traceability principle | spec-driven ordered artifacts | plan-artifact chain + criterion traceability (T20-02/05) | **ADAPT (principle-level, already landed)** | Sprint 20 (done) | its tooling/runtime | CLOSED (landed in Sprint 20) |
| OpenAI Codex CLI | `docs/OPEN_SOURCE_RESEARCH.md` §1 | turn/item/delta event-stream protocol; apply-patch; approval×sandbox gates; session resume/fork | verified licence + architecture (Sprint 0 research) | RunSnapshot + audit event log design input; governance gate paradigm | **仅借鉴思想 / ADAPT (design input, landed)** | Sprint 0+ (landed) | Rust/TS runtime; Responses-API binding | CLOSED (landed) |
| OpenHands | OPEN_SOURCE_RESEARCH §2 | Action/Observation append-only EventStream; Runtime abstraction | verified research note | event-log/checkpoint reference; AgentRuntimePort validation | ADAPT (design input) | landed (S0 research) | Python web-app runtime | CLOSED |
| OpenAI Agents SDK | OPEN_SOURCE_RESEARCH §3 | Agent/Runner/Guardrail/Handoff four-piece contract | verified research note | future P1 runtime adapter candidate (`packages/adapters/*`) | **ADAPTER candidate (not started)** | P1+ | default tracing to OpenAI (privacy) | REGISTERED |
| LangGraph / MS Agent Framework / SWE-agent / MetaGPT / CrewAI | OPEN_SOURCE_RESEARCH §4-§8 | agent orchestration references | verified research notes | design cross-checks only | various (see §9 decision matrix) | as recorded | runtime adoption without adapter seam | REGISTERED |
| OpenMausBot | name appears in Sprint23 order §6 only; NO local technical note | — | — | — | — | — | — | **DETAILS_NOT_YET_VERIFIED** |

## Default Agentic Kernel Selection Sprint additions (2026-10-01; source-first: the LOCAL installed runtime + web-verified licenses)

| Source | Local evidence | Capability / mechanism | Decision | Detail |
|---|---|---|---|---|
| DeepSeek Harness (kernel-level read) | `E:\DeepSeek.Harness\...esourcesuntime` 全部 ~250 `@deepseek-ai/*` 包逐包 LICENSE=**MIT**;`dsh-llm` provider-neutral seam;`dsh-llm-pi-ai` OpenAI-compatible gateways/self-hosted/逐请求 provider;`dsh-tools` allow/deny/ask+per-agent 可见集;`dsh-sandbox-policy`(fail-safe read-only)/`dsh-fs-sandbox`/`dsh-sandbox-windows-acl`(诚实 partial);`dsh-user-approval` fail-closed;`dsh-agent-loop` turn/step/durable inbox/abort/并行调度;`dsh-compaction-*`/`dsh-spill`;`dsh-headless`/`dsh-sdk-minimal` | 默认内置 Agentic Kernel 候选(推荐 STRATEGY A:pinned runtime + CompanyOS 最小 kernel profile;世界观包 REJECT) | **CANDIDATE (RESEARCH-FROZEN, 未接入)** | 全量机制级裁决见 `docs/research/AGENT_RUNTIME_MECHANISM_MAP.md`;选型见 `docs/research/DEFAULT_AGENTIC_KERNEL_SELECTION.md` |
| OpenAI Codex CLI | web 核验:Apache-2.0,Rust `codex-rs`,原生 Windows elevated 沙箱,`model_providers` OpenAI 兼容自定义端点 | SE 机制(apply_patch 协议纪律/双门/事件流) | **REFERENCE (机制吸收;不作默认内核)** | 同上机制图 C 节 |
| ZCode | 本机 `D:\zcode` =专有 Electron GUI(app.asar;仅 Electron/Chromium 附带许可;无 CLI/自动化面) | 桌面/GUI 操作形态 | **FUTURE_DESKTOP_CAPABILITY (DEFER;无源不可嵌)** | 同上机制图 B 节 |
| OpenHands / Aider | web 核验:MIT(Docker 沙箱运行时)/ Apache-2.0(LiteLLM 100+ 模型) | 沙箱隔离形态 / 通用模型抽象层先例 | **DEFER / ADAPT(principle)** | 同上机制图 D 节 |

## Default Agentic Kernel Roadmap STAGE 1 — official upstream re-evaluation (2026-10-01; PINNED evidence, supersedes the local-sample rows above for architecture decisions)

| Source | Pinned evidence | Capability / mechanism | Decision | Detail |
|---|---|---|---|---|
| DeepSeek Harness (OFFICIAL) | `github.com/deepseek-ai/deepseek-harness` master@`639ed015397290b3745d163aafe02ffee4aa3f84` = tag `dsh-v0.2.0-rc.2`;根+逐包 **MIT**;`SAFETY.md` 自称 experimental/未审计 | 默认内核候选(全部关键机制在官方源复核成立:provider-neutral llm/pi-ai 网关/逐请求模型/allow-deny-ask/sandbox 族/user-approval fail-closed/sdk-minimal/headless;0.2.0 新增 account↔api-key 路线分包) | **DSH_MANAGED_MINIMAL_RUNTIME(推荐,待 Boss 复核)** | `docs/research/OFFICIAL_UPSTREAM_KERNEL_COMPARISON.md` |
| 本机 DSH 安装版 | 子包版本=官方 `dsh-v0.1.6-alpha.2` 构建;根 CLI `0.1.6-max` 发行后缀;符号级一致 | LOCAL_COMPATIBILITY_SAMPLE only(S24 NDJSON 契约实证保留为 local 证据;架构证据作废) | **DOWNGRADED(污染审计)** | `docs/research/LOCAL_DSH_CONTAMINATION_REPORT.md` |
| ZCode (OFFICIAL) | `github.com/zai-org/ZCode` main@`29628c9acdb81b703bbd4080c207a0e7ce5e276e` = `v3.14.3`;根 **Apache-2.0**;NOTICE 诚实声明无默认 OS 沙箱 | ModelSelection schema/权限规则引擎/turn 状态机/server stdio+http;自带 workflow-draft 世界观 | **第二机制源+未来第二 adapter 候选(非默认内核;世界观 REJECT)** | 同上比较文档 §1/§3;初版"专有"结论作废 |

## Kernel Roadmap STAGE 3 — DSH managed minimal kernel profile spec (2026-10-01; design-frozen, zero production)

| Source | Pinned evidence | Capability / mechanism | Decision | Detail |
|---|---|---|---|---|
| DSH (official, Stage 3) | fresh clone `dsh-repro` @ `639ed015…`(`dsh-v0.2.0-rc.2`);闭包脚本(硬17/含peer22/扩展55);`bundle/sdk-minimal` patch 全读;`user-approval` types(approval/request 瀑布);`llm-pi-ai` 路由 schema;`DSH_HOME` env;**可复现门全 PASS**(install 59.4s/官方构建 exit 0/companyos-minimal profile 实跑 final=PONG/exit 0/零告警/SIGINT→typed TRANSPORT) | MINIMAL profile 规格(包分类/worldview denylist/工具允许表/BYO-only 模型桥 OPTION B/审批 enforcement-only 映射/双层安全/生命周期/错误与结果归一/分发升级门/退出策略);**READY_TO_IMPLEMENT_EMBEDDED_KERNEL=YES**;IMPLEMENTATION_BASELINE=research baseline(rc,升级门约束) | **SPEC FROZEN(待 Boss 批 Stage 4)** | `docs/architecture/DSH_DEFAULT_KERNEL_PROFILE_SPEC.md`(+MODEL_BRIDGE/SECURITY_BOUNDARY/DISTRIBUTION_UPDATE 三份);研究原型在仓外 `kernel-research/gate/` |

## Sprint24 final closeout distinctions (Boss V2 §28 — per the LOCAL installed runtime)

| Mechanism | Local evidence | Decision |
|---|---|---|
| Durable Session identity | probe: `session-…` id adopted across separate CLI processes; `~/.dsh/sessions/<cwd>/<sessionId>/` persists a `session.v3.jsonl.zstd` log | ADAPTED (binding column `provider_session_id`) |
| Session continuation | probe: `--session-id session-c4fc3746…` in a NEW CLI process emitted `turn_start turn:2` and answered "MARBLE" from turn 1's memory | ADAPTED (capability `session-continuation`; continuation is DELIBERATE new work, never auto-replay) |
| Provider invocation identity | probe: NDJSON exposes only `sessionId` + turn/step NUMBERS (sequence, not stable ids); no per-invocation id exists | UNSUPPORTED (`provider_invocation_id` stays null without provider evidence) |
| Same-invocation query | probe: the installed CLI surface is only `--json`/`--session-id`/task; no query/list/tail command exists | UNSUPPORTED (capability `status-query` NOT advertised) |
| Same-invocation recovery | no invocation identity and no query ⇒ nothing to reattach to | UNSUPPORTED (capability `same-invocation-recovery` NOT advertised; C2 therefore does not apply) |
| Provider idempotency | probe: each headless invocation without `--session-id` mints a NEW session; no idempotency key accepted | UNSUPPORTED (deterministic CompanyOS dispatchKey remains OUR binding identity only) |

Only the mechanisms above are marked ADAPTED because only they are both proven by the
INSTALLED runtime and implemented in CompanyOS source. Anything the newest upstream may
additionally expose is deliberately NOT marked (§32: no upstream substitution).

## Sprint24 status view (Boss §55)

- **DeepSeek Harness**: SELECTIVE ADAPTATION DEEPENED — implemented mechanisms:
  capability seam (ExecutorProvider contract → implementation → engine consumer),
  named providers behind one registry (implementation discovery only), fail-loud
  capability advertisement + required⊆provider negotiation, published-run boundary
  (real external identity only from evidence), durable identity vs live activation
  (ExecutionAttempt durable; process handle live), single cancellation channel
  (AbortSignal), no second queue, accepted-run ownership. **The installed runtime is
  itself the selected REAL provider** (`dsh --profile headless --json`, 3 live
  invocations + session-resume recovery probe; local install only, no GitHub
  newer-version fetch per Boss ruling).
- **Explicitly rejected (Sprint24)**: Cordis as Core; DeepSeek Session as CompanyOS
  workflow truth; Agent Teams Task DAG/status; second queue/scheduler/state machine;
  provider-side exactly-once claims (provider supports none — never invented).
- **Paperclip**: DEFER (control-plane/governance presentation later).
- **Memory projects**: DEFER (Memory != execution authority).

## Sprint23 status view (Boss §54)

- **DeepSeek Harness**: SELECTIVE ADAPTATION — the six translated mechanisms
  (durable-vs-projection, restart reconstruction, live-event model, event map,
  projection seam, runtime inspector) are specified in
  `docs/sprint23/S23_MINIMAL_OBSERVABILITY.md`. No dependency, no Cordis, no
  Session-as-truth, no Agent Teams DAG.
- **Paperclip**: future/limited reference (REFERENCE_NOT_FETCHED).
- **Memory projects (Hindsight/StateComp/PaMER/DRSR)**: DEFER — Minimal
  Observability is not long-term memory; ARCH-030 stands.
- **OpenMausBot**: DETAILS_NOT_YET_VERIFIED.
## Sprint 26 dispositions

| Reference | Mechanism | Disposition |
|---|---|---|
| Paperclip | operational control surface | ADAPT — Goal Workspace + Run Control Plane |
| Paperclip | governance/approval surface | ADAPT — existing Decision/Approval authority |
| Paperclip | runtime status | ADAPT — RunObservationService |
| Paperclip | cost/budget visibility | DEFER — no canonical cost truth; no fake estimates |
| Paperclip | AI employee org-chart authority | REJECT |
| Paperclip | Task/workflow/agent truth | REJECT |
| DeepSeek Harness | durable/live separation, session diagnostics | ADAPT/REFERENCE (Sprint24 stance, reused by the Run View) |
| DeepSeek Harness | product dependency | REJECT — the Control Plane is provider-agnostic; local availability is an optional compatibility probe |
| Backlog | latest-official-DSH architecture study | DEFERRED RESEARCH TASK — LATEST_DEEPSEEK_HARNESS_ARCHITECTURE_RECON (read-only, after Sprint26 freeze) |
