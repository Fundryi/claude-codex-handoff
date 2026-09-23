const assert = require("node:assert/strict");
const { execFile, spawnSync } = require("node:child_process");
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
  const target = dirs.target.split(path.sep).join("/");
  const launched = await companionRun(["task", "--background", "--json", `--cwd "${target}"\nPrint 1 to 5 in order`]);
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
