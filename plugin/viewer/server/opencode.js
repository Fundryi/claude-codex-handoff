'use strict';

const fs = require("fs");
const path = require("path");
const { OPENCODE_DB, CLAUDE_ROOT_MS, CLAUDE_MAX_ROOTS, shared } = require("./runtime");
const { broadcast } = require("./events");
const { STUCK_AFTER_MS } = require("./jobs");

// ---------------- OpenCode chats (read only) ----------------
// Only session_v2 and session_message are allowed. The same file contains credentials.
let opencodeSqlite; // undefined until first use, null when this Node has no SQLite support
let opencodeDb = null, opencodeIdentity = "";
let opencodeNextChange = 0, opencodeSig = "";

function opencodeClose() {
  try { if (opencodeDb) opencodeDb.close(); } catch {}
  opencodeDb = null;
  opencodeIdentity = "";
  shared.opencodeWatermark = "";
  shared.opencodeRows = [];
  opencodeNextChange = 0;
}

function opencodeConnection() {
  try {
    const st = fs.statSync(OPENCODE_DB);
    const identity = [st.dev, st.ino, st.birthtimeMs].join(":");
    if (opencodeDb && identity === opencodeIdentity) return opencodeDb;
    opencodeClose();
    if (opencodeSqlite === undefined) {
      try { opencodeSqlite = (process.getBuiltinModule ? process.getBuiltinModule("node:sqlite") : require("node:sqlite")) || null; }
      catch { opencodeSqlite = null; }
    }
    if (!opencodeSqlite || !opencodeSqlite.DatabaseSync) return null;
    // One handle, reused on every poll and pull. No PRAGMAs or checkpoints.
    opencodeDb = new opencodeSqlite.DatabaseSync(OPENCODE_DB, { readOnly: true });
    opencodeIdentity = identity;
    return opencodeDb;
  } catch { opencodeClose(); return null; } // missing file/schema never affects the other sources
}

function opencodeStep(content) {
  let parts;
  try { parts = JSON.parse(content || "[]"); } catch { return "working"; }
  if (!Array.isArray(parts)) return "working";
  const part = parts.findLast(p => p && p.type === "tool");
  if (!part) return "working";
  const name = typeof part.name === "string" ? part.name : typeof part.tool === "string" ? part.tool : "";
  if (!name) return "working";
  const input = part.state && part.state.input || {};
  const file = input.filePath || input.file_path || input.path;
  const summary = typeof input.command === "string" ? input.command
    : typeof file === "string" ? path.basename(file.replace(/\\/g, "/"))
    : typeof input.description === "string" ? input.description : "";
  return (name + (summary ? ": " + summary : "")).split(/\r?\n/, 1)[0].slice(0, 160);
}

function opencodeSessionView(row, now) {
  let model = {};
  try { model = JSON.parse(row.model ?? row.assistant_model ?? "{}") || {}; } catch {}
  const idle = row.newest_type === "idle" || (row.time_idle != null && row.time_idle >= row.time_updated);
  const outcome = row.idle_outcome || row.newest_outcome || "";
  const state = idle ? (outcome === "succeeded" ? "done" : outcome === "failed" ? "failed" : "stopped")
    : now - row.time_updated < STUCK_AFTER_MS ? "running" : "ended";
  return { id: "opencode:" + row.id, sessionId: row.id, parentId: row.parent_id ? "opencode:" + row.parent_id : null,
    title: row.title || "OpenCode session", cwd: row.directory || "", project: path.basename((row.directory || "").replace(/\\/g, "/")),
    model: [model.providerID, model.id].filter(x => typeof x === "string" && x).join("/"), effort: typeof model.variant === "string" ? model.variant : "",
    state, outcome, startedMs: row.time_created, updatedMs: row.time_updated,
    ...(state === "running" ? { step: opencodeStep(row.assistant_content) } : {}),
    usage: { total: (row.tokens_input || 0) + (row.tokens_output || 0) + (row.tokens_cache_read || 0) + (row.tokens_cache_write || 0), output: row.tokens_output || 0 }, cost: row.cost || 0 };
}

