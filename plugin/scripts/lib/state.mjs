import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";
import { jobLooksDead } from "./liveness.mjs";

const STATE_VERSION = 1;
export const STATE_ROOT_ENV = "CODEX_COMPANION_STATE_ROOT";
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const POINTERS_FILE_NAME = "job-pointers.json";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateRoot() {
  // ponytail: one fixed shared root for CLI + viewer; CLAUDE_PLUGIN_DATA
  // intentionally ignored so both sides always see the same jobs.
  return process.env[STATE_ROOT_ENV] || path.join(os.homedir(), ".codex-companion", "state");
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const stateRoot = resolveStateRoot();
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  return readState(resolveStateFile(cwd));
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  return writeState(resolveStateDir(cwd), state);
}

// Takes the resolved dir: resolving it spawns git, and updateState holds its lock
// across this, so the locked section stays pure file I/O.
function writeState(stateDir, state) {
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  const previousJobs = readState(stateFile).jobs;
  fs.mkdirSync(jobsDir, { recursive: true });
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(path.join(jobsDir, `${job.id}.json`));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(stateFile, `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

// Temp file + rename: a writer killed mid-write leaves the old file, never a torn one
// (readState would read a torn state.json as empty, and the next save would drop every job).
// Windows refuses the rename with EPERM/EBUSY/EACCES while a lock-free reader has the
// target open, so retry briefly.
function writeFileAtomic(file, content) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
        try { fs.unlinkSync(temp); } catch {}
        throw error;
      }
      sleepSync(10);
    }
  }
}

// Cross-process lock for a load-mutate-save of a shared file. Detached workers,
// the prompt hook and the CLI all rewrite state.json; unlocked, one save dropped
// another's completion write and reconcileDeadJobs then stamped a finished job died.
// Updates take milliseconds, so a lock older than LOCK_STALE_MS is a crashed holder's.
// The wait stays above the stale limit (a crashed holder's lock is always broken
// in time) and well under the prompt hook's 5 s timeout.
const LOCK_STALE_MS = 3000;
const LOCK_WAIT_MS = 3500;
// EPERM/EBUSY/EACCES: Windows reports these while a just-unlinked lock is still being deleted.
const LOCK_BUSY_CODES = new Set(["EEXIST", "EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function releaseLock(lock) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.unlinkSync(lock);
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      sleepSync(10);
    }
  }
  // Still there (Windows EPERM/EBUSY): the next writer breaks it as stale.
}

// ponytail: breaking a stale lock is check-then-unlink, so two waiters that both saw
// it stale can both get in, and a holder frozen past LOCK_STALE_MS can release the
// lock its breaker took. Only after a crash or a multi-second freeze; the upgrade
// path is a pid + token in the lock file, checked before unlinking.
function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      held = true;
    } catch (error) {
      if (!LOCK_BUSY_CODES.has(error?.code)) throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {
        // gone already, or mid-delete - just retry
      }
      if (Date.now() >= deadline) break;
      sleepSync(5 + Math.random() * 20);
    }
  }
  // Wait bound hit (a stale lock that will not unlink): run unlocked. Hanging would
  // stall a worker or the prompt hook, and throwing would lose the update - a failed
  // completion write lands in runTrackedJob's catch and records the run as failed.
  // Unlocked is exactly the old behaviour, only for this one write.
  try {
    return fn();
  } finally {
    if (held) releaseLock(lock);
  }
}

// Every state.json load-mutate-save goes through here.
export function updateState(cwd, mutate) {
  const stateDir = resolveStateDir(cwd);
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  return withFileLock(stateFile, () => {
    const state = readState(stateFile);
    mutate(state);
    return writeState(stateDir, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead). EPERM = process exists but we can't signal it
    // (still alive) - treating EPERM as dead would fail live-but-inaccessible work.
    return err?.code === "EPERM";
  }
}

function fileMtimeIso(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return nowIso();
  }
}

const DIED_PATCH = {
  status: "failed",
  phase: "died",
  diedReason: "process-vanished",
  errorMessage: "Worker process exited without recording a result.",
  pid: null
};
const FINISHED_FIELDS = ["status", "phase", "completedAt", "exitCode", "errorMessage", "diedReason", "stderrTail", "threadId", "turnId", "agents", "needsDecision"];

// The job file is written before state.json, so a finished run can be on record
// there while its state.json entry still says running (the state write failed or,
// before the lock, was clobbered).
function finishedRun(stored) {
  return Boolean(stored) && ["completed", "failed", "cancelled"].includes(stored.status) &&
    (Boolean(stored.completedAt) || typeof stored.exitCode === "number");
}

// A worker killed by SIGKILL/taskkill never reaches runTrackedJob's catch block,
// so its record freezes at "running" forever and permanently jams resolveResultJob.
// Nothing else will ever correct it, so reads do.
export function reconcileDeadJobs(cwd) {
  // Unlocked fast path: every read lands here and almost always nothing died.
  if (!loadState(cwd).jobs.some((job) => jobLooksDead(job, pidAlive(job.pid)))) {
    return [];
  }

  // Decided again under the lock on fresh state, so a worker write that landed
  // since the check above is never stamped over. Job paths come from jobsDir, not
  // resolveJobFile: that spawns git, and after a reboot every job is dead at once.
  const jobsDir = resolveJobsDir(cwd);
  const reconciled = [];
  updateState(cwd, (state) => {
    state.jobs = state.jobs.map((job) => {
      if (!jobLooksDead(job, pidAlive(job.pid))) return job;
      reconciled.push(job.id);
      const jobFile = path.join(jobsDir, `${job.id}.json`);
      // A torn job file (worker killed mid-write) counts as no record: throwing here
      // would jam every listJobs for the workspace until someone fixed the file by hand.
      let stored = null;
      try {
        if (fs.existsSync(jobFile)) stored = readJobFile(jobFile);
      } catch {}
      if (finishedRun(stored)) {
        // The run did finish: state.json takes the job file's outcome, the file stays as is.
        const outcome = Object.fromEntries(FINISHED_FIELDS.filter((key) => key in stored).map((key) => [key, stored[key]]));
        return { ...job, ...outcome, pid: null };
      }
      // Same stamp lands in both stores - job-file mtime approximates when the worker
      // actually stopped, which enrichJob's elapsed/duration math reads from state.json.
      const died = { ...DIED_PATCH, completedAt: fileMtimeIso(jobFile) };
      if (stored) fs.writeFileSync(jobFile, `${JSON.stringify({ ...stored, ...died }, null, 2)}\n`, "utf8");
      return { ...job, ...died };
    });
  });

  return reconciled;
}

export function listJobs(cwd) {
  reconcileDeadJobs(cwd);
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

// Job files take a per-job lock: the worker's progress/heartbeat patches and
// /codex:cancel (another process) both rewrite the file, and an unlocked stale
// snapshot erased cancelRequested. Plain writeFileSync, not writeFileAtomic: a
// Windows rename fails with EPERM while a lock-free reader (viewer, shouldCancel,
// waitForJobSettled) has the file open, and those readers already retry torn reads.
// Paths resolve outside the lock (resolveJobFile spawns git).
export function writeJobFile(cwd, jobId, payload) {
  const jobFile = resolveJobFile(cwd, jobId);
  withFileLock(jobFile, () => fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8"));
  return jobFile;
}

// Locked read-merge-write of one job file, so a patch never overwrites fields
// another process wrote since. A missing file stays missing (returns null).
export function patchJobFile(cwd, jobId, patch) {
  const jobFile = resolveJobFile(cwd, jobId);
  return withFileLock(jobFile, () => {
    if (!fs.existsSync(jobFile)) return null;
    const next = { ...readJobFile(jobFile), ...patch };
    fs.writeFileSync(jobFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  });
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

// A job started with --cwd lives in the target workspace's state. The launcher
// workspace (where Claude runs; under CloudCLI it can never cd) keeps a pointer to
// it, so its prompt hook, status and result still find the job. Newest first,
// capped at MAX_JOBS like the jobs themselves.
export function resolvePointersFile(cwd) {
  return path.join(resolveStateDir(cwd), POINTERS_FILE_NAME);
}

// Missing or corrupt file: no pointers. Bad entries are skipped, never fatal.
export function readJobPointers(cwd) {
  return readPointersFile(resolvePointersFile(cwd));
}

function readPointersFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : []).filter(
    (entry) => entry && typeof entry.jobId === "string" && entry.jobId && typeof entry.workspaceRoot === "string" && entry.workspaceRoot
  ).map(({ jobId, workspaceRoot }) => ({ jobId, workspaceRoot }));
}

// Read-modify-write under the same kind of lock as state.json, so two launches in
// the same instant keep both pointers. The atomic write means lock-free readers
// see the old file or the new one, never a torn one.
export function updateJobPointers(cwd, mutate) {
  const file = resolvePointersFile(cwd);
  withFileLock(file, () => {
    writeFileAtomic(file, `${JSON.stringify(mutate(readPointersFile(file)).slice(0, MAX_JOBS), null, 2)}\n`);
  });
}

export function addJobPointer(cwd, jobId, workspaceRoot) {
  updateJobPointers(cwd, (pointers) => [{ jobId, workspaceRoot }, ...pointers.filter((entry) => entry.jobId !== jobId)]);
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
