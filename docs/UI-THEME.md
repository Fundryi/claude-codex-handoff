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

Status color has one meaning everywhere: session cards, filters, and the selected-task header.

| Status | Color | Behavior |
|---|---|---|
| Running | Blue `#67a8ff` | Circular spinner indicates active work |
| Waiting | Yellow `#e5b849` | Quiet for at least 20 seconds |
| Possibly stuck | Orange `#ee964b` | Quiet for more than 10 minutes without completion |
| Finished | Green `#4ac26b` | Completion event received |
| All | Gray `#7b8794` | Neutral collection, not a task state |

Do not animate an entire row or badge. Only the small Running spinner moves.

## Geometry and spacing

- Header icon and follow controls are 32 px high.
- Feed toolbar and status-filter controls are 28 px high.
- Controls within one row share the same vertical position.
- Corners use a 6 or 7 px radius; status badges remain pill-shaped.
- The session list starts at 340 px, can be resized from 240 px to 55% of the viewport, and remembers the chosen width.
- At 760 px and below, the session list becomes an overlay drawer and the content remains a single full-width column.
- The page must never create horizontal document scrolling. Long paths, commands, patches, and messages wrap inside their own container.

Compact spacing is the only layout. There is no separate Comfortable density.

## Navigation behavior

- Filters are a fixed vertical list. Their order and position do not change when counts update.
- Choosing a filter pauses Follow newest. A background update must not override an explicit filter choice.
- Follow newest is resumed only through its button. When resumed, it selects the newest Running task and shows the Running filter.
- If the selected task itself changes status, its filter follows that new status so the selected card remains visible.
- All remains All when the selected task changes status.
- Sidebar width, collapsed state, filter, search, feed view, selected task, auto-follow, and auto-scroll persist in the browser.

## Feed behavior

- Activity is the default and hides internal instruction dumps.
- Raw log exposes all events for diagnosis.
- Commands, tool output, thinking, patches, and long messages start collapsed.
- Render at most 160 Activity events or 80 Raw events initially. Earlier events remain available through Show earlier activity.
- Auto-scroll follows new events only while the reader is already near the bottom. Otherwise show Jump to latest.

## Motion and accessibility

- Hover, selection, border, and color transitions use 140–180 ms.
- Buttons, filters, sessions, and the resize separator must remain keyboard accessible.
- Focus uses a visible blue 2 px outline.
- Dangerous process controls stay inside the task-actions menu and require confirmation.
