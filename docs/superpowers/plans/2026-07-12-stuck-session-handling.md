# Stuck-Session Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safe stop-task flow with an in-app detail modal, human-readable "why is it waiting" info for IDLE/STALE sessions, and copy actions that let the user actually continue or fork a stuck Codex job.

**Architecture:** The Node server (`codex-live-viewer.js`) gains three structured fields in its session summary. All UI work happens in `viewer-ui.html`: new pure helper functions (unit-tested via the existing regex-extract + `vm.runInNewContext` pattern), a stop-confirmation modal replacing `window.confirm`/`window.alert`, a waiting-reason line in the task header, and two new clipboard actions in the task menu.

**Tech Stack:** Node 18+ (zero npm dependencies), vanilla JS/HTML/CSS, `node --test` for tests.

## Global Constraints

- The viewer stays **read-only**: it must never spawn `codex`, never write to session files. New actions are clipboard-copy only.
- Zero npm dependencies. Tests use only `node:` built-ins.
- Do NOT modify the embedded `FALLBACK_PAGE` string inside `codex-live-viewer.js` — it is a compatibility fallback and stays as-is.
- All user-visible text rendered from session data must use `textContent` (never `innerHTML`) — session titles/commands come from rollout files.
- Match existing code style in `viewer-ui.html`: `var`, function declarations, 2-space indent, single quotes in JS.
- Run tests with: `npm test` (runs `node --test tests/*.test.js`).
- Spec: `docs/superpowers/specs/2026-07-12-stuck-session-handling-design.md`.

---

### Task 1: Structured session-summary fields (server)

**Files:**
- Modify: `codex-live-viewer.js` (function `sessionSummary`, around lines 191–210)

**Interfaces:**
- Produces: each session object sent over SSE gains `quietMs` (number, ms since last file growth), `lastKind` (string, kind of last event or `""`), `lastText` (string, last event text truncated to 120 chars or `""`). Existing fields (`lastEvent`, `status`, `lastGrow`, …) unchanged.

- [ ] **Step 1: Add the fields**

In `codex-live-viewer.js`, replace the body of `sessionSummary` so the returned object includes the three new fields. The current function is:

```js
function sessionSummary(s) {
  // LIVE: file is growing. DONE: wrote task_complete. IDLE: quiet but recent
  // (slow tool call / thinking). STALE: quiet >10min and never completed - dead/aborted.
  const quiet = Date.now() - s.lastGrow;
  const status = quiet < LIVE_WINDOW_MS ? "LIVE"
    : s.events.some(e => e.kind === "done") ? "DONE"
    : quiet < STALE_AFTER_MS ? "IDLE" : "STALE";
  const last = s.events[s.events.length - 1];
  return {
    id: s.id,
    threadId: s.meta.threadId || "",
    title: s.meta.title || "",
    cwd: s.meta.cwd || "",
    model: s.meta.model || "",
    status,
    lastGrow: s.lastGrow,
    lastEvent: last ? (last.kind + ": " + String(last.text).slice(0, 90)) : "",
    eventCount: s.events.length,
  };
}
```

Change the returned object to:

```js
  return {
    id: s.id,
    threadId: s.meta.threadId || "",
    title: s.meta.title || "",
    cwd: s.meta.cwd || "",
    model: s.meta.model || "",
    status,
    lastGrow: s.lastGrow,
    quietMs: quiet,
    lastKind: last ? last.kind : "",
    lastText: last ? String(last.text).slice(0, 120) : "",
    lastEvent: last ? (last.kind + ": " + String(last.text).slice(0, 90)) : "",
    eventCount: s.events.length,
  };
```

- [ ] **Step 2: Syntax-check and run existing tests**

