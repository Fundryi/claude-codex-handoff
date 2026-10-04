'use strict';

const fs = require("fs");
const path = require("path");
const { CLAUDE_TOOL_GRACE_MS, CLAUDE_MAX_AGENTS_SENT, CLAUDE_AGENT_ID, claudeRuns, claudeWfReaders, shared } = require("./runtime");
const { broadcast } = require("./events");
const { STUCK_AFTER_MS } = require("./jobs");
const { readAppended, claudeCursor, claudeReadHead, claudeReadTail } = require("./readers");

// ---------------- Claude workflows (read only) ----------------
// Claude Code writes every Workflow tool run under CLAUDE_PROJECTS/<slug>/<session>/:
//   subagents/workflows/<runId>/{journal.jsonl, agent-<id>.jsonl, agent-<id>.meta.json}
//   workflows/<runId>.json (snapshot, written at run end), workflows/scripts/<name>-<runId>.js
// Polled, never fs.watch'ed (GBs, and every transcript write would fire). Nothing here writes.
// Only ids, labels, titles, paths, phases, states, counts, times, tool previews (a tool name and the first line of
// its input, the same a Codex feed shows), token counts, models and efforts reach /events; transcript text goes out
// only through /claude/transcript (and its alias /claude/agent). Both sit behind trustedControlOrigin.
let claudeFrameSig = "";

// One journal.jsonl line. The result text (up to 61 KB, an object on 2.1.210) is never kept.
function claudeJournalEntry(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  if (o.type === "launched") return { type: "launched" };
  if (o.type !== "started" && o.type !== "result" && o.type !== "failed") return null;
  if (typeof o.agentId !== "string" || !o.agentId) return null;
  return { type: o.type, agentId: o.agentId, label: typeof o.label === "string" ? o.label : "", phase: typeof o.phase === "string" ? o.phase : "" };
}

// The script's `export const meta = { ... }` literal, read as text. Never required, imported or eval'ed.
function claudeScriptMeta(text) {
  const block = (/export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(String(text || "")) || [])[1] || "";
  const unq = (s) => s.replace(/\\(.)/g, "$1");
  const str = (key) => { const m = new RegExp("\\b" + key + "[\"']?\\s*:\\s*(['\"`])((?:\\\\.|(?!\\1)[^\\\\])*?)\\1").exec(block); return m ? unq(m[2]) : ""; };
  const phases = [...block.matchAll(/\btitle["']?\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g)].map((m) => unq(m[2]));
  return { name: str("name"), description: str("description"), phases };
}

// One agent-transcript line -> viewer feed events, in the Codex event shape so the UI feed code
// works unchanged. kind "meta" carries context tokens and never reaches the feed.
function claudeTranscriptEvents(line) {
  let o;
  try { o = JSON.parse(line); } catch { return []; }
  if (!o || (o.type !== "user" && o.type !== "assistant")) return [];
  const ts = o.timestamp || null;
  const msg = o.message && typeof o.message === "object" ? o.message : {};
  const content = msg.content;
  const blocks = Array.isArray(content) ? content : [];
  const out = [];
  const userText = (text) => {
    const ev = { kind: "user", ts, text };
    if (o.isMeta || /^\s*<(?:system-reminder|command-|local-command-)/.test(text)) ev.internal = true;
    return ev;
  };
  if (o.type === "user") {
    if (typeof content === "string") return content.trim() ? [userText(content)] : [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === "tool_result") {
        const c = b.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && p.type === "text" && p.text) || "").join("\n") : "";
        out.push({ kind: "out", ts, resultOf: String(b.tool_use_id || ""), text: (b.is_error ? "error: " : "") + text.slice(0, 1200) });
      } else if (b.type === "text" && String(b.text || "").trim()) out.push(userText(b.text));
    }
    return out;
  }
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && String(b.text || "").trim()) out.push({ kind: "agent", ts, text: b.text });
    else if (b.type === "thinking" && String(b.thinking || "").trim()) out.push({ kind: "think", ts, text: String(b.thinking).slice(0, 500) });
    else if (b.type === "tool_use") {
      const input = b.input && typeof b.input === "object" ? b.input : {};
      const name = String(b.name || "tool");
      const head = String(input.command || input.file_path || input.notebook_path || input.description || input.pattern || JSON.stringify(input));
      const preview = name + ": " + head.split(/\r?\n/)[0].slice(0, 90);
      if (name === "Bash" || name === "PowerShell") out.push({ kind: "cmd", ts, callId: b.id, text: String(input.command || ""), preview });
      else if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) out.push({ kind: "patch", ts, callId: b.id, text: String(input.file_path || input.notebook_path || "(edit)"), preview });
      else out.push({ kind: "tool", ts, callId: b.id, text: name + " " + JSON.stringify(input).slice(0, 300), preview });
    }
  }
  const u = msg.usage;
  // model and effort ride every assistant line; "<synthetic>" (an API error line) is no model.
  const model = typeof msg.model === "string" && /^claude-/.test(msg.model) ? msg.model : "";
  if (u && typeof u === "object") out.push({ kind: "meta", ts, tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    model, effort: typeof o.effort === "string" ? o.effort : "" });
  return out;
}

