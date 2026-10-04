const assert = require("node:assert/strict");
const { serverSource } = require("./helpers/source");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = serverSource();
const simplifySrc = src.match(/function simplify\(line\) \{[\s\S]*?\n\}/)[0];

const plain = value => JSON.parse(JSON.stringify(value));

test("deep tool input cannot discard the following transcript event", () => {
  const args = '{"command":"echo ok","extra":' + '{"a":'.repeat(8000) + '0' + '}'.repeat(8000) + '}';
  const bad = JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: args } });
  const good = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Finished" } });
  const data = Buffer.from(bad + "\n" + good + "\n");
  const c = { Buffer, Date, Map, Set, MAX_EVENTS_KEPT: 100, sessions: new Map(), path, broadcast() {},
    fs: { statSync: () => ({ size: data.length, mtimeMs: 1 }), openSync: () => 1,
      readSync: (_, buf, off, len, pos) => data.copy(buf, off, pos, pos + len), closeSync() {} } };
  for (const name of ["simplify", "promptTitle", "ingest"]) {
    vm.runInNewContext(src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}"))[0], c);
  }
  assert.doesNotThrow(() => c.ingest("fixture.jsonl"));
  assert.deepEqual(plain(c.sessions.get("fixture.jsonl").events.map(e => e.text)), ["echo ok", "Finished"]);
  const adapters = adapterContext();
  const claude = adapters.claudeTranscriptEvents('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":' + args + '}]}}')[0];
  const opencode = adapters.opencodeTranscriptEvents({ type: "assistant", data: { content: [
    { type: "tool", name: "bash", state: { input: JSON.parse(args) } }] } })[0];
  for (const event of [c.sessions.get("fixture.jsonl").events[0], claude, opencode]) {
    assert.equal(event.tool.input.command, "echo ok");
    assert.ok(JSON.stringify(event.tool.input).length <= 20000);
    let depth = 0, value = event.tool.input.extra;
    while (value && value.a) { depth++; value = value.a; }
    assert.ok(depth <= 64);
  }
});

test("diff counts include header-looking additions and deletions inside hunks", () => {
  const diff = '@@ -1 +1 @@\n---counter;\n+++counter;';
  const codex = ctx().simplify(JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'FileChange', changes: { 'a.js': { type: 'update', unified_diff: diff } } } } }));
  const opencode = adapterContext().opencodeTranscriptEvents({ type: 'assistant', data: { content: [{ type: 'tool', name: 'edit',
    state: { input: { filePath: 'a.js' }, metadata: { patch: '--- a/a.js\n+++ b/a.js\n' + diff } } }] } })[0];
  for (const event of [codex, opencode]) {
    assert.deepEqual(plain(event.files), [{ path: 'a.js', op: 'update', added: 1, removed: 1 }]);
    assert.match(event.diff, /---counter;\n\+\+\+counter;/);
  }
});
function adapterContext() {
  const c = { fs: require("node:fs"), Buffer };
  const mediaFile = path.join(__dirname, "../server/media.js");
  if (c.fs.existsSync(mediaFile)) Object.assign(c, require(mediaFile));
  for (const name of ["feedToolFields", "feedBlock", "lineDiffResult", "lineDiff", "claudeTranscriptEvents", "claudeTranscriptPage", "opencodeTranscriptEvents"]) {
    const match = src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}"));
    if (match) vm.runInNewContext(match[0], c);
  }
  return c;
}

test("Claude Edit becomes a patch with a unified diff and file counts", () => {
  const ev = adapterContext().claudeTranscriptEvents(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "D:/x/a.js", old_string: "let a = 1;\n", new_string: "let a = 2;\n" } }] } }))[0];
  assert.match(ev.diff, /^--- a\/D:\/x\/a\.js\n\+\+\+ b\/D:\/x\/a\.js\n@@ -1 \+1 @@\n-let a = 1;\n\+let a = 2;/);
  assert.deepEqual(plain(ev.files), [{ path: "D:/x/a.js", op: "update", added: 1, removed: 1 }]);
});

test("Claude tools carry parsed capped input and targets while Bash keeps its command", () => {
  const c = adapterContext();
  const events = c.claudeTranscriptEvents(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "foo", path: "D:/x" } },
    { type: "tool_use", id: "t3", name: "Bash", input: { command: "npm test\necho done" } },
    { type: "tool_use", name: "Agent", input: { name: "scout", prompt: "x".repeat(2000000) } }] } }));
  assert.deepEqual(plain(events[0].tool), { name: "Grep", target: "foo", input: { pattern: "foo", path: "D:/x" } });
  assert.equal(events[1].text, "npm test\necho done");
  assert.equal(events[1].callId, "t3");
  assert.equal(events[2].tool.target, "scout");
  assert.ok(JSON.stringify(events[2].tool.input).length <= 20000);
  assert.ok(events[2].truncated.total > events[2].truncated.shown);
});

