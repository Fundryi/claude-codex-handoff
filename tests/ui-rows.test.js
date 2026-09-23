const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// The whole pure-helper block, as tests/stuck-session.test.js extracts it.
const block = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];
// The old 8-filter rules (filterIncludes + dismissedHides), frozen here when the
// sidebar moved to tabs, to prove the new views keep them for session-only data.
function filterIncludes(session, filter) {
  if (filter === "ARCHIVED") return !!session.archived;
  if (session.archived) return filter === "ALL";
  return filter === "ALL" || (filter === "ACTIVE" ? session.status !== "DONE" : session.status === filter);
}
function dismissedHides(session, filter, dismissedIds) {
  return filter !== "ALL" && (dismissedIds || []).indexOf(session.id) !== -1;
}

function ctx() { const c = {}; vm.runInNewContext(block, c); return c; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
const ids = (items) => plain(items.map((entry) => entry.id));

const T0 = Date.parse("2026-09-22T10:00:00Z");
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

test("one session with three jobs on its thread is one row with the newest job", () => {
  const { buildRows } = ctx();
  const session = { id: "s6", threadId: "t6", status: "DONE", cwd: "D:\\work\\proj", lastGrow: T0 + 100 };
  // Deliberately not newest-first: the builder must pick by time, not by position.
  const jobs = [
    { id: "j6-1", threadId: "t6", status: "completed", live: "completed", title: "Fixture 6", updatedAt: iso(400) },
    { id: "j6-3", threadId: "t6", status: "completed", live: "completed", title: "Fixture 6", updatedAt: iso(1200), fast: true },
    { id: "j6-2", threadId: "t6", status: "completed", live: "completed", title: "Fixture 6", updatedAt: iso(800) }
  ];
  const rows = buildRows([session], jobs);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, "s6");
  assert.equal(row.session, session);
  assert.equal(row.job.id, "j6-3");
  assert.equal(row.olderJobs, 2);
  assert.equal(row.status, "FINISHED");
  assert.equal(row.title, "Fixture 6", "session without title borrows the job title");
  assert.equal(row.project, "D:\\work\\proj");
  assert.equal(row.threadId, "t6");
  assert.equal(row.fast, true, "fast comes from the newest job");
  assert.equal(row.needsAnswer, false);
  assert.equal(row.updatedMs, T0 + 1200, "newest of session growth and job update");
  assert.deepEqual(plain(row.children), []);
});

test("queued job without a session is its own row until the session appears", () => {
  const { buildRows, rowInView } = ctx();
  const queued = { id: "j7", threadId: null, status: "queued", live: "working", title: "Fixture 7", workspaceRoot: "D:\\w", updatedAt: iso(0) };
  const before = buildRows([], [queued]);
  assert.equal(before.length, 1);
  assert.equal(before[0].id, "job:j7");
  assert.equal(before[0].session, null);
  assert.equal(before[0].status, "RUNNING");
  assert.equal(before[0].project, "D:\\w");
  assert.equal(before[0].title, "Fixture 7");
  assert.equal(rowInView(before[0], "NOW", "RUNNING", []), true);
  assert.equal(rowInView(before[0], "HANDOFFS", "RUNNING", []), true);

  const started = Object.assign({}, queued, { threadId: "t7", status: "running" });
  const after = buildRows([{ id: "s7", threadId: "t7", status: "LIVE", lastGrow: T0 }], [started]);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "s7");
  assert.equal(after[0].job.id, "j7");
  assert.equal(after[0].olderJobs, 0);

  // Two sessionless jobs on one thread still collapse; a job with no thread stays alone.
  const orphans = buildRows([], [
    { id: "a", threadId: "tx", live: "failed", updatedAt: iso(0) },
    { id: "b", threadId: "tx", live: "completed", updatedAt: iso(50) },
    { id: "c", live: "failed", updatedAt: iso(10) },
    { id: "d", live: "failed", updatedAt: iso(20) }
  ]);
  assert.deepEqual(plain(orphans.map((r) => [r.id, r.olderJobs])), [["job:b", 1], ["job:d", 0], ["job:c", 0]]);
});

