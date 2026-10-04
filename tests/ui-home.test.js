const assert = require("node:assert/strict");
const { uiSource } = require("./helpers/source");
const test = require("node:test");
const vm = require("node:vm");

const html = uiSource();
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function ctx() {
  const c = { viewRoots: model => model.roots };
  for (const name of ["firstLine", "projectName", "liveHidden", "childOrder", "overviewGroups", "overviewStep"]) {
    vm.runInNewContext(script.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n    \\}"))[0], c);
  }
  return c;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
const NOW = new Date(2026, 9, 3, 15).getTime();
function node(id, state, children = [], extra = {}) {
  return { id, kind: "chat", state, rollup: state, updatedMs: NOW, children, ...extra };
}
function model(...nodes) {
  const children = new Set(nodes.flatMap(n => n.children));
  return { nodes: Object.fromEntries(nodes.map(n => [n.id, n])), roots: nodes.filter(n => !children.has(n.id)).map(n => n.id) };
}

test("overview lists running children once and promotes questions and attention", () => {
  const { overviewGroups } = ctx();
  const groups = overviewGroups(model(
    node("parent", "BACKGROUND", ["agent", "handoff", "ask", "failed", "done"]),
    node("agent", "RUNNING", [], { kind: "agent" }),
    node("handoff", "RUNNING", [], { kind: "handoff" }),
    node("ask", "ANSWER", [], { kind: "handoff" }),
    node("failed", "ATTENTION", [], { kind: "handoff" }),
    node("done", "FINISHED", [], { kind: "agent" })
  ), NOW, []);
  assert.deepEqual(plain(groups.running.map(n => n.id)), ["parent"]);
  assert.deepEqual(plain(groups.children.parent.map(n => n.id)).sort(), ["agent", "handoff"]);
  assert.deepEqual(plain(groups.answer.map(n => n.id)), ["ask"]);
  assert.deepEqual(plain(groups.attention.map(n => n.id)), ["failed"]);
  assert.equal(groups.finished.length, 0, "finished agents do not remain under a parent");
});

test("finished rows include all of today and handoffs under finished parents", () => {
  const { overviewGroups } = ctx();
  const nodes = Array.from({ length: 8 }, (_, i) => node("f" + i, "FINISHED"));
  nodes.push(node("old", "FINISHED", [], { updatedMs: new Date(2026, 9, 2, 23, 59).getTime() }),
    node("parent", "FINISHED", ["h", "oc"]), node("h", "FINISHED", [], { kind: "handoff" }),
    node("oc", "FINISHED", [], { kind: "opencode", row: { job: { engine: "opencode" } } }));
  const groups = overviewGroups(model(...nodes), NOW, []);
  assert.equal(groups.finished.length, 11, "no old five-card cap");
  assert.ok(groups.finished.some(n => n.id === "h"));
  assert.ok(groups.finished.some(n => n.id === "oc"));
  assert.ok(!groups.finished.some(n => n.id === "old"));
});

test("hidden subtrees and ghosts do not become rows; running work stays accessible", () => {
  const { overviewGroups } = ctx();
  const groups = overviewGroups(model(
    node("hidden", "RUNNING", ["hidden-child"], { row: { id: "dismissed" } }),
    node("hidden-child", "RUNNING"),
    node("archived", "ARCHIVED", [], { row: { id: "archived" } }),
    node("ghost", "FINISHED", ["h"], { kind: "ghost" }),
    node("h", "ANSWER", [], { kind: "handoff" }),
    node("done", "FINISHED", ["active"]),
    node("active", "RUNNING", [], { kind: "agent" })
  ), NOW, ["dismissed"]);
  assert.deepEqual(plain(groups.running.map(n => n.id)), ["active"]);
  assert.deepEqual(plain(groups.answer.map(n => n.id)), ["h"]);
  assert.ok(!groups.finished.some(n => n.id === "ghost"));
});

test("doing-now uses evidence, basename patches and honest answer and working fallbacks", () => {
  const { overviewStep } = ctx();
  const step = n => overviewStep({ nodes: {} }, n);
  assert.equal(step(node("c", "RUNNING", [], { tool: "Bash: npm test" })).text, "Bash: npm test");
  assert.equal(step(node("c", "RUNNING", [], { tool: "Bash: npm test" })).command, true);
  assert.equal(step(node("c", "RUNNING", [], { row: { session: { lastKind: "cmd", lastText: "npm test\noutput" } } })).text, "ran npm test");
  assert.equal(step(node("c", "RUNNING", [], { row: { session: { lastKind: "patch", lastText: "D:\\repo\\app.js, /repo/docs/UI-THEME.md" } } })).text, "patched app.js, UI-THEME.md");
  assert.equal(step(node("c", "ANSWER", [], { row: { job: { needsDecision: "Which option?\nDetails" } } })).text, "Which option?");
  assert.equal(step(node("c", "ANSWER")).text, "waiting for your answer");
  assert.equal(step(node("c", "RUNNING")).text, "working");
  assert.equal(step(node("c", "RUNNING", [], { kind: "opencode", chat: { step: "shell: npm test" } })).text, "shell: npm test");
  assert.equal(step(node("c", "FINISHED")).text, "");
  assert.equal(step(node("c", "FINISHED", [], { tool: "Bash: stale command", row: { job: { errorMessage: "old error" } } })).text, "");
  assert.equal(step(node("c", "ATTENTION", [], { kind: "opencode", chat: { outcome: "failed" } })).text, "failed");
  assert.equal(step(node("c", "ATTENTION", [], { row: { job: { errorMessage: "Worker failed\nDetails" } } })).text, "Worker failed");
  assert.equal(step(node("c", "ATTENTION", [], { tool: "Bash: stale command" })).text, "");
  assert.equal(step(node("c", "ENDED")).text, "");
  assert.equal(step(node("c", "ENDED", [], { kind: "opencode", chat: { outcome: "stopped" } })).text, "stopped");
  assert.equal(step(node("c", "STOPPED")).text, "stopped");
  assert.equal(step(node("c", "WAITING")).text, "");
});

test("doing-now carries background counts and workflow phase counts", () => {
  const { overviewStep } = ctx();
  const parent = node("parent", "BACKGROUND", ["a", "b"]);
  const m = model(parent, node("a", "RUNNING", [], { kind: "agent" }), node("b", "FINISHED"));
  assert.equal(overviewStep(m, parent).text, "1 agent running");
  m.nodes.b.state = "RUNNING";
  assert.equal(overviewStep(m, parent).text, "2 agents running");
  m.nodes.a.state = m.nodes.b.state = "FINISHED";
  assert.equal(overviewStep(m, parent).text, "");
  const workflow = node("wf", "RUNNING", [], { kind: "workflow", run: { phases: [
    { title: "Research", done: 2, started: 2 }, { title: "Build", done: 1, started: 3 }
  ] } });
  assert.equal(overviewStep(m, workflow).text, "Build 1/3");
});
