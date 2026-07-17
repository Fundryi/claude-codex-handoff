const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const slice = script.match(/function taskFormBody[\s\S]*?function knownCwds[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test("taskFormBody trims and omits empty optionals", () => {
  const { taskFormBody } = ctx();
  assert.deepEqual(
    plain(taskFormBody({ cwd: " D:\\GIT\\x ", prompt: " fix it ", effort: "", model: "", write: false, sandbox: "" })),
    { cwd: "D:\\GIT\\x", prompt: "fix it" },
  );
  assert.deepEqual(
    plain(taskFormBody({ cwd: "D:\\x", prompt: "p", effort: "xhigh", model: "spark", write: true, sandbox: "workspace-write" })),
    { cwd: "D:\\x", prompt: "p", effort: "xhigh", model: "spark", write: true, sandbox: "workspace-write" },
  );
});

test("resumeBody carries thread, cwd and adjustments", () => {
  const { resumeBody } = ctx();
  assert.deepEqual(
    plain(resumeBody({ threadId: "th-1", cwd: "D:\\x" }, { effort: "high", write: true })),
    { threadId: "th-1", cwd: "D:\\x", effort: "high", write: true },
  );
  assert.deepEqual(plain(resumeBody({ threadId: "th-1", cwd: "D:\\x" }, {})), { threadId: "th-1", cwd: "D:\\x" });
});

test("knownCwds dedupes sessions and jobs, newest first, skips blanks", () => {
  const { knownCwds } = ctx();
  assert.deepEqual(
    plain(knownCwds(
      [{ cwd: "D:\\a" }, { cwd: "" }, { cwd: "D:\\b" }],
      [{ workspaceRoot: "D:\\b" }, { workspaceRoot: "D:\\c" }],
    )),
    ["D:\\a", "D:\\b", "D:\\c"],
  );
});
