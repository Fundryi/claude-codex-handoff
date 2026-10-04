'use strict';

const fs = require("fs");
const path = require("path");
const { sessions, CLAUDE_TOOL_GRACE_MS, CLAUDE_AGENT_ID, claudeRuns, CLAUDE_CHAT_ID, CLAUDE_ROOT_MS, CLAUDE_MAX_ROOTS, CLAUDE_MAX_CHILDREN_SENT, CLAUDE_SCAN_CAP, CLAUDE_SLICE_MS, CLAUDE_SESSIONS_DIR, claudeChatFiles, claudeChats, claudeWfReaders, claudeLinks, shared } = require("./runtime");
const { broadcast } = require("./events");
const { STUCK_AFTER_MS, pidAlive, listCompanionJobs } = require("./jobs");
const { readAppended, claudeCursor, claudeReadHead } = require("./readers");
const { claudeAgentState } = require("./claude-workflows");
const { claudeUsageCheck } = require("./usage");

// ---------------- Claude chats (read only) ----------------
// The tree under each Claude main chat: plain subagents (nested by parentAgentId), workflow runs
// and Codex handoffs. Every chat file is listed each scan; only the root window is read. A chat is
// read once from the end when it is tracked, then only its new lines. Usage totals and the links of
// old handoffs come from one capped backfill read per file, in CLAUDE_SLICE_MS slices per tick.
// Nothing here writes, and a whole chat file is never read on a timer.
let claudePids = new Map();        // sessionId -> { status } for a live Claude process
let claudeJobs = [];               // listCompanionJobs(), refreshed each scan
let claudeChatsSig = "";
// The plugin's status line script saves the 5-hour and 7-day windows here after each Claude reply.
function claudeLineFacts(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const s = (v) => typeof v === "string" ? v : "";
  const n = (v) => typeof v === "number" && isFinite(v) ? v : 0;
  const f = { type: s(o.type), ts: Date.parse(o.timestamp) || 0 };
  if (o.entrypoint) f.entrypoint = s(o.entrypoint);
  if (o.version) f.version = s(o.version);
  if (o.cwd) f.cwd = s(o.cwd);
  if (o.forkedFrom && o.forkedFrom.sessionId) f.forkedFrom = s(o.forkedFrom.sessionId);
  // indexOf, not a lazy regex: many openers with no closer made the regex quadratic.
  const notes = (text) => {
    const t = String(text), open = "<task-notification>", close = "</task-notification>";
    for (let at = t.indexOf(open); at !== -1; at = t.indexOf(open, at)) {
      const end = t.indexOf(close, at);
      if (end === -1) break;
      const body = t.slice(at + open.length, end);
      at = end;
      const id = (/<task-id>\s*([^<\s]+)\s*</.exec(body) || [])[1];
      if (id) (f.notes = f.notes || []).push({ id, status: ((/<status>\s*([^<\s]+)\s*</.exec(body) || [])[1] || "") });
    }
  };
  const command = (text) => { if (!f.command) f.command = (/^\s*<command-name>\s*(\/?[\w:.-]{1,60})\s*</.exec(text) || [])[1]; };
  if (f.type === "custom-title") { f.title = s(o.customTitle); f.titleSource = "custom"; }
  else if (f.type === "ai-title") { f.title = s(o.aiTitle); f.titleSource = "ai"; }
  else if (f.type === "last-prompt") f.lastPrompt = s(o.lastPrompt).slice(0, 200);
  else if (f.type === "queue-operation") notes(s(o.content));
  else if (f.type === "system") {
    if (o.subtype === "compact_boundary") f.compact = true;
    if (o.subtype === "local_command") command(s(o.content));
    if (o.subtype === "stop_hook_summary" || o.subtype === "turn_duration") f.turn = "done";
  } else if (f.type === "user") {
    const c = o.message && o.message.content;
    const texts = typeof c === "string" ? [c] : [];
    for (const b of Array.isArray(c) ? c : []) {
      if (!b) continue;
      if (b.type === "tool_result") {
        const t = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((p) => (p && p.type === "text" && p.text) || "").join("\n") : "";
        (f.results = f.results || []).push({ id: s(b.tool_use_id), text: t, error: !!b.is_error });
      } else if (b.type === "text") texts.push(s(b.text));
    }
    if (f.results) f.turn = "running";
    for (const t of texts) {
      notes(t);
      if (/^\s*\[Request interrupted/.test(t)) { f.turn = "done"; continue; }
      if (/^\s*<task-notification>/.test(t)) { f.turn = "running"; continue; } // Claude wakes up for it
      command(t);
      if (!t.trim() || o.isMeta || o.isCompactSummary || /^\s*<(?:system-reminder|command-|local-command-)/.test(t)) continue;
      if (!f.prompt) f.prompt = t;
      f.turn = "running";
    }
  } else if (f.type === "assistant") {
    const m = o.message && typeof o.message === "object" ? o.message : {};
    if (/^claude-/.test(s(m.model))) { f.model = m.model; f.effort = s(o.effort); }
    const u = m.usage;
    if (u && typeof u === "object") f.usage = { id: s(m.id), in: n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens), out: n(u.output_tokens) };
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b || b.type !== "tool_use") continue;
      const input = b.input && typeof b.input === "object" ? b.input : {};
      const name = s(b.name) || "tool";
      const head = s(input.command) || s(input.file_path) || s(input.description) || s(input.pattern) || s(input.url);
      (f.tools = f.tools || []).push({ id: s(b.id), name, preview: (name + ": " + head.split(/\r?\n/)[0]).slice(0, 100),
        agent: name === "Agent" || name === "Task",
        companion: (name === "Bash" || name === "PowerShell") && /codex-companion\.mjs["']?\s+(?:task|review|adversarial-review)\b/.test(s(input.command)) });
    }
    // One message is written as one line per content block; the last line carries the stop reason.
    f.turn = m.model === "<synthetic>" || (m.stop_reason && m.stop_reason !== "tool_use") ? "done" : "running";
  }
  return f;
}

// The ids a companion `task` or review result names: the job id, and the Codex thread id after one of the
// labels the companion prints (never a bare UUID: chat ids are UUIDs too).
function claudeLauncherIds(text) {
  const t = String(text || "");
  // The companion ends its result with its own ids; any other id in the text may be one Codex only mentioned.
  const own = [...t.matchAll(/(?:Codex|OpenCode) job: ((?:task|review)-[a-z0-9]{6,12}-[a-z0-9]{4,8})(?: · thread: (ses_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?/gi)].pop();
  if (own) return { jobIds: [own[1]], threadIds: own[2] ? [own[2].startsWith("ses_") ? own[2] : own[2].toLowerCase()] : [] };
  const jobIds = [...new Set([...t.matchAll(/\b((?:task|review)-[a-z0-9]{6,12}-[a-z0-9]{4,8})\b/g)].map((m) => m[1]))];
  const threadIds = [...new Set([...t.matchAll(/(?:OpenCode session ID:|OpenCode thread:|--resume-thread|Codex session ID:|thread:|codex resume)\s*(ses_[A-Za-z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((m) => m[1].startsWith("ses_") ? m[1] : m[1].toLowerCase()))];
  return { jobIds, threadIds };
}

// Usage repeats on every line of one message, and a compaction writes old lines again: each
// message id counts once. The id window is bounded; repeats seen on this PC sit within ~400 messages.
function claudeUsageAdd(acc, u, count, setContext) {
  if (!u) return;
  if (setContext) acc.context = u.in;
  if (!count) return;
  if (u.id) {
    if (acc.seen.has(u.id)) return;
    acc.seen.add(u.id);
    if (acc.seen.size > 2048) acc.seen.delete(acc.seen.values().next().value);
  }
  acc.total += u.in + u.out;
  acc.output += u.out;
}

// The first entrypoint, version, cwd, fork parent and typed prompt in a head read.
function claudeHeadFacts(text) {
  const out = { entrypoint: "", version: "", cwd: "", forkedFrom: "", firstPrompt: "", firstCommand: "" };
  const lines = String(text || "").split("\n");
  lines.pop(); // the read may cut the last line
  for (const line of lines) {
    const f = claudeLineFacts(line);
    if (!f) continue;
    for (const k of ["entrypoint", "version", "cwd", "forkedFrom"]) if (!out[k] && f[k]) out[k] = f[k].slice(0, 500);
    if (!out.firstPrompt && f.prompt) out.firstPrompt = f.prompt.trim().slice(0, 200);
    if (!out.firstCommand && f.command) out.firstCommand = f.command;
    if (out.entrypoint && out.cwd && out.firstPrompt) break;
  }
  return out;
}

// cachedUsageUtilization from Claude Code's state file: the snapshot /usage and the VS Code usage
// meter save. That file also holds OAuth and MCP settings: only these fields ever leave this function.
function claudeReader(file, nodeId, chatId, rank) {
  return { file, nodeId, chatId, rank, cursor: claudeCursor(), scan: claudeCursor(), end: 0, scanDone: false, capped: false, mtimeMs: 0,
    title: "", titleSource: "", lastPrompt: "", model: "", effort: "", turn: "", lastTs: 0, compactions: 0,
    pending: new Map(), usage: { seen: new Set(), context: 0, total: 0, output: 0 },
    companionCalls: new Set(), agentCalls: new Set(), agentEnds: new Map(), noteEnds: new Map() };
}

// Sticky and only more exact: a job moves once, from its chat to an agent inside it, never back.
function claudeLink(ids, r) {
  for (const id of [...ids.jobIds, ...ids.threadIds]) {
    const cur = claudeLinks.get(id);
    if (!cur || r.rank > cur.rank) claudeLinks.set(id, { node: r.nodeId, chat: r.chatId, rank: r.rank });
  }
}

// mode "tail": the state read at discovery (no counting; the backfill counts those bytes).
// "scan": the backfill (counts only). "live": new lines (both). Launches and end records apply in
// every mode: they are idempotent, and a call and its result can sit on both sides of the boundary.
function claudeApply(r, f, mode) {
  const state = mode !== "scan", count = mode !== "tail";
  if (f.ts > r.lastTs) r.lastTs = f.ts;
  if (state) {
    if (f.title && (f.titleSource === "custom" || r.titleSource !== "custom")) { r.title = f.title; r.titleSource = f.titleSource; }
    if (f.lastPrompt) r.lastPrompt = f.lastPrompt;
    if (f.model) { r.model = f.model; r.effort = f.effort || r.effort; }
  }
  claudeUsageAdd(r.usage, f.usage, count, state);
  if (count && f.compact) r.compactions++;
  for (const t of f.tools || []) {
    if (state) r.pending.set(t.id, { name: t.name, preview: t.preview, since: f.ts || Date.now() });
    if (t.agent) r.agentCalls.add(t.id);
    if (t.companion) r.companionCalls.add(t.id);
  }
  for (const x of f.results || []) {
    r.pending.delete(x.id);
    if (r.companionCalls.delete(x.id)) claudeLink(claudeLauncherIds(x.text), r);
    // A background agent's call returns at once; its end comes as a task notification.
    if (r.agentCalls.delete(x.id) && !/Async agent launched|running in the background/i.test(x.text)) r.agentEnds.set(x.id, x.error ? "failed" : "done");
  }
  for (const n of f.notes || []) r.noteEnds.set(n.id, n.status);
  if (state && f.turn) { r.turn = f.turn; if (f.turn === "done") r.pending.clear(); }
}

// Fixes the boundary once: the live cursor starts after the last complete line, the backfill stops there.
function claudeOpen(r, bytes) {
  let fd;
  try {
    fd = fs.openSync(r.file, "r");
    const st = fs.fstatSync(fd);
    const from = Math.max(0, st.size - bytes);
    const buf = Buffer.alloc(st.size - from);
    const got = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from));
    const endIdx = got.lastIndexOf(10) + 1;
    const startIdx = from > 0 ? got.indexOf(10) + 1 : 0;
    r.end = from + endIdx;
    r.mtimeMs = st.mtimeMs;
    r.cursor.offset = r.cursor.size = r.end;
    // Over the cap, the backfill reads the newest part: recent children end and launch there.
    // Its first line is cut and fails to parse, which drops it.
    r.scan.offset = Math.max(0, r.end - CLAUDE_SCAN_CAP);
    r.capped = r.scan.offset > 0;
    if (endIdx > startIdx) {
      for (const line of got.toString("utf8", startIdx, endIdx).split("\n")) {
        const f = line.trim() && claudeLineFacts(line);
        if (f) claudeApply(r, f, "tail");
      }
    }
  } catch { /* gone or locked: the next scan retries the reader */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function claudeFollow(r) {
  const got = readAppended(r.file, r.cursor, 2 * 1024 * 1024);
  if (!got) return;
  r.mtimeMs = got.st.mtimeMs;
  for (const line of got.lines) {
    const f = claudeLineFacts(line);
    if (f) claudeApply(r, f, "live");
  }
}

function claudeNewChat(id, c) {
  const chat = { id, nodeId: "chat:" + id, file: c.file, slug: c.slug, sDir: path.join(path.dirname(c.file), id),
    reader: claudeReader(c.file, "chat:" + id, id, 1), head: null, agents: new Map(), startedMs: 0 };
  try { const st = fs.statSync(c.file); chat.startedMs = st.birthtimeMs || st.mtimeMs; } catch {}
  claudeOpen(chat.reader, 256 * 1024);
  chat.head = claudeHeadFacts(claudeReadHead(c.file, 256 * 1024));
  return chat;
}

function claudeAgentMeta(chat, a) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(chat.sDir, "subagents", "agent-" + a.id + ".meta.json"), "utf8"));
    const s = (v) => typeof v === "string" ? v.slice(0, 200) : "";
    a.label = s(m.description); a.agentType = s(m.agentType); a.background = m.requestShape === "background";
    a.toolUseId = s(m.toolUseId); a.parentAgentId = CLAUDE_AGENT_ID.test(s(m.parentAgentId)) ? m.parentAgentId : "";
    a.stoppedByUser = m.stoppedByUser === true; a.worktree = s(m.worktreeBranch); a.metaModel = s(m.model);
    a.metaOk = true;
  } catch { /* written ~40 ms after the transcript: the label is the id until the next scan */ }
}

function claudeNewAgent(chat, id, file) {
  const a = { id, nodeId: "agent:" + id, file, metaOk: false, label: "", agentType: "", background: false, toolUseId: "",
    parentAgentId: "", stoppedByUser: false, worktree: "", metaModel: "", startedMs: 0, reader: claudeReader(file, "agent:" + id, chat.id, 2) };
  claudeAgentMeta(chat, a);
  try { const st = fs.statSync(file); a.startedMs = st.birthtimeMs || st.mtimeMs; } catch {}
  claudeOpen(a.reader, 64 * 1024);
  return a;
}

// The end record sits in the transcript that started the agent: the chat, or its parent agent.
function claudeAgentEnd(chat, a) {
  const parent = a.parentAgentId && chat.agents.get(a.parentAgentId);
  for (const r of [chat.reader, parent && parent.reader]) {
    if (!r) continue;
    const st = r.noteEnds.get(a.id);
    if (st) return st === "completed" ? "done" : st === "failed" ? "failed" : st === "killed" ? "killed" : "stopped";
    if (!a.background && a.toolUseId && r.agentEnds.has(a.toolUseId)) return r.agentEnds.get(a.toolUseId);
  }
  return a.stoppedByUser ? "stopped" : "";
}

// No end record: running while the file grows or a tool waits (the v2.18.0 rule), else "ended".
function claudeLiveState(r, now) {
  const pend = [...r.pending.values()].pop();
  return now - r.mtimeMs < STUCK_AFTER_MS || (pend && now - pend.since < CLAUDE_TOOL_GRACE_MS) ? "running" : "ended";
}

function claudeAgentLiveState(chat, a, now) {
  return claudeAgentEnd(chat, a) || claudeLiveState(a.reader, now);
}

function claudeChatState(chat, now, childRunning) {
  const r = chat.reader, pid = claudePids.get(chat.id);
  const pend = [...r.pending.values()].pop();
  if ((pid && pid.status === "waiting") || (pend && /^(?:AskUserQuestion|ExitPlanMode)$/.test(pend.name))) return "needs-you";
  if (r.turn === "running" && ((pid && pid.status === "busy") || claudeLiveState(r, now) === "running")) return "running";
  return childRunning ? "background" : "done";
}

function claudeUsageOut(rs) {
  let total = 0, output = 0, partial = false;
  for (const r of rs) { total += r.usage.total; output += r.usage.output; if (!r.scanDone || r.capped) partial = true; }
  return { total, output, partial };
}

// Once per scan: which chats are roots, their subagents, the readers of their workflow agents,
// live Claude processes and the job list.
function claudeChatsScan(now, sweep) {
  claudeJobs = listCompanionJobs();
  const busy = new Set();
  for (const j of claudeJobs) if (j.sessionId && (j.status === "running" || j.status === "queued")) busy.add(j.sessionId);
  for (const run of claudeRuns.values()) if (run.status === "RUNNING") busy.add(run.sessionId);
  for (const c of claudeChats.values()) if (shared.claudeChatsFrame.chats.some((x) => x.sessionId === c.id && x.state !== "done")) busy.add(c.id);
  const keep = new Set([...claudeChatFiles.entries()].filter(([, c]) => now - c.mtimeMs < CLAUDE_ROOT_MS)
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs).slice(0, CLAUDE_MAX_ROOTS).map(([id]) => id));
  for (const id of busy) if (claudeChatFiles.has(id)) keep.add(id); // a running child pulls an old chat back
  for (const id of claudeChats.keys()) if (!keep.has(id)) claudeChats.delete(id);
  for (const id of keep) if (!claudeChats.has(id)) claudeChats.set(id, claudeNewChat(id, claudeChatFiles.get(id)));
  for (const chat of claudeChats.values()) {
    const dir = path.join(chat.sDir, "subagents");
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) {
      const m = /^agent-(a[0-9a-f]{6,40})\.jsonl$/.exec(name);
      if (!m) continue;
      const a = chat.agents.get(m[1]);
      if (!a) { chat.agents.set(m[1], claudeNewAgent(chat, m[1], path.join(dir, name))); continue; }
      if (!a.metaOk) claudeAgentMeta(chat, a);
      // A finished agent can be continued later: one stat per sweep catches it (a running one is followed every tick).
      if (sweep) try { a.reader.mtimeMs = fs.statSync(a.file).mtimeMs; } catch {}
    }
  }
  const wfKeep = new Set();
  for (const run of claudeRuns.values()) {
    if (!claudeChats.has(run.sessionId)) continue;
    for (const id of run.agents.keys()) {
      const key = run.sessionId + "/" + run.id + "/" + id;
      wfKeep.add(key);
      if (claudeWfReaders.has(key)) continue;
      const r = claudeReader(path.join(run.dir, "agent-" + id + ".jsonl"), "wfagent:" + key, run.sessionId, 2);
      claudeOpen(r, 64 * 1024);
      claudeWfReaders.set(key, r);
    }
  }
  for (const key of claudeWfReaders.keys()) if (!wfKeep.has(key)) claudeWfReaders.delete(key);
  const pids = new Map();
  let names = [];
  try { names = fs.readdirSync(CLAUDE_SESSIONS_DIR); } catch {}
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, name), "utf8"));
      if (j && CLAUDE_CHAT_ID.test(String(j.sessionId || "")) && pidAlive(j.pid)) pids.set(j.sessionId, { status: String(j.status || "") });
    } catch { /* mid-write: next scan */ }
  }
  claudePids = pids;
  claudeUsageCheck();
}

