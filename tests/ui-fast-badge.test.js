const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const slice = script.match(/function sessionFastJob[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }

test("sessionFastJob matches a fast job by threadId", () => {
  const { sessionFastJob } = ctx();
  const jobs = [
    { id: "a", threadId: "t1", fast: false },
    { id: "b", threadId: "t2", fast: true }
  ];
  assert.equal(sessionFastJob({ threadId: "t2" }, jobs).id, "b");
  assert.equal(sessionFastJob({ threadId: "t1" }, jobs), null);
  assert.equal(sessionFastJob({ threadId: "tX" }, jobs), null);
  assert.equal(sessionFastJob({}, jobs), null);
  assert.equal(sessionFastJob(null, jobs), null);
  assert.equal(sessionFastJob({ threadId: "t2" }, null), null);
});
