# History Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Metadata search across ALL rollout files (sessions + archived, 600+), with results openable on demand — the 40-session display cap no longer limits search.

**Architecture:** The server builds an in-memory metadata index (first 64 KB of each rollout file, parsed with the existing `simplify()`), serves `GET /search?q=` and `POST /open?id=`. Opened sessions are pinned (LRU max 10) so `tick()` keeps them tracked. The UI adds a debounced History results section under the session list.

**Tech Stack:** Node 18+ (zero npm deps), vanilla JS/HTML/CSS, `node --test`.

## Global Constraints

- Viewer stays **read-only**: indexing and `/open` only read files; never write to `~/.codex`.
- Zero npm dependencies; tests use `node:` built-ins only.
- Do NOT modify the embedded `FALLBACK_PAGE` in `codex-live-viewer.js`.
- `textContent` only for session-derived text, never `innerHTML`.
- Match existing style: server file uses `const`/arrow-tolerant modern JS; `viewer-ui.html` uses `var`, single quotes, 2-space indent.
- Test command: `npm test`.
- Spec: `docs/superpowers/specs/2026-07-12-history-search-design.md`.

---

### Task 1: Server search index + /search endpoint (TDD)

**Files:**
- Modify: `codex-live-viewer.js`
- Create: `tests/search.test.js`

**Interfaces:**
- Produces: `collectRolloutFiles()` (all files, sorted by mtime desc), `searchMatch(entry, terms)` (pure), `indexEntry(file)`, `buildSearchIndex()`, `GET /search?q=` returning `{ ready, indexed, results: [{ id, threadId, title, cwd, mtimeMs, archived }] }`.

- [ ] **Step 1: Write the failing test**

Create `tests/search.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const searchMatchSource = source.match(/function searchMatch[\s\S]*?\n}/)[0];

function searchContext() {
  const context = {};
  vm.runInNewContext(searchMatchSource, context);
  return context;
}

test("searchMatch requires every term, case-insensitively", () => {
  const ctx = searchContext();
  const entry = {
    title: "Fix the login bug",
    cwd: "D:\\GIT\\MyApp",
    threadId: "019f5265-e45b",
    id: "rollout-2026-07-11T20-17-22-019f5265",
  };
  assert.equal(ctx.searchMatch(entry, ["login"]), true);
  assert.equal(ctx.searchMatch(entry, ["LOGIN", "myapp"]), true);
  assert.equal(ctx.searchMatch(entry, ["login", "otherproject"]), false);
  assert.equal(ctx.searchMatch(entry, ["019f5265"]), true);
  assert.equal(ctx.searchMatch(entry, []), false);
});

test("searchMatch tolerates missing fields", () => {
  const ctx = searchContext();
  assert.equal(ctx.searchMatch({ id: "rollout-x" }, ["rollout-x"]), true);
  assert.equal(ctx.searchMatch({}, ["anything"]), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the two new tests FAIL (regex match returns null → TypeError, or searchMatch undefined); all other tests PASS.

- [ ] **Step 3: Implement on the server**

In `codex-live-viewer.js`:

(a) Split the file listing. Replace the current `listRolloutFiles()` (walks and slices) with:

```js
function collectRolloutFiles() {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(SESSIONS_DIR, 0);
  walk(ARCHIVED_DIR, 0);
  out.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  return out;
}

