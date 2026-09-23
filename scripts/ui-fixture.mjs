#!/usr/bin/env node
// UI fixture harness for the viewer-ui-rework tasks (Task 0).
//
// Builds a throwaway CODEX_HOME + companion state root under os.tmpdir()
// with 13 sessions/jobs that exercise every session/job status the UI
// renders, then spawns `codex-live-viewer.js serve` pointed at them.
//
// Usage:
//   node scripts/ui-fixture.mjs
// Prints the viewer URL, then keeps running (Ctrl+C stops it and the
// spawned viewer). Fixture files live under a temp dir; nothing under
// ~/.codex or ~/.codex-companion is ever touched.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const PORT = 8399;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ui-fixture-"));
const CODEX_HOME = path.join(root, "codex-home");
const STATE_ROOT = path.join(root, "companion-state");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const ARCHIVED_DIR = path.join(CODEX_HOME, "archived_sessions");
const WORKSPACE_CWD = path.join(root, "workspace"); // never needs to exist on disk

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(ARCHIVED_DIR, { recursive: true });
fs.mkdirSync(STATE_ROOT, { recursive: true });

const now = Date.now();
let uidCounter = 0;
function uuid() {
  uidCounter += 1;
  return `11111111-1111-4111-8111-${String(uidCounter).padStart(12, "0")}`;
}

// ---- rollout line builders (schema matches codex-live-viewer.js's simplify()) ----
function metaLine(ts, { id, cwd, model = "gpt-5", parentThreadId, agentNickname }) {
  const payload = { id, timestamp: new Date(ts).toISOString(), cwd, model, originator: "codex_cli", cli_version: "0.98.0" };
  if (parentThreadId) payload.parent_thread_id = parentThreadId;
  if (agentNickname) payload.agent_nickname = agentNickname;
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "session_meta", payload });
}
function userLine(ts, message) {
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "event_msg", payload: { type: "user_message", message } });
}
function agentLine(ts, message) {
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "event_msg", payload: { type: "agent_message", message } });
}
function cmdLine(ts, command) {
  return JSON.stringify({
    timestamp: new Date(ts).toISOString(), type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", command] }) },
  });
}
function patchLine(ts, files) {
  const patch = files.map(f => `*** Update File: ${f}\n@@\n-old\n+new`).join("\n");
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "response_item", payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ patch }) } });
}
function thinkLine(ts, text) {
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "response_item", payload: { type: "reasoning", summary: [{ text }] } });
}
function doneLine(ts) {
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "event_msg", payload: { type: "task_complete" } });
}
function abortedLine(ts) {
  return JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "event_msg", payload: { type: "turn_aborted" } });
}

function rolloutPath(dir, ts, id) {
  const d = new Date(ts);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const stamp = d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const day = path.join(dir, yyyy, mm, dd);
  fs.mkdirSync(day, { recursive: true });
  return path.join(day, `rollout-${stamp}-${id}.jsonl`);
}

function writeRollout(dir, ts, id, lines, mtime) {
  const file = rolloutPath(dir, ts, id);
  fs.writeFileSync(file, lines.filter(Boolean).join("\n") + "\n", "utf8");
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

const MARKDOWN_ANSWER = [
  "## Summary",
  "Did the thing.",
  "",
  "## Changes",
  "- Added a fixture harness",
  "- Wired it to the viewer",
  "",
  "## Needs decision",
  "Should the harness also cover the archived-session sweep, or is that Task 11's job?",
  "",
  "## Verification",
  "```js",
  "npm test // 194/194",
  "```",
  "",
  "<script>alert(1)</script>",
].join("\n");

const PLAIN_ANSWER = "Done. Ran the migration, verified the row count matches, nothing else needed.";

// ---------------- 1. Running session ----------------
{
  const id = uuid();
  const ts = now - 5000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 1 - running session with commands and a patch"),
    thinkLine(ts + 100, "Looking at the fixture harness requirements."),
    cmdLine(ts + 200, "npm test"),
    patchLine(ts + 300, ["scripts/ui-fixture.mjs"]),
    agentLine(ts + 400, MARKDOWN_ANSWER),
  ], now); // mtime = now => LIVE
}

// ---------------- 2. Waiting interactive session ----------------
{
  const id = uuid();
  const ts = now - 11 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 2 - waiting interactive session, no job"),
    agentLine(ts + 100, "Sitting here waiting for the next prompt."),
  ], ts); // quiet 10 min, no job => IDLE
}

