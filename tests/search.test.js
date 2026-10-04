const assert = require("node:assert/strict");
const { serverSource } = require("./helpers/source");
const test = require("node:test");
const vm = require("node:vm");

const source = serverSource();
const searchMatchSource = source.match(/function searchMatch[\s\S]*?\n}/)[0];

function searchContext() {
  const context = {};
  vm.runInNewContext(searchMatchSource, context);
  return context;
}

test("searchMatch requires every term, case-insensitively", () => {
  const ctx = searchContext();
  const entry = {
    title: "Fix the login bug",
    cwd: "D:\\GIT\\MyApp",
    threadId: "019f5265-e45b",
    id: "rollout-2026-07-11T20-17-22-019f5265",
  };
  assert.equal(ctx.searchMatch(entry, ["login"]), true);
  assert.equal(ctx.searchMatch(entry, ["LOGIN", "myapp"]), true);
  assert.equal(ctx.searchMatch(entry, ["login", "otherproject"]), false);
  assert.equal(ctx.searchMatch(entry, ["019f5265"]), true);
  assert.equal(ctx.searchMatch(entry, []), false);
});

test("searchMatch tolerates missing fields", () => {
  const ctx = searchContext();
  assert.equal(ctx.searchMatch({ id: "rollout-x" }, ["rollout-x"]), true);
  assert.equal(ctx.searchMatch({}, ["anything"]), false);
});