test("rowStatus: job liveness wins over session quiet time", () => {
  const { rowStatus } = ctx();
  const idle = { status: "IDLE" };
  const cases = [
    [idle, { live: "working" }, "RUNNING"],
    [idle, { status: "queued" }, "RUNNING"],
    [{ status: "LIVE" }, { live: "dead" }, "ATTENTION"],
    [idle, { live: "possibly-stuck" }, "ATTENTION"],
    [idle, { live: "failed" }, "ATTENTION"],
    // A thread resumed interactively after its handoff ended: the live session wins over the old job.
    [{ status: "LIVE" }, { live: "completed" }, "RUNNING"],
    [{ status: "LIVE" }, { live: "completed", needsDecision: "Which one?" }, "RUNNING"],
    [{ status: "LIVE" }, { live: "cancelled" }, "RUNNING"],
    [{ status: "LIVE", archived: true }, { live: "completed" }, "ARCHIVED"],
    [{ status: "IDLE" }, { live: "completed" }, "FINISHED"],
    [idle, { live: "completed", needsDecision: "Keep the API?" }, "ANSWER"],
    [idle, { live: "completed", needsDecision: "   " }, "FINISHED"],
    [idle, { live: "cancelled" }, "STOPPED"],
    [{ status: "DONE", archived: true }, { live: "completed" }, "ARCHIVED"],
    [{ status: "LIVE" }, null, "RUNNING"],
    [{ status: "IDLE" }, null, "WAITING"],
    [{ status: "STALE" }, null, "ATTENTION"],
    [{ status: "STOPPED" }, null, "STOPPED"],
    [{ status: "DONE" }, null, "FINISHED"],
    [{ status: "LIVE", archived: true }, null, "ARCHIVED"],
    [null, { live: "completed", needsDecision: "Which one?" }, "ANSWER"]
  ];
  for (const [session, job, want] of cases) {
    assert.equal(rowStatus(session, job), want, JSON.stringify([session, job]));
  }
});

test("child agents nest under the lead; counts skip children, dismissed and archived", () => {
  const { buildRows, viewCounts, rowInView } = ctx();
  const sessions = [
    { id: "lead", threadId: "L", status: "IDLE", lastGrow: T0 + 50 },
    { id: "kid1", threadId: "K1", parentThreadId: "L", status: "LIVE", agentNickname: "Ada", lastGrow: T0 + 90 },
    { id: "kid2", threadId: "K2", parentThreadId: "L", status: "LIVE", agentNickname: "Bo", lastGrow: T0 + 80 },
    { id: "gone", threadId: "G", status: "LIVE", lastGrow: T0 + 10 },
    { id: "old", threadId: "O", status: "DONE", archived: true, lastGrow: T0 },
    { id: "done", threadId: "D", status: "DONE", lastGrow: T0 + 5 }
  ];
  const jobs = [{ id: "jd", threadId: "D", live: "completed", updatedAt: iso(5) }];
  const rows = buildRows(sessions, jobs);
  assert.deepEqual(plain(rows.map((r) => r.id)), ["lead", "gone", "done", "old"]);
  const lead = rows[0];
  assert.deepEqual(plain(lead.children.map((r) => [r.id, r.status, r.title])), [["kid1", "RUNNING", "Agent Ada"], ["kid2", "RUNNING", "Agent Bo"]]);

  const counts = plain(viewCounts(rows, ["gone"]));
  assert.deepEqual(counts, {
    NOW: { ALL: 1, RUNNING: 0, WAITING: 1, ATTENTION: 0, ANSWER: 0 },
    HANDOFFS: { ALL: 1, RUNNING: 0, ATTENTION: 0, ANSWER: 0, FINISHED: 1, STOPPED: 0 },
    HISTORY: { FINISHED: 1, STOPPED: 0, ARCHIVED: 1, DISMISSED: 1, EVERYTHING: 4 }
  });
  // A tab's count is what clicking the tab shows: its first chip (History opens on Finished).
  const { tabCounts } = ctx();
  assert.deepEqual(plain(tabCounts(counts)), { NOW: 1, HANDOFFS: 1, HISTORY: 1 });
  const gone = rows[1];
  assert.equal(rowInView(gone, "NOW", "RUNNING", ["gone"]), false);
  assert.equal(rowInView(gone, "HISTORY", "DISMISSED", ["gone"]), true);
  assert.equal(rowInView(gone, "HISTORY", "EVERYTHING", ["gone"]), true);
  assert.equal(rowInView(rows[3], "HANDOFFS", "ALL", []), false, "archived rows stay out of Now and Handoffs");
  assert.equal(rowInView(rows[0], "NOW", "FINISHED", []), false, "chip must belong to the tab");
  assert.equal(rowInView(rows[0], "BOGUS", "ALL", []), false);
});

