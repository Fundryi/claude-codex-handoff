const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const slice = script.match(/function resumeBody[\s\S]*?function answerPrompt[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

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
