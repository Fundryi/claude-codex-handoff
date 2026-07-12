# Archived Sessions Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show sessions archived with `codex archive` in the viewer under a new "Archived" filter, with a copy-`codex unarchive` action to restore them.

**Architecture:** The Node server scans `$CODEX_HOME/archived_sessions` in addition to `sessions` and marks those sessions with an `archived: true` summary flag. The UI adds an ARCHIVED filter, renders an "Archived" badge instead of the live status for those sessions, hides actions that make no sense on archived sessions (stop, resume/continue/fork, archive), and offers "Copy unarchive command" instead.

**Tech Stack:** Node 18+ (zero npm deps), vanilla JS/HTML/CSS, `node --test`.

## Global Constraints

- Viewer stays **read-only**: never spawns codex, never moves/writes session files. Unarchive is a clipboard-copy action.
- Zero npm dependencies; tests use `node:` built-ins only.
- Do NOT modify the embedded `FALLBACK_PAGE` in `codex-live-viewer.js`.
- `textContent` only for session-derived text, never `innerHTML`.
- Match existing style in `viewer-ui.html` (`var`, single quotes, 2-space indent).
- Test command: `npm test`.
- Archived rollout files live flat in `~/.codex/archived_sessions/rollout-*.jsonl` (verified); `codex unarchive <id>` moves them back (verified against codex-cli 0.144.1).

---

### Task 1: Server scans archived_sessions and flags summaries

**Files:**
- Modify: `codex-live-viewer.js`

**Interfaces:**
- Produces: session summaries gain `archived: boolean`. Session state objects gain nothing else; archived detection is by file path prefix.

- [ ] **Step 1: Add the archived dir constant**

After the existing line:

```js
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
```

add:

```js
const ARCHIVED_DIR = path.join(CODEX_HOME, "archived_sessions");
```

- [ ] **Step 2: Scan both directories**

In `listRolloutFiles()`, the walk currently runs only on the sessions dir:

```js
  walk(SESSIONS_DIR, 0);
```

change to:

```js
  walk(SESSIONS_DIR, 0);
  walk(ARCHIVED_DIR, 0);
```

(The existing `walk` already tolerates missing directories via its try/catch, and the combined list is still mtime-sorted and capped at `MAX_SESSIONS` by the code below the walk calls.)

- [ ] **Step 3: Watch the archived dir too**

`watchSessions()` currently is:

```js
function watchSessions() {
  try { fs.watch(SESSIONS_DIR, { recursive: true }, kick); }
  catch { /* recursive watch unsupported on some platforms - poll covers it */ }
}
```

change to:

```js
function watchSessions() {
  try { fs.watch(SESSIONS_DIR, { recursive: true }, kick); }
  catch { /* recursive watch unsupported on some platforms - poll covers it */ }
  try { fs.watch(ARCHIVED_DIR, { recursive: true }, kick); }
  catch { /* dir may not exist yet - the 1s poll covers it */ }
}
```

- [ ] **Step 4: Flag archived sessions in the summary**

In `sessionSummary(s)`, after the `status,` line in the returned object, add:

```js
    archived: s.file.startsWith(ARCHIVED_DIR),
```

- [ ] **Step 5: Verify and commit**

Run: `node -c codex-live-viewer.js && npm test`
Expected: syntax OK, all tests PASS.

```bash
git add codex-live-viewer.js
git commit -m "feat(server): track archived sessions from archived_sessions dir"
```

---

### Task 2: UI filter logic + unarchive helper (TDD)

**Files:**
- Modify: `viewer-ui.html` (helpers block, `filterIncludes`, `visibleSessions`, `statusCount`, `waitReason`)
- Modify: `tests/stuck-session.test.js`

**Interfaces:**
- Consumes: `archived` flag from Task 1.
- Produces: `unarchiveCommand(threadId)` → `'codex unarchive <id>'`; `filterIncludes(session, filter)` understands the `'ARCHIVED'` filter id and excludes archived sessions from every other filter except `'ALL'`.

- [ ] **Step 1: Write failing tests**

Append to `tests/stuck-session.test.js`:

