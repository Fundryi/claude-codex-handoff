'use strict';

const fs = require("fs");
const path = require("path");
const { CLAUDE_PROJECTS, CLAUDE_MAX_RUNS, CLAUDE_KEEP_MS, CLAUDE_RUN_ID, claudeRuns, CLAUDE_CHAT_ID, CLAUDE_SWEEP_MS, claudeChatFiles, claudeChats, claudeLinks } = require("./runtime");
const { claudeNewRun, claudeTick } = require("./claude-workflows");
const { claudeChatsScan } = require("./claude-chats");

// Full walk every CLAUDE_SCAN_MS: 52 project listings (~3.5 ms) plus one probe per session dir.
// Paths come only from real readdir names, never from a slug or id seen inside a file.
function claudeDiscover() {
  try {
    const now = Date.now();
    const found = new Map();
    const seenChats = new Set();
    const sweep = now - claudeLastSweep >= CLAUDE_SWEEP_MS;
    if (sweep) claudeLastSweep = now;
    const has = (p) => { try { return !!fs.statSync(p, { throwIfNoEntry: false }); } catch { return false; } };
    let projects = [];
    try { projects = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }); } catch {}
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const pDir = path.join(CLAUDE_PROJECTS, p.name);
      let entries = [];
      try { entries = fs.readdirSync(pDir, { withFileTypes: true }); } catch { continue; }
      for (const s of entries) {
        if (s.isFile()) {
          const id = s.name.endsWith(".jsonl") ? s.name.slice(0, -6) : "";
          if (!CLAUDE_CHAT_ID.test(id)) continue;
          seenChats.add(id);
          const known = claudeChatFiles.get(id);
          if (known && !sweep) continue;
          // A resume appends to an old chat file: the sweep's stat of every file catches it.
          try { claudeChatFiles.set(id, { file: path.join(pDir, s.name), slug: p.name, mtimeMs: fs.statSync(path.join(pDir, s.name)).mtimeMs }); } catch {}
          continue;
        }
        if (!s.isDirectory()) continue;
        const sDir = path.join(pDir, s.name);
        const ids = new Set();
        // Most sessions never ran a workflow: one non-throwing stat each (~40 us on NTFS) skips them.
        // Claude Code (2.1.210 and 2.1.284) saves the script to S/workflows/scripts/ at launch, so
        // S/workflows exists from a run's first second; only then is S/subagents/workflows listed.
        // ponytail: one probe per session dir per scan (~10 ms at 193); probe cold sessions less often if it grows.
        const snapDir = path.join(sDir, "workflows");
        if (!has(snapDir)) continue;
        try { for (const e of fs.readdirSync(path.join(sDir, "subagents", "workflows"))) if (CLAUDE_RUN_ID.test(e)) ids.add(e); } catch {}
        try { for (const e of fs.readdirSync(snapDir)) { const m = /^(wf_[A-Za-z0-9-]+)\.json$/.exec(e); if (m && CLAUDE_RUN_ID.test(m[1])) ids.add(m[1]); } } catch {}
        for (const id of ids) {
          let activity = (claudeRuns.get(id) || {}).lastActivityMs || 0;
          for (const f of [path.join(sDir, "subagents", "workflows", id, "journal.jsonl"), path.join(sDir, "workflows", id + ".json")]) {
            try { activity = Math.max(activity, fs.statSync(f).mtimeMs); } catch {}
          }
          if (now - activity < CLAUDE_KEEP_MS) found.set(id, { sDir, session: s.name, slug: p.name, activity });
        }
      }
    }
    const keep = new Set([...found.entries()].sort((a, b) => b[1].activity - a[1].activity).slice(0, CLAUDE_MAX_RUNS).map(([id]) => id));
    for (const [id, run] of claudeRuns) if (run.status === "RUNNING" && found.has(id)) keep.add(id);
    let added = false;
    for (const id of keep) if (!claudeRuns.has(id)) { claudeRuns.set(id, claudeNewRun(id, found.get(id))); added = true; }
    for (const id of claudeRuns.keys()) if (!keep.has(id)) claudeRuns.delete(id);
    if (added) claudeTick();
    for (const id of claudeChatFiles.keys()) if (!seenChats.has(id)) claudeChatFiles.delete(id);
    for (const [key, link] of claudeLinks) if (!claudeChatFiles.has(link.chat)) claudeLinks.delete(key); // its chat file is gone
    // A tracked chat's own reader knows its newest write before the next sweep does.
    for (const chat of claudeChats.values()) { const c = claudeChatFiles.get(chat.id); if (c) c.mtimeMs = Math.max(c.mtimeMs, chat.reader.mtimeMs); }
    claudeChatsScan(now, sweep);
  } catch { /* the next scan retries */ }
}

let claudeLastSweep = 0;


module.exports = { claudeDiscover };