function opencodeChatsTick() {
  const now = Date.now();
  try {
    const db = opencodeConnection();
    if (db) {
      const marker = JSON.stringify(db.prepare("SELECT MAX(time_updated) AS updated, MAX(time_idle) AS idle, COUNT(id) AS count FROM session_v2").get());
      if (marker !== shared.opencodeWatermark || now >= opencodeNextChange) {
        if (marker !== shared.opencodeWatermark) {
          // Pull an old parent into the window when a child writes. UNION also bounds cycles.
          shared.opencodeRows = db.prepare(`WITH RECURSIVE recent(id, parent_id, updated) AS (
            SELECT id, parent_id, time_updated FROM session_v2 WHERE time_updated >= ?
            UNION SELECT s.id, s.parent_id, r.updated FROM session_v2 s JOIN recent r ON s.id = r.parent_id
          ), roots AS (
            SELECT s.id FROM session_v2 s JOIN recent r ON r.id = s.id
            WHERE s.parent_id IS NULL OR NOT EXISTS (SELECT p.id FROM session_v2 p WHERE p.id = s.parent_id)
            GROUP BY s.id ORDER BY MAX(r.updated) DESC LIMIT ?
          ), selected(id) AS (
            SELECT id FROM roots
            UNION SELECT s.id FROM session_v2 s WHERE s.time_updated >= ? AND (s.time_idle IS NULL OR s.time_idle < s.time_updated)
              AND COALESCE((SELECT m.type FROM session_message m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1), '') <> 'idle'
            UNION SELECT s.id FROM session_v2 s JOIN selected p ON s.parent_id = p.id
            UNION SELECT s.parent_id FROM session_v2 s JOIN selected c ON c.id = s.id WHERE s.parent_id IS NOT NULL
          ) SELECT s.id, s.parent_id, s.directory, s.title, s.model, s.cost, s.tokens_input, s.tokens_output,
            s.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated, s.time_idle, s.idle_outcome,
            (SELECT m.time_created FROM session_message m WHERE m.session_id = s.id AND m.type = 'user' ORDER BY m.seq DESC LIMIT 1) AS user_time,
            (SELECT json_object('providerID', json_extract(m.data, '$.model.providerID'),
              'id', json_extract(m.data, '$.model.id'), 'variant', json_extract(m.data, '$.model.variant'))
              FROM session_message m WHERE m.session_id = s.id AND m.type = 'assistant' AND s.model IS NULL ORDER BY m.seq DESC LIMIT 1) AS assistant_model,
            (SELECT m.type FROM session_message m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1) AS newest_type,
            (SELECT json_extract(m.data, '$.outcome') FROM session_message m WHERE m.session_id = s.id AND m.type = 'idle' ORDER BY m.seq DESC LIMIT 1) AS newest_outcome,
            CASE WHEN s.time_updated > ? AND (s.time_idle IS NULL OR s.time_idle < s.time_updated)
              AND COALESCE((SELECT m.type FROM session_message m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1), '') <> 'idle'
              THEN (SELECT json_extract(m.data, '$.content') FROM session_message m WHERE m.session_id = s.id AND m.type = 'assistant' ORDER BY m.seq DESC LIMIT 1)
              END AS assistant_content
            FROM session_v2 s JOIN selected k ON k.id = s.id`).all(now - CLAUDE_ROOT_MS, CLAUDE_MAX_ROOTS, now - STUCK_AFTER_MS, now - STUCK_AFTER_MS);
          shared.opencodeWatermark = marker;
        }
        const byId = new Map(shared.opencodeRows.map(r => [r.id, r]));
        const families = new Map();
        for (const row of shared.opencodeRows) {
          let root = row;
          const seen = new Set();
          while (byId.has(root.parent_id) && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.parent_id); }
          let family = families.get(root.id);
          if (!family) families.set(root.id, family = { rows: [], updated: 0, running: false });
          family.rows.push(row);
          family.updated = Math.max(family.updated, row.time_updated);
          if (opencodeSessionView(row, now).state === "running") family.running = true;
        }
        const recent = [...families.values()].filter(f => now - f.updated < CLAUDE_ROOT_MS)
          .sort((a, b) => b.updated - a.updated).slice(0, CLAUDE_MAX_ROOTS);
        // Same root count/age rules as Claude: the recent window plus every family with running work.
        const keep = new Set([...recent, ...[...families.values()].filter(f => f.running)]);
        const chats = [...keep].flatMap(f => f.rows.map(r => opencodeSessionView(r, now)));
        opencodeNextChange = Infinity;
        for (const r of shared.opencodeRows) for (const t of [r.time_updated + STUCK_AFTER_MS, r.time_updated + CLAUDE_ROOT_MS])
          if (t > now) opencodeNextChange = Math.min(opencodeNextChange, t);
        opencodePublish(chats);
      }
    } else opencodePublish([]);
  } catch { opencodeClose(); opencodePublish([]); } // do not log DB rows or errors from the credential file
}

function opencodePublish(chats) {
  const frame = { type: "opencodeChats", chats };
  const sig = JSON.stringify(frame);
  if (sig === opencodeSig) return;
  opencodeSig = sig;
  shared.opencodeChatsFrame = frame;
  broadcast(frame);
}

