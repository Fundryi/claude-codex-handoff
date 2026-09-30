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

// Claude workflow parsers. Fixtures are trimmed real lines from ~/.claude/projects run files
// (Claude Code 2.1.284 and 2.1.210), with prompts, paths and signatures redacted.
function fn(name) { const c = {}; vm.runInNewContext(src.match(new RegExp("\\nfunction " + name + "\\([\\s\\S]*?\\n\\}"))[0], c); return c[name]; }

test("Claude journal: 2.1.284 and 2.1.210 lines, unknown types skipped, result text never kept", () => {
  const entry = fn("claudeJournalEntry");
  assert.deepEqual({ ...entry('{"type":"launched"}') }, { type: "launched" });
  assert.deepEqual({ ...entry('{"type":"started","key":"v2:9884beb5","agentId":"ad97a37493043d788","label":"plan","phase":"Plan"}') },
    { type: "started", agentId: "ad97a37493043d788", label: "plan", phase: "Plan" });
  // 2.1.210: no launched line, no label or phase
  assert.deepEqual({ ...entry('{"type":"started","key":"v2:e5a67619","agentId":"aea329c5cb28af87d"}') },
    { type: "started", agentId: "aea329c5cb28af87d", label: "", phase: "" });
  const big = entry(JSON.stringify({ type: "result", key: "v2:x", agentId: "ad97a37493043d788", result: "x".repeat(60 * 1024) }));
  assert.equal(big.type, "result");
  assert.equal("result" in big, false);
  assert.equal(JSON.stringify(big).length < 200, true);
  // 2.1.210 results are objects
  assert.equal("result" in entry('{"type":"result","agentId":"aea329c5cb28af87d","result":{"question":"redacted"}}'), false);
  assert.equal(entry('{"type":"failed","agentId":"a7beb7a64a116bddb"}').type, "failed");
  assert.equal(entry('{"type":"paused"}'), null);
  assert.equal(entry("not json {"), null);
  assert.equal(entry('{"type":"started"}'), null);
  assert.equal(entry('{"type":"started","agentId":42}'), null);
  assert.equal(entry("null"), null);
});

test("Claude script meta: name, description and phase titles read as text, never run", () => {
  const meta = fn("claudeScriptMeta");
  const live = [
    "export const meta = {",
    "  name: 'claude-workflow-view-2180',",
    "  description: 'v2.18.0: Claude workflow view (own Claude tab, stages 1+2) + broker stage two; plan, build, review, fix, live verify with screenshots',",
    "  phases: [",
    "    { title: 'Plan', detail: 'implementation plan from the approved scope' },",
    "    { title: 'Build', detail: 'server, then UI; broker stage two in parallel' },",
    "    { title: 'Review', detail: 'security, parser/CPU, UI distinction, broker' },",
    "    { title: 'Fix', detail: 'apply confirmed findings' },",
    "    { title: 'Verify', detail: 'tests, live data, screenshots, CPU' },",
    "  ],",
    "}",
    "throw new Error('a script body must never run');",
    "export default async function () { process.exit(1) }",
  ].join("\r\n");
  const m = meta(live);
  assert.equal(m.name, "claude-workflow-view-2180");
  assert.match(m.description, /^v2\.18\.0: Claude workflow view/);
  assert.deepEqual([...m.phases], ["Plan", "Build", "Review", "Fix", "Verify"]);
  const dq = meta('export const meta = {\n  name: "say-\\"hi\\"",\n  description: "it\'s fine",\n  phases: [{ title: "A" }],\n}\n');
  assert.equal(dq.name, 'say-"hi"');
  assert.equal(dq.description, "it's fine");
  assert.deepEqual([...dq.phases], ["A"]);
  const jq = meta('export const meta = {\n  "name": "deep-research",\n  \'description\': "d",\n  phases: [{"title":"Scope","detail":"x"},{"title":"Verify"}],\n}\n');
  assert.equal(jq.name, "deep-research");
  assert.equal(jq.description, "d");
  assert.deepEqual([...jq.phases], ["Scope", "Verify"]);
  const none = meta("export default async function () {}\n");
  assert.deepEqual({ name: none.name, description: none.description, phases: [...none.phases] }, { name: "", description: "", phases: [] });
  assert.deepEqual([...meta(null).phases], []);
});

