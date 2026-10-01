# UI theme

Codex Live Viewer is a compact task monitor. It should feel calm while work is progressing and make changes in task state obvious without moving controls around.

The design base is the owner's reference image (a dark violet workspace, see `docs/superpowers/specs/2026-09-30-unified-view-design.md` section 2). The base colors below are sampled from it; every meaning color (status, actor, structure, project) keeps one meaning each. The mockup `docs/superpowers/specs/2026-09-30-unified-view-mockup.html` is the reference for every rule; the `:root` block in `viewer-ui.html` is the one owner of the values.

## Palette (tokens)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d0f14` | page, gaps between panels, code blocks |
| `--panel` | `#15181f` | main pane, feed, cards |
| `--panel-2` | `#1c202b` | sidebar, header, toolbar, buttons |
| `--panel-3` | `#222736` | nested fills: usage cells, chip fills, inline code |
| `--hover` | `#242a3a` | hover band |
| `--selected` | `#2c2748` | selected row band |
| `--selected-bar` | `#b693f4` | selected row left bar |
| `--border` | `#2c3142` | panels, cards, inputs |
| `--border-strong` | `#3a4054` | chips, buttons |
| `--border-soft` | `#1f2431` | dividers between rows |
| `--fg` | `#f3f4f6` | text |
| `--muted` | `#9aa0bd` | secondary text (4.5:1 or better everywhere) |
| `--faint` | `#646984` | decoration only, never a fact |

Tinted chips (status pills): pastel text on a dark fill of the same hue, a 1 px border in a mid tint, 18 px tall, 10 px 700. Running `#172a45` / `--blue` / `#274a7d`; Finished `#152929` / `--green` / `#1e5a44`; Waiting `#42331b` / `--yellow` / `#6b5222`; Needs attention `#3a2618` / `--amber` / `#6b4522`; Needs answer transparent / `--amber` / `--amber`; Stopped and Archived `#252a3a` / `--muted` / `--border-strong`; FAST transparent / `--yellow` / `#6b5222`; background tag (`.status.BG`) `--panel-3` / `--muted` / `--border-strong`, weight 600. The Running pill keeps its 8 px spinner. Green confirmation row (`.done-row`): `#152929` / `#6ee7b7` / `#134b3e`. Progress fill: `linear-gradient(90deg, #a855f7, #38bdf8)`. Danger (stop, cancel, kill) is the Failed red mixed into the panel with `color-mix`; there is no separate danger color.

### Contrast (WCAG, computed)

Text on the backgrounds it sits on. Computed with `design-audit/contrast.js`.

| Color | bg | panel | panel-2 | panel-3 | selected | hover |
|---|---|---|---|---|---|---|
| `--fg` #f3f4f6 | 17.42 | 16.14 | 14.78 | 13.52 | 12.80 | 13.00 |
| `--muted` #9aa0bd | 7.43 | 6.88 | 6.30 | 5.76 | 5.46 | 5.55 |
| `--faint` #646984 | 3.56 | 3.29 | 3.02 | 2.76 | 2.61 | 2.66 |
| `--blue` #82aaff | 8.35 | 7.73 | 7.08 | 6.48 | 6.13 | 6.23 |
| `--green` #4ade80 | 11.00 | 10.19 | 9.34 | 8.54 | 8.08 | 8.21 |
| `--yellow` #fcd14a | 13.11 | 12.14 | 11.12 | 10.17 | 9.63 | 9.79 |
| `--amber` #f9b141 | 10.40 | 9.64 | 8.83 | 8.07 | 7.64 | 7.76 |
| `--red` #fca5a5 | 10.10 | 9.36 | 8.57 | 7.84 | 7.42 | 7.54 |
| `--you` #f28fbf | 8.63 | 8.00 | 7.33 | 6.70 | 6.34 | 6.45 |
| `--claude` #e0825e | 6.87 | 6.36 | 5.83 | 5.33 | 5.05 | 5.13 |
| `--plugin` #c3e88d | 13.92 | 12.90 | 11.81 | 10.80 | 10.23 | 10.39 |
| `--codex` #4fd1bd | 10.21 | 9.46 | 8.67 | 7.93 | 7.50 | 7.62 |
| `--codex-lead` #9ae0d4 | 12.77 | 11.83 | 10.84 | 9.91 | 9.38 | 9.53 |
| `--tree-text` #b693f4 | 7.73 | 7.16 | 6.56 | 6.00 | 5.68 | 5.77 |
| `--p1` #c792ea (captions) | 7.97 | 7.38 | 6.76 | 6.18 | 5.85 | 5.95 |
| `--p4` #7ac4e2 (captions) | 9.88 | 9.15 | 8.38 | 7.67 | 7.26 | 7.38 |
| `--p5` #ff6fe1 (captions) | 7.86 | 7.28 | 6.67 | 6.10 | 5.78 | 5.87 |
| `--accent` #7c5cff (lines and fills only, never text) | 4.41 | 4.09 | 3.74 | 3.42 | 3.24 | 3.29 |
| `--meter-fill` #8087a8 (meter only, never text) | 5.43 | 5.03 | 4.61 | 4.21 | 3.99 | 4.05 |