function listRolloutFiles() {
  return collectRolloutFiles().slice(0, MAX_SESSIONS);
}
```

(b) After the `sessions`/`sseClients` declarations near the top, add:

```js
const searchIndex = new Map(); // file -> { file, id, threadId, title, cwd, mtimeMs, archived }
let searchIndexReady = false;
```

(c) After the `simplify()` function, add the index code and the pure matcher (keep `searchMatch` as a top-level `function` declaration ending with a `}` at column 0 — the test extracts it by regex):

```js
// ---------------- metadata search index (all sessions, not just top-40) ----------------
function indexEntry(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const cached = searchIndex.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached;
  const entry = {
    file,
    id: path.basename(file, ".jsonl"),
    threadId: "",
    title: "",
    cwd: "",
    mtimeMs: st.mtimeMs,
    archived: file.startsWith(ARCHIVED_DIR),
  };
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(st.size, 64 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const ev = simplify(line);
      if (!ev) continue;
      if (ev.kind === "meta") {
        if (ev.cwd) entry.cwd = ev.cwd;
        if (ev.id) entry.threadId = ev.id;
      } else if (ev.kind === "user" && !entry.title) {
        const first = String(ev.text).split("\n").map(l => l.trim())
          .find(l => l && !l.startsWith("<") && !l.startsWith("</"));
        if (first) entry.title = first.slice(0, 100);
      }
      if (entry.title && entry.threadId && entry.cwd) break;
    }
  } catch { /* unreadable file - keep the bare entry so it is still findable by id */ }
  searchIndex.set(file, entry);
  return entry;
}

function buildSearchIndex() {
  const files = collectRolloutFiles();
  const live = new Set(files);
  for (const f of files) indexEntry(f);
  for (const key of searchIndex.keys()) if (!live.has(key)) searchIndex.delete(key);
  searchIndexReady = true;
}