test("Claude results register images and explain truncation without sending base64", () => {
  const events = adapterContext().claudeTranscriptEvents(JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] },
    { type: "tool_result", tool_use_id: "t2", content: "x".repeat(5000) }] } }), { file: "F", offset: 0 });
  assert.equal(events[0].media[0].mime, "image/png");
  assert.match(events[0].media[0].ref, /^[0-9a-f]{24}$/);
  assert.ok(!JSON.stringify(events).includes("iVBOR"));
  assert.deepEqual(plain(events[1].truncated), { shown: events[1].text.length, total: 5000 });
});

test("injected Claude and Codex blocks are typed and handoff sections stay speech", () => {
  const c = adapterContext();
  const event = text => c.claudeTranscriptEvents(JSON.stringify({ type: "user", message: { content: text } }))[0];
  const note = event("<task-notification>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>");
  assert.equal(note.block.type, "task-notification");
  assert.equal(note.block.title, "Done");
  for (const [body, type] of [["[Workflow harness] scout", "harness"], ["# AGENTS.md instructions\nx", "agents-md"], ["<system-reminder>x</system-reminder>", "system-reminder"], ["<context_window_protection>x</context_window_protection>", "context"]]) {
    assert.equal(event(body).block.type, type);
    assert.equal(event(body).block.chars, body.length);
  }
  assert.equal(event("<goal>Do work</goal>").block, undefined);
  const codex = ctx().simplify(JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ text: "Rules" }] } }));
  assert.deepEqual(plain(codex.block), { type: "developer", title: "Developer", chars: 5 });
});

test("lineDiff uses three context lines, correct hunk ranges and bounded output", () => {
  const c = adapterContext();
  const old = Array.from({ length: 20 }, (_, i) => "line" + i).join("\n");
  const diff = c.lineDiff(old, old.replace("line8", "changed"), "a.js");
  assert.match(diff, /@@ -6,7 \+6,7 @@\n line5\n line6\n line7\n-line8\n\+changed\n line9\n line10\n line11/);
  assert.equal(c.lineDiff("same", "same", "a.js"), "");
  assert.match(c.lineDiff("", "a\nb\n", "a.js"), /@@ -0,0 \+1,2 @@\n\+a\n\+b/);
  const result = c.lineDiffResult("", "x\n".repeat(50000), "a.js");
  assert.ok(result.diff.split("\n").length <= 2000);
  assert.equal(result.added, 50000);
  assert.ok(result.truncated.total > result.truncated.shown);
});

test("Claude Write and MultiEdit expose all-added and per-edit changes", () => {
  const events = adapterContext().claudeTranscriptEvents(JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", name: "Write", input: { file_path: "a.js", content: "a\nb\n" } },
    { type: "tool_use", name: "MultiEdit", input: { file_path: "a.js", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] } }] } }));
  assert.deepEqual(plain(events[0].files), [{ path: "a.js", op: "add", added: 2, removed: 0 }]);
  assert.match(events[1].diff, /-a\n\+b/);
  assert.match(events[1].diff, /-c\n\+d/);
  assert.equal(events[1].files[0].removed, 2);
});

test("OpenCode tools expose targets, diffs, exit and capped inputs", () => {
  const events = adapterContext().opencodeTranscriptEvents({ type: "assistant", data: { content: [
    { type: "tool", name: "read", state: { input: { filePath: "a.js" } } },
    { type: "tool", name: "edit", state: { input: { filePath: "a.js", oldString: "a", newString: "b" } } },
    { type: "tool", name: "bash", state: { input: { command: "false\necho done" }, metadata: { exit: 1 }, output: "failed" } },
    { type: "tool", name: "agent", state: { input: { name: "scout", prompt: "x".repeat(2000000) } } }] } });
  assert.equal(events[0].tool.target, "a.js");
  assert.equal(events[1].kind, "patch");
  assert.match(events[1].diff, /-a\n\+b/);
  assert.equal(events[2].kind, "cmd");
  assert.equal(events[2].exit, 1);
  assert.equal(events[2].text, "false\necho done");
  assert.ok(JSON.stringify(events[3].tool.input).length <= 20000);
  assert.ok(events[3].truncated.total > events[3].truncated.shown);
});