// Model and effort from a transcript's tail (the first assistant line sits ~220 KB in, after the
// prompt and attachments, so the head never has it). Newest assistant line wins; its first line is
// dropped when the text starts mid-file.
function claudeLastModel(text, midFile) {
  const lines = String(text || "").split("\n");
  if (midFile) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const m = o && o.type === "assistant" && o.message && o.message.model;
    if (typeof m === "string" && /^claude-/.test(m)) return { model: m, effort: typeof o.effort === "string" ? o.effort : "" };
  }
  return { model: "", effort: "" };
}

// Soft: the snapshot is the only finish record. Never "stopped" from a pid (a workflow can outlive
// its Claude process). Quiet = may be paused, rate-limited or ended; a flag only, nothing acts on it.
function claudeRunStatus(snapshotStatus, newestWriteMs, pendingSinceMs, now) {
  if (snapshotStatus === "completed") return "DONE";
  if (snapshotStatus === "failed") return "FAILED";
  if (snapshotStatus === "killed") return "KILLED";
  if (now - newestWriteMs < STUCK_AFTER_MS) return "RUNNING";
  // An agent waiting on its own tool (a 10-minute test run) is not quiet.
  // ponytail: capped at CLAUDE_TOOL_GRACE_MS so a run killed mid-tool without a snapshot does not read Running for a day.
  if (pendingSinceMs && now - pendingSinceMs < CLAUDE_TOOL_GRACE_MS) return "RUNNING";
  return "QUIET";
}

// ingest's byte-offset reader, reusable: complete lines appended since cursor.offset, the cut last
// line carried as bytes. null on ENOENT/EBUSY with the cursor unchanged.
function claudeNewRun(id, c) {
  const run = {
    id, sessionDir: c.sDir, dir: path.join(c.sDir, "subagents", "workflows", id),
    snapshotFile: path.join(c.sDir, "workflows", id + ".json"), sessionId: c.session, projectSlug: c.slug,
    name: "", scriptName: "", description: "", phases: [], project: c.slug.replace(/^[a-z]--/i, ""), cwdFound: false,
    journal: { ...claudeCursor(), mtimeMs: 0, birthtimeMs: 0 }, launchedSeen: false,
    agents: new Map(), snapshot: null, snapAgents: new Map(), snapMtime: -1, snapBad: false, settledAt: -1,
    status: "", error: "", lastActivityMs: c.activity,
  };
  try {
    const scripts = path.join(c.sDir, "workflows", "scripts");
    const file = fs.readdirSync(scripts).find((n) => n.endsWith("-" + id + ".js"));
    if (file) Object.assign(run, claudeScriptMeta(claudeReadHead(path.join(scripts, file), 32 * 1024)));
    run.scriptName = run.name;
  } catch { /* no script folder: snapshot-only or foreign run */ }
  return run;
}