test("session-only rows land where today's filters put them", () => {
  const { buildRows, rowInView } = ctx();
  const mapping = [
    ["ACTIVE", "NOW", "ALL"], ["LIVE", "NOW", "RUNNING"], ["IDLE", "NOW", "WAITING"], ["STALE", "NOW", "ATTENTION"],
    ["DONE", "HISTORY", "FINISHED"], ["STOPPED", "HISTORY", "STOPPED"], ["ARCHIVED", "HISTORY", "ARCHIVED"], ["ALL", "HISTORY", "EVERYTHING"]
  ];
  for (const status of ["LIVE", "IDLE", "STALE", "STOPPED", "DONE"]) {
    for (const archived of [false, true]) {
      for (const dismissed of [false, true]) {
        const session = { id: "s", threadId: "t", status, archived };
        const [row] = buildRows([session], []);
        const dismissedIds = dismissed ? ["s"] : [];
        for (const [filter, tab, chip] of mapping) {
          const today = filterIncludes(session, filter) && !dismissedHides(session, filter, dismissedIds);
          assert.equal(rowInView(row, tab, chip, dismissedIds), today, `${status} archived=${archived} dismissed=${dismissed} ${filter}`);
        }
      }
    }
  }
});

test("legacyFilterView maps every old filter and survives garbage", () => {
  const { legacyFilterView } = ctx();
  const want = {
    ACTIVE: ["NOW", "ALL"], JOBS: ["HANDOFFS", "ALL"], LIVE: ["NOW", "RUNNING"], IDLE: ["NOW", "WAITING"],
    STALE: ["NOW", "ATTENTION"], DONE: ["HISTORY", "FINISHED"], STOPPED: ["HISTORY", "STOPPED"],
    ARCHIVED: ["HISTORY", "ARCHIVED"], ALL: ["HISTORY", "EVERYTHING"]
  };
  for (const [filter, [tab, chip]] of Object.entries(want)) {
    assert.deepEqual(plain(legacyFilterView({ filter, home: false, autoScroll: true, sideWidth: 340 })), { tab, chip, overview: false }, filter);
  }
  assert.deepEqual(plain(legacyFilterView({ filter: "DONE", home: true })), { tab: "NOW", chip: "ALL", overview: true });
  const fallback = { tab: "NOW", chip: "ALL", overview: false };
  for (const junk of [null, undefined, "LIVE", 42, [], {}, { filter: "nope" }, { filter: {} }, { filter: "__proto__" }, { filter: "constructor" }, { filter: "toString" }, { home: "yes" }]) {
    assert.deepEqual(plain(legacyFilterView(junk)), fallback, JSON.stringify(junk));
  }
});

