#!/usr/bin/env node
/*
 * codex-live-viewer.js
 * Read-only live dashboard for ALL Codex sessions on this machine,
 * including headless handoffs spawned by the Claude Code codex plugin.
 *
 * How: Codex appends every event of every session to
 *   %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl
 * as it runs. This server tails that folder and streams updates
 * to a browser page via Server-Sent Events. Zero npm dependencies.
 *
 * Run:  node codex-live-viewer.js        (then open http://localhost:8377)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const APP_ID = "codex-live-viewer";
const APP_VERSION = "2.20.0";
const PORT = process.env.CODEX_VIEWER_PORT ? parseInt(process.env.CODEX_VIEWER_PORT, 10) : 8377;
const PID_FILE = path.join(os.tmpdir(), "codex-live-viewer-" + PORT + ".pid");
function parseFlags(argv) {
  const flags = { cmd: null, host: null, tunnel: false, tunnelToken: null, token: null, noOpen: false, flagArgv: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") { flags.host = argv[++i] || null; flags.flagArgv.push(a, flags.host); }
    else if (a === "--tunnel") { flags.tunnel = true; flags.flagArgv.push(a); }
    else if (a === "--tunnel-token") { flags.tunnelToken = argv[++i] || null; flags.tunnel = true; flags.flagArgv.push(a, flags.tunnelToken); }
    else if (a === "--token") { flags.token = argv[++i] || null; flags.flagArgv.push(a, flags.token); }
    else if (a === "--no-open") flags.noOpen = true; // start without opening a browser tab
    else rest.push(a);
  }
  flags.cmd = rest[0] || "serve";
  flags.args = rest.slice(1).map(a => a.trim().toLowerCase());
  return flags;
}
const FLAGS = parseFlags(process.argv.slice(2));
// A proxy name usually means the proxy runs on another machine, so it opens the bind too.
const HOST = FLAGS.host || process.env.CODEX_VIEWER_HOST || (process.env.CODEX_VIEWER_ALLOWED_HOSTS ? "0.0.0.0" : "127.0.0.1");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
// Claude Code's own root. CLAUDE_CONFIG_DIR moves it (Claude Code settings docs). Read only, like CODEX_HOME.
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CLAUDE_PROJECTS = path.join(CLAUDE_HOME, "projects");
// The viewer never writes under CODEX_HOME, so the token lives in the companion state root.
// Older builds kept it in CODEX_HOME; that copy is only read, so old tunnel links keep working.
const TOKEN_FILE = path.join(process.env.CODEX_COMPANION_STATE_ROOT
  || path.join(os.homedir(), ".codex-companion", "state"), "live-viewer-token");
const LEGACY_TOKEN_FILE = path.join(CODEX_HOME, "live-viewer-token");

function loadToken() {
  if (FLAGS.token) return FLAGS.token;
  if (process.env.CODEX_VIEWER_TOKEN) return process.env.CODEX_VIEWER_TOKEN;
  for (const file of [TOKEN_FILE, LEGACY_TOKEN_FILE]) {
    try {
      const t = fs.readFileSync(file, "utf8").trim();
      if (!t) continue;
      if (file !== TOKEN_FILE) saveToken(t);
      return t;
    } catch {}
  }
  const t = crypto.randomBytes(16).toString("hex");
  saveToken(t);
  return t;
}
function saveToken(t) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  } catch {}
}
const TOKEN = FLAGS.tunnel ? loadToken() : null;

// Token auth for tunnel traffic only. cloudflared always sets cf-connecting-ip
// and tunnel visitors cannot strip it; requests without it are local/LAN and trusted.
function tunnelAuthDecision(headers, rawUrl, token, tunnelActive) {
  if (!tunnelActive) return { allow: true };
  if (!headers["cf-connecting-ip"]) return { allow: true };
  if (!token) return { allow: false };
  // Byte lengths, not char lengths: a non-ASCII token of equal char length makes timingSafeEqual throw.
  const eq = t => { if (!t) return false; const a = Buffer.from(t), b = Buffer.from(token); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const u = new URL(rawUrl, "http://local");
  const qtoken = u.searchParams.get("token");
  if (qtoken !== null) {
    if (!eq(qtoken)) return { allow: false };
    u.searchParams.delete("token");
    return { allow: true, setCookie: true, redirect: u.pathname + u.search };
  }
  const m = /(?:^|;\s*)clv_token=([^;]*)/.exec(headers.cookie || "");
  if (m && eq(m[1])) return { allow: true };
  return { allow: false };
}

function parseTunnelUrl(text) {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
  return m ? m[0] : null;
}

let tunnelChild = null;
function startTunnel(token) {
  const args = FLAGS.tunnelToken
    ? ["tunnel", "run", "--token", FLAGS.tunnelToken]
    : ["tunnel", "--url", "http://127.0.0.1:" + PORT];
  tunnelChild = spawn("cloudflared", args, { stdio: ["ignore", "ignore", "pipe"] });
  tunnelChild.on("error", () => {
    tunnelChild = null;
    console.error("[X] cloudflared not found on PATH - tunnel disabled, local serving continues.");
    console.error("    Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  });
  if (FLAGS.tunnelToken) {
    console.log("[OK] Named tunnel starting - open your configured hostname with /?token=" + token);
    return;
  }
  let buf = "";
  let printed = false;
  tunnelChild.stderr.on("data", d => {
    if (printed) return;
    buf += d.toString();
    const url = parseTunnelUrl(buf);
    if (url) { printed = true; console.log("[OK] Tunnel -> " + url + "/?token=" + token); }
  });
}
function stopTunnel() {
  if (!tunnelChild) return;
  try { tunnelChild.kill(); } catch {}
  tunnelChild = null;
}
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const ARCHIVED_DIR = path.join(CODEX_HOME, "archived_sessions");
const POLL_MS = 1000;          // how often we check files for growth
const LIVE_WINDOW_MS = 20000;  // file grew within this window => LIVE
const MAX_SESSIONS = 40;       // most recent sessions to track
const MAX_EVENTS_KEPT = 500;   // per-session event ring buffer

// ---------------- session state ----------------
// key: absolute file path
// val: { id, file, offset, partial, meta, events[], lastGrow, size }
const sessions = new Map();
const sseClients = new Set();
const notificationClients = new Set();
const searchIndex = new Map(); // file -> { file, id, threadId, title, cwd, mtimeMs, archived }
const pinnedFiles = new Map(); // file -> last-open timestamp (LRU, max 10)
const MAX_PINNED = 10;
let searchIndexReady = false;
const rolloutStats = new Map(); // file -> { mtimeMs, size } from the last stat, or null
const resumedFiles = new Set(); // untracked rollouts a full pass saw grow, followed until read to the end

// full: restat every file (the 30 s index rebuild). Otherwise (the 1 s tick) stat only new
// and tracked files: stat is ~90% of this walk, ~120 ms for 2,600 rollouts.
// ponytail: an untracked old rollout that grows again sorts up within 30 s, not 1 s.
function collectRolloutFiles(full) {
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(SESSIONS_DIR, 0);
  walk(ARCHIVED_DIR, 0);
  // One stat per file; stat inside the comparator cost ~60k stats per call (every tick).
  // A tracked session also sorts by its newest record: Codex 0.146+ pins mtime at creation
  // on Windows, so a long run would drop out of the top 40 while it is still writing.
  // A full pass also catches an untracked rollout that grew (an old session resumed; its mtime
  // stays pinned). tick follows it as an extra next to the newest 40 (resumedFiles); it never
  // takes a place in the 40, so no other session is pushed out.
  const before = full ? new Map(rolloutStats) : null;
  if (full) rolloutStats.clear();
  const mtime = new Map(out.map(p => {
    let st = rolloutStats.get(p);
    if (st === undefined || sessions.has(p)) { st = null; try { const s = fs.statSync(p); st = { mtimeMs: s.mtimeMs, size: s.size }; } catch {} rolloutStats.set(p, st); }
    const old = before && before.get(p);
    if (old && st && st.size > old.size && !sessions.has(p)) resumedFiles.add(p);
    return [p, Math.max(st?.mtimeMs || 0, sessions.get(p)?.lastGrow || 0)];
  }));
  if (full) for (const p of resumedFiles) if (!rolloutStats.has(p)) resumedFiles.delete(p);
  out.sort((a, b) => mtime.get(b) - mtime.get(a));
  return out;
}

function listRolloutFiles() {
  return collectRolloutFiles().slice(0, MAX_SESSIONS);
}

// Turn one raw rollout line into a display event (schema-tolerant).
function simplify(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const ts = o.timestamp || o.ts || null;
  const t = o.type || "";
  const p = o.payload || o;

  // session metadata
  if (t === "session_meta" || p.cwd && p.id && !p.type) {
    return { kind: "meta", ts, cwd: p.cwd || "", id: p.id || "", model: p.model || (p.turn_context && p.turn_context.model) || "",
      parentThreadId: p.parent_thread_id || "", agentNickname: p.agent_nickname || "", agentPath: p.agent_path || "", originator: p.originator || "", instructions: undefined,
      guardian: p.source?.subagent?.other === "guardian" };
  }
  // event_msg wrapper (agent messages, token counts, etc.)
  if (t === "event_msg") {
    const et = p.type || "";
    if (et === "user_message")  return { kind: "user",  ts, text: p.message || "" };
    if (et === "agent_message") return { kind: "agent", ts, text: p.message || "" };
    if (et === "agent_reasoning" || et === "agent_reasoning_delta") return null; // too chatty
    if (et === "token_count") {
      const tokens = p.info?.total_token_usage?.total_tokens ?? p.total_tokens ?? 0;
      // Context now = the last call's input + output (Codex appends the output to the history).
      const contextTokens = p.info?.last_token_usage?.total_tokens || 0;
      const contextWindow = p.info?.model_context_window || 0;
      // rate_limits here are ignored: one event holds one bucket (a Spark or premium bucket too).
      // The plan limits come from the live read (refreshCodexLimits).
      return tokens ? { kind: "meta", ts, tokens, contextTokens, contextWindow } : null;
    }
    if (et === "task_started") return { kind: "sys", ts, text: "task started" };
    if (et === "task_complete") return { kind: "done", ts, text: "task complete" };
    if (et === "turn_aborted") return { kind: "err", ts, text: "turn aborted" };
    // What Codex ran. Since code mode (0.148+) these items are the only record of
    // commands, file edits, MCP calls and web searches. AgentMessage, Reasoning and
    // UserMessage items repeat response_items and stay dropped.
    if (et === "item_completed") {
      const item = p.item || {};
      if (item.type === "CommandExecution") {
        // 0.124-0.128 logged the same command as function_call shell too (source "agent").
        if (item.source === "agent") return null;
        const text = (item.parsed_cmd || []).map(c => c && c.cmd).filter(Boolean).join(" && ")
          || (Array.isArray(item.command) ? item.command.join(" ") : String(item.command || ""));
        const exit = item.exit_code == null ? "" : "\n\nexit " + item.exit_code;
        // done: logged once the command finished (function_call shell is logged as it starts).
        return { kind: "cmd", ts, text, done: true, detail: (text + exit + "\n" + String(item.aggregated_output || "")).slice(0, 4000) };
      }
      if (item.type === "FileChange") {
        const changes = item.changes || {};
        const files = Object.keys(changes);
        const detail = files.map(f => (changes[f].type || "update") + " " + f + "\n" + (changes[f].unified_diff || changes[f].content || "")).join("\n\n");
        return { kind: "patch", ts, text: files.length ? files.join(", ") : "(patch)", detail: detail.slice(0, 4000) };
      }
      // 0.124-0.155 also logged a direct MCP call as function_call with the same id; ingest keeps one.
      if (item.type === "McpToolCall") return { kind: "tool", ts, callId: item.id, text: item.server + "." + item.tool + " " + JSON.stringify(item.arguments || {}).slice(0, 300) };
      if (item.type === "Extension" && item.kind === "web.search") return { kind: "tool", ts, text: "web.search " + (item.query || "") };
      return null;
    }
    return null;
  }
  // response_item wrapper (model I/O, tool calls)
  if (t === "response_item") {
    const it = p.type || "";
    if (it === "message") {
      const role = p.role || "";
      const text = (p.content || []).map(c => c.text || c.input_text || c.output_text || "").join("");
      if (!text.trim()) return null;
      // Codex 0.153 records the prompt only here (no event_msg user_message any
      // more). Hook output and system blocks arrive as role developer: internal.
      // A user-role message is injected context only when it opens with one of the
      // tags Codex injects (seen in real rollouts), or with the AGENTS.md heading.
      // Prompts that open with any other tag (<goal>, <task>, <role>) are speech.
      // Keep in step with INJECTED_BLOCK in viewer-ui.html (tests/ui-feed.test.js checks).
      if (role === "user") {
        const INJECTED_BLOCK = /^\s*(?:<(?:environment_context|permissions|user_instructions|recommended_plugins|skills?|skills_instructions|apps|plugins|developer|multi_agent_mode|multi_agent_role|collaboration_mode|context_window[\w-]*|context_guidance|model_switch|app-context|codex-jobs|codex_internal_context|image_resize_notice|task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|ide_opened_file|ide_selection|system-reminder|turn_aborted|external_codex_apps_writing_block_edits|subagent_notification)(?=[\s>/])|# AGENTS\.md instructions\b|The following is the Codex agent history (?:added since your last approval assessment|whose request action you are assessing)\b)/;
        return INJECTED_BLOCK.test(text) ? { kind: "user", ts, text, internal: true } : { kind: "user", ts, text };
      }
      if (role === "developer") return { kind: "agent", ts, text, internal: true };
      return { kind: "agent", ts, text };
    }
    if (it === "function_call") {
      let args = p.arguments;
      try { args = JSON.parse(p.arguments); } catch {}
      if (p.name === "shell" || p.name === "shell_command" || p.name === "local_shell" ) {
        const cmd = Array.isArray(args && args.command) ? args.command.join(" ") : (args && args.command) || p.arguments || "";
        return { kind: "cmd", ts, text: cmd };
      }
      if (p.name === "apply_patch" || (args && args.patch)) {
        const patch = (args && (args.patch || args.input)) || "";
        const files = [...String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(m => m[1]);
        return { kind: "patch", ts, text: files.length ? files.join(", ") : "(patch)", detail: String(patch).slice(0, 4000) };
      }
      return { kind: "tool", ts, callId: p.call_id, text: p.name + " " + String(p.arguments || "").slice(0, 300) };
    }
    if (it === "function_call_output") {
      let out = p.output;
      try { const j = JSON.parse(p.output); out = j.output || p.output; } catch {}
      out = String(out || "");
      if (!out.trim()) return null;
      return { kind: "out", ts, text: out.slice(0, 1200) };
    }
    if (it === "local_shell_call") {
      const cmd = (p.action && Array.isArray(p.action.command)) ? p.action.command.join(" ") : "";
      return { kind: "cmd", ts, text: cmd };
    }
    if (it === "reasoning") {
      const sum = (p.summary || []).map(s => s.text || "").join(" ");
      return sum.trim() ? { kind: "think", ts, text: sum.slice(0, 500) } : null;
    }
    return null;
  }
  // turn_context lines carry model/cwd/effort/sandbox on newer versions
  if (t === "turn_context") {
    const sp = p.sandbox_policy;
    const sandbox = typeof sp === "string" ? sp : (sp && (sp.mode || sp.type)) || "";
    return { kind: "meta", ts, cwd: p.cwd || "", model: p.model || "", effort: p.effort || "", sandbox };
  }
  return null;
}

// Session title from a prompt: the first line that is not an XML tag and not one
// of the routing lines a rescue prompt opens with. Text after "Task:" wins. Same
// rule as taskTitleFromPrompt in the companion, kept in sync by hand.
function promptTitle(text) {
  const line = String(text || "").split("\n").map(l => l.trim())
    .find(l => l && !l.startsWith("<") && !/^(dispatch flags|binding contract)\s*:/i.test(l));
  if (!line) return "";
  const task = line.match(/\btask\s*:\s*(.+)$/i);
  return (task ? task[1] : line).slice(0, 100);
}

// ---------------- metadata search index (all sessions, not just top-40) ----------------
// st: the rebuild's stat snapshot ({ mtimeMs, size }); direct callers leave it out.
function indexEntry(file, st) {
  if (!st) { try { st = fs.statSync(file); } catch { return null; } }
  const cached = searchIndex.get(file);
  // Size too: Codex 0.146+ pins a rollout's mtime at creation on Windows while it grows.
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const entry = {
    file,
    id: path.basename(file, ".jsonl"),
    threadId: "",
    title: "",
    cwd: "",
    mtimeMs: st.mtimeMs,
    size: st.size,
    archived: file.startsWith(ARCHIVED_DIR),
  };
  try {
    // The first real prompt sits behind injected context (220-400 KB on Codex 0.155+):
    // read 64 KB chunks up to 1 MB, carrying the cut last line, until all three are found.
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0, carry = Buffer.alloc(0), child = false;
    try {
      while (pos < st.size && pos < 1024 * 1024 && !(entry.title && entry.threadId && entry.cwd)) {
        const n = fs.readSync(fd, buf, 0, buf.length, pos);
        if (!n) break;
        pos += n;
        const data = Buffer.concat([carry, buf.subarray(0, n)]);
        const cut = pos < st.size ? data.lastIndexOf(10) + 1 : data.length;
        carry = data.subarray(cut);
        for (const line of data.toString("utf8", 0, cut).split("\n")) {
          if (!line.trim()) continue;
          const ev = simplify(line);
          if (!ev) continue;
          if (ev.kind === "meta") {
            if (ev.cwd) entry.cwd = ev.cwd;
            if (ev.id && !entry.threadId) {
              entry.threadId = ev.id;
              // A child agent's rollout opens with the parent's history, so its first prompt is the parent's.
              child = !!ev.parentThreadId;
              if (child) entry.title = [ev.agentNickname && "Agent " + ev.agentNickname, ev.agentPath].filter(Boolean).join(" · ") || (ev.guardian ? "Guardian review" : "");
            }
          } else if (ev.kind === "user" && !ev.internal && !entry.title && !child) {
            entry.title = promptTitle(ev.text);
          }
          if (entry.title && entry.threadId && entry.cwd) break;
        }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* unreadable file - keep the bare entry so it is still findable by id */ }
  searchIndex.set(file, entry);
  return entry;
}

