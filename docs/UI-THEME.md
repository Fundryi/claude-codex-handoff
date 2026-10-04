# UI theme

AI Live Viewer is a compact task monitor. It should feel calm while work is progressing and make changes in task state obvious without moving controls around.

The design base is the owner's reference image `.superpowers/workspace.png` (OctoShell, 1920x1032: three rounded panels on a near-black backdrop, one violet for structure, a few small status colors). The owner-approved October 3 list mockup defines the Live overview and Activity rail. Its sidebar and chat page are examples only. Keep the real sidebar and page. Every meaning color (status, actor, structure, project) keeps one meaning each. The `:root` block in `ui/theme.css` owns the values. The mobile token override stays in `ui/responsive.css`.

CSS files load in this order:

- `ui/theme.css`: tokens and the wide-screen token override.
- `ui/layout.css`: reset, sidebar, tabs, chips, tree rows and rails.
- `ui/marks.css`: kind marks, working halos and animations.
- `ui/surfaces.css`: overview, Activity rail, plans, workflows, panels, headers, menus and controls.
- `ui/feed.css`: feed grammar, messages, thinking/work rows and Markdown.
- `ui/responsive.css`: mobile, container and reduced-motion overrides. Keep last.

`ai-live-viewer.js` starts the server. `server/http.js` loads the required UI assets before the server listens and serves them at fixed URLs. Missing assets fail startup. There is no embedded fallback page.

## Reference samples (the token source)

Sampled from the image with a local one-off script (fills = the modal color of the region; text = the pixel farthest from that mode). Region is `x, y, w, h` in image pixels.

| Name | Region sampled | Hex |
|---|---|---|
| backdrop (gap between the cards) | 394,300 4x200 | `#0d0f14` |
| sidebar card fill (tab row) | 300,55 60x14 | `#1c202b` |
| main card and right card fill, message card fill | 1500,930 60x20 | `#15181f` |
| card border (sidebar right edge) | 389,300 6x200 | `#2c3142` |
| code block fill | 700,650 400x30 | `#101318` |
| group tints (storefront, ui, api) | 300,380 / 300,700 / 300,860 | `#2d2c3f` / `#222736` / `#1f2930` |
| selected row band and bar | 280,296 80x28 | `#41386f` |
| selected row title | 120,296 150x14 | `#f3f4f6` |
| tree row title (unselected), subline | 120,206 / 116,182 | `#8087a8` / `#8086a5` |
| right list row title | 1398,172 130x12 | `#e5e7eb` |
| violet accent (claude label, tool name, agent segment, inline code text, "Claude is thinking") | 437,260 40x12 | `#7c5cff` |
| violet captions and the active tab | 58,90 / 28,56 | `#c792ea` / `#c36ffb` |
| primary button fill and border ("New project") | 100,950 60x20 | `#342f60` |
| secondary button fill, border text | 100,912 60x18 | `#1c202b`, `#8087a8` |
| active filter chip fill and text ("All 17") | 1382,143 30x12 | `#313747`, `#f3f4f6` |
| inline code chip fill and text | 1520,383 140x12 | `#313747`, `#7c5cff` |
| working: chip dot, list word | 1430,143 / 1802,172 | `#82aaff` / `#7fa6f9` |
| done: chip dot, list word | 1582,143 / 1850,228 | `#4ade80` / `#47d37b` |
| error: chip dot (dim), stop button text | 1514,143 / 1290,814 | `#703b40` / `#fca5a5` |
| idle: chip dot, chip word | 1650,143 / 1662,143 | `#4b5066` / `#8087a8` |
| amber ("Auto" chip fill and text) | 1730,93 30x14 | `#42331b`, `#fcd34d` |
| green confirmation row fill and text | 1500,732 / 1400,732 | `#152929`, `#6ee7b7` |
| progress line violet to blue, title | 500,82 / 900,82 / 740,58 | `#9d60f7` / `#47aff8` / `#38bdf8` |
| primary text (prose) | 1380,410 400x14 | `#f3f4f6` |
| dim text (timestamp, path, placeholder, "live watch") | 490,260 / 440,839 / 460,877 / 1380,886 | `#7d84a6` / `#8087a8` / `#4a5063` / `#555b71` |
| json key, string, brace | 460,395 / 600,395 / 445,373 | `#c792ea` / `#c3e88d` / `#85d7f9` |

Corner radii measured on the 2x crops: cards (the three panels) about 10 px; buttons and the input about 8 px; filter chips, the selected row band and the toolbar chips about 6 px.