test("menuItems: grouped items with today's conditions", () => {
  const { buildRows, menuItems } = ctx();
  const row = (session, jobs) => buildRows(session ? [session] : [], jobs || [])[0];
  const win = { dismissed: false, windows: true };

  const live = menuItems(row({ id: "s", threadId: "t", status: "LIVE" }), win);
  assert.deepEqual(ids(live), ["dismiss", "copy-resume", "copy-continue", "copy-fork", "copy-archive", "show-processes", "stop"]);
  assert.deepEqual(plain([...new Set(live.map((i) => i.group))]), ["Session", "Terminal commands", "Diagnostics"]);
  assert.equal(live.find((i) => i.id === "stop").danger, true);
  for (const item of live) assert.ok(item.label && item.title, item.id);
  assert.match(live.find((i) => i.id === "copy-fork").title, /codex fork/);

  // Stop needs a live session on Windows.
  assert.deepEqual(ids(menuItems(row({ id: "s", threadId: "t", status: "LIVE" }), { windows: false })), ["dismiss", "copy-resume", "copy-continue", "copy-fork", "copy-archive"]);
  assert.ok(!ids(menuItems(row({ id: "s", threadId: "t", status: "DONE" }), win)).includes("stop"));
  const archived = menuItems(row({ id: "s", threadId: "t", status: "DONE", archived: true }), { dismissed: true, windows: true });
  assert.deepEqual(ids(archived), ["dismiss", "copy-unarchive"]);
  assert.equal(archived[0].label, "Restore task");

  // Cancel only while the job works; Resume only when resumable; full result once finished.
  const working = menuItems(row(null, [{ id: "j", threadId: "t", live: "working" }]), win);
  assert.deepEqual(ids(working), ["cancel-job", "dismiss", "copy-resume", "copy-continue", "copy-fork"]);
  assert.equal(working[0].group, "Job");
  assert.equal(working[0].danger, true);
  assert.deepEqual(ids(menuItems(row(null, [{ id: "j", threadId: "t", live: "dead" }]), win)), ["resume-job", "dismiss", "copy-resume", "copy-continue", "copy-fork"]);
  assert.deepEqual(ids(menuItems(row(null, [{ id: "j", live: "failed" }]), win)), ["show-result", "dismiss"], "no thread: nothing to resume or copy");
  const done = menuItems(row({ id: "s", threadId: "t", status: "DONE" }, [{ id: "j", threadId: "t", live: "completed" }]), win);
  assert.deepEqual(ids(done), ["show-result", "dismiss", "copy-resume", "copy-continue", "copy-fork", "copy-archive", "show-processes"]);

  // A stale session without a handoff job resumes from its thread; archived or job-owned ones do not.
  assert.deepEqual(ids(menuItems(row({ id: "s", threadId: "t", status: "STALE" }), win)).slice(0, 1), ["resume-session"]);
  assert.ok(!ids(menuItems(row({ id: "s", threadId: "t", status: "STALE", archived: true }), win)).includes("resume-session"));
  assert.ok(!ids(menuItems(row({ id: "s", threadId: "t", status: "STALE" }, [{ id: "j", threadId: "t", live: "possibly-stuck" }]), win)).some((id) => id.startsWith("resume")));
  assert.ok(!ids(menuItems(row({ id: "s", threadId: "t", status: "IDLE" }), win)).some((id) => id.startsWith("resume")));
});

