'use strict';

const fs = require("fs");
const os = require("os");
const { sseClients, CLAUDE_STATE_FILE, CLAUDE_LIMITS_FILE, CODEX_LIMITS_MS, shared } = require("./runtime");
const { broadcast } = require("./events");
const { runCompanion } = require("./jobs");

let claudeUsageMtime = -1;

// Codex plan limits, read live through the companion (one short app-server, about 1 s) only
// while a browser is connected: on connect, every CODEX_LIMITS_MS, and when a job ends.
// A failed read keeps the last good numbers and adds the error.
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
    const last = shared.codexLimitsFrame.limits;
    const limits = parsed && parsed.ok ? parsed : {
      ...(last && last.windows ? last : { windows: [], resets: null, fetchedAtMs: 0 }),
      ok: false, allowed: null, error: String((parsed && parsed.detail) || stderr || "no reply").slice(0, 200),
    };
    shared.codexLimitsFrame = { type: "codexLimits", limits };
    broadcast(shared.codexLimitsFrame);
  });
}

// One chat or agent transcript line -> the facts the tree needs. Text is kept only where a fact
// needs it (a tool result is scanned for job ids, then dropped).
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
  if (JSON.stringify(usage) === JSON.stringify(shared.claudeUsageFrame.usage)) return;
  shared.claudeUsageFrame = { type: "claudeUsage", usage };
  broadcast(shared.claudeUsageFrame);
}


module.exports = { claudeUsageCheck, refreshCodexLimits };
