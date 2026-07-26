const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const followUrl = pathToFileURL(
  path.join(__dirname, "..", "plugin", "scripts", "lib", "job-follow.mjs")
).href;
const stateUrl = pathToFileURL(
  path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")
).href;

let seq = 0;

function freshRoot() {
  const root = path.join(os.tmpdir(), `clv-follow-${process.pid}-${seq++}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.env.CODEX_COMPANION_STATE_ROOT = root;
  return root;
}

function jobRecord(overrides) {
  return {
    id: "task-follow",
    title: "Codex Rescue",
    jobClass: "task",
    status: "running",
    phase: "investigating",
    workspaceRoot: process.cwd(),
    pid: process.pid,
    logFile: null,
    ...overrides
  };
}

test("a terminal job returns immediately and does not time out", async () => {
  freshRoot();
  const state = await import(`${stateUrl}?f=${seq}`);
  const { followJob } = await import(`${followUrl}?f=${seq}`);
  const record = jobRecord({ status: "completed", rendered: "done\n", exitCode: 0 });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const snapshot = await followJob(process.cwd(), record.id, null, { budgetMs: 5000, quiet: true });
  assert.equal(snapshot.waitTimedOut, false);
  assert.equal(snapshot.job.status, "completed");
});

test("an active job hands back when the budget expires", async () => {
  freshRoot();
  const state = await import(`${stateUrl}?f=${seq}`);
  const { followJob } = await import(`${followUrl}?f=${seq}`);
  const record = jobRecord({ id: "task-slow", pid: process.pid });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const started = Date.now();
  const snapshot = await followJob(process.cwd(), record.id, null, { budgetMs: 300, quiet: true });
  assert.equal(snapshot.waitTimedOut, true);
  assert.equal(snapshot.job.status, "running");
  assert.ok(Date.now() - started >= 300, "must actually wait out the budget");
});

test("log lines are emitted once, never repeated", async () => {
  freshRoot();
  const root = process.env.CODEX_COMPANION_STATE_ROOT;
  const state = await import(`${stateUrl}?f=${seq}`);
  const { followJob } = await import(`${followUrl}?f=${seq}`);

  fs.mkdirSync(root, { recursive: true });
  const logFile = path.join(root, "follow.log");
  fs.writeFileSync(logFile, "first line\n", "utf8");

  const record = jobRecord({ id: "task-log", pid: process.pid, logFile });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    setTimeout(() => fs.appendFileSync(logFile, "second line\n", "utf8"), 120);
    await followJob(process.cwd(), record.id, logFile, { budgetMs: 400 });
  } finally {
    process.stderr.write = originalWrite;
  }

  const emitted = chunks.join("");
  assert.equal(emitted.match(/first line/g).length, 1, "first line emitted exactly once");
  assert.equal(emitted.match(/second line/g).length, 1, "second line emitted exactly once");
});

test("a state.json caught mid-write costs one tick, not the whole run", async () => {
  freshRoot();
  const state = await import(`${stateUrl}?f=${seq}`);
  const { followJob } = await import(`${followUrl}?f=${seq}`);
  const record = jobRecord({ id: "task-torn" });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const stateFile = state.resolveStateFile(process.cwd());
  const good = fs.readFileSync(stateFile, "utf8");

  // Tear the file after the seed read, then restore it terminal a moment later.
  setTimeout(() => fs.writeFileSync(stateFile, good.slice(0, good.length >> 1), "utf8"), 150);
  setTimeout(() => {
    fs.writeFileSync(stateFile, good, "utf8");
    state.upsertJob(process.cwd(), { id: record.id, status: "completed" });
  }, 400);

  const snapshot = await followJob(process.cwd(), record.id, null, { budgetMs: 5000, quiet: true });
  assert.equal(snapshot.waitTimedOut, false, "a torn read must not abort the follow");
  assert.equal(snapshot.job.status, "completed");
});

test("a job that genuinely does not exist still throws", async () => {
  freshRoot();
  const state = await import(`${stateUrl}?f=${seq}`);
  const { followJob } = await import(`${followUrl}?f=${seq}`);
  const record = jobRecord({ id: "task-present" });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  await assert.rejects(
    () => followJob(process.cwd(), "task-nope", null, { budgetMs: 2000, quiet: true }),
    /No job found/,
    "tolerating torn reads must not swallow a real unknown-job error"
  );
});

test("the final output block is not echoed to stderr", async () => {
  freshRoot();
  const root = process.env.CODEX_COMPANION_STATE_ROOT;
  const state = await import(`${stateUrl}?f=${seq}`);
  const { followJob } = await import(`${followUrl}?f=${seq}`);

  fs.mkdirSync(root, { recursive: true });
  const logFile = path.join(root, "final.log");
  fs.writeFileSync(
    logFile,
    "[2026-01-01T00:00:00.000Z] Turn completed.\n\n[2026-01-01T00:00:01.000Z] Final output\nTHE ANSWER\n",
    "utf8"
  );

  const record = jobRecord({ id: "task-final", status: "completed", logFile, rendered: "THE ANSWER\n", exitCode: 0 });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await followJob(process.cwd(), record.id, logFile, { budgetMs: 500 });
  } finally {
    process.stderr.write = originalWrite;
  }

  const emitted = chunks.join("");
  assert.match(emitted, /Turn completed/, "progress lines must still stream");
  assert.equal(emitted.includes("THE ANSWER"), false, "the rendered answer belongs on stdout only");
});

test("the handback names the job, the workspace, and how to get the result", async () => {
  const { renderFollowHandback } = await import(`${followUrl}?f=${seq}`);
  const text = renderFollowHandback({
    jobId: "task-abc",
    title: "Codex Rescue",
    status: "running",
    workspaceRoot: "D:\\GIT\\example"
  });
  assert.match(text, /task-abc/);
  assert.match(text, /still running/i);
  assert.match(text, /--cwd/, "must pin --cwd so a follow-up from another directory still finds it");
  assert.match(text, /D:\\GIT\\example/);
});
