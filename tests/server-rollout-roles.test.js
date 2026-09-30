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

test("start --no-open skips the browser tab", () => {
  const c = {};
  vm.runInNewContext(src.match(/function parseFlags\(argv\) \{[\s\S]*?\n\}/)[0], c);
  assert.equal(c.parseFlags(["start", "--no-open"]).noOpen, true);
  assert.equal(c.parseFlags(["start", "--no-open"]).cmd, "start");
  assert.equal(c.parseFlags(["start"]).noOpen, false);
  assert.match(src, /function openBrowser\(\) \{\s*if \(FLAGS\.noOpen\) return;/);
});

// Prompts often open with a tag: Claude's <goal> or <task>, the adversarial review's <role>,
// Codex Desktop's <send_user_message_question_reply>. Only the tags Codex itself injects (a list
// taken from real rollouts) and the AGENTS.md heading are injected context; the rest is speech.
test("only the tags Codex injects are internal; prompts that open with another tag are speech", () => {
  const internal = (text) => ctx().simplify(item("user", text)).internal === true;
  for (const prompt of [
    "<goal>\nPick a name\n</goal>\n\n<return_format>\nEnd with four headings\n</return_format>",
    "<goal>\nPick a name\n</goal>",
    "<task>\nRename the config key\n</task>",
    "<role>\nYou are an adversarial reviewer.\n</role>",
    "<send_user_message_question_reply>Use B</send_user_message_question_reply>",
    "<div> is the wrapper I meant",
  ]) assert.equal(internal(prompt), false, prompt);
  for (const block of [
    "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
    "<recommended_plugins>\nHere is a list",
    "<skill>\n<name>tdd</name>",
    "<task-notification>\nJob done",
    "<ide_opened_file>/repo/a.js</ide_opened_file>",
    "<user_instructions>\nBe brief",
    "  <permissions instructions>\nsandbox",
    "# AGENTS.md instructions for /repo/x\n\n<INSTRUCTIONS>",
  ]) assert.equal(internal(block), true, block);
  // Older Codex versions write the AGENTS.md heading without " for <path>".
  assert.equal(internal("# AGENTS.md instructions\n\n<INSTRUCTIONS>\nBe brief"), true);
  // Codex writes a child agent's status into the lead's thread as a user message.
  assert.equal(internal('<subagent_notification>\n{"agent":"alpha","status":"completed"}\n</subagent_notification>'), true);
  // A tag name that only starts like an injected one is not injected: <skills_x> vs <skills>.
  assert.equal(internal("<skillset>\nmine"), false);
});

test("session_meta carries the originator", () => {
  const ev = ctx().simplify(JSON.stringify({ type: "session_meta", payload: { id: "t", cwd: "/repo", originator: "Claude Code" } }));
  assert.equal(ev.originator, "Claude Code");
  assert.equal(ctx().simplify(JSON.stringify({ type: "session_meta", payload: { id: "t", cwd: "/repo" } })).originator, "");
});

// Codex 0.148+ (code mode) records what it ran only as event_msg/item_completed items.
// Shapes trimmed from a real 0.159.2 rollout.
function completed(item) {
  return JSON.stringify({ timestamp: "2026-09-30T12:30:55.244Z", ordinal: 19, type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "u", item } });
}

test("item_completed CommandExecution is a cmd event with the clean command", () => {
  const ev = ctx().simplify(completed({
    type: "CommandExecution", command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "Get-Content -LiteralPath 'C:\\Users\\RTK.md'"],
    cwd: "file:///D:/GIT/x", parsed_cmd: [{ type: "read", cmd: "Get-Content -LiteralPath 'C:\\Users\\RTK.md'", name: "RTK.md" }],
    source: "unified_exec_startup", status: "completed", aggregated_output: "# RTK\r\n", exit_code: 0,
  }));
  assert.equal(ev.kind, "cmd");
  assert.equal(ev.text, "Get-Content -LiteralPath 'C:\\Users\\RTK.md'");
  assert.match(ev.detail, /exit 0\n# RTK/);
  // 0.124-0.128 logged the same command as function_call shell too; that one is shown.
  assert.equal(ctx().simplify(completed({ type: "CommandExecution", command: ["pwsh.exe", "-Command", "git status"], source: "agent" })), null);
});

test("item_completed FileChange, McpToolCall and web search become patch and tool events", () => {
  const patch = ctx().simplify(completed({ type: "FileChange", changes: {
    "C:\\Temp\\report.md": { type: "add", content: "# Report\n" },
    "C:\\Temp\\map.md": { type: "update", unified_diff: "@@ -40,3 +40,3 @@\n-a\n+b\n", move_path: null },
  }, status: "completed" }));
  assert.equal(patch.kind, "patch");
  assert.equal(patch.text, "C:\\Temp\\report.md, C:\\Temp\\map.md");
  assert.match(patch.detail, /^add C:\\Temp\\report\.md\n# Report/);
  assert.match(patch.detail, /update C:\\Temp\\map\.md\n@@ -40,3/);
  const mcp = ctx().simplify(completed({ type: "McpToolCall", server: "context-mode", tool: "ctx_search", arguments: { queries: ["x"] }, status: "completed" }));
  assert.equal(mcp.kind, "tool");
  assert.match(mcp.text, /^context-mode\.ctx_search /);
  const web = ctx().simplify(completed({ type: "Extension", kind: "web.search", query: "codex models", action: { type: "search" } }));
  assert.deepEqual([web.kind, web.text], ["tool", "web.search codex models"]);
  // These repeat response_items or carry nothing to show.
  for (const type of ["AgentMessage", "Reasoning", "UserMessage", "SubAgentActivity"]) assert.equal(ctx().simplify(completed({ type })), null, type);
});

test("the Guardian's history openers are injected context", () => {
  const ev = ctx().simplify(item("user", "The following is the Codex agent history added since your last approval assessment. Continue the same review conversation."));
  assert.equal(ev.internal, true);
  assert.equal(ctx().simplify(item("user", "The following is the Codex agent history whose request action you are assessing. Treat the transcript as evidence.")).internal, true);
});