Pill text on its fill: Running 6.29, Finished 8.73, Waiting 8.34, Needs attention 7.75, Stopped 5.53, green row 9.98, `--fg` on `--accent-fill` 11.08.

Rules: `--faint` is under 4.5 everywhere, so it is used only for decoration and for words that repeat a nearby fact ("window unknown", captions' counts, the "USAGE" caption). Every 10 px word that carries information uses `--muted` or a color from the table. `--accent` is never text; violet text uses `--tree-text`.

## Typography

Use Segoe UI Variable, Segoe UI, or the platform system font for the interface. Use Cascadia Code or Consolas only for code-like text: ids (session, thread, agent), sandbox names, the current tool, commands and paths. Everything else, including every number and every usage cell, is the interface font with tabular figures (`font-variant-numeric: tabular-nums` on `:root`). Marks and kind glyphs are SVG, never font glyphs.

| Use | Size | Weight |
|---|---:|---:|
| Selected node title, product title | 14 px | 650 |
| Feed content, search | 13 px | 400 |
| Side panel title | 13 px | 650 |
| Root row title, overview card title, run view agent label | 12 px | 600 |
| Child row title | 12 px | 500 (600 when selected) |
| Navigation, metadata, chips, meta line, crumbs | 11 px | 400 |
| Root row line 3, child row line 2, overview card meta, fold row, row time, plans block, state words | 10.5 px | 400 (600 for state words and the row words "needs answer", "needs attention", "fast") |
| Status pills, kind words, captions, section labels, usage cell labels, flags | 10 px | 700 (captions and labels uppercase, letter-spacing .05 em; flags 400) |
| `you` tag | 9 px | 700 |

## Status colors

Status color has one meaning everywhere: list rows, filter chips, cards, state marks and the selected-task header.

| Status | Token | Behavior |
|---|---|---|
| Running | `--blue` `#82aaff` | Circular spinner indicates active work |
| Waiting | `--yellow` `#fcd14a` | Quiet for at least 20 seconds, no job evidence |
| Needs attention | `--amber` `#f9b141` | The job process died or its heartbeat stopped, or it failed, and the session is not running again. Sessions without a job never get this |
| Needs you | `--amber`, hollow pill | The chip that holds Needs answer (the finished job's result asks a question, no run on the thread is working, the session has not written since) and a chat's needs-you state. The row word is "needs answer" |
| Finished | `--green` `#4ade80` | Completion event received; a chat whose turn is done |
| Failed, over a limit | `--red` `#fca5a5` | |
| Stopped, Ended | `--gray` `#8087a8` | Cancelled job, aborted turn, or an agent with no end record. Not an alarm |
| All | `--blue` (same as Running) | Neutral collection, not a task state |

State mark (`.sdot`): a 10 px box, one shape per state: Running a 10 px spinner ring, Finished a green dot, Waiting a yellow dot, Needs attention an amber dot, Needs answer a hollow amber ring, Stopped a gray dot, Ended a darker gray dot. State words (`.state-word`, 10.5 px 600) use the same colors: "running", "done", "needs attention", "needs answer", "stopped".

Do not animate an entire row or badge. Only the small Running spinner moves (and the "Codex is working" spinner at the end of a running feed, which is the same Running blue).

## Actor colors

Actor color says who sent a feed message, never a status. The avatar shape (filled or ring), the label and the "sender → receiver" line tell the actors of one color apart.

| Actor | Token | Glyph | Meaning |
|---|---|---|---|
| You | Pink `--you` `#f28fbf` | `you` | A message you typed in a Codex session or a chat |
| You, relayed | Pink, dashed ring avatar, tag "relayed answer" | `you` | Your answer delivered through Claude or the answer box |
| Claude | Clay `--claude` `#e0825e` | `claude` | A handoff prompt (tag "handoff"), Claude's own answer, or a chat reply (Claude → You) |
| Claude work | Clay rail, ring dot | `claude` | A chat's own tool calls and thinking (`.actor-claude-work`) |
| Plugin | Lime `--plugin` `#c3e88d` | `plugin` | The return-format footer the plugin appends to a handoff prompt |
| Codex | Teal `--codex` `#4fd1bd` | `codex` | Codex replies; tag "asks you" when the reply has a question |
| Codex (lead) | Light teal `--codex-lead` `#9ae0d4`, ring avatar | `codex` | In a child agent's session: the lead agent's prompts |
| Codex work | Teal rail, ring dot | `codex` | Thinking, commands, output, patches and tool calls |
| System | Slate `--system` `#8087a8`, dashed | `info` | Injected context and hook text |
| Workflow script | Clay, ring avatar | `flow` | The prompt a workflow script gave an agent |
| Claude agent | Clay, filled avatar | `flow` | The replies of an agent a workflow started |
| Agent work | Clay rail, ring dot | `flow` | That agent's tool calls, output and thinking |

The `you` tag (9 px 700, pink outline) sits on a Codex CLI root row: you started it, not Claude. Kind word color = who does the work; the clay `claude` starter glyph on "Handoff" = Claude started it, Codex does the work.

A question for the human (the Needs decision callout in a Codex reply, and the Result card's question) uses the You pink, because it is addressed to you. In a handoff the reply goes to Claude, so the tag reads "asks you (via Claude)". In a child agent's session the question is for the lead agent, in the light teal of Codex (lead).

Who sent a message comes from `messageActor(event, session)`: Codex work kinds are Codex work, turn events are markers, the server's `internal` flag or the injected-block list is System, agent speech is Codex. Developer-role messages are always System. A user message starting with `Answer from the user:` is You relayed, one starting with `Answer from Claude (automatic` is Claude. In a child agent's session any other user message is the lead agent's. Otherwise it is Claude's handoff when the session's `originator` is `Claude Code`, and yours otherwise.

## Structure color

The violet family is structure and never an actor or a status: `--accent` `#7c5cff` for the active tab underline, the focus ring, the unread dot, the primary button border and the Jump pill; `--accent-fill` `#342f60` for the primary button fill; `--selected` and `--selected-bar` for the selected row; `--tree` for rails and captions when project colors are off; `--tree-text` `#b693f4` for structure text (the fold row, the brand mark, links in the sidebar). The Codex agent pill is no longer violet: it is the Codex teal ring mark.

## Project colors

`--p1` `#c792ea`, `--p2` `#82aaff`, `--p3` `#4ade80`, `--p4` `#7ac4e2`, `--p5` `#ff6fe1`. A project color appears in exactly three places: the group caption, the group's tint (6 % into `--panel-2`) and the group's rails (55 % into transparent). Never on a node, a pill, a mark or a card bar. A group sets `--pc`; `.group.ghost` uses `--system`.

## Kind marks

One SVG set (`GL` in `viewer-ui.html`: `claude`, `codex`, `flow`, `ghost`, `you`, `plugin`, `info`; 16-unit box, 1.7 stroke, round caps) for every mark, kind word, avatar, chip and usage cell. `glyph(name)` returns the SVG element; `markElement(shape, k, name)` the 16 px mark; `kindLabel(text, k, { starter, glyph })` the kind word.

| Kind | Mark | Kind word | Color |
|---|---|---|---|
| Claude chat | filled clay, `claude` | Claude chat | `k-claude` |
| Claude agent | clay ring, `claude` | Claude agent | `k-claude` |
| Workflow | filled clay, `flow` | workflow | `k-claude` |
| Workflow agent | clay ring, `flow` | workflow agent | `k-claude` |
| Handoff | filled teal, `codex` | Handoff, with the clay `claude` starter glyph | `k-codex` |
| Codex agent | teal ring, `codex` | Codex agent | `k-codex` |
| Codex CLI | filled teal, `codex`, plus the `you` tag | Codex CLI run | `k-codex` |
| Not on this PC | dashed slate ring, `ghost` | chat | `k-system` |

Boxes: state mark 10 px, kind mark 16 px (glyph 10 px), kind word glyph 11 px, breadcrumb mark 14 px, feed avatar 18 px (glyph 11 px), work row avatar 16 px (glyph 9 px).

## Usage

Numbers use the compact format (`412k`, `1.2M`, `3.8M`), tabular figures, interface font. A lower bound shows `≥` (`.ucell.lower`); a pruned job shows "tokens unknown" in `--faint` (`.ucell .unk`), because the words repeat the fact that nothing is known. The usage strip (`#usage`, `.ucell`: 24 px, `--panel-3` fill, 9 px uppercase label) sits under the header's meta line: context (with a meter), total with output, and the tree total split by Claude (`.sc`) and Codex (`.sp`). The meter (`.meter`, 44 x 5 px) is neutral `--meter-fill`; status colors appear only on a plan meter near its limit (`.warn` amber from 80 %, `.crit` red from 95 %). The plans block (`#plans` under the tree) lists the Claude and Codex plan windows with a meter, the percent and the reset time; `#plans.stale` dims the Claude rows when the figures are older than a minute, `.plan-none` says when there is no data, and under 300 px the reset column hides behind the `#plans.open` toggle.

## Task facts

The project, the model and the effort are the facts you check first, so they are chips under the header title (`.fact`, 24 px, `--panel-3` fill, `--border-strong`): project with a folder icon in the worker's color and a solid border in that color (dashed `.fact-project.other` for a child in another project), model short name, effort with a dim label, and `from` (the chat a handoff came from; hidden on a phone). The meta line (`.mi-wrap` with `.mi` items) never splits an item and never leaves a dangling separator; "Started by: Claude (handoff)" colors the name with the actor color.

## Geometry and spacing

- Grid: 4 px. Row padding 8 px 10 px 7 px (root), 4 px 10 px 5 px plus the level offset (child). Card padding 8 px 10 px 9 px. Header padding 10 px 16 px 8 px. Feed padding 12 px 16 px 56 px.
- Heights: header buttons 32 px, tabs 28 px, chips, fact chips and usage cells 24 px, pills 18 px, row lines 18 px, fold row 24 px, group caption 30 px, feed toolbar 40 px, run view agent rows 30 px, plan rows 20 px, the side panel back button 28 px.
- Radii: 7 px for buttons and cards, 8 px for the result card, 6 px for fact chips and usage cells, 4 px for flags and tags, 999 px for pills and chips, 3 px for meters, 5 px for the rail elbow.
- Borders: 1 px `--border` for panels, cards, inputs; 1 px `--border-strong` for chips and buttons; 1 px `--border-soft` between root rows; 3 px left border for selection (`--selected-bar`) and for cards (the worker color); 1 px rails in the group's rail color; 1 px dashed `--border-strong` for flags and the ghost mark; 1.5 px rings for marks and state marks.
- The tree: `--indent` 18 px per level to level 4, `--indent-deep` 10 px per level after that (the cycle guard is at level 8); `--rail-x` 12 px for the level 1 rail. A child row is a grid (state box 10 px, mark box 16 px, title, time) with `--d` = depth and `--lx` the computed offset. Rails: `.rl.thru` for a continuing ancestor level (`--l`), `.rl.elbow` into this row, `.rl.stem` from a child's state mark down to its open children. Root rows draw no stem.
- The sidebar starts at 340 px (400 px from 2200 px viewport width), can be resized from 240 px to 55 % of the viewport, and remembers the chosen width. At 240 px the root row hides the source word and the roll-up word, the kind word is cut at 90 px, and the plans block hides its reset column (`#side` is the size container).
- Content column: header, toolbar, result card and feed share one column of at most `--content-max` 1360 px, centered in the main pane (`.inner`, `#feed-inner`, `.result-card-box`). The header's right-side controls sit on the column's right edge. With the side panel open (`body.panel-open`) the column re-centers in the remaining space. From 2200 px (`@media (min-width: 2200px)`) the side panel takes the width beyond the column (`--panel-w` up to 1400 px).
- At 760 px and below, the sidebar is a drawer over a backdrop (`min(88vw, 340px)`); the header wraps into rows (menu button, counter and `...` first, then the title, facts, meta and usage); chips scroll sideways in one row with an edge fade (`#chips-wrap.more-left`, `.more-right`); the overview is one column; the side panel covers the pane with a back button; Jump to latest floats over the feed.
- The page must never create horizontal document scrolling.

## Navigation behavior

- The viewer does not start new Codex runs. Runs start from Claude (`/codex:handoff`) or a Codex CLI; the viewer resumes, answers and cancels them.
- Two tabs, Live and History (the unified view; until the logic lands, the four tabs Now, Handoffs, History, Claude keep working with the new styles). Live holds seven status chips (All, Running, Needs you, Needs attention, Waiting, Finished, Stopped) and, after a divider, the two kind chips Claude and Codex (`.chip-kinds`, one wrapping unit). Order and position never change when counts update.
- One tree: projects as groups (caption with count and tree total), root rows (3 lines plus the roll-up line: state dots with counts per child state and the tree total), child rows on rails. A root's roll-up carries the states of its children, so a chat with a child that needs you shows "needs answer" on the root. The fold row hides the finished middle of a long child list ("12 finished agents"); the cap row says how many older children live in History.
- The overview (Live, nothing selected) shows four card sections: Needs you, Needs attention, Running, Recently finished. A node page has no cards; the tree lists its children.
- The header counter shows running, need you and needs attention for every kind, from every tab; clicking it opens Live.
- Keys: `/` focuses search; arrows move in the tree (up, down, left closes, right opens); Escape closes the top layer first: a dialog, then the `...`/context menu, then the side panel, then the drawer.
- Choosing a tab or chip pauses auto-open. Auto-open resumes only through its toggle on the overview. If the selected node changes status, the view moves to a chip that still shows it.
- Sidebar width, collapsed state, tab, chip, search, selected node id (`<kind>:<id>`), open roots, open folds, kind chips and the project group toggle persist in the browser.

## Menu behavior

- The task header's `...` menu and a row's right-click menu build from the same item list, grouped under small section labels: Resume, Job, Session, Terminal commands, Diagnostics (Windows only).
- Cancel job… and Stop task process… are the only dangerous entries; both ask for confirmation in-app and never fire from a single click.
- Chat entries are copy only: Copy session ID, Copy transcript path, Copy resume command, and Copy agent ID while an agent is open. A ghost root ("not on this PC") has a single entry, Copy session ID.
- Escape closes the open menu, in addition to dialogs and the context menu.

## Feed behavior

- The feed shows everything; there is no filter. A message is a card: avatar, "sender → receiver" in the actor colors, a tag, the time. Chat actors: You → Claude, Claude → You, Claude work (clay rail, ring dot). Codex work folds into one "Codex work" row on a teal rail; a Claude agent's "Agent work" on the clay rail. Each run of injected context folds into one dashed System row.
- Run markers (`.marker`) are thin centered rules: Turn started, ✓ Turn complete (green), Turn aborted (red), "Run 1 of 2 · finished 25m ago · show its result"; `.marker.warn` (amber) for a run that needs attention. The green confirmation row (`.done-row`) marks a finished handoff.
- While the task is Running, the feed ends with "Codex is working · <latest step>" (or "Claude agent is working") in the Running blue.
- Jump to latest (`#feed-pill`) floats over the bottom of the feed while the reader has scrolled up; it carries the "N new" count in `--tree-text`.
- Messages, thinking steps and the result card render a safe Markdown subset built as DOM nodes with `textContent`; untrusted output never becomes `innerHTML` (the GL constants are the one trusted exception).
- The "Result from Codex" card (teal rail and avatar, 8 px radius) sits between the toolbar and the feed; its question callout is pink; the answer box's primary button is `--accent-fill` with an `--accent` border.

## Motion and accessibility

- Hover, selection, border, and color transitions use 140–180 ms. The drawer slides in 180 ms. Nothing else moves.
- Buttons, tabs, chips, rows, and the resize separator must remain keyboard accessible.
- Focus uses a visible 2 px `--accent` outline.
- Dangerous process controls stay inside the task-actions menu and require confirmation.
