'use strict';

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { ROOT, COMPANION_STATE_ROOT, jobStateCache } = require("./runtime");

// ---------------- companion job state (shared with the plugin) ----------------
function resolveCompanionScript(baseDir) {
  const candidates = [
    path.join(baseDir, "plugin", "scripts", "codex-companion.mjs"), // repo layout
    path.join(baseDir, "..", "scripts", "codex-companion.mjs"),     // bundled: plugin/viewer/
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}
const COMPANION_SCRIPT = resolveCompanionScript(ROOT);
const STUCK_AFTER_MS = 5 * 60 * 1000; // alive but no heartbeat this long => possibly stuck

function classifyJobLiveness(job, pidIsAlive, now) {
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job.status;
  if (!pidIsAlive) return "dead";
  const beatMs = job.heartbeatAt ? now - Date.parse(job.heartbeatAt) : Infinity;
  // ponytail: heartbeat freshness only; if pid is alive we never flag before
  // STUCK_AFTER_MS, so long-running commands are not misreported as stuck.
  return beatMs < STUCK_AFTER_MS ? "working" : "possibly-stuck";
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Parsed state.json per workspace, reused while its mtime and size hold, for 10 s at most.
// Callers still check pid and heartbeat on every use; the records are read-only.
function listCompanionJobs(fresh, all) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(COMPANION_STATE_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  const now = Date.now();
  const seen = new Set();
  for (const d of dirs) {
    seen.add(d.name);
    try {
      const file = path.join(COMPANION_STATE_ROOT, d.name, "state.json");
      const st = fs.statSync(file);
      let cached = jobStateCache.get(d.name);
      if (fresh || !cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size || now - cached.at > 10000) {
        cached = { mtimeMs: st.mtimeMs, size: st.size, at: now, jobs: JSON.parse(fs.readFileSync(file, "utf8")).jobs || [] };
        jobStateCache.set(d.name, cached);
      }
      for (const job of cached.jobs) out.push({ ...job, stateDir: d.name });
    } catch { jobStateCache.delete(d.name); /* partial write or foreign dir - skip, read again next time */ }
  }
  for (const name of jobStateCache.keys()) if (!seen.has(name)) jobStateCache.delete(name);
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (all) return out;
  // The 100 newest, plus an older job that still needs someone: queued or running, or the newest
  // job of its thread with an open question. A busy day pushed one past 100 (2026-10-02).
  const threads = new Set();
  return out.filter((job, i) => {
    const newest = !job.threadId || !threads.has(job.threadId);
    if (job.threadId) threads.add(job.threadId);
    return i < 100 || job.status === "queued" || job.status === "running"
      || (newest && job.status === "completed" && !!String(job.needsDecision || "").trim());
  });
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function companionJobFile(stateDir, jobId) {
  if (!SAFE_SEGMENT.test(stateDir) || !SAFE_SEGMENT.test(jobId)) return null;
  return path.join(COMPANION_STATE_ROOT, stateDir, "jobs", jobId + ".json");
}

const DEFAULT_RESUME_PROMPT = "Continue the previous task where it left off and finish it.";

function buildCompanionTaskArgs(body) {
  const args = ["task", "--background", "--json", "--cwd", body.cwd];
  if (body.engine === "opencode") args.push("--engine", "opencode");
  if (body.effort) args.push("--effort", String(body.effort));
  if (body.model) args.push("-m", String(body.model));
  if (body.write) args.push("--write");
  if (body.resumeThreadId) args.push("--resume-thread", String(body.resumeThreadId));
  if (body.fast) args.push("--fast");
  if (body.prompt) args.push(String(body.prompt));
  return args;
}

// Runs in the job's own folder (every call passes --cwd). From the viewer's folder the
// companion would record a --cwd pointer there, and a Claude session in that folder
// would be handed jobs from an unrelated project.
function runCompanion(args, extraEnv, cb) {
  const cwdAt = args.indexOf("--cwd");
  execFile(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: cwdAt === -1 ? undefined : args[cwdAt + 1],
    env: { ...process.env, ...extraEnv },
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  }, (err, stdout, stderr) => {
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}
    cb(err, parsed, String(stderr || err || "").slice(0, 500));
  });
}

function isUsableDir(p) {
  try { return typeof p === "string" && p.length > 0 && fs.statSync(p).isDirectory(); } catch { return false; }
}


module.exports = { listCompanionJobs, classifyJobLiveness, pidAlive, STUCK_AFTER_MS, runCompanion, companionJobFile, DEFAULT_RESUME_PROMPT, buildCompanionTaskArgs, isUsableDir, resolveCompanionScript, COMPANION_SCRIPT, SAFE_SEGMENT };
