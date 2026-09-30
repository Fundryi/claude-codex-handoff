const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const hookPath = path.join(__dirname, "..", "plugin", "scripts", "session-lifecycle-hook.mjs");
const stateUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")).href;

test("SessionEnd leaves running jobs and their workers alone", async () => {
  const { saveState, loadState } = await import(stateUrl);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-session-end-"));
  const stateRoot = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  process.env.CODEX_COMPANION_STATE_ROOT = stateRoot;

  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const sessionId = "session-under-test";
  try {
    saveState(workspace, {
      jobs: [{ id: "task-1", kind: "task", jobClass: "task", status: "running", pid: worker.pid, sessionId, updatedAt: new Date().toISOString() }]
    });

    const run = spawnSync(process.execPath, [hookPath, "SessionEnd"], {
      input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: workspace, reason: "other" }),
      env: { ...process.env, CODEX_COMPANION_STATE_ROOT: stateRoot },
      encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr);

    // spawnSync blocked the event loop, so let it run and watch for an exit. kill(pid, 0) is no
    // proof on POSIX (a killed, unreaped child is a zombie), and a kill by signal leaves exitCode null.
    const died = await Promise.race([once(worker, "exit").then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
    assert.equal(died, false, "worker was killed");
    const jobs = loadState(workspace).jobs;
    assert.equal(jobs.length, 1, "job record was deleted");
    assert.equal(jobs[0].status, "running", "job status was changed");
    assert.equal(jobs[0].pid, worker.pid, "job pid was changed");
  } finally {
    worker.kill();
    delete process.env.CODEX_COMPANION_STATE_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
