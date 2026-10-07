const assert = require("node:assert/strict");
const { uiSource } = require("./helpers/source");
const test = require("node:test");
const vm = require("node:vm");

const html = uiSource();
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

test("workflow agents own their questions after finishing; plain handoffs still need an answer", () => {
  const c = ctx();
  const parentId = "wfagent:chat/run/agent";
  c.claudeChats = { chats: [{ id: "chat:chat", sessionId: "chat", state: "done", children: [
    { kind: "workflow", id: "workflow:chat/run", runId: "run", parentId: "chat:chat" },
    { kind: "handoff", id: "handoff:t", parentId, threadId: "t", jobIds: ["j"] }
  ] }] };
  const agent = { id: "agent", state: "running" };
  c.claudeRuns = [{ sessionId: "chat", id: "run", agents: [agent] }];
  for (const engine of ["codex", "opencode"]) {
    const job = { id: "j", threadId: "t", engine, status: "completed", needsDecision: "Which option?", updatedAt: iso(0) };
    const session = { id: "s", threadId: "t", status: "DONE", lastGrow: T0 };
    const row = () => c.buildRows([session], [job])[0];
    agent.state = "running";
    assert.equal(row().status, "ANSWER", "a running workflow agent keeps today's behavior");
    for (const state of ["done", "failed", "ended"]) {
      agent.state = state;
      assert.equal(row().status, "FINISHED", engine + " / " + state);
      assert.equal(row().needsAnswer, false);
      assert.equal(c.answerTarget(row(), [job]), null);
      assert.equal(c.jobStatusLabel(job), "Finished");
      assert.equal(c.viewCounts([row()], []).NOW.ANSWER, 0);
      const model = c.buildNodes(c.claudeChats, c.claudeRuns, [row()], [job], T0);
      const node = model.nodes["handoff:t"];
      assert.equal(node.state, "FINISHED");
      assert.equal(model.nodes["chat:chat"].states.ANSWER, undefined, "the tree roll-up excludes the question");
      assert.equal(c.nodeSelfMatch(node, "ANSWER", {}), false, "Needs you chip excludes it");
      assert.equal(c.nodeSelfMatch(node, "RUNNING", {}), false, "Running chip excludes it");
    }
    assert.equal(c.rowStatus({ ...session, status: "LIVE" }, job), "RUNNING", "resumed threads still run");
    const plainJob = { ...job, id: "plain", threadId: "plain-thread" };
    assert.equal(c.rowStatus(null, plainJob), "ANSWER", "normal chat questions remain open");
    assert.ok(c.answerTarget({ job: plainJob }, [plainJob]));
    const delivered = { ...plainJob, announcedAt: iso(1000) };
    assert.equal(c.rowStatus(null, delivered), "FINISHED", "delivered questions belong to Claude even without a tracked session");
    assert.equal(c.jobStatusLabel(delivered), "Finished");
    assert.equal(c.questionOpen(delivered), false);
    assert.equal(c.answerTarget({ job: delivered }, [delivered]), null);
    assert.equal(c.resultCardModel("## Needs decision\nWhich option?", []).question, "Which option?", "finished question text stays readable");
    c.claudeRuns = [];
    assert.equal(row().status, "ANSWER", "missing workflow state cannot silently claim the question");
    c.claudeRuns = [{ sessionId: "chat", id: "run", agents: [agent] }];
  }
});

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
    // A live session beats a dead, failed or stuck job: someone resumed the thread in a terminal,
    // and a Resume here would start a second Codex on it.
    [{ status: "LIVE" }, { live: "dead" }, "RUNNING"],
    [{ status: "LIVE" }, { live: "failed" }, "RUNNING"],
    [{ status: "LIVE" }, { live: "possibly-stuck" }, "RUNNING"],
    [{ status: "LIVE", archived: true }, { live: "dead" }, "ATTENTION"],
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
    // Session growth cannot prove delivery: announcedAt owns the question state.
    [{ status: "IDLE", lastGrow: T0 + 5000 }, { live: "completed", needsDecision: "Q?", updatedAt: iso(0) }, "ANSWER"],
    [{ status: "IDLE", lastGrow: T0 + 5001 }, { live: "completed", needsDecision: "Q?", updatedAt: iso(0) }, "ANSWER"],
    [{ status: "LIVE", lastGrow: T0 + 9000 }, { live: "completed", needsDecision: "Q?", updatedAt: iso(0) }, "RUNNING"],
    [{ status: "IDLE", lastGrow: T0 + 9000 }, { live: "completed", needsDecision: "Q?" }, "ANSWER", "no updatedAt: nothing to compare"],
    [idle, { live: "cancelled" }, "STOPPED"],
    [{ status: "DONE", archived: true }, { live: "completed" }, "ARCHIVED"],
    [{ status: "LIVE" }, null, "RUNNING"],
    [{ status: "IDLE" }, null, "WAITING"],
    [{ status: "STALE" }, null, "ATTENTION"],
    [{ status: "STOPPED" }, null, "STOPPED"],
    [{ status: "DONE" }, null, "FINISHED"],
    [{ status: "LIVE", archived: true }, null, "ARCHIVED"],
    [null, { live: "completed", needsDecision: "Which one?" }, "ANSWER"],
    [null, { live: "completed", needsDecision: "Which one?", announcedAt: iso(1) }, "FINISHED"],
    [null, { status: "completed", needsDecision: "Which one?", announcedAt: iso(1) }, "FINISHED"]
  ];
  for (const [session, job, want, note] of cases) {
    assert.equal(rowStatus(session, job), want, note || JSON.stringify([session, job]));
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
    HISTORY: { FINISHED: 1, STOPPED: 0, ARCHIVED: 1, DISMISSED: 1, EVERYTHING: 4 },
    // Codex rows never show in the Claude tab (it lists Claude workflows only).
    CLAUDE: { ALL: 0, RUNNING: 0, ATTENTION: 0, FINISHED: 0 }
  });
  // A tab's count is what clicking the tab shows: its first chip (History opens on Finished).
  const { tabCounts } = ctx();
  assert.deepEqual(plain(tabCounts(counts)), { NOW: 1, HANDOFFS: 1, HISTORY: 1, CLAUDE: 0 });
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
  // The job dialog opens for any job: "Show full result" once it ended, "Show job details" before.
  const working = menuItems(row(null, [{ id: "j", threadId: "t", live: "working" }]), win);
  assert.deepEqual(ids(working), ["show-result", "cancel-job", "dismiss", "copy-resume", "copy-continue", "copy-fork"]);
  assert.equal(working[0].label, "Show job details");
  assert.equal(working[1].group, "Job");
  assert.equal(working[1].danger, true);
  const dead = menuItems(row(null, [{ id: "j", threadId: "t", live: "dead" }]), win);
  assert.deepEqual(ids(dead), ["resume-job", "show-result", "dismiss", "copy-resume", "copy-continue", "copy-fork"]);
  assert.equal(dead[1].label, "Show job details");
  const stuck = menuItems(row({ id: "s", threadId: "t", status: "STALE" }, [{ id: "j", threadId: "t", live: "possibly-stuck" }]), win);
  assert.equal(stuck.find((i) => i.id === "show-result").label, "Show job details");
  const failed = menuItems(row(null, [{ id: "j", live: "failed" }]), win);
  assert.deepEqual(ids(failed), ["show-result", "dismiss"], "no thread: nothing to resume or copy");
  assert.equal(failed[0].label, "Show full result");
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
    [{ id: "s", threadId: "t-9", status: "IDLE", cwd: "D:\\GIT\\proj", model: "gpt-5", tokensUsed: 500, sandbox: "workspace-write", lastKind: "cmd", lastText: "npm test", lastGrow: T0 }],
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
  const [idleOnly] = buildRows([{ id: "i", threadId: "ti", status: "IDLE", lastGrow: T0, lastKind: "cmd", lastText: "npm test" }], []);
  assert.match(rowReason(idleOnly, T0 + 60000), /^Waiting 1m 0s .*npm test/);
  assert.match(rowTooltip(idleOnly, T0 + 60000), /Waiting 1m 0s/);
  const [idleWithDoneJob] = buildRows([{ id: "i", threadId: "ti", status: "DONE" }], [{ id: "j", threadId: "ti", live: "completed" }]);
  assert.equal(rowReason(idleWithDoneJob), "", "no reason for a finished row");
  const [jobOnly] = buildRows([], [{ id: "q", live: "working", workspaceRoot: "/srv/api", model: "sol", effort: "xhigh", phase: "queued", updatedAt: iso(0) }]);
  assert.equal(rowMetaLine(jobOnly), "api · sol · xhigh");
  assert.match(rowTooltip(jobOnly, T0), /queued/);
  assert.doesNotMatch(rowTooltip(jobOnly, T0), /thread:|earlier run/);
});

