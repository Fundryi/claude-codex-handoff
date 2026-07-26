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
