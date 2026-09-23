const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const pureHelpers = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];
const navigationFunctions = script.match(
  /function chooseView[\s\S]*?(?=\n    function renderList)/,
)[0];

// sessions/jobs are live arrays: tests mutate them to simulate SSE updates.
function navigation(overrides = {}) {
  const context = {
    prefs: { tab: "NOW", chip: "ALL", autoFollow: true, dismissed: [] },
    selected: "selected",
    sessions: [{ id: "selected", threadId: "t-sel", status: "LIVE" }],
    jobs: [],
    savePrefs() {},
    applyPrefs() {},
    renderFilters() {},
    renderList() {},
    renderHeader() {},
    renderFeed() {},
    refreshJobs() { context.refreshed = (context.refreshed || 0) + 1; },
    selectSession(id) { context.selected = id; },
    ...overrides,
  };
  context.currentRows = () => context.buildRows(context.sessions, context.jobs);
  vm.runInNewContext(pureHelpers + "\n" + navigationFunctions, context);
  return context;
}
const view = (context) => [context.prefs.tab, context.prefs.chip];

test("picking a tab or chip pauses automatic following and closes the Now overview", () => {
  const context = navigation();
  context.prefs.home = true;

  context.chooseView("HISTORY", "FINISHED");
  assert.deepEqual(view(context), ["HISTORY", "FINISHED"]);
  assert.equal(context.prefs.autoFollow, false);
  assert.equal(context.prefs.home, false);
  assert.equal(context.refreshed, undefined);

  context.chooseView("HANDOFFS", "ALL");
  assert.equal(context.refreshed, 1, "Handoffs pulls fresh job state");
});

test("the chip only follows an actual selected-task status change, so the row stays visible", () => {
  const context = navigation();
  context.prefs.tab = "HISTORY";
  context.prefs.chip = "FINISHED";

  // No status change: an explicit choice is never overridden.
  context.followSelectedStatus("RUNNING");
  assert.deepEqual(view(context), ["HISTORY", "FINISHED"]);

  // Running -> Waiting while Now/Running is open: same tab, new chip.
  context.prefs.tab = "NOW";
  context.prefs.chip = "RUNNING";
  context.sessions[0].status = "IDLE";
  context.followSelectedStatus("RUNNING");
  assert.deepEqual(view(context), ["NOW", "WAITING"]);

  // Waiting -> Finished: Now has no Finished chip, so History/Finished (old DONE filter).
  context.sessions[0].status = "DONE";
  context.followSelectedStatus("WAITING");
  assert.deepEqual(view(context), ["HISTORY", "FINISHED"]);

  // A handoff that finishes while Handoffs/Running is open stays in Handoffs.
  context.prefs.tab = "HANDOFFS";
  context.prefs.chip = "RUNNING";
  context.jobs.push({ id: "j", threadId: "t-sel", live: "completed" });
  context.followSelectedStatus("RUNNING");
  assert.deepEqual(view(context), ["HANDOFFS", "FINISHED"]);

  // Still visible after the change: no move.
  context.prefs.tab = "NOW";
  context.prefs.chip = "ALL";
  context.jobs[0].live = "dead";
  context.followSelectedStatus("FINISHED");
  assert.deepEqual(view(context), ["NOW", "ALL"]);
});

test("Everything stays Everything and Handoffs/All stays put when the selected task changes", () => {
  const context = navigation();
  context.prefs.tab = "HISTORY";
  context.prefs.chip = "EVERYTHING";
  context.sessions[0].status = "DONE";
  context.followSelectedStatus("RUNNING");
  assert.deepEqual(view(context), ["HISTORY", "EVERYTHING"]);

  // A session without a handoff never shows in Handoffs; like the old Jobs filter, it stays.
  context.prefs.tab = "HANDOFFS";
  context.prefs.chip = "ALL";
  context.sessions[0].status = "IDLE";
  context.followSelectedStatus("FINISHED");
  assert.deepEqual(view(context), ["HANDOFFS", "ALL"]);
});

test("a selected child agent follows the view of its lead row", () => {
  const context = navigation({
    selected: "kid",
    sessions: [
      { id: "lead", threadId: "L", status: "DONE", lastGrow: 2 },
      { id: "kid", threadId: "K", parentThreadId: "L", status: "LIVE", lastGrow: 1 },
    ],
  });
  context.prefs.chip = "RUNNING";
  context.followSelectedStatus("RUNNING");
  assert.deepEqual(view(context), ["HISTORY", "FINISHED"], "the lead row is what the list draws");
});

test("Follow newest keeps a thread resumed after its handoff finished in the running view", () => {
  // codex resume <thread> after the handoff completed: live session, newest job completed.
  const resumed = { id: "resumed", threadId: "t-res", status: "LIVE" };
  const context = navigation({ jobs: [{ id: "j", threadId: "t-res", live: "completed" }] });
  context.sessions.push(resumed);
  context.followRunningSession(resumed);
  assert.deepEqual(view(context), ["NOW", "ALL"], "visible in Now/All: no jump to History/Finished");
  assert.equal(context.selected, "resumed");

  context.prefs.tab = "HISTORY";
  context.prefs.chip = "FINISHED";
  context.selected = "selected";
  context.followRunningSession(resumed);
  assert.deepEqual(view(context), ["NOW", "RUNNING"]);
});

test("Follow newest deliberately returns to the running view", () => {
  const running = { id: "running", threadId: "t-run", status: "LIVE" };
  const context = navigation();
  context.sessions.push(running);
  context.prefs.tab = "HISTORY";
  context.prefs.chip = "FINISHED";
  context.prefs.autoFollow = false;

  context.followRunningSession(running);
  assert.deepEqual(view(context), ["HISTORY", "FINISHED"]);
  assert.equal(context.selected, "selected");

  context.prefs.autoFollow = true;
  context.followRunningSession(running);
  assert.deepEqual(view(context), ["NOW", "RUNNING"]);
  assert.equal(context.selected, "running");

  // Already visible in the current view: the view stays.
  context.prefs.tab = "NOW";
  context.prefs.chip = "ALL";
  context.selected = "selected";
  context.followRunningSession(running);
  assert.deepEqual(view(context), ["NOW", "ALL"]);
  assert.equal(context.selected, "running");
});
