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