// Agent ids come from Claude's own files but still end up in paths: CLAUDE_AGENT_ID only.
function claudeAgent(run, id) {
  let a = run.agents.get(id);
  if (a || !CLAUDE_AGENT_ID.test(id)) return a;
  a = { id, order: run.agents.size, label: "", phase: "", metaLabel: "", metaPhase: "", state: "running",
    cursor: claudeCursor(), lastWriteMs: 0, pending: new Map(), toolName: "", toolPreview: "", toolSinceMs: 0, contextTokens: 0, model: "", effort: "" };
  try {
    const m = JSON.parse(fs.readFileSync(path.join(run.dir, "agent-" + id + ".meta.json"), "utf8"));
    if (typeof m.description === "string") a.metaLabel = m.description;
    if (typeof m.workflowPhase === "string") a.metaPhase = m.workflowPhase;
  } catch { /* 2.1.210 meta, or not written yet: the journal and snapshot labels cover it */ }
  // One stat, so an agent that finished before the viewer started still has a last-write time.
  try { a.lastWriteMs = fs.statSync(path.join(run.dir, "agent-" + id + ".jsonl")).mtimeMs; } catch {}
  // Once, here: a finished agent is never read again. A running agent's live lines update it.
  const tail = claudeReadTail(path.join(run.dir, "agent-" + id + ".jsonl"), 64 * 1024);
  Object.assign(a, claudeLastModel(tail.text, tail.midFile));
  if (!run.cwdFound) {
    // The first transcript line carries cwd after the prompt; attachment lines after it carry it too.
    const m = /"cwd":"((?:\\.|[^"\\])*)"/.exec(claudeReadHead(path.join(run.dir, "agent-" + id + ".jsonl"), 64 * 1024));
    if (m) { try { run.project = JSON.parse('"' + m[1] + '"').split(/[\\/]/).filter(Boolean).pop() || run.project; run.cwdFound = true; } catch {} }
  }
  run.agents.set(id, a);
  return a;
}

// Only whitelisted fields: the snapshot also holds the script, result, logs, args and previews.
function claudeSnapshot(j, mtimeMs) {
  const s = (v) => typeof v === "string" ? v : "";
  const n = (v) => typeof v === "number" && isFinite(v) ? v : 0;
  const agents = new Map();
  for (const r of Array.isArray(j.workflowProgress) ? j.workflowProgress : []) {
    if (!r || typeof r.agentId !== "string") continue;
    agents.set(r.agentId, {
      label: s(r.label), phase: s(r.phaseTitle), lastMs: n(r.lastProgressAt), model: s(r.model),
      state: r.state === "done" ? "done" : r.state === "failed" || r.state === "error" ? "failed" : "ended",
    });
  }
  return {
    mtimeMs, status: s(j.status), startTime: n(j.startTime), endMs: Date.parse(j.timestamp) || mtimeMs,
    durationMs: n(j.durationMs), tokens: n(j.totalTokens), toolCalls: n(j.totalToolCalls), model: s(j.defaultModel),
    workflowName: s(j.workflowName), phases: (Array.isArray(j.phases) ? j.phases : []).map((p) => s(p && p.title)).filter(Boolean), agents,
  };
}

