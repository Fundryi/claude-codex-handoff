const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Slice from jobDetailLine through homeCards so the detail-line dependency rides along.
const slice = script.match(/function jobDetailLine[\s\S]*?function homeCards[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }
// Arrays produced inside the vm sandbox are a different Array realm; JSON round-trip
// before deepEqual so comparisons don't fail on constructor identity (see ui-actions.test.js).
function plain(value) { return JSON.parse(JSON.stringify(value)); }

const NOW = 1_700_000_000_000;

test("active jobs and sessions become cards, newest first", () => {
  const { homeCards } = ctx();
  const jobs = [
    { id: "j1", threadId: "t1", live: "working", status: "running", fast: true, title: "Job one", workspaceRoot: "D:\\repo", heartbeatAt: new Date(NOW - 1000).toISOString() },
    { id: "j2", threadId: "t2", live: "completed", status: "completed", title: "Done job", workspaceRoot: "D:\\repo", updatedAt: new Date(NOW - 5000).toISOString() }
  ];
  const sessions = [
    { id: "s1", threadId: "t9", status: "LIVE", title: "Session", cwd: "D:\\other", lastGrow: NOW - 2000, tokensUsed: 42 }
  ];
  const { active, finished } = homeCards(sessions, jobs, NOW);
  assert.deepEqual(plain(active.map(c => c.id)), ["j1", "s1"]);
  assert.equal(active[0].fast, true);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].id, "j2");
});

test("a session sharing a job threadId merges into the job card", () => {
  const { homeCards } = ctx();
  const jobs = [{ id: "j1", threadId: "t1", live: "working", status: "running", title: "Job", workspaceRoot: "D:\\repo", heartbeatAt: new Date(NOW).toISOString() }];
  const sessions = [{ id: "s1", threadId: "t1", status: "LIVE", title: "Same run", cwd: "D:\\repo", lastGrow: NOW, tokensUsed: 7 }];
  const { active } = homeCards(sessions, jobs, NOW);
  assert.equal(active.length, 1);
  assert.equal(active[0].sessionId, "s1");
  assert.equal(active[0].tokens, 7);
});

test("a resumed thread's session merges onto the working job card, not the completed one, regardless of job order", () => {
  const { homeCards } = ctx();
  const completedJob = { id: "j-old", threadId: "t1", live: "completed", status: "completed", title: "First run", workspaceRoot: "D:\\repo", updatedAt: new Date(NOW - 9000).toISOString() };
  const workingJob = { id: "j-new", threadId: "t1", live: "working", status: "running", title: "Resumed run", workspaceRoot: "D:\\repo", heartbeatAt: new Date(NOW).toISOString() };
  const sessions = [{ id: "s1", threadId: "t1", status: "LIVE", title: "Same thread", cwd: "D:\\repo", lastGrow: NOW, tokensUsed: 99 }];

  const completedFirst = homeCards(sessions, [completedJob, workingJob], NOW);
  assert.deepEqual(plain(completedFirst.active.map(c => c.id)), ["j-new"]);
  assert.equal(completedFirst.active[0].sessionId, "s1");
  assert.equal(completedFirst.active[0].tokens, 99);
  assert.equal(completedFirst.finished.length, 1);
  assert.equal(completedFirst.finished[0].id, "j-old");
  assert.equal(completedFirst.finished[0].sessionId, null);
  assert.equal(completedFirst.finished[0].tokens, 0);

  const workingFirst = homeCards(sessions, [workingJob, completedJob], NOW);
  assert.deepEqual(plain(workingFirst.active.map(c => c.id)), ["j-new"]);
  assert.equal(workingFirst.active[0].sessionId, "s1");
  assert.equal(workingFirst.active[0].tokens, 99);
  assert.equal(workingFirst.finished.length, 1);
  assert.equal(workingFirst.finished[0].id, "j-old");
  assert.equal(workingFirst.finished[0].sessionId, null);
  assert.equal(workingFirst.finished[0].tokens, 0);
});

test("stuck sessions count as active; archived are dropped; finished capped at 5", () => {
  const { homeCards } = ctx();
  const sessions = [
    { id: "stuck", status: "STALE", title: "Stuck", cwd: "", lastGrow: NOW },
    { id: "arch", status: "DONE", archived: true, title: "Old", cwd: "", lastGrow: NOW }
  ];
  const jobs = [];
  for (let i = 0; i < 8; i++) jobs.push({ id: "d" + i, live: "completed", status: "completed", title: "x", workspaceRoot: "", updatedAt: new Date(NOW - i * 1000).toISOString() });
  const { active, finished } = homeCards(sessions, jobs, NOW);
  assert.deepEqual(plain(active.map(c => c.id)), ["stuck"]);
  assert.equal(finished.length, 5);
});