function buildSearchIndex() {
  const files = collectRolloutFiles(true);
  const live = new Set(files);
  for (const f of files) indexEntry(f, rolloutStats.get(f));
  for (const key of searchIndex.keys()) if (!live.has(key)) searchIndex.delete(key);
  searchIndexReady = true;
}

function searchMatch(entry, terms) {
  if (!terms.length) return false;
  const hay = ((entry.title || "") + " " + (entry.cwd || "") + " " +
    (entry.threadId || "") + " " + (entry.id || "")).toLowerCase();
  return terms.every(t => hay.includes(String(t).toLowerCase()));
}

function ingest(file) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  let s = sessions.get(file);
  if (!s) {
    s = { id: path.basename(file, ".jsonl"), file, offset: 0, partial: Buffer.alloc(0), meta: {}, events: [], callIds: new Set(), lastGrow: st.mtimeMs, size: 0 };
    sessions.set(file, s);
  }
  if (st.size < s.size) { s.offset = 0; s.partial = Buffer.alloc(0); s.events = []; s.callIds.clear(); } // truncated/rotated
  s.size = st.size;
  if (st.size <= s.offset) return;

  const buf = Buffer.alloc(Math.min(st.size - s.offset, 5 * 1024 * 1024));
  let fd, n = 0;
  try { fd = fs.openSync(file, "r"); n = fs.readSync(fd, buf, 0, buf.length, s.offset); }
  catch { return; } // vanished or locked between stat and read: offset unchanged, retry next tick
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  if (!n) return;
  s.offset += n;

  // Carry the cut last line as bytes, so a multi-byte character split across reads survives.
  const data = Buffer.concat([s.partial, buf.subarray(0, n)]);
  const cut = data.lastIndexOf(10) + 1;
  s.partial = Buffer.from(data.subarray(cut)); // copy so the 5 MiB read buffer is not retained
  const lines = data.toString("utf8", 0, cut).split("\n");
  const fresh = [];
  let newest = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    // lastGrow is the newest record time, not the file mtime (Codex 0.146+ pins that at
    // creation on Windows) and not Date.now() (a backfill of an old file is not live growth).
    const stamp = Date.parse((line.match(/^\{"timestamp":"([^"]+)"/) || [])[1]);
    if (stamp > newest) newest = stamp;
    const ev = simplify(line);
    if (!ev) continue;
    // rollouts log each message twice (event_msg + response_item) - drop consecutive duplicates.
    // Messages only: the same command twice in a row is a real re-run.
    const prevEv = s.events[s.events.length - 1];
    if (prevEv && prevEv.kind === ev.kind && prevEv.text === ev.text && (ev.kind === "user" || ev.kind === "agent")) continue;
    if (ev.callId) {
      if (s.callIds.has(ev.callId)) continue;
      s.callIds.add(ev.callId);
    }
    if (ev.kind === "meta") {
      if (ev.cwd) s.meta.cwd = ev.cwd;
      if (ev.model) s.meta.model = ev.model;
      if (ev.effort) s.meta.effort = ev.effort;
      if (ev.sandbox) s.meta.sandbox = ev.sandbox;
      if (ev.tokens) s.meta.tokens = ev.tokens;
      if (ev.contextTokens) s.meta.contextTokens = ev.contextTokens;
      if (ev.contextWindow) s.meta.contextWindow = ev.contextWindow;
      // First session_meta wins. A child agent's rollout repeats the parent's
      // session_meta after its own; taking the last one made the child carry the
      // parent's thread id and become its own parent.
      if (ev.id && !s.meta.threadId) {
        s.meta.threadId = ev.id;
        // A child agent's rollout opens with the parent's history, so its first
        // prompt is the parent's: title it by its own agent name and path instead.
        if (ev.parentThreadId) s.meta.title = [ev.agentNickname && "Agent " + ev.agentNickname, ev.agentPath].filter(Boolean).join(" · ") || (ev.guardian ? "Guardian review" : "");
      }
      if (ev.parentThreadId && !s.meta.parentThreadId) s.meta.parentThreadId = ev.parentThreadId;
      if (ev.agentNickname && !s.meta.agentNickname) s.meta.agentNickname = ev.agentNickname;
      if (ev.originator && !s.meta.originator) s.meta.originator = ev.originator;
      continue;
    }
    if (ev.kind === "user" && !ev.internal && !s.meta.title && !s.meta.parentThreadId) s.meta.title = promptTitle(ev.text);
    s.events.push(ev);
    fresh.push(ev);
    if (s.events.length > MAX_EVENTS_KEPT) s.events.splice(0, s.events.length - MAX_EVENTS_KEPT);
  }
  s.lastGrow = Math.max(s.lastGrow, newest || st.mtimeMs); // mtime only for files without timestamps
  if (fresh.length) {
    broadcast({ type: "events", session: s.id, events: fresh });
    if (fresh.some(event => event.kind === "done")) {
      broadcast({
        type: "complete",
        session: s.id,
        title: String(s.meta.title || "Codex task").slice(0, 120),
      }, notificationClients);
    }
  }
}

