const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const hookUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "stop-review-gate-hook.mjs")).href;
const stateUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")).href;

// `task --json` stops following after 100 s and returns a handback with no
// rawOutput. The gate used to block with "no final output" on every long review.
test("a handback is waited out; a direct answer is not", async () => {
  const { stopReviewRawOutput } = await import(hookUrl);
  const waited = [];
  const late = stopReviewRawOutput({ jobId: "task-s", waitTimedOut: true }, (id) => {
    waited.push(id);
    return { job: { status: "completed" }, storedJob: { result: { rawOutput: "ALLOW: ok" } } };
  });
  assert.deepEqual(waited, ["task-s"]);
  assert.equal(late.rawOutput, "ALLOW: ok");
  assert.equal(stopReviewRawOutput({ rawOutput: "BLOCK: x" }, () => assert.fail("must not wait")).rawOutput, "BLOCK: x");
  assert.equal(stopReviewRawOutput({ jobId: "t", waitTimedOut: true }, () => ({ jobId: "t", waitTimedOut: true })).timedOut, true);
  assert.equal(stopReviewRawOutput({ jobId: "t", waitTimedOut: true }, () => null).rawOutput, undefined);
});

test("the real result --wait output carries the review text where the gate reads it", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clv-stop-gate-"));
  process.env.CODEX_COMPANION_STATE_ROOT = stateRoot;
  const state = await import(`${stateUrl}?g=1`);
  const record = {
    id: "task-gate", title: "Codex Stop Gate Review", jobClass: "task", status: "completed",
    workspaceRoot: process.cwd(), pid: null, exitCode: 0,
    result: { rawOutput: "ALLOW: nothing to block" }, rendered: "ALLOW: nothing to block\n"
  };
  state.writeJobFile(process.cwd(), record.id, record);
  state.upsertJob(process.cwd(), record);
  const { waitForStopReviewJob } = await import(hookUrl);
  const waited = waitForStopReviewJob(process.cwd(), { ...process.env, CODEX_COMPANION_STATE_ROOT: stateRoot }, "task-gate", 10_000);
  assert.equal(waited.storedJob.result.rawOutput, "ALLOW: nothing to block");
  delete process.env.CODEX_COMPANION_STATE_ROOT;
});

// Claude Code kills the Stop hook at its hooks.json timeout. The gate's own budget
// must end first, or its "timed out" block never prints.
test("the gate's budget ends before the Stop hook timeout", () => {
  const pluginDir = path.join(__dirname, "..", "plugin");
  const hooks = JSON.parse(fs.readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8"));
  const stopTimeoutS = hooks.hooks.Stop[0].hooks[0].timeout;
  const src = fs.readFileSync(path.join(pluginDir, "scripts", "stop-review-gate-hook.mjs"), "utf8");
  const [, minutes] = src.match(/const STOP_REVIEW_TIMEOUT_MS = (\d+) \* 60 \* 1000;/);
  assert.ok(Number(minutes) * 60 < stopTimeoutS, `${minutes} min must be under ${stopTimeoutS} s`);
  assert.equal(src.match(/timed out after (\d+) minutes/g).every((text) => text.includes(`${minutes} minutes`)), true);
});
