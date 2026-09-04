const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");

function serverContext() {
  const slice = [
    src.match(/function simplify\(line\) \{[\s\S]*?\n\}/)[0],
    src.match(/function promptTitle\(text\) \{[\s\S]*?\n\}/)[0],
    src.match(/function indexEntry\(file\) \{[\s\S]*?\n\}/)[0],
    src.match(/function ingest\(file\) \{[\s\S]*?\n\}/)[0],
  ].join("\n");
  const context = {
    fs, path, Buffer, Date, JSON, Map, String, Math,
    sessions: new Map(), searchIndex: new Map(),
    ARCHIVED_DIR: "Z:\\archived", MAX_EVENTS_KEPT: 500,
    broadcast() {}, broadcastNotification() {},
  };
  vm.runInNewContext(slice, context);
  return context;
}

function meta(payload) { return JSON.stringify({ timestamp: "2026-09-04T16:52:47Z", type: "session_meta", payload }); }

// A child agent's rollout repeats the parent's session_meta after its own. The
// last one used to win, so the child took the parent's thread id and became its
// own parent - which made the dashboard list recurse without end.
test("a child agent keeps its own thread id when the parent's session_meta follows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-child-"));
  const file = path.join(dir, "rollout-child.jsonl");
  fs.writeFileSync(file, [
    meta({ id: "child-1", session_id: "parent-1", parent_thread_id: "parent-1", agent_nickname: "Kierkegaard", cwd: "D:\\x" }),
    meta({ id: "parent-1", session_id: "parent-1", cwd: "D:\\x" }),
    "",
  ].join("\n"));
  const ctx = serverContext();
  ctx.ingest(file);
  const s = ctx.sessions.get(file);
  assert.equal(s.meta.threadId, "child-1");
  assert.equal(s.meta.parentThreadId, "parent-1");
  assert.equal(s.meta.agentNickname, "Kierkegaard");
  assert.equal(ctx.indexEntry(file).threadId, "child-1");
});
