const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const companionPath = path.join(__dirname, "..", "plugin", "scripts", "codex-companion.mjs");
const src = fs.readFileSync(companionPath, "utf8");

// Slice a top-level function's body: from its declaration to the next column-0 "}".
function functionBody(name) {
  const start = src.indexOf(name);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = src.indexOf("\n}", start);
  assert.notEqual(end, -1, `${name} must be a top-level function`);
  return src.slice(start, end);
}

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

// Codex's built-in default effort is low on gpt-5.6-sol; an unset --effort must
// never fall through to it. max and ultra stay opt-in.
test("unset effort falls back to xhigh", () => {
  assert.match(src, /DEFAULT_REASONING_EFFORT = "xhigh"/);
  assert.match(src, /normalizeReasoningEffort\(options\.effort\) \?\? DEFAULT_REASONING_EFFORT/);
  assert.equal(src.includes('"minimal"'), false, "minimal is not a real Codex effort");
  assert.equal(/VALID_REASONING_EFFORTS = new Set\(\[[^\]]*"none"/.test(src), false, "none is not a real Codex effort");
});

test("model aliases cover sol, terra, luna, spark", () => {
  assert.match(src, /\["sol", "gpt-5\.6-sol"\]/);
  assert.match(src, /\["terra", "gpt-5\.6-terra"\]/);
  assert.match(src, /\["luna", "gpt-5\.6-luna"\]/);
  assert.match(src, /\["daybreak-blue", "gpt-daybreak-blue-latest"\]/);
  assert.match(src, /\["spark", "gpt-5\.3-codex-spark"\]/);
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
// Fix round 1, Important 2 + fold-in 4: upsertJob forces updatedAt to now on every
// patch, and sortJobsNewestFirst sorts on updatedAt - bare /codex:result and
// /codex:status's latestFinished both depend on that order. markJobAnnounced must
// stamp state.json without disturbing updatedAt (matching the hook's markAnnounced,
// which was fixed the same way), and must not create a bogus job file - containing
// nothing but announcedAt - when the crash-guard path's readStoredJob found none.
test("markJobAnnounced guards the per-job-file write and stamps state.json via updateState, not upsertJob", () => {
  const start = src.indexOf("function markJobAnnounced(job, stored)");
  assert.notEqual(start, -1, "markJobAnnounced must exist");
  const nextFnStart = src.indexOf("async function followAndReport(", start);
  assert.notEqual(nextFnStart, -1);
  const body = src.slice(start, nextFnStart);

  assert.match(body, /const jobFile = resolveJobFile\(job\.workspaceRoot, job\.id\);/);
  assert.match(
    body,
    /if \(fs\.existsSync\(jobFile\)\) \{[\s\S]*?writeJobFile\(job\.workspaceRoot, job\.id, \{ \.\.\.stored, announcedAt \}\);/,
    "must not create a bogus job file when readStoredJob found nothing, like the hook's markAnnounced"
  );
  assert.match(
    body,
    /updateState\(job\.workspaceRoot, \(state\) => \{[\s\S]*?announcedAt = announcedAt;/,
    "must stamp the state.json entry via a field-preserving updateState, not upsertJob"
  );
  assert.equal(
    body.includes("upsertJob("),
    false,
    "upsertJob forces updatedAt to now and would reorder sortJobsNewestFirst"
  );
});

// Fix round 1, Important 1: a stamping failure (e.g. Windows EBUSY/EPERM from
// saveState's unlinkSync racing the viewer or a live worker) must not turn an
// already-printed result into a non-zero exit via main().catch. Losing the stamp
// just means pending-jobs-hook.mjs re-reports the job next prompt.
test("markJobAnnounced swallows a stamping failure instead of letting it reach main().catch", () => {
  const start = src.indexOf("function markJobAnnounced(job, stored)");
  const nextFnStart = src.indexOf("async function followAndReport(", start);
  const body = src.slice(start, nextFnStart);

  assert.match(body, /\btry \{/, "the stamping work must run inside a try block");
  const catchIndex = body.search(/\}\s*catch\s*\{/);
  assert.notEqual(catchIndex, -1, "must have a catch block");
  const catchBlock = body.slice(catchIndex);
  assert.equal(catchBlock.includes("throw"), false, "the catch must swallow, not rethrow");
  assert.equal(
    catchBlock.includes("process.exitCode"),
    false,
    "a stamping failure must not touch the exit code - the result was already printed"
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

// Windows `taskkill /T` enumerates descendants by walking ParentProcessId at kill
// time, and `detached: true` does not clear that link - so a tree kill of the
// follower reached the worker and codex under it, which is the original incident.
// The trampoline exits immediately, leaving the worker parented to a dead pid that
// taskkill cannot traverse. These two guards exist because the double-spawn looks
// redundant and someone WILL try to collapse it.
test("spawnDetachedTaskWorker spawns the trampoline, never the worker directly", () => {
  const body = functionBody("function spawnDetachedTaskWorker(");
  assert.match(body, /"task-worker-launch"/, "must spawn the trampoline");
  assert.equal(
    /"task-worker"/.test(body),
    false,
    "spawning task-worker directly leaves a live ParentProcessId link for taskkill /T to walk"
  );
});

test("task-worker-launch is dispatched and spawns the real worker detached", () => {
  assert.match(
    src,
    /case "task-worker-launch":\s*\n\s*await handleTaskWorkerLaunch\(argv\);/,
    "the trampoline needs a dispatcher case or the spawn is a no-op"
  );
  const body = functionBody("async function handleTaskWorkerLaunch(");
  assert.match(body, /"task-worker"/, "the trampoline must spawn the real worker");
  assert.match(body, /detached: true/);
  assert.match(body, /child\.unref\(\)/);
  // Without the pid swap the record keeps the trampoline's pid, which is dead
  // moments later, and reconcileDeadJobs marks a healthy job failed.
  assert.match(body, /pid: child\.pid \?\? null/, "must hand the record the real worker's pid");
  assert.equal(body.includes("upsertJob("), false, "upsertJob would bump updatedAt and reorder jobs");
});

test("the trampoline hands the job record the real worker's pid, then exits", async () => {
  const root = path.join(os.tmpdir(), `clv-tramp-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.env.CODEX_COMPANION_STATE_ROOT = root;
  const state = await import(
    pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")).href
  );

  const workspace = path.join(root, "ws");
  fs.mkdirSync(workspace, { recursive: true });

  // No `request` on purpose: the worker throws on the missing payload before
  // runTrackedJob ever runs, so it never touches the pid we are asserting on and
  // no codex process is started.
  const job = {
    id: "task-trampoline",
    title: "Codex Task",
    jobClass: "task",
    status: "queued",
    phase: "queued",
    workspaceRoot: workspace,
    pid: null,
    logFile: null
  };
  state.writeJobFile(workspace, job.id, job);
  state.upsertJob(workspace, job);

  const launcher = spawn(
    process.execPath,
    [companionPath, "task-worker-launch", "--cwd", workspace, "--job-id", job.id],
    { stdio: "ignore" }
  );
  const launcherPid = launcher.pid;
  const exitCode = await new Promise((resolve) => launcher.on("exit", resolve));
  assert.equal(exitCode, 0, "the trampoline must exit cleanly and immediately");

  const stored = state.readJobFile(state.resolveJobFile(workspace, job.id));
  assert.equal(typeof stored.pid, "number", "the trampoline must record a worker pid");
  assert.notEqual(stored.pid, launcherPid, "the recorded pid must be the worker's, not the dying launcher's");
  assert.equal(
    state.loadState(workspace).jobs.find((entry) => entry.id === job.id).pid,
    stored.pid,
    "both stores must agree, or reconcileDeadJobs reads the stale one"
  );
});

const pluginDir = path.join(__dirname, "..", "plugin");

test("no prompt file asks the model to guess how long a task will run", () => {
  const files = [
    path.join(pluginDir, "commands", "rescue.md"),
    path.join(pluginDir, "commands", "review.md"),
    path.join(pluginDir, "commands", "adversarial-review.md"),
    path.join(pluginDir, "agents", "codex-rescue.md"),
    path.join(pluginDir, "skills", "codex-cli-runtime", "SKILL.md")
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(
      /default to foreground|prefer foreground|likely to keep Codex running|clearly tiny|recommend background/i.test(text),
      false,
      `${path.basename(file)} still asks the model to choose an execution mode`
    );
  }
});

test("the review commands no longer offer an execution-mode choice", () => {
  for (const name of ["review.md", "adversarial-review.md"]) {
    const text = fs.readFileSync(path.join(pluginDir, "commands", name), "utf8");
    assert.equal(/AskUserQuestion/.test(text), false, `${name} must not ask about execution mode`);
    assert.equal(/run_in_background/.test(text), false, `${name} must not background the Bash call`);
  }
});