test("viewContaining keeps the current view, then the row's own status chip, then a catch-all", () => {
  const { buildRows, viewContaining } = ctx();
  const one = (session, jobs) => buildRows(session ? [session] : [], jobs || [])[0];
  const view = (row, tab, chip, dismissed) => plain(viewContaining(row, tab, chip, dismissed || []));
  const running = one({ id: "s", threadId: "t", status: "LIVE" });
  assert.deepEqual(view(running, "NOW", "ALL"), { tab: "NOW", chip: "ALL" }, "already visible: no move");
  assert.deepEqual(view(one({ id: "s", threadId: "t", status: "IDLE" }), "NOW", "RUNNING"), { tab: "NOW", chip: "WAITING" });
  // Same tab first: a handoff that finishes while Handoffs/Running is open stays in Handoffs.
  const handoffDone = one({ id: "s", threadId: "t", status: "DONE" }, [{ id: "j", threadId: "t", live: "completed" }]);
  assert.deepEqual(view(handoffDone, "HANDOFFS", "RUNNING"), { tab: "HANDOFFS", chip: "FINISHED" });
  // Now has no Finished chip: History before Handoffs (old filter DONE = History/Finished).
  assert.deepEqual(view(handoffDone, "NOW", "RUNNING"), { tab: "HISTORY", chip: "FINISHED" });
  assert.deepEqual(view(one({ id: "s", threadId: "t", status: "DONE" }), "NOW", "WAITING"), { tab: "HISTORY", chip: "FINISHED" });
  assert.deepEqual(view(one({ id: "s", threadId: "t", status: "STOPPED" }), "HISTORY", "FINISHED"), { tab: "HISTORY", chip: "STOPPED" });
  assert.deepEqual(view(one({ id: "s", threadId: "t", status: "DONE", archived: true }), "NOW", "ALL"), { tab: "HISTORY", chip: "ARCHIVED" });
  assert.deepEqual(view(running, "NOW", "RUNNING", ["s"]), { tab: "HISTORY", chip: "DISMISSED" });
  assert.deepEqual(view(running, "BOGUS", "ALL"), { tab: "NOW", chip: "RUNNING" }, "garbage current view falls through");
  assert.deepEqual(view(one(null, [{ id: "j", live: "failed" }]), "HISTORY", "FINISHED"), { tab: "NOW", chip: "ATTENTION" });
});

test("findRow finds a top-level row by its own id or a child agent's id", () => {
  const { buildRows, findRow } = ctx();
  const rows = buildRows([
    { id: "lead", threadId: "L", status: "IDLE", lastGrow: T0 + 5 },
    { id: "kid", threadId: "K", parentThreadId: "L", status: "LIVE", lastGrow: T0 + 9 },
    { id: "solo", threadId: "S", status: "DONE", lastGrow: T0 }
  ], [{ id: "j", live: "failed", updatedAt: iso(1) }]);
  assert.equal(findRow(rows, "solo").id, "solo");
  assert.equal(findRow(rows, "kid").id, "lead", "a child agent is shown under its lead");
  assert.equal(findRow(rows, "job:j").id, "job:j");
  assert.equal(findRow(rows, "missing"), null);
  assert.equal(findRow(rows, null), null);
  assert.equal(findRow(null, "solo"), null);
});

test("savedView: stored tab and chip win, otherwise the old filter or home maps over", () => {
  const { savedView } = ctx();
  const v = (prefs) => plain(savedView(prefs));
  assert.deepEqual(v({ tab: "HANDOFFS", chip: "FINISHED", filter: "LIVE" }), { tab: "HANDOFFS", chip: "FINISHED" });
  assert.deepEqual(v({ tab: "NOW", chip: "FINISHED", filter: "JOBS" }), { tab: "HANDOFFS", chip: "ALL" }, "chip outside its tab is junk");
  assert.deepEqual(v({ filter: "DONE", home: false }), { tab: "HISTORY", chip: "FINISHED" });
  assert.deepEqual(v({ filter: "ALL" }), { tab: "HISTORY", chip: "EVERYTHING" });
  assert.deepEqual(v({ filter: "STALE", home: true }), { tab: "NOW", chip: "ALL" });
  for (const junk of [null, undefined, "NOW", {}, { tab: "__proto__", chip: "ALL" }, { tab: "NOW", chip: "toString" }, { tab: ["NOW"], chip: "ALL" }]) {
    assert.deepEqual(v(junk), { tab: "NOW", chip: "ALL" }, JSON.stringify(junk));
  }
});

