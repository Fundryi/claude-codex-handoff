# Stuck-Session Handling — Design

Date: 2026-07-12
Status: Approved by user

## Goal

Make the viewer genuinely useful when a Codex session is stuck:

1. Safe, informative Stop Task flow (in-app detail modal + confirm, no `window.confirm`/`alert`).
2. Explain WHY a session shows "Waiting" (IDLE) or "Possibly stuck" (STALE).
3. More copy-command actions so the user can actually continue/fix a stuck job.

Hard constraint: the viewer stays **read-only**. It never spawns codex, never
writes to session files. New actions are clipboard-copy only. (User-confirmed
decision; rejects one-click headless continue and open-terminal options.)

## 1. Stop Task — detail modal

Current: action menu → "Stop task process…" → process panel lists codex
processes (from `/procs`), each row has a STOP button guarded only by native
`window.confirm`, result via `window.alert`.

New:

- Keep the process panel listing (sorted by closeness to session start).
- STOP on a row opens an in-app modal (`<dialog>` or fixed overlay, matching
  UI theme in `docs/UI-THEME.md`) showing:
  - Task title + project name (from selected session)
  - PID, process name, process start time
  - Full command line (monospace, wrapping)
  - Start-time match quality: "Started within Ns of this task" or warning
    "Does not match this task's start time"
  - **Red warning** when the command line matches `app-server` or `mcp`:
    shared process hosting multiple tasks; stopping kills all of them.
  - **Yellow warning** when no close start-time match (< 15 s) exists:
    session process likely already exited.
- Buttons: red "Stop process" (calls existing `POST /kill?pid=`) and "Cancel".
- Kill result (success/error text) is rendered inside the modal/panel, not
  `window.alert`.
- Server kill logic unchanged (`codex-live-viewer.js` already re-verifies the
  PID is a codex process before `taskkill /PID <pid> /T /F`).

## 2. Waiting status insight

Current: `sessionSummary()` sends `lastEvent` (pre-formatted string
`"kind: text"`). UI shows generic tooltip only.

New:

- `sessionSummary()` in `codex-live-viewer.js` adds structured fields:
  - `quietMs`: `Date.now() - s.lastGrow`
  - `lastKind`: kind of last event ("cmd", "think", "out", "user", "agent", …)
  - `lastText`: last event text, truncated ~120 chars
  - Keep `lastEvent` for backward compatibility (fallback UI uses it).
- UI (viewer-ui.html): when selected session is IDLE or STALE, the task header
  shows a reason line, e.g.
  `Waiting 3m 12s — last activity: running command "npm test"`.
  Kind → phrase mapping:
  - `cmd` → `running command "<text>"` (likely a long/quiet command)
  - `out` → `processing command output`
  - `think` → `thinking (reasoning summary in progress)`
  - `tool` → `tool call "<text>"`
  - `user` → `prompt sent, no agent response yet`
  - `agent` → `agent replied — may be waiting for approval or next instruction`
  - fallback → last event text
- Same reason text goes into the status badge `title` tooltip in the session
  list rows.
- Duration formatted `Xs` / `Xm Ys` / `Xh Ym`, updates with the existing 10 s
  re-render interval.

## 3. Action menu — more copy commands

Current: "Copy resume command" → `codex resume <threadId>`.

New menu (all clipboard-only, hidden when no threadId):

- **Copy resume command** (existing): `codex resume <threadId>`
  — opens interactive TUI on the old conversation.
- **Copy continue command** (new):
  `codex exec resume <threadId> "Continue the previous task where it left off and finish it."`
  — headless continue; the actual "fix stuck job" command.
- **Copy fork command** (new): `codex fork <threadId>`
  — safe experiment on a copy; original session untouched.

Uses the existing `copyText()` helper with per-button success labels.

## 4. README

- Document the new action menu entries.
- Add a short "Recovering a stuck session" recipe: check the Waiting reason →
  stop the matching process via the detail modal → paste
  `codex exec resume <id> "..."` to continue (verified against
  codex-cli 0.144.1).
- Update the safer-stop bullet points (detail modal, shared-process warning).

## Testing

- Extend `tests/viewer-ui-state.test.js` (Node, zero-dep) covering:
  - waiting-reason phrase mapping (kind → text) and duration formatting
  - stop-modal warning logic (shared-process detection, start-time match)
  - continue/fork command string construction
- Logic under test must be factored into small pure functions in
  viewer-ui.html script (same pattern the existing tests use).

## Out of scope

- Viewer spawning codex (rejected — stays read-only)
- Archive/delete session buttons
- Embedded fallback page inside codex-live-viewer.js (unchanged, compatibility
  only)
- Non-Windows process stop