test("Claude transcript lines become feed events", () => {
  const events = (o) => Array.from(fn("claudeTranscriptEvents")(typeof o === "string" ? o : JSON.stringify(o)), (e) => ({ ...e }));
  const base = { isSidechain: true, agentId: "a7beb7a64a116bddb", timestamp: "2026-09-30T17:42:08.361Z", cwd: "D:/redacted", sessionId: "354f362e" };
  const user = (content, extra = {}) => ({ ...base, type: "user", message: { role: "user", content }, ...extra });
  const usage = { input_tokens: 2, cache_creation_input_tokens: 59403, cache_read_input_tokens: 21837, output_tokens: 8 };
  const asst = (block) => ({ ...base, type: "assistant", message: { model: "claude-opus-5-5", role: "assistant", content: [block], usage } });

  assert.deepEqual(events(user("[Workflow harness — user request] redacted")), [{ kind: "user", ts: base.timestamp, text: "[Workflow harness — user request] redacted" }]);
  assert.equal(events(user("<system-reminder>\nredacted\n</system-reminder>"))[0].internal, true);
  assert.equal(events(user("plain", { isMeta: true }))[0].internal, true);
  assert.equal(events(user("<command-name>/x</command-name>"))[0].internal, true);

  const text = events(asst({ type: "text", text: "Clean scope. Making the edits." }));
  assert.deepEqual(text[0], { kind: "agent", ts: base.timestamp, text: "Clean scope. Making the edits." });
  // Usage rides every assistant line: context = input + cache creation + cache read.
  assert.deepEqual(text[1], { kind: "meta", ts: base.timestamp, tokens: 2 + 59403 + 21837 });

  assert.deepEqual(events(asst({ type: "thinking", thinking: "", signature: "redacted" })).map((e) => e.kind), ["meta"]);
  assert.equal(events(asst({ type: "thinking", thinking: "Check the gate first." }))[0].kind, "think");

  const bash = events(asst({ type: "tool_use", id: "toolu_01A", name: "Bash", input: { command: "npm test\necho done", description: "Run tests" } }))[0];
  assert.equal(bash.kind, "cmd");
  assert.equal(bash.callId, "toolu_01A");
  assert.equal(bash.text, "npm test\necho done");
  assert.equal(bash.preview, "Bash: npm test");
  const edit = events(asst({ type: "tool_use", id: "toolu_01B", name: "Edit", input: { file_path: "D:/x/a.js", old_string: "a", new_string: "b" } }))[0];
  assert.equal(edit.kind, "patch");
  assert.equal(edit.text, "D:/x/a.js");
  const grep = events(asst({ type: "tool_use", id: "toolu_01C", name: "Grep", input: { pattern: "broker-lifecycle|broker-endpoint", output_mode: "content" } }))[0];
  assert.equal(grep.kind, "tool");
  assert.match(grep.text, /^Grep \{"pattern":/);
  assert.equal(grep.preview, "Grep: broker-lifecycle|broker-endpoint");

  const out = events(user([{ tool_use_id: "toolu_01A", type: "tool_result", content: "AGENTS.md:26: redacted" }]))[0];
  assert.deepEqual(out, { kind: "out", ts: base.timestamp, resultOf: "toolu_01A", text: "AGENTS.md:26: redacted" });
  const arr = events(user([{ tool_use_id: "toolu_01C", type: "tool_result", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }], is_error: true }]))[0];
  assert.equal(arr.resultOf, "toolu_01C");
  assert.equal(arr.text, "error: one\ntwo");

  assert.deepEqual(events({ ...base, type: "attachment", attachment: { type: "hook_success", hookName: "SubagentStart" } }), []);
  assert.deepEqual(events("{broken"), []);
  assert.deepEqual(events("null"), []);
});
