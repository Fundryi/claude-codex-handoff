# History Search — Design

Date: 2026-07-12
Status: Approved by user

## Goal

Search must work beyond the 40 tracked sessions. The viewer indexes metadata
(title, project, thread id, date) of ALL rollout files — `~/.codex/sessions`
and `~/.codex/archived_sessions` (617+ files today) — and lets the user find
and open any of them.

Scope decision (user-confirmed): metadata search only. Full-text search of
conversation content is a possible later addition, not part of this feature.

## Server

- `collectRolloutFiles()`: current walk, both dirs, mtime-sorted, no cap.
  `listRolloutFiles()` becomes `collectRolloutFiles().slice(0, MAX_SESSIONS)`.
- **Search index**: `Map<file, entry>` where entry = `{ file, id, threadId,
  title, cwd, mtimeMs, archived }`. Built by reading only the first 64 KB of
  each file through the existing `simplify()` parser (session_meta → cwd and
  threadId, first real user message → title). Entries cached by `mtimeMs`;
  unchanged files are never re-read. Full build runs right after the server
  starts listening and refreshes every 30 s (cheap after first pass — stat
  calls only).
- **`GET /search?q=`**: splits the query into terms (max 8), AND-matches all
  terms against `title + cwd + threadId + id` (case-insensitive substring),
  sorts by recency, returns top 50 as JSON plus `{ ready, indexed }` status.
- **`POST /open?id=<sessionId>`**: id must exist in the index (no arbitrary
  paths). Pins the file (LRU, max 10 pinned) and ingests it so it becomes a
  tracked session; pinned files survive the top-40 cut in `tick()`. Origin
  check like the other control endpoints.

## UI

- Search input keeps filtering the live sessions instantly, and additionally
  queries `/search` debounced (250 ms).
- Results not already in the live list render in a **History** section at the
  bottom of the session list: title, project, relative date, Archived badge
  where applicable, "History" badge otherwise.
- Clicking a history row calls `/open?id=`, selects the session; the feed
  fills from the SSE events broadcast that ingesting triggers.
- Empty query clears the History section.

## Read-only guarantee unchanged

Indexing reads files; `/open` only causes the server to *read* one more file.
Nothing writes to `~/.codex`.

## Testing

- `tests/search.test.js`: extracts `searchMatch` from `codex-live-viewer.js`
  via regex + `vm` (same pattern as the UI tests) — term AND-matching,
  case-insensitivity, empty-query behavior.
- UI helper `mergeHistoryResults(results, liveIds)` (helpers block) unit
  tested: filters out sessions already shown live.

## Out of scope

- Full-text content search
- Raising MAX_SESSIONS
- Persisting the index to disk
