'use strict';

const fs = require("fs");
const path = require("path");
const { SESSIONS_DIR, ARCHIVED_DIR, POLL_MS, LIVE_WINDOW_MS, MAX_SESSIONS, MAX_EVENTS_KEPT, sessions, sseClients, notificationClients, searchIndex, pinnedFiles, rolloutStats, resumedFiles, IDLE_POLL_MS, shared } = require("./runtime");
const { broadcast } = require("./events");
const { classifyJobLiveness, pidAlive, listCompanionJobs } = require("./jobs");
const { registerMedia } = require('./media');

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
  const location = arguments[1];
  const event = (() => {

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
        const command = item.command;
        const flag = Array.isArray(command) ? command.findIndex(s => /^(?:-Command|-c|\/c)$/i.test(s)) : -1;
        const text = flag >= 0 ? command.slice(flag + 1).join(' ') : typeof command === 'string' ? command
          : (item.parsed_cmd || []).map(c => c && c.cmd).filter(Boolean).join(" && ") || (Array.isArray(command) ? command.join(' ') : '');
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
      // Keep in step with INJECTED_BLOCK in ui/js/feed-model.js (tests/ui-feed.test.js checks).
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
  })();
  // Keep simplify self-contained: regex-extracted test callers have no module scope.
  const cap = (key, raw, limit) => { raw = String(raw || ''); event[key] = raw.slice(0, limit); if (raw.length > limit) event.truncated = { shown: event[key].length, total: raw.length }; };
  const images = (parts, base) => {
    if (!location || typeof registerMedia !== 'function' || !Array.isArray(parts)) return [];
    return parts.flatMap((part, i) => {
      let mime, image;
      if (part?.type === 'image' && part.source?.type === 'base64') { mime = part.source.media_type; image = true; }
      else if (part?.type === 'input_image' && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(part.image_url || '')) { mime = part.image_url.slice(5, part.image_url.indexOf(';')); image = true; }
      if (!image) return [];
      const ref = registerMedia({ ...location, part: [...base, i], mime });
      return ref ? [{ ref, mime, alt: 'Image' }] : [];
    });
  };
  const media = t === 'response_item' && p.type === 'message' ? images(p.content, ['payload', 'content']) : [];
  if (!event) return media.length ? { kind: p.role === 'user' ? 'user' : 'out', ts, text: '', media } : null;
  if (media.length) event.media = media;
  const tool = (name, input) => {
    input = input && typeof input === 'object' ? input : { input: String(input || '') };
    const raw = JSON.stringify(input);
    let bounded = input;
    if (raw.length > 20000) {
      const shrink = (value, budget, depth) => {
        if (typeof value === 'string') {
          let lo = 0, hi = value.length;
          while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (JSON.stringify(value.slice(0, mid)).length <= budget) lo = mid; else hi = mid - 1; }
          return value.slice(0, lo);
        }
        if (!value || typeof value !== 'object') return value;
        const array = Array.isArray(value), result = array ? [] : {};
        if (depth > 64) return result;
        let used = 2, count = 0;
        for (const key of Object.keys(value)) {
          const overhead = (count ? 1 : 0) + (array ? 0 : JSON.stringify(key).length + 1);
          if (budget - used - overhead < 2) break;
          const child = shrink(value[key], budget - used - overhead, depth + 1);
          const length = JSON.stringify(child).length;
          if (used + overhead + length > budget) break;
          if (array) result.push(child); else Object.defineProperty(result, key, { value: child, enumerable: true });
          used += overhead + length; count++;
        }
        return result;
      };
      bounded = shrink(input, 20000, 0);
      event.truncated = { shown: JSON.stringify(bounded).length, total: raw.length };
    }
    const target = /grep|glob/i.test(name) ? input.pattern : /agent|task/i.test(name) ? input.name || input.subagent_type || input.description
      : input.command || input.file_path || input.filePath || input.path || input.url || input.query || input.description;
    event.tool = { name, target: String(target || '').slice(0, 20000), input: bounded };
    if (event.kind === 'tool' && !event.truncated) {
      const text = name + ' ' + raw;
      if (text.length > event.text.length) event.truncated = { shown: event.text.length, total: text.length };
    }
  };
  const patchFields = changes => {
    const diffs = [], files = [];
    for (const [file, change] of Object.entries(changes || {})) {
      const op = change.type === 'add' ? 'add' : change.type === 'delete' ? 'delete' : 'update';
      let diff = String(change.unified_diff || '');
      if (diff && !/^--- /m.test(diff)) diff = '--- a/' + file + '\n+++ b/' + file + '\n' + diff;
      if (!diff && typeof change.content === 'string') {
        const lines = change.content.replace(/\r\n/g, '\n').split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        const n = lines.length, range = n === 1 ? '1' : '1,' + n;
        diff = '--- a/' + file + '\n+++ b/' + file + '\n@@ -' + (op === 'delete' ? range : '0,0') + ' +' + (op === 'delete' ? '0,0' : range) + ' @@\n' + lines.map(l => (op === 'delete' ? '-' : '+') + l).join('\n');
      }
      const lines = diff.split('\n');
      files.push({ path: file, op, added: lines.filter(l => /^\+(?!\+\+)/.test(l)).length, removed: lines.filter(l => /^-(?!--)/.test(l)).length });
      if (diff) diffs.push(diff.replace(/\n$/, ''));
    }
    const raw = diffs.join('\n');
    event.diff = raw.split('\n').slice(0, 2000).join('\n');
    event.files = files;
    if (event.diff.length < raw.length) event.truncated = { shown: event.diff.length, total: raw.length };
    else if (event.detail) {
      const detail = Object.keys(changes || {}).map(f => (changes[f].type || 'update') + ' ' + f + '\n' + (changes[f].unified_diff || changes[f].content || '')).join('\n\n');
      if (detail.length > event.detail.length) event.truncated = { shown: event.detail.length, total: detail.length };
    }
  };
  if (t === 'event_msg' && p.type === 'item_completed') {
    const item = p.item || {};
    if (item.type === 'CommandExecution') {
      if (typeof item.exit_code === 'number' && Number.isFinite(item.exit_code)) event.exit = item.exit_code;
      if (item.id) event.callId = item.id;
      const status = item.exit_code == null ? '' : '\n\nexit ' + item.exit_code;
      cap('detail', event.text + status + '\n' + String(item.aggregated_output || ''), 4000);
    } else if (item.type === 'FileChange') { if (item.id) event.callId = item.id; patchFields(item.changes); }
    else if (item.type === 'McpToolCall') tool(item.server + '.' + item.tool, item.arguments || {});
    else if (item.type === 'Extension' && item.kind === 'web.search') tool('web.search', { query: item.query || '' });
  }
  if (t === 'response_item') {
    if (p.type === 'function_call' || p.type === 'local_shell_call') {
      if (p.call_id || p.id) event.callId = p.call_id || p.id;
      let input = p.arguments || p.action || {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
      tool(p.name || 'local_shell', input);
      if (event.kind === 'patch') {
        const raw = String(input.patch || input.input || '');
        if (/^(?:diff --git |--- |@@ -)/m.test(raw)) event.diff = raw.split('\n').slice(0, 2000).join('\n');
        event.files = [...raw.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)].map(m => {
          const start = m.index + m[0].length;
          const next = raw.indexOf('\n*** ', start);
          const lines = raw.slice(start, next < 0 ? raw.length : next).split('\n');
          return { path: m[2], op: m[1].toLowerCase(), added: lines.filter(l => l.startsWith('+')).length, removed: lines.filter(l => l.startsWith('-')).length };
        });
        if (event.diff && event.diff.length < raw.length) event.truncated = { shown: event.diff.length, total: raw.length };
        else if (raw.length > 4000 && !event.truncated) event.truncated = { shown: event.detail.length, total: raw.length };
      }
    } else if (p.type === 'function_call_output') {
      if (p.call_id) event.resultOf = p.call_id;
      let output = p.output;
      try { const j = JSON.parse(output); output = j.output ?? output; if (typeof j.exit_code === 'number' && Number.isFinite(j.exit_code)) event.exit = j.exit_code; } catch {}
      cap('text', output, 1200);
    } else if (p.type === 'reasoning') cap('text', (p.summary || []).map(s => s.text || '').join(' '), 500);
    else if (p.type === 'message' && (event.internal || p.role === 'system')) {
      let type = p.role === 'developer' ? 'developer' : 'other', title = p.role === 'developer' ? 'Developer' : 'Injected content';
      const text = event.text;
      if (/^\s*# AGENTS\.md instructions/.test(text)) { type = 'agents-md'; title = 'AGENTS.md'; }
      else if (/^\s*# CLAUDE\.md/.test(text)) { type = 'claude-md'; title = 'CLAUDE.md'; }
      else if (/^\s*<(?:skills?|skills_instructions)[\s>]/.test(text)) { type = 'skill'; title = 'Skill'; }
      else if (/^\s*<task-notification[\s>]/.test(text)) { type = 'task-notification'; title = (/<summary>([\s\S]*?)<\/summary>/.exec(text) || [])[1] || 'Task notification'; }
      else if (/^\s*<system-reminder[\s>]/.test(text)) { type = 'system-reminder'; title = 'System reminder'; }
      else if (/^\s*<(?:context[\w-]*|codex-jobs|codex_internal_context)[\s>]/.test(text)) { type = 'context'; title = 'Context'; }
      event.block = { type, title: title.slice(0, 300), chars: text.length };
    }
  }
  if (event.diff) event.format = 'diff';
  return event;
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
  shared.searchIndexReady = true;
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
  let lineOffset = s.offset - n - s.partial.length;
  const cut = data.lastIndexOf(10) + 1;
  s.partial = Buffer.from(data.subarray(cut)); // copy so the 5 MiB read buffer is not retained
  const lines = data.toString("utf8", 0, cut).split("\n");
  const fresh = [];
  let newest = 0;
  for (const line of lines) {
    const location = { file, offset: lineOffset };
    lineOffset += Buffer.byteLength(line, 'utf8') + 1;
    if (!line.trim()) continue;
    // lastGrow is the newest record time, not the file mtime (Codex 0.146+ pins that at
    // creation on Windows) and not Date.now() (a backfill of an old file is not live growth).
    const stamp = Date.parse((line.match(/^\{"timestamp":"([^"]+)"/) || [])[1]);
    if (stamp > newest) newest = stamp;
    const ev = simplify(line, location);
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
    lastText: last ? (last.kind === "patch" ? String(last.text).split(/,\s*|\r?\n/).filter(Boolean)
      .map(file => path.basename(file.replace(/\\/g, "/"))).join(", ") : String(last.text)).slice(0, 120) : "",
    lastEvent: last ? (last.kind + ": " + String(last.text).slice(0, 90)) : "",
    eventCount: s.events.length,
  };
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
    scheduleTick(sseClients.size || notificationClients.size ? Math.max(POLL_MS, tickGap(codexActive + shared.claudeActive)) : IDLE_POLL_MS);
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
let tickTimer = null, tickDue = 0, lastTickAt = 0, sessionsSig = "", codexActive = 0;
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
function kick(force) {
  if (!sseClients.size && !notificationClients.size && force !== true) return;
  scheduleTick(lastTickAt + tickGap(codexActive + shared.claudeActive) - Date.now());
}
function watchSessions() {
  try { fs.watch(SESSIONS_DIR, { recursive: true }, kick); }
  catch { /* recursive watch unsupported on some platforms - poll covers it */ }
  try { fs.watch(ARCHIVED_DIR, { recursive: true }, kick); }
  catch { /* dir may not exist yet - the 1s poll covers it */ }
}


module.exports = { searchMatch, ingest, sessionSummary, tick, threadJobStatuses, scheduleTick, kick, collectRolloutFiles, buildSearchIndex, watchSessions, listRolloutFiles, simplify, promptTitle, indexEntry, tickGap };