function claudeTickRun(run, now) {
  const journalFile = path.join(run.dir, "journal.jsonl");
  let jst = null, sst = null;
  try { jst = fs.statSync(journalFile); } catch {}
  try { sst = fs.statSync(run.snapshotFile); } catch {}
  if (jst) { run.journal.mtimeMs = jst.mtimeMs; run.journal.birthtimeMs = jst.birthtimeMs; }
  // A resumed run reuses the folder, so its old snapshot is stale once the journal moves on.
  const fresh = !!sst && sst.mtimeMs >= run.journal.mtimeMs - 2000;
  if (!fresh || sst.mtimeMs !== run.settledAt) {
    if (!fresh) { run.snapshot = null; run.snapBad = false; run.snapMtime = -1; }
    // Journal: one 4 MiB step per tick while running; all of it once a fresh snapshot ends the run.
    for (let r; (r = readAppended(journalFile, run.journal, 4 * 1024 * 1024)) && r.lines.length;) {
      for (const line of r.lines) {
        const e = claudeJournalEntry(line);
        if (!e) continue;
        if (e.type === "launched") { run.launchedSeen = true; continue; }
        const a = claudeAgent(run, e.agentId);
        if (!a) continue;
        if (e.type === "started") { a.state = "running"; if (e.label) a.label = e.label; if (e.phase) a.phase = e.phase; }
        else a.state = e.type === "result" ? "done" : "failed";
      }
      if (!fresh || run.journal.offset >= run.journal.size) break;
    }
    if (fresh && sst.mtimeMs !== run.snapMtime) {
      run.snapMtime = sst.mtimeMs;
      try { run.snapshot = claudeSnapshot(JSON.parse(fs.readFileSync(run.snapshotFile, "utf8")), sst.mtimeMs); run.snapAgents = run.snapshot.agents; run.snapBad = false; }
      catch { run.snapshot = null; run.snapBad = true; }
    }
    if (run.snapshot) {
      for (const [id, s] of run.snapshot.agents) {
        const a = claudeAgent(run, id);
        if (a && a.state === "running") a.state = s.state;
      }
      run.settledAt = sst.mtimeMs; // finished: no more journal or transcript reads until the snapshot changes
    } else {
      // Live transcripts, running agents only (never stat a finished agent on a timer).
      for (const a of run.agents.values()) {
        if (a.state !== "running") continue;
        const r = readAppended(path.join(run.dir, "agent-" + a.id + ".jsonl"), a.cursor, 2 * 1024 * 1024);
        if (!r) continue;
        let newest = r.st.mtimeMs;
        for (const line of r.lines) {
          for (const ev of claudeTranscriptEvents(line)) {
            const t = Date.parse(ev.ts) || 0;
            if (t > newest) newest = t;
            if (ev.kind === "meta") { a.contextTokens = ev.tokens; if (ev.model) a.model = ev.model; if (ev.effort) a.effort = ev.effort; continue; }
            if (ev.callId) a.pending.set(ev.callId, { preview: ev.preview, since: t || now });
            if (ev.resultOf) a.pending.delete(ev.resultOf);
          }
        }
        a.lastWriteMs = Math.max(a.lastWriteMs, newest);
        const last = [...a.pending.values()].pop();
        a.toolPreview = last ? last.preview : "";
        a.toolName = last ? last.preview.split(": ")[0] : "";
        a.toolSinceMs = last ? last.since : 0;
      }
    }
  }
  const snap = run.snapshot;
  run.name = run.scriptName || (snap && snap.workflowName) || run.id;
  const running = [...run.agents.values()].filter((a) => a.state === "running");
  const newestWrite = Math.max(run.journal.mtimeMs, ...running.map((a) => a.lastWriteMs));
  const pendingSince = Math.max(0, ...running.map((a) => a.toolSinceMs));
  run.status = claudeRunStatus(snap ? snap.status : "", newestWrite, pendingSince, now);
  run.lastActivityMs = Math.max(newestWrite, snap ? snap.endMs : 0, ...[...run.agents.values()].map((a) => a.lastWriteMs));
  run.error = run.snapBad ? "details unavailable" : "";
}

function claudeAgentState(run, a) {
  return a.state === "running" && run.status !== "RUNNING" ? "ended" : a.state;
}