test("header Resume: shown for a dead or failed job and a STALE session without a job, hidden otherwise", () => {
  const { buildRows, resumeTarget } = ctx();
  const one = (session, jobs) => buildRows(session ? [session] : [], jobs || [])[0];
  // Fixture 8 shape: the session went STALE because its handoff process died.
  const dead = one({ id: "s", threadId: "t", status: "STALE", cwd: "D:\\s" }, [{ id: "j", threadId: "t", live: "dead", workspaceRoot: "D:\\w" }]);
  assert.deepEqual(plain(resumeTarget(dead)), { threadId: "t", cwd: "D:\\w" });
  assert.deepEqual(plain(resumeTarget(one(null, [{ id: "j", threadId: "t", status: "failed", cwd: "D:\\c" }]))), { threadId: "t", cwd: "D:\\c" }, "job status counts when live is missing");
  assert.deepEqual(plain(resumeTarget(one({ id: "s", threadId: "t", status: "STALE", cwd: "D:\\s" }))), { threadId: "t", cwd: "D:\\s" });
  const hidden = {
    "possibly-stuck job (may still run)": one({ id: "s", threadId: "t", status: "STALE" }, [{ id: "j", threadId: "t", live: "possibly-stuck" }]),
    "working job": one({ id: "s", threadId: "t", status: "LIVE" }, [{ id: "j", threadId: "t", live: "working" }]),
    "finished job on a stale-looking session": one({ id: "s", threadId: "t", status: "IDLE" }, [{ id: "j", threadId: "t", live: "completed" }]),
    "dead job without thread": one(null, [{ id: "j", live: "dead" }]),
    "archived STALE session": one({ id: "s", threadId: "t", status: "STALE", archived: true }),
    "STALE session without thread": one({ id: "s", status: "STALE" }),
    "waiting session": one({ id: "s", threadId: "t", status: "IDLE" }),
    "running session": one({ id: "s", threadId: "t", status: "LIVE" }),
    // Resumed from a copied command in a terminal: Resume here would start a second Codex on the thread.
    "dead job on a LIVE session": one({ id: "s", threadId: "t", status: "LIVE" }, [{ id: "j", threadId: "t", live: "dead" }]),
    "failed job on a LIVE session": one({ id: "s", threadId: "t", status: "LIVE" }, [{ id: "j", threadId: "t", live: "failed" }])
  };
  for (const [name, row] of Object.entries(hidden)) assert.equal(resumeTarget(row), null, name);
});