// Up to CLAUDE_SLICE_MS of backfill, newest file first. 1 MiB steps keep one step well under the budget.
function claudeBackfill(deadline) {
  const todo = [];
  for (const c of claudeChats.values()) {
    if (!c.reader.scanDone) todo.push(c.reader);
    for (const a of c.agents.values()) if (!a.reader.scanDone) todo.push(a.reader);
  }
  for (const r of claudeWfReaders.values()) if (!r.scanDone) todo.push(r);
  todo.sort((x, y) => y.mtimeMs - x.mtimeMs);
  for (const r of todo) {
    while (!r.scanDone) {
      if (Date.now() >= deadline) return;
      if (r.scan.offset >= r.end) { r.scanDone = true; break; }
      const got = readAppended(r.file, r.scan, Math.min(1024 * 1024, r.end - r.scan.offset));
      if (!got) { r.scanDone = true; break; } // gone: its last facts stay until the chat drops
      if (!got.lines.length && got.st.size <= r.scan.offset) { r.scanDone = true; break; } // shrunk under the cursor
      for (const line of got.lines) {
        if (!/"assistant"|tool_result|task-notification|compact_boundary/.test(line)) continue; // cheap skip of attachments and prompts
        const f = claudeLineFacts(line);
        if (f) claudeApply(r, f, "scan");
      }
    }
  }
}

