#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { extractSection } from "./lib/render.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  updateState,
  writeJobFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function ageLabel(iso, now) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

const MAX_DETAILED = 3;
const MAX_LINES = 40;
const MAX_CHARS = 2000;

// The Summary section when Codex wrote the headings, otherwise the start of the
// answer. Bounded by lines and characters: this lands in Claude's context.
export function shortResult(stored) {
  const raw = String(stored?.result?.rawOutput || stored?.errorMessage || stored?.rendered || "").trim();
  if (!raw) return [];
  let text = (extractSection(raw, "Summary") || raw).split(/\r?\n/).slice(0, MAX_LINES).join("\n");
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)} [cut]`;
  return text.split("\n");
}

export function buildPendingJobsReport(jobs, now, readStored = () => null) {
  const lines = [];
  let detailed = 0;
  for (const job of jobs) {
    if (TERMINAL.has(job.status)) {
      if (job.announcedAt) continue;
      const label = job.title ? `${job.title} — ` : "";
      const age = ageLabel(job.completedAt, now) || "unknown time";
      const stored = detailed < MAX_DETAILED ? readStored(job) : null;
      const body = shortResult(stored);
      if (body.length === 0) {
        lines.push(`${job.id}  ${job.status} ${age} ago  — ${label}result not delivered; run: /codex:result ${job.id}`);
        continue;
      }
      detailed += 1;
      lines.push(`${job.id}  ${job.status} ${age} ago  — ${job.title ?? "Codex job"}`);
      lines.push(...body.map((line) => `  ${line}`));
      const question = job.needsDecision ?? stored?.needsDecision;
      if (question) {
        const thread = job.threadId ?? stored?.threadId;
        lines.push("  Codex asks:", ...question.split(/\r?\n/).map((line) => `    ${line}`));
        lines.push(`  Follow the codex-result-handling skill before you answer.${thread ? ` Resume with --resume-thread ${thread}.` : ""}`);
      }
      lines.push(`  Full text: /codex:result ${job.id}`);
      continue;
    }
    if (job.status !== "queued" && job.status !== "running") continue;
    const phase = job.phase ? ` · phase: ${job.phase}` : "";
    const label = job.title ? ` — ${job.title}` : "";
    const age = ageLabel(job.startedAt ?? job.createdAt, now) || "unknown time";
    lines.push(`${job.id}  ${job.status} ${age}${label}${phase}`);
  }

  if (lines.length === 0) return "";
  return ["<codex-jobs>", ...lines, "</codex-jobs>", ""].join("\n");
}

// A single field-preserving updateState write, not one upsertJob per job: upsertJob
// unconditionally bumps updatedAt after the patch spread, and sortJobsNewestFirst
// sorts on updatedAt - bare /codex:result and /codex:status's latestFinished both
// depend on that order. Stamping every unannounced terminal job (up to MAX_JOBS) on
// the first prompt after install must not repoint either at an arbitrary old job.
export function markAnnounced(workspaceRoot, jobs, nowIso) {
  const ids = new Set();
  for (const job of jobs) {
    if (!TERMINAL.has(job.status) || job.announcedAt) continue;
    ids.add(job.id);
    const jobFile = resolveJobFile(workspaceRoot, job.id);
    if (fs.existsSync(jobFile)) {
      writeJobFile(workspaceRoot, job.id, { ...readJobFile(jobFile), announcedAt: nowIso });
    }
  }
  if (ids.size === 0) return;
  updateState(workspaceRoot, (state) => {
    for (const job of state.jobs) {
      if (ids.has(job.id) && !job.announcedAt) job.announcedAt = nowIso;
    }
  });
}

function main() {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  // Fast path: no state dir means this workspace has never run a job. Exit before
  // touching anything - this runs on every single user prompt.
  if (!fs.existsSync(resolveStateDir(workspaceRoot))) return;

  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  // A torn or corrupt job file falls back to the pointer line, never to silence.
  const readStored = (job) => {
    try {
      const jobFile = resolveJobFile(workspaceRoot, job.id);
      return fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
    } catch {
      return null;
    }
  };
  const report = buildPendingJobsReport(jobs, Date.now(), readStored);
  if (!report) return;

  // Delivered means written: if Claude's end of the pipe is gone (EPIPE), leave
  // the jobs unannounced so the next prompt shows them again.
  process.stdout.on("error", () => {});
  process.stdout.write(report, (error) => {
    if (error) return;
    try {
      markAnnounced(workspaceRoot, jobs, new Date().toISOString());
    } catch {
      // Best-effort: a lost stamp only means the job is reported once more.
    }
  });
}

// Guards main() so importing this module (tests, or any future consumer of
// buildPendingJobsReport/markAnnounced) never runs it as a side effect of import -
// only running the file directly, exactly as hooks.json does, executes it. Matches
// session-lifecycle-hook.mjs's own guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    // A hook must never block the user's prompt. Silence is the correct failure mode.
  }
}