function sessionSummary(s, threadJobStatus) {
  // LIVE: file is growing, or the thread's companion job process is alive with
  // a fresh heartbeat (long thinking writes nothing to the rollout). DONE: wrote
  // task_complete. STALE: only with job evidence - the job process died or its
  // heartbeat stopped. A quiet session with no job is an interactive window the
  // user left open, not a stuck handoff, so it stays IDLE however long it sits.
  // STOPPED: quiet because the companion job for this thread was cancelled.
  const quiet = Date.now() - s.lastGrow;
  const jobLive = threadJobStatus ? threadJobStatus.get(s.meta.threadId) : undefined;
  // DONE only when the latest turn completed: a later turn start, prompt or abort clears it.
  let turnDone = false;
  for (let i = s.events.length - 1; i >= 0; i--) {
    const e = s.events[i];
    if (e.kind === "done") { turnDone = true; break; }
    if (e.kind === "sys" || e.kind === "err" || (e.kind === "user" && !e.internal)) break;
  }
  let status = quiet < LIVE_WINDOW_MS ? "LIVE"
    : turnDone ? "DONE"
    : jobLive === "working" ? "LIVE"
    : jobLive === "dead" || jobLive === "possibly-stuck" ? "STALE"
    : "IDLE";
  if ((status === "IDLE" || status === "STALE") && jobLive === "cancelled") status = "STOPPED";
  const last = s.events[s.events.length - 1];
  // A quiet session whose last event is an error (e.g. "turn aborted") and
  // that has no working job is stopped, not waiting forever.
  if (status === "IDLE" && last && last.kind === "err" && jobLive !== "working") status = "STOPPED";
  return {
    id: s.id,
    threadId: s.meta.threadId || "",
    parentThreadId: s.meta.parentThreadId || "",
    agentNickname: s.meta.agentNickname || "",
    originator: s.meta.originator || "", // "Claude Code" for a handoff; the UI tells Claude's prompts from yours by it
    title: s.meta.title || "",
    cwd: s.meta.cwd || "",
    model: s.meta.model || "",
    effort: s.meta.effort || "",
    sandbox: s.meta.sandbox || "",
    tokensUsed: s.meta.tokens || 0,
    contextTokens: s.meta.contextTokens || 0,
    contextWindow: s.meta.contextWindow || 0,
    status,
    archived: s.file.startsWith(ARCHIVED_DIR),
    lastGrow: s.lastGrow,
    quietMs: Math.floor(quiet / 5000) * 5000, // 5 s steps, so a quiet session does not change the list every tick
    lastKind: last ? last.kind : "",
    lastDone: !!(last && last.done), // a command that already finished
    lastText: last ? String(last.text).slice(0, 120) : "",
    lastEvent: last ? (last.kind + ": " + String(last.text).slice(0, 90)) : "",
    eventCount: s.events.length,
  };
}

function broadcast(obj, clients = sseClients) {
  if (!clients.size) return; // nobody listens: skip the stringify
  const line = "data: " + JSON.stringify(obj) + "\n\n";
  for (const res of clients) { try { res.write(line); } catch {} }
}

function tick() {
  lastTickAt = Date.now();
  try {
    const files = listRolloutFiles();
    for (const [file] of pinnedFiles) {
      if (!fs.existsSync(file)) { pinnedFiles.delete(file); continue; }
      if (!files.includes(file)) files.push(file);
    }
    // A resumed old rollout is an extra until it ranks in on its own or is read to its end
    // (offset against this tick's fresh stat, so bytes written since the last read keep it; a file
    // that shrank is not "read to its end": ingest resets the reader and reads it again first).
    for (const file of resumedFiles) {
      const s = sessions.get(file), st = rolloutStats.get(file);
      if (files.includes(file) || (s && st && st.size >= s.size && s.offset >= st.size)) { resumedFiles.delete(file); continue; }
      files.push(file);
    }
    for (const f of files) ingest(f);
    for (const key of sessions.keys()) if (!files.includes(key)) sessions.delete(key);
    const threadJobStatus = threadJobStatuses(listCompanionJobs());
    const list = files.map(f => sessions.get(f)).filter(Boolean).map(s => sessionSummary(s, threadJobStatus));
    codexActive = list.filter(s => s.status === "LIVE").length;
    // Unchanged list: no frame. A new tab gets the full list from /events on connect.
    const sig = JSON.stringify(list);
    if (sig !== sessionsSig) {
      sessionsSig = sig;
      broadcast({ type: "sessions", sessions: list });
    }
  } finally {
    clearTimeout(tickTimer);
    tickTimer = null;
    scheduleTick(sseClients.size ? Math.max(POLL_MS, tickGap(codexActive + claudeActive)) : IDLE_POLL_MS);
  }
}

// newest job per thread wins - a cancelled thread that was resumed is running again
function threadJobStatuses(jobs) {
  const map = new Map();
  const now = Date.now();
  for (const job of jobs || []) {
    if (job.threadId && !map.has(job.threadId)) map.set(job.threadId, classifyJobLiveness(job, pidAlive(job.pid), now));
  }
  return map;
}

// Adaptive refresh. A file change (fs.watch) or a job notice pulls the next tick in, but never
// closer than tickGap after the last one: the more tasks run at once, the longer the gap.
// Without changes the poll runs every 1 s (or the gap, if longer); with no browser every 5 s.
const IDLE_POLL_MS = 5000;
let tickTimer = null, tickDue = 0, lastTickAt = 0, sessionsSig = "", codexActive = 0, claudeActive = 0;
function tickGap(active) {
  return Math.min(2000, 250 + 75 * (active || 0));
}
function scheduleTick(delay) {
  const due = Date.now() + Math.max(0, delay);
  if (tickTimer && tickDue <= due) return;
  clearTimeout(tickTimer);
  tickDue = due;
  tickTimer = setTimeout(() => { tickTimer = null; tick(); }, due - Date.now());
}
function kick() {
  if (!sseClients.size) return; // no browser: the 5 s poll is enough
  scheduleTick(lastTickAt + tickGap(codexActive + claudeActive) - Date.now());
}
function watchSessions() {
  try { fs.watch(SESSIONS_DIR, { recursive: true }, kick); }
  catch { /* recursive watch unsupported on some platforms - poll covers it */ }
  try { fs.watch(ARCHIVED_DIR, { recursive: true }, kick); }
  catch { /* dir may not exist yet - the 1s poll covers it */ }
}

// ---------------- process control (kill stuck sessions) ----------------
// Rollout files carry no PID, so we list codex-related processes and let the
// user pick; the UI sorts them by closeness to the session start time.
function codexProcs(cb) {
  if (process.platform !== "win32") return cb([]); // kill feature is Windows-only for now
  const script =
    "$me=$PID;" +
    "Get-CimInstance Win32_Process | Where-Object {" +
    " ($_.ProcessId -ne $me) -and" +
    " ([string]$_.CommandLine -notmatch 'codex-live-viewer') -and" +
    " (($_.Name -match 'codex') -or ([string]$_.CommandLine -match 'codex(\\.exe)?\"?\\s+(exec|apply|resume|proto|app-server|mcp)'))" +
    "} | ForEach-Object { [pscustomobject]@{" +
    " pid=$_.ProcessId; name=$_.Name;" +
    " started=$(if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0});" +
    " cmd=[string]$_.CommandLine } } | ConvertTo-Json -Compress";
  execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) return cb([]);
      let j; try { j = JSON.parse(stdout || "[]"); } catch { return cb([]); }
      cb(Array.isArray(j) ? j : j ? [j] : []);
    });
}

// ---------------- companion job state (shared with the plugin) ----------------
const COMPANION_STATE_ROOT = process.env.CODEX_COMPANION_STATE_ROOT
  || path.join(os.homedir(), ".codex-companion", "state");
