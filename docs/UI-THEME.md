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
| Needs attention | Orange `#ee964b` | The job process died or its heartbeat stopped, or it failed, and the session is not running again. Sessions without a job never get this |
| Needs answer | Orange outline, `?` chip | The finished job's result asks a question (Needs decision), no run on the thread is working, and the session has not written since (answered elsewhere) |
| Finished | Green `#4ac26b` | Completion event received |
| Stopped | Gray: chip dot `#7b8794`, badge `#9fb0c3` on `#262d38` | Cancelled job or aborted turn. Not an alarm |
| Archived | Gray: chip dot `#9fb0c3`, badge `#9fb0c3` on `#262d38` (same badge as Stopped, lighter chip dot) | Not a task state |
| All | Blue `#67a8ff` (same as Running) | Neutral collection, not a task state |

Do not animate an entire row or badge. Only the small Running spinner moves (and the "Codex is working" spinner at the end of a running feed, which is the same Running blue).

## Actor colors

Actor color says who sent a feed message. It has one meaning everywhere: feed cards, the legend, the header's "Started by" line, the sidebar Handoff chip and the Result card. No actor color is a status color: Claude's clay is redder and darker than the Needs attention amber, and the Handoff chip carries Claude's glyph instead of a status pill.

| Actor | Color | Contrast on `#0b0f14` / `#111720` | Avatar | Means |
|---|---|---|---|---|
| You | Pink `#f28fbf` | 8.65 / 8.10 | `Y` | A message you typed in a Codex session |
| You, relayed | Pink, dashed ring avatar, tag "relayed answer" | same | `Y` | Your answer delivered through Claude or the answer box (`Answer from the user:`) |
| Claude | Clay `#d97757` | 6.16 / 5.76 | `✳` | A handoff prompt (tag "handoff"), or Claude's own answer (`Answer from Claude (automatic N of 2):`, tag "automatic answer N of 2") |
| Plugin | Lime `#b6cf6e` | 11.11 / 10.40 | `+` | The return-format footer the plugin appends to a handoff prompt |
| Codex | Teal `#45c4b0` | 8.95 / 8.38 | `>_` | Codex replies; tag "asks you" when the reply has a question under Needs decision |
| Codex work | Teal rail, ring dot in the legend | same | `>_` | Thinking, commands, output, patches and tool calls |
| System | Slate `#8c9bab`, dashed | 6.76 / 6.33 | `i` | Injected context (permissions, AGENTS.md, environment, skills) and hook text |

A question for the human (the Needs decision callout in a Codex reply, and the Result card's question) uses the You pink, because it is addressed to you.

Who sent a message comes from `messageActor(event, session)`: Codex work kinds are Codex work, turn events are markers, the server's `internal` flag (and the older text patterns) is System, agent speech is Codex. A user message starting with `Answer from the user:` is You relayed, one starting with `Answer from Claude (automatic` is Claude. Any other user message is Claude's handoff when the session's `originator` (from the rollout's `session_meta`) is `Claude Code`, and yours otherwise, including when the originator is unknown.

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

- The viewer does not start new Codex runs. Runs start from Claude (`/codex:rescue`) or a Codex CLI; the viewer resumes, answers and cancels them.
- One list of rows: a Codex session and the handoff jobs on its thread share one row. Rows show 3 lines: badges, title, project · model · effort · tokens. Full path, thread, sandbox, reason and job detail are in the row tooltip.
- Tabs Now, Handoffs, History sit in one fixed row. Each tab has filter chips with counts (Now: All, Running, Waiting, Needs attention, Needs answer; Handoffs: All, Running, Needs attention, Needs answer, Finished, Stopped; History: Finished, Stopped, Archived, Dismissed, Everything). Order and position never change when counts update.
- Choosing a tab or chip pauses auto-open (also closes the Now overview if it was open). A background update must not override an explicit choice.
- Auto-open is resumed only through its toggle, in the Now overview header ("Auto-open new runs: On/Off"). Turning it on leaves the overview, opens the newest Running task, and shows Now/Running unless the current view already shows it.
- If the selected task itself changes status, the view moves to that status's chip (same tab first) so the selected row remains visible. History/Everything and Handoffs/All stay put.
- When the open task is not in the current view, a thin bar above the list says "Open: <title> (not in this view) · Show"; Show switches to a view that contains it.
- The Now overview (Needs answer, Needs attention, Running, Recently finished) shows when no task is open, and when the Now tab is clicked while already active. It replaces the old Home view; there is no separate Home button.
- Sidebar width, collapsed state, tab, chip, search, selected task, and auto-open persist in the browser. Old saved filters (and the old Home flag) map to a tab and chip on first load; the Now-overview flag itself is never persisted. There is no separate auto-scroll preference: following the feed is automatic (see Feed behavior).