test("capped tool inputs retain nested object and array types on every adapter", () => {
  const input = { queries: [{ pattern: 'foo', context: 'x'.repeat(2000000) }], later: 1 };
  const c = adapterContext();
  const claude = c.claudeTranscriptEvents(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Search', input }] } }))[0];
  const codex = ctx().simplify(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'search', arguments: JSON.stringify(input) } }));
  const opencode = c.opencodeTranscriptEvents({ type: 'assistant', data: { content: [{ type: 'tool', name: 'search', state: { input } }] } })[0];
  for (const ev of [claude, codex, opencode]) {
    assert.ok(Array.isArray(ev.tool.input.queries));
    assert.equal(ev.tool.input.queries[0].pattern, 'foo');
    assert.equal(typeof ev.tool.input.queries[0].context, 'string');
    assert.ok(JSON.stringify(ev.tool.input).length <= 20000);
    assert.ok(ev.truncated.total > ev.truncated.shown);
  }
});

test("OpenCode edits accept metadata before/after and supplied patch shapes", () => {
  const ev = adapterContext().opencodeTranscriptEvents({ type: 'assistant', data: { content: [{ type: 'tool', name: 'edit',
    state: { input: { filePath: 'a.js' }, metadata: { diff: { before: 'a\n', after: 'b\n', file: 'a.js' } } } }] } })[0];
  assert.match(ev.diff, /-a\n\+b/);
});

test("adapter preview cuts carry character counts even below the tool input and diff caps", () => {
  const c = adapterContext();
  const claude = c.claudeTranscriptEvents(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Search', input: { query: 'x'.repeat(1000) } }] } }))[0];
  const codex = ctx().simplify(JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'search', arguments: JSON.stringify({ query: 'x'.repeat(1000) }) } }));
  for (const ev of [claude, codex]) {
    assert.ok(ev.truncated);
    assert.equal(ev.truncated.shown, ev.text.length);
    assert.ok(ev.truncated.total > ev.text.length);
  }
  const patch = ctx().simplify(JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'FileChange', changes: { 'a.js': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+' + 'x'.repeat(5000) } } } } }));
  assert.equal(patch.truncated.shown, patch.detail.length);
  assert.ok(patch.truncated.total > patch.detail.length);
});

test("Codex patch previews keep file basenames before the preview length limit", () => {
  const c = { path, Date, LIVE_WINDOW_MS: 20000, ARCHIVED_DIR: "Z:\\archived" };
  vm.runInNewContext(src.match(/function sessionSummary[\s\S]*?\n\}/)[0], c);
  const session = { id: "s", file: "C:\\sessions\\rollout.jsonl", lastGrow: Date.now(), meta: {},
    events: [{ kind: "patch", text: "C:\\" + "long-directory\\".repeat(20) + "app.js, /repo/docs/UI-THEME.md" }] };
  assert.equal(c.sessionSummary(session).lastText, "app.js, UI-THEME.md");
});

test("OpenCode running step uses only the newest tool and a short safe input summary", () => {
  const c = { path, STUCK_AFTER_MS: 300000 };
  for (const name of ["opencodeStep", "opencodeSessionView"]) vm.runInNewContext(src.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n\\}"))[0], c);
  const content = JSON.stringify([null, { type: "tool", name: "shell", state: { input: { command: "old" } } },
    { type: "tool", name: "read", state: { input: { filePath: "D:\\repo\\app.js" }, output: "private output" } }, { type: "text", text: "ignore" }]);
  assert.equal(c.opencodeStep(content), "read: app.js");
  assert.equal(c.opencodeStep(JSON.stringify([{ type: "tool", tool: "bash", state: { input: { command: "npm test\noutput" } } }])), "bash: npm test");
  for (const malformed of ["broken", "{}", "null", "[]", '[{"type":"tool","name":9}]']) assert.equal(c.opencodeStep(malformed), "working");
  assert.ok(c.opencodeStep(JSON.stringify([{ type: "tool", name: "shell", state: { input: { command: "x".repeat(1000) } } }])).length <= 160);
  const now = Date.now();
  const row = { id: "s", time_updated: now, assistant_content: content };
  assert.equal(c.opencodeSessionView(row, now).step, "read: app.js");
  assert.equal(c.opencodeSessionView({ ...row, newest_type: "idle" }, now).step, undefined);
  assert.equal(c.opencodeSessionView(row, now + 300001).step, undefined);
});

