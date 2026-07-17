const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const src = fs.readFileSync(path.join(__dirname, "..", "plugin", "scripts", "codex-companion.mjs"), "utf8");

test("task accepts --resume-thread and validates like resume-last", () => {
  assert.ok(src.includes('"resume-thread"'), "resume-thread must be a value option");
  assert.match(src, /function requireTaskRequest\(prompt, resumeLast, resumeThreadId\)/);
});

test("review command supports --background via the shared worker", () => {
  assert.match(src, /jobClass === "review"\s*\?\s*\(\)\s*=>\s*executeReviewRun/);
});

test("job records carry model, effort, sandbox", () => {
  assert.match(src, /sandbox:\s*companionSandbox\(\)/);
  assert.match(src, /model,\s*\n?\s*effort,/);
});

test("task and review commands accept --fast", () => {
  assert.match(src, /async function handleTask\(argv\)[\s\S]*?booleanOptions:\s*\[[^\]]*"fast"/);
  assert.match(src, /async function handleReviewCommand\(argv, config\)[\s\S]*?booleanOptions:\s*\[[^\]]*"fast"/);
});

test("fast reaches task and review requests", () => {
  assert.match(src, /const fast = Boolean\(options\.fast\);/);
  assert.match(src, /function buildTaskRequest\(\{[^}]*fast[^}]*\}\)[\s\S]*?return \{[^}]*fast/);
  assert.match(src, /reviewName: config\.reviewName,\s*\n?\s*fast: Boolean\(options\.fast\)/);
});

test("job records carry fast", () => {
  assert.match(src, /function createCompanionJob\(\{[^}]*fast = false[^}]*\}\)/);
  assert.match(src, /createJobRecord\(\{[\s\S]*?fast,/);
});