function claudeChatsBuild(now) {
  const runsBySession = new Map();
  for (const run of claudeRuns.values()) {
    if (!runsBySession.has(run.sessionId)) runsBySession.set(run.sessionId, []);
    runsBySession.get(run.sessionId).push(run);
  }
  // One handoff per Codex thread (scope 3.4 rule 5). Its parent: the launcher of its first job that
  // has one, else the launcher of the thread, else its chat by job.sessionId.
  const hand = new Map();
  for (const j of claudeJobs.slice().reverse()) { // oldest first
    if (!j || !j.id) continue;
    const key = j.threadId || j.id;
    let h = hand.get(key);
    if (!h) hand.set(key, h = { key, threadId: j.threadId || "", jobIds: [], sessionId: "", running: false, startedMs: 0, updatedMs: 0 });
    h.jobIds.push(j.id);
    if (!h.sessionId && j.sessionId) h.sessionId = j.sessionId;
    if (j.status === "running" || j.status === "queued") h.running = true;
    h.startedMs = h.startedMs || Date.parse(j.createdAt) || 0;
    h.updatedMs = Math.max(h.updatedMs, Date.parse(j.updatedAt) || 0);
  }
  // A pruned job (50 per workspace) whose Codex thread is still loaded keeps its place by thread id.
  const threads = new Map();
  for (const s of sessions.values()) if (s.meta.threadId) threads.set(s.meta.threadId, s);
  for (const [id, l] of claudeLinks) {
    if (!threads.has(id) || hand.has(id)) continue;
    const s = threads.get(id);
    hand.set(id, { key: id, threadId: id, jobIds: [], sessionId: l.chat, running: now - s.lastGrow < STUCK_AFTER_MS, startedMs: 0, updatedMs: s.lastGrow });
  }
  const byChat = new Map();
  for (const h of hand.values()) {
    let link = null;
    for (const id of [...h.jobIds, h.threadId]) { const l = id && claudeLinks.get(id); if (l) { link = l; break; } }
    h.chat = (link && link.chat) || h.sessionId;
    h.link = link;
    if (!h.chat) continue; // not from Claude, or a viewer resume of a thread no Claude job shares: a Codex row
    if (!byChat.has(h.chat)) byChat.set(h.chat, []);
    byChat.get(h.chat).push(h);
  }
  const chats = [];
  for (const chat of claudeChats.values()) {
    try { chats.push(claudeChatView(chat, now, runsBySession.get(chat.id) || [], byChat.get(chat.id) || [])); } catch { /* one bad chat never stops the frame */ }
  }
  chats.sort((a, b) => (b.state !== "done") - (a.state !== "done") || b.updatedMs - a.updatedMs);
  // Handoffs whose chat file is not on this PC (cleaned up, or another machine): visible, never dropped.
  const ghosts = [];
  for (const [sid, hs] of byChat) {
    if (claudeChatFiles.has(sid)) continue;
    const live = hs.filter((h) => h.running || now - h.updatedMs < CLAUDE_ROOT_MS);
    if (!live.length) continue;
    ghosts.push({ id: "ghost:" + sid, sessionId: sid, updatedMs: Math.max(...live.map((h) => h.updatedMs)),
      children: live.map((h) => ({ kind: "handoff", id: "handoff:" + h.key, parentId: "ghost:" + sid, threadId: h.threadId, jobIds: h.jobIds, exact: false, running: h.running, startedMs: h.startedMs, updatedMs: h.updatedMs, depth: 1 })) });
  }
  return { type: "claudeChats", chats, ghosts };
}