test("OpenCode rows preserve messages, tool output and finish while ignoring unknown data", () => {
  const parser = src.match(/function opencodeTranscriptEvents\(row\) \{[\s\S]*?\n\}/);
  assert.ok(parser, "OpenCode row parser exists");
  const c = adapterContext();
  vm.runInNewContext(parser[0], c);
  const row = (type, data) => ({ type, seq: 3, time_created: 1700000000000, data: JSON.stringify(data) });
  const events = c.opencodeTranscriptEvents;
  assert.equal(events(row("user", { text: "Check it" }))[0].text, "Check it");
  const assistant = events(row("assistant", {
    model: { providerID: "local", id: "model", variant: "high" }, cost: 0.02,
    tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 6, write: 1 } },
    content: [null, { type: "text", text: "Done" }, { type: "reasoning", text: "Check first" },
      { type: "tool", id: "call1", name: "shell", state: { status: "completed", input: { command: "echo OK" }, content: [{ type: "text", text: "OK" }], metadata: { exit: 0 } } },
      { type: "tool", id: "call2", name: "subagent", state: { status: "completed", input: { prompt: "Check" }, output: "Child done", metadata: { sessionID: "ses_child" } } },
      { type: "future", secret: "skip" }]
  }));
  assert.equal(Array.from(assistant, e => e.kind).join(","), "agent,think,cmd,tool,meta");
  assert.equal(assistant[2].text, "echo OK");
  assert.equal(assistant[2].detail, "OK");
  assert.equal(assistant[2].callId, "call1");
  assert.equal(assistant[2].done, true);
  assert.equal(assistant[3].sessionId, "ses_child");
  assert.equal(assistant[3].detail, "Child done");
  assert.equal(assistant[4].model, "local/model");
  assert.equal(assistant[4].effort, "high");
  assert.equal(assistant[4].tokens, 17);
  assert.equal(assistant[4].cost, 0.02);
  assert.equal(events(row("idle", { outcome: "succeeded" }))[0].kind, "done");
  assert.equal(events(row("idle", { outcome: "failed" }))[0].text, "failed");
  assert.equal(events(row("assistant", { error: { name: "APIError", data: { message: "Bad request" } } }))[0].text, "Bad request");
  assert.equal(events(row("system", { text: "Context" }))[0].internal, true);
  for (const r of [row("unknown", { text: "skip" }), row("assistant", { content: {} }), { type: "user", data: "broken" }, null]) {
    assert.doesNotThrow(() => events(r));
  }
  assert.equal(events(row("unknown", { text: "skip" })).length, 0);
});

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
  // Codex 0.159.2: context now and the window. rate_limits are not read here (one bucket per
  // event, a Spark run would show its 0 %); the plan limits come from the live read.
  const ev3 = ctx().simplify(JSON.stringify({ timestamp: "2026-10-01T10:00:00.000Z", type: "event_msg", payload: { type: "token_count",
    info: { total_token_usage: { total_tokens: 42326 }, last_token_usage: { input_tokens: 42299, output_tokens: 27, total_tokens: 42326 }, model_context_window: 828400 },
    rate_limits: { limit_id: "codex", primary: { used_percent: 47, window_minutes: 10080, resets_at: 1791046707 }, secondary: null, plan_type: "pro" } } }));
  assert.equal(ev3.contextTokens, 42326);
  assert.equal(ev3.contextWindow, 828400);
  assert.equal(ev3.plan, undefined);
  const spark = ctx().simplify(JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null,
    rate_limits: { limit_id: "codex_bengalfox", primary: { used_percent: 0, window_minutes: 300, resets_at: 1791046707 } } } }));
  assert.equal(spark, null);
});

