// Pure liveness predicates shared by the companion CLI.
// No imports on purpose: state.mjs imports this module, so importing state.mjs
// back would create a cycle.

export const STUCK_AFTER_MS = 5 * 60 * 1000; // alive but no heartbeat this long => possibly stuck

export function classifyJobLiveness(job, pidIsAlive, now) {
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job.status;
  if (!pidIsAlive) return "dead";
  const beatMs = job.heartbeatAt ? now - Date.parse(job.heartbeatAt) : Infinity;
  // The worker beats on a 30s timer while a turn runs (tracked-jobs.mjs), so a
  // stale heartbeat with a live pid means the worker itself is wedged - long
  // quiet thinking no longer trips this.
  return beatMs < STUCK_AFTER_MS ? "working" : "possibly-stuck";
}

export function jobLooksDead(job, pidIsAlive) {
  // ponytail: dead pid only. Heartbeat age is deliberately ignored here - a long
  // Codex thinking phase emits no progress events, so a stale heartbeat with a
  // live pid is a healthy job, and reconciling on it would kill live work.
  // Ceiling: a recycled pid keeps a dead job looking alive forever; the upgrade
  // path is recording process start time alongside the pid.
  if (job.status !== "queued" && job.status !== "running") return false;
  return !pidIsAlive;
}