function resolveCompanionScript(baseDir) {
  const candidates = [
    path.join(baseDir, "plugin", "scripts", "codex-companion.mjs"), // repo layout
    path.join(baseDir, "..", "scripts", "codex-companion.mjs"),     // bundled: plugin/viewer/
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}
const COMPANION_SCRIPT = resolveCompanionScript(__dirname);
const STUCK_AFTER_MS = 5 * 60 * 1000; // alive but no heartbeat this long => possibly stuck

function classifyJobLiveness(job, pidIsAlive, now) {
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return job.status;
  if (!pidIsAlive) return "dead";
  const beatMs = job.heartbeatAt ? now - Date.parse(job.heartbeatAt) : Infinity;
  // ponytail: heartbeat freshness only; if pid is alive we never flag before
  // STUCK_AFTER_MS, so long-running commands are not misreported as stuck.
  return beatMs < STUCK_AFTER_MS ? "working" : "possibly-stuck";
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Parsed state.json per workspace, reused while its mtime and size hold, for 10 s at most.
// Callers still check pid and heartbeat on every use; the records are read-only.
const jobStateCache = new Map(); // dir name -> { mtimeMs, size, at, jobs }
function listCompanionJobs(fresh) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(COMPANION_STATE_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
  const now = Date.now();
  const seen = new Set();
  for (const d of dirs) {
    seen.add(d.name);
    try {
      const file = path.join(COMPANION_STATE_ROOT, d.name, "state.json");
      const st = fs.statSync(file);
      let cached = jobStateCache.get(d.name);
      if (fresh || !cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size || now - cached.at > 10000) {
        cached = { mtimeMs: st.mtimeMs, size: st.size, at: now, jobs: JSON.parse(fs.readFileSync(file, "utf8")).jobs || [] };
        jobStateCache.set(d.name, cached);
      }
      for (const job of cached.jobs) out.push({ ...job, stateDir: d.name });
    } catch { jobStateCache.delete(d.name); /* partial write or foreign dir - skip, read again next time */ }
  }
  for (const name of jobStateCache.keys()) if (!seen.has(name)) jobStateCache.delete(name);
  out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  return out.slice(0, 100);
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function companionJobFile(stateDir, jobId) {
  if (!SAFE_SEGMENT.test(stateDir) || !SAFE_SEGMENT.test(jobId)) return null;
  return path.join(COMPANION_STATE_ROOT, stateDir, "jobs", jobId + ".json");
}

const DEFAULT_RESUME_PROMPT = "Continue the previous task where it left off and finish it.";

function buildCompanionTaskArgs(body) {
  const args = ["task", "--background", "--json", "--cwd", body.cwd];
  if (body.effort) args.push("--effort", String(body.effort));
  if (body.model) args.push("-m", String(body.model));
  if (body.write) args.push("--write");
  if (body.resumeThreadId) args.push("--resume-thread", String(body.resumeThreadId));
  if (body.fast) args.push("--fast");
  if (body.prompt) args.push(String(body.prompt));
  return args;
}

function readJsonBody(req, cb) {
  let body = "";
  req.setEncoding("utf8"); // decodes across chunks, so a character split between two chunks survives
  req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => { let j = null; try { j = JSON.parse(body); } catch {} cb(j); });
}

// Runs in the job's own folder (every call passes --cwd). From the viewer's folder the
// companion would record a --cwd pointer there, and a Claude session in that folder
// would be handed jobs from an unrelated project.
function runCompanion(args, extraEnv, cb) {
  const cwdAt = args.indexOf("--cwd");
  execFile(process.execPath, [COMPANION_SCRIPT, ...args], {
    cwd: cwdAt === -1 ? undefined : args[cwdAt + 1],
    env: { ...process.env, ...extraEnv },
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  }, (err, stdout, stderr) => {
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}
    cb(err, parsed, String(stderr || err || "").slice(0, 500));
  });
}

function jsonReply(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function isUsableDir(p) {
  try { return typeof p === "string" && p.length > 0 && fs.statSync(p).isDirectory(); } catch { return false; }
}

function handleLaunch(res, body, args) {
  const env = body.sandbox ? { CODEX_PLUGIN_SANDBOX: String(body.sandbox) } : {};
  runCompanion(args, env, (err, parsed, errText) => {
    if (err || !parsed || !parsed.jobId) return jsonReply(res, 500, { ok: false, error: errText || "companion did not return a job id" });
    jsonReply(res, 200, { ok: true, jobId: parsed.jobId, logFile: parsed.logFile || "" });
  });
}

// ---------------- Claude workflows (read only) ----------------
// Claude Code writes every Workflow tool run under CLAUDE_PROJECTS/<slug>/<session>/:
//   subagents/workflows/<runId>/{journal.jsonl, agent-<id>.jsonl, agent-<id>.meta.json}
//   workflows/<runId>.json (snapshot, written at run end), workflows/scripts/<name>-<runId>.js
// Polled, never fs.watch'ed (GBs, and every transcript write would fire). Nothing here writes.
// Only ids, labels, titles, paths, phases, states, counts, times, tool previews (a tool name and the first line of
// its input, the same a Codex feed shows), token counts, models and efforts reach /events; transcript text goes out
// only through /claude/transcript (and its alias /claude/agent). Both sit behind trustedControlOrigin.
const CLAUDE_SCAN_MS = 5000;              // new runs appear within this
const CLAUDE_MAX_RUNS = 20;               // newest runs tracked; running runs always kept on top
const CLAUDE_KEEP_MS = 24 * 60 * 60 * 1000; // no activity this long => dropped from memory (files stay)
const CLAUDE_TOOL_GRACE_MS = 30 * 60 * 1000; // an agent waiting on its own tool stays Running this long
const CLAUDE_MAX_AGENTS_SENT = 150;       // per run in the frame; counts stay exact
const CLAUDE_RUN_ID = /^wf_[A-Za-z0-9-]{3,40}$/;
const CLAUDE_AGENT_ID = /^a[0-9a-f]{6,40}$/;
const claudeRuns = new Map();             // runId -> run (claudeNewRun has the shape)
let claudeFrameSig = "";
let claudeFrame = { type: "claudeRuns", runs: [] };

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
function readAppended(file, cursor, maxBytes) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (st.size < cursor.size) { cursor.offset = 0; cursor.partial = Buffer.alloc(0); }
  const from = cursor.offset;
  if (st.size <= from) { cursor.size = st.size; return { lines: [], st }; }
  const buf = Buffer.alloc(Math.min(st.size - from, maxBytes));
  let fd, n = 0;
  try { fd = fs.openSync(file, "r"); n = fs.readSync(fd, buf, 0, buf.length, from); }
  catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  const data = Buffer.concat([cursor.partial, buf.subarray(0, n)]);
  const cut = data.lastIndexOf(10) + 1;
  cursor.partial = Buffer.from(data.subarray(cut));
  cursor.offset = from + n;
  cursor.size = st.size;
  return { lines: data.toString("utf8", 0, cut).split("\n").filter((l) => l.trim()), st };
}

function claudeCursor() { return { offset: 0, size: 0, partial: Buffer.alloc(0) }; }

function claudeReadHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, bytes, 0));
  } catch { return ""; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// The last `bytes` of a file; midFile when the read did not start at byte 0.
function claudeReadTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - from);
    return { text: buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, from)), midFile: from > 0 };
  } catch { return { text: "", midFile: false }; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

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
    counts, phases: [...phaseMap.values()],
    agents: sent.map(({ order, ...a }) => a), agentsHidden: all.length - sent.length,
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
  claudeFrame = frame;
  broadcast(frame);
}

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

// ---------------- Claude chats (read only) ----------------
// The tree under each Claude main chat: plain subagents (nested by parentAgentId), workflow runs
// and Codex handoffs. Every chat file is listed each scan; only the root window is read. A chat is
// read once from the end when it is tracked, then only its new lines. Usage totals and the links of
// old handoffs come from one capped backfill read per file, in CLAUDE_SLICE_MS slices per tick.
// Nothing here writes, and a whole chat file is never read on a timer.
const CLAUDE_CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_ROOT_MS = 24 * 60 * 60 * 1000;   // roots: chats with a write in this window ...
const CLAUDE_MAX_ROOTS = 30;                    // ... the newest this many, plus every chat with running work
const CLAUDE_MAX_CHILDREN_SENT = 20;            // per chat in the frame; counts stay exact
const CLAUDE_SCAN_CAP = 64 * 1024 * 1024;       // backfill reads at most the newest this of one file; usage is then "at least"
const CLAUDE_SLICE_MS = 20;                     // backfill budget per tick
const CLAUDE_SWEEP_MS = 15000;                  // stat every chat file this often (a resume appends to an old one)
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_HOME, "sessions"); // <pid>.json while a Claude process lives
// Claude Code keeps its global state file in CLAUDE_CONFIG_DIR when set, else in the home folder.
const CLAUDE_STATE_FILE = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(os.homedir(), ".claude.json");
const claudeChatFiles = new Map(); // sessionId -> { file, slug, mtimeMs } for every chat file on disk
const claudeChats = new Map();     // sessionId -> tracked chat (claudeNewChat)
const claudeWfReaders = new Map(); // "<session>/<runId>/<agentId>" -> reader of a workflow agent (usage, launches)
const claudeLinks = new Map();     // job id or Codex thread id -> { node, chat, rank }: the transcript that launched it
let claudePids = new Map();        // sessionId -> { status } for a live Claude process
let claudeLastSweep = 0;
let claudeJobs = [];               // listCompanionJobs(), refreshed each scan
let claudeChatsSig = "";
let claudeChatsFrame = { type: "claudeChats", chats: [], ghosts: [] };
// The plugin's status line script saves the 5-hour and 7-day windows here after each Claude reply.
const CLAUDE_LIMITS_FILE = path.join(os.homedir(), ".codex-companion", "claude-limits.json");
let claudeUsageMtime = -1;
let claudeUsageFrame = { type: "claudeUsage", usage: null };

// Codex plan limits, read live through the companion (one short app-server, about 1 s) only
// while a browser is connected: on connect, every CODEX_LIMITS_MS, and when a job ends.
// A failed read keeps the last good numbers and adds the error.
const CODEX_LIMITS_MS = 5 * 60 * 1000;
let codexLimitsFrame = { type: "codexLimits", limits: null };
let codexLimitsAtMs = 0;
let codexLimitsBusy = false;
let codexLimitsRead = 0; // the read whose answer counts; a late answer of a released read is dropped
function refreshCodexLimits(force) {
  const now = Date.now();
  if (!sseClients.size || (codexLimitsBusy && now - codexLimitsAtMs < 120000)) return; // a hung read frees the slot after 2 min
  if (!force && now - codexLimitsAtMs < CODEX_LIMITS_MS) return;
  codexLimitsBusy = true;
  codexLimitsAtMs = now;
  const read = ++codexLimitsRead;
  runCompanion(["limits", "--json", "--cwd", os.homedir()], {}, (_err, parsed, stderr) => {
    if (read !== codexLimitsRead) return;
    codexLimitsBusy = false;
    const last = codexLimitsFrame.limits;
    const limits = parsed && parsed.ok ? parsed : {
      ...(last && last.windows ? last : { windows: [], resets: null, fetchedAtMs: 0 }),
      ok: false, allowed: null, error: String((parsed && parsed.detail) || stderr || "no reply").slice(0, 200),
    };
    codexLimitsFrame = { type: "codexLimits", limits };
    broadcast(codexLimitsFrame);
  });
}