test("header reason line: wait reason, died reason, stuck detail, nothing when healthy", () => {
  const { buildRows, headerReason } = ctx();
  const one = (session, jobs) => buildRows(session ? [session] : [], jobs || [])[0];
  const now = T0 + 5 * 60000;
  assert.match(headerReason(one({ id: "s", status: "IDLE", lastGrow: now - 60000, lastKind: "cmd", lastText: "npm test" }), now), /^Waiting 1m 0s .*npm test/);
  assert.equal(headerReason(one({ id: "s", threadId: "t", status: "IDLE" }, [{ id: "j", threadId: "t", live: "dead", diedReason: "process-vanished" }]), now),
    "Handoff process died: process-vanished");
  assert.equal(headerReason(one(null, [{ id: "j", live: "failed" }]), now), "Handoff failed");
  // A STALE session keeps today's wait reason in front of the job detail.
  assert.equal(headerReason(one({ id: "s", threadId: "t", status: "STALE", lastGrow: now - 300000, lastKind: "cmd", lastText: "npm test" }, [{ id: "j", threadId: "t", live: "possibly-stuck", heartbeatAt: iso(0) }]), now),
    "Waiting 5m 0s — last activity: running command \"npm test\" · Handoff may be stuck: no heartbeat for 5m 0s");
  assert.equal(headerReason(one({ id: "s", threadId: "t", status: "LIVE" }, [{ id: "j", threadId: "t", live: "working" }]), now), "");
  assert.equal(headerReason(one({ id: "s", status: "DONE" }), now), "");
});

