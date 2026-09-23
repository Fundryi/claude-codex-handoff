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
| Waiting | Yellow `#e5b849` | Quiet for at least 20 seconds |
| Possibly stuck | Orange `#ee964b` | The job process died or its heartbeat stopped. Sessions without a job never get this |
| Finished | Green `#4ac26b` | Completion event received |
| Stopped | Gray: chip dot `#7b8794`, badge `#9fb0c3` on `#262d38` (the Archived badge) | Cancelled job or aborted turn. Not an alarm |
| All | Gray `#7b8794` | Neutral collection, not a task state |

Do not animate an entire row or badge. Only the small Running spinner moves.

## Geometry and spacing

- Header icon and follow controls are 32 px high.
- Feed toolbar controls and the sidebar tabs are 28 px high. Filter chips are 24 px pills.
- Controls within one row share the same vertical position.
- Corners use a 6 or 7 px radius; status badges remain pill-shaped.
- The session list starts at 340 px, can be resized from 240 px to 55% of the viewport, and remembers the chosen width.
- At 760 px and below, the session list becomes an overlay drawer and the content remains a single full-width column.
- The page must never create horizontal document scrolling. Long paths, commands, patches, and messages wrap inside their own container.

Compact spacing is the only layout. There is no separate Comfortable density.

## Navigation behavior

- One list of rows: a Codex session and the handoff jobs on its thread share one row. Rows show 3 lines: badges, title, project · model · effort · tokens. Full path, thread, sandbox, reason and job detail are in the row tooltip.
- Tabs Now, Handoffs, History sit in one fixed row. Each tab has filter chips with counts (Now: All, Running, Waiting, Needs attention, Needs answer; Handoffs: All, Running, Needs attention, Needs answer, Finished, Stopped; History: Finished, Stopped, Archived, Dismissed, Everything). Order and position never change when counts update.
- Choosing a tab or chip pauses auto-open (also closes the Now overview if it was open). A background update must not override an explicit choice.
- Auto-open is resumed only through its toggle, in the Now overview header ("Auto-open new runs: On/Off"). When resumed, it selects the newest Running task and shows Now/Running unless the current view already shows it.
- If the selected task itself changes status, the view moves to that status's chip (same tab first) so the selected row remains visible. History/Everything and Handoffs/All stay put.
- When the open task is not in the current view, a thin bar above the list says "Open: <title> (not in this view) · Show"; Show switches to a view that contains it.
- The Now overview (Needs answer, Needs attention, Running, Recently finished) shows when no task is open, and when the Now tab is clicked while already active. It replaces the old Home view; there is no separate Home button.
- Sidebar width, collapsed state, tab, chip, search, feed view, selected task, auto-open, and auto-scroll persist in the browser. Old saved filters (and the old Home flag) map to a tab and chip on first load; the Now-overview flag itself is never persisted.

## Feed behavior

- Activity is the default and hides internal instruction dumps.
- Raw log exposes all events for diagnosis.
- Commands, tool output, thinking, patches, and long messages start collapsed.
- Render at most 160 Activity events or 80 Raw events initially. Earlier events remain available through Show earlier activity.
- Auto-scroll follows new events only while the reader is already near the bottom. Otherwise show Jump to latest.
- A task whose newest handoff run finished shows a Result card between the feed toolbar and the feed: Summary, Changed files, Checks run and Needs decision (or the plain answer), open by default and collapsible. Live feed updates never rebuild it, so a half-typed answer keeps its text, focus and cursor.
- The answer box shows only when the result asks a question and no run on the thread is working. "Answer and resume" opens the resume confirm prefilled with `Answer from the user: <text>`; nothing is sent without that confirm.

## Motion and accessibility

- Hover, selection, border, and color transitions use 140–180 ms.
- Buttons, tabs, chips, rows, and the resize separator must remain keyboard accessible.
- Focus uses a visible blue 2 px outline.
- Dangerous process controls stay inside the task-actions menu and require confirmation.
