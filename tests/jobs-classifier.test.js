const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const slice = src.match(/const STUCK_AFTER_MS[\s\S]*?function classifyJobLiveness[\s\S]*?\n\}/)[0];

function ctx() {
  const c = {};
  vm.runInNewContext(slice, c);
  return c;
}

const NOW = 1_700_000_000_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

test("terminal statuses pass through", () => {
  const { classifyJobLiveness } = ctx();
  assert.equal(classifyJobLiveness({ status: "completed" }, false, NOW), "completed");
  assert.equal(classifyJobLiveness({ status: "failed" }, false, NOW), "failed");
  assert.equal(classifyJobLiveness({ status: "cancelled" }, false, NOW), "cancelled");
});

test("alive process with fresh heartbeat is working - even when quiet for a long task", () => {
  const { classifyJobLiveness } = ctx();
  assert.equal(classifyJobLiveness({ status: "running", heartbeatAt: iso(30_000) }, true, NOW), "working");
});

test("alive process with stale heartbeat is possibly-stuck, dead pid is dead", () => {
  const { classifyJobLiveness } = ctx();
  assert.equal(classifyJobLiveness({ status: "running", heartbeatAt: iso(20 * 60_000) }, true, NOW), "possibly-stuck");
  assert.equal(classifyJobLiveness({ status: "running", heartbeatAt: iso(30_000) }, false, NOW), "dead");
  assert.equal(classifyJobLiveness({ status: "queued", heartbeatAt: null }, false, NOW), "dead");
});