// Claude workflow parsers. Fixtures are trimmed real lines from ~/.claude/projects run files
// (Claude Code 2.1.284 and 2.1.210), with prompts, paths and signatures redacted.
function fn(name) { const c = adapterContext(); vm.runInNewContext(src.match(new RegExp("\\nfunction " + name + "\\([\\s\\S]*?\\n\\}"))[0], c); return c[name]; }

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
  const events = (o) => plain(fn("claudeTranscriptEvents")(typeof o === "string" ? o : JSON.stringify(o)));
  const base = { isSidechain: true, agentId: "a7beb7a64a116bddb", timestamp: "2026-09-30T17:42:08.361Z", cwd: "D:/redacted", sessionId: "354f362e" };
  const user = (content, extra = {}) => ({ ...base, type: "user", message: { role: "user", content }, ...extra });
  const usage = { input_tokens: 2, cache_creation_input_tokens: 59403, cache_read_input_tokens: 21837, output_tokens: 8 };
  const asst = (block) => ({ ...base, type: "assistant", message: { model: "claude-opus-5-5", role: "assistant", content: [block], usage } });

  const harness = "[Workflow harness — user request] redacted";
  assert.deepEqual(events(user(harness)), [{ kind: "user", ts: base.timestamp, text: harness,
    block: { type: "harness", title: "Workflow harness", chars: harness.length } }]);
  assert.equal(events(user("<system-reminder>\nredacted\n</system-reminder>"))[0].internal, true);
  assert.equal(events(user("plain", { isMeta: true }))[0].internal, true);
  assert.equal(events(user("<command-name>/x</command-name>"))[0].internal, true);

  const text = events(asst({ type: "text", text: "Clean scope. Making the edits." }));
  assert.deepEqual(text[0], { kind: "agent", ts: base.timestamp, text: "Clean scope. Making the edits." });
  // Usage rides every assistant line: context = input + cache creation + cache read. So do model and effort.
  assert.deepEqual(text[1], { kind: "meta", ts: base.timestamp, tokens: 2 + 59403 + 21837, model: "claude-opus-5-5", effort: "" });
  const withEffort = events({ ...asst({ type: "text", text: "x" }), effort: "high" }).find((e) => e.kind === "meta");
  assert.equal(withEffort.model, "claude-opus-5-5");
  assert.equal(withEffort.effort, "high");
  // An API-error line is "<synthetic>": no model.
  const synthetic = events({ ...base, type: "assistant", message: { model: "<synthetic>", content: [], usage: { input_tokens: 0 } } })[0];
  assert.equal(synthetic.model, "");

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

