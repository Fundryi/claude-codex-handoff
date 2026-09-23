const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// The ... menu and the right-click menu share one builder: menuItems(row, context).
const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const block = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];

function ctx() { const c = {}; vm.runInNewContext(block, c); return c; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }
const ids = (items) => plain(items.map((entry) => entry.id));
function menu(session, jobs, context) {
  const { buildRows, menuItems } = ctx();
  return menuItems(buildRows(session ? [session] : [], jobs || [])[0], context || { dismissed: false });
}

test("live session with thread gets copy commands, dismiss, and stop", () => {
  const items = menu({ id: "s", threadId: "t1", status: "LIVE" });
  assert.deepEqual(ids(items), ["dismiss", "copy-resume", "copy-continue", "copy-fork", "copy-archive", "show-processes", "stop"]);
  assert.equal(items[items.length - 1].danger, true);
  // Stop is pointless on a task that ended or whose job was cancelled.
  assert.ok(!ids(menu({ id: "s", threadId: "t1", status: "DONE" })).includes("stop"), "DONE");
  assert.ok(!ids(menu({ id: "s", threadId: "t1", status: "STOPPED" }, [{ id: "j", threadId: "t1", live: "cancelled" }])).includes("stop"), "cancelled job");
  // An aborted turn is STOPPED too, but its interactive Codex window is often still running.
  assert.ok(ids(menu({ id: "s", threadId: "t1", status: "STOPPED", lastKind: "err" })).includes("stop"), "aborted turn");
});

test("finished session without thread only gets dismiss and diagnostics", () => {
  const items = menu({ id: "s", status: "DONE" }, [], { dismissed: true });
  assert.deepEqual(ids(items), ["dismiss", "show-processes"]);
  assert.equal(items[0].label, "Restore task");
});

test("archived session gets unarchive and dismiss only", () => {
  assert.deepEqual(ids(menu({ id: "s", threadId: "t1", status: "DONE", archived: true })), ["dismiss", "copy-unarchive"]);
});

test("dead job with thread gets copies and resume; running job gets cancel", () => {
  assert.deepEqual(ids(menu(null, [{ id: "j", threadId: "t1", live: "dead" }])), ["resume-job", "show-result", "dismiss", "copy-resume", "copy-continue", "copy-fork"]);
  const working = menu(null, [{ id: "j", live: "working" }]);
  assert.deepEqual(ids(working), ["show-result", "cancel-job", "dismiss"]);
  assert.equal(working[1].danger, true);
  assert.equal(working[1].label, "Cancel job…");
});

test("a job-only row dismisses by its job: id", () => {
  const { buildRows } = ctx();
  const row = buildRows([], [{ id: "j", live: "completed" }])[0];
  assert.equal(row.id, "job:j");
  assert.equal(menu(null, [{ id: "j", live: "completed" }], { dismissed: true }).find((i) => i.id === "dismiss").label, "Restore task");
});

test("menu items keep today's tooltips", () => {
  const items = menu({ id: "s", threadId: "t1", status: "LIVE" });
  const titles = Object.fromEntries(items.map((i) => [i.id, i.title]));
  assert.match(titles["copy-resume"], /^codex resume /);
  assert.match(titles["copy-continue"], /^codex exec resume /);
  assert.match(titles["copy-archive"], /^codex archive /);
  assert.match(titles.dismiss, /Viewer-only, undoable/);
});
