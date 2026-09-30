const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const livenessUrl = pathToFileURL(
  path.join(__dirname, "..", "plugin", "scripts", "lib", "liveness.mjs")
).href;

test("jobLooksDead fires only for active jobs whose pid is gone", async () => {
  const { jobLooksDead } = await import(livenessUrl);
  assert.equal(jobLooksDead({ status: "running", pid: 1 }, false), true);
  assert.equal(jobLooksDead({ status: "queued", pid: null }, false), true);
  assert.equal(jobLooksDead({ status: "running", pid: 1 }, true), false);
  assert.equal(jobLooksDead({ status: "completed" }, false), false);
  assert.equal(jobLooksDead({ status: "failed" }, false), false);
  assert.equal(jobLooksDead({ status: "cancelled" }, false), false);
});

test("a stale heartbeat with a live pid is NOT dead - long thinking phases emit nothing", async () => {
  const { jobLooksDead } = await import(livenessUrl);
  const ancient = { status: "running", pid: 1, heartbeatAt: new Date(0).toISOString() };
  assert.equal(jobLooksDead(ancient, true), false);
});