function claudeChatView(chat, now, runs, hands) {
  const r = chat.reader;
  const kids = [];
  const rescueOf = new Map(); // rescue agent id -> handoff that takes its place
  for (const h of hands) {
    let parentId = chat.nodeId, rescue = "";
    if (h.link && h.link.node !== chat.nodeId) {
      parentId = h.link.node;
      const a = h.link.node.startsWith("agent:") && chat.agents.get(h.link.node.slice(6));
      if (a && a.agentType === "codex:codex-rescue") { rescue = a.id; parentId = a.parentAgentId && chat.agents.has(a.parentAgentId) ? "agent:" + a.parentAgentId : chat.nodeId; }
    }
    const kid = { kind: "handoff", id: "handoff:" + h.key, parentId, threadId: h.threadId, jobIds: h.jobIds, rescueAgentId: rescue, exact: !!h.link,
      state: h.running ? "running" : "done", startedMs: h.startedMs, updatedMs: h.updatedMs };
    if (rescue) rescueOf.set(rescue, kid);
    kids.push(kid);
  }
  const wfNode = new Map(); // agent id -> its workflow agent node, for an agent started by a workflow agent
  for (const run of runs) {
    const rs = [...claudeWfReaders.entries()].filter(([k]) => k.startsWith(chat.id + "/" + run.id + "/")).map(([, x]) => x);
    for (const id of run.agents.keys()) wfNode.set(id, "wfagent:" + chat.id + "/" + run.id + "/" + id);
    kids.push({ kind: "workflow", id: "workflow:" + chat.id + "/" + run.id, runId: run.id, parentId: chat.nodeId, label: run.name || run.id,
      state: run.status === "RUNNING" ? "running" : run.status === "QUIET" ? "quiet" : run.status === "FAILED" ? "failed" : run.status === "KILLED" ? "killed" : "done",
      startedMs: run.journal.birthtimeMs || run.journal.mtimeMs, updatedMs: run.lastActivityMs, usage: claudeUsageOut(rs) });
  }
  for (const a of chat.agents.values()) {
    if (rescueOf.has(a.id)) continue;
    const state = claudeAgentLiveState(chat, a, now);
    const pend = state === "running" ? [...a.reader.pending.values()].pop() : null;
    let parentId = chat.nodeId, flag = "";
    if (a.parentAgentId) {
      parentId = chat.agents.has(a.parentAgentId) ? "agent:" + a.parentAgentId : wfNode.get(a.parentAgentId) || chat.nodeId;
      if (parentId === chat.nodeId) flag = "parent agent not found";
    }
    kids.push({ kind: "agent", id: a.nodeId, parentId, label: a.label || a.agentType || a.id, agentType: a.agentType, background: a.background,
      model: a.reader.model || a.metaModel, effort: a.reader.effort, state, tool: pend ? pend.preview : "", worktree: a.worktree, flag,
      startedMs: a.startedMs, updatedMs: a.reader.mtimeMs,
      usage: { context: a.reader.usage.context, ...claudeUsageOut([a.reader]) } });
  }
  // Depth along parent links, cycle guard 8. A parent outside this chat (a workflow agent) counts as depth 2.
  const byId = new Map(kids.map((k) => [k.id, k]));
  for (const k of kids) {
    let d = 1, p = k.parentId;
    const seen = new Set([k.id]);
    while (p !== chat.nodeId && d < 8 && !seen.has(p)) { seen.add(p); d++; const up = byId.get(p); if (!up) { d++; break; } p = up.parentId; }
    k.depth = d;
  }
  const counts = {};
  let childRunning = false;
  for (const k of kids) {
    const c = counts[k.kind] || (counts[k.kind] = {});
    c[k.state] = (c[k.state] || 0) + 1;
    if (k.state === "running") childRunning = true;
  }
  // Running first, then newest; every sent child brings its parents along.
  const pick = new Set(kids.slice().sort((x, y) => (y.state === "running") - (x.state === "running") || y.updatedMs - x.updatedMs)
    .slice(0, CLAUDE_MAX_CHILDREN_SENT).map((k) => k.id));
  // A workflow agent is not a child here: its workflow stands in for it.
  const up = (k) => byId.get(k.parentId) || (k.parentId.startsWith("wfagent:") ? byId.get("workflow:" + k.parentId.slice(8).split("/").slice(0, 2).join("/")) : undefined);
  for (const id of [...pick]) { let p = up(byId.get(id)); while (p && !pick.has(p.id)) { pick.add(p.id); p = up(p); } }
  const children = kids.filter((k) => pick.has(k.id));
  const tree = claudeUsageOut([r, ...[...chat.agents.values()].map((a) => a.reader),
    ...[...claudeWfReaders.entries()].filter(([k]) => k.startsWith(chat.id + "/")).map(([, x]) => x)]);
  const pend = [...r.pending.values()].pop();
  const state = claudeChatState(chat, now, childRunning);
  const h = chat.head || {};
  // A chat that only ran a slash command (/usage, /workflows) is named after that command.
  const title = r.title || h.firstPrompt || r.lastPrompt || (h.firstCommand ? "Ran " + h.firstCommand : chat.id.slice(0, 8));
  return {
    id: chat.nodeId, sessionId: chat.id, title: title.slice(0, 200),
    titleSource: r.title ? r.titleSource : h.firstPrompt ? "first-prompt" : r.lastPrompt ? "last-prompt" : h.firstCommand ? "command" : "id",
    project: (h.cwd && h.cwd.split(/[\\/]/).filter(Boolean).pop()) || chat.slug.replace(/^[a-z]--/i, ""), cwd: h.cwd,
    source: h.entrypoint, version: h.version, forkedFrom: h.forkedFrom && h.forkedFrom !== chat.id ? h.forkedFrom : "",
    model: r.model, effort: r.effort, state, alive: claudePids.has(chat.id), tool: state === "running" && pend ? pend.preview : "",
    startedMs: chat.startedMs, updatedMs: r.mtimeMs, lastPrompt: r.lastPrompt, compactions: r.compactions,
    usage: { context: r.usage.context, ...claudeUsageOut([r]) }, claudeTree: tree,
    counts, children, childrenHidden: kids.length - children.length,
  };
}

