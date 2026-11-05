# UI 视觉重做「纸与墨」/ Paper-Ink UI redesign (2026-11-05)

提交 / Commit: `38071cf` (branch `ui/paper-ink`, fast-forwarded into `hark-lane` on top of v0.1.2 `fbd139c`). Version unchanged (0.1.2); no tag/release.
交互审计全文 / Full interaction audit: [UI_AUDIT_INTERACTION.md](./UI_AUDIT_INTERACTION.md).

## 设计方向 / Direction
暖灰纸面 + 墨黑文字 + 唯一强调色「朱」。层级靠字重、字号、灰度和 1px 细线，不靠卡片和阴影。
朱色只有一个含义：这件事是活的，或者需要你（执行中、等待批准、阻塞、当前目标），其余全部是墨色。
Warm paper surfaces, ink text, a single vermilion accent that only means "live or needs you". No gradients, large rounded cards, shadows, glass, emoji, purple/blue "AI colours", coloured status badges or percentage animations.

## Tokens（摘要 / summary，`apps/renderer/src/styles.css :root`）
| token | hex | use |
|---|---|---|
| `--paper-0..3` | `#F7F5F1` `#F1EEE9` `#E9E5DE` `#E0DBD2` | reading pane / app bg & run view / sidebar & hover / selected & pressed |
| `--ink-1..4` | `#1C1B19` `#4B4842` `#77736B` `#A29D93` | text & primary button / secondary text / meta (≥4.5:1) / PENDING glyphs & disabled only |
| `--rule` / `--rule-strong` | `#DDD8CF` / `#C9C3B8` | 1px dividers / input & secondary-button borders, kbd |
| `--accent` / `--accent-ink` / `--accent-wash` | `#B3412A` / `#8E3220` / `#F3E4DD` | 朱 glyphs & bars / accent text / approval & blocked strip bg only |
| composer bg | `#FFFEFC` | the only surface lighter than paper |

- 字体 / Fonts: Segoe UI Variable Text → Segoe UI → Microsoft YaHei UI → PingFang SC → Noto Sans CJK SC; mono Cascadia Mono → Consolas; global `tnum`.
- 字号 / Type scale: Display 28/600 (budget, ≤1 per screen) · H1 22/700 · phase 16/600 · body 14/1.6 · small 13 · meta 12 · label 11/600 +.08em · mono 12–12.5.
- 间距 / Spacing 4·8·12·16·24·32·48; layout sidebar 232 · centre max 720 (40 padding) · run view 344; top bar 44.
- 圆角 / Radius 4px (buttons, rows, kbd), 6px composer only; borders 1px `--rule`; no shadows; accent bars 2px.
- 任务状态 / Task states: shape + word, colour only for live states (DONE ink disc+tick, EXECUTING/AWAITING accent, PENDING ink-4 hollow circle, FAILED ink square — no red, CANCELLED hollow square).

## UI-AUDIT 发现与修复 / Findings and fixes
| id | 修复 / fix |
|---|---|
| 01 | Ctrl/⌘+Enter 发送，Enter 换行；IME `isComposing`/keyCode 229 不发送 |
| 02 | 空白输入不可发送（按钮与快捷键同一判定） |
| 03 | 新建目标保留未确认提交与草稿，避免重复 Goal |
| 04 | `approval.respond` 携带 `approvalId`；过期审批 → `CONFLICT APPROVAL_STALE`（main） |
| 05 | Goal 取消后批准 → `CANCELLED APPROVAL_GOAL_CANCELLED`；UI 只展示「无需处理」 |
| 06 | 批准单飞守卫（双击只发一次） |
| 07 | 审批卡聚焦一次、主/次按钮、风险 低/中/高；无批准快捷键 |
| 08 | 取消确认说明待批准操作不会执行；默认焦点「继续执行」；Esc 关闭 |
| 09 | 数据库失败横幅在所有视图显示，发送禁用并给出原因 |
| 10 | 打开的 Goal 不在最近列表时仍显示其 canonical objective |
| 11 | 首页（开始 + 列表）与 对话与任务（打开的 Goal）拆分，发送后自动进入新 Goal |
| 12 | 最近列表最新在前（≤30），中文状态词 |
| 13 | 模型卡仅在需要时显示；配置指引指向「CompanyOS 首次配置」 |
| 14 | 设置页中文标签，未知值 `--` |
| 15 | 运行面板默认展开，折叠按钮 `aria-expanded` |
| 19 | 运行中 Goal 结果显示「进行中」而非「未交付」 |
| 22 | `decisions.pending` 分页遍历全部 run（main） |
| 23 | 全局 Ctrl/⌘+N 新建目标 |
| 25 | 提交中输入框 readOnly（保留焦点） |
| 26 | 会话费用取自 main 的 canonical usage（币种、`≈` 估算、不可证明 `--`），`format.ts sessionCostText` |

测试 / Tests: `apps/renderer/tests/ui-paper-ink-interaction.test.ts`, `tests/hark/ui-paper-ink-control-plane.test.ts`.
状态 / Status: Hark self-review only; no real model calls; real-PC acceptance and independent review NOT RUN.
