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
  const warnings = (proc, started) => JSON.parse(JSON.stringify(ctx.processWarnings(proc, started)));
  assert.deepEqual(
    warnings({ cmd: "codex app-server --port 1", started: t0 + 3000 }, t0),
    { shared: true, timeMatch: true },
  );
  assert.deepEqual(
    warnings({ cmd: "codex exec resume abc", started: t0 + 60000 }, t0),
    { shared: false, timeMatch: false },
  );
  assert.deepEqual(
    warnings({ cmd: "codex mcp-server", started: 0 }, 0),
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
  assert.equal(ctx.archiveCommand("abc-123"), "codex archive abc-123");
});

test("dismissed sessions hide in every filter except All", () => {
  const ctx = helperContext();
  assert.equal(ctx.dismissedHides({ id: "a" }, "STALE", ["a"]), true);
  assert.equal(ctx.dismissedHides({ id: "a" }, "ACTIVE", ["a"]), true);
  assert.equal(ctx.dismissedHides({ id: "a" }, "ALL", ["a"]), false);
  assert.equal(ctx.dismissedHides({ id: "b" }, "STALE", ["a"]), false);
  assert.equal(ctx.dismissedHides({ id: "a" }, "STALE", undefined), false);
});