test("rowById finds child agents too; threadRuns lists a thread's runs newest first", () => {
  const { buildRows, rowById, threadRuns } = ctx();
  const rows = buildRows([
    { id: "lead", threadId: "tl", status: "LIVE", lastGrow: T0 },
    { id: "kid", threadId: "tk", parentThreadId: "tl", status: "IDLE", lastGrow: T0 }
  ], []);
  assert.equal(rowById(rows, "lead").id, "lead");
  assert.equal(rowById(rows, "kid").id, "kid");
  assert.equal(rowById(rows, "nope"), null);
  // A grandchild agent the list does not draw gets a one-session build. A newer working job on
  // another thread sorts first there, so the header must pick the session's row by id, not [0].
  const grandchild = { id: "gc", threadId: "tg", parentThreadId: "tk", status: "LIVE", lastGrow: T0 };
  const solo = buildRows([grandchild], [{ id: "other", threadId: "t-other", live: "working", updatedAt: iso(60000) }]);
  assert.equal(solo[0].id, "job:other", "the trap: [0] is the other thread's job row");
  const own = rowById(solo, "gc");
  assert.equal(own.id, "gc");
  assert.equal(own.job, null);
  const jobs = [
    { id: "a", threadId: "t6", createdAt: iso(100) },
    { id: "c", threadId: "t6", updatedAt: iso(300) },
    { id: "x", threadId: "other", updatedAt: iso(900) },
    { id: "b", threadId: "t6", updatedAt: iso(200) }
  ];
  assert.deepEqual(ids(threadRuns(jobs, jobs[0])), ["c", "b", "a"]);
  assert.deepEqual(ids(threadRuns(jobs, { id: "loose" })), ["loose"], "no thread: just the job itself");
});

test("dismissed ids: sessions and job-only rows stay while they exist; job ids wait for the first job list", () => {
  const { keptDismissed } = ctx();
  const sessions = [{ id: "s1" }];
  const jobs = [{ id: "j1" }];
  assert.deepEqual(plain(keptDismissed(["s1", "gone", "job:j1", "job:old"], sessions, jobs, true)), ["s1", "job:j1"]);
  assert.deepEqual(plain(keptDismissed(["s1", "gone", "job:j1", "job:old"], sessions, [], false)), ["s1", "job:j1", "job:old"], "jobs not loaded yet: keep every job id");
  const open = ["opencode:ses_a", "opencode:ses_old"];
  assert.deepEqual(plain(keptDismissed(open, sessions, jobs, true, [{ id: "opencode:ses_a" }])), ["opencode:ses_a"], "a listed OpenCode session stays dismissed");
  assert.deepEqual(plain(keptDismissed(open, sessions, jobs, true, null)), open, "no OpenCode frame yet: keep every OpenCode id");
});

