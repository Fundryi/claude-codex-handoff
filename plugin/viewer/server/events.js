'use strict';

const path = require("path");
const { sessions, sseClients, notificationClients, shared } = require("./runtime");
const { listCompanionJobs } = require("./jobs");
const { notifyDesktop } = require("./os-notify");

function broadcast(obj, clients = sseClients) {
  // One desktop request at the source, even with no browser or several listeners.
  if (clients === notificationClients && process.env.CODEX_VIEWER_NOTIFICATIONS !== "0"
    && (obj.type === "complete" || (obj.type === "job" && ["completed", "failed", "cancelled"].includes(obj.status)))) {
    try {
      notifyDesktop({
        summary: obj.summary || (obj.status === "failed" ? "AI task failed" : obj.status === "cancelled" ? "AI task stopped" : "AI task complete"),
        title: obj.title || "Codex task",
      });
    } catch {} // An optional desktop helper must never interrupt SSE delivery.
  }
  if (!clients.size) return; // nobody listens: skip the stringify
  const line = "data: " + JSON.stringify(obj) + "\n\n";
  for (const res of clients) { try { res.write(line); } catch {} }
}

function plainRunNotification(body, knownSession) {
  if (process.env.CODEX_VIEWER_NOTIFICATIONS === "0" || typeof body.sessionId !== "string" || !body.sessionId) return null;
  // Read fresh state: the worker can have recorded its session since the last poll.
  if (listCompanionJobs(true, true).some(job => job.threadId === body.sessionId)) return null;
  const codex = body.source === "codex";
  const label = codex ? "Codex" : "OpenCode";
  const approval = codex ? body.event === "PermissionRequest" : body.event === "permission.asked";
  const question = !codex && body.event === "question.asked";
  const end = codex ? body.event === "done" || body.event === "err"
    : ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(body.event);
  if (!approval && !question && !end) return null;
  let start = 0, cwd = codex ? body.cwd : body.directory, failed = body.event === "err" || body.event === "session.execution.failed";
  if (codex) {
    const session = knownSession || [...sessions.values()].find(s => s.meta.threadId === body.sessionId);
    if (session) {
      cwd = session.meta.cwd || cwd;
      const user = session.events.findLast(e => e.kind === "user" && !e.internal);
      start = user ? Date.parse(user.ts) : 0;
      failed = failed || session.events.at(-1)?.kind === "err";
    }
  } else {
    const row = shared.opencodeRows.find(r => r.id === body.sessionId);
    if (row) { start = Number(row.user_time) || 0; cwd = row.directory || cwd; }
  }
  if (end && !failed && process.env.CODEX_VIEWER_NOTIFY_QUIET === "1"
    && !(start > 0 && Date.now() - start >= 60000)) return null;
  const project = typeof cwd === "string" ? path.basename(cwd.replace(/\\/g, "/")).slice(0, 120) : "";
  const summary = `${label} ${question ? "asks you something" : approval ? "needs approval" : failed ? "turn failed" : body.event === "session.execution.interrupted" ? "turn stopped" : "turn complete"}`;
  const tool = approval && typeof body.tool === "string" ? body.tool.slice(0, 160) : "";
  return { type: "complete", source: body.source, session: body.sessionId, summary,
    title: summary + (tool ? ": " + tool : "") + (project ? " in " + project : "") };
}


module.exports = { broadcast, plainRunNotification };
