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

test("sessionMetaLine short form leaves path, model and effort to the header chips", () => {
  const line = ctx().sessionMetaLine({ cwd: "D:\\GIT\\x", model: "gpt-5.3-codex", effort: "xhigh", sandbox: "danger-full-access", tokensUsed: 48211, threadId: "th-9" }, true);
  assert.equal(line, "sandbox: danger-full-access   |   tokens: " + (48211).toLocaleString() + "   |   thread: th-9");
});

test("modelShortName: Claude model ids to a short name, anything else unchanged", () => {
  const helpers = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];
  const c = {};
  vm.runInNewContext(helpers, c);
  assert.equal(c.modelShortName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(c.modelShortName("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(c.modelShortName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(c.modelShortName("claude-fable-5-1"), "Fable 5.1");
  assert.equal(c.modelShortName("claude-opus-5"), "Opus 5");
  assert.equal(c.modelShortName("gpt-5.3-codex"), "gpt-5.3-codex");
  assert.equal(c.modelShortName("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet-20241022");
  assert.equal(c.modelShortName(""), "");
});
