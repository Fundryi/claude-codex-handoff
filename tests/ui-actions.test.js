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

test("taskFormBody includes fast only when enabled", () => {
  const { taskFormBody } = ctx();
  assert.deepEqual(plain(taskFormBody({ cwd: "D:\\x", prompt: "p", fast: true })), { cwd: "D:\\x", prompt: "p", fast: true });
  assert.deepEqual(plain(taskFormBody({ cwd: "D:\\x", prompt: "p", fast: false })), { cwd: "D:\\x", prompt: "p" });
});

test("resumeBody carries thread, cwd and adjustments", () => {
  const { resumeBody } = ctx();
  assert.deepEqual(
    plain(resumeBody({ threadId: "th-1", cwd: "D:\\x" }, { effort: "high", write: true })),
    { threadId: "th-1", cwd: "D:\\x", effort: "high", write: true },
  );
  assert.deepEqual(plain(resumeBody({ threadId: "th-1", cwd: "D:\\x" }, {})), { threadId: "th-1", cwd: "D:\\x" });
});

test("resumeBody includes fast only when enabled", () => {
  const { resumeBody } = ctx();
  assert.deepEqual(
    plain(resumeBody({ threadId: "th-1", cwd: "D:\\x" }, { fast: true })),
    { threadId: "th-1", cwd: "D:\\x", fast: true },
  );
  assert.deepEqual(plain(resumeBody({ threadId: "th-1", cwd: "D:\\x" }, { fast: false })), { threadId: "th-1", cwd: "D:\\x" });
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

test("answerPrompt prefixes the answer and never lets it start the prompt", () => {
  const { answerPrompt } = ctx();
  assert.equal(answerPrompt("  use option B  "), "Answer from the user: use option B");
  // A leading "--" stays inside the prompt text, so it can never read as a CLI flag.
  assert.equal(answerPrompt("--force the old API"), "Answer from the user: --force the old API");
  // Inner quotes and newlines are kept as typed.
  assert.equal(
    answerPrompt('Keep "old" API\nbut rename it\'s helper\n'),
    'Answer from the user: Keep "old" API\nbut rename it\'s helper',
  );
  for (const blank of ["", "   ", "\n\t \r\n", null, undefined]) assert.equal(answerPrompt(blank), "", `blank: ${JSON.stringify(blank)}`);
});

test("resumeBody carries the answer prompt from the answer box", () => {
  const { resumeBody, answerPrompt } = ctx();
  assert.deepEqual(
    plain(resumeBody({ threadId: "th-1", cwd: "D:\\x" }, { prompt: answerPrompt("keep it") })),
    { threadId: "th-1", cwd: "D:\\x", prompt: "Answer from the user: keep it" },
  );
});