// The tree's middle level for a run. A topic is the second ":" part of a label ("verify:datev-firma:F1#1"
// -> "datev-firma"); it becomes a group when 2 or more agents share it. Other agents group by phase.
// A lone agent stays flat, and so does a run with no topic and one phase. Sets a.group (or "");
// counts cover every agent, sent or not. A group's order is its first agent's.
function claudeRunGroups(all, phaseOrder) {
  const topicOf = (a) => String(a.label).split(":")[1] || "";
  const shared = new Map();
  for (const a of all) { const t = topicOf(a); if (t) shared.set(t, (shared.get(t) || 0) + 1); }
  const groups = new Map();
  for (const a of all) {
    const t = topicOf(a);
    a.group = t && shared.get(t) > 1 ? "t:" + t : "p:" + a.phase;
    if (!groups.has(a.group)) groups.set(a.group, { key: a.group, title: a.group.slice(2), loose: a.group[0] === "p", agents: [] });
    groups.get(a.group).agents.push(a);
  }
  for (const [key, g] of groups) if (g.agents.length < 2) { g.agents[0].group = ""; groups.delete(key); }
  if (groups.size < 2 && ![...groups.values()].some((g) => !g.loose)) { for (const a of all) a.group = ""; return []; }
  const tally = (xs) => ({ started: xs.length, running: xs.filter((a) => a.state === "running").length,
    done: xs.filter((a) => a.state === "done").length, failed: xs.filter((a) => a.state === "failed").length });
  return [...groups.values()].map(({ agents, ...g }) => ({
    ...g, ...tally(agents), order: agents[0].order,
    steps: phaseOrder.map((p) => ({ title: p, ...tally(agents.filter((a) => a.phase === p)) })).filter((s) => s.started),
    tokens: agents.reduce((s, a) => s + (a.usage ? a.usage.total : 0), 0),
    partial: agents.some((a) => !a.usage || a.usage.partial),
    lastWriteMs: Math.max(0, ...agents.map((a) => a.lastWriteMs)),
  }));
}

function claudeRunView(run) {
  const snap = run.snapshot;
  const all = [...run.agents.values()].map((a) => {
    const s = run.snapAgents.get(a.id); // labels outlive a stale snapshot (a resumed legacy run has no others)
    const state = claudeAgentState(run, a);
    const r = claudeWfReaders.get(run.sessionId + "/" + run.id + "/" + a.id); // the chat tree's reader: usage totals
    return {
      usage: r ? { total: r.usage.total, output: r.usage.output, partial: !r.scanDone || r.capped } : null,
      id: a.id, order: a.order, label: a.label || a.metaLabel || (s && s.label) || a.id,
      phase: a.phase || a.metaPhase || (s && s.phase) || "phase unknown", state,
      lastWriteMs: Math.floor(a.lastWriteMs || (s && s.lastMs) || 0), tool: state === "running" ? a.toolName : "", contextTokens: a.contextTokens,
      model: a.model || (s && s.model) || "", effort: a.effort,
    };
  });
  // The run's model and effort: the most common across all its agents (a script can override per agent).
  const mostCommon = (key) => {
    const n = new Map();
    let best = "", top = 0;
    for (const a of all) if (a[key]) { const c = (n.get(a[key]) || 0) + 1; n.set(a[key], c); if (c > top) { top = c; best = a[key]; } }
    return best;
  };
  const counts = { started: all.length, running: 0, done: 0, failed: 0, ended: 0 };
  const phaseMap = new Map();
  for (const t of run.phases.length ? run.phases : snap ? snap.phases : []) phaseMap.set(t, { title: t, started: 0, done: 0, failed: 0 });
  for (const a of all) {
    counts[a.state]++;
    if (a.phase === "phase unknown") continue;
    if (!phaseMap.has(a.phase)) phaseMap.set(a.phase, { title: a.phase, started: 0, done: 0, failed: 0 });
  }
  if (all.some((a) => a.phase === "phase unknown")) phaseMap.set("phase unknown", { title: "phase unknown", started: 0, done: 0, failed: 0 });
  for (const a of all) {
    const p = phaseMap.get(a.phase);
    p.started++;
    if (a.state === "done") p.done++;
    if (a.state === "failed") p.failed++;
  }
  const groups = claudeRunGroups(all, [...phaseMap.keys()]);
  // All running agents first, then the newest writes; sent in journal order.
  const sent = all.length <= CLAUDE_MAX_AGENTS_SENT ? all
    : all.slice().sort((x, y) => (y.state === "running") - (x.state === "running") || y.lastWriteMs - x.lastWriteMs)
      .slice(0, CLAUDE_MAX_AGENTS_SENT).sort((x, y) => x.order - y.order);
  return {
    id: run.id, name: run.name, description: run.description, project: run.project, session: run.sessionId.slice(0, 8), sessionId: run.sessionId,
    model: mostCommon("model") || (snap && snap.model) || "", effort: mostCommon("effort"),
    status: run.status, error: run.error, legacy: !run.launchedSeen,
    startedMs: (snap && snap.startTime) || run.journal.birthtimeMs || run.journal.mtimeMs,
    updatedMs: run.lastActivityMs, endedMs: snap ? snap.endMs : 0, durationMs: snap ? snap.durationMs : 0,
    counts, phases: [...phaseMap.values()], groups,
    agents: sent, agentsHidden: all.length - sent.length,
    totals: snap ? { tokens: snap.tokens, toolCalls: snap.toolCalls } : null,
  };
}

