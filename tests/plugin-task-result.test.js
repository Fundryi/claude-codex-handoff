const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const scripts = path.join(__dirname, "..", "plugin", "scripts");
const mjs = (name) => pathToFileURL(path.join(scripts, "lib", name)).href;
const companionSrc = fs.readFileSync(path.join(scripts, "codex-companion.mjs"), "utf8");

const ANSWER = [
  "Fixed the retry loop.",
  "",
  "## Summary",
  "The uploader now retries 3 times.",
  "",
  "## Changed files",
  "- src/upload.js",
  "",
  "## Checks run",
  "npm test (green)",
  "",
  "## Needs decision",
  "Should the old API stay? Options: keep it (recommended), delete it."
].join("\n");

test("readNeedsDecision finds a real question and ignores empty answers", async () => {
  const { readNeedsDecision } = await import(mjs("render.mjs"));
  assert.equal(readNeedsDecision(ANSWER), "Should the old API stay? Options: keep it (recommended), delete it.");
  assert.equal(readNeedsDecision(ANSWER.replace(/\n/g, "\r\n")), "Should the old API stay? Options: keep it (recommended), delete it.");
  assert.equal(readNeedsDecision("### Needs Decision:\nPick a name?\n## Other\nx"), "Pick a name?");
  assert.equal(readNeedsDecision("**Needs decision:**\nPick a name?"), "Pick a name?");
  for (const empty of ["None", "none.", "-", "N/A", ""]) {
    assert.equal(readNeedsDecision(`## Summary\nok\n## Needs decision\n${empty}`), null, `"${empty}" is not a question`);
  }
  assert.equal(readNeedsDecision("No headings at all."), null);
  assert.equal(readNeedsDecision(`## Needs decision\n${"q".repeat(3000)}`).length, 1000);
});

test("extractSection stops at the next heading", async () => {
  const { extractSection } = await import(mjs("render.mjs"));
  assert.equal(extractSection(ANSWER, "Summary"), "The uploader now retries 3 times.");
  assert.equal(extractSection(ANSWER, "Missing"), null);
});

test("a task result lists recorded edits and the thread, a stored result lists the edits", async () => {
  const { renderTaskResult, renderStoredJobResult } = await import(mjs("render.mjs"));
  const text = renderTaskResult({ rawOutput: ANSWER }, { threadId: "thr-1", touchedFiles: ["src/upload.js"] });
  assert.ok(text.startsWith(ANSWER), "the answer comes first, unchanged");
  assert.match(text, /Recorded file edits \(patch tool only, shell edits are not listed\):\n- src\/upload\.js/);
  assert.match(text, /Codex thread: thr-1/);
  assert.equal(renderTaskResult({ rawOutput: "done" }, {}), "done\n", "no edits and no thread add nothing");

  const stored = renderStoredJobResult(
    { id: "task-1", status: "completed" },
    { threadId: "thr-1", result: { rawOutput: ANSWER, touchedFiles: ["src/upload.js"] } }
  );
  assert.match(stored, /- src\/upload\.js/);
  assert.equal(stored.match(/thr-1/g).length, 2, "session id and resume command, no extra thread line");
});

test("withReturnFormat adds the footer, but never to a stop-gate review", () => {
  const context = { STOP_REVIEW_TASK_MARKER: "Run a stop-gate review of the previous Claude turn." };
  vm.runInNewContext(companionSrc.match(/function withReturnFormat[\s\S]*?\n\}/)[0], context);
  assert.equal(context.withReturnFormat("Fix it", "FOOTER"), "Fix it\n\nFOOTER");
  const gate = "<task>\nRun a stop-gate review of the previous Claude turn.\n</task>";
  assert.equal(context.withReturnFormat(gate, "FOOTER"), gate);
});

test("runTrackedJob stores needsDecision on both job stores", async () => {
  process.env.CODEX_COMPANION_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clv-task-result-"));
  process.env.CODEX_VIEWER_PORT = "1";
  const { runTrackedJob } = await import(mjs("tracked-jobs.mjs"));
  const { listJobs, readJobFile, resolveJobFile } = await import(mjs("state.mjs"));
  const ws = process.cwd();
  await runTrackedJob(
    { id: "job-q-1", workspaceRoot: ws, title: "Question task" },
    async () => ({ exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "", summary: "ok", needsDecision: "Keep the API?" }),
    { heartbeatMs: 25 }
  );
  assert.equal(listJobs(ws).find((j) => j.id === "job-q-1").needsDecision, "Keep the API?");
  assert.equal(readJobFile(resolveJobFile(ws, "job-q-1")).needsDecision, "Keep the API?");
  await runTrackedJob(
    { id: "job-q-2", workspaceRoot: ws, title: "Plain task" },
    async () => ({ exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "", summary: "ok", needsDecision: null }),
    { heartbeatMs: 25 }
  );
  assert.equal("needsDecision" in listJobs(ws).find((j) => j.id === "job-q-2"), false);
  delete process.env.CODEX_COMPANION_STATE_ROOT;
  delete process.env.CODEX_VIEWER_PORT;
});
