import process from "node:process";

import { buildSingleJobSnapshot } from "./job-control.mjs";

// Deliberately under the Bash tool's 120s default so the follower always exits
// cleanly with a job id rather than being killed mid-write. Not a flag: a
// per-call-site number kept in sync with a timeout in another file will drift,
// and past the budget the right behaviour is identical anyway - hand back a job
// that is still running.
export const FOLLOW_BUDGET_MS = 100_000;
export const FOLLOW_POLL_INTERVAL_MS = 100;

// `/codex:status --wait` keeps the budget and cadence it has today. Only the
// follower polls aggressively, and only the follower gives up at 100s.
export const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240_000;
export const DEFAULT_STATUS_POLL_INTERVAL_MS = 2_000;

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshotOrNull(cwd, reference) {
  // A concurrent non-atomic state.json write makes loadState return an empty job
  // list, which makes buildSingleJobSnapshot throw. The job is fine - the file was
  // caught mid-write. Callers keep their last good snapshot and retry next tick.
  try {
    return buildSingleJobSnapshot(cwd, reference);
  } catch {
    return null;
  }
}

export async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = snapshotOrNull(cwd, reference);
  if (!snapshot) {
    // Two consecutive failures mean the job really is unknown, not a torn read,
    // so this one is allowed to throw.
    await sleep(pollIntervalMs);
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    options.onPoll?.();
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = snapshotOrNull(cwd, reference) ?? snapshot;
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

export async function followJob(cwd, jobId, options = {}) {
  return waitForSingleJobSnapshot(cwd, jobId, {
    timeoutMs: options.budgetMs ?? FOLLOW_BUDGET_MS,
    pollIntervalMs: FOLLOW_POLL_INTERVAL_MS
  });
}

export function renderFollowHandback(payload) {
  const port = Number(process.env.CODEX_VIEWER_PORT) || 8377;
  return [
    `${payload.title} is still running as ${payload.jobId}.`,
    "It is detached, so it keeps going on its own. Nothing has been lost.",
    "",
    "Collect the result with:",
    "",
    `  node "${process.argv[1]}" result ${payload.jobId} --wait --cwd "${payload.workspaceRoot}"`,
    "",
    "Inside the codex-rescue agent: run it in the foreground with --timeout-ms 540000 and repeat until the job ends.",
    "Anywhere else: run it as a background Bash task (run_in_background: true) and keep working.",
    `  Live progress: http://127.0.0.1:${port}`,
    ""
  ].join("\n");
}