// One chat or agent transcript line -> the facts the tree needs. Text is kept only where a fact
// needs it (a tool result is scanned for job ids, then dropped).
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
  const own = [...t.matchAll(/Codex job: ((?:task|review)-[a-z0-9]{6,12}-[a-z0-9]{4,8})(?: · thread: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?/gi)].pop();
  if (own) return { jobIds: [own[1]], threadIds: own[2] ? [own[2].toLowerCase()] : [] };
  const jobIds = [...new Set([...t.matchAll(/\b((?:task|review)-[a-z0-9]{6,12}-[a-z0-9]{4,8})\b/g)].map((m) => m[1]))];
  const threadIds = [...new Set([...t.matchAll(/(?:Codex session ID:|thread:|codex resume)\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi)].map((m) => m[1].toLowerCase()))];
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
function claudeUsageView(j) {
  const c = j && j.cachedUsageUtilization;
  if (!c || typeof c !== "object") return null;
  const s = (v) => typeof v === "string" ? v : "";
  const n = (v) => typeof v === "number" && isFinite(v) ? v : 0;
  const u = c.utilization && typeof c.utilization === "object" ? c.utilization : {};
  const limits = (Array.isArray(u.limits) ? u.limits : []).filter((l) => l && typeof l.kind === "string").map((l) => ({
    kind: l.kind, isActive: l.is_active === true, percent: n(l.percent), severity: s(l.severity), resetsAt: s(l.resets_at),
    model: s(l.scope && l.scope.model && l.scope.model.display_name),
  }));
  const sp = u.spend && typeof u.spend === "object" ? u.spend : null;
  return { fetchedAtMs: n(c.fetchedAtMs), limits, spend: sp && sp.enabled ? { percent: n(sp.percent), severity: s(sp.severity) } : null };
}

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
  for (const c of claudeChats.values()) if (claudeChatsFrame.chats.some((x) => x.sessionId === c.id && x.state !== "done")) busy.add(c.id);
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
function claudeUsageMerge(snapshot, line) {
  const n = (v) => typeof v === "number" && isFinite(v) ? v : null;
  const win = (w, kind) => w && n(w.usedPercent) !== null
    ? { kind, isActive: false, percent: w.usedPercent, severity: null, resetsAt: n(w.resetsAtMs) ? new Date(w.resetsAtMs).toISOString() : "", model: "" }
    : null;
  if (!line || !n(line.atMs) || (snapshot && snapshot.fetchedAtMs > line.atMs)) return snapshot ? { ...snapshot, source: "snapshot" } : null;
  const scoped = snapshot ? snapshot.limits.filter((l) => l.kind === "weekly_scoped").map((l) => ({ ...l, atMs: snapshot.fetchedAtMs })) : [];
  return {
    source: "statusline", fetchedAtMs: line.atMs,
    limits: [win(line.fiveHour, "session"), win(line.sevenDay, "weekly_all"), ...scoped].filter(Boolean),
    spend: snapshot ? snapshot.spend : null, spendAtMs: snapshot ? snapshot.fetchedAtMs : 0,
  };
}

function claudeUsageCheck() {
  let st, lt;
  try { st = fs.statSync(CLAUDE_STATE_FILE); } catch { st = null; }
  try { lt = fs.statSync(CLAUDE_LIMITS_FILE); } catch { lt = null; }
  const mtime = (st ? st.mtimeMs : 0) + "/" + (lt ? lt.mtimeMs : 0);
  if (mtime === claudeUsageMtime) return;
  claudeUsageMtime = mtime;
  let snapshot = null, line = null;
  try { snapshot = st ? claudeUsageView(JSON.parse(fs.readFileSync(CLAUDE_STATE_FILE, "utf8"))) : null; } catch { claudeUsageMtime = -1; return; } // mid-write: retry
  try { line = lt ? JSON.parse(fs.readFileSync(CLAUDE_LIMITS_FILE, "utf8")) : null; } catch { line = null; }
  const usage = claudeUsageMerge(snapshot, line);
  if (JSON.stringify(usage) === JSON.stringify(claudeUsageFrame.usage)) return;
  claudeUsageFrame = { type: "claudeUsage", usage };
  broadcast(claudeUsageFrame);
}

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
  claudeActive = running;
  try { claudeBackfill(Date.now() + CLAUDE_SLICE_MS); } catch {}
  let frame;
  try { frame = claudeChatsBuild(now); } catch { return; }
  const sig = JSON.stringify(frame);
  if (sig === claudeChatsSig) return;
  claudeChatsSig = sig;
  claudeChatsFrame = frame;
  broadcast(frame);
}

