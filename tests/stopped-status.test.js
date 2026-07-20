const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");

function serverContext() {
  const slice =
    src.match(/const STUCK_AFTER_MS[\s\S]*?function classifyJobLiveness[\s\S]*?\n\}/)[0] +
    "\n" +
    src.match(/function pidAlive[\s\S]*?\n\}/)[0] +
    "\n" +
    src.match(/function sessionSummary[\s\S]*?\n\}/)[0] +
    "\n" +
    src.match(/function threadJobStatuses[\s\S]*?\n\}/)[0];
  const context = { Date, Map, process, LIVE_WINDOW_MS: 20000, STALE_AFTER_MS: 600000, ARCHIVED_DIR: "Z:\\archived" };
  vm.runInNewContext(slice, context);
  return context;
}

function makeSession(quietMs) {
  return {
    id: "s1",
    file: "C:\\sessions\\rollout-1.jsonl",
    lastGrow: Date.now() - quietMs,
    events: [],
    meta: { threadId: "t-1" },
  };
}

test("quiet session whose job was cancelled reports STOPPED", () => {
  const ctx = serverContext();
  const jobStatus = new Map([["t-1", "cancelled"]]);
  assert.equal(ctx.sessionSummary(makeSession(60000), jobStatus).status, "STOPPED");
  assert.equal(ctx.sessionSummary(makeSession(20 * 60 * 1000), jobStatus).status, "STOPPED");
});

test("live or unrelated sessions are not overridden", () => {
  const ctx = serverContext();
  const jobStatus = new Map([["t-1", "cancelled"]]);
  assert.equal(ctx.sessionSummary(makeSession(1000), jobStatus).status, "LIVE");
  assert.equal(ctx.sessionSummary(makeSession(60000), new Map()).status, "IDLE");
  assert.equal(ctx.sessionSummary(makeSession(60000)).status, "IDLE");
});

const ALIVE_PID = process.pid;
const DEAD_PID = 999999999;
function beat(msAgo) { return new Date(Date.now() - msAgo).toISOString(); }

test("quiet session with a working job reports LIVE", () => {
  const ctx = serverContext();
  const jobs = ctx.threadJobStatuses([{ threadId: "t-1", status: "running", pid: ALIVE_PID, heartbeatAt: beat(30000) }]);
  assert.equal(ctx.sessionSummary(makeSession(60000), jobs).status, "LIVE");
  assert.equal(ctx.sessionSummary(makeSession(20 * 60 * 1000), jobs).status, "LIVE");
});

test("quiet session with a dead job reports STALE without the 10min wait", () => {
  const ctx = serverContext();
  const jobs = ctx.threadJobStatuses([{ threadId: "t-1", status: "running", pid: DEAD_PID, heartbeatAt: beat(30000) }]);
  assert.equal(ctx.sessionSummary(makeSession(60000), jobs).status, "STALE");
});

test("possibly-stuck job falls back to quiet-time behavior", () => {
  const ctx = serverContext();
  const jobs = ctx.threadJobStatuses([{ threadId: "t-1", status: "running", pid: ALIVE_PID, heartbeatAt: beat(20 * 60000) }]);
  assert.equal(ctx.sessionSummary(makeSession(60000), jobs).status, "IDLE");
  assert.equal(ctx.sessionSummary(makeSession(20 * 60 * 1000), jobs).status, "STALE");
});

test("done beats a working job", () => {
  const ctx = serverContext();
  const jobs = ctx.threadJobStatuses([{ threadId: "t-1", status: "running", pid: ALIVE_PID, heartbeatAt: beat(30000) }]);
  const done = makeSession(60000);
  done.events = [{ kind: "done", text: "" }];
  assert.equal(ctx.sessionSummary(done, jobs).status, "DONE");
});

test("threadJobStatuses classifies liveness, newest job per thread wins", () => {
  const ctx = serverContext();
  const map = ctx.threadJobStatuses([
    { threadId: "t-1", status: "running", pid: ALIVE_PID, heartbeatAt: beat(30000) },
    { threadId: "t-1", status: "cancelled" },
    { threadId: "t-2", status: "cancelled" },
  ]);
  assert.equal(map.get("t-1"), "working");
  assert.equal(map.get("t-2"), "cancelled");
});

test("UI knows the STOPPED status", () => {
  assert.match(html, /STOPPED:\s*\{\s*label:\s*'Stopped'/);
  assert.match(html, /\.status\.STOPPED\s*\{/);
  // stop button is pointless on an already-stopped task
  assert.match(html, /stopButton\.hidden = session\.status === 'DONE' \|\| session\.status === 'STOPPED'/);
});
