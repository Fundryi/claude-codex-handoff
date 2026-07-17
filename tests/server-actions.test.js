const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const slice = src.match(/const DEFAULT_RESUME_PROMPT[\s\S]*?function buildCompanionReviewArgs[\s\S]*?\n\}/)[0];

function ctx() {
  const c = {};
  vm.runInNewContext(slice, c);
  return c;
}

function resolverCtx() {
  const match = src.match(/function resolveCompanionScript[\s\S]*?\n\}/);
  assert.ok(match, "resolveCompanionScript must be declared at top level");
  const c = { fs, path };
  vm.runInNewContext(match[0], c);
  return c;
}

test("resolveCompanionScript supports repo and bundled plugin layouts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-companion-"));
  try {
    const { resolveCompanionScript } = resolverCtx();
    const repoRoot = path.join(tmp, "repo");
    const repoScript = path.join(repoRoot, "plugin", "scripts", "codex-companion.mjs");
    const alternateScript = path.join(tmp, "scripts", "codex-companion.mjs");
    const viewerDir = path.join(repoRoot, "plugin", "viewer");
    const missingRoot = path.join(tmp, "empty", "missing");
    fs.mkdirSync(path.dirname(repoScript), { recursive: true });
    fs.mkdirSync(path.dirname(alternateScript), { recursive: true });
    fs.mkdirSync(viewerDir, { recursive: true });
    fs.writeFileSync(repoScript, "");
    fs.writeFileSync(alternateScript, "");

    assert.equal(resolveCompanionScript(repoRoot), repoScript);
    assert.equal(resolveCompanionScript(viewerDir), repoScript);
    assert.equal(resolveCompanionScript(missingRoot), path.join(missingRoot, "plugin", "scripts", "codex-companion.mjs"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildCompanionTaskArgs maps every field", () => {
  const { buildCompanionTaskArgs } = ctx();
  assert.deepEqual(
    Array.from(buildCompanionTaskArgs({ cwd: "D:\\GIT\\x", prompt: "do it", effort: "xhigh", model: "spark", write: true, resumeThreadId: "th-1" })),
    ["task", "--background", "--json", "--cwd", "D:\\GIT\\x", "--effort", "xhigh", "-m", "spark", "--write", "--resume-thread", "th-1", "do it"],
  );
  assert.deepEqual(
    Array.from(buildCompanionTaskArgs({ cwd: "D:\\GIT\\x", prompt: "hi" })),
    ["task", "--background", "--json", "--cwd", "D:\\GIT\\x", "hi"],
  );
});

test("buildCompanionReviewArgs maps kind and focus", () => {
  const { buildCompanionReviewArgs } = ctx();
  assert.deepEqual(
    Array.from(buildCompanionReviewArgs({ cwd: "D:\\x", kind: "adversarial-review", focus: "check auth" })),
    ["adversarial-review", "--background", "--json", "--cwd", "D:\\x", "check auth"],
  );
  assert.deepEqual(
    Array.from(buildCompanionReviewArgs({ cwd: "D:\\x", kind: "review", focus: "ignored for native review" })),
    ["review", "--background", "--json", "--cwd", "D:\\x"],
  );
  assert.deepEqual(buildCompanionReviewArgs({ cwd: "D:\\x", kind: "nonsense" })[0], "review");
});