Run: `node -c codex-live-viewer.js && npm test`
Expected: syntax OK, all existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add codex-live-viewer.js
git commit -m "feat(server): expose quietMs/lastKind/lastText in session summary"
```

---

### Task 2: Pure helper functions + tests (waiting reason, warnings, commands)

**Files:**
- Modify: `viewer-ui.html` (script block — insert helpers after `firstLine`, before `setConnection`)
- Create: `tests/stuck-session.test.js`

**Interfaces:**
- Consumes: session summary fields from Task 1 (`quietMs`, `lastKind`, `lastText`, `lastEvent`, `status`), existing helper `firstLine(text, limit)`.
- Produces (all inside the `viewer-ui.html` script, used by Tasks 3–5):
  - `formatDuration(ms)` → `"42s"` / `"3m 12s"` / `"2h 5m"`
  - `waitReason(session)` → `""` unless status is `IDLE`/`STALE`, else `'Waiting <dur> — last activity: <phrase>'`
  - `processWarnings(proc, sessionStartMs)` → `{ shared: boolean, timeMatch: boolean }`
  - `resumeCommand(threadId)` → `'codex resume <id>'`
  - `continueCommand(threadId)` → `'codex exec resume <id> "Continue the previous task where it left off and finish it."'`
  - `forkCommand(threadId)` → `'codex fork <id>'`

- [ ] **Step 1: Write the failing tests**

Create `tests/stuck-session.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// extract firstLine + the stuck-session helpers that follow it
const helpers = script.match(
  /function firstLine[\s\S]*?(?=\n    function setConnection)/,
)[0];

function helperContext() {
  const context = {};
  vm.runInNewContext(helpers, context);
  return context;
}

test("formatDuration renders seconds, minutes, hours", () => {
  const ctx = helperContext();
  assert.equal(ctx.formatDuration(42000), "42s");
  assert.equal(ctx.formatDuration(192000), "3m 12s");
  assert.equal(ctx.formatDuration(7500000), "2h 5m");
  assert.equal(ctx.formatDuration(-5), "0s");
});

test("waitReason is empty unless waiting or stuck", () => {
  const ctx = helperContext();
  assert.equal(ctx.waitReason({ status: "LIVE", quietMs: 5000 }), "");
  assert.equal(ctx.waitReason({ status: "DONE", quietMs: 5000 }), "");
  assert.equal(ctx.waitReason(null), "");
});

test("waitReason explains the last activity by kind", () => {
  const ctx = helperContext();
  assert.equal(
    ctx.waitReason({ status: "IDLE", quietMs: 60000, lastKind: "cmd", lastText: "npm test" }),
    'Waiting 1m 0s — last activity: running command "npm test"',
  );
  assert.equal(
    ctx.waitReason({ status: "STALE", quietMs: 60000, lastKind: "user", lastText: "do the thing" }),
    "Waiting 1m 0s — last activity: prompt sent, no agent response yet",
  );
  assert.equal(
    ctx.waitReason({ status: "IDLE", quietMs: 60000, lastKind: "agent", lastText: "done soon" }),
    "Waiting 1m 0s — last activity: agent replied — may be waiting for approval or next instruction",
  );
  // unknown kind falls back to the preformatted lastEvent
  assert.equal(
    ctx.waitReason({ status: "IDLE", quietMs: 60000, lastKind: "mystery", lastEvent: "mystery: ???" }),
    "Waiting 1m 0s — last activity: mystery: ???",
  );
});

test("processWarnings flags shared processes and start-time matches", () => {
  const ctx = helperContext();
  const t0 = 1000000;
  assert.deepEqual(
    ctx.processWarnings({ cmd: "codex app-server --port 1", started: t0 + 3000 }, t0),
    { shared: true, timeMatch: true },
  );
  assert.deepEqual(
    ctx.processWarnings({ cmd: "codex exec resume abc", started: t0 + 60000 }, t0),
    { shared: false, timeMatch: false },
  );
  assert.deepEqual(
    ctx.processWarnings({ cmd: "codex mcp-server", started: 0 }, 0),
    { shared: true, timeMatch: false },
  );
});

