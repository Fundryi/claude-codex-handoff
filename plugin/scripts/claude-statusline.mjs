#!/usr/bin/env node
// Claude Code status line: prints the model and the plan limits, and saves the limits for the
// AI Live Viewer. Claude Code hands every status line its rate_limits (5-hour and 7-day
// windows) after each reply, so the viewer stays current without /usage.
// The session hook copies this file to ~/.codex-companion/claude-statusline.mjs (a path that
// survives plugin updates); the statusLine setting points there.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const LIMITS_FILE = path.join(os.homedir(), ".codex-companion", "claude-limits.json");

// Only the two documented windows: percent used and reset time. Nothing else leaves.
export function statusLimits(input) {
  const rl = (input && input.rate_limits) || {};
  const win = (w) => w && typeof w.used_percentage === "number" && Number.isFinite(w.used_percentage)
    ? { usedPercent: w.used_percentage, resetsAtMs: (Number(w.resets_at) || 0) * 1000 }
    : null;
  const fiveHour = win(rl.five_hour);
  const sevenDay = win(rl.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

export function statusText(input, limits) {
  const parts = [];
  const model = input && input.model && input.model.display_name;
  if (model) parts.push(String(model));
  if (limits && limits.fiveHour) parts.push(`5h ${Math.round(limits.fiveHour.usedPercent)}%`);
  if (limits && limits.sevenDay) parts.push(`week ${Math.round(limits.sevenDay.usedPercent)}%`);
  return parts.join(" · ");
}

// The file is replaced, never appended: it holds only the newest numbers (about 150 bytes).
function save(limits, file = LIMITS_FILE) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ atMs: Date.now(), ...limits }));
    fs.renameSync(tmp, file); // several chats may write at once: last one wins, never a half file
  } catch {
    try { fs.unlinkSync(tmp); } catch {} // a failed swap (file locked) leaves no temp file behind
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(raw); } catch {}
    const limits = statusLimits(input);
    if (limits) save(limits);
    process.stdout.write(statusText(input, limits));
  });
}
