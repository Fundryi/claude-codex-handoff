const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const libDir = path.join(__dirname, "..", "plugin", "scripts", "lib");
const href = (name) => pathToFileURL(path.join(libDir, name)).href;

const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cxc-cancel-test-"));
process.env.CODEX_COMPANION_STATE_ROOT = stateRoot;
process.env.CODEX_VIEWER_PORT = "1"; // notifyViewer must not reach a real viewer

const FAKE_CWD = "D:\\fake\\graceful-cancel-repo";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("createTurnCancelWatcher interrupts once when shouldCancel flips", async () => {
  const { createTurnCancelWatcher } = await import(href("codex.mjs"));
  let wanted = false;
  const calls = [];
  const watcher = createTurnCancelWatcher({
    shouldCancel: () => wanted,
    interrupt: (threadId, turnId) => { calls.push([threadId, turnId]); },
    intervalMs: 10
  });
  watcher.arm("t-1", "turn-1");
  await sleep(40);
  assert.equal(calls.length, 0);
  assert.equal(watcher.interrupted(), false);
  wanted = true;
  await sleep(40);
  assert.deepEqual(calls, [["t-1", "turn-1"]]);
  assert.equal(watcher.interrupted(), true);
  watcher.dispose();
});

test("createTurnCancelWatcher without shouldCancel is inert", async () => {
  const { createTurnCancelWatcher } = await import(href("codex.mjs"));
  const watcher = createTurnCancelWatcher({ interrupt: () => { throw new Error("must not run"); } });
  watcher.arm("t-1", "turn-1");
  watcher.dispose();
  assert.equal(watcher.interrupted(), false);
});

test("waitForJobSettled resolves when the worker marks the job terminal", async () => {
  const { waitForJobSettled } = await import(href("job-control.mjs"));
  const { writeJobFile } = await import(href("state.mjs"));
  writeJobFile(FAKE_CWD, "job-settle", { id: "job-settle", status: "running", pid: process.pid });
  setTimeout(() => {
    writeJobFile(FAKE_CWD, "job-settle", { id: "job-settle", status: "cancelled", pid: null });
  }, 120);
  const result = await waitForJobSettled(FAKE_CWD, "job-settle", { timeoutMs: 2000, pollMs: 25 });
  assert.deepEqual(result, { settled: true, status: "cancelled" });
});

test("waitForJobSettled bails out fast when the worker pid is dead", async () => {
  const { waitForJobSettled } = await import(href("job-control.mjs"));
  const { writeJobFile } = await import(href("state.mjs"));
  writeJobFile(FAKE_CWD, "job-dead", { id: "job-dead", status: "running", pid: 999999999 });
  const started = Date.now();
  const result = await waitForJobSettled(FAKE_CWD, "job-dead", { timeoutMs: 5000, pollMs: 25 });
  assert.equal(result.settled, false);
  assert.equal(result.pidDead, true);
  assert.ok(Date.now() - started < 1000, "dead pid must not burn the whole grace period");
});

test("runTrackedJob marks an interrupted run as cancelled, not failed", async () => {
  const { runTrackedJob } = await import(href("tracked-jobs.mjs"));
  const { readJobFile, resolveJobFile } = await import(href("state.mjs"));
  const job = { id: "job-int", workspaceRoot: FAKE_CWD, title: "Test task" };
  await runTrackedJob(job, async () => ({
    exitStatus: 1,
    interrupted: true,
    threadId: "t-1",
    turnId: "turn-1",
    payload: {},
    rendered: "",
    summary: "stopped"
  }));
  const stored = readJobFile(resolveJobFile(FAKE_CWD, "job-int"));
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.errorMessage, "Cancelled by user.");
  assert.equal(stored.diedReason, null);
});