// ---------------- 3. Aborted session ----------------
{
  const id = uuid();
  const ts = now - 2 * 60 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 3 - aborted session, no job"),
    cmdLine(ts + 100, "long-running-thing"),
    abortedLine(ts + 200),
  ], ts); // quiet 2h, no job; last event turn_aborted
}

const jobs = [];
const jobFiles = new Map(); // jobId -> full record written to jobs/<id>.json

function addJob(job) {
  jobs.push(job);
  jobFiles.set(job.id, job);
  return job;
}

// ---------------- 4. Finished handoff with headings + question ----------------
{
  const id = uuid();
  const ts = now - 30 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 4 - finished handoff with headings"),
    agentLine(ts + 100, MARKDOWN_ANSWER),
    doneLine(ts + 200),
  ], ts + 200);
  addJob({
    id: `job-fixture-04`, cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 4 - finished handoff with headings",
    status: "completed", pid: null, threadId: id, sessionId: "fixture-session",
    summary: "Fixture harness done, one open question.",
    needsDecision: "Should the harness also cover the archived-session sweep, or is that Task 11's job?",
    result: { rawOutput: MARKDOWN_ANSWER, touchedFiles: ["scripts/ui-fixture.mjs", "scripts/ui-shots.js"] },
    rendered: MARKDOWN_ANSWER,
    createdAt: new Date(ts).toISOString(), updatedAt: new Date(ts + 200).toISOString(), completedAt: new Date(ts + 200).toISOString(),
  });
}

// ---------------- 5. Finished handoff, plain answer ----------------
{
  const id = uuid();
  const ts = now - 25 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 5 - finished handoff, plain answer"),
    agentLine(ts + 100, PLAIN_ANSWER),
    doneLine(ts + 200),
  ], ts + 200);
  addJob({
    id: `job-fixture-05`, cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 5 - finished handoff, plain answer",
    status: "completed", pid: null, threadId: id, sessionId: "fixture-session",
    summary: "Migration verified, nothing else needed.",
    result: { rawOutput: PLAIN_ANSWER, touchedFiles: [] },
    rendered: PLAIN_ANSWER,
    createdAt: new Date(ts).toISOString(), updatedAt: new Date(ts + 200).toISOString(), completedAt: new Date(ts + 200).toISOString(),
  });
}

// ---------------- 6. Handoff resumed twice: one session, three jobs ----------------
{
  const id = uuid();
  const ts = now - 20 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 6 - handoff resumed twice"),
    agentLine(ts + 100, "First pass done."),
    agentLine(ts + 500, "Resumed, second pass done."),
    agentLine(ts + 900, "Resumed again, final pass done."),
    doneLine(ts + 1000),
  ], ts + 1000);
  for (let n = 1; n <= 3; n++) {
    addJob({
      id: `job-fixture-06-${n}`, cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 6 - handoff resumed twice",
      status: "completed", pid: null, threadId: id, sessionId: "fixture-session",
      summary: `Pass ${n} of 3 complete.`,
      result: { rawOutput: `Pass ${n} of 3 complete.`, touchedFiles: [] },
      rendered: `Pass ${n} of 3 complete.`,
      createdAt: new Date(ts + n * 100).toISOString(), updatedAt: new Date(ts + n * 400).toISOString(), completedAt: new Date(ts + n * 400).toISOString(),
    });
  }
}

// ---------------- 7. Queued job, no session file ----------------
addJob({
  id: "job-fixture-07", cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 7 - queued job, no session",
  status: "queued", pid: null, threadId: null, sessionId: "fixture-session",
  createdAt: new Date(now - 60 * 1000).toISOString(), updatedAt: new Date(now - 60 * 1000).toISOString(),
});

// ---------------- 8. Dead job on a quiet session ----------------
{
  const id = uuid();
  const ts = now - 15 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 8 - dead job, needs attention"),
    agentLine(ts + 100, "Working on it..."),
  ], ts + 100);
  addJob({
    id: "job-fixture-08", cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 8 - dead job, needs attention",
    status: "running", pid: 999999, threadId: id, sessionId: "fixture-session", // pid does not exist => dead
    heartbeatAt: new Date(ts + 100).toISOString(),
    createdAt: new Date(ts).toISOString(), updatedAt: new Date(ts + 100).toISOString(),
  });
}

