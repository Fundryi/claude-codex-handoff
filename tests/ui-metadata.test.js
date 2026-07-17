const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const slice = script.match(/function sessionMetaLine[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }

test("sessionMetaLine shows model, effort, sandbox, tokens and thread", () => {
  const line = ctx().sessionMetaLine({ cwd: "D:\\GIT\\x", model: "gpt-5.3-codex", effort: "xhigh", sandbox: "danger-full-access", tokensUsed: 48211, threadId: "th-9" });
  assert.ok(line.includes("gpt-5.3-codex"));
  assert.ok(line.includes("effort: xhigh"));
  assert.ok(line.includes("sandbox: danger-full-access"));
  assert.ok(line.includes("tokens: 48"));
  assert.ok(line.includes("th-9"));
});

test("sessionMetaLine omits unknown effort/sandbox", () => {
  const line = ctx().sessionMetaLine({ cwd: "D:\\x", model: "", effort: "", sandbox: "", threadId: "" });
  assert.ok(!line.includes("effort:"));
  assert.ok(!line.includes("sandbox:"));
});
