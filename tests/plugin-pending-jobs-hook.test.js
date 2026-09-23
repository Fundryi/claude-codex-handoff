const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

const hookPath = path.join(__dirname, "..", "plugin", "scripts", "pending-jobs-hook.mjs");
const hookUrl = pathToFileURL(hookPath).href;
const libUrl = (name) => pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", name)).href;

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
    },
    { id: "task-fresh", status: "running", startedAt: iso(10_000) }
  ];
  const report = buildPendingJobsReport(jobs, NOW);
  assert.match(report, /task-handback/);
  assert.match(report, /running 3m/);
  // Under 30 seconds rounds to zero minutes; "0m" read as if the job never started.
  assert.match(report, /task-fresh  running <1m/);
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

const ANSWER = "Done.\n\n## Summary\nRetry added.\n\n## Checks run\nnpm test\n\n## Needs decision\nKeep the old API? Options: keep (recommended), delete.";

// CloudCLI ends the Claude process on every new message and the session id can
// change. The result must still reach the next prompt, once.
test("a job finished after its Claude process died is delivered to the next session, once", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clv-hook-cloudcli-"));
  const env = { ...process.env, CODEX_COMPANION_STATE_ROOT: stateRoot, CODEX_VIEWER_PORT: "1" };
  const runHook = (sessionId) =>
    spawnSync(process.execPath, [hookPath], {
      cwd: process.cwd(),
      env: { ...env, CODEX_COMPANION_SESSION_ID: sessionId },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId }),
      encoding: "utf8"
    });

  const previous = process.env.CODEX_COMPANION_STATE_ROOT;
  process.env.CODEX_COMPANION_STATE_ROOT = stateRoot;
  process.env.CODEX_VIEWER_PORT = "1";
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const { runTrackedJob } = await import(`${libUrl("tracked-jobs.mjs")}?c=1`);
    const { readNeedsDecision } = await import(libUrl("render.mjs"));
    const { upsertJob } = await import(`${libUrl("state.mjs")}?c=1`);
    const { resolveWorkspaceRoot } = await import(libUrl("workspace.mjs"));
    const ws = resolveWorkspaceRoot(process.cwd());
    const job = { id: "task-cloudcli", workspaceRoot: ws, title: "Add retry", sessionId: "session-A" };

    upsertJob(ws, { ...job, status: "running", pid: worker.pid, startedAt: new Date().toISOString() });
    const running = runHook("session-A");
    assert.match(running.stdout, /task-cloudcli  running/, running.stderr);

    worker.kill();
    await runTrackedJob(job, async () => ({
      exitStatus: 0, threadId: "thr-9", turnId: "u", summary: "Retry added.",
      payload: { rawOutput: ANSWER, threadId: "thr-9" }, rendered: `${ANSWER}\n`,
      needsDecision: readNeedsDecision(ANSWER)
    }), { heartbeatMs: 25 });

    const first = runHook("session-B");
    fs.writeFileSync(path.join(stateRoot, "hook-first-run.txt"), first.stdout);
    assert.match(first.stdout, /task-cloudcli  completed/);
    assert.match(first.stdout, /  Done\.\n  Retry added\./, "the lines above Summary come first");
    assert.match(first.stdout, /Codex asks:\n {4}Keep the old API\?/);
    assert.match(first.stdout, /--resume-thread thr-9/);
    assert.match(first.stdout, /Full text: \/codex:result task-cloudcli/);
    assert.equal(first.stdout.includes("npm test"), false, "Checks run is not part of the short result");

    const second = runHook("session-B");
    assert.equal(second.stdout.includes("task-cloudcli"), false, "delivered once");
  } finally {
    worker.kill();
    process.env.CODEX_COMPANION_STATE_ROOT = previous;
    delete process.env.CODEX_VIEWER_PORT;
  }
});

