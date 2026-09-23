# UI theme

Codex Live Viewer is a compact task monitor. It should feel calm while work is progressing and make changes in task state obvious without moving controls around.

## Typography

Use Segoe UI Variable, Segoe UI, or the platform system font for the interface. Use Cascadia Code or Consolas only for commands, IDs, and tool output.

| Use | Size | Weight |
|---|---:|---:|
| Selected task title and product title | 14 px | 650 |
| Feed content and search | 13 px | 400 |
| Session title | 12 px | 600 |
| Navigation, metadata, and controls | 11 px | 400 |
| Status and event labels | 10 px | 700 |

## Status colors

Status color has one meaning everywhere: list rows, filter chips, and the selected-task header.

| Status | Color | Behavior |
|---|---|---|
| Running | Blue `#67a8ff` | Circular spinner indicates active work |
| Waiting | Yellow `#e5b849` | Quiet for at least 20 seconds, no job evidence |
| Needs attention | Orange `#ee964b` | The job process died or its heartbeat stopped, or it failed. Sessions without a job never get this |
| Needs answer | Orange outline, `?` chip | The finished job's result asks a question (Needs decision) and no run on the thread is working |
| Finished | Green `#4ac26b` | Completion event received |
| Stopped | Gray: chip dot `#7b8794`, badge `#9fb0c3` on `#262d38` | Cancelled job or aborted turn. Not an alarm |
| Archived | Gray: chip dot `#9fb0c3`, badge `#9fb0c3` on `#262d38` (same badge as Stopped, lighter chip dot) | Not a task state |
| All | Blue `#67a8ff` (same as Running) | Neutral collection, not a task state |

Do not animate an entire row or badge. Only the small Running spinner moves.

## Geometry and spacing

- Header icon and follow controls are 32 px high.
- Feed toolbar controls and the sidebar tabs are 28 px high. Filter chips are 24 px pills.
- Controls within one row share the same vertical position.
- Corners use a 6 or 7 px radius; status badges remain pill-shaped.
- The session list starts at 340 px, can be resized from 240 px to 55% of the viewport, and remembers the chosen width.
- At 760 px and below, the session list becomes an overlay drawer over a backdrop; tapping the backdrop closes the drawer. The content remains a single full-width column, filter chips scroll sideways instead of wrapping, and the title and meta line wrap instead of being cut.
- The page must never create horizontal document scrolling. Long paths, commands, patches, and messages wrap inside their own container.

Compact spacing is the only layout. There is no separate Comfortable density.

## Navigation behavior

- The brand row's Start button opens one "Start Codex run" dialog with a Kind switch (Task, Review, Adversarial review) instead of three separate buttons. Fields hide per kind with the `hidden` attribute; the confirm button reads "Start task" or "Start review".
- One list of rows: a Codex session and the handoff jobs on its thread share one row. Rows show 3 lines: badges, title, project · model · effort · tokens. Full path, thread, sandbox, reason and job detail are in the row tooltip.
- Tabs Now, Handoffs, History sit in one fixed row. Each tab has filter chips with counts (Now: All, Running, Waiting, Needs attention, Needs answer; Handoffs: All, Running, Needs attention, Needs answer, Finished, Stopped; History: Finished, Stopped, Archived, Dismissed, Everything). Order and position never change when counts update.
- Choosing a tab or chip pauses auto-open (also closes the Now overview if it was open). A background update must not override an explicit choice.
- Auto-open is resumed only through its toggle, in the Now overview header ("Auto-open new runs: On/Off"). When resumed, it selects the newest Running task and shows Now/Running unless the current view already shows it.
- If the selected task itself changes status, the view moves to that status's chip (same tab first) so the selected row remains visible. History/Everything and Handoffs/All stay put.
- When the open task is not in the current view, a thin bar above the list says "Open: <title> (not in this view) · Show"; Show switches to a view that contains it.
- The Now overview (Needs answer, Needs attention, Running, Recently finished) shows when no task is open, and when the Now tab is clicked while already active. It replaces the old Home view; there is no separate Home button.
- Sidebar width, collapsed state, tab, chip, search, selected task, and auto-open persist in the browser. Old saved filters (and the old Home flag) map to a tab and chip on first load; the Now-overview flag itself is never persisted. There is no separate auto-scroll preference: following the feed is automatic (see Feed behavior).

## Menu behavior

- The task header's `...` menu and a row's right-click menu build from the same item list, grouped under small section labels: Resume (when the row is resumable), Job (Show full result, Cancel job…), Session (Dismiss task / Restore task), Terminal commands (Copy resume, Copy continue, Copy fork, Copy archive / Copy unarchive), Diagnostics (Show processes, Stop task process…, Windows only).
- Cancel job… and Stop task process… are the only dangerous entries; both ask for confirmation in-app and never fire from a single click.
- Escape closes the open menu, in addition to dialogs and the context menu.

## Feed behavior

- Commands, tool output, patches, and long messages start collapsed. Consecutive THINKING events group into one collapsed row ("Thinking · N steps · <first summary>"); expanding it shows each step.
- CODEX and USER messages, thinking steps, and the result card render a safe Markdown subset: headings, paragraphs, bold, italic, inline code, fenced code blocks, bullet and numbered lists, and block quotes. Links show as text plus the URL, never as a clickable link. Everything is built as DOM nodes with `textContent`; untrusted output never becomes `innerHTML`.
- "Show internals" reveals internal Codex events (injected prompts, permissions) and auto-expands patches; it replaces the old separate Raw log view.
- Render at most 160 events initially. Earlier events remain available through Show earlier activity, up to a 500-event cap.
- The feed follows new events automatically while the reader is already near the bottom, and pauses the moment they scroll up. A paused feed shows Jump to latest instead of a toggle.
- A task whose newest handoff run finished shows a Result card between the feed toolbar and the feed: Summary, Changed files, Checks run and Needs decision (or the plain answer), open by default and collapsible. Live feed updates never rebuild it, so a half-typed answer keeps its text, focus and cursor.
- "Show full result" (in the Result card, the header `...` menu, or a row's right-click menu) opens the job result dialog. It lists every run on the thread, newest first, so an earlier run stays reachable after a resume.
- The answer box shows only when the result asks a question and no run on the thread is working. "Answer and resume" opens the resume confirm prefilled with `Answer from the user: <text>`; nothing is sent without that confirm.

## Motion and accessibility

- Hover, selection, border, and color transitions use 140–180 ms.
- Buttons, tabs, chips, rows, and the resize separator must remain keyboard accessible.
- Focus uses a visible blue 2 px outline.
- `/` focuses search when no field already has focus. Arrow keys, plus Home and End, move focus within the tabs row and within the chips row. Escape closes the top layer first: an open dialog, then the `...`/context menu, then the mobile drawer; only the top-most one closes on a single press.
- Dangerous process controls stay inside the task-actions menu and require confirmation.
