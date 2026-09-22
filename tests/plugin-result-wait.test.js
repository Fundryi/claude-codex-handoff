const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

const run = promisify(execFile);
const companion = path.join(__dirname, "..", "plugin", "scripts", "codex-companion.mjs");
const stateUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")).href;

let seq = 0;

async function freshState() {
  const root = path.join(os.tmpdir(), `clv-result-wait-${process.pid}-${seq++}`);
  fs.rmSync(root, { recursive: true, force: true });
  process.env.CODEX_COMPANION_STATE_ROOT = root;
  const state = await import(`${stateUrl}?w=${seq}`);
  return { root, state };
}

function jobRecord(overrides) {
  return {
    id: "task-wait",
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

function runResult(root, args) {
  return run(process.execPath, [companion, "result", ...args, "--json"], {
    cwd: process.cwd(),
    env: { ...process.env, CODEX_COMPANION_STATE_ROOT: root }
  });
}

test("result --wait returns immediately for an already-terminal job", async () => {
  const { root, state } = await freshState();
  const record = jobRecord({ status: "completed", rendered: "done\n", exitCode: 0 });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const { stdout } = await runResult(root, [record.id, "--wait"]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.job.status, "completed");
  assert.equal(payload.storedJob.rendered, "done\n");
  assert.ok(state.loadState(process.cwd()).jobs.find((job) => job.id === record.id).announcedAt);
});

test("result --wait resolves when a dead-pid job is reconciled to failed", async () => {
  const { root, state } = await freshState();
  const record = jobRecord({ id: "task-ghost", pid: 999999999 });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const { stdout } = await runResult(root, [record.id, "--wait"]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.job.status, "failed");
});

test("result --wait --timeout-ms hands back a still-running job", async () => {
  const { root, state } = await freshState();
  const record = jobRecord({ id: "task-slow", pid: process.pid });
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);

  const { stdout } = await runResult(root, [record.id, "--wait", "--timeout-ms", "400"]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.waitTimedOut, true);
  assert.equal(payload.jobId, "task-slow");
});

test("result --wait without a job id fails fast instead of guessing across sessions", async () => {
  const { root } = await freshState();

  await assert.rejects(
    runResult(root, ["--wait"]),
    (error) => {
      assert.match(error.stderr, /requires a job id/);
      return true;
    }
  );
});

// /codex:result printed the answer but never stamped announcedAt, so the prompt
// hook reported the same job as "not delivered" on the next message.
test("result marks a finished job delivered, and leaves a running one alone", async () => {
  const { root, state } = await freshState();
  const done = jobRecord({ id: "task-done", status: "completed", rendered: "done\n", exitCode: 0, pid: null });
  const live = jobRecord({ id: "task-live", status: "running", pid: process.pid });
  for (const record of [done, live]) {
    state.writeJobFile(process.cwd(), record.id, record);
    state.upsertJob(process.cwd(), record);
  }

  // Plain branch: result on a finished job marks it delivered
  await runResult(root, [done.id]);

  // --wait branch: result on a running job with timeout returns a payload
  const { stdout } = await runResult(root, [live.id, "--wait", "--timeout-ms", "100"]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.waitTimedOut, true, "result times out on running job");

  const jobs = state.loadState(process.cwd()).jobs;
  assert.ok(jobs.find((job) => job.id === "task-done").announcedAt, "finished job is delivered");
  assert.equal(jobs.find((job) => job.id === "task-live").announcedAt, undefined, "running job is not marked");
  assert.ok(state.readJobFile(state.resolveJobFile(process.cwd(), "task-done")).announcedAt);
});
