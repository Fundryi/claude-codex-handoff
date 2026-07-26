const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const src = fs.readFileSync(path.join(__dirname, "..", "plugin", "scripts", "codex-companion.mjs"), "utf8");

test("task accepts --resume-thread and validates like resume-last", () => {
  assert.ok(src.includes('"resume-thread"'), "resume-thread must be a value option");
  assert.match(src, /function requireTaskRequest\(prompt, resumeLast, resumeThreadId\)/);
});

test("review command supports --background via the shared worker", () => {
  assert.match(src, /jobClass === "review"\s*\?\s*\(\)\s*=>\s*executeReviewRun/);
});

test("job records carry model, effort, sandbox", () => {
  assert.match(src, /sandbox:\s*companionSandbox\(\)/);
  assert.match(src, /model,\s*\n?\s*effort,/);
});

test("task and review commands accept --fast", () => {
  assert.match(src, /async function handleTask\(argv\)[\s\S]*?booleanOptions:\s*\[[^\]]*"fast"/);
  assert.match(src, /async function handleReviewCommand\(argv, config\)[\s\S]*?booleanOptions:\s*\[[^\]]*"fast"/);
});

test("fast reaches task and review requests", () => {
  assert.match(src, /const fast = Boolean\(options\.fast\);/);
  assert.match(src, /function buildTaskRequest\(\{[^}]*fast[^}]*\}\)[\s\S]*?return \{[^}]*fast/);
  assert.match(src, /reviewName: config\.reviewName,\s*\n?\s*fast: Boolean\(options\.fast\)/);
});

test("job records carry fast", () => {
  assert.match(src, /function createCompanionJob\(\{[^}]*fast = false[^}]*\}\)/);
  assert.match(src, /createJobRecord\(\{[\s\S]*?fast,/);
});

test("the foreground execution path is gone for good", () => {
  assert.equal(
    src.includes("runForegroundCommand"),
    false,
    "runForegroundCommand lets a harness timeout kill Codex - it must not come back"
  );
});

// (?:(?!\n\})[\s\S])*? stops the match at the first column-0 "}", i.e. the end of the
// named function. An unbounded [\s\S]*? would happily reach a sibling function's call,
// so deleting either handler's call would still pass - a guard that cannot fail.
const insideBody = (name, call) =>
  new RegExp(`async function ${name}\\((?:(?!\\n\\})[\\s\\S])*?${call}`);

test("task and review both reach codex through the detached worker", () => {
  assert.match(src, insideBody("handleTask", "enqueueBackgroundTask\\(cwd, job, request\\)"));
  assert.match(src, insideBody("handleReviewCommand", "enqueueBackgroundTask\\(cwd, job, request\\)"));
});

test("the non-background path follows the detached job instead of running it inline", () => {
  assert.match(src, insideBody("handleTask", "await followAndReport\\(cwd, job, logFile"));
  assert.match(src, insideBody("handleReviewCommand", "await followAndReport\\(cwd, job, logFile"));
});

// runTrackedJob's catch path writes errorMessage but no rendered/result and a null
// exitCode, so a naive follower prints "" and exits 0 on a crashed run. Deleting
// runForegroundCommand removed main().catch as the thing that used to surface it.
test("a crashed run surfaces its error instead of exiting silently with 0", () => {
  assert.match(
    src,
    /async function followAndReport\([\s\S]*?stored\.errorMessage[\s\S]*?process\.exitCode = 1;/,
    "followAndReport must report a job that failed without recording a result"
  );
});

// A job followed to completion prints its result inline - that IS delivery, so the
// re-attach hook (pending-jobs-hook.mjs) must not later flag it as undelivered.
// Only the handback branch (still running, nothing printed) leaves it genuinely
// undelivered. Sliced by function boundary rather than a single anchored regex so
// this still finds the right code no matter how the branches get reordered.
test("markJobAnnounced stamps announcedAt into both the per-job file and state.json", () => {
  assert.match(
    src,
    /function markJobAnnounced\(job, stored\) \{[\s\S]*?writeJobFile\(job\.workspaceRoot, job\.id, \{ \.\.\.stored, announcedAt \}\);[\s\S]*?upsertJob\(job\.workspaceRoot, \{ id: job\.id, announcedAt \}\);/,
    "markJobAnnounced must write announcedAt to the job file and the state.json entry, like the hook's markAnnounced"
  );
});

test("only the delivered paths in followAndReport mark a job announced", () => {
  const start = src.indexOf("async function followAndReport(");
  assert.notEqual(start, -1, "followAndReport must exist");
  const nextFnStart = src.indexOf("function spawnDetachedTaskWorker(", start);
  assert.notEqual(nextFnStart, -1, "spawnDetachedTaskWorker must exist right after followAndReport");
  const body = src.slice(start, nextFnStart);

  const handbackStart = body.indexOf("if (snapshot.waitTimedOut)");
  const crashGuardStart = body.indexOf("stored.rendered == null");
  assert.ok(handbackStart !== -1 && crashGuardStart !== -1 && handbackStart < crashGuardStart);

  const handbackBlock = body.slice(handbackStart, crashGuardStart);
  assert.equal(
    handbackBlock.includes("markJobAnnounced"),
    false,
    "the handback branch must not mark the job announced - it is still running and genuinely undelivered"
  );

  const crashGuardBlock = body.slice(crashGuardStart);
  assert.match(
    crashGuardBlock,
    /process\.exitCode = 1;[\s\S]*?markJobAnnounced\(job, stored\);/,
    "the crash-guard branch reports the error to the user, so it must mark the job announced"
  );

  const successTailStart = body.indexOf("outputResult(options.json ? stored.result");
  assert.notEqual(successTailStart, -1);
  const successTail = body.slice(successTailStart);
  assert.match(
    successTail,
    /markJobAnnounced\(job, stored\);/,
    "the success path prints the result, so it must mark the job announced"
  );
});
