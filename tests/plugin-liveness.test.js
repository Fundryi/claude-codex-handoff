const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const livenessUrl = pathToFileURL(
  path.join(__dirname, "..", "plugin", "scripts", "lib", "liveness.mjs")
).href;

const viewerSrc = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const viewerSlice = viewerSrc.match(
  /const STUCK_AFTER_MS[\s\S]*?function classifyJobLiveness[\s\S]*?\n\}/
)[0];

function viewerCtx() {
  const context = {};
  vm.runInNewContext(viewerSlice, context);
  return context;
}

const NOW = 1_700_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

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

test("viewer and lib classifiers agree on every case", async () => {
  const lib = await import(livenessUrl);
  const viewer = viewerCtx();
  const cases = [
    [{ status: "completed" }, false],
    [{ status: "failed" }, false],
    [{ status: "cancelled" }, true],
    [{ status: "running", heartbeatAt: iso(30_000) }, true],
    [{ status: "running", heartbeatAt: iso(20 * 60_000) }, true],
    [{ status: "running", heartbeatAt: iso(30_000) }, false],
    [{ status: "queued", heartbeatAt: null }, false],
    [{ status: "queued", heartbeatAt: iso(1_000) }, true]
  ];
  for (const [job, alive] of cases) {
    assert.equal(
      lib.classifyJobLiveness(job, alive, NOW),
      viewer.classifyJobLiveness(job, alive, NOW),
      `drift for ${JSON.stringify(job)} alive=${alive}`
    );
  }
});
