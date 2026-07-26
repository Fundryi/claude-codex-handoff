const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const hookUrl = pathToFileURL(
  path.join(__dirname, "..", "plugin", "scripts", "pending-jobs-hook.mjs")
).href;

// The hook's main() runs unconditionally on import (same pattern as
// codex-companion.mjs), and this repo dogfoods the plugin on itself - so the real
// ~/.codex-companion/state may already hold jobs for this very workspace. Point the
// state root at an empty temp dir before the first import so the hook's cold-path
// early-return kicks in and this suite never touches real job state.
const freshRoot = path.join(os.tmpdir(), `clv-pending-jobs-hook-${process.pid}`);
fs.rmSync(freshRoot, { recursive: true, force: true });
process.env.CODEX_COMPANION_STATE_ROOT = freshRoot;

const NOW = Date.parse("2026-07-26T13:30:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

test("nothing to report produces an empty string", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  assert.equal(buildPendingJobsReport([], NOW), "");
  assert.equal(
    buildPendingJobsReport([{ id: "task-old", status: "completed", announcedAt: iso(1000) }], NOW),
    ""
  );
});

test("an active job is reported with its age and phase", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const report = buildPendingJobsReport(
    [{ id: "rev-1", status: "running", phase: "reviewing", title: "Codex Review", startedAt: iso(12 * 60_000) }],
    NOW
  );
  assert.match(report, /<codex-jobs>/);
  assert.match(report, /rev-1/);
  assert.match(report, /running 12m/);
  assert.match(report, /reviewing/);
});

test("a finished but unannounced job is reported with how to fetch it", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const report = buildPendingJobsReport(
    [{ id: "task-2", status: "completed", title: "Codex Rescue", completedAt: iso(4 * 60_000) }],
    NOW
  );
  assert.match(report, /task-2/);
  assert.match(report, /completed 4m ago/);
  assert.match(report, /result task-2/);
});

test("an already-announced finished job is not reported again", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const report = buildPendingJobsReport(
    [{ id: "task-3", status: "completed", completedAt: iso(60_000), announcedAt: iso(30_000) }],
    NOW
  );
  assert.equal(report, "");
});

test("active jobs are reported every time, announced or not", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const report = buildPendingJobsReport(
    [{ id: "task-4", status: "running", startedAt: iso(60_000), announcedAt: iso(30_000) }],
    NOW
  );
  assert.match(report, /task-4/);
});

// Required extension: printing a result inline (the common "feels like foreground"
// path through followAndReport in codex-companion.mjs) is delivery. followAndReport
// stamps announcedAt on that path, so the record this hook sees afterward looks like
// the one below - the hook must not flag it as an undelivered result.
test("a job followed to completion and delivered inline is not reported", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const jobs = [
    {
      id: "task-followed",
      status: "completed",
      title: "Codex Rescue",
      completedAt: iso(2 * 60_000),
      announcedAt: iso(2 * 60_000)
    }
  ];
  assert.equal(buildPendingJobsReport(jobs, NOW), "");
});

// Required extension: when the follow budget expires, followAndReport hands back
// without ever stamping announcedAt - that job is genuinely still running and
// genuinely undelivered, which is exactly what the hook must surface on the user's
// next prompt.
test("a job handed back when the follow budget expired is reported", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const jobs = [
    {
      id: "task-handback",
      status: "running",
      phase: "investigating",
      title: "Codex Rescue",
      startedAt: iso(3 * 60_000)
    }
  ];
  const report = buildPendingJobsReport(jobs, NOW);
  assert.match(report, /task-handback/);
  assert.match(report, /running 3m/);
});
