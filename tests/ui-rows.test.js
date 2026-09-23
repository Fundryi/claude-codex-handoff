const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// The whole pure-helper block, as tests/stuck-session.test.js extracts it.
const block = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];
// Today's filter rule, to prove the new views keep it for session-only data.
const legacy = script.match(/function filterIncludes[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(block + "\n" + legacy, c); return c; }
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
    [{ status: "LIVE" }, { live: "completed" }, "FINISHED"],
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
  const gone = rows[1];
  assert.equal(rowInView(gone, "NOW", "RUNNING", ["gone"]), false);
  assert.equal(rowInView(gone, "HISTORY", "DISMISSED", ["gone"]), true);
  assert.equal(rowInView(gone, "HISTORY", "EVERYTHING", ["gone"]), true);
  assert.equal(rowInView(rows[3], "HANDOFFS", "ALL", []), false, "archived rows stay out of Now and Handoffs");
  assert.equal(rowInView(rows[0], "NOW", "FINISHED", []), false, "chip must belong to the tab");
  assert.equal(rowInView(rows[0], "BOGUS", "ALL", []), false);
});

test("session-only rows land where today's filters put them", () => {
  const { buildRows, rowInView, filterIncludes, dismissedHides } = ctx();
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
