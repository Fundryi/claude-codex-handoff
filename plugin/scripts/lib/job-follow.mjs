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

export async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    options.onPoll?.();
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

export async function followJob(cwd, jobId, logFile, options = {}) {
  let emitted = 0;
  const drainLog = () => {
    if (!logFile) return;
    let text = "";
    try {
      text = fs.readFileSync(logFile, "utf8");
    } catch {
      return;
    }
    if (text.length <= emitted) return;
    process.stderr.write(text.slice(emitted));
    emitted = text.length;
  };

  const quiet = Boolean(options.quiet);
  const snapshot = await waitForSingleJobSnapshot(cwd, jobId, {
    timeoutMs: options.budgetMs ?? FOLLOW_BUDGET_MS,
    pollIntervalMs: FOLLOW_POLL_INTERVAL_MS,
    onPoll: quiet ? undefined : drainLog
  });
  if (!quiet) drainLog();
  return snapshot;
}

export function renderFollowHandback(payload) {
  const port = Number(process.env.CODEX_VIEWER_PORT) || 8377;
  return [
    `${payload.title} is still running as ${payload.jobId}.`,
    "It is detached, so it keeps going on its own. Nothing has been lost.",
    "",
    `  Result when it finishes:  node scripts/codex-companion.mjs result ${payload.jobId} --cwd "${payload.workspaceRoot}"`,
    `  Live progress:            http://127.0.0.1:${port}`,
    ""
  ].join("\n");
}
