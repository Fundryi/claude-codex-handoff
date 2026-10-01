const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const pureHelpers = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];
const navigationFunctions = script.match(
  /function chooseView[\s\S]*?(?=\n    function renderList)/,
)[0];

// sessions/jobs are live arrays: tests mutate them to simulate SSE updates. The tree is built from them
// (no Claude chats), so a Codex session is a node "codex:<id>" (or "codexagent:<id>" under its lead).
function navigation(overrides = {}) {
  const context = {
    prefs: { tab: "LIVE", chip: "ALL", kinds: {}, autoFollow: true, dismissed: [], node: "codex:selected" },
    selected: "selected",
    sessions: [{ id: "selected", threadId: "t-sel", status: "LIVE", lastGrow: Date.now() }],
    jobs: [],
    savePrefs() {},
    applyPrefs() {},
    renderFilters() {},
    renderList() {},
    renderHeader() {},
    renderFeed() {},
    selectSession(id) { context.selected = id; context.prefs.node = "codex:" + id; },
    ...overrides,
  };
  context.currentRows = () => context.buildRows(context.sessions, context.jobs);
  context.currentModel = () => context.buildNodes({ chats: [], ghosts: [] }, [], context.currentRows(), context.jobs, Date.now());
  // As in the page code: the open node decides the page kind.
  context.pageKind = () => {
    if (context.prefs.home || !context.prefs.node) return "overview";
    const kind = String(context.prefs.node).split(":")[0];
    if (kind === "handoff" || kind === "codex" || kind === "codexagent") return "codex";
    return ["chat", "workflow", "ghost"].includes(kind) ? kind : "overview";
  };
  context.pageNode = () => context.currentModel().nodes[context.prefs.node] || null;
  vm.runInNewContext(pureHelpers + "\n" + navigationFunctions, context);
  return context;
}
const view = (context) => [context.prefs.tab, context.prefs.chip];

test("picking a tab or chip pauses automatic following and closes the overview", () => {
  const context = navigation();
  context.prefs.home = true;
  context.chooseView("HISTORY", "FINISHED");
  assert.deepEqual(view(context), ["HISTORY", "FINISHED"]);
  assert.equal(context.prefs.autoFollow, false);
  assert.equal(context.prefs.home, false);
});

test("Auto-open follows a running Codex task, never away from an open Claude page or panel", () => {
  const running = { id: "running", threadId: "t-run", status: "LIVE", lastGrow: Date.now() };
  const context = navigation();
  context.sessions.push(running);
  context.prefs.autoFollow = false;
  context.followRunningSession(running);
  assert.equal(context.selected, "selected", "Auto-open off: nothing moves");

  context.prefs.autoFollow = true;
  context.followRunningSession(running);
  assert.equal(context.selected, "running");

  // From the overview too (no node open).
  context.prefs.node = null;
  context.selected = null;
  context.followRunningSession(running);
  assert.equal(context.selected, "running");

  // An open Claude chat or an open side panel keeps its place.
  context.prefs.node = "chat:0b1c2d3e-0000-4000-8000-000000000001";
  context.selected = null;
  context.followRunningSession(running);
  assert.equal(context.selected, null);
  context.prefs.node = "codex:selected";
  context.prefs.panel = "agent:a0123456789abcdef";
  context.followRunningSession(running);
  assert.equal(context.selected, null);
});

test("turning Auto-open on from the overview leaves it and opens the running task", () => {
  // The toggle only shows on the overview (prefs.home), where followRunningSession stands down.
  const running = { id: "running", threadId: "t-run", status: "LIVE", lastGrow: Date.now() };
  const context = navigation({ sessions: [{ id: "selected", threadId: "t-sel", status: "IDLE", lastGrow: Date.now() }, running] });
  context.prefs.home = true;
  context.prefs.autoFollow = false;

  context.setAutoOpen(true, running);
  assert.equal(context.prefs.autoFollow, true);
  assert.equal(context.prefs.home, false, "the overview closes so the opened task shows");
  assert.equal(context.selected, "running");

  // Turning it off opens nothing and leaves the view alone.
  context.prefs.home = true;
  context.selected = "selected";
  context.setAutoOpen(false, running);
  assert.equal(context.prefs.autoFollow, false);
  assert.equal(context.prefs.home, true);
  assert.equal(context.selected, "selected");
});