## Menu behavior

- The task header's `...` menu and a row's right-click menu build from the same item list, grouped under small section labels: Resume (when the row is resumable), Job (Show full result, or Show job details while the job has not ended; Cancel job…), Session (Dismiss task / Restore task), Terminal commands (Copy resume, Copy continue, Copy fork, Copy archive / Copy unarchive), Diagnostics (Show processes, Stop task process…, Windows only; Stop is left out once the task finished or its job was cancelled, but kept for an aborted turn, whose Codex window may still run).
- Cancel job… and Stop task process… are the only dangerous entries; both ask for confirmation in-app and never fire from a single click.
- Escape closes the open menu, in addition to dialogs and the context menu.

## Feed behavior

- The feed shows everything; there is no filter or "Show internals" switch. Its grammar:
  - A message is a card: avatar, "sender → receiver" in the actor colors (Claude → Codex, You → Codex, Codex → Claude in a handoff, Codex → You otherwise), a tag, and the time. Card border and a faint tint use the sender's color. Messages over 3000 characters collapse behind "show full message".
  - A handoff prompt's `<return_format>` footer is split off into a collapsed Plugin part at the bottom of the card. Tag-only lines in a prompt (`<goal>`, `<rules>`, `<done_when>`) show as small section headings. The answer prefixes are shown as the tag, not repeated in the text.
  - A Codex reply with a real question under Needs decision gets an "asks you" tag, and the question moves out of the text into a pink "Question for you" callout at the end of the card.
  - Consecutive Codex work (thinking groups, commands, output, patches, tools) folds into one "Codex work" row on a teal rail under its turn, summarised as "1 command · 1 patch · 2 thinking steps". It starts collapsed, except the block Codex is working on right now. Inside, each step is one collapsed row: kind label, one line of text, time. Consecutive thinking steps group into one "Thinking · N steps" row.
  - Each run of injected context and hook text folds into one dashed System row ("3 injected blocks · permissions, AGENTS.md, environment context"); expanding it lists each block with its size.
  - Turn events are thin centered rules: Turn started, ✓ Turn complete (Finished green), Turn aborted (red).
  - While the task is Running, the feed ends with "Codex is working · <latest step>" (running <command>, editing <files>, thinking, ...).
- The legend ("Who's who") sits in the 43 px bar above the feed, where the internals toggle used to be: one colored dot per actor, with a tooltip each. At 760 px and below the "Who's who" label hides and the row scrolls sideways; it never adds height.
- The header's meta line starts with "Started by: Claude (handoff)" or "Started by: you (Codex CLI)" (other originators by name, e.g. "you (Codex Desktop)"), from the session's originator. Unknown originator: no line.
- Messages, thinking steps, and the result card render a safe Markdown subset: headings, paragraphs, bold, italic, inline code, fenced code blocks, bullet and numbered lists, and block quotes. Links show as text plus the URL, never as a clickable link. Everything is built as DOM nodes with `textContent`; untrusted output never becomes `innerHTML`.
- Render at most 160 events initially. Earlier events remain available through Show earlier activity, up to a 500-event cap.
- The feed follows new events automatically while the reader is already near the bottom, and pauses the moment they scroll up. A paused feed shows Jump to latest instead of a toggle.
- Live updates rebuild the feed at most once per frame, and not while the reader has text selected in it: the rebuild waits until the selection clears. Open rows and keyboard focus on a row survive a rebuild.
- A task whose newest handoff run finished shows a "Result from Codex" card (Codex teal rail and avatar) between the feed toolbar and the feed: Summary, Changed files, Checks run and "Needs decision: a question for you" (pink callout), or the plain answer, open by default and collapsible. Live feed updates never rebuild it, so a half-typed answer keeps its text, focus and cursor.
- "Show full result" (in the Result card, the header `...` menu, or a row's right-click menu) opens the job result dialog. It lists every run on the thread, newest first, so an earlier run stays reachable after a resume.
- The answer box shows only when the result asks a question, no run on the thread is working, and the session is not running again. When the session wrote more than 5 s after the run asked, the question counts as answered outside the viewer: the row reads Finished and the box hides. "Answer and resume" opens the resume confirm prefilled with `Answer from the user: <text>`; nothing is sent without that confirm.

## Motion and accessibility

- Hover, selection, border, and color transitions use 140–180 ms.
- Buttons, tabs, chips, rows, and the resize separator must remain keyboard accessible.
- Focus uses a visible blue 2 px outline.
- `/` focuses search when no field already has focus. Arrow keys, plus Home and End, move focus within the tabs row and within the chips row. Escape closes the top layer first: an open dialog, then the `...`/context menu, then the mobile drawer; only the top-most one closes on a single press.
- Dangerous process controls stay inside the task-actions menu and require confirmation.
