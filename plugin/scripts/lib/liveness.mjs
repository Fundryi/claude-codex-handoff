// Pure liveness predicates shared by the companion CLI.
// No imports on purpose: state.mjs imports this module, so importing state.mjs
// back would create a cycle.

export const STUCK_AFTER_MS = 5 * 60 * 1000; // alive but no heartbeat this long => possibly stuck

export function classifyJobLiveness(job, pidIsAlive, now) {
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job.status;
  if (!pidIsAlive) return "dead";
  const beatMs = job.heartbeatAt ? now - Date.parse(job.heartbeatAt) : Infinity;
  // ponytail: heartbeat freshness only; if pid is alive we never flag before
  // STUCK_AFTER_MS, so long-running commands are not misreported as stuck.
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