// ---------------- 9. Possibly-stuck job (live pid = this fixture process) ----------------
{
  const id = uuid();
  const ts = now - 12 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 9 - possibly-stuck job"),
    agentLine(ts + 100, "Still going, heartbeat is old."),
  ], ts + 100);
  addJob({
    id: "job-fixture-09", cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 9 - possibly-stuck job",
    status: "running", pid: process.pid, threadId: id, sessionId: "fixture-session", // alive: this very process
    heartbeatAt: new Date(now - 10 * 60 * 1000).toISOString(), // 10 min old => possibly-stuck
    createdAt: new Date(ts).toISOString(), updatedAt: new Date(ts + 100).toISOString(),
  });
}

// ---------------- 10. Fast job ----------------
{
  const id = uuid();
  const ts = now - 18 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 10 - fast job"),
    agentLine(ts + 100, "Priority tier, finished quickly."),
    doneLine(ts + 200),
  ], ts + 200);
  addJob({
    id: "job-fixture-10", cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 10 - fast job",
    status: "completed", pid: null, threadId: id, sessionId: "fixture-session", fast: true,
    summary: "Priority tier, finished quickly.",
    result: { rawOutput: "Priority tier, finished quickly.", touchedFiles: [] },
    rendered: "Priority tier, finished quickly.",
    createdAt: new Date(ts).toISOString(), updatedAt: new Date(ts + 200).toISOString(), completedAt: new Date(ts + 200).toISOString(),
  });
}

// ---------------- 11. Cancelled job ----------------
{
  const id = uuid();
  const ts = now - 22 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 11 - cancelled job"),
    agentLine(ts + 100, "Started, then got cancelled."),
  ], ts + 100);
  addJob({
    id: "job-fixture-11", cwd: WORKSPACE_CWD, kind: "task", title: "Fixture 11 - cancelled job",
    status: "cancelled", pid: null, threadId: id, sessionId: "fixture-session",
    errorMessage: "Cancelled by user.",
    createdAt: new Date(ts).toISOString(), updatedAt: new Date(ts + 100).toISOString(), completedAt: new Date(ts + 100).toISOString(),
  });
}

// ---------------- 12. Archived session ----------------
{
  const id = uuid();
  const ts = now - 3 * 60 * 60 * 1000;
  writeRollout(ARCHIVED_DIR, ts, id, [
    metaLine(ts, { id, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 12 - archived session"),
    agentLine(ts + 100, "Archived after finishing."),
    doneLine(ts + 200),
  ], ts + 200);
}
// (the "dismissed session" half of fixture 12 is a browser pref - ui-shots.js
// sets it via localStorage against fixture 2's session id)

// ---------------- 13. Lead session with 2 child agents ----------------
{
  const leadId = uuid();
  const ts = now - 8 * 60 * 1000;
  writeRollout(SESSIONS_DIR, ts, leadId, [
    metaLine(ts, { id: leadId, cwd: WORKSPACE_CWD }),
    userLine(ts, "Task: Fixture 13 - lead session with 2 child agents"),
    agentLine(ts + 100, "Dispatching two child agents."),
  ], ts + 100);
  for (const nick of ["alpha", "beta"]) {
    const childId = uuid();
    const cts = ts + 200;
    writeRollout(SESSIONS_DIR, cts, childId, [
      metaLine(cts, { id: childId, cwd: WORKSPACE_CWD, parentThreadId: leadId, agentNickname: nick }),
      userLine(cts, `Task: Fixture 13 child ${nick}`),
      agentLine(cts + 100, `Child ${nick} working.`),
    ], cts + 100);
  }
}

// ---------------- write companion state ----------------
const STATE_DIR_NAME = "fixture-workspace-0000000000000000";
const stateDir = path.join(STATE_ROOT, STATE_DIR_NAME);
const jobsDir = path.join(stateDir, "jobs");
fs.mkdirSync(jobsDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: { stopReviewGate: false }, jobs }, null, 2) + "\n", "utf8");
for (const [jobId, record] of jobFiles) {
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
}

console.log(`[ui-fixture] fixtures written under ${root}`);

// ---------------- spawn the viewer ----------------
const child = spawn(process.execPath, [path.join(REPO_ROOT, "codex-live-viewer.js"), "serve"], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    CODEX_HOME,
    CODEX_COMPANION_STATE_ROOT: STATE_ROOT,
    CODEX_VIEWER_PORT: String(PORT),
    CODEX_VIEWER_AUTOSTART: "0",
  },
  stdio: "inherit",
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  try { child.kill(); } catch {}
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => { if (!stopping) process.exit(code ?? 0); });

console.log(`[ui-fixture] viewer at http://127.0.0.1:${PORT}`);
console.log(`[ui-fixture] fixture root: ${root}`);
