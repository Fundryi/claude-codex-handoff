const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const slice = script.match(/function contextMenuItems[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }

function plain(value) { return JSON.parse(JSON.stringify(value)); }

const ids = (items) => plain(items.map((entry) => entry.id));

test("live session with thread gets copy commands, dismiss, and stop", () => {
  const { contextMenuItems } = ctx();
  const items = contextMenuItems({ type: "session", session: { threadId: "t1", status: "LIVE" }, dismissed: false });
  assert.deepEqual(ids(items), ["copy-resume", "copy-continue", "copy-fork", "copy-archive", "dismiss", "stop"]);
  assert.equal(items[items.length - 1].danger, true);
});

test("finished session without thread only gets dismiss", () => {
  const { contextMenuItems } = ctx();
  assert.deepEqual(ids(contextMenuItems({ type: "session", session: { status: "DONE" }, dismissed: true })), ["dismiss"]);
  assert.equal(contextMenuItems({ type: "session", session: { status: "DONE" }, dismissed: true })[0].label, "Restore task");
});

test("archived session gets unarchive and dismiss only", () => {
  const { contextMenuItems } = ctx();
  assert.deepEqual(
    ids(contextMenuItems({ type: "session", session: { threadId: "t1", status: "DONE", archived: true }, dismissed: false })),
    ["copy-unarchive", "dismiss"]
  );
});

test("dead job with thread gets copies and resume; running job gets cancel", () => {
  const { contextMenuItems } = ctx();
  assert.deepEqual(
    ids(contextMenuItems({ type: "job", job: { threadId: "t1", live: "dead" } })),
    ["copy-resume", "copy-continue", "copy-fork", "resume-job"]
  );
  assert.deepEqual(ids(contextMenuItems({ type: "job", job: { live: "working" } })), ["cancel-job"]);
});
