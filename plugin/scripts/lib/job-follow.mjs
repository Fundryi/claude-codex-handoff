import fs from "node:fs";
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

// runTrackedJob flips the job terminal and only then appends this block, so the
// final drain races that append: land after it and the answer goes to stderr and
// then again to stdout. Matches appendLogBlock's "\n[<iso>] Final output\n".
const FINAL_OUTPUT_MARKER = /\n\[[^\]]+\] Final output\n/;

export async function followJob(cwd, jobId, logFile, options = {}) {
  let emitted = 0;
  const drainLog = (isFinal = false) => {
    if (!logFile) return;
    let text = "";
    try {
      text = fs.readFileSync(logFile, "utf8");
    } catch {
      return;
    }
    if (text.length <= emitted) return;
    let pending = text.slice(emitted);
    if (isFinal) {
      const cut = pending.search(FINAL_OUTPUT_MARKER);
      if (cut !== -1) pending = pending.slice(0, cut);
    }
    // Advance past the whole remainder either way so nothing repeats later.
    emitted = text.length;
    if (pending) process.stderr.write(pending);
  };

  const quiet = Boolean(options.quiet);
  const snapshot = await waitForSingleJobSnapshot(cwd, jobId, {
    timeoutMs: options.budgetMs ?? FOLLOW_BUDGET_MS,
    pollIntervalMs: FOLLOW_POLL_INTERVAL_MS,
    onPoll: quiet ? undefined : drainLog
  });
  if (!quiet) drainLog(true);
  return snapshot;
}

export function renderFollowHandback(payload) {
  const port = Number(process.env.CODEX_VIEWER_PORT) || 8377;
  return [
    `${payload.title} is still running as ${payload.jobId}.`,
    "It is detached, so it keeps going on its own. Nothing has been lost.",
    "",
    "To collect the result without polling, run this as a BACKGROUND Bash task",
    "(run_in_background: true) and continue with other work - the harness wakes",
    "you with the report the moment the job finishes, however long it takes:",
    "",
    `  node "${process.argv[1]}" result ${payload.jobId} --wait --cwd "${payload.workspaceRoot}"`,
    "",
    "Never re-arm foreground waits on a timer.",
    `  Live progress: http://127.0.0.1:${port}`,
    ""
  ].join("\n");
}
