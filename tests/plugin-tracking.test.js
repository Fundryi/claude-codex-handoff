const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const mjs = (rel) => pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", rel)).href;

test("mapDeathReason recognizes known failure signatures", async () => {
  const { mapDeathReason } = await import(mjs("death-reasons.mjs"));
  assert.match(mapDeathReason("windows sandbox: runner failed during SpawnChild: CreateProcessAsUserW failed: 1312"), /sandbox/i);
  assert.match(mapDeathReason("CreateProcessWithLogonW failed: 2"), /sandbox/i);
  assert.match(mapDeathReason("HTTP 401 unauthorized"), /login/i);
  assert.match(mapDeathReason("429 Too Many Requests: rate limit"), /rate/i);
  assert.match(mapDeathReason("spawn codex ENOENT"), /not found/i);
  assert.equal(mapDeathReason("some novel explosion"), null);
  assert.equal(mapDeathReason(null), null);
});

test("progress updater writes a throttled heartbeat", async () => {
  const os = require("node:os");
  const fs = require("node:fs");
  process.env.CODEX_COMPANION_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clv-hb-"));
  const { createJobProgressUpdater } = await import(mjs("tracked-jobs.mjs"));
  const { upsertJob, listJobs } = await import(mjs("state.mjs"));
  const ws = process.cwd();
  upsertJob(ws, { id: "job-hb-1", status: "running" });
  const update = createJobProgressUpdater(ws, "job-hb-1");
  update({ message: "working", phase: "running" });
  const job = listJobs(ws).find((j) => j.id === "job-hb-1");
  assert.ok(job.heartbeatAt, "heartbeatAt should be set");
  assert.ok(Date.now() - Date.parse(job.heartbeatAt) < 5000);
  delete process.env.CODEX_COMPANION_STATE_ROOT;
});