function searchMatch(entry, terms) {
  if (!terms.length) return false;
  const hay = ((entry.title || "") + " " + (entry.cwd || "") + " " +
    (entry.threadId || "") + " " + (entry.id || "")).toLowerCase();
  return terms.every(t => hay.includes(t));
}
```

(d) Add the endpoint in the HTTP handler, before the final `else` (404) branch:

```js
  } else if (req.url.startsWith("/search?q=")) {
    const q = decodeURIComponent(req.url.slice("/search?q=".length)).trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
    const results = [];
    for (const entry of searchIndex.values()) {
      if (searchMatch(entry, terms)) results.push(entry);
    }
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ready: searchIndexReady,
      indexed: searchIndex.size,
      results: results.slice(0, 50).map(e => ({
        id: e.id, threadId: e.threadId, title: e.title, cwd: e.cwd,
        mtimeMs: e.mtimeMs, archived: e.archived,
      })),
    }));
  } else if (req.url === "/events") {
```

(the `/events` line shows where the insertion lands — directly before it).

(e) Kick off the index in `serve()`, inside the `server.on("listening", ...)` callback after `setInterval(tick, POLL_MS);`:

```js
    setTimeout(buildSearchIndex, 50);
    setInterval(buildSearchIndex, 30000);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && node -c codex-live-viewer.js`
Expected: all PASS, syntax OK.

- [ ] **Step 5: Commit**

```bash
git add codex-live-viewer.js tests/search.test.js
git commit -m "feat(server): metadata search index over all rollout files"
```

---

### Task 2: /open endpoint with pinning

**Files:**
- Modify: `codex-live-viewer.js`

**Interfaces:**
- Consumes: `searchIndex` from Task 1.
- Produces: `POST /open?id=<sessionId>` — pins + ingests the file, responds `{ ok: true, id }` or 404 JSON error. Pinned files survive the top-40 cut in `tick()` (LRU, max 10).

- [ ] **Step 1: Add the pin store**

Next to the `searchIndex` declaration, add:

```js
const pinnedFiles = new Map(); // file -> last-open timestamp (LRU, max 10)
const MAX_PINNED = 10;
```

- [ ] **Step 2: Respect pins in tick()**

`tick()` currently is:

```js
function tick() {
  const files = listRolloutFiles();
  for (const f of files) ingest(f);
  for (const key of sessions.keys()) if (!files.includes(key)) sessions.delete(key);
  broadcast({ type: "sessions", sessions: files.map(f => sessions.get(f)).filter(Boolean).map(sessionSummary) });
}
```

change to:

```js
function tick() {
  const files = listRolloutFiles();
  for (const [file] of pinnedFiles) {
    if (!fs.existsSync(file)) { pinnedFiles.delete(file); continue; }
    if (!files.includes(file)) files.push(file);
  }
  for (const f of files) ingest(f);
  for (const key of sessions.keys()) if (!files.includes(key)) sessions.delete(key);
  broadcast({ type: "sessions", sessions: files.map(f => sessions.get(f)).filter(Boolean).map(sessionSummary) });
}
```

- [ ] **Step 3: Add the endpoint**

In the HTTP handler, directly before the `/search` branch added in Task 1, add:

```js
  } else if (req.url.startsWith("/open?id=")) {
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
    if (!trustedControlOrigin(req)) { res.writeHead(403); return res.end("untrusted origin"); }
    const id = decodeURIComponent(req.url.slice("/open?id=".length));
    const entry = [...searchIndex.values()].find(e => e.id === id);
    res.writeHead(entry ? 200 : 404, { "Content-Type": "application/json" });
    if (!entry) return res.end(JSON.stringify({ ok: false, error: "unknown session id" }));
    pinnedFiles.set(entry.file, Date.now());
    while (pinnedFiles.size > MAX_PINNED) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [file, ts] of pinnedFiles) if (ts < oldestTs) { oldestTs = ts; oldestKey = file; }
      pinnedFiles.delete(oldestKey);
    }
    ingest(entry.file);
    tick();
    res.end(JSON.stringify({ ok: true, id }));
  } else if (req.url.startsWith("/search?q=")) {
```

Note: `/open` only reads a rollout file the index already knows — no arbitrary paths reach the filesystem.

- [ ] **Step 4: Verify and commit**

Run: `npm test && node -c codex-live-viewer.js`
Expected: all PASS.

```bash
git add codex-live-viewer.js
git commit -m "feat(server): open pinned history sessions on demand"
```

---

### Task 3: UI history results section (TDD)

**Files:**
- Modify: `viewer-ui.html`
- Modify: `tests/stuck-session.test.js`

**Interfaces:**
- Consumes: `GET /search?q=`, `POST /open?id=` from Tasks 1–2.
- Produces: helper `mergeHistoryResults(results, liveIds)` in the helpers block (between `firstLine` and `setConnection`).

- [ ] **Step 1: Write the failing test**

Append to `tests/stuck-session.test.js`:

```js
test("mergeHistoryResults drops sessions already shown live", () => {
  const ctx = helperContext();
  const results = [
    { id: "a", title: "one" },
    { id: "b", title: "two" },
    { id: "c", title: "three" },
  ];
  assert.deepEqual(
    JSON.parse(JSON.stringify(ctx.mergeHistoryResults(results, ["b"]))),
    [{ id: "a", title: "one" }, { id: "c", title: "three" }],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.mergeHistoryResults(null, ["b"]))), []);
});
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npm test`
Expected: new test FAILS; everything else PASSES.

- [ ] **Step 3: Implement the helper**

In the `viewer-ui.html` helpers block (between `firstLine` and `setConnection`), after `dismissedHides`, add:

```js
    function mergeHistoryResults(results, liveIds) {
      return (results || []).filter(function (entry) {
        return liveIds.indexOf(entry.id) === -1;
      });
    }
```

- [ ] **Step 4: Wire the search fetch and history rendering**

(a) State: after the `var renderLimits = {};` line, add:

```js
    var historyResults = [];
    var historySearchTimer = null;
