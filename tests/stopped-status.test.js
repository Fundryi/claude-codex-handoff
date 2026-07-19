const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");

function serverContext() {
  const slice =
    src.match(/function sessionSummary[\s\S]*?\n\}/)[0] +
    "\n" +
    src.match(/function threadJobStatuses[\s\S]*?\n\}/)[0];
  const context = { Date, Map, LIVE_WINDOW_MS: 20000, STALE_AFTER_MS: 600000, ARCHIVED_DIR: "Z:\\archived" };
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

test("threadJobStatuses keeps the newest job per thread", () => {
  const ctx = serverContext();
  const map = ctx.threadJobStatuses([
    { threadId: "t-1", status: "running" },
    { threadId: "t-1", status: "cancelled" },
    { threadId: "t-2", status: "cancelled" },
  ]);
  assert.equal(map.get("t-1"), "running");
  assert.equal(map.get("t-2"), "cancelled");
});

test("UI knows the STOPPED status", () => {
  assert.match(html, /STOPPED:\s*\{\s*label:\s*'Stopped'/);
  assert.match(html, /\.status\.STOPPED\s*\{/);
  // stop button is pointless on an already-stopped task
  assert.match(html, /stopButton\.hidden = session\.status === 'DONE' \|\| session\.status === 'STOPPED'/);
});
