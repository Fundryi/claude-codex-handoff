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
  assert.equal(buildTaskRunMetadata({ prompt: "<goal>\nAdd retry to the uploader\n</goal>\n<rules>\nNone\n</rules>" }).title, "Add retry to the uploader");
  assert.equal(buildTaskRunMetadata({ prompt: "Follow handoff/coding.md (binding).\n<goal>\nAdd retry\n</goal>" }).title, "Add retry");
});

// The job summary shows in /codex:status and the viewer. With the four return
// headings it used to read "## Summary"; it now reads the Summary text.
test("task summary line reads the Summary section, else the first line", async () => {
  const { extractSection } = await import(mjs("render.mjs"));
  const context = { extractSection };
  vm.runInNewContext(
    [
      companionSrc.match(/function firstMeaningfulLine[\s\S]*?\n\}/)[0],
      companionSrc.match(/function taskSummaryLine[\s\S]*?\n\}/)[0]
    ].join("\n"),
    context
  );
  const { taskSummaryLine } = context;
  assert.equal(taskSummaryLine("Done.\n\n## Summary\nRetry added.", "fb"), "Retry added.");
  assert.equal(taskSummaryLine("## Summary\nRetry added.\n## Checks run\nx", "fb"), "Retry added.");
  assert.equal(taskSummaryLine("plain answer", "fb"), "plain answer");
  assert.equal(taskSummaryLine("", "fb"), "fb");
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
  const { splitLeadingFlags } = await import(mjs("args.mjs"));
  const context = { splitLeadingFlags };
  const config = { valueOptions: ["model", "effort", "cwd"], aliasMap: { C: "cwd" } };
  vm.runInNewContext(companionSrc.match(/function liftInlineFlags[\s\S]*?\n\}/)[0], context);
  const lifted = context.liftInlineFlags("--model astra --effort high\nTask: fix unit 5\n\nDetails", config);
  assert.deepEqual(JSON.parse(JSON.stringify(lifted.flags)), ["--model", "astra", "--effort", "high"]);
  assert.equal(lifted.prompt, "Task: fix unit 5\n\nDetails");
  assert.equal(context.liftInlineFlags("Task: plain\n--not a flag line", config).flags.length, 0);
  // A Windows folder keeps its backslashes, quoted or not (CloudCLI-style routing).
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.liftInlineFlags('--cwd "C:\\Users\\me\\my repo" --write\n--model D:\\GIT\\x\nTask', config).flags)),
    ["--cwd", "C:\\Users\\me\\my repo", "--write", "--model", "D:\\GIT\\x"]
  );
  assert.match(companionSrc, /options\[key\] \?\?= value;/);
});

// A task passed as one string used to be split on every space and joined again:
// line breaks were lost, "Don't" became "Dont", and backslashes vanished.
test("splitLeadingFlags keeps a task prompt byte for byte after its leading flags", async () => {
  const { splitLeadingFlags } = await import(mjs("args.mjs"));
  const config = { valueOptions: ["model", "effort", "cwd"], aliasMap: { m: "model", C: "cwd" } };
  const prompt = "<goal>\nDon't touch C:\\Users\\x \"quoted\" file\n</goal>\n\n  indented, and use --force carefully";
  assert.deepEqual(
    splitLeadingFlags(`--model astra -m sol --cwd "D:\\GIT\\my repo" --write ${prompt}`, config),
    ["--model", "astra", "-m", "sol", "--cwd", "D:\\GIT\\my repo", "--write", prompt]
  );
  assert.deepEqual(splitLeadingFlags("--effort=high fix it", config), ["--effort=high", "fix it"]);
  assert.deepEqual(splitLeadingFlags("--resume", config), ["--resume"]);
  assert.deepEqual(splitLeadingFlags("Don't split me", config), ["Don't split me"]);
  assert.deepEqual(splitLeadingFlags("", config), []);
});