## Palette (tokens)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d0f14` | the backdrop behind the cards, code blocks (thinking-step code blocks are transparent) |
| `--panel` | `#15181f` | main card, side panel card, feed, header, toolbar |
| `--panel-2` | `#1c202b` | sidebar panel, message cards, menus, dialogs, secondary buttons |
| `--panel-3` | `#313747` | the active filter chip, inline code |
| `--hover` | `#242a3a` | hover band |
| `--selected` | `#41386f` | selected row band (reference) |
| `--border` | `#2c3142` | the cards, message cards, inputs, usage cells, fact chips, buttons |
| `--border-strong` | `#3a4054` | dialog buttons, flags, the stale-row dash |
| `--border-soft` | `#1f2431` | dividers inside blocks |
| `--fg` | `#f3f4f6` | text |
| `--muted` | `#9aa0bd` | secondary text |
| `--faint` | `#646984` | decoration, repeated facts, prompt-section captions and tool-output labels |
| `--r-panel` / `--r-btn` / `--r-chip` | `10px` / `8px` / `6px` | the three radii; every surface uses one of them |
| `--gutter` | `8px` | the backdrop gap around and between the cards |

Content tokens (2.27.0, `ui/theme.css`). Syntax colors are for code only, never a status, actor or structure.

| Group | Tokens |
|---|---|
| Syntax | `--syn-keyword` `#c792ea` (keywords, JSON keys), `--syn-string` `#c3e88d`, `--syn-number` `#f78c6c`, `--syn-comment` `#8d93b3`, `--syn-function` `#85d7f9`, `--syn-type` `#ffcb6b` (capitalized identifiers), `--syn-punct` `#9aa0bd` |
| Code | `--code-fg` `#e5e7eb`; `--code-size` `12px` for block code, diffs, commands and JSON; thinking-step code is 11 px |
| Diff | `--diff-add` `#4ade80`, `--diff-del` `#fca5a5`, `--diff-add-bg` `#142620`, `--diff-del-bg` `#2c2327`, `--diff-hunk-bg` `#1d1a35` |
| Failed badge | `--fail-bg` `#40353f`, `--fail-border` `#6b4a50` |
| Terminal (ANSI 30-37 and 90-97 share them) | `--term-black` `#8087a8`, `--term-red` `#fca5a5`, `--term-green` `#4ade80`, `--term-yellow` `#f9b141`, `--term-blue` `#82aaff`, `--term-magenta` `#ff6fe1`, `--term-cyan` `#85d7f9`, `--term-white` `#f3f4f6` |

Status pills (`.status`) exist only in the task header's title row: pastel text on a dark fill of the same hue, 1 px border in a mid tint, 18 px tall, 10 px 700, 6 px corners. Running `#172a45` / `--blue` / `#274a7d`; Finished `#152929` / `--green` / `#1e5a44`; Waiting and Stopped `#252a3a` / `--muted` / `--border-strong`; Needs attention `#3a2618` / `--amber` / `#6b4522`; Needs answer transparent / `--amber` / `--amber`; FAST transparent / `--muted` / `--border-strong`; background tag (`.status.BG`) `--panel-3` / `--muted` / `--border-strong`, weight 600. The Running pill carries a 7 px blue dot that breathes (opacity only); the Running chip and the "is working" footer line use the same breathing dot. Nothing rotates. Rows and cards never carry a pill: the kind mark carries the state (arc, amber ring, dotted ring, dim) next to a state word. Green confirmation row (`.done-row`): `#152929` / `#6ee7b7` / `#134b3e`. Progress fill: `linear-gradient(90deg, #a855f7, #38bdf8)`, the one gradient (the reference has it). No glows: the unread dot is a plain 6 px `--accent` dot. Danger (stop, cancel, kill) is the Failed red mixed into the panel with `color-mix`; there is no separate danger color.

### Contrast (WCAG, computed)

Text on the backgrounds it sits on. Computed with a local one-off script.

| Color | bg | panel | panel-2 | panel-3 | selected | hover |
|---|---|---|---|---|---|---|
| `--fg` #f3f4f6 | 17.42 | 16.14 | 14.78 | 10.79 | 9.45 | 13.00 |
| `--muted` #9aa0bd | 7.43 | 6.88 | 6.30 | 4.60 | 4.03 | 5.55 |
| `--faint` #646984 | 3.56 | 3.29 | 3.02 | 2.20 | 1.93 | 2.66 |
| `--blue` #82aaff | 8.35 | 7.73 | 7.08 | 5.17 | 4.53 | 6.23 |
| `--green` #4ade80 | 11.00 | 10.19 | 9.34 | 6.82 | 5.97 | 8.21 |
| `--amber` #f9b141 | 10.40 | 9.64 | 8.83 | 6.44 | 5.64 | 7.76 |
| `--red` #fca5a5 | 10.10 | 9.36 | 8.57 | 6.26 | 5.48 | 7.54 |
| `--you` #f28fbf | 8.63 | 8.00 | 7.33 | 5.35 | 4.68 | 6.45 |
| `--claude` #e0825e | 6.87 | 6.36 | 5.83 | 4.26 | 3.72 | 5.13 |
| `--plugin` #c3e88d | 13.92 | 12.90 | 11.81 | 8.62 | 7.55 | 10.39 |
| `--codex` #4fd1bd | 10.21 | 9.46 | 8.67 | 6.33 | 5.54 | 7.62 |
| `--codex-lead` #9ae0d4 | 12.77 | 11.83 | 10.84 | 7.91 | 6.92 | 9.53 |
| `--tree-text` #b693f4 | 7.73 | 7.16 | 6.56 | 4.79 | 4.19 | 5.77 |
| `--p1` #c792ea (captions) | 7.97 | 7.38 | 6.76 | 4.94 | 4.32 | 5.95 |
| `--p4` #7ac4e2 (captions) | 9.88 | 9.15 | 8.38 | 6.12 | 5.36 | 7.38 |
| `--p5` #ff6fe1 (captions) | 7.86 | 7.28 | 6.67 | 4.87 | 4.26 | 5.87 |
| `--accent` #7c5cff (lines and fills only, never text) | 4.41 | 4.09 | 3.74 | 2.73 | 2.39 | 3.29 |
| `--meter-fill` #8087a8 (meter only, never text) | 5.43 | 5.03 | 4.61 | 3.36 | 2.95 | 4.05 |
| lifted dim text #c9cbe0 (selected sidebar rows only) | | | | | 6.49 | |