test("Claude transcript tail: the newest real assistant line gives model and effort", () => {
  const last = (text, midFile) => ({ ...fn("claudeLastModel")(text, midFile) });
  const line = (o) => JSON.stringify({ isSidechain: true, agentId: "a7beb7a64a116bddb", timestamp: "2026-09-30T17:42:08.361Z", ...o });
  const asst = (model, effort) => line({ type: "assistant", effort, message: { model, role: "assistant", content: [{ type: "text", text: "x" }] } });
  const result = line({ type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_01A", type: "tool_result", content: "redacted" }] } });
  const tail = [asst("claude-sonnet-5-5", "low"), asst("claude-opus-5-5", "high"), result, asst("<synthetic>", "high"), result].join("\n") + "\n";
  assert.deepEqual(last(tail, false), { model: "claude-opus-5-5", effort: "high" });
  // Read from mid-file: the cut first line is dropped, never parsed as the answer.
  const cut = '","type":"assistant","message":{"model":"claude-haiku-4-5"}}\n' + result + "\n";
  assert.deepEqual(last(cut, true), { model: "", effort: "" });
  assert.deepEqual(last(asst("claude-fable-5-1") + "\n", false), { model: "claude-fable-5-1", effort: "" });
  assert.deepEqual(last("", false), { model: "", effort: "" });
});

// Claude chat tree parsers. Line shapes from main chat files of Claude Code 2.1.186 and 2.1.285
// on this PC, trimmed, with text, paths and ids redacted.
function fns(...names) { const c = {}; for (const n of names) vm.runInNewContext(src.match(new RegExp("\\nfunction " + n + "\\([\\s\\S]*?\\n\\}"))[0], c); return c; }

test("Claude chat lines: titles, prompts, turn state, tools, results and task notifications", () => {
  const facts = (o) => fns("claudeLineFacts").claudeLineFacts(typeof o === "string" ? o : JSON.stringify(o));
  const base = { sessionId: "354f362e-aa4e-45e9-9969-37583718e229", timestamp: "2026-10-01T09:41:02.000Z", version: "2.1.285", entrypoint: "claude-vscode", cwd: "D:\\GIT\\redacted" };
  assert.equal(facts({ type: "custom-title", sessionId: base.sessionId, customTitle: "Fix the release flow" }).title, "Fix the release flow");
  assert.equal(facts({ type: "custom-title", customTitle: "x" }).titleSource, "custom");
  assert.equal(facts({ type: "ai-title", aiTitle: "Plan 2.19" }).titleSource, "ai");
  assert.equal(facts({ type: "last-prompt", lastPrompt: "y".repeat(500) }).lastPrompt.length, 200);
  // A typed prompt starts a turn; hook text and commands do not, and are never a prompt.
  const p = facts({ ...base, type: "user", message: { role: "user", content: "Check the hook against CloudCLI" } });
  assert.equal(p.prompt, "Check the hook against CloudCLI");
  assert.equal(p.turn, "running");
  assert.equal(p.entrypoint, "claude-vscode");
  assert.equal(p.version, "2.1.285");
  for (const c of ["<system-reminder>\nredacted\n</system-reminder>", "<command-name>/compact</command-name>", "<local-command-stdout>ok</local-command-stdout>"]) {
    const f = facts({ ...base, type: "user", message: { role: "user", content: c } });
    assert.equal(f.prompt, undefined);
    assert.equal(f.turn, undefined);
  }
  assert.equal(facts({ ...base, type: "user", isMeta: true, message: { content: [{ type: "text", text: "hook text" }] } }).prompt, undefined);
  assert.equal(facts({ ...base, type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }).turn, "done");
  // 2.1.186 forks: every copied line names the parent chat.
  assert.equal(facts({ ...base, version: "2.1.186", entrypoint: "sdk-ts", forkedFrom: { sessionId: "0b1c2d3e-0000-4000-8000-000000000000", messageUuid: "u" }, type: "user", message: { content: "x" } }).forkedFrom, "0b1c2d3e-0000-4000-8000-000000000000");
  // Assistant: model, effort, usage, tools; the stop reason decides the turn.
  const usage = { input_tokens: 2, cache_creation_input_tokens: 59403, cache_read_input_tokens: 21837, output_tokens: 8 };
  const asst = (content, stop, extra = {}) => ({ ...base, type: "assistant", effort: "high", message: { id: "msg_01", model: "claude-opus-5-5", content, stop_reason: stop, usage }, ...extra });
  const t = facts(asst([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: 'node "C:/x/plugin/scripts/codex-companion.mjs" task --background --effort low "redacted"' } },
    { type: "tool_use", id: "toolu_2", name: "Agent", input: { description: "Review the plugin hook", prompt: "redacted" } },
    { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "npm test" } }], "tool_use"));
  assert.equal(t.model, "claude-opus-5-5");
  assert.equal(t.effort, "high");
  assert.deepEqual({ ...t.usage }, { id: "msg_01", in: 2 + 59403 + 21837, out: 8 });
  assert.equal(t.turn, "running");
  assert.deepEqual(Array.from(t.tools, (x) => [x.id, x.agent, x.companion]), [["toolu_1", false, true], ["toolu_2", true, false], ["toolu_3", false, false]]);
  assert.equal(t.tools[1].preview, "Agent: Review the plugin hook");
  assert.equal(facts(asst([{ type: "tool_use", id: "t", name: "PowerShell", input: { command: "node codex-companion.mjs adversarial-review --base main" } }], "tool_use")).tools[0].companion, true);
  assert.equal(facts(asst([{ type: "tool_use", id: "t", name: "Bash", input: { command: "node codex-companion.mjs status" } }], "tool_use")).tools[0].companion, false);
  assert.equal(facts(asst([{ type: "text", text: "Done." }], "end_turn")).turn, "done");
  assert.equal(facts(asst([{ type: "text", text: "partial" }], null)).turn, "running");
  const synthetic = facts({ ...base, type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] } });
  assert.equal(synthetic.model, undefined);
  assert.equal(synthetic.turn, "done");
  // Results carry the full text (the launcher id line sits at the end of a long result).
  const r = facts({ ...base, type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "long result\n".repeat(200) }, { type: "text", text: "Codex job: task-muo8qkie-4wem4h" }] }] } });
  assert.equal(r.results[0].id, "toolu_1");
  assert.match(r.results[0].text, /Codex job: task-muo8qkie-4wem4h$/);
  assert.equal(r.turn, "running");
  // Background agents end by a task notification: in a queue-operation line or a user line.
  const note = "<task-notification>\n<task-id>aa29e4c2d0000000a</task-id>\n<tool-use-id>toolu_2</tool-use-id>\n<status>completed</status>\n<summary>redacted</summary>\n</task-notification>";
  assert.deepEqual(Array.from(facts({ type: "queue-operation", operation: "enqueue", content: note }).notes, (x) => ({ ...x })), [{ id: "aa29e4c2d0000000a", status: "completed" }]);
  const nu = facts({ ...base, type: "user", message: { content: note } });
  assert.equal(nu.notes[0].status, "completed");
  assert.equal(nu.prompt, undefined);
  assert.equal(nu.turn, "running");
  assert.equal(facts({ type: "system", subtype: "compact_boundary", parentUuid: null }).compact, true);
  assert.equal(facts({ type: "system", subtype: "turn_duration" }).turn, "done");
  assert.equal(facts({ type: "attachment", attachment: { type: "hook_success" } }).turn, undefined);
  assert.equal(facts("{broken"), null);
  assert.equal(facts("null"), null);
});