// The unified tree (design 13.2.1): one chat with a subagent, a workflow agent and handoffs; a ghost; your
// own Codex run; a Codex agent two levels down. Shapes as the claudeChats/claudeRuns frames send them.
test("buildNodes joins chats, runs, handoffs and Codex agents into one tree, every node with a visible parent", () => {
  const { buildRows, buildNodes } = ctx();
  const now = Date.now();
  const sid = "0b1c2d3e-0000-4000-8000-000000000001";
  const ghostId = "7f3a9c2e-0000-4000-8000-000000000009";
  const iso = new Date(now).toISOString();
  const sessions = [
    { id: "s-h1", threadId: "T1", originator: "Claude Code", status: "LIVE", lastGrow: now, tokensUsed: 1000 },
    { id: "s-h2", threadId: "T2", originator: "Claude Code", status: "DONE", lastGrow: now, tokensUsed: 500 },
    { id: "s-ca", threadId: "T3", parentThreadId: "T1", status: "LIVE", lastGrow: now, tokensUsed: 200 },
    { id: "s-ca2", threadId: "T4", parentThreadId: "T3", status: "DONE", lastGrow: now, tokensUsed: 50 },
    { id: "s-you", threadId: "T5", originator: "codex_cli_rs", status: "DONE", lastGrow: now, tokensUsed: 70 },
    { id: "s-gh", threadId: "T6", originator: "Claude Code", status: "DONE", lastGrow: now },
  ];
  const jobs = [
    { id: "task-a", threadId: "T1", sessionId: sid, status: "running", createdAt: iso, updatedAt: iso },
    { id: "task-b", threadId: "T2", sessionId: sid, status: "completed", createdAt: iso, updatedAt: iso },
    { id: "task-c", threadId: "T6", sessionId: ghostId, status: "completed", updatedAt: iso },
  ];
  const frame = {
    chats: [{
      id: "chat:" + sid, sessionId: sid, title: "Fix the release flow", project: "repo", cwd: "D:/x/repo", state: "running", updatedMs: now,
      usage: { context: 1, total: 4000, output: 10, partial: false }, claudeTree: { total: 9000, output: 0, partial: false }, childrenHidden: 3,
      children: [
        { kind: "agent", id: "agent:a1", parentId: "chat:" + sid, label: "Review the hook", agentType: "general-purpose", background: true, state: "running", usage: { total: 300 }, startedMs: 1 },
        { kind: "workflow", id: "workflow:" + sid + "/wf_x", runId: "wf_x", parentId: "chat:" + sid, label: "scope", state: "running", usage: { total: 600 }, startedMs: 2 },
        { kind: "handoff", id: "handoff:T1", parentId: "agent:a1", threadId: "T1", jobIds: ["task-a"], exact: true, startedMs: 3 },
        { kind: "handoff", id: "handoff:T2", parentId: "wfagent:" + sid + "/wf_x/a2", threadId: "T2", jobIds: ["task-b", "task-z"], exact: false, startedMs: 4 },
      ],
    }],
    ghosts: [{ id: "ghost:" + ghostId, sessionId: ghostId, updatedMs: now, children: [{ kind: "handoff", id: "handoff:T6", threadId: "T6", jobIds: ["task-c"] }] }],
  };
  const runs = [{ id: "wf_x", sessionId: sid, status: "RUNNING", agents: [{ id: "a2", label: "scout", phase: "Scout", state: "done", usage: { total: 600 } }] }];
  const { nodes, roots } = buildNodes(frame, runs, buildRows(sessions, jobs), jobs, now);
  const parent = (id) => nodes[id].parentId;
  assert.equal(parent("agent:a1"), "chat:" + sid);
  assert.equal(parent("handoff:T1"), "agent:a1", "a subagent's handoff hangs under the subagent");
  assert.equal(parent("handoff:T2"), "wfagent:" + sid + "/wf_x/a2", "a workflow agent's handoff hangs under that agent");
  assert.equal(parent("codexagent:s-ca"), "handoff:T1");
  assert.equal(parent("codexagent:s-ca2"), "codexagent:s-ca", "a Codex grandchild nests, never a root of its own");
  assert.equal(parent("handoff:T6"), "ghost:" + ghostId);
  assert.deepEqual(plain(roots).sort(), ["chat:" + sid, "codex:s-you", "ghost:" + ghostId].sort());
  assert.deepEqual(plain(nodes["handoff:T2"].flags), ["agent not known", "2 runs"]);
  assert.deepEqual(plain(nodes["agent:a1"].flags), ["background"]);
  // Roll-up: the chat runs. Usage: the server's Claude total for the chat, plus the Codex part of the tree.
  assert.equal(nodes["chat:" + sid].rollup, "RUNNING");
  assert.equal(nodes["chat:" + sid].tree.claude, 9000);
  assert.equal(nodes["chat:" + sid].tree.codex, 1000 + 500 + 200 + 50);
  assert.equal(nodes["chat:" + sid].tree.partial, true, "3 children were not sent: a lower bound");
  // No loose node: every node reaches a root through parents that exist.
  Object.keys(nodes).forEach((id) => {
    let n = nodes[id];
    for (let guard = 0; n.parentId && guard < 10; guard++) { assert.ok(nodes[n.parentId], id + " has a missing parent " + n.parentId); n = nodes[n.parentId]; }
    assert.ok(roots.includes(n.id), id + " ends at a root");
  });
});

