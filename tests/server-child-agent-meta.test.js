const assert = require("node:assert/strict");
const fs = require("node:fs");
const { serverSource } = require("./helpers/source");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = serverSource();

function serverContext() {
  const slice = [
    src.match(/function simplify\(line\) \{[\s\S]*?\n\}/)[0],
    src.match(/function promptTitle\(text\) \{[\s\S]*?\n\}/)[0],
    src.match(/function indexEntry\(file, st\) \{[\s\S]*?\n\}/)[0],
    src.match(/function ingest\(file\) \{[\s\S]*?\n\}/)[0],
    src.match(/function sessionSummary[\s\S]*?\n\}/)[0],
  ].join("\n");
  const context = {
    fs, path, Buffer, Date, JSON, Map, String, Math,
    sessions: new Map(), searchIndex: new Map(),
    ARCHIVED_DIR: "Z:\\archived", MAX_EVENTS_KEPT: 500, LIVE_WINDOW_MS: 20000,
    broadcast() {},
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

// The UI tells Claude's handoff prompts from the human's by the session's originator.
// Like the thread id, the session's own session_meta wins over a repeated parent one.
test("the session summary exposes the rollout's own originator", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-origin-"));
  const handoff = path.join(dir, "rollout-handoff.jsonl");
  const bare = path.join(dir, "rollout-bare.jsonl");
  fs.writeFileSync(handoff, [
    meta({ id: "child-2", parent_thread_id: "parent-2", cwd: "/repo", originator: "Claude Code" }),
    meta({ id: "parent-2", cwd: "/repo", originator: "codex_cli_rs" }),
    "",
  ].join("\n"));
  fs.writeFileSync(bare, meta({ id: "old-1", cwd: "/repo" }) + "\n");
  const ctx = serverContext();
  ctx.ingest(handoff);
  ctx.ingest(bare);
  assert.equal(ctx.sessionSummary(ctx.sessions.get(handoff)).originator, "Claude Code");
  assert.equal(ctx.sessionSummary(ctx.sessions.get(bare)).originator, "");
});

// A 0.159 child rollout opens with the parent's session_meta and history, including
// the parent's prompt (no inherited_user_message flag on it). That prompt was the child's title.
test("a child agent is titled by its agent name, not the parent's inherited prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-child-title-"));
  const file = path.join(dir, "rollout-child-title.jsonl");
  const prompt = JSON.stringify({ timestamp: "2026-09-30T12:30:43Z", ordinal: 9, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Follow handoff/review.md (binding). Task: the parent's job" }] } });
  fs.writeFileSync(file, [
    meta({ id: "child-3", parent_thread_id: "parent-3", agent_nickname: "Avicenna", agent_path: "/root/docs_inventory", cwd: "/repo", subagent_history_start_ordinal: 27 }),
    meta({ id: "parent-3", cwd: "/repo" }),
    prompt,
    "",
  ].join("\n"));
  const ctx = serverContext();
  ctx.ingest(file);
  assert.equal(ctx.sessions.get(file).meta.title, "Agent Avicenna \u00b7 /root/docs_inventory");
  assert.equal(ctx.indexEntry(file).title, "Agent Avicenna \u00b7 /root/docs_inventory");
  // A root session still takes its title from its prompt.
  const rootFile = path.join(dir, "rollout-root.jsonl");
  fs.writeFileSync(rootFile, [meta({ id: "parent-3", cwd: "/repo" }), prompt, ""].join("\n"));
  ctx.ingest(rootFile);
  assert.equal(ctx.sessions.get(rootFile).meta.title, "the parent's job");
});

// A Guardian (approval review) is a child with no agent name or path.
test("a Guardian child session is titled Guardian review", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-guardian-"));
  const file = path.join(dir, "rollout-guardian.jsonl");
  fs.writeFileSync(file, meta({ id: "g-1", parent_thread_id: "parent-4", cwd: "/repo", source: { subagent: { other: "guardian" } } }) + "\n");
  const ctx = serverContext();
  ctx.ingest(file);
  assert.equal(ctx.sessions.get(file).meta.title, "Guardian review");
  assert.equal(ctx.indexEntry(file).title, "Guardian review");
});

// 0.124-0.155 log a direct MCP call twice: response_item function_call and item_completed
// McpToolCall, with the same id. Shapes trimmed from a real 0.145 rollout.
test("an MCP call logged as function_call and McpToolCall shows once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-mcp-pair-"));
  const file = path.join(dir, "rollout-mcp-pair.jsonl");
  const args = { query: "Docker container saves" };
  fs.writeFileSync(file, [
    meta({ id: "t-mcp", cwd: "/repo" }),
    JSON.stringify({ timestamp: "2026-04-29T13:33:10Z", type: "response_item", payload: { type: "function_call", name: "search", arguments: JSON.stringify(args), call_id: "call_abc" } }),
    JSON.stringify({ timestamp: "2026-04-29T13:33:11Z", type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "call_abc", server: "mcp_router", tool: "search", arguments: args, status: "completed" } } }),
    JSON.stringify({ timestamp: "2026-04-29T13:33:12Z", type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", id: "exec-1", server: "mcp_router", tool: "search", arguments: args, status: "completed" } } }),
    "",
  ].join("\n"));
  const ctx = serverContext();
  ctx.ingest(file);
  assert.deepEqual(Array.from(ctx.sessions.get(file).events, e => e.text), [
    'search {"query":"Docker container saves"}',
    'mcp_router.search {"query":"Docker container saves"}',
  ]);
});

// Codex 0.146+ pins a rollout's mtime at creation on Windows while it keeps growing.
test("lastGrow follows the newest record time, not the file mtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-lastgrow-"));
  const file = path.join(dir, "rollout-grow.jsonl");
  fs.writeFileSync(file, [
    meta({ id: "t-1", cwd: "/repo" }),
    JSON.stringify({ timestamp: "2026-09-04T17:10:00.500Z", type: "event_msg", payload: { type: "token_count", info: null } }),
    "",
  ].join("\n"));
  const created = new Date("2026-09-04T16:52:47Z");
  fs.utimesSync(file, created, created);
  const ctx = serverContext();
  ctx.ingest(file);
  assert.equal(ctx.sessions.get(file).lastGrow, Date.parse("2026-09-04T17:10:00.500Z"));
});

// On Codex 0.155+ the first real prompt sits 220-400 KB in, behind injected context.
test("the search index finds a title past the first 64 KB, across a chunk boundary", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-index-deep-"));
  const file = path.join(dir, "rollout-deep.jsonl");
  const user = (text) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  const head = meta({ id: "t-deep", cwd: "/repo" }) + "\n" +
    user("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\n" + "x".repeat(200 * 1024)) + "\n";
  // Pad so the 256 KB chunk edge falls inside the first two-byte "é" of the prompt.
  const prefix = Buffer.byteLength(user("")) - Buffer.byteLength('"}]}}');
  const promptStart = 4 * 64 * 1024 - prefix - "Prompt ".length - 1;
  const padLine = (k) => user("<environment_context>" + "y".repeat(k) + "</environment_context>") + "\n";
  const pad = padLine(promptStart - Buffer.byteLength(head) - Buffer.byteLength(padLine(0)));
  fs.writeFileSync(file, head + pad + user("Prompt " + "é".repeat(300)) + "\n");
  assert.equal(Buffer.byteLength(head + pad), promptStart);
  const entry = serverContext().indexEntry(file);
  assert.equal(entry.threadId, "t-deep");
  assert.equal(entry.title, "Prompt " + "é".repeat(93));
});
