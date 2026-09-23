const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const src = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
const slice = src.match(/const DEFAULT_RESUME_PROMPT[\s\S]*?function buildCompanionTaskArgs[\s\S]*?\n\}/)[0];

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

test("buildCompanionTaskArgs maps fast before the prompt", () => {
  const { buildCompanionTaskArgs } = ctx();
  assert.deepEqual(
    Array.from(buildCompanionTaskArgs({ cwd: "D:\\x", prompt: "p", fast: true })),
    ["task", "--background", "--json", "--cwd", "D:\\x", "--fast", "p"],
  );
  assert.ok(!buildCompanionTaskArgs({ cwd: "D:\\x", prompt: "p" }).includes("--fast"));
});

// The companion records a --cwd pointer in the folder it runs from. Run from the
// viewer's folder, a resume would be handed to whatever Claude session works there.
test("runCompanion runs the companion inside the job's folder", async () => {
  const match = src.match(/function runCompanion[\s\S]*?\n\}/);
  assert.ok(match, "runCompanion must be declared at top level");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-run-companion-"));
  const job = path.join(tmp, "job folder");
  fs.mkdirSync(job);
  const script = path.join(tmp, "companion.js");
  fs.writeFileSync(script, "console.log(JSON.stringify({ cwd: process.cwd() }))\n");
  const c = { execFile: require("node:child_process").execFile, process, COMPANION_SCRIPT: script };
  vm.runInNewContext(match[0], c);
  const parsed = await new Promise((resolve) => c.runCompanion(["cancel", "job-1", "--cwd", job, "--json"], {}, (_err, value) => resolve(value)));
  assert.equal(fs.realpathSync(parsed.cwd), fs.realpathSync(job));
});
