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

// Fold-in fix: Date.parse on an unparseable/missing-but-truthy timestamp is NaN,
// which used to flow straight into the template as "NaNhNaNm" plus a doubled space
// and a bare "ago" once ageLabel started returning "".
test("an unparseable timestamp falls back to a readable label, never NaN", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const report = buildPendingJobsReport(
    [
      { id: "task-badclock", status: "completed", title: "Codex Rescue", completedAt: "not-a-date" },
      { id: "rev-badclock", status: "running", phase: "reviewing", startedAt: "also-not-a-date" }
    ],
    NOW
  );
  assert.equal(report.includes("NaN"), false, "must never render NaN");
  assert.equal(/ {2,}ago/.test(report), false, "must not render a doubled space before ago");
  assert.match(report, /task-badclock  completed unknown time ago/);
  assert.match(report, /rev-badclock  running unknown time · phase: reviewing/);
});

// Required test (fix round 1): markAnnounced must stamp announcedAt into both
// stores for exactly the targeted job, and must not disturb updatedAt anywhere -
// upsertJob forces updatedAt to "now" on every patch, which would repoint
// sortJobsNewestFirst (and so bare /codex:result and /codex:status's
// latestFinished) at whichever job last got announced, not whichever job is
// actually newest.
test("markAnnounced stamps announcedAt in both stores without touching updatedAt", async () => {
  const stateUrl = pathToFileURL(
    path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")
  ).href;
  const { markAnnounced } = await import(hookUrl);
  const state = await import(stateUrl);

  const cwd = process.cwd();
  const targetUpdatedAt = iso(10 * 60_000);
  const otherUpdatedAt = iso(5 * 60_000);

  state.writeJobFile(cwd, "task-mark", { id: "task-mark", status: "completed", updatedAt: targetUpdatedAt });
  state.writeJobFile(cwd, "task-other", { id: "task-other", status: "completed", updatedAt: otherUpdatedAt });
  state.updateState(cwd, (s) => {
    s.jobs.push({ id: "task-mark", status: "completed", updatedAt: targetUpdatedAt });
    s.jobs.push({ id: "task-other", status: "completed", updatedAt: otherUpdatedAt });
  });

  markAnnounced(cwd, [{ id: "task-mark", status: "completed" }], iso(0));

  const markedFile = state.readJobFile(state.resolveJobFile(cwd, "task-mark"));
  assert.ok(markedFile.announcedAt, "(a) the job file must carry announcedAt");
  assert.equal(markedFile.updatedAt, targetUpdatedAt, "(b) the job file's updatedAt must be untouched");

  const stateJobs = state.loadState(cwd).jobs;
  const marked = stateJobs.find((job) => job.id === "task-mark");
  const untouched = stateJobs.find((job) => job.id === "task-other");
  assert.ok(marked.announcedAt, "(a) the state.json entry must carry announcedAt");
  assert.equal(marked.updatedAt, targetUpdatedAt, "(b) the state.json entry's updatedAt must be untouched");
  assert.equal(untouched.announcedAt, undefined, "(c) the untouched job must not gain announcedAt");
  assert.equal(untouched.updatedAt, otherUpdatedAt, "(b) the untouched job's updatedAt must also be untouched");
});
