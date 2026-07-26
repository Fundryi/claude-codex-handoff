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

test("task and review both reach codex through the detached worker", () => {
  assert.match(src, /async function handleTask\(argv\)[\s\S]*?enqueueBackgroundTask\(cwd, job, request\)/);
  assert.match(src, /async function handleReviewCommand\(argv, config\)[\s\S]*?enqueueBackgroundTask\(cwd, job, request\)/);
});

test("the non-background path follows the detached job instead of running it inline", () => {
  assert.match(src, /await followAndReport\(cwd, job, logFile/);
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