// ---------------- HTTP ----------------
const FALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Codex Live</title><style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#c9d1d9;--dim:#8b949e;--green:#3fb950;--yellow:#d29922;--blue:#58a6ff;--red:#f85149;--purple:#bc8cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 "Cascadia Code",Consolas,monospace;display:flex;height:100vh}
#side{width:340px;min-width:280px;border-right:1px solid var(--border);overflow-y:auto;background:var(--panel)}
#side h1{font-size:14px;padding:12px 14px;margin:0;border-bottom:1px solid var(--border)}
#tabs{display:flex;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--panel);z-index:1}
.tab{flex:1;text-align:center;padding:7px 0;cursor:pointer;color:var(--dim);font-size:11px;border-bottom:2px solid transparent;user-select:none}
.tab:hover{color:var(--fg)}.tab.on{color:var(--fg);border-bottom-color:var(--blue)}
.tab .n{opacity:.7}
.sess{padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer}
.sess:hover{background:#1c2128}.sess.sel{background:#1f2937;border-left:3px solid var(--blue)}
.sess .top{display:flex;align-items:center;gap:7px}
.sess .top .when{color:var(--dim);font-size:10px;margin-left:auto}
.dot{width:8px;height:8px;border-radius:50%;background:var(--blue);flex:none;box-shadow:0 0 6px var(--blue)}
.badge{font-size:10px;padding:1px 7px;border-radius:9px;font-weight:bold}
.LIVE{background:var(--green);color:#000;animation:pulse 1.2s infinite}
.IDLE{background:var(--yellow);color:#000}.DONE{background:#30363d;color:var(--dim)}
.STALE{background:#6e2c2c;color:var(--fg)}
@keyframes pulse{50%{opacity:.55}}
.title{font-weight:bold;font-size:12px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px}
.cwd{color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lastev{color:var(--dim);font-size:11px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#main{flex:1;display:flex;flex-direction:column}
#head{padding:10px 16px;border-bottom:1px solid var(--border);background:var(--panel);font-size:12px;color:var(--dim);min-height:41px}
#headrow{display:flex;align-items:center;gap:10px}
#headtxt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#stopbtn{background:var(--red);color:#000;border:0;border-radius:4px;padding:3px 10px;font:inherit;font-size:11px;font-weight:bold;cursor:pointer;flex:none}
#stopbtn:hover{opacity:.85}
#stoplist{margin-top:8px;border-top:1px solid var(--border);padding-top:8px;font-size:11px}
.proc{display:flex;gap:8px;align-items:flex-start;margin-bottom:4px;color:var(--dim);word-break:break-all}
.proc.close{color:var(--fg)}
.killbtn{background:var(--red);color:#000;border:0;border-radius:3px;padding:1px 8px;cursor:pointer;font:inherit;font-size:10px;font-weight:bold;flex:none}
#feed{flex:1;overflow-y:auto;padding:12px 16px}
.ev{margin-bottom:8px;white-space:pre-wrap;word-break:break-word}
.ev .k{font-size:10px;font-weight:bold;margin-right:8px;padding:1px 6px;border-radius:3px}
.k-user{background:var(--blue);color:#000}.k-agent{background:var(--green);color:#000}
.k-cmd{background:var(--yellow);color:#000}.k-out{background:#30363d;color:var(--dim)}
.k-patch{background:var(--purple);color:#000}.k-think{background:#30363d;color:var(--dim)}
.k-tool{background:#30363d;color:var(--fg)}.k-done{background:var(--green);color:#000}
.k-err{background:var(--red);color:#000}.k-sys{background:#30363d;color:var(--dim)}
.ev.cmd .t{color:var(--yellow)}.ev.out .t{color:var(--dim)}.ev.think .t{color:var(--dim);font-style:italic}
.ev.patch .t{color:var(--purple)}
.seccap{margin:16px 0 6px;font-size:10px;font-weight:bold;letter-spacing:1.5px;padding-bottom:3px;border-bottom:1px solid var(--border);color:var(--dim)}
.seccap:first-child{margin-top:0}
.seccap.user{color:var(--blue)}.seccap.agent{color:var(--green)}.seccap.work{color:var(--yellow)}
details{margin-top:2px}summary{color:var(--dim);cursor:pointer;font-size:11px}
#empty{color:var(--dim);padding:40px;text-align:center}
</style></head><body>
<div id="side"><h1>Codex Live Sessions</h1><div id="tabs"></div><div id="list"></div></div>
<div id="main"><div id="head"><div id="headrow"><span id="headtxt">select a session (LIVE sessions auto-select)</span><button id="stopbtn" hidden>Stop task&#8230;</button></div><div id="stoplist" hidden></div></div><div id="feed"><div id="empty">Waiting for sessions...<br><br>Fire a handoff from Claude Code and it appears here the moment it starts.</div></div></div>
<script>
let sessions=[],selected=null,store={},autoFollow=true,filter='LIVE',seeded=false,lastSig='';
const unread=new Set(),prevStatus={};
const list=document.getElementById('list'),feed=document.getElementById('feed'),tabs=document.getElementById('tabs');
const headtxt=document.getElementById('headtxt'),stopbtn=document.getElementById('stopbtn'),stoplist=document.getElementById('stoplist');
function fmt(ts){if(!ts)return'';try{return new Date(ts).toLocaleTimeString()}catch{return''}}
function renderTabs(){
  const counts={ALL:sessions.length,LIVE:0,IDLE:0,STALE:0,DONE:0};
  for(const s of sessions)counts[s.status]=(counts[s.status]||0)+1;
  tabs.innerHTML='';
  for(const f of['LIVE','IDLE','STALE','DONE','ALL']){
    const d=document.createElement('div');d.className='tab'+(f===filter?' on':'');
    d.innerHTML=f+' <span class="n">'+(counts[f]||0)+'</span>';
    d.onclick=()=>{filter=f;lastSig='';renderList()};
    tabs.appendChild(d);
  }
}
function renderList(){
  renderTabs();
  const shown=sessions.filter(s=>filter==='ALL'||s.status===filter);
  // skip DOM rebuild when nothing visible changed (rebuilding every tick killed text selection)
  const sig=JSON.stringify([filter,selected,shown.map(s=>[s.id,s.status,s.lastEvent,s.title,unread.has(s.id)])]);
  if(sig===lastSig)return;lastSig=sig;
  list.innerHTML='';
  for(const s of shown){
    const d=document.createElement('div');d.className='sess'+(s.id===selected?' sel':'');
    // session text (cwd, last message) comes from rollout files - never innerHTML it
    d.innerHTML='<div class="top"><span class="badge '+s.status+'">'+s.status+'</span>'
      +(unread.has(s.id)?'<span class="dot" title="new activity"></span>':'')
      +'<span class="when"></span></div><div class="title"></div><div class="cwd"></div><div class="lastev"></div>';
    d.querySelector('.when').textContent=new Date(s.lastGrow).toLocaleTimeString();
    d.querySelector('.title').textContent=s.title||'(no prompt yet)';
    d.querySelector('.title').title=s.title||'';
    d.querySelector('.cwd').textContent=s.cwd||s.id;
    d.querySelector('.lastev').textContent=s.lastEvent||'';
    d.onclick=()=>select(s.id,true);
    list.appendChild(d);
  }
  if(!shown.length){
    const d=document.createElement('div');
    d.style.cssText='color:var(--dim);padding:30px 14px;text-align:center;font-size:12px';
    d.textContent='no '+filter+' sessions';
    list.appendChild(d);
  }
}
function select(id,byUser){
  if(byUser)autoFollow=false;
  selected=id;unread.delete(id);lastSig='';
  renderList();renderFeed();
}
function evHtml(e){
  const t=document.createElement('div');t.className='ev '+e.kind;
  let inner='<span class="k k-'+e.kind+'">'+e.kind.toUpperCase()+'</span><span style="color:var(--dim);font-size:10px;margin-right:8px">'+fmt(e.ts)+'</span><span class="t"></span>';
  t.innerHTML=inner;t.querySelector('.t').textContent=e.text||'';
  if(e.detail){const det=document.createElement('details');det.innerHTML='<summary>patch content</summary>';const pre=document.createElement('pre');pre.textContent=e.detail;pre.style.color='var(--purple)';det.appendChild(pre);t.appendChild(det);}
  return t;
}
function renderHead(){
  const meta=sessions.find(s=>s.id===selected);
  headtxt.textContent=meta?((meta.cwd||meta.id)+'   |   model: '+(meta.model||'?')+'   |   thread: '+(meta.threadId||'?')+'   |   resume: codex resume '+(meta.threadId||'')):'select a session (LIVE sessions auto-select)';
  stopbtn.hidden=!meta||meta.status==='DONE'; // nothing left to stop on completed tasks
  if(stopbtn.hidden)stoplist.hidden=true;
}
// short blip on status changes; pitch says what happened
let actx;
function beep(f){
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended')actx.resume();
    const o=actx.createOscillator(),g=actx.createGain();
    o.type='sine';o.frequency.value=f;
    g.gain.setValueAtTime(.08,actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.0001,actx.currentTime+.18);
    o.connect(g);g.connect(actx.destination);o.start();o.stop(actx.currentTime+.2);
  }catch{}
}
const TONES={LIVE:880,DONE:520,STALE:300,IDLE:660};
function sessStart(id){
  const m=(id||'').match(/rollout-(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})/);
  return m?new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime():0;
}
stopbtn.onclick=async()=>{
  if(!stoplist.hidden){stoplist.hidden=true;return}
  stoplist.hidden=false;stoplist.textContent='scanning codex processes...';
  let procs=[];
  try{procs=await(await fetch('/procs')).json()}catch{}
  if(!procs.length){stoplist.textContent='no codex processes found (session process already exited)';return}
  const t0=sessStart(selected);
  procs.sort((a,b)=>Math.abs(a.started-t0)-Math.abs(b.started-t0));
  stoplist.innerHTML='';
  if(t0&&!procs.some(p=>Math.abs(p.started-t0)<15000)){
    const w=document.createElement('div');
    w.style.cssText='color:var(--yellow);margin-bottom:8px';
    w.textContent='\\u26a0 No process matches this session\\u2019s start time \\u2014 the session is most likely already dead. '
      +'The processes below are shared app-servers / hosts (Codex Desktop, VS Code extension); '
      +'killing one affects ALL sessions running through it, not just this one.';
    stoplist.appendChild(w);
  }
  for(const p of procs){
    const closeMatch=t0&&Math.abs(p.started-t0)<15000;
    const r=document.createElement('div');r.className='proc'+(closeMatch?' close':'');
    const b=document.createElement('button');b.className='killbtn';b.textContent='KILL';
    b.onclick=async()=>{
      if(b.disabled)return;
      if(!b.dataset.armed){b.dataset.armed='1';b.textContent='CONFIRM KILL (pid + child tree, cannot be undone)';return}
      b.disabled=true;b.textContent='KILLING...';
      let msg='';try{msg=await(await fetch('/kill?pid='+p.pid,{method:'POST'})).text()}catch(e){msg='request failed: '+e}
      stoplist.textContent=msg;
    };
    const txt=document.createElement('span');
    txt.textContent='[pid '+p.pid+'] '+p.name+' | started '+(p.started?new Date(p.started).toLocaleTimeString():'?')
      +(closeMatch?' \\u2190 matches this session start':'')+' | '+String(p.cmd||'').slice(0,160);
    r.appendChild(b);r.appendChild(txt);stoplist.appendChild(r);
  }
};
// feed sections: caption row whenever the event category changes (user / agent / working / status)
const CATS={user:'user',agent:'agent',cmd:'work',out:'work',patch:'work',tool:'work',think:'work',sys:'sys',done:'sys',err:'sys'};
const CAPTION={user:'▸ USER',agent:'▸ AGENT',work:'▸ WORKING — commands / files / thinking',sys:'▸ STATUS'};
let lastCat=null;
function appendEv(e){
  const c=CATS[e.kind]||'sys';
  if(c!==lastCat){
    const cap=document.createElement('div');cap.className='seccap '+c;cap.textContent=CAPTION[c];
    feed.appendChild(cap);lastCat=c;
  }
  feed.appendChild(evHtml(e));
}
// full feed rebuild ONLY on session switch / snapshot; live events append incrementally,
// so selecting text in the feed is never wiped by updates
function renderFeed(){
  feed.innerHTML='';lastCat=null;const evs=store[selected]||[];
  renderHead();
  if(!evs.length){feed.innerHTML='<div id="empty">no displayable events yet</div>';return}
  for(const e of evs)appendEv(e);
  feed.scrollTop=feed.scrollHeight;
}
const es=new EventSource('/events');
es.onmessage=m=>{
  const d=JSON.parse(m.data);
  if(d.type==='sessions'){
    for(const s of d.sessions){
      const ps=prevStatus[s.id];
      const changed=ps===undefined||ps!==s.status;
      // unread marker: new session appears, or status flips, while not being watched
      if(seeded&&s.id!==selected&&changed)unread.add(s.id);
      if(seeded&&changed)beep(TONES[s.status]||660);
      prevStatus[s.id]=s.status;
    }
    seeded=true;
    sessions=d.sessions;renderList();renderHead();
    if(autoFollow){const live=sessions.find(s=>s.status==='LIVE');if(live&&live.id!==selected)select(live.id,false)}
  }
  if(d.type==='snapshot'){store[d.session]=d.events;if(d.session===selected)renderFeed()}
  if(d.type==='events'){(store[d.session]=store[d.session]||[]).push(...d.events);
    if(store[d.session].length>500)store[d.session].splice(0,store[d.session].length-500);
    if(d.session===selected){for(const e of d.events)appendEv(e);feed.scrollTop=feed.scrollHeight}
    else if(seeded){unread.add(d.session);lastSig='';renderList()}}
};
</script></body></html>`;

let PAGE = FALLBACK_PAGE;
try {
  PAGE = fs.readFileSync(path.join(__dirname, "viewer-ui.html"), "utf8");
} catch {
  // Keep the embedded page as a compatibility fallback for single-file installs.
}

let LOGO = null;
try {
  LOGO = fs.readFileSync(path.join(__dirname, "assets", "logo.svg"), "utf8");
} catch {
  // The embedded compatibility UI does not require the standalone logo asset.
}

const server = http.createServer((req, res) => {
  const auth = tunnelAuthDecision(req.headers, req.url, TOKEN, FLAGS.tunnel);
  if (!auth.allow) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("token required"); }
  if (auth.setCookie) res.setHeader("Set-Cookie", "clv_token=" + TOKEN + "; HttpOnly; Path=/; SameSite=Lax; Secure");
  if (auth.redirect) { res.writeHead(302, { Location: auth.redirect }); return res.end(); }
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      application: APP_ID,
      version: APP_VERSION,
      notificationListener: notificationClients.size > 0,
    }));
  } else if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  } else if (req.url === "/logo.svg" && LOGO) {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
    res.end(LOGO);
  } else if (req.url === "/shutdown") {
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("bye");
    setTimeout(() => process.exit(0), 100);
  } else if (req.url === "/procs") {
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    codexProcs(list => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
    });
  } else if (req.url.startsWith("/kill?pid=")) {
    if (process.platform !== "win32") { res.writeHead(501); return res.end("kill is Windows-only for now"); }
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    const pid = parseInt(req.url.slice("/kill?pid=".length), 10);
    if (!Number.isInteger(pid) || pid <= 0) { res.writeHead(400); return res.end("bad pid"); }
    // re-verify the pid is still a codex process before killing anything
    codexProcs(list => {
      if (!list.some(p => p.pid === pid)) { res.writeHead(400); return res.end("pid " + pid + " is not a codex process (already gone?)"); }
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], (err, so, se) => {
        res.writeHead(err ? 500 : 200, { "Content-Type": "text/plain" });
        res.end(err ? ("kill failed: " + String(se || err).slice(0, 300)) : "killed pid " + pid + " (+ child tree)");
      });
    });
  } else if (req.url.startsWith("/open?id=")) {
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    let id;
    try { id = decodeURIComponent(req.url.slice("/open?id=".length)); } catch { res.writeHead(400); return res.end("bad id"); }
    // A session id, or a thread id (a handoff row whose session left the newest 40; the file name ends with it).
    const entry = [...searchIndex.values()].find(e => e.id === id || e.threadId === id || e.id.endsWith("-" + id));
    res.writeHead(entry ? 200 : 404, { "Content-Type": "application/json" });
    if (!entry) return res.end(JSON.stringify({ ok: false, error: "unknown session id" }));
    pinnedFiles.set(entry.file, Date.now());
    while (pinnedFiles.size > MAX_PINNED) {
      let oldestKey = null, oldestTs = Infinity;
      for (const [file, ts] of pinnedFiles) if (ts < oldestTs) { oldestTs = ts; oldestKey = file; }
      pinnedFiles.delete(oldestKey);
    }
    ingest(entry.file);
    tick();
    res.end(JSON.stringify({ ok: true, id: entry.id }));
  } else if (req.url.startsWith("/search?q=")) {
    // Reads need the Host check too: a DNS-rebound page would otherwise read titles, prompts and paths.
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    let q;
    try { q = decodeURIComponent(req.url.slice("/search?q=".length)).trim().toLowerCase(); } catch { res.writeHead(400); return res.end("bad query"); }
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
    const results = [];
    for (const entry of searchIndex.values()) {
      if (searchMatch(entry, terms)) results.push(entry);
    }
    results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ready: searchIndexReady,
      indexed: searchIndex.size,
      results: results.slice(0, 50).map(e => ({
        id: e.id, threadId: e.threadId, title: e.title, cwd: e.cwd,
        mtimeMs: e.mtimeMs, archived: e.archived,
      })),
    }));
  } else if (req.url === "/events") {
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    // First browser after a quiet spell (slow timers): catch up before the first frames go out.
    if (!sseClients.size) {
      try { claudeDiscover(); } catch {}
      try { claudeTick(); } catch {}
      try { claudeChatsTick(); } catch {}
      try { tick(); } catch {}
    }
    sseClients.add(res);
    scheduleTick(POLL_MS); // that tick planned the 5 s idle poll: pull it in to the normal rate
    // initial state: session list + full event snapshots
    const threadJobStatus = threadJobStatuses(listCompanionJobs());
    res.write("data: " + JSON.stringify({ type: "sessions", sessions: [...sessions.values()].map(s => sessionSummary(s, threadJobStatus)) }) + "\n\n");
    res.write("data: " + JSON.stringify(claudeFrame) + "\n\n");
    res.write("data: " + JSON.stringify(claudeChatsFrame) + "\n\n");
    res.write("data: " + JSON.stringify(claudeUsageFrame) + "\n\n");
    res.write("data: " + JSON.stringify(codexLimitsFrame) + "\n\n");
    for (const s of sessions.values())
      res.write("data: " + JSON.stringify({ type: "snapshot", session: s.id, events: s.events }) + "\n\n");
    req.on("close", () => sseClients.delete(res));
    refreshCodexLimits(false);
  } else if (req.url === "/notifications") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    notificationClients.add(res);
    res.write(": connected\n\n");
    req.on("close", () => notificationClients.delete(res));
  } else if (req.url === "/jobs") {
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    const now = Date.now();
    const jobs = listCompanionJobs().map(j => {
      const alive = pidAlive(j.pid);
      return { ...j, pidAlive: alive, live: classifyJobLiveness(j, alive, now) };
    });
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ jobs }));
  } else if (req.url.startsWith("/job?")) {
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    const u = new URL(req.url, "http://local");
    const file = companionJobFile(u.searchParams.get("dir") || "", u.searchParams.get("id") || "");
    let body = null;
    try { body = file && fs.readFileSync(file, "utf8"); } catch {}
    res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
    res.end(body || JSON.stringify({ ok: false, error: "job not found" }));
  } else if (req.url === "/resume") {
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    readJsonBody(req, body => {
      if (!body || !body.threadId || !isUsableDir(body.cwd)) return jsonReply(res, 400, { ok: false, error: "threadId and existing cwd required" });
      const liveJob = listCompanionJobs(true).find(j => j.threadId === body.threadId && pidAlive(j.pid));
      if (liveJob) return jsonReply(res, 409, { ok: false, error: "job " + liveJob.id + " is still running on this thread - stop it first" });
      handleLaunch(res, body, buildCompanionTaskArgs({
        ...body,
        resumeThreadId: body.threadId,
        prompt: body.prompt || DEFAULT_RESUME_PROMPT,
      }));
    });
  } else if (req.url === "/cancel") {
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    readJsonBody(req, body => {
      if (!body || !body.jobId || !isUsableDir(body.cwd)) return jsonReply(res, 400, { ok: false, error: "jobId and existing cwd required" });
      runCompanion(["cancel", String(body.jobId), "--cwd", body.cwd, "--json"], {}, (err, parsed, errText) => {
        if (err) return jsonReply(res, 500, { ok: false, error: errText });
        jsonReply(res, 200, { ok: true, ...(parsed || {}) });
      });
    });
  } else if (req.url === "/notify") {
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
    // Posted by the local companion process (127.0.0.1, Content-Type only, no Origin), never a browser.
    if (!loopbackDirect(req) || req.headers.origin) return refuseUntrusted(req, res);
    readJsonBody(req, body => {
      if (body && body.jobId) {
        jobStateCache.clear(); // the job just changed its state file: read it fresh
        broadcast({ type: "job", jobId: body.jobId, status: body.status || "", title: String(body.title || "").slice(0, 120) }, notificationClients);
        kick();
        refreshCodexLimits(true); // the job used some of the plan
      }
      jsonReply(res, 200, { ok: true });
    });
  } else if (/^\/claude\/(?:agent|run|transcript)(?:\?|$)/.test(req.url)) {
    // Read only. Owner decision (2026-10-01): a Claude transcript needs no stricter gate than a Codex
    // job, so the gate is the one /jobs uses. The tunnel token is checked before any route runs.
    if (req.method !== "GET") { res.writeHead(405); return res.end("GET only"); }
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    const u = new URL(req.url, "http://local");
    const run = claudeRuns.get(u.searchParams.get("run") || "");
    const agentId = u.searchParams.get("agent") || "";
    const noStore = (code, obj) => { res.setHeader("Cache-Control", "no-store"); jsonReply(res, code, obj); };
    const offset = Math.max(0, parseInt(u.searchParams.get("offset"), 10) || 0);
    if (u.pathname === "/claude/transcript" && !run) {
      // A chat, or a plain subagent of it. Paths come from the server's own file list and a validated id.
      const sid = u.searchParams.get("chat") || "";
      const c = CLAUDE_CHAT_ID.test(sid) && claudeChatFiles.get(sid);
      if (!c) return noStore(404, { ok: false, error: "chat not found" });
      if (agentId && !CLAUDE_AGENT_ID.test(agentId)) return noStore(404, { ok: false, error: "agent not found" });
      const file = agentId ? path.join(path.dirname(c.file), sid, "subagents", "agent-" + agentId + ".jsonl") : c.file;
      const chat = claudeChats.get(sid);
      const a = chat && agentId ? chat.agents.get(agentId) : null;
      const r = chat ? (agentId ? a && a.reader : chat.reader) : null;
      let page;
      try { page = claudeTranscriptPage(file, offset); } catch { return noStore(404, { ok: false, error: "transcript not found" }); }
      const state = !r ? "" : agentId ? (a ? claudeAgentLiveState(chat, a, Date.now()) : "") : claudeChatState(chat, Date.now(), false);
      const pend = r && state === "running" ? [...r.pending.values()].pop() : null;
      return noStore(200, { ok: true, events: page.events, offset: page.offset, size: page.size,
        tool: pend ? pend.preview : "", contextTokens: (r && r.usage.context) || page.contextTokens, state,
        model: (r && r.model) || (a && a.metaModel) || "", effort: (r && r.effort) || "" });
    }
    if (!run) return noStore(404, { ok: false, error: "run not tracked" });
    if (u.pathname === "/claude/run") {
      return noStore(200, { ok: true, journal: path.join(run.dir, "journal.jsonl"), snapshot: run.snapshotFile,
        resume: "Resume Claude workflow " + run.id + " (Workflow tool, resumeFromRunId: \"" + run.id + "\")" });
    }
    // The path is built from the server-owned run.dir and a validated id, never from query text.
    const agent = CLAUDE_AGENT_ID.test(agentId) && run.agents.get(agentId);
    if (!agent) return noStore(404, { ok: false, error: "agent not tracked" });
    let page;
    try { page = claudeTranscriptPage(path.join(run.dir, "agent-" + agent.id + ".jsonl"), offset); }
    catch { return noStore(404, { ok: false, error: "transcript not found" }); }
    const state = claudeAgentState(run, agent);
    noStore(200, { ok: true, events: page.events, offset: page.offset, size: page.size,
      tool: state === "running" ? agent.toolPreview : "", contextTokens: agent.contextTokens || page.contextTokens, state,
      model: agent.model || (run.snapAgents.get(agent.id) || {}).model || "", effort: agent.effort });
  } else {
    res.writeHead(404); res.end("not found");
  }
});

// ---------------- CLI ----------------
const BASE = "http://127.0.0.1:" + PORT;

function controlHosts() {
  const hosts = new Set(["localhost:" + PORT, "127.0.0.1:" + PORT, "[::1]:" + PORT]);
  if (HOST !== "127.0.0.1") {
    hosts.add(HOST + ":" + PORT);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list || []) {
        if (iface.family === "IPv4") hosts.add(iface.address + ":" + PORT);
      }
    }
  }
  // Names a reverse proxy serves the viewer under: a bare name, name:port, or the full URL.
  for (const entry of String(process.env.CODEX_VIEWER_ALLOWED_HOSTS || "").split(",")) {
    const name = entry.trim().toLowerCase();
    if (!name) continue;
    try { hosts.add(name.includes("://") ? new URL(name).host : name); } catch {}
  }
  return hosts;
}

function refuseUntrusted(req, res) {
  res.writeHead(403, { "Content-Type": "text/plain" });
  res.end("untrusted origin. If a proxy serves the viewer at " + String(req.headers.host || "").slice(0, 200) +
    ", add that name to CODEX_VIEWER_ALLOWED_HOSTS and restart the viewer.");
}

function trustedControlOrigin(req) {
  const origin = req.headers.origin;
  if (FLAGS.tunnel && req.headers["cf-connecting-ip"]) {
    // Tunnel traffic is token-gated upstream and the tunnel hostname is not
    // known to the server (named tunnels), so same-host is the strictest rule.
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }
  // Direct traffic: Host must be a name this server is actually reachable at,
  // otherwise a DNS-rebound page becomes same-origin and bypasses Origin checks.
  const hosts = controlHosts();
  if (!hosts.has(req.headers.host)) return false;
  if (!origin) return true;
  try { return hosts.has(new URL(origin).host); } catch { return false; }
}

// A request straight from this PC: loopback socket, no proxy in between, a loopback Host
// (a DNS-rebound page in a local browser passes the socket check but not this).
// ponytail: a local proxy that adds no forwarding headers (nginx's default proxy_pass sets Host to the
// upstream and adds none) looks exactly like a local process; /notify only broadcasts a job id, that is the ceiling.
function loopbackDirect(req) {
  const h = req.headers || {};
  if (h["x-forwarded-for"] || h.forwarded || h["x-real-ip"] || h["cf-connecting-ip"]) return false;
  const ip = (req.socket && req.socket.remoteAddress) || "";
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return false;
  return h.host === "127.0.0.1:" + PORT || h.host === "localhost:" + PORT || h.host === "[::1]:" + PORT;
}

function serve() {
  if (!fs.existsSync(SESSIONS_DIR) && !fs.existsSync(CLAUDE_PROJECTS)) {
    console.error("[X] Neither Codex sessions (" + SESSIONS_DIR + ") nor Claude projects (" + CLAUDE_PROJECTS + ") found.");
    console.error("    Run any codex or claude command once, or set CODEX_HOME / CLAUDE_CONFIG_DIR.");
    process.exit(1);
  }
  let retries = 0;
  server.on("listening", () => {
    console.log("[OK] Codex Live Viewer -> http://localhost:" + PORT);
    if (HOST !== "127.0.0.1") {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
          if (iface.family === "IPv4" && !iface.internal) {
            console.log("[OK] LAN -> http://" + iface.address + ":" + PORT);
          }
        }
      }
    }
    if (FLAGS.tunnel) startTunnel(TOKEN);
    // Written only once the port is ours, so `kill` can find a viewer too hung to answer.
    try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch {}
    process.on("exit", () => { try { if (fs.readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch {} });
    console.log("[OK] Watching: " + SESSIONS_DIR);
    if (fs.existsSync(CLAUDE_PROJECTS)) console.log("[OK] Claude workflows: " + CLAUDE_PROJECTS);
    tick(); // reschedules itself (adaptive, see tickGap)
    watchSessions();
    // Own timers, so a Claude error never stalls Codex updates.
    // ponytail: poll only (1 s reads, 5 s discovery). A PostToolUse(Workflow) kick hook (scope graft 10) only if 5 s feels slow.
    // With no browser connected they run every 5th time (5 s reads, 25 s discovery); /events catches up on connect.
    claudeDiscover();
    claudeTick();
    let claudeIdleTurn = 0, claudeIdleScan = 0;
    setInterval(() => { if (sseClients.size || ++claudeIdleScan % 5 === 0) claudeDiscover(); }, CLAUDE_SCAN_MS);
    setInterval(() => {
      if (!sseClients.size && ++claudeIdleTurn % 5 !== 0) return;
      try { claudeTick(); } finally { claudeChatsTick(); } // one failing never skips the other
    }, POLL_MS);
    setInterval(refreshCodexLimits, 60 * 1000, false);
    setTimeout(buildSearchIndex, 50);
    setInterval(buildSearchIndex, 30000);
    // A proxy cuts a stream that stays silent (nginx: 60 s). A comment line keeps both streams open.
    setInterval(() => {
      for (const res of [...sseClients, ...notificationClients]) { try { res.write(": ping\n\n"); } catch {} }
    }, 25000);
  });
  server.on("error", err => {
    if (err.code !== "EADDRINUSE") throw err;
    if (retries === 0) {
      ping(isViewer => {
        if (!isViewer) {
          console.error("[X] Port " + PORT + " is used by something that is not the viewer.");
          console.error("    Set CODEX_VIEWER_PORT to a free port and retry.");
          process.exit(1);
        }
        console.log("[i] Port " + PORT + " busy - stopping the old viewer and taking over...");
        const req = http.request(BASE + "/shutdown", { method: "POST" }, r => {
          r.resume();
          retries++;
          setTimeout(() => server.listen(PORT, HOST), 400);
        });
        req.on("error", () => {
          retries++;
          setTimeout(() => server.listen(PORT, HOST), 400);
        });
        req.end();
      });
    } else if (retries < 5) {
      retries++;
      setTimeout(() => server.listen(PORT, HOST), 400);
    } else {
      console.error("[X] Could not take over port " + PORT + ".");
      process.exit(1);
    }
  });
  server.listen(PORT, HOST);
  process.on("exit", stopTunnel);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
}

function ping(cb) {
  const req = http.get(BASE + "/health", res => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", chunk => { if (body.length < 1000) body += chunk; });
    res.on("end", () => {
      let data;
      try { data = JSON.parse(body); } catch {}
      const ok = res.statusCode === 200 && data && data.application === APP_ID;
      cb(ok, ok ? data : null, ok ? null : "foreign");
    });
  });
  // The third argument says why the port is not a usable viewer even though it is
  // taken: "busy" (it did not answer in time: a viewer still loading, or a hung one)
  // or "foreign" (another program answers). Neither counts as "down", or a start
  // would launch into a port that is still taken.
  let busy = false;
  req.setTimeout(1000, () => { busy = true; req.destroy(); });
  req.on("error", err => cb(false, null, busy ? "busy" : err.code === "ECONNREFUSED" ? null : "foreign"));
}

function reportBlocked(why) {
  if (why === "foreign") {
    console.log("[X] Port " + PORT + " is used by another program, not the viewer.");
    console.log("    Pick a free port: set CODEX_VIEWER_PORT=" + (PORT + 1) + " (or any free port) where Claude and Codex run, then start the viewer again.");
  } else {
    console.log("[i] The viewer on " + BASE + " is not answering (still starting, or hung). Try again in a few seconds, or force it with kill.");
  }
  process.exitCode = 1;
}

// Force-quit the viewer that owns PORT, even a hung one: the pid comes from the file
// serve writes, and the process must still be a codex-live-viewer (a recycled pid
// belonging to anything else is never killed).
function doKill() {
  let pid;
  try { pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10); } catch {}
  if (!pid || !pidAlive(pid)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
    console.log("[i] No viewer process recorded for port " + PORT + ".");
    return;
  }
  const check = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "').CommandLine"]]
    : ["ps", ["-p", String(pid), "-o", "command="]];
  execFile(check[0], check[1], { windowsHide: true }, (_err, cmdline) => {
    if (!/codex-live-viewer/.test(String(cmdline || ""))) {
      try { fs.unlinkSync(PID_FILE); } catch {}
      console.log("[i] Process " + pid + " is not a viewer (the record was stale). Nothing killed.");
      return;
    }
    const done = () => {
      try { fs.unlinkSync(PID_FILE); } catch {}
      waitDown(() => ping((up, _i, blocked) => {
        if (up || blocked) { console.error("[X] Port " + PORT + " still answers after killing " + pid + "."); process.exitCode = 1; }
        else console.log("[OK] Viewer killed (pid " + pid + ").");
      }));
    };
    // /T also ends a tunnel child. On POSIX a detached viewer leads its own process group.
    if (process.platform === "win32") return execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, done);
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    done();
  });
}

// True only when both are x.y.z and a is lower; anything unreadable counts as not older.
function isOlderVersion(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(a || ""));
  const pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(b || ""));
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) < Number(pb[i]);
  return false;
}

function openBrowser() {
  if (FLAGS.noOpen) return;
  const url = "http://localhost:" + PORT;
  const opts = { detached: true, stdio: "ignore" };
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], opts).unref();
    else if (process.platform === "darwin") spawn("open", [url], opts).unref();
    else spawn("xdg-open", [url], opts).unref();
  } catch {}
}

// A running viewer from an older version is replaced, so a plugin update takes effect
// without a new session. force replaces any running viewer (restart).
function doStart(force) {
  ping((up, info, blocked) => {
    if (blocked) return reportBlocked(blocked);
    if (!up) return launch();
    const older = isOlderVersion(info.version, APP_VERSION);
    if (!force && !older) { console.log("[OK] already running -> " + BASE); openBrowser(); return; }
    console.log(older ? "[i] Replacing viewer " + info.version + " with " + APP_VERSION : "[i] Restarting viewer");
    doStop(() => waitDown(launch));
  });
}

// The old viewer answers /shutdown before its port closes; launching too early would
// see it still up, or fail to bind.
function waitDown(cb, tries = 0) {
  ping((up, _info, blocked) => {
    if ((!up && !blocked) || tries >= 25) return cb();
    setTimeout(() => waitDown(cb, tries + 1), 200);
  });
}

function launch() {
  spawn(process.execPath, [__filename, "serve", ...FLAGS.flagArgv], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  let tries = 0;
  let done = false; // pings overlap; only the first result may report
  const t = setInterval(() => ping(up2 => {
    if (done) return;
    if (up2) { done = true; clearInterval(t); console.log("[OK] Codex Live Viewer running -> " + BASE); openBrowser(); }
    else if (++tries > 25) { done = true; clearInterval(t); console.error("[X] The viewer did not come up on port " + PORT + " within 5s. To see why, run: node \"" + __filename + "\" serve"); process.exit(1); }
  }), 200);
}

function doStop(cb) {
  ping((up, _info, blocked) => {
    if (blocked) return reportBlocked(blocked);
    if (!up) { console.log("[i] Viewer was not running."); if (cb) cb(false); return; }
    let finished = false;
    const req = http.request(BASE + "/shutdown", { method: "POST" }, () => {
      if (finished) return;
      finished = true;
      console.log("[OK] Viewer stopped.");
      if (cb) cb(true);
    });
    req.on("error", () => {
      if (finished) return;
      finished = true;
      console.log("[i] Viewer was not running.");
      if (cb) cb(false);
    });
    req.end();
  });
}

// "start <action>" lets /codex:viewer pass its one argument through: an empty or
// unknown action is a plain start, never the foreground serve.
const START_ACTIONS = ["restart", "stop", "status", "kill"];
const cmd = FLAGS.cmd === "start" && START_ACTIONS.includes(FLAGS.args[0]) ? FLAGS.args[0] : FLAGS.cmd;
if (cmd === "serve") serve();
else if (cmd === "start") doStart(false);
else if (cmd === "kill") doKill();
else if (cmd === "stop") doStop(stopped => stopped && waitDown(() => ping(up => { if (up) { console.error("[X] Viewer still answers on " + BASE); process.exitCode = 1; } })));
else if (cmd === "restart") doStart(true);
else if (cmd === "status") ping((up, info, blocked) => blocked ? reportBlocked(blocked) : console.log(up ? "[OK] running " + (info.version || "?") + " -> " + BASE : "[i] not running"));
else {
  console.log("Usage: codex-live-viewer <start|stop|restart|status|kill|serve>");
  console.log("  start    run in background and open the browser; replaces an older running version");
  console.log("  stop     stop the background server");
  console.log("  restart  stop any running viewer, then start this one");
  console.log("  status   is it running?");
  console.log("  kill     force-quit the viewer, even a hung one");
  console.log("  serve    run in the foreground (default; what npm start does)");
  console.log("Flags:");
  console.log("  --host <addr>         bind address (default 127.0.0.1, or 0.0.0.0 when CODEX_VIEWER_ALLOWED_HOSTS is set; 0.0.0.0 = LAN)");
  console.log("  --tunnel              expose via Cloudflare quick tunnel (needs cloudflared)");
  console.log("  --tunnel-token <t>    named Cloudflare tunnel (custom domain); implies --tunnel");
  console.log("  --token <t>           fixed tunnel access token (default: auto-generated)");
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}
