const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "codex-live-viewer.js"), "utf8");
const simplifySrc = src.match(/function simplify\(line\) \{[\s\S]*?\n\}/)[0];

function ctx() {
  const c = {};
  vm.runInNewContext(simplifySrc, c);
  return c;
}

function item(role, text) {
  return JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
}

// Codex 0.153 writes the user's prompt only as a response_item with role user.
// The event_msg user_message form is gone, so dropping user-role items lost
// every title and every prompt in the feed.
test("user-role response_items become user events", () => {
  const ev = ctx().simplify(item("user", "Fix the flaky test\nDetails follow"));
  assert.equal(ev.kind, "user");
  assert.equal(ev.internal, undefined);
  assert.match(ev.text, /Fix the flaky test/);
});

test("injected context blocks are user events marked internal", () => {
  const ev = ctx().simplify(item("user", "<recommended_plugins>\nHere is a list"));
  assert.equal(ev.kind, "user");
  assert.equal(ev.internal, true);
});

// Hook output and system blocks arrive as role developer. They are not Codex
// speech and must not render as CODEX in the feed.
test("developer-role response_items are internal agent events", () => {
  const ev = ctx().simplify(item("developer", "PONYTAIL MODE ACTIVE"));
  assert.equal(ev.kind, "agent");
  assert.equal(ev.internal, true);
  assert.equal(ctx().simplify(item("assistant", "Done.")).internal, undefined);
});

test("session_meta carries the parent thread and agent nickname of a child agent", () => {
  const ev = ctx().simplify(JSON.stringify({
    type: "session_meta",
    payload: { id: "child-1", cwd: "D:\\x", parent_thread_id: "parent-1", agent_nickname: "Kierkegaard", thread_source: "subagent" },
  }));
  assert.equal(ev.kind, "meta");
  assert.equal(ev.parentThreadId, "parent-1");
  assert.equal(ev.agentNickname, "Kierkegaard");
  const plain = ctx().simplify(JSON.stringify({ type: "session_meta", payload: { id: "root", cwd: "D:\\x" } }));
  assert.equal(plain.parentThreadId, "");
  assert.equal(plain.agentNickname, "");
});

test("promptTitle skips routing lines and prefers the text after Task:", () => {
  const c = {};
  vm.runInNewContext(src.match(/function promptTitle\(text\) \{[\s\S]*?\n\}/)[0], c);
  assert.equal(c.promptTitle("Dispatch flags: --model sol\n\nBinding contract: D:\\x\\coding.md\n\nFollow coding.md (binding). Task: add retry to the uploader"), "add retry to the uploader");
  assert.equal(c.promptTitle("<task>\nRename the config key\n</task>"), "Rename the config key");
  assert.equal(c.promptTitle("What model are you?"), "What model are you?");
  assert.equal(c.promptTitle(""), "");
});

test("APP_VERSION matches package.json", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(src, new RegExp(`const APP_VERSION = "${pkg.version.replace(/\\./g, "\\\\.")}"`));
});
