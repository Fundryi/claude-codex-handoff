const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const src = fs.readFileSync(
  path.join(__dirname, "..", "plugin", "scripts", "lib", "codex.mjs"),
  "utf8"
);

// Daybreak access is verification-gated per account. The worker must check
// model/list before starting a Daybreak turn so a locked account gets a clear
// fail-fast message instead of an opaque API error mid-run.
test("runAppServerTurn preflights Daybreak model access via model/list", () => {
  const start = src.indexOf("export async function runAppServerTurn(");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n}", start));
  assert.match(body, /gpt-daybreak/);
  assert.match(body, /model\/list/);
  assert.match(body, /verification-gated/);
  const checkAt = body.indexOf("model/list");
  const threadAt = body.indexOf("startThread(");
  assert.ok(checkAt !== -1 && threadAt !== -1 && checkAt < threadAt, "the access check must run before the thread starts");
});