Pill text on its fill: Running 6.29, Finished 8.73, Needs attention 7.75, Stopped and Waiting 5.53, green row 9.98, `--fg` on `--accent-fill` 11.08.

Rules: `--faint` is under 4.5 everywhere, so it is used only for decoration, for words that repeat a nearby fact ("window unknown", captions' counts, the "USAGE" caption, the tokens of a finished child row that the tooltip repeats), for prompt-section captions (GOAL, RULES) and for tool-output labels (Output, Result). Every 10 px word that carries information uses `--muted` or a color from the table. The selected band (`#41386f`) is bright, so on a selected sidebar row the dim text (meta, time, roll-up) lifts to `#c9cbe0` (6.49:1); the kind word keeps its actor color because the kind mark beside it says the same thing. `--accent` is never text; interface violet text uses `--tree-text`, and syntax keywords and JSON keys use `--syn-keyword`. Inline code is `--tree-text` on `--panel-3` (4.79:1), except in thinking steps, where it is `--muted` on a transparent background with no chip padding.

## Typography

Use Segoe UI Variable, Segoe UI, or the platform system font for the interface. Use the code font stack `Consolas, Menlo, monospace` only for code-like text: ids (session, thread, agent), sandbox names, the current tool, commands and paths. Name only fonts that are part of the system (Consolas on Windows, Menlo on macOS, the `monospace` default on Linux). Never name a font that an app brings along, such as Cascadia Code: Windows Terminal shares it with all apps, and when Terminal updates, the font file moves and an open browser draws every letter as a box (seen 2026-10-03). Everything else, including every number and every usage cell, is the interface font with tabular figures (`font-variant-numeric: tabular-nums` on `:root`). Marks and kind glyphs are SVG, never font glyphs.

| Use | Size | Weight |
|---|---:|---:|
| Selected node title, product title | 14 px | 650 |
| Feed content, search | 13 px | 400 |
| Side panel title | 13 px | 650 |
| Sidebar root row title, run view agent label | 12 px | 600 |
| Overview row title | 13 px | 550 |
| Activity row title | 12.5 px | 500 |
| Child row title | 12 px | 500 (600 when selected) |
| Sidebar row titles | | `--muted` at rest (the reference list); `--fg` on the selected, hovered or focused row |
| Work step kind (`.step-kind`) | 10 px | 600, plain case, in the actor color |
| Phase caption (`.claude-phase`) | 10 px | 700 `--faint` uppercase, like `.ov-heading`, no stripe |
| Navigation, metadata, chips, meta line, crumbs | 11 px | 400 |
| Root row line 3, child row line 2, fold row, row time, plans block, state words | 10.5 px | 400 (600 for state words and the row words "needs answer", "needs attention", "fast") |
| Status pills, kind words, captions, section labels, usage cell labels, flags | 10 px | 700 (captions and labels uppercase, letter-spacing .05 em; flags 400) |
| `you` tag | 9 px | 700 |

## Status colors

Status color has one meaning everywhere: list rows, filter chips, state dots and the selected-task header.

| Status | Token | Behavior |
|---|---|---|
| Running | `--blue` `#82aaff` | State word, pill, chip and roll-up dot; the arc on a running mark is the actor color |
| Waiting | `--gray` `#8087a8` (the reference "idle" grey) | Quiet for at least 20 seconds, no job evidence. The word "waiting" tells it from Stopped |
| Needs attention | `--amber` `#f9b141` | The job process died or its heartbeat stopped, or it failed, and the session is not running again. Sessions without a job never get this |
| Needs you | `--amber`, hollow pill | The chip that holds Needs answer (the finished job's result asks a question, no run on the thread is working, the session has not written since) and a chat's needs-you state. The row word is "needs answer" |
| Finished | `--green` `#4ade80` | Completion event received; a chat whose turn is done |
| Failed, over a limit | `--red` `#fca5a5` | |
| Stopped, Ended | `--gray` `#8087a8` | Cancelled job, aborted turn, or an agent with no end record. Not an alarm |
| All | `--blue` (same as Running) | Neutral collection, not a task state |

Working mark: the kind mark carries the state through a halo slot 3 px outside it (`::after`, a ring `--bw` thick, see Pixel grid). Running (`.mk-busy`): an arc in the actor color (`--k`) travels around the mark, 1.4 s per lap; only the gradient angle animates, the box never moves. Needs answer (`.mk-ask`): a solid amber ring. Needs attention (`.mk-warn`): a dotted amber ring. Finished, stopped, ended, archived and background (`.mk-dim`): the mark at 50 % (70 % on a selected row). Waiting: the plain mark. Under reduced motion the arc stands still as a three-quarter arc. The state dot (`.sdot`, a 10 px box, 8 px dot in the state color) survives only on the root roll-up line and the kind counts. State words (`.state-word`, 10.5 px 600) use the same colors: "running", "background", "finished", "waiting", "needs attention", "needs answer", "stopped", "ended". The status set is the reference's: blue, green, amber, red, grey. `--yellow` survives only in the stop dialog's warning box; FAST is a small muted uppercase word (`.fl.fast`), not a color.

A row shows its state exactly as the reference list does: the mark on the left, the state word right-aligned before the time. A filter chip with a count of 0 (`.chip-button.zero`) dims to 45 %, like the reference's "Error 0".

Do not animate an entire row or badge. One language: a mark orbits (the arc on a running kind mark), a dot breathes (the Running pill, the Running chip, the "is working" line at the end of a running feed), nothing rotates.

## Actor colors

Actor color says who sent a feed message, never a status. The avatar shape (filled or ring), the label and the "sender → receiver" line tell the actors of one color apart.

| Actor | Token | Glyph | Meaning |
|---|---|---|---|
| You | Pink `--you` `#f28fbf` | `you` | A message you typed in a Codex session or a chat |
| You, relayed | Pink, dashed ring avatar, tag "relayed answer" | `you` | Your answer delivered through Claude or the answer box |
| Claude | Clay `--claude` `#e0825e` | `claude` | A handoff prompt (tag "handoff"), Claude's own answer, or a chat reply (Claude → You) |
| OpenCode | Periwinkle `--opencode` `#aabcf8` | `opencode` | OpenCode replies and work. |
| Claude work | Clay ring dot, indented work rows | `claude` | A chat's own tool calls and thinking (`.actor-claude-work`) |
| Plugin | Lime `--plugin` `#c3e88d` | `plugin` | The return-format footer the plugin appends to a handoff prompt |
| Codex | Teal `--codex` `#4fd1bd` | `codex` | Codex replies; tag "asks you" when the reply has a question |
| Codex (lead) | Light teal `--codex-lead` `#9ae0d4`, ring avatar | `codex` | In a child agent's session: the lead agent's prompts |
| Codex work | Teal ring dot, indented work rows | `codex` | Thinking, commands, output, patches and tool calls |
| System | Slate `--system` `#8087a8`, dashed | `info` | Injected context and hook text |
| Workflow script | Clay, ring avatar | `flow` | The prompt a workflow script gave an agent |
| Claude agent | Clay, filled avatar | `flow` | The replies of an agent a workflow started |
| Agent work | Clay ring dot, indented work rows | `flow` | That agent's tool calls, output and thinking |

The `you` tag (9 px 700, pink outline) sits on a Codex CLI root row: you started it, not Claude. Kind word color = who does the work; the clay `claude` starter glyph on "Handoff" = Claude started it, Codex does the work.

A question for the human (the Needs decision callout in a Codex reply, and the Result card's question) uses the You pink, because it is addressed to you. In a handoff the reply goes to Claude, so the tag reads "asks you (via Claude)". In a child agent's session the question is for the lead agent, in the light teal of Codex (lead).

Who sent a message comes from `messageActor(event, session)`: Codex work kinds are Codex work, turn events are markers, the server's `internal` flag or the injected-block list is System, agent speech is Codex. Developer-role messages are always System. A user message starting with `Answer from the user:` is You relayed, one starting with `Answer from Claude (automatic` is Claude. In a child agent's session any other user message is the lead agent's. Otherwise it is Claude's handoff when the session's `originator` is `Claude Code`, and yours otherwise.

## Structure color

The violet family is structure and never an actor or a status: `--accent` `#7c5cff` for the active tab underline, the focus ring, the unread dot, the primary button border and the Jump pill; `--accent-fill` `#342f60` for the primary button fill; `--selected` for the selected row band; `--tree` for rails and captions when project colors are off; `--tree-text` `#b693f4` for structure text (the fold row, the brand mark, links in the sidebar). The Codex agent pill uses the Codex teal ring mark.

## Project colors

`--p1` `#c792ea`, `--p2` `#82aaff`, `--p3` `#4ade80`, `--p4` `#7ac4e2`, `--p5` `#ff6fe1`. A project color appears in exactly three places: the group caption, the group's tint (6 % into `--panel-2`) and the group's rails (55 % into transparent). Never on a node, a pill, a mark or a card bar. A group sets `--pc`; `.group.ghost` uses `--system`.

## Kind marks

One SVG set (`GL` in `ui/js/marks.js`: `claude`, `codex`, `flow`, `ghost`, `you`, `plugin`, `info`; 16-unit box, 1.7 stroke, round caps) for every mark, kind word, avatar, chip and usage cell. The helpers live in the same file. `glyph(name)` returns the SVG element; `markElement(shape, k, name)` the 16 px mark; `kindLabel(text, k, { starter, glyph })` the kind word.

| Kind | Mark | Kind word | Color |
|---|---|---|---|
| Claude chat | filled clay, `claude` | Claude chat | `k-claude` |
| Claude agent | clay ring, `claude` | Claude agent | `k-claude` |
| OpenCode chat | filled periwinkle, `opencode`; a child uses a ring | OpenCode chat | `k-opencode` |
| Workflow | filled clay, `flow` | workflow | `k-claude` |
| Workflow agent | clay ring, `flow` | workflow agent | `k-claude` |
| Handoff | filled teal, `codex` | Handoff, with the clay `claude` starter glyph | `k-codex` |
| Codex agent | teal ring, `codex` | Codex agent | `k-codex` |
| Codex CLI | filled teal, `codex`, plus the `you` tag | Codex CLI run | `k-codex` |
| Not on this PC | dashed slate ring, `ghost` | chat | `k-system` |

Boxes: kind mark 16 px (glyph 10 px) with a 22 px halo, kind word glyph 11 px, breadcrumb mark, overview child mark and roll-up count mark 12 px (glyph 8 px; 12 is a multiple of 4, so the box is whole device pixels at every DPR), feed avatar 18 px (glyph 11 px), work row avatar 16 px (glyph 9 px). No mark has a CSS border: a ring is an inset `box-shadow` of `--bw`, the ghost mark a dashed conic ring in `::before` masked to `--bw`, the topic mark an 8 px hollow dot (`::before`, absolute at 4 px / 4 px) and no glyph. So every shape has the same 16 px box, the same glyph position and the same halo distance.

Topic rows (a run's topics, `.row.child.topic` in the tree): one line always, running or not: the topic mark, the title, the steps (`.wf-steps`, built by `stepsElement`: "Review 1/1 › Verify 24/24", one span per step, the step with running agents in `--blue` 600, the others `--muted`, the `›` in `--faint`), the state word, the tokens, the time. The steps column is `fit-content(46%)` and right-packed, so the counts line up across rows; under 420 px of sidebar the step words (`.n`) hide and the counts stay ("1/1 › 24/24", in the order of the workflow's own phase line), and a finished topic drops its state word. A loose group (agents with no shared topic, grouped by phase) shows the phase as its title and the count only ("Gap · 2/2"). In the run view the same group is a `.topic-row` (28 px, 4 px above it): a chevron (`GL.chev`, 16 px box, 10 px glyph), the title 600, the steps at 11 px, the state word, the tokens, the time; it opens and closes its agent rows (`openTopics`): finished topics closed, topics with running agents or with the open panel agent open.

## Usage

Numbers use the compact format (`412k`, `1.2M`, `3.8M`), tabular figures, interface font. A lower bound shows `≥` (`.ucell.lower`); a pruned job shows "tokens unknown" in `--faint` (`.ucell .unk`), because the words repeat the fact that nothing is known. The usage strip (`#usage`, `.ucell`: 24 px, `--panel-3` fill, 9 px uppercase label) sits under the header's meta line: context (with a meter), total with output, and the tree total split by Claude (`.sc`) and Codex (`.sp`). The meter (`.meter`, 44 x 5 px) is neutral `--meter-fill`; status colors appear only on a plan meter near its limit (`.warn` amber from 80 %, `.crit` red from 95 %). The plans block (`#plans` under the tree) lists the Claude and Codex plan windows grouped by source. One source line per vendor (`.plan-src`: 16 px icon box with the 11 px glyph in the actor color, the name 600 `--fg`, and a right-aligned note in `--muted`: the age, or `.stale` amber / `.crit` red for an old snapshot, a failed read or a reached limit); the Codex line carries the resets count as a quiet pill (`.pl-resets`: the `.status.BG` recipe, 18 px, `--panel-3`, `--border-strong`, 6 px corners). Under it one row per window (`.plan-row`): name, meter, value, reset time. The block is one grid (`14px fit-content(76px) minmax(32px, 1fr) 58px auto`, 8 px gaps) and every row is a column subgrid of it, so the meter starts and ends at the same x on every row of both sources; column 1 is the indent under the source icon, the value column is fixed so `100% used` never moves the meter, and the reset column takes its widest text. The value is the number 600 `--fg` with the word "used" in `--muted`; `.warn` and `.crit` color the number and the meter fill; a row whose reset passed (`.passed`) shows "unknown" in `--muted` over an empty meter. Under 330 px the reset column is dropped and the reset text sits on a second 10 px line under the meter: no toggle, nothing hidden.

## Task facts

The project, the model and the effort are the facts you check first, so they are chips under the header title (`.fact`, 24 px, `--panel-3` fill, `--border-strong`): project in 600 with a folder icon in the worker's color and the same neutral border as every other chip (dashed `.fact-project.other` for a child in another project), model short name, effort with a dim label, and `from` (the chat a handoff came from; hidden on a phone). The meta line (`.mi-wrap` with `.mi` items) never splits an item and never leaves a dangling separator; "Started by: Claude (handoff)" colors the name with the actor color.

## Geometry and spacing

- Layout: three rounded cards (`.pane`: `#side`, `#main`, `#panel`) on the `--bg` backdrop with a `--gutter` (8 px) around and between them, like the reference. The card line is a 1 px `--border` shadow outside the box (`box-shadow: 0 0 0 1px`), not a border, so the card and the scroll container inside it start at 8 px, a multiple of 4 (see Pixel grid). The splitter is the gutter between the sidebar and the main card and only shows itself (accent fill) under the pointer. On a phone the gutter is 0 and the cards lose their corners.
- Pixel grid: 4 px. Every row pitch is a multiple of 4 and every mark sits 0, 4 or 8 px under its row top and at a multiple of 4 px in x, counted from the card edge. 4 CSS px is a whole device pixel at DPR 1, 1.25, 1.5, 1.75 and 2, so a mark never straddles device pixels on a 125 % or 150 % Windows display (a ring would rasterize one pixel taller than wide and the glyph shift). The rule covers the containers too: the list starts at 164 + 24 px per chip row (brand 58, controls 98 + chip rows), the header is 10 px + rows on 8 px steps (crumbs 4 + 16, title row 32, facts 8 + 24, meta 8 + 16, usage 8 + 24) + 9 px + the 1 px line, the toolbar is 35 + 1 px, the feed and the run view start 12 px under that, the home view 6 px further, the Activity panel head is 60 px and its body starts 4 px under it. Content columns centre with `margin-left: round(down, …, 4px)` and the main card takes a `round(down, …, 4px)` width while the side panel is open (Chrome 125+; older browsers keep the plain auto layout). The sidebar width pref is rounded to 4 px on load and while dragging. Scrolled lists keep the grid with `snapScrollToGrid`: on `scrollend` the list, the run view and the panel settle on the nearest multiple of 4 (at most 2 px, after the motion); the feed too, except when it is pinned to its end. `--bw` (ring stroke and halo ring) is a whole number of device pixels per DPR: 1 px at DPR 1, 1.6 px (2 dpx) at 1.25, 1.3334 px (2 dpx) at 1.5, 1.1429 px (2 dpx) at 1.75, 1.5 px (3 dpx) at 2, 1.3334 px (4 dpx) at 3, set by `min-resolution` media queries on `:root`. Row padding 6 px 10 px 6 px 12 px (root), 3 px 10 px plus the level offset (child), 0 top and 4 px bottom with a 16 px line for a quiet child and a topic row. Header padding 10 px 16 px 9 px. Feed padding 12 px 16 px 56 px.
- Rows: a root row is two lines. Line 1: kind mark, title, state word, time (20 px). Line 2: the kind word, source, "fast", model, effort, tokens and flags on the left; the roll-up (the children's worst state, kind counts, Σ tree total) on the right, 10 px `--muted`. Under 400 px (the default 340 px sidebar) the kind counts hide and the roll-up keeps the word and the Σ total; under 300 px the Σ moves to the group caption. A child row is one line (kind mark, title, state word, time) plus a meta line that starts under the title while it is active; a finished, ended or stopped child (`.row.child.fin`) is one quiet line (20 px pitch: a 16 px line with the mark at its top and 4 px of air): muted 11.5 px title, state word, tokens in `--faint`, time. Row text has fixed line heights (`#side` 15 px, `.row-top` and `.row-title` 18 px, `.row-sum` 15 px) so no row is a fraction of a pixel tall. The roll-up has fixed cells: a kind count 33 px (12 px mark, 3 px gap, the number) with the 7 px flex gap, the Σ total 58 px right aligned, so the count marks land on the grid from the row's right edge. The fold row ("+ 18 finished") is a 22 px violet button with 1 px above and below (24 px pitch) that fills with `--accent-fill` under the pointer; `.rows` is a flex column so those margins never collapse.
- Chips: one compact row, no borders, 22 px with 2 px between rows and 3 px above and below the block (24 px per row), 11 px words with a dot and the count inline; the active chip sits on a `--panel-3` block with 6 px corners (the reference "All 17"). The row wraps to a second line when the sidebar is narrow and scrolls sideways on a phone.
- Heights: header buttons 32 px, tabs 28 px, chips 22 px, fact chips and usage cells 24 px, pills 18 px, row lines 18 px, root row 48 px, active child row 40 px, quiet child and topic row 20 px, fold row 22 px (24 px pitch), group caption 32 px (its separator is an inset shadow, so a group's height stays a multiple of 4; `.rows` has 4 px under its last row), feed toolbar 36 px (35 + the line), run view summary 50 px + 14 px, run view agent rows 32 px, topic rows 28 px + 4 px, phase captions 16 px (12 px above, 4 px under), overview rows 36 px and children 28 px, Activity rows 32 px and children 28 px, plan source lines 22 px, plan rows 20 px (32 px under 330 px, when the reset text takes a second line), the side panel back button 28 px.
- Radii (`--r-panel` 10 px, `--r-btn` 8 px, `--r-chip` 6 px): the cards, menus and dialogs 10 px; buttons, inputs, message cards, code blocks, the result card, the plans block, the Jump pill 8 px; chips, status pills, tabs, rows and the selected row band, usage cells, fact chips, toolbar buttons, message tags, menu entries 6 px; flags, tags and inline code 4 px; meters 3 px; the rail elbow 5 px. Nothing is square and nothing is a 999 px capsule except the `you` tag.
- Borders: the cards carry a 1 px `--border` shadow outside the box (see Layout); 1 px `--border` for message cards, inputs, usage cells, fact chips and header buttons; 1 px `--border-strong` for dialog buttons and the auto-open switch when it is On. No colored edge stripes anywhere: cards, message cards and the result card have one even neutral border, a selected row is marked by its band fill alone, and no element says who works through a colored left edge (the kind word, marks and avatars do that); 1 px tree rails in the group's rail color; 1 px dashed `--border-strong` for flags; `--bw` (1 to 3 device pixels, see Pixel grid) for the ring marks, the dashed ghost mark, the topic dot and the halos. An overview root row's separator is an inset `--border-soft` shadow, not a border, so the row stays 36 px.
- Fills: the header, toolbar and feed share the main card's `--panel`; message cards, menus and dialogs are `--panel-2` with no actor tint; usage cells and fact chips have no fill.
- The tree: `--indent` 16 px per level to level 4, `--indent-deep` 8 px per level after that (the cycle guard is at level 8); `--rail-x` 16 px for the level 1 rail. A child row is a grid (mark box 16 px, title, time) with `--d` = depth and `--lx` the computed offset; the row starts at `--lx` + 8 px so the mark is centred on the next level's rail (marks at x 24 for a root, 36, 52, 68, 84 for levels 1 to 4). Rails: `.rl.thru` for a continuing ancestor level (`--l`), `.rl.elbow` into this row (5 px wide, it ends at the halo edge; 13 px tall on a 40 px row, 9 px on a quiet or topic row, 11 px on a fold), `.rl.stem` from under a child's mark down to its open children (from 23 px on a 40 px row, 19 px on a quiet or topic row). Root rows draw no stem.
- The sidebar starts at 340 px (400 px from 2200 px viewport width), can be resized from 240 px to 55 % of the viewport, and remembers the chosen width. At 240 px the root row hides the source word and the roll-up word, the kind word is cut at 90 px, and under 330 px a plan row writes its reset time on a second line (`#side` is the size container).
- Content column: header, toolbar, result card and feed share one column of at most `--content-max` 1360 px, centered in the main card (`.inner`, `#feed-inner`, `.result-card-box`). The header's right-side controls sit on the column's right edge. The side panel (`#panel`) is a card of its own beside the main card (a sibling of `<main>`, shown by `body.panel-open`), so the column centers in the main card on its own. From 2200 px, an open agent keeps the wider transcript panel (`--panel-w` up to 1400 px). A page with no agent panel has the 320 px Activity rail.
- Overview column: the header and feed can use up to 2080 px. See Live overview and Wide screens below.
- At 760 px and below, the sidebar is a drawer over a backdrop (`min(88vw, 340px)`); the header wraps into rows (menu button, counter and `...` first, then the title, facts, meta and usage); chips scroll sideways in one row with an edge fade (`#chips-wrap.more-left`, `.more-right`); the overview is one column; the side panel covers the pane with a back button; Jump to latest floats over the feed.
- The page must never create horizontal document scrolling.

## Live overview

Use a calm list with no boxes or colored edge stripes. Groups are Running,
Needs you and Needs attention. Each group has a small uppercase caption and
a count. Each root row is 36 px high, with `--r-chip` corners and a `--hover`
fill under the pointer. A thin `--border-soft` rule (an inset shadow) separates root rows. The row padding is 0 10 px 0 12 px and the column gap 12 px, so the 16 px mark and, on a child, the 12 px inline mark sit on the 4 px grid.

Columns, from left to right: a 16 px kind mark (it carries the state); title
`minmax(220px, 1.2fr)`, 13 px and weight 550; project, 150 px; doing now
`minmax(160px, 1fr)`, 12 px; state word, 96 px; age, 54 px and right aligned.
The title, project and doing-now text use an ellipsis when they do not fit.
The project is a basename, with the full path in its title. Project, doing-now
and age text use `--muted`. Commands use the existing code font. A question
uses `--amber`. A running row with no known step says "working" in
`--muted`. Finished rows have an empty doing-now cell. Other inactive rows
show an available outcome or error reason, or an empty cell.

Only running children appear under a parent. They are 28 px high, with a
28 px title indent per depth (20 px in the Activity rail), a 12 px mark 6 px
under the row top (the title is a flex row of mark and text) and a small
rounded elbow whose foot meets the mark's centre. They have no border or box.
Children that need an answer or attention have their own group rows. A row
click opens the node with the existing page or agent-panel behavior.

Model id, effort, token total, FAST, source and flags such as "chat not in
Live" are in the row title. They remain on the open page. Doing-now text
uses the current Claude tool, the Codex last event, the running OpenCode
step, the background child count, the workflow phase count or the first
line of the job question. Patch summaries show file basenames only.

One quiet line says "N finished today · show". The count uses the local
calendar day. The control expands finished rows in place, with the same
36 px row style. It then says "hide". There is no five-row cap.

## Wide screens

At 2200 px and above, an overview with no page open has no right panel.
The overview has two columns with a 32 px gap; the left column's width rounds down to a multiple of 4 px (`round()`), so the right column starts on the pixel grid. Running and the
finished control are on the left. Needs you and Needs attention are on
the right. Below 2200 px, the groups and finished control form one column.
Narrow columns reduce the text tracks. On small screens, the project and
doing-now columns hide in turn. Their facts remain in the row title.
Rows must not cause horizontal page scrolling.

At 2200 px and above, an open page has a 320 px Activity rail in the
existing right-panel slot. The main page uses the remaining space. Its
1360 px content-column limit stays the same. The rail header says
"Activity", with a quiet running and needs-you count line.

The rail shows Running and up to four Needs you rows. Rows are 32 px high:
kind mark, title and age. Running children are 28 px high
under their parent, their 12 px mark 8 px under the row top. Project and doing-now text are in the row title.
The footer says "N more need you · N need attention · N finished · open
Live". Use "needs" when either needs count is 1. A background count of 1
says "1 agent running". The last words open the overview. Each rail row opens its node.
An open Claude agent uses the existing, wider transcript panel and takes
precedence over the rail. Below 2200 px there is no Activity rail. Use no
em dash or en dash in interface copy.

## Navigation behavior

- The viewer does not start new Codex runs. Runs start from Claude (`/codex:handoff`) or a Codex CLI; the viewer resumes, answers and cancels them.
- Two tabs, Live and History (the unified view). Live holds seven status chips (All, Running, Needs you, Needs attention, Waiting, Finished, Stopped) and, after a divider, the two kind chips Claude and Codex (`.chip-kinds`, one wrapping unit). Order and position never change when counts update.
- One tree: projects as groups (caption with count and tree total), root rows (two lines, see Geometry), child rows on rails: active work first, newest started on top, then finished work, newest first, behind the "+ N finished" fold. A root's roll-up carries the states of its children, so a chat with a child that needs you shows "needs answer" on the root. The fold row hides the finished middle of a long child list ("12 finished agents"); the cap row says how many older children live in History.
- The overview opens when Live has no selected node. It shows Running, Needs you and Needs attention. The finished control expands rows in place. See Live overview below.
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

- The feed shows everything; there is no filter. A message is a card (`--panel-2`, one even 1 px `--border`, 8 px corners, no colored edge): avatar, "sender → receiver" in the actor colors, a tag, the time. The actor never tints the card's fill or its border. Chat actors: You → Claude, Claude → You, Claude work (clay ring dot). Codex work folds into one "Codex work" row, a Claude agent's work into one "Agent work" row; work rows sit indented under their message with no rail. Each run of injected context folds into one dashed System row.
- Run markers (`.marker`) are thin centered rules: Turn started, ✓ Turn complete (green), Turn aborted (red), "Run 1 of 2 · finished 25m ago · show its result"; `.marker.warn` (amber) for a run that needs attention. The green confirmation row (`.done-row`) marks a finished handoff.
- While the task is Running, the feed ends with "Codex is working · <latest step>" (or "Claude agent is working") in the Running blue.
- Jump to latest (`#feed-pill`) floats over the bottom of the feed while the reader has scrolled up; it carries the "N new" count in `--tree-text`.
- Messages, thinking steps and the result card render a safe Markdown subset built as DOM nodes with `textContent`; untrusted output never becomes `innerHTML` (the GL constants are the one trusted exception).
- The "Result from Codex" card (teal avatar, one even 1 px border, 8 px radius) sits between the toolbar and the feed; its question callout is pink; the answer box's primary button is `--accent-fill` with an `--accent` border.

## Motion and accessibility

- Hover, selection, border, and color transitions use 140 to 180 ms. The drawer slides in 180 ms. Nothing else moves.
- Buttons, tabs, chips, rows, and the resize separator must remain keyboard accessible.
- Focus uses a visible 2 px `--accent` outline on buttons, inputs, selects, text areas, disclosure summaries and the resize separator. Group captions use the same inset and corner radius as rows.
- Reduced motion freezes the arcs (a still three-quarter arc) and the breathing dots, and uses automatic feed scrolling.
- Dangerous process controls stay inside the task-actions menu and require confirmation.