test("Claude usage: each message id counts once, also when a compaction writes the line again", () => {
  const { claudeUsageAdd } = fns("claudeUsageAdd");
  const acc = { seen: new Set(), context: 0, total: 0, output: 0 };
  const u = { id: "msg_01", in: 81242, out: 8 };
  claudeUsageAdd(acc, u, true, true);
  claudeUsageAdd(acc, u, true, true); // the same message, next content block
  for (let i = 0; i < 300; i++) claudeUsageAdd(acc, { id: "msg_x" + i, in: 1, out: 1 }, true, true);
  claudeUsageAdd(acc, u, true, false); // rewritten after a compact boundary, ~300 messages later
  assert.equal(acc.total, 81250 + 600);
  assert.equal(acc.output, 8 + 300);
  assert.equal(acc.context, 1); // the newest live line
  // A tail read sets the context only: the backfill counts those bytes.
  const tail = { seen: new Set(), context: 0, total: 0, output: 0 };
  claudeUsageAdd(tail, u, false, true);
  assert.deepEqual([tail.context, tail.total, tail.seen.size], [81242, 0, 0]);
  // A line without a message id still counts; the window of ids stays bounded.
  claudeUsageAdd(acc, { id: "", in: 5, out: 5 }, true, false);
  assert.equal(acc.total, 81860);
  for (let i = 0; i < 5000; i++) claudeUsageAdd(acc, { id: "m" + i, in: 0, out: 0 }, true, false);
  assert.equal(acc.seen.size <= 2048, true);
});

test("Claude launcher ids: job ids and labelled thread ids only, never a bare UUID", () => {
  const ids = (t) => { const r = fns("claudeLauncherIds").claudeLauncherIds(t); return { jobIds: [...r.jobIds], threadIds: [...r.threadIds] }; };
  assert.deepEqual(ids("Codex task started in the background as task-muocxq6w-uvy30z. Check /codex:status task-muocxq6w-uvy30z for progress."),
    { jobIds: ["task-muocxq6w-uvy30z"], threadIds: [] });
  // P1: the line every foreground result ends with
  assert.deepEqual(ids("Summary\n...\nCodex job: review-muocv3nt-l3eu18 · thread: 01A0F346-1111-7222-8333-444455556666\n"),
    { jobIds: ["review-muocv3nt-l3eu18"], threadIds: ["01a0f346-1111-7222-8333-444455556666"] });
  // Another job the answer only mentions does not link: the closing line wins.
  assert.deepEqual(ids("See task-aaaaaaaa-bbbbbb and thread: 01a0f347-0000-7000-8000-000000000000.\nCodex job: task-muocxq6w-uvy30z\n"),
    { jobIds: ["task-muocxq6w-uvy30z"], threadIds: [] });
  assert.deepEqual(ids("Codex session ID: 01a0f348-aaaa-7bbb-8ccc-dddddddddddd\nResume in Codex: codex resume 01a0f348-aaaa-7bbb-8ccc-dddddddddddd").threadIds,
    ["01a0f348-aaaa-7bbb-8ccc-dddddddddddd"]);
  // A chat id in a path or a plain mention is no thread
  assert.deepEqual(ids("D:/x/354f362e-aa4e-45e9-9969-37583718e229/subagents"), { jobIds: [], threadIds: [] });
  assert.deepEqual(ids(null), { jobIds: [], threadIds: [] });
});