```js
const navigationSlice = script.match(/function filterIncludes[\s\S]*?\n    }/)[0];

test("unarchive command builder", () => {
  const ctx = helperContext();
  assert.equal(ctx.unarchiveCommand("abc-123"), "codex unarchive abc-123");
});

test("archived sessions only appear in Archived and All filters", () => {
  const ctx = {};
  vm.runInNewContext(navigationSlice, ctx);
  assert.equal(ctx.filterIncludes({ archived: true, status: "STALE" }, "ARCHIVED"), true);
  assert.equal(ctx.filterIncludes({ archived: true, status: "STALE" }, "STALE"), false);
  assert.equal(ctx.filterIncludes({ archived: true, status: "STALE" }, "ACTIVE"), false);
  assert.equal(ctx.filterIncludes({ archived: true, status: "STALE" }, "ALL"), true);
  assert.equal(ctx.filterIncludes({ archived: false, status: "STALE" }, "ARCHIVED"), false);
  assert.equal(ctx.filterIncludes({ status: "LIVE" }, "ACTIVE"), true);
  assert.equal(ctx.filterIncludes({ status: "DONE" }, "ACTIVE"), false);
});

test("waitReason stays silent for archived sessions", () => {
  const ctx = helperContext();
  assert.equal(ctx.waitReason({ status: "STALE", archived: true, quietMs: 60000, lastKind: "cmd", lastText: "x" }), "");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the three new tests FAIL; everything else PASSES.

- [ ] **Step 3: Implement**

(a) In the helpers block of `viewer-ui.html` (between `firstLine` and `setConnection` — required by the test extraction regex), after `archiveCommand`, add:

```js
    function unarchiveCommand(threadId) { return 'codex unarchive ' + threadId; }
```

(b) In `waitReason`, change the guard line from:

```js
      if (!session || (session.status !== 'IDLE' && session.status !== 'STALE')) return '';
```

to:

```js
      if (!session || session.archived || (session.status !== 'IDLE' && session.status !== 'STALE')) return '';
```

(c) Replace `filterIncludes` with:

```js
    function filterIncludes(session, filter) {
      if (filter === 'ARCHIVED') return !!session.archived;
      if (session.archived) return filter === 'ALL';
      return filter === 'ALL' ||
        (filter === 'ACTIVE' ? session.status !== 'DONE' : session.status === filter);
    }
```

(d) DRY `visibleSessions`: its inline `statusMatch` duplicates `filterIncludes`. Replace:

```js
        if (dismissedHides(session, prefs.filter, prefs.dismissed)) return false;
        var statusMatch = prefs.filter === 'ALL' ||
          (prefs.filter === 'ACTIVE' ? session.status !== 'DONE' : session.status === prefs.filter);
        if (!statusMatch) return false;
```

with:

```js
        if (dismissedHides(session, prefs.filter, prefs.dismissed)) return false;
        if (!filterIncludes(session, prefs.filter)) return false;