test("copy command builders produce exact codex CLI invocations", () => {
  const ctx = helperContext();
  assert.equal(ctx.resumeCommand("abc-123"), "codex resume abc-123");
  assert.equal(
    ctx.continueCommand("abc-123"),
    'codex exec resume abc-123 "Continue the previous task where it left off and finish it."',
  );
  assert.equal(ctx.forkCommand("abc-123"), "codex fork abc-123");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: new tests FAIL (`formatDuration is not a function` etc.); the three existing navigation tests still PASS.

- [ ] **Step 3: Implement the helpers**

In `viewer-ui.html`, directly AFTER the `firstLine` function (which ends with `}` before `function setConnection`), insert:

```js
    function formatDuration(ms) {
      var seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      if (seconds < 60) return seconds + 's';
      var minutes = Math.floor(seconds / 60);
      if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
      return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
    }
    function waitReason(session) {
      if (!session || (session.status !== 'IDLE' && session.status !== 'STALE')) return '';
      var text = firstLine(session.lastText, 80);
      var phrase = ({
        cmd: 'running command "' + text + '"',
        out: 'processing command output',
        think: 'thinking (reasoning summary in progress)',
        tool: 'tool call "' + text + '"',
        user: 'prompt sent, no agent response yet',
        agent: 'agent replied — may be waiting for approval or next instruction'
      })[session.lastKind] || (session.lastEvent || 'no displayable activity');
      return 'Waiting ' + formatDuration(session.quietMs) + ' — last activity: ' + phrase;
    }
    function processWarnings(proc, sessionStartMs) {
      return {
        shared: /app-server|mcp/i.test(String(proc.cmd || '')),
        timeMatch: !!(sessionStartMs && proc.started && Math.abs(proc.started - sessionStartMs) < 15000)
      };
    }
    function resumeCommand(threadId) { return 'codex resume ' + threadId; }
    function continueCommand(threadId) {
      return 'codex exec resume ' + threadId + ' "Continue the previous task where it left off and finish it."';
    }
    function forkCommand(threadId) { return 'codex fork ' + threadId; }
```

Note: the test extraction regex requires these functions to sit between `firstLine` and `setConnection` — do not place them elsewhere.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer-ui.html tests/stuck-session.test.js
git commit -m "feat(ui): add waiting-reason, process-warning, and command helpers"
```

---

### Task 3: Waiting-reason line in header + badge tooltips

**Files:**
- Modify: `viewer-ui.html` (CSS block, `renderHeader`, `renderList`)

**Interfaces:**
- Consumes: `waitReason(session)` from Task 2; session fields from Task 1.

- [ ] **Step 1: Add CSS**

In the `<style>` block, after the `.meta-button:hover { color: var(--blue); }` rule, add:

```css
    #wait-reason {
      flex-basis: 100%;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      color: var(--yellow);
    }
    #wait-reason.STALE { color: #f0a254; }
```

- [ ] **Step 2: Render the reason line in the header**

In `renderHeader()` in `viewer-ui.html`, after the `values.forEach(...)` block and before the `if (session.threadId) {` block, insert:

```js
      var reason = waitReason(session);
      if (reason) {
        var reasonLine = document.createElement('span');
        reasonLine.id = 'wait-reason';
        reasonLine.className = 'meta-item ' + session.status;
        reasonLine.textContent = reason;
        reasonLine.title = reason;
        taskMeta.appendChild(reasonLine);
      }
```

(`taskMeta` is cleared with `taskMeta.textContent = ''` at the top of `renderHeader`, so no duplicate handling is needed. The `#wait-reason` CSS `flex-basis: 100%` wins over `.meta-item` for layout because `#task-meta` is `flex-wrap: wrap`.)

- [ ] **Step 3: Reason in the session-list badge tooltip**

In `renderList()`, the badge is currently built as:

```js
        var badge = document.createElement('span');
        badge.className = 'status ' + session.status;
        badge.textContent = STATUS[session.status].label;
        badge.title = STATUS[session.status].help;
```

Change the `badge.title` line to:

```js
        badge.title = waitReason(session) || STATUS[session.status].help;
```

Also update the header status badge in `renderHeader()` the same way — it currently reads:

```js
      taskStatus.title = STATUS[session.status].help;
```

change to:

```js
      taskStatus.title = waitReason(session) || STATUS[session.status].help;
```

- [ ] **Step 4: Run tests + manual smoke**

Run: `npm test` — Expected: PASS.
Run: `node codex-live-viewer.js serve` briefly, open http://localhost:8377, select an IDLE/STALE session, confirm the yellow reason line appears under the title and badge tooltips show the reason. Stop the server afterwards (Ctrl+C).

- [ ] **Step 5: Commit**

```bash
git add viewer-ui.html
git commit -m "feat(ui): explain why waiting/stuck sessions are quiet"
```

---

### Task 4: Stop-confirmation detail modal

**Files:**
- Modify: `viewer-ui.html` (HTML body, CSS block, stop-button JS)

**Interfaces:**
- Consumes: `processWarnings(proc, sessionStartMs)` from Task 2, existing `sessionStart(id)`, `currentSession()`, `projectName(cwd)`, existing endpoints `GET /procs` and `POST /kill?pid=`.

- [ ] **Step 1: Add modal markup**

In `viewer-ui.html`, add the modal as a sibling of `<main>` — insert it after the `</main>` closing tag and before the `<script>` tag:

```html
  <div id="stop-modal" hidden>
    <div id="stop-modal-box" role="dialog" aria-modal="true" aria-labelledby="stop-modal-title">
      <h2 id="stop-modal-title">Stop Codex process?</h2>
      <div id="stop-modal-body"></div>
      <div id="stop-modal-actions">
        <button id="stop-modal-cancel" type="button">Cancel</button>
        <button id="stop-modal-confirm" type="button">Stop process</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: Add modal CSS**

In the `<style>` block, after the `.kill-button` rule, add:

```css
    #stop-modal {
      position: fixed;
      inset: 0;
      z-index: 50;
      background: #000a;
      display: grid;
      place-items: center;
    }
    #stop-modal[hidden] { display: none; }
    #stop-modal-box {
      width: min(92vw, 560px);
      max-height: 84vh;
      overflow-y: auto;
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      box-shadow: 0 18px 50px #000c;
    }
    #stop-modal-box h2 { margin: 0 0 12px; font-size: 14px; }
    .stop-modal-row { display: flex; gap: 10px; margin-bottom: 6px; font-size: 12px; }
    .stop-modal-label { color: var(--muted); flex: none; width: 70px; }
    .stop-modal-value { min-width: 0; overflow-wrap: anywhere; }
    .stop-modal-warning {
      border-radius: 7px;
      padding: 8px 10px;
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.5;
    }
    .stop-modal-warning.red { background: #4a1512; color: #ffb3ad; border: 1px solid #7a2a24; }
    .stop-modal-warning.yellow { background: #453a14; color: #f0cb6e; border: 1px solid #6d5a1e; }
    .stop-modal-warning.ok { background: #14331e; color: #8fdca4; border: 1px solid #245c36; }
    #stop-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    #stop-modal-actions button {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 7px 12px;
      background: transparent;
      cursor: pointer;
      font-size: 12px;
    }
    #stop-modal-actions button:hover { background: var(--hover); }
    #stop-modal-confirm { background: #6d2925; border-color: #8a3a34; color: #ffd0cc; font-weight: 700; }
    #stop-modal-confirm:disabled { opacity: .6; cursor: default; }
```

- [ ] **Step 3: Wire the modal, replace confirm/alert**

In the script block, after the existing element lookups (near `var processPanel = ...`), add:

```js
    var stopModal = document.getElementById('stop-modal');
    var stopModalBody = document.getElementById('stop-modal-body');
    var stopModalConfirm = document.getElementById('stop-modal-confirm');
    var stopModalCancel = document.getElementById('stop-modal-cancel');
    var pendingKillPid = null;
```

Then add these functions and listeners (a good spot is right after the `copyText` function):

```js
    function modalRow(label, value, mono) {
      var row = document.createElement('div');
      row.className = 'stop-modal-row';
      var name = document.createElement('span');
      name.className = 'stop-modal-label';
      name.textContent = label;
      var val = document.createElement('span');
      val.className = 'stop-modal-value' + (mono ? ' mono' : '');
      val.textContent = value;
      row.append(name, val);
      return row;
    }

    function modalWarning(kind, text) {
      var warning = document.createElement('div');
      warning.className = 'stop-modal-warning ' + kind;
      warning.textContent = text;
      return warning;
    }

    function openStopModal(proc) {
      var session = currentSession();
      var startedMs = sessionStart(selected);
      var warnings = processWarnings(proc, startedMs);
      pendingKillPid = proc.pid;
      stopModalBody.textContent = '';
      stopModalBody.appendChild(modalRow('Task', (session && session.title) || 'Unknown task'));
      stopModalBody.appendChild(modalRow('Project', session ? projectName(session.cwd) : 'Unknown'));
      stopModalBody.appendChild(modalRow('PID', proc.pid + '  (' + proc.name + ')', true));
      stopModalBody.appendChild(modalRow('Started', proc.started ? new Date(proc.started).toLocaleTimeString() : 'Unknown'));
      stopModalBody.appendChild(modalRow('Command', String(proc.cmd || '(unknown command line)'), true));
      if (warnings.shared) {
        stopModalBody.appendChild(modalWarning('red',
          'Shared Codex process (app-server / MCP). It can host several tasks at once — stopping it stops ALL of them, not just this one.'));
      }
      if (warnings.timeMatch) {
        stopModalBody.appendChild(modalWarning('ok', 'Process start time matches this task’s start time.'));
      } else {
        stopModalBody.appendChild(modalWarning('yellow',
          'This process does not match this task’s start time. The task’s own process may already have exited.'));
      }
      stopModalBody.appendChild(modalWarning('red', 'Stopping kills the process and its entire child tree. This cannot be undone.'));
      stopModalConfirm.hidden = false;
      stopModalConfirm.disabled = false;
      stopModalCancel.textContent = 'Cancel';
      stopModal.hidden = false;
      stopModalCancel.focus();
    }

    stopModalConfirm.addEventListener('click', async function () {
      if (pendingKillPid == null) return;
      stopModalConfirm.disabled = true;
      var message = '';
      try { message = await (await fetch('/kill?pid=' + pendingKillPid, { method: 'POST' })).text(); }
      catch (error) { message = 'Request failed: ' + error; }
      pendingKillPid = null;
      stopModalBody.textContent = '';
      stopModalBody.appendChild(modalWarning(/^killed/i.test(message) ? 'ok' : 'yellow', message));
      stopModalConfirm.hidden = true;
      stopModalCancel.textContent = 'Close';
      processPanel.hidden = true;
    });
    stopModalCancel.addEventListener('click', function () {
      stopModal.hidden = true;
      pendingKillPid = null;
    });
    stopModal.addEventListener('click', function (event) {
      if (event.target === stopModal) { stopModal.hidden = true; pendingKillPid = null; }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !stopModal.hidden) { stopModal.hidden = true; pendingKillPid = null; }
    });
```

Finally, inside the existing `stopButton.addEventListener('click', ...)` process-row builder, replace the old kill handler:

```js
        kill.addEventListener('click', async function () {
          if (!window.confirm('Stop PID ' + process.pid + ' (' + process.name + ') and its entire child process tree?\n\nThis cannot be undone.')) return;
          var message = '';
          try { message = await (await fetch('/kill?pid=' + process.pid, { method: 'POST' })).text(); }
          catch (error) { message = 'Request failed: ' + error; }
          window.alert(message);
          processPanel.hidden = true;
        });
```

with:

```js
        kill.addEventListener('click', function () { openStopModal(process); });
```

After this task, `viewer-ui.html` must contain no calls to `window.confirm` or `window.alert`.

- [ ] **Step 4: Run tests + manual smoke**

Run: `npm test` — Expected: PASS.
Manual: serve the viewer, open a session, Task actions → "Stop task process…" → STOP on a row → modal shows details + warnings; Cancel and Escape close it; confirming on a bogus/already-dead PID shows the server's error text inside the modal (safe to try with a process that no longer exists).

- [ ] **Step 5: Commit**

```bash
git add viewer-ui.html
git commit -m "feat(ui): stop-task detail modal with shared-process warnings"
```

---

### Task 5: Continue + fork copy actions in the task menu

**Files:**
- Modify: `viewer-ui.html` (action menu HTML, copy handlers, `renderHeader`)

**Interfaces:**
- Consumes: `resumeCommand`, `continueCommand`, `forkCommand` from Task 2; existing `copyText(text, button, successLabel)`.

- [ ] **Step 1: Add menu buttons**

In the `#action-menu` div, currently:

```html
      <div id="action-menu" hidden>
        <button id="copy-resume" type="button">Copy resume command</button>
        <button id="stop-button" type="button">Stop task process&#x2026;</button>
      </div>
```

change to:

```html
      <div id="action-menu" hidden>
        <button id="copy-resume" type="button" title="codex resume — reopen this conversation interactively">Copy resume command</button>
        <button id="copy-continue" type="button" title="codex exec resume — continue this task headlessly where it left off">Copy continue command</button>
        <button id="copy-fork" type="button" title="codex fork — experiment on a copy; the original session stays untouched">Copy fork command</button>
        <button id="stop-button" type="button">Stop task process&#x2026;</button>
      </div>
```

- [ ] **Step 2: Wire handlers and visibility**

The existing copy-resume handler:

```js
    document.getElementById('copy-resume').addEventListener('click', function () {
      var session = currentSession();
      if (session && session.threadId) copyText('codex resume ' + session.threadId, this, 'Resume command copied');
    });
```

replace with:

```js
    [
      { id: 'copy-resume', build: resumeCommand, done: 'Resume command copied' },
      { id: 'copy-continue', build: continueCommand, done: 'Continue command copied' },
      { id: 'copy-fork', build: forkCommand, done: 'Fork command copied' }
    ].forEach(function (action) {
      document.getElementById(action.id).addEventListener('click', function () {
        var session = currentSession();
        if (session && session.threadId) copyText(action.build(session.threadId), this, action.done);
      });
    });
```

In `renderHeader()`, both places that toggle `copy-resume` visibility must now toggle all three. The no-session branch currently has:

```js
        stopButton.hidden = true;
        document.getElementById('copy-resume').hidden = true;
        return;
```

change to:

```js
        stopButton.hidden = true;
        ['copy-resume', 'copy-continue', 'copy-fork'].forEach(function (id) {
          document.getElementById(id).hidden = true;
        });
        return;
```

and the end of `renderHeader` currently has:

```js
      stopButton.hidden = session.status === 'DONE';
      document.getElementById('copy-resume').hidden = !session.threadId;
```

change to:

```js
      stopButton.hidden = session.status === 'DONE';
      ['copy-resume', 'copy-continue', 'copy-fork'].forEach(function (id) {
        document.getElementById(id).hidden = !session.threadId;
      });
```

- [ ] **Step 3: Run tests + manual smoke**

Run: `npm test` — Expected: PASS.
Manual: open the task actions menu on a session with a thread ID — three copy entries visible; each copies its exact command (paste to verify); on a session without a thread ID all three are hidden.

- [ ] **Step 4: Commit**

```bash
git add viewer-ui.html
git commit -m "feat(ui): copy continue and fork commands in task menu"
```

---

### Task 6: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update features list**

In `README.md`, replace the feature bullet:

```markdown
- Each session shows its thread ID and the matching `codex resume <id>` command.
```

with:

```markdown
- The task menu copies ready-to-paste `codex resume`, `codex exec resume` (headless continue), and `codex fork` commands for the selected session.
- Waiting and possibly-stuck sessions explain what they were last doing (running a command, thinking, waiting for a reply) and for how long.
```

and replace:

```markdown
- On Windows, you can inspect matching Codex processes and stop a stuck task after confirming the PID.
```

with:

```markdown
- On Windows, you can inspect matching Codex processes and stop a stuck task through a detail dialog that shows the full command line and warns before touching shared `app-server`/MCP processes.
```

- [ ] **Step 2: Add a "Recovering a stuck session" section**

Insert this section after the `## Optional: completion toasts (Windows)` section and before `## Security notes`:

```markdown
## Recovering a stuck session

1. Check the status: a **Waiting** or **Possibly stuck** task shows what it was last doing (for example `running command "npm test"`) and for how long.
2. If the process is truly stuck, open the task menu, choose `Stop task process…`, pick the matching PID, and review the confirmation dialog. It warns you when the process is a shared `app-server`/MCP host, because stopping one of those stops every task it hosts.
3. Continue the work: `Copy continue command` gives you `codex exec resume <id> "…"`, which resumes the same thread headlessly and finishes the task. `Copy resume command` opens the thread interactively instead, and `Copy fork command` experiments on a copy while leaving the original session untouched. (Verified against codex-cli 0.144.1.)

The viewer itself stays read-only: it never launches Codex or writes to session files. You paste the commands into your own terminal.
```

- [ ] **Step 3: Update the security note**

Replace the bullet:

```markdown
- The Windows stop feature runs `taskkill` only after you choose and confirm a PID. It checks the process again immediately before killing it. Rollout files do not contain a PID, so the suggested match is based on start time. Check the command line before stopping `codex app-server`, since that process may host several handoffs.
```

with:

```markdown
- The Windows stop feature runs `taskkill` only after you choose a PID and confirm it in a dialog that shows the full command line and start-time match. It checks the process again immediately before killing it. Rollout files do not contain a PID, so the suggested match is based on start time, and the dialog warns explicitly before stopping `codex app-server`/MCP processes that may host several handoffs.
```

- [ ] **Step 4: Final verification + commit**

Run: `npm test && node -c codex-live-viewer.js`
Expected: all tests PASS, syntax OK.

```bash
git add README.md
git commit -m "docs: stuck-session recovery guide and updated feature notes"
```