```

(b) CSS, after the `.session.dismissed { opacity: .55; }` rule:

```css
    .history-caption {
      padding: 10px 12px 4px;
      color: var(--faint);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .8px;
      text-transform: uppercase;
    }
    .status.HISTORY { background: #20262f; color: #8c9bab; }
```

(c) Replace the current search input listener:

```js
    search.addEventListener('input', function () {
      prefs.query = search.value;
      savePrefs();
      renderList();
    });
```

with:

```js
    search.addEventListener('input', function () {
      prefs.query = search.value;
      savePrefs();
      renderList();
      window.clearTimeout(historySearchTimer);
      var query = String(prefs.query || '').trim();
      if (!query) {
        historyResults = [];
        lastListSignature = '';
        renderList();
        return;
      }
      historySearchTimer = window.setTimeout(async function () {
        try {
          var response = await fetch('/search?q=' + encodeURIComponent(query));
          var data = await response.json();
          if (String(prefs.query || '').trim() !== query) return; // stale response
          historyResults = data.results || [];
        } catch (_) {
          historyResults = [];
        }
        lastListSignature = '';
        renderList();
      }, 250);
    });
```

(d) In `renderList()`, include history in the signature — the signature array gains a final element after the `shown.map(...)` entry:

```js
        historyResults.map(function (entry) { return entry.id; })
```

(e) At the end of `renderList()`, after the `if (!shown.length) { ... }` block, append the history section:

```js
      var history = String(prefs.query || '').trim()
        ? mergeHistoryResults(historyResults, shown.map(function (session) { return session.id; }))
        : [];
      if (history.length) {
        var caption = document.createElement('div');
        caption.className = 'history-caption';
        caption.textContent = 'History — older sessions (' + history.length + ')';
        list.appendChild(caption);
        history.forEach(function (entry) {
          var row = document.createElement('button');
          row.type = 'button';
          row.className = 'session';
          var top = document.createElement('div');
          top.className = 'session-top';
          var badge = document.createElement('span');
          badge.className = 'status ' + (entry.archived ? 'ARCHIVED' : 'HISTORY');
          badge.textContent = entry.archived ? 'Archived' : 'History';
          badge.title = 'Not in the live list. Click to load this session.';
          top.appendChild(badge);
          var time = document.createElement('span');
          time.className = 'session-time';
          time.textContent = relativeTime(entry.mtimeMs);
          top.appendChild(time);
          var title = document.createElement('div');
          title.className = 'session-title';
          title.textContent = entry.title || 'Untitled Codex task';
          var project = document.createElement('div');
          project.className = 'session-project';
          project.textContent = projectName(entry.cwd);
          project.title = entry.cwd || '';
          row.append(top, title, project);
          row.addEventListener('click', function () { openHistorySession(entry.id); });
          list.appendChild(row);
        });
      }
```

(f) Add the opener function after `selectSession`:

```js
    async function openHistorySession(id) {
      try {
        var response = await fetch('/open?id=' + encodeURIComponent(id), { method: 'POST' });
        if (!response.ok) return;
        selectSession(id, true);
      } catch (_) {}
    }
```

(`selectSession` tolerates ids that are not yet in `sessions` — the header renders once the next sessions broadcast arrives, and the feed fills from the ingest events broadcast.)

- [ ] **Step 5: Run tests + manual smoke**

Run: `npm test`
Expected: all PASS.
Manual: serve the viewer, type a word from an old project (something not in the visible 40) into search — a "History" section appears with grey badges; clicking a row loads and selects that session; clearing the search removes the section.

- [ ] **Step 6: Commit**

```bash
git add viewer-ui.html tests/stuck-session.test.js
git commit -m "feat(ui): history search across all sessions"
```

---

### Task 4: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Feature bullet**

Replace the bullet:

```markdown
- The responsive dashboard includes search, human-readable status filters, Activity and Raw log views, a collapsible and resizable session list, and a safer task-actions menu.
```

with:

```markdown
- The responsive dashboard includes search, human-readable status filters, Activity and Raw log views, a collapsible and resizable session list, and a safer task-actions menu.
- Search covers ALL recorded sessions, not just the visible list: a metadata index (title, project, thread id) of every rollout file powers a History section, and clicking a result loads that session on demand.
```

- [ ] **Step 2: Limitations note**

In `## Limitations`, replace:

```markdown
- Sessions are detected by file growth. A session whose file stops growing for 20 s shows as IDLE even if the process is still alive (e.g. long-running silent tool call).
```

with:

```markdown
- Sessions are detected by file growth. A session whose file stops growing for 20 s shows as IDLE even if the process is still alive (e.g. long-running silent tool call).
- Search matches session metadata (title, project, thread id) — not the full conversation text.
```

- [ ] **Step 3: Verify and commit**

Run: `npm test && node -c codex-live-viewer.js`

```bash
git add README.md
git commit -m "docs: history search"
```
