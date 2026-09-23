const assert = require("node:assert/strict");
const { execFile, spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");

// CloudCLI runs Claude in one fixed folder and targets others with `task --cwd`.
// Those jobs live in the target folder's state; the launcher keeps a pointer, so
// the prompt hook, status and result still find them from the launcher folder.

const run = promisify(execFile);
const scripts = path.join(__dirname, "..", "plugin", "scripts");
const companion = path.join(scripts, "codex-companion.mjs");
const hook = path.join(scripts, "pending-jobs-hook.mjs");
const stateUrl = pathToFileURL(path.join(scripts, "lib", "state.mjs")).href;

// A codex stand-in: it passes the availability checks, then its app-server dies at
// once, so the detached worker records a real failed job without any network.
function writeFakeCodex(dir) {
  fs.writeFileSync(
    path.join(dir, "codex"),
    '#!/bin/sh\n[ "$1" = "--version" ] && { echo codex-cli 0.0.0; exit 0; }\n[ "$2" = "--help" ] && exit 0\necho "fake app-server refuses" >&2\nexit 1\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(dir, "codex.cmd"),
    '@echo off\r\nif "%1"=="--version" (echo codex-cli 0.0.0& exit /b 0)\r\nif "%2"=="--help" exit /b 0\r\necho fake app-server refuses 1>&2\r\nexit /b 1\r\n'
  );
}

let seq = 0;
async function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "clv-cwd-"));
  const dirs = {};
  for (const name of ["launcher", "target", "other", "bin", "state"]) {
    dirs[name] = path.join(base, name);
    fs.mkdirSync(dirs[name]);
  }
  writeFakeCodex(dirs.bin);
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const env = {
    ...process.env,
    [pathKey]: `${dirs.bin}${path.delimiter}${process.env[pathKey] ?? ""}`,
    CODEX_COMPANION_STATE_ROOT: dirs.state,
    CODEX_VIEWER_PORT: "1"
  };
  delete env.CODEX_COMPANION_SESSION_ID;
  process.env.CODEX_COMPANION_STATE_ROOT = dirs.state;
  const state = await import(`${stateUrl}?cwd=${seq++}`);
  const companionRun = (args) => run(process.execPath, [companion, ...args], { cwd: dirs.launcher, env });
  const hookRun = () =>
    spawnSync(process.execPath, [hook], {
      cwd: dirs.launcher,
      env,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8"
    });
  return { dirs, state, companionRun, hookRun };
}

test("a --cwd job reaches the launcher's hook once, and status and result find it", async () => {
  const { dirs, state, companionRun, hookRun } = await setup();

  // A finished job in a workspace nothing points at: never this launcher's business.
  state.upsertJob(dirs.other, { id: "task-unrelated", status: "completed", title: "Elsewhere", completedAt: new Date().toISOString() });

  // Routing flags ride on the handoff's first line, as /codex:rescue sends them.
  // The native path: on Windows its backslashes must survive the lift.
  await assert.rejects(
    companionRun(["task", "--background", "--json", `--cwd "${path.join(dirs.target, "missing")}"\nPrint 1 to 5 in order`]),
    (error) => error.stderr.includes(`--cwd folder does not exist: ${path.join(dirs.target, "missing")}`)
  );
  const launched = await companionRun(["task", "--background", "--json", `--cwd "${dirs.target}"\nPrint 1 to 5 in order`]);
  const { jobId } = JSON.parse(launched.stdout);
  assert.ok(jobId, launched.stdout);
  assert.ok(state.loadState(dirs.target).jobs.some((job) => job.id === jobId), "the job lives in the target workspace");
  assert.equal(state.loadState(dirs.launcher).jobs.length, 0, "the launcher holds a pointer, not a copy");

  const waited = await companionRun(["status", jobId, "--wait", "--timeout-ms", "30000", "--json"]);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.id, jobId);
  assert.equal(snapshot.job.status, "failed", "the fake app-server ends the run");

  const first = hookRun();
  fs.writeFileSync(path.join(dirs.state, "hook-first-run.txt"), first.stdout);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`${jobId}  failed`));
  assert.equal(first.stdout.includes("task-unrelated"), false, "no pointer, no delivery");

  const second = hookRun();
  assert.equal(second.stdout.includes(jobId), false, "delivered once");
  assert.ok(state.loadState(dirs.target).jobs.find((job) => job.id === jobId).announcedAt, "marked in the job's own workspace");

  const result = JSON.parse((await companionRun(["result", jobId, "--json"])).stdout);
  assert.equal(result.job.id, jobId);
  assert.equal(result.storedJob.status, "failed");
});