test("only 3 jobs get a short result; others, missing files and no-heading answers degrade safely", async () => {
  const { buildPendingJobsReport } = await import(hookUrl);
  const finished = (id) => ({ id, status: "completed", title: id, completedAt: iso(60_000) });
  const stored = {
    a: { result: { rawOutput: "## Summary\nA done." } },
    b: { result: { rawOutput: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") } },
    c: { result: { rawOutput: "x".repeat(10_000) } },
    d: { result: { rawOutput: "## Summary\nD done." } }
  };
  const report = buildPendingJobsReport(
    ["a", "b", "c", "d", "gone"].map(finished),
    NOW,
    (job) => stored[job.id] ?? null
  );
  assert.match(report, /A done\./);
  assert.match(report, /line 39/);
  assert.equal(report.includes("line 40"), false, "40 lines per job at most");
  assert.match(report, /x{2000} \[cut\]/, "a single huge line is capped at 2000 characters");
  assert.equal(/x{2001}/.test(report), false, "a single huge line is capped at 2000 characters");
  assert.ok(report.length < 10_000, "the injected text stays under 10,000 characters");
  assert.equal(report.includes("D done."), false, "the 4th job gets a pointer only");
  assert.match(report, /d  completed 1m ago  — d — result not delivered; run: \/codex:result d/);
  assert.match(report, /gone  completed 1m ago  — gone — result not delivered/);
});

// Seed one finished, unannounced job in a fresh state root. The job file holds
// `jobFileText` as written, so a test can make it corrupt.
async function seedFinishedJob(tag, id, jobFileText) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `clv-hook-${tag}-`));
  const previous = process.env.CODEX_COMPANION_STATE_ROOT;
  process.env.CODEX_COMPANION_STATE_ROOT = stateRoot;
  try {
    const state = await import(`${libUrl("state.mjs")}?${tag}=1`);
    const { resolveWorkspaceRoot } = await import(libUrl("workspace.mjs"));
    const ws = resolveWorkspaceRoot(process.cwd());
    state.upsertJob(ws, { id, workspaceRoot: ws, title: "Add retry", status: "completed", completedAt: new Date().toISOString() });
    const jobFile = state.resolveJobFile(ws, id);
    fs.mkdirSync(path.dirname(jobFile), { recursive: true });
    fs.writeFileSync(jobFile, jobFileText);
    return { stateRoot, ws, state };
  } finally {
    process.env.CODEX_COMPANION_STATE_ROOT = previous;
  }
}

// A torn or corrupt job file must not silence the hook: the job still gets its pointer.
test("a corrupt job file falls back to the pointer line", async () => {
  const { stateRoot } = await seedFinishedJob("corrupt", "task-torn", "{not json");
  const run = spawnSync(process.execPath, [hookPath], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_COMPANION_STATE_ROOT: stateRoot, CODEX_VIEWER_PORT: "1" },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8"
  });
  assert.match(run.stdout, /task-torn  completed .* result not delivered; run: \/codex:result task-torn/, run.stderr);
});

// Delivered means written. If Claude's end of the pipe is gone, the job stays
// unannounced so the next prompt still shows it, and the hook does not crash.
test("the hook does not mark jobs delivered when its stdout is gone", async () => {
  const answer = JSON.stringify({ id: "task-gone", status: "completed", result: { rawOutput: "## Summary\nRetry added." } });
  const { stateRoot, ws, state } = await seedFinishedJob("epipe", "task-gone", answer);
  const child = spawn(process.execPath, [hookPath], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_COMPANION_STATE_ROOT: stateRoot, CODEX_VIEWER_PORT: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0, stderr);
  const previous = process.env.CODEX_COMPANION_STATE_ROOT;
  process.env.CODEX_COMPANION_STATE_ROOT = stateRoot;
  try {
    assert.equal(state.loadState(ws).jobs.find((job) => job.id === "task-gone").announcedAt, undefined, "state not marked");
    assert.equal(state.readJobFile(state.resolveJobFile(ws, "task-gone")).announcedAt, undefined, "job file not marked");
  } finally {
    process.env.CODEX_COMPANION_STATE_ROOT = previous;
  }
});

// Codex sometimes answers above the return headings and leaves Summary a stub.
test("shortResult keeps the opening lines above Summary, within the caps", async () => {
  const { shortResult } = await import(hookUrl);
  const raw = (rawOutput) => shortResult({ result: { rawOutput } });
  assert.deepEqual(
    raw("I printed 1, 2, 3, 4, 5 in order.\n\n## Summary\nCompleted.\n\n## Checks run\nnone"),
    ["I printed 1, 2, 3, 4, 5 in order.", "Completed."]
  );
  assert.deepEqual(raw("## Summary\nA done.\n## Checks run\nx"), ["A done."], "no preface: unchanged");
  const lines = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join("\n");
  assert.deepEqual(raw(`${lines("p", 60)}\n## Summary\nS`), ["p0", "p1", "p2", "p3", "p4", "S"], "only the first few preface lines");
  assert.equal(raw(`${lines("p", 60)}\n## Summary\n${lines("s", 60)}`).length, 40, "MAX_LINES still holds");
  const huge = raw(`${"x".repeat(3000)}\n## Summary\n${"y".repeat(3000)}`).join("\n");
  assert.ok(huge.length <= 2000 + " [cut]".length, "MAX_CHARS still holds");
});
