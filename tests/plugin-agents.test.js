const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "..", "plugin", "scripts");
const mjs = (name) => pathToFileURL(path.join(root, "lib", name)).href;
const companionSrc = fs.readFileSync(path.join(root, "codex-companion.mjs"), "utf8");

function companionSlice() {
  const slice = [
    companionSrc.match(/function shorten\(text, limit = 96\) \{[\s\S]*?\n\}/)[0],
    companionSrc.match(/function buildTaskRunMetadata[\s\S]*?\n\}/)[0],
    companionSrc.match(/function taskTitleFromPrompt[\s\S]*?\n\}/)[0]
  ].join("\n");
  const context = { STOP_REVIEW_TASK_MARKER: "Run a stop-gate review of the previous Claude turn.", DEFAULT_CONTINUE_PROMPT: "Continue." };
  vm.runInNewContext(slice, context);
  return context;
}

// Every job used to be titled "Codex Task", which made the dashboard list and
// /codex:status unreadable. The title now comes from the prompt.
test("task title comes from the first meaningful prompt line", () => {
  const { buildTaskRunMetadata } = companionSlice();
  assert.equal(buildTaskRunMetadata({ prompt: "Fix the flaky login test\n\nDetails..." }).title, "Fix the flaky login test");
  assert.equal(
    buildTaskRunMetadata({ prompt: "Dispatch flags: --model sol --effort high\n\nBinding contract: D:\\x\\coding.md\n\nFollow handoff/coding.md (binding). Task: add retry to the uploader" }).title,
    "add retry to the uploader"
  );
  assert.equal(buildTaskRunMetadata({ prompt: "<task>\nRename the config key\n</task>" }).title, "Rename the config key");
  assert.equal(buildTaskRunMetadata({ prompt: "" }).title, "Codex Task");
  assert.equal(buildTaskRunMetadata({ prompt: "", resumeLast: true }).title, "Codex Resume");
  assert.equal(buildTaskRunMetadata({ prompt: "x".repeat(200) }).title.length, 80);
  assert.equal(buildTaskRunMetadata({ prompt: "Run a stop-gate review of the previous Claude turn." }).title, "Codex Stop Gate Review");
});

test("collectAgentLabels lists child agents by nickname, never the root thread", async () => {
  const { collectAgentLabels } = await import(mjs("codex.mjs"));
  const state = {
    threadId: "root",
    rootThreadId: "root",
    threadIds: new Set(["root", "c1", "c2"]),
    threadLabels: new Map([["c1", "Kierkegaard"]])
  };
  assert.deepEqual(collectAgentLabels(state), ["Kierkegaard", "c2"]);
  assert.deepEqual(collectAgentLabels({ threadId: "root", rootThreadId: "root", threadIds: new Set(["root"]), threadLabels: new Map() }), []);
});

test("runTrackedJob stores the agents a run used on the job record", async () => {
  process.env.CODEX_COMPANION_STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "clv-agents-"));
  const { runTrackedJob } = await import(mjs("tracked-jobs.mjs"));
  const { listJobs, readJobFile, resolveJobFile } = await import(mjs("state.mjs"));
  const ws = process.cwd();
  const job = { id: "job-agents-1", workspaceRoot: ws, title: "Agent task" };
  await runTrackedJob(
    job,
    async () => ({ exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "", summary: "ok", agents: ["Kierkegaard", "Wegener"] }),
    { heartbeatMs: 25 }
  );
  const stored = listJobs(ws).find((j) => j.id === "job-agents-1");
  assert.deepEqual(stored.agents, ["Kierkegaard", "Wegener"]);
  assert.deepEqual(readJobFile(resolveJobFile(ws, "job-agents-1")).agents, ["Kierkegaard", "Wegener"]);
  const plain = { id: "job-agents-2", workspaceRoot: ws, title: "Solo task" };
  await runTrackedJob(plain, async () => ({ exitStatus: 0, threadId: "t", turnId: "u", payload: {}, rendered: "", summary: "ok", agents: [] }), { heartbeatMs: 25 });
  assert.equal("agents" in listJobs(ws).find((j) => j.id === "job-agents-2"), false);
  delete process.env.CODEX_COMPANION_STATE_ROOT;
});

// A caller pasted "--model astra --effort high" as the first prompt line. The
// run then ignored the flags and the job was titled after them.
test("liftInlineFlags moves leading flag lines out of the prompt", async () => {
  const { splitRawArgumentString } = await import(mjs("args.mjs"));
  const context = { splitRawArgumentString };
  vm.runInNewContext(companionSrc.match(/function liftInlineFlags[\s\S]*?\n\}/)[0], context);
  const lifted = context.liftInlineFlags("--model astra --effort high\nTask: fix unit 5\n\nDetails");
  assert.deepEqual(JSON.parse(JSON.stringify(lifted.flags)), ["--model", "astra", "--effort", "high"]);
  assert.equal(lifted.prompt, "Task: fix unit 5\n\nDetails");
  assert.equal(context.liftInlineFlags("Task: plain\n--not a flag line").flags.length, 0);
  assert.match(companionSrc, /options\[key\] \?\?= value;/);
});