function claudeRunsFrame() {
  const runs = [];
  for (const run of claudeRuns.values()) { try { if (run.status) runs.push(claudeRunView(run)); } catch {} }
  runs.sort((a, b) => (b.status === "RUNNING") - (a.status === "RUNNING") || b.updatedMs - a.updatedMs);
  return { type: "claudeRuns", runs };
}

function claudeTick() {
  const now = Date.now();
  for (const run of claudeRuns.values()) {
    // A format change degrades one run, never the timer.
    try { claudeTickRun(run, now); } catch { run.error = "details unavailable"; if (!run.status) run.status = "QUIET"; }
  }
  const frame = claudeRunsFrame();
  const sig = JSON.stringify(frame.runs);
  if (sig === claudeFrameSig) return;
  claudeFrameSig = sig;
  shared.claudeFrame = frame;
  broadcast(frame);
}

// Up to 8 MiB of complete lines: from offset when the reader already has everything before it,
// else the tail of the file (first partial line dropped). meta events stay out of the feed.
function claudeTranscriptPage(file, offset) {
  const CAP = 8 * 1024 * 1024;
  const size = fs.statSync(file).size;
  const from = offset > 0 && offset <= size ? offset : Math.max(0, size - CAP);
  const buf = Buffer.alloc(Math.min(size - from, CAP));
  let n = 0;
  const fd = fs.openSync(file, "r");
  try { n = fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  const data = buf.subarray(0, n);
  let skip = 0;
  if (from > 0 && from !== offset) { const nl = data.indexOf(10); skip = nl === -1 ? data.length : nl + 1; }
  let end = Math.max(skip, data.lastIndexOf(10) + 1);
  // ponytail: a line longer than the cap is skipped, not shown; without this the offset never moves.
  if (end === skip && n === CAP) end = n;
  let events = [], contextTokens = 0;
  for (const line of data.toString("utf8", skip, end).split("\n")) {
    if (!line.trim()) continue;
    for (const ev of claudeTranscriptEvents(line)) {
      if (ev.kind === "meta") contextTokens = ev.tokens;
      else events.push(ev);
    }
  }
  if (events.length > 500) events = events.slice(-500);
  return { events, offset: from + end, size, contextTokens };
}


module.exports = { claudeNewRun, claudeTick, claudeAgentState, claudeTranscriptPage };
