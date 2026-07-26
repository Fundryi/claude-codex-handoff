const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const stateUrl = pathToFileURL(
  path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")
).href;
const jobControlUrl = pathToFileURL(
  path.join(__dirname, "..", "plugin", "scripts", "lib", "job-control.mjs")
).href;

let seq = 0;

// Each test gets its own state root so ordering never matters.
function freshRoot() {
  const root = path.join(os.tmpdir(), `clv-reconcile-${process.pid}-${seq++}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.env.CODEX_COMPANION_STATE_ROOT = root;
  return root;
}

async function loadState() {
  return import(`${stateUrl}?r=${seq}`);
}

function jobRecord(overrides) {
  return {
    id: "task-zzz",
    title: "Codex Rescue",
    jobClass: "task",
    status: "running",
    phase: "investigating",
    workspaceRoot: process.cwd(),
    pid: null,
    logFile: null,
    ...overrides
  };
}

async function seed(state, record) {
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);
}

test("a running job with no live pid is reconciled to failed", async () => {
  freshRoot();
  const state = await loadState();
  await seed(state, jobRecord({ pid: null }));

  const reconciled = state.reconcileDeadJobs(process.cwd());
  assert.deepEqual(reconciled, ["task-zzz"]);

  const stored = state.readJobFile(state.resolveJobFile(process.cwd(), "task-zzz"));
  assert.equal(stored.status, "failed");
  assert.equal(stored.phase, "died");
  assert.equal(stored.diedReason, "process-vanished");
  assert.equal(stored.pid, null);
  assert.ok(stored.completedAt, "completedAt must be stamped");

  const entry = state.listJobs(process.cwd()).find((job) => job.id === "task-zzz");
  assert.equal(entry.status, "failed", "state.json must agree with the job file");
  assert.equal(entry.completedAt, stored.completedAt, "both stores must agree on completedAt");
});

test("a running job whose pid is alive is left alone", async () => {
  freshRoot();
  const state = await loadState();
  await seed(state, jobRecord({ id: "task-live", pid: process.pid }));

  assert.deepEqual(state.reconcileDeadJobs(process.cwd()), []);
  const stored = state.readJobFile(state.resolveJobFile(process.cwd(), "task-live"));
  assert.equal(stored.status, "running");
});

test("terminal jobs are untouched and cause no write", async () => {
  freshRoot();
  const state = await loadState();
  await seed(state, jobRecord({ id: "task-done", status: "completed", pid: null }));

  // A same-tick write would false-pass the mtime comparison below on filesystems
  // with coarse timestamp resolution.
  await new Promise((r) => setTimeout(r, 20));
  const stateFile = state.resolveStateFile(process.cwd());
  const before = fs.statSync(stateFile).mtimeMs;
  assert.deepEqual(state.reconcileDeadJobs(process.cwd()), []);
  assert.equal(fs.statSync(stateFile).mtimeMs, before, "a clean read must not rewrite state");
});

test("listJobs reconciles, so /codex:result stops refusing a dead job", async () => {
  freshRoot();
  const state = await loadState();
  await seed(state, jobRecord({ id: "task-jam", pid: null, rendered: "partial output" }));

  const jobControl = await import(`${jobControlUrl}?r=${seq}`);
  const resolved = jobControl.resolveResultJob(process.cwd(), "task-jam");
  assert.equal(resolved.job.id, "task-jam");
  assert.equal(resolved.job.status, "failed");
});

test("a reconciled job is no longer cancelable", async () => {
  freshRoot();
  const state = await loadState();
  await seed(state, jobRecord({ id: "task-gone", pid: null }));

  const jobControl = await import(`${jobControlUrl}?r=${seq}`);
  // ponytail: matchJobReference (job-control.mjs, reference-only for this task) throws its
  // own "No job found" message before resolveCancelableJob's "No active job found" branch can
  // ever run when a reference is passed — that branch is unreachable dead code at baseline,
  // pre-existing and unrelated to reconciliation. The assertion still proves the intent from
  // the design spec: a reconciled job is no longer treated as active/cancelable.
  assert.throws(
    () => jobControl.resolveCancelableJob(process.cwd(), "task-gone"),
    /No job found/
  );
});