test("a corrupt pointer file never breaks the hook, and pointers to deleted jobs are pruned", async () => {
  const { dirs, state, hookRun, companionRun } = await setup();
  state.upsertJob(dirs.launcher, { id: "task-own", status: "completed", title: "Own job", completedAt: new Date().toISOString() });
  const pointersFile = state.resolvePointersFile(dirs.launcher);

  fs.writeFileSync(pointersFile, "{not json");
  const corrupt = hookRun();
  assert.equal(corrupt.status, 0, corrupt.stderr);
  assert.match(corrupt.stdout, /task-own  completed/, "the launcher's own jobs still arrive");

  // A live pointer next to one whose job is gone, plus junk entries.
  const live = { id: "task-live", status: "completed", title: "Live", completedAt: new Date().toISOString() };
  state.writeJobFile(dirs.target, live.id, live);
  state.upsertJob(dirs.target, live);
  fs.writeFileSync(pointersFile, JSON.stringify([
    { jobId: "task-gone", workspaceRoot: dirs.target },
    { jobId: "task-live", workspaceRoot: dirs.target },
    { jobId: "task-nowhere", workspaceRoot: path.join(dirs.target, "deleted-folder") },
    5, null, { jobId: 7 }, { jobId: "task-no-root" }
  ]));
  const pruned = hookRun();
  assert.equal(pruned.status, 0, pruned.stderr);
  assert.match(pruned.stdout, /task-live  completed/);
  assert.equal(/task-gone|task-nowhere/.test(pruned.stdout), false);
  assert.deepEqual(state.readJobPointers(dirs.launcher).map((pointer) => pointer.jobId), ["task-live"]);

  await assert.rejects(companionRun(["result", "task-gone", "--json"]), /No job found for "task-gone"/);
});

// A worker stand-in that stops safely the way the real one does: it sees
// cancelRequested on its job file and marks the job cancelled.
const SAFE_STOP_WORKER = `
const fs = require("node:fs");
const file = process.argv[1];
setInterval(() => {
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!job.cancelRequested) return;
  fs.writeFileSync(file, JSON.stringify({ ...job, status: "cancelled", pid: null }));
  process.exit(0);
}, 50);
setTimeout(() => process.exit(1), 20000);
`;

test("cancel finds a --cwd job from the launcher folder", async () => {
  const { dirs, state, companionRun } = await setup();
  const job = { id: "task-cancel-me", status: "running", title: "Long run", workspaceRoot: dirs.target, startedAt: new Date().toISOString() };
  const jobFile = state.writeJobFile(dirs.target, job.id, job);
  const worker = spawn(process.execPath, ["-e", SAFE_STOP_WORKER, jobFile], { stdio: "ignore" });
  try {
    state.writeJobFile(dirs.target, job.id, { ...job, pid: worker.pid });
    state.upsertJob(dirs.target, { ...job, pid: worker.pid });
    state.addJobPointer(dirs.launcher, job.id, dirs.target);

    const payload = JSON.parse((await companionRun(["cancel", job.id, "--json"])).stdout);
    assert.equal(payload.jobId, job.id);
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.stopMode, "safe");
    assert.equal(state.readJobFile(jobFile).cancelRequested, true, "the request landed in the job's own workspace");
  } finally {
    worker.kill();
  }
});

// Counts every git spawn in the hook process. The hook spawns git to resolve a
// workspace, so this is what its cost per prompt scales with.
function gitCounter(dir) {
  const counter = path.join(dir, "count-git.cjs");
  const countFile = path.join(dir, "git-count.txt");
  fs.writeFileSync(counter, `
const cp = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const original = cp.spawnSync;
cp.spawnSync = function (command, ...rest) {
  if (command === "git") require("node:fs").appendFileSync(${JSON.stringify(countFile)}, "x");
  return original.call(this, command, ...rest);
};
syncBuiltinESMExports();
`);
  return { counter, count: () => (fs.existsSync(countFile) ? fs.readFileSync(countFile, "utf8").length : 0), reset: () => fs.rmSync(countFile, { force: true }) };
}

test("the hook's git calls grow with target folders, not with pointers", async () => {
  const { dirs, state } = await setup();
  const base = path.dirname(dirs.launcher);
  const few = path.join(base, "few");
  const many = path.join(base, "many");
  fs.mkdirSync(few);
  fs.mkdirSync(many);
  const done = new Date().toISOString();
  for (let i = 0; i < 20; i++) {
    const root = i % 2 ? dirs.target : dirs.other;
    const job = { id: `task-p${i}`, status: "completed", completedAt: done, announcedAt: done };
    state.writeJobFile(root, job.id, job);
    state.upsertJob(root, job);
    if (i < 2) state.addJobPointer(few, job.id, root);
    state.addJobPointer(many, job.id, root);
  }
  const git = gitCounter(dirs.state);
  const runIn = (cwd) => {
    git.reset();
    const run = spawnSync(process.execPath, [hook], {
      cwd,
      env: { ...process.env, CODEX_COMPANION_STATE_ROOT: dirs.state, CODEX_VIEWER_PORT: "1", NODE_OPTIONS: `--require "${git.counter.split(path.sep).join("/")}"` },
      input: "{}",
      encoding: "utf8"
    });
    assert.equal(run.status, 0, run.stderr);
    return git.count();
  };
  const fewCount = runIn(few);
  assert.ok(fewCount > 0, "the counter sees the hook's git calls");
  assert.equal(runIn(many), fewCount, "20 pointers into 2 folders cost what 2 pointers do");
});