```

(e) DRY `statusCount` the same way. Replace its body with:

```js
    function statusCount(id) {
      if (id === 'ALL') return sessions.length;
      var pool = sessions.filter(function (s) { return !isDismissed(s.id); });
      return pool.filter(function (s) { return filterIncludes(s, id); }).length;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS (including the pre-existing navigation tests in `tests/viewer-ui-state.test.js`, which extract `filterIncludes` and must keep working).

- [ ] **Step 5: Commit**

```bash
git add viewer-ui.html tests/stuck-session.test.js
git commit -m "feat(ui): archived-aware filtering and unarchive command helper"
```

---

### Task 3: Archived filter tab, badge, and menu wiring

**Files:**
- Modify: `viewer-ui.html` (FILTERS/STATUS tables, CSS, `renderList`, `renderHeader`, action menu)

**Interfaces:**
- Consumes: `filterIncludes`/`unarchiveCommand` from Task 2, `archived` flag from Task 1.

- [ ] **Step 1: Add filter and status entries**

In the `STATUS` table, after the `DONE:` line, add:

```js
      ARCHIVED: { label: 'Archived', help: 'This session was archived with codex archive. Copy the unarchive command to bring it back.' }
```

(add a trailing comma to the `DONE` line). In `FILTERS`, insert before the `ALL` entry:

```js
      { id: 'ARCHIVED', label: 'Archived' },
```

- [ ] **Step 2: CSS**

After the `.status.DONE { ... }` rule add:

```css
    .status.ARCHIVED { background: #262d38; color: #9fb0c3; }
```

After the `.filter-button[data-filter="ALL"]::before { ... }` rule add:

```css
    .filter-button[data-filter="ARCHIVED"]::before { background: #9fb0c3; }
```

- [ ] **Step 3: Badge rendering**

In `renderList()`, the badge lines currently read:

```js
        var badge = document.createElement('span');
        badge.className = 'status ' + session.status;
        badge.textContent = STATUS[session.status].label;
        badge.title = waitReason(session) || STATUS[session.status].help;
```

change to:

```js
        var badge = document.createElement('span');
        var badgeStatus = session.archived ? 'ARCHIVED' : session.status;
        badge.className = 'status ' + badgeStatus;
        badge.textContent = STATUS[badgeStatus].label;
        badge.title = waitReason(session) || STATUS[badgeStatus].help;
```

In `renderHeader()`, the equivalent lines:

```js
      taskStatus.hidden = false;
      taskStatus.className = 'status ' + session.status;
      taskStatus.textContent = STATUS[session.status].label;
      taskStatus.title = waitReason(session) || STATUS[session.status].help;
```

change to:

```js
      taskStatus.hidden = false;
      var headerStatus = session.archived ? 'ARCHIVED' : session.status;
      taskStatus.className = 'status ' + headerStatus;
      taskStatus.textContent = STATUS[headerStatus].label;
      taskStatus.title = waitReason(session) || STATUS[headerStatus].help;
```

Also include the archived flag in the list re-render signature: in `renderList()`, the signature map line

```js
          return [session.id, session.status, session.lastGrow, session.title, session.cwd, session.lastEvent, unread.has(session.id), isDismissed(session.id)];
```

becomes:

```js
          return [session.id, session.status, session.lastGrow, session.title, session.cwd, session.lastEvent, unread.has(session.id), isDismissed(session.id), !!session.archived];
```

- [ ] **Step 4: Menu button + visibility**

In the `#action-menu` div, after the `copy-archive` button, add:

```html
        <button id="copy-unarchive" type="button" title="codex unarchive — move this session back into the active list (paste in your terminal)">Copy unarchive command</button>
```

In the copy-action wiring array, add the entry:

```js
      { id: 'copy-unarchive', build: unarchiveCommand, done: 'Unarchive command copied' }
```

In `renderHeader()`, the no-session branch currently hides:

```js
        ['copy-resume', 'copy-continue', 'copy-fork', 'copy-archive'].forEach(function (id) {
          document.getElementById(id).hidden = true;
        });
```

change the array to include `'copy-unarchive'`. The with-session branch currently ends with:

```js
      stopButton.hidden = session.status === 'DONE';
      var dismissButton = document.getElementById('dismiss-button');
      dismissButton.hidden = false;
      dismissButton.textContent = isDismissed(session.id) ? 'Restore task' : 'Dismiss task';
      ['copy-resume', 'copy-continue', 'copy-fork', 'copy-archive'].forEach(function (id) {
        document.getElementById(id).hidden = !session.threadId;
      });
```

change to:

```js
      stopButton.hidden = session.status === 'DONE' || !!session.archived;
      var dismissButton = document.getElementById('dismiss-button');
      dismissButton.hidden = false;
      dismissButton.textContent = isDismissed(session.id) ? 'Restore task' : 'Dismiss task';
      ['copy-resume', 'copy-continue', 'copy-fork', 'copy-archive'].forEach(function (id) {
        document.getElementById(id).hidden = !session.threadId || !!session.archived;
      });
      document.getElementById('copy-unarchive').hidden = !session.threadId || !session.archived;
```

(Resume/continue/fork/archive are hidden on archived sessions because codex cannot act on an archived thread until it is unarchived; stop is pointless since the file is static.)

- [ ] **Step 5: Verify and commit**

Run: `npm test` — Expected: all PASS.
Manual smoke: `node codex-live-viewer.js serve`, open http://localhost:8377 — the two existing archived sessions from 2026-07-11 must appear under the new Archived filter with grey "Archived" badges; their task menu shows only "Copy unarchive command" + "Dismiss task"; other filters do not contain them; All shows them. Stop the server afterwards.

```bash
git add viewer-ui.html
git commit -m "feat(ui): archived sessions tab with unarchive copy action"
```

---

### Task 4: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Feature bullet**

After the bullet about the task menu copy commands, add:

```markdown
- Sessions archived with `codex archive` appear under an Archived filter with a copy-paste `codex unarchive <id>` command to restore them.
```

- [ ] **Step 2: Recovery recipe**

In the `## Recovering a stuck session` section, extend step 4 by appending this sentence at its end:

```markdown
Archived sessions stay visible under the **Archived** filter, where `Copy unarchive command` gives you `codex unarchive <id>` to restore one.
```

- [ ] **Step 3: Verify and commit**

Run: `npm test && node -c codex-live-viewer.js`

```bash
git add README.md
git commit -m "docs: archived sessions tab"
```
