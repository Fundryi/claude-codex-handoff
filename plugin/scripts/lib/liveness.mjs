// Pure liveness predicates shared by the companion CLI.
// No imports on purpose: state.mjs imports this module, so importing state.mjs
// back would create a cycle.

export function jobLooksDead(job, pidIsAlive) {
  // ponytail: dead pid only. Heartbeat age is deliberately ignored here - a long
  // Codex thinking phase emits no progress events, so a stale heartbeat with a
  // live pid is a healthy job, and reconciling on it would kill live work.
  // Ceiling: a recycled pid keeps a dead job looking alive forever; the upgrade
  // path is recording process start time alongside the pid.
  if (job.status !== "queued" && job.status !== "running") return false;
  return !pidIsAlive;
}