test("a handoff of a tracked chat that the frame did not send stays out of the roots, but History and search find it", () => {
  const { buildRows, buildNodes, viewRoots } = ctx();
  const now = Date.now();
  const sid = "0b1c2d3e-0000-4000-8000-000000000001";
  const sessions = [{ id: "s-old", threadId: "T9", originator: "Claude Code", status: "DONE", lastGrow: now }];
  const jobs = [{ id: "task-old", threadId: "T9", sessionId: sid, status: "completed", updatedAt: new Date(now).toISOString() }];
  const frame = { chats: [{ id: "chat:" + sid, sessionId: sid, title: "t", state: "done", updatedMs: now, children: [], childrenHidden: 1 }], ghosts: [] };
  const model = buildNodes(frame, [], buildRows(sessions, jobs), jobs, now);
  assert.deepEqual(plain(model.roots), ["chat:" + sid]);
  const history = (chip, query) => plain(viewRoots(model, { tab: "HISTORY", chip }, now, [], query || ""));
  assert.deepEqual(history("EVERYTHING"), ["handoff:T9"]);
  assert.deepEqual(history("FINISHED", "task-old"), ["handoff:T9"], "History search finds it by its job id");
  assert.deepEqual(history("FINISHED", "no such thing"), []);
  assert.deepEqual(history("DISMISSED"), []);
  assert.deepEqual(plain(viewRoots(model, { tab: "HISTORY", chip: "DISMISSED" }, now, ["s-old"], "")), ["handoff:T9"]);
});

