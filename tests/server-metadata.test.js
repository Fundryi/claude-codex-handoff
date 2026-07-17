const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const simplifySrc = src.match(/function simplify\(line\) \{[\s\S]*?\n\}/)[0];

function ctx() {
  const c = {};
  vm.runInNewContext(simplifySrc, c);
  return c;
}

test("turn_context carries model, effort and sandbox", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-17T10:00:00Z",
    type: "turn_context",
    payload: { cwd: "D:\\GIT\\x", model: "gpt-5.3-codex", effort: "xhigh", sandbox_policy: { mode: "danger-full-access" } },
  });
  const ev = ctx().simplify(line);
  assert.equal(ev.kind, "meta");
  assert.equal(ev.model, "gpt-5.3-codex");
  assert.equal(ev.effort, "xhigh");
  assert.equal(ev.sandbox, "danger-full-access");
});

test("turn_context tolerates string sandbox_policy and missing fields", () => {
  const ev = ctx().simplify(JSON.stringify({ type: "turn_context", payload: { sandbox_policy: "read-only" } }));
  assert.equal(ev.sandbox, "read-only");
  const ev2 = ctx().simplify(JSON.stringify({ type: "turn_context", payload: {} }));
  assert.equal(ev2.effort, "");
  assert.equal(ev2.sandbox, "");
});

test("token_count events surface running token totals", () => {
  const ev = ctx().simplify(JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { total_tokens: 48211 } } },
  }));
  assert.equal(ev.kind, "meta");
  assert.equal(ev.tokens, 48211);
  // tolerate the flat shape too
  const ev2 = ctx().simplify(JSON.stringify({ type: "event_msg", payload: { type: "token_count", total_tokens: 7 } }));
  assert.equal(ev2.tokens, 7);
});
