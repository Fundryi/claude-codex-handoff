#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import {
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function ageLabel(iso, now) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export function buildPendingJobsReport(jobs, now) {
  const lines = [];
  for (const job of jobs) {
    if (TERMINAL.has(job.status)) {
      if (job.announcedAt) continue;
      const label = job.title ? `${job.title} — ` : "";
      lines.push(
        `${job.id}  ${job.status} ${ageLabel(job.completedAt, now)} ago  — ${label}result not delivered; run: /codex:result ${job.id}`
      );
      continue;
    }
    if (job.status !== "queued" && job.status !== "running") continue;
    const phase = job.phase ? ` · phase: ${job.phase}` : "";
    const label = job.title ? ` — ${job.title}` : "";
    lines.push(`${job.id}  ${job.status} ${ageLabel(job.startedAt ?? job.createdAt, now)}${label}${phase}`);
  }

  if (lines.length === 0) return "";
  return ["<codex-jobs>", ...lines, "</codex-jobs>", ""].join("\n");
}

function markAnnounced(workspaceRoot, jobs, nowIso) {
  for (const job of jobs) {
    if (!TERMINAL.has(job.status) || job.announcedAt) continue;
    const jobFile = resolveJobFile(workspaceRoot, job.id);
    if (fs.existsSync(jobFile)) {
      writeJobFile(workspaceRoot, job.id, { ...readJobFile(jobFile), announcedAt: nowIso });
    }
    upsertJob(workspaceRoot, { id: job.id, announcedAt: nowIso });
  }
}

function main() {
  const workspaceRoot = resolveWorkspaceRoot(process.cwd());
  // Fast path: no state dir means this workspace has never run a job. Exit before
  // touching anything - this runs on every single user prompt.
  if (!fs.existsSync(resolveStateDir(workspaceRoot))) return;

  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const report = buildPendingJobsReport(jobs, Date.now());
  if (!report) return;

  process.stdout.write(report);
  markAnnounced(workspaceRoot, jobs, new Date().toISOString());
}

try {
  main();
} catch {
  // A hook must never block the user's prompt. Silence is the correct failure mode.
}