test("worstState, the Live window and saved views from before the redesign", () => {
  const { worstState, liveRoot, liveHidden, nodeSavedView, nodeIdFor, childOrder, nodeSelfMatch } = ctx();
  // The Running chip (the default) also shows a question for you; nothing finished.
  assert.equal(nodeSelfMatch({ kind: "handoff", state: "ANSWER" }, "RUNNING", {}), true);
  assert.equal(nodeSelfMatch({ kind: "chat", state: "RUNNING" }, "RUNNING", {}), true);
  assert.equal(nodeSelfMatch({ kind: "chat", state: "FINISHED" }, "RUNNING", {}), false);
  assert.equal(nodeSelfMatch({ kind: "handoff", state: "ATTENTION" }, "RUNNING", {}), false);
  // Children: active first (newest started on top), then finished (newest finished on top).
  const kids = [
    { id: "old-done", rollup: "FINISHED", startedMs: 1, updatedMs: 10 },
    { id: "run-old", rollup: "RUNNING", startedMs: 2, updatedMs: 99 },
    { id: "new-done", rollup: "FINISHED", startedMs: 3, updatedMs: 20 },
    { id: "run-new", rollup: "RUNNING", startedMs: 4, updatedMs: 5 },
    { id: "asks", rollup: "ANSWER", startedMs: 3, updatedMs: 1 },
  ];
  assert.deepEqual(kids.sort(childOrder).map((k) => k.id), ["run-new", "asks", "run-old", "new-done", "old-done"]);
  assert.equal(worstState("FINISHED", "RUNNING"), "RUNNING");
  assert.equal(worstState("ANSWER", "ATTENTION"), "ANSWER");
  assert.equal(worstState("", "ENDED"), "ENDED");
  const now = Date.now();
  assert.equal(liveRoot({ state: "FINISHED", rollup: "FINISHED", updatedMs: now - 3600e3 }, now, []), true);
  assert.equal(liveRoot({ state: "FINISHED", rollup: "FINISHED", updatedMs: now - 30 * 3600e3 }, now, []), false, "old and done: History");
  assert.equal(liveRoot({ state: "ANSWER", rollup: "ANSWER", updatedMs: now - 90 * 3600e3 }, now, []), true, "an old question still shows");
  assert.equal(liveRoot({ state: "RUNNING", rollup: "RUNNING", updatedMs: now, row: { id: "s1" } }, now, ["s1"]), false, "dismissed");
  assert.equal(liveHidden({ state: "FINISHED", row: { id: "s2" } }, ["s2"]), true, "a dismissed child leaves Live too");
  assert.equal(liveHidden({ state: "ARCHIVED", row: { id: "s3" } }, []), true, "so does an archived one");
  assert.equal(liveHidden({ state: "ARCHIVED" }, []), false, "a Claude node has no Codex row to dismiss");
  // Design 4.3: Now -> Live; Handoffs -> Live + Codex; Claude -> Live + Claude; History unchanged.
  const v = (p) => { const r = plain(nodeSavedView(p)); assert.equal(r.viewV, 2); delete r.viewV; return r; };
  assert.deepEqual(v({ tab: "NOW", chip: "ANSWER" }), { tab: "LIVE", chip: "ANSWER", kinds: { claude: false, codex: false } });
  assert.deepEqual(v({ tab: "HANDOFFS", chip: "FINISHED" }), { tab: "LIVE", chip: "FINISHED", kinds: { claude: false, codex: true } });
  assert.deepEqual(v({ tab: "CLAUDE", chip: "RUNNING" }), { tab: "LIVE", chip: "RUNNING", kinds: { claude: true, codex: false } });
  assert.deepEqual(v({ tab: "HISTORY", chip: "ARCHIVED" }), { tab: "HISTORY", chip: "ARCHIVED", kinds: { claude: false, codex: false } });
  assert.deepEqual(v({ tab: "LIVE", chip: "STOPPED", kinds: { codex: true } }), { tab: "LIVE", chip: "STOPPED", kinds: { claude: false, codex: true } });
  assert.deepEqual(v({ filter: "STALE" }), { tab: "LIVE", chip: "ATTENTION", kinds: { claude: false, codex: false } });
  // Running is the default: a first start, and a saved Live "All" from before, open on Running once.
  assert.deepEqual(v({}), { tab: "LIVE", chip: "RUNNING", kinds: { claude: false, codex: false } });
  assert.deepEqual(v({ tab: "LIVE", chip: "ALL" }), { tab: "LIVE", chip: "RUNNING", kinds: { claude: false, codex: false } });
  assert.deepEqual(v({ tab: "LIVE", chip: "ALL", viewV: 2 }), { tab: "LIVE", chip: "ALL", kinds: { claude: false, codex: false } }, "All picked after the switch stays");
  // A saved Codex row id or Claude run maps to its node; a missing one gives null (the overview shows).
  const model = { nodes: { "handoff:T1": { row: { id: "s-h1" } }, "workflow:s/wf_x": { kind: "workflow", runId: "wf_x" },
    "wfagent:s/wf_x/a2": { kind: "wfagent", run: { id: "wf_x" }, agent: { id: "a2" } } }, roots: [] };
  assert.equal(nodeIdFor(model, { selected: "s-h1" }), "handoff:T1");
  assert.equal(nodeIdFor(model, { claudeRun: "wf_x" }), "workflow:s/wf_x");
  assert.equal(nodeIdFor(model, { claudeRun: "wf_x", claudeAgent: "a2" }), "wfagent:s/wf_x/a2", "the v2.18 open agent opens again");
  assert.equal(nodeIdFor(model, { selected: "gone" }), null);
});
