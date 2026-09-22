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
