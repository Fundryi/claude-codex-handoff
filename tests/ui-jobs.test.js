const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const slice = script.match(/function jobStatusLabel[\s\S]*?function jobDetailLine[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }

test("jobStatusLabel maps liveness to one title-case status vocabulary", () => {
  const { jobStatusLabel } = ctx();
  assert.equal(jobStatusLabel({ live: "working" }), "Running");
  assert.equal(jobStatusLabel({ live: "possibly-stuck" }), "Needs attention");
  assert.equal(jobStatusLabel({ live: "dead" }), "Needs attention");
  assert.equal(jobStatusLabel({ live: "failed" }), "Needs attention");
  assert.equal(jobStatusLabel({ live: "completed" }), "Finished");
  assert.equal(jobStatusLabel({ live: "completed", needsDecision: "Keep the API?" }), "Needs answer");
  assert.equal(jobStatusLabel({ live: "cancelled" }), "Stopped");
  assert.equal(jobStatusLabel({ live: "queued", status: "queued" }), "Running");
});

test("jobDetailLine includes phase, heartbeat age, effort/model and died reason", () => {
  const { jobDetailLine } = ctx();
  const now = 1_700_000_000_000;
  const line = jobDetailLine({
    phase: "running", heartbeatAt: new Date(now - 65_000).toISOString(),
    model: "gpt-5.3-codex", effort: "xhigh", sandbox: "danger-full-access", diedReason: null,
  }, now);
  assert.ok(line.includes("running"));
  assert.ok(line.includes("1m 5s"));
  assert.ok(line.includes("xhigh"));
  const dead = jobDetailLine({ phase: "failed", heartbeatAt: null, diedReason: "Codex auth expired - run `codex login`." }, now);
  assert.ok(dead.includes("Codex auth expired"));
});

test("jobDetailLine no longer includes fast text (chip renders it)", () => {
  const { jobDetailLine } = ctx();
  assert.ok(!jobDetailLine({ phase: "running", fast: true }, Date.now()).includes("fast"));
});