function opencodeTranscriptEvents(row) {
  // ponytail: OpenCode's internal schema changes often. Unknown message/content fields are skipped.
  if (!row || typeof row !== "object") return [];
  let data;
  try { data = typeof row.data === "string" ? JSON.parse(row.data) : row.data; } catch { return []; }
  if (!data || typeof data !== "object") return [];
  const stamp = Number(row.time_created) || Number(data.time && data.time.created) || 0;
  const ts = Number.isFinite(stamp) && Math.abs(stamp) <= 8640000000000000 ? new Date(stamp).toISOString() : "";
  const out = [];
  const text = v => typeof v === "string" ? v : "";
  const num = v => typeof v === "number" && Number.isFinite(v) ? v : 0;
  const error = data.error;
  if (row.type === "user") { if (text(data.text)) out.push({ kind: "user", ts, text: data.text }); }
  else if (row.type === "assistant") {
    for (const part of Array.isArray(data.content) ? data.content : []) {
      if (!part || typeof part !== "object") continue;
      if ((part.type === "text" || part.type === "reasoning") && text(part.text)) {
        out.push({ kind: part.type === "text" ? "agent" : "think", ts, text: part.text });
      } else if (part.type === "tool") {
        const name = text(part.name) || text(part.tool);
        if (!name) continue;
        const state = part.state && typeof part.state === "object" ? part.state : {};
        const input = state.input && typeof state.input === "object" ? state.input : {};
        const meta = state.metadata && typeof state.metadata === "object" ? state.metadata : {};
        const output = text(state.output) || (Array.isArray(state.content) ? state.content.filter(c => c && c.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "");
        const cmd = name === "shell" || name === "bash";
        out.push({ kind: cmd ? "cmd" : "tool", ts, text: cmd ? text(input.command) || name : name,
          detail: output || text(state.error), args: input, callId: text(part.id) || text(part.callID),
          done: ["completed", "error", "failed", "cancelled"].includes(state.status),
          ...(typeof meta.exit === "number" ? { exitCode: meta.exit } : {}),
          ...(name === "subagent" && text(meta.sessionID) ? { sessionId: meta.sessionID } : {}) });
      }
    }
    if (error) out.push({ kind: "err", ts, text: text(error) || text(error.data && error.data.message) || text(error.message) || text(error.name) || "OpenCode error" });
    const model = data.model && typeof data.model === "object" ? data.model : {};
    const tokens = data.tokens && typeof data.tokens === "object" ? data.tokens : {};
    const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
    const modelName = [text(model.providerID), text(model.id)].filter(Boolean).join("/");
    const total = num(tokens.input) + num(cache.read) + num(cache.write);
    out.push({ kind: "meta", ts, model: modelName, effort: text(model.variant), tokens: total, outputTokens: num(tokens.output), reasoningTokens: num(tokens.reasoning), cost: num(data.cost),
      text: [modelName, text(model.variant), total + " input tokens", num(tokens.output) + " output tokens", num(tokens.reasoning) + " reasoning tokens", "$" + num(data.cost)].filter(Boolean).join(" · ") });
  } else if (row.type === "idle") out.push({ kind: "done", ts, text: text(data.outcome) || "stopped", outcome: text(data.outcome) || "stopped", done: true });
  else if (row.type === "system" || row.type === "synthetic") {
    const body = text(data.text) || (Array.isArray(data.content) ? data.content.filter(p => p && p.type === "text").map(p => text(p.text)).join("\n") : "");
    if (body) out.push({ kind: "sys", ts, text: body, internal: true });
  }
  return out;
}

function opencodeTranscriptPage(id, offset) {
  const db = opencodeConnection();
  if (!db) return null;
  try {
    const row = db.prepare(`SELECT id, parent_id, directory, title, model, cost, tokens_input, tokens_output,
      tokens_cache_read, tokens_cache_write, time_created, time_updated, time_idle, idle_outcome,
      (SELECT json_object('providerID', json_extract(m.data, '$.model.providerID'),
        'id', json_extract(m.data, '$.model.id'), 'variant', json_extract(m.data, '$.model.variant'))
        FROM session_message m WHERE m.session_id = s.id AND m.type = 'assistant' AND s.model IS NULL ORDER BY m.seq DESC LIMIT 1) AS assistant_model,
      (SELECT m.type FROM session_message m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1) AS newest_type,
      (SELECT json_extract(m.data, '$.outcome') FROM session_message m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1) AS newest_outcome
      FROM session_v2 s WHERE s.id = ?`).get(id);
    if (!row) return null;
    // Re-read the last seq: OpenCode updates streamed assistant rows in place.
    const first = offset == null;
    const rows = first
      ? db.prepare("SELECT type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 200").all(id).reverse()
      : db.prepare("SELECT type, seq, time_created, data FROM session_message WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT 101").all(id, offset);
    const more = !first && rows.length > 100;
    if (more) rows.pop();
    const events = rows.flatMap(r => opencodeTranscriptEvents(r).map(e => ({ ...e, seq: r.seq })));
    const chat = opencodeSessionView(row, Date.now());
    const last = rows.length ? rows[rows.length - 1].seq : offset || 0;
    const context = db.prepare(`SELECT COALESCE(json_extract(data, '$.tokens.input'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS contextTokens
      FROM session_message WHERE session_id = ? AND type = 'assistant'
      AND json_type(data, '$.tokens') = 'object' ORDER BY seq DESC LIMIT 1`).get(id);
    return { events, offset: last + (more ? 1 : 0), more, replaceFrom: rows.length ? rows[0].seq : null,
      contextTokens: context?.contextTokens || 0, state: chat.state, model: chat.model, effort: chat.effort };
  } catch { opencodeClose(); return null; }
}


module.exports = { opencodeChatsTick, opencodeTranscriptPage };
