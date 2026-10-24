# CompanyOS Desktop Client — STAGE 1

Status: IMPLEMENTED (canonical Goal loop + durable rehydration)
Stage: 1 of N — minimum usable product shell; NOT the full final UI.
This document describes the client. It is documentation, NOT runtime truth.

---

## 1. Architecture

```
Renderer (apps/renderer, React 19 + Vite, UNTRUSTED)
    ↓  window.companyos.* (typed preload bridge, sandboxed, allow-listed)
Preload (apps/desktop/preload/preload.cjs — CommonJS, channel allow-list)
    ↓  ipcMain.handle (allow-listed channels only)
Electron Main (apps/desktop/src/main.ts — Application Facade)
    ↓  composeCoreServices + repositoryRuntime.openWorkspace (existing seams)
CompanyOS runtime (control-plane service, observation service, canonical persistence)
```

- The renderer holds ZERO canonical truth: no Goal/Run/Task/Validation/Outcome state.
- All operational state re-reads from canonical durable truth on every bounded poll.
- The renderer never opens SQLite, never imports Node built-ins or Electron
  (enforced by `apps/renderer/tests/no-node-builtins.test.ts`), never sees provider
  credentials (vault stays main-process), never spawns processes, never settles runs.

## 2. IPC contract (delta over Sprint 0/5/26)

| Channel | Direction | Purpose |
|---|---|---|
| `companyos:control-plane` | renderer → main | goal.create / goal.advance / approval.respond / home.summary / goal.workspace / run.overview / run.blockers / run.timeline / run.task / run.artifacts / decisions.pending (unchanged from Sprint 26) |
| `companyos:workspace-select` | renderer → main | Opens the NATIVE directory chooser; resolves the chosen absolute path or null (cancelled). No values are passed in. |
| `companyos:workspace-open` | renderer → main | Validates the chosen directory (exists + is a directory) and opens it through the ONE trusted seam `repositoryRuntime.openWorkspace({root, commandProfile:{}})`. Persists the selection (operational context) to `userData/workspace-selection.json`. |
| `companyos:workspace-current` | renderer → main | Returns the currently opened workspace path (opened now, or the persisted selection re-offered after restart), or null. |

All three are in the allow-list (`channels.ts` + `preload.cjs`, drift-guarded by
`apps/desktop/tests/channels.test.ts`). No shell/process execution is exposed.

## 3. Canonical command/query seams

Commands (renderer → canonical service):
- Workspace: `workspaceSelect` (native chooser) + `workspaceOpen` (trusted seam).
- Goal: `controlPlaneRequest({operation:'goal.create', payload:{companyId, objective, commandId}})`.
- Pipeline: `goal.advance` (manual Stage-1 button; bounded canonical steps).
- Approvals: `approval.respond` (existing surface, unchanged).

Queries (read-only projections of canonical truth):
- `home.summary` — recent goals (objective/state/createdAt).
- `goal.workspace` — goal + planning run + overview + blockers + execution runs.
- `run.overview` — state/failureReason/taskSummary/attempts/validation/progress/artifacts/handoffCount.
- `run.artifacts` — canonical deliverable artifact references (ids + kinds; never content copies).
- `run.blockers` / `run.timeline` / `run.task` / `decisions.pending` — existing.

## 4. Implemented screens

- **Workspace selector** (shell-top): current workspace path or empty state; Browse →
  native chooser → validated open. Goal submission is DISABLED until a workspace is
  opened — no hidden fallback to any directory.
- **Goal entry**: multi-line natural-language textarea; `开始目标` disabled until
  workspace ready AND text non-empty. Stable per-entry command id (double-click replays
  the same canonical goal — no duplicate).
- **Recent goals list**: objective, state badge (canonical lifecycle states only),
  short stable run id, createdAt; newest-first; bounded poll ONLY while a goal is
  non-terminal.
- **Goal detail** (`goal.workspace` + `run.overview` + `run.artifacts`): canonical
  state, failureReason (when failed), task progress (done/total — never a percentage),
  attempt summary (completed/failed/active), validation summary (validator/status,
  missing validators), deliverable artifact refs + handoff count on terminal, execution
  runs, blockers.
- **Failure view**: FAILED stays FAILED with the canonical failureReason; explicit
  banner ("该目标已失败…不会自动重跑"); no softening, no auto-rerun, no auto-hide.
  Retry controls are intentionally absent in Stage 1.

## 5. Restart semantics

- Goals/runs/tasks/validations/outcomes are canonical durable truth — nothing to
  "rehydrate"; the client just re-reads `home.summary`/`goal.workspace` on launch.
- The workspace selection is operational context: persisted to
  `userData/workspace-selection.json` (main-process only) and re-opened at quiescent
  startup through the same trusted seam. A vanished directory downgrades to a cleared
  selection (the UI asks again) — no hidden fallback, no error-loop.
- No in-memory-only Goal list exists.

## 6. Security boundary

- Renderer: no Node built-ins, no Electron, no SQLite, no secrets (all enforced:
  import-hygiene suite + sandboxed preload + channel allow-list).
- Main: vault/credentials never cross IPC; logs redact; directory access only through
  the workspace seam; provider settings intentionally absent in Stage 1.
- Provider API keys live in the vault/main process only.

## 7. Known Stage-1 limitations

1. Manual `继续推进` button drives `goal.advance` (Stage 2 targets automatic
   background advance so the loop runs end-to-end without the button).
2. Bounded 4s polling (no push/events yet — existing subscription mechanism pending).
3. Workspace selection is single-directory; no multi-workspace administration.
4. Detail view is list-based; no runtime visualization/graph (Stage 2).
5. Retry/cancel controls absent (intentional — canonical semantics first).
6. The desktop Goal loop requires the operator env (model endpoint + credential) —
   provider credential configuration UI is explicitly out of Stage 1 scope.

## 8. Stage-2 handoff

- Runtime view: live attempt timeline, per-task detail, artifacts-by-task.
- Automatic advance loop (background `goal.advance` scheduling) with explicit
  user-visible pause — no second scheduler: it calls the same canonical seam.
- Approval center on `decisions.pending`.
- Push-based refresh if an event/subscription seam lands in the runtime.