test("rowMatch: title matches need no hint, other fields name what matched", () => {
  const { buildRows, rowMatch } = ctx();
  const rows = buildRows([
    { id: "rollout-a", threadId: "019a-thread", status: "LIVE", title: "Fix the retry loop", cwd: "D:\\GIT\\alpha-repo", model: "gpt-5", lastGrow: T0 + 9 },
    { id: "lead", threadId: "L", status: "IDLE", title: "Lead run", cwd: "D:\\b", lastGrow: T0 + 5 },
    { id: "kid", threadId: "K", parentThreadId: "L", status: "LIVE", agentNickname: "Kierkegaard", lastGrow: T0 + 1 }
  ], [{ id: "job-77", threadId: "TJ", live: "failed", title: "Queued review", kindLabel: "Adversarial review", updatedAt: iso(3) }]);
  assert.deepEqual(plain(rows.map((r) => r.id)), ["rollout-a", "lead", "job:job-77"]);
  const [first, lead, job] = rows;
  assert.equal(rowMatch(first, ""), "");
  assert.equal(rowMatch(first, "  "), "");
  assert.equal(rowMatch(first, "RETRY"), "", "case-insensitive title hit");
  assert.equal(rowMatch(first, "alpha"), "project");
  assert.equal(rowMatch(first, "019A"), "thread id");
  assert.equal(rowMatch(first, "gpt-5"), "model");
  assert.equal(rowMatch(first, "rollout-a"), "id");
  assert.equal(rowMatch(first, "nothing like it"), null);
  assert.equal(rowMatch(job, "adversarial"), "kind");
  assert.equal(rowMatch(job, "job-77"), "id");
  assert.equal(rowMatch(lead, "kierkegaard"), "agent team", "a lead stays visible when a child agent matches");
});

test("row badge, meta line and tooltip", () => {
  const { buildRows, rowBadge, rowMetaLine, rowTooltip } = ctx();
  const want = { RUNNING: "LIVE", WAITING: "IDLE", ATTENTION: "STALE", ANSWER: "NEEDS_ANSWER", STOPPED: "STOPPED", FINISHED: "DONE", ARCHIVED: "ARCHIVED" };
  for (const [status, cls] of Object.entries(want)) assert.equal(rowBadge(status), cls, status);
  assert.equal(rowBadge("nonsense"), "IDLE");

  const [merged] = buildRows(
    [{ id: "s", threadId: "t-9", status: "IDLE", cwd: "D:\\GIT\\proj", model: "gpt-5", tokensUsed: 500, sandbox: "workspace-write", quietMs: 60000, lastKind: "cmd", lastText: "npm test", lastGrow: T0 }],
    [
      { id: "j2", threadId: "t-9", live: "dead", effort: "high", diedReason: "process gone, resumable", updatedAt: iso(20) },
      { id: "j1", threadId: "t-9", live: "completed", updatedAt: iso(10) }
    ]
  );
  assert.equal(rowMetaLine(merged), "proj · gpt-5 · high · tokens: 500");
  const tip = rowTooltip(merged, T0 + 60000);
  for (const part of ["D:\\GIT\\proj", "thread: t-9", "sandbox: workspace-write", "process gone, resumable", "1 earlier run on this thread"]) {
    assert.ok(tip.includes(part), part + " in " + JSON.stringify(tip));
  }
  // The dead job decides the status (Needs attention), so the session's "Waiting ..." reason stays out.
  assert.doesNotMatch(tip, /Waiting/);
  const { rowReason } = ctx();
  assert.equal(rowReason(merged), "");
  const [idleOnly] = buildRows([{ id: "i", threadId: "ti", status: "IDLE", quietMs: 60000, lastKind: "cmd", lastText: "npm test" }], []);
  assert.match(rowReason(idleOnly), /^Waiting 1m 0s .*npm test/);
  assert.match(rowTooltip(idleOnly, T0), /Waiting 1m 0s/);
  const [idleWithDoneJob] = buildRows([{ id: "i", threadId: "ti", status: "DONE" }], [{ id: "j", threadId: "ti", live: "completed" }]);
  assert.equal(rowReason(idleWithDoneJob), "", "no reason for a finished row");
  const [jobOnly] = buildRows([], [{ id: "q", live: "working", workspaceRoot: "/srv/api", model: "sol", effort: "xhigh", phase: "queued", updatedAt: iso(0) }]);
  assert.equal(rowMetaLine(jobOnly), "api · sol · xhigh");
  assert.match(rowTooltip(jobOnly, T0), /queued/);
  assert.doesNotMatch(rowTooltip(jobOnly, T0), /thread:|earlier run/);
});