// Claude plan usage: re-read Claude Code's state file only when its mtime moves.
// The newer of two sources wins for the 5-hour and 7-day windows: the status line file (written
// after each Claude reply) or the /usage snapshot. A per-model week exists only in the snapshot;
// it carries the snapshot's time so the page can hide it when old.
function claudeChatsTick() {
  const now = Date.now();
  let running = 0; // running agents, for the adaptive Codex tick gap
  for (const chat of claudeChats.values()) {
    try {
      claudeFollow(chat.reader);
      for (const a of chat.agents.values()) if (claudeAgentLiveState(chat, a, now) === "running") { running++; claudeFollow(a.reader); }
    } catch { /* one bad chat never stops the timer */ }
  }
  for (const [key, r] of claudeWfReaders) {
    const [, runId, id] = key.split("/");
    const run = claudeRuns.get(runId), a = run && run.agents.get(id);
    if (a && claudeAgentState(run, a) === "running") { running++; try { claudeFollow(r); } catch {} }
  }
  shared.claudeActive = running;
  try { claudeBackfill(Date.now() + CLAUDE_SLICE_MS); } catch {}
  let frame;
  try { frame = claudeChatsBuild(now); } catch { return; }
  const sig = JSON.stringify(frame);
  if (sig === claudeChatsSig) return;
  claudeChatsSig = sig;
  shared.claudeChatsFrame = frame;
  broadcast(frame);
}


module.exports = { claudeChatsScan, claudeAgentLiveState, claudeChatState, claudeChatsTick };