test("Claude head facts: first entrypoint, cwd, typed prompt and slash command; a cut last line is dropped", () => {
  const head = (t) => ({ ...fns("claudeLineFacts", "claudeHeadFacts").claudeHeadFacts(t) });
  const l = (o) => JSON.stringify({ sessionId: "s", timestamp: "2026-10-01T09:00:00Z", ...o });
  const text = [
    l({ type: "permission-mode", permissionMode: "auto" }),
    l({ type: "user", entrypoint: "cli", version: "2.1.186", cwd: "D:\\GIT\\redacted", isMeta: true, message: { content: "<system-reminder>x</system-reminder>" } }),
    l({ type: "user", entrypoint: "cli", cwd: "D:\\GIT\\other", message: { content: "  Tidy the KB routing tables  " } }),
    '{"type":"user","message":{"content":"cut',
  ].join("\n");
  assert.deepEqual(head(text), { entrypoint: "cli", version: "2.1.186", cwd: "D:\\GIT\\redacted", forkedFrom: "", firstPrompt: "Tidy the KB routing tables", firstCommand: "" });
  assert.equal(head("").firstPrompt, "");
  // A chat that only ran a slash command gets that command as its name.
  const cmd = l({ type: "system", subtype: "local_command", content: "<command-name>/workflows</command-name>\n<command-message>workflows</command-message>" });
  assert.equal(head(cmd + "\n").firstCommand, "/workflows");
  // Many task-notification openers with no closer: linear, and no note.
  const flood = l({ type: "user", message: { content: "<task-notification>".repeat(60000) } });
  const t0 = Date.now();
  assert.equal(fns("claudeLineFacts").claudeLineFacts(flood).notes, undefined);
  assert.ok(Date.now() - t0 < 500, "the notification scan stays linear");
});

test("Claude plan usage: only the usage snapshot fields leave Claude Code's state file", () => {
  const view = (j) => fns("claudeUsageView").claudeUsageView(j);
  const state = {
    oauthAccount: { emailAddress: "secret@example.com", accessToken: "sk-secret" }, mcpServers: { x: { env: { TOKEN: "secret" } } },
    cachedUsageUtilization: { fetchedAtMs: 1790791778358, accountUuid: "uuid-secret", utilization: {
      five_hour: { utilization: 8 }, iguana_necktie: { secret: 1 },
      limits: [
        { kind: "session", group: "session", percent: 8, severity: "normal", resets_at: "2026-09-30T22:00:00+00:00", scope: null, is_active: false },
        { kind: "weekly_all", group: "weekly", percent: 20, severity: "normal", resets_at: "2026-10-07T10:00:00+00:00", scope: null },
        { kind: "weekly_scoped", group: "weekly", percent: 7, severity: "warning", resets_at: "2026-10-07T10:00:00+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
        null, { percent: 3 },
      ],
      spend: { used: { amount_minor: 0 }, percent: 0, severity: "normal", enabled: false } } },
  };
  const v = view(state);
  assert.equal(JSON.stringify(v).includes("secret"), false);
  assert.equal(v.fetchedAtMs, 1790791778358);
  assert.deepEqual(Array.from(v.limits, (l) => [l.kind, l.percent, l.severity, l.model, l.isActive]), [["session", 8, "normal", "", false], ["weekly_all", 20, "normal", "", false], ["weekly_scoped", 7, "warning", "Fable", false]]);
  state.cachedUsageUtilization.utilization.limits[1].is_active = true;
  assert.equal(view(state).limits[1].isActive, true);
  assert.equal(v.spend, null);
  state.cachedUsageUtilization.utilization.spend.enabled = true;
  assert.deepEqual({ ...view(state).spend }, { percent: 0, severity: "normal" });
  assert.equal(view({}), null);
  assert.equal(view(null), null);
  // The status line file wins when newer; the per-model week stays from the snapshot with its time.
  const merge = (s, l) => JSON.parse(JSON.stringify(fns("claudeUsageMerge").claudeUsageMerge(s, l)));
  const snap = view(state);
  const line = { atMs: snap.fetchedAtMs + 60000, fiveHour: { usedPercent: 12, resetsAtMs: 1790800000000 }, sevenDay: { usedPercent: 21, resetsAtMs: 0 } };
  const m = merge(snap, line);
  assert.equal(m.source, "statusline");
  assert.equal(m.fetchedAtMs, line.atMs);
  assert.deepEqual(m.limits.map((l) => [l.kind, l.percent, l.severity, l.atMs || 0]), [["session", 12, null, 0], ["weekly_all", 21, null, 0], ["weekly_scoped", 7, "warning", snap.fetchedAtMs]]);
  assert.equal(m.limits[0].resetsAt, new Date(1790800000000).toISOString());
  assert.equal(merge(snap, { ...line, atMs: snap.fetchedAtMs - 1 }).source, "snapshot", "an older status line loses");
  assert.equal(merge(null, line).limits.length, 2);
  assert.equal(merge(null, null), null);
  assert.equal(merge(null, { atMs: "x" }), null, "a broken file is ignored");
});
