'use strict';

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { ROOT, APP_ID, APP_VERSION, FLAGS, POLL_MS, sessions, sseClients, notificationClients, searchIndex, pinnedFiles, MAX_PINNED, jobStateCache, CLAUDE_AGENT_ID, claudeRuns, CLAUDE_CHAT_ID, claudeChatFiles, claudeChats, shared } = require("./runtime");
const { TOKEN, tunnelAuthDecision, codexProcs, refuseUntrusted, trustedControlOrigin, loopbackDirect } = require("./access");
const { broadcast } = require("./events");
const { searchMatch, ingest, sessionSummary, tick, threadJobStatuses, scheduleTick, kick } = require("./sessions");
const { classifyJobLiveness, pidAlive, listCompanionJobs, companionJobFile, DEFAULT_RESUME_PROMPT, buildCompanionTaskArgs, runCompanion, isUsableDir } = require("./jobs");
const { claudeAgentState, claudeTick, claudeTranscriptPage } = require("./claude-workflows");
const { claudeDiscover } = require("./discovery");
const { claudeAgentLiveState, claudeChatState, claudeChatsTick } = require("./claude-chats");
const { opencodeChatsTick, opencodeTranscriptPage } = require("./opencode");
const { refreshCodexLimits } = require("./usage");

function readJsonBody(req, cb) {
  let body = "";
  req.setEncoding("utf8"); // decodes across chunks, so a character split between two chunks survives
  req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => { let j = null; try { j = JSON.parse(body); } catch {} cb(j); });
}

function jsonReply(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function handleLaunch(res, body, args) {
  const env = body.sandbox ? { CODEX_PLUGIN_SANDBOX: String(body.sandbox) } : {};
  runCompanion(args, env, (err, parsed, errText) => {
    if (err || !parsed || !parsed.jobId) return jsonReply(res, 500, { ok: false, error: errText || "companion did not return a job id" });
    jsonReply(res, 200, { ok: true, jobId: parsed.jobId, logFile: parsed.logFile || "" });
  });
}

// ---------------- HTTP ----------------
const UI_ASSET_FILES = new Map([
  ["/", ["ui/index.html", "text/html; charset=utf-8"]],
  ["/logo.svg", ["assets/logo.svg", "image/svg+xml"]],
  ["/ui/theme.css", ["ui/theme.css", "text/css; charset=utf-8"]],
  ["/ui/layout.css", ["ui/layout.css", "text/css; charset=utf-8"]],
  ["/ui/marks.css", ["ui/marks.css", "text/css; charset=utf-8"]],
  ["/ui/surfaces.css", ["ui/surfaces.css", "text/css; charset=utf-8"]],
  ["/ui/feed.css", ["ui/feed.css", "text/css; charset=utf-8"]],
  ["/ui/responsive.css", ["ui/responsive.css", "text/css; charset=utf-8"]],
  ["/ui/js/state.js", ["ui/js/state.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/markdown.js", ["ui/js/markdown.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/feed-model.js", ["ui/js/feed-model.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/rows.js", ["ui/js/rows.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/workflow-model.js", ["ui/js/workflow-model.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/tree-model.js", ["ui/js/tree-model.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/navigation.js", ["ui/js/navigation.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/tree.js", ["ui/js/tree.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/header.js", ["ui/js/header.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/marks.js", ["ui/js/marks.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/plans.js", ["ui/js/plans.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/node-header.js", ["ui/js/node-header.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/feed.js", ["ui/js/feed.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/overview.js", ["ui/js/overview.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/pages.js", ["ui/js/pages.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/workflows.js", ["ui/js/workflows.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/jobs.js", ["ui/js/jobs.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/controls.js", ["ui/js/controls.js", "text/javascript; charset=utf-8"]],
  ["/ui/js/boot.js", ["ui/js/boot.js", "text/javascript; charset=utf-8"]],
]);

function loadUiAssets() {
  const assets = new Map();
  for (const [url, [file, contentType]] of UI_ASSET_FILES) {
    let body;
    try {
      body = fs.readFileSync(path.join(ROOT, file));
    } catch (err) {
      throw new Error("Cannot read required UI asset " + file + ": " + err.message);
    }
    assets.set(url, { body, contentType, cacheControl: url === "/logo.svg" ? "public, max-age=3600" : "no-store" });
  }
  return assets;
}

function loadUiAssetsOrExit() {
  try { return loadUiAssets(); } catch (err) {
    console.error("[X] " + err.message);
    console.error("    The install is incomplete. Reinstall or update the plugin.");
    process.exit(1);
  }
}

// Loaded only by serve/start: status/stop/kill do not need an installed UI.
let uiAssets = null;

function handleRequest(req, res) {
  const auth = tunnelAuthDecision(req.headers, req.url, TOKEN, FLAGS.tunnel);
  if (!auth.allow) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("token required"); }
  if (auth.setCookie) res.setHeader("Set-Cookie", "clv_token=" + TOKEN + "; HttpOnly; Path=/; SameSite=Lax; Secure");
  if (auth.redirect) { res.writeHead(302, { Location: auth.redirect }); return res.end(); }
  const asset = uiAssets.get(req.url);
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      application: APP_ID,
      version: APP_VERSION,
      notificationListener: notificationClients.size > 0,
    }));
  } else if (asset) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end("GET or HEAD only");
    }
    res.writeHead(200, {
      "Content-Type": asset.contentType,
      "Cache-Control": asset.cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Content-Length": asset.body.length,
    });
    res.end(req.method === "HEAD" ? undefined : asset.body);
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
      ready: shared.searchIndexReady,
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
      opencodeChatsTick();
      try { tick(); } catch {}
    }
    sseClients.add(res);
    scheduleTick(POLL_MS); // that tick planned the 5 s idle poll: pull it in to the normal rate
    // initial state: session list + full event snapshots
    const threadJobStatus = threadJobStatuses(listCompanionJobs());
    res.write("data: " + JSON.stringify({ type: "sessions", sessions: [...sessions.values()].map(s => sessionSummary(s, threadJobStatus)) }) + "\n\n");
    res.write("data: " + JSON.stringify(shared.claudeFrame) + "\n\n");
    res.write("data: " + JSON.stringify(shared.claudeChatsFrame) + "\n\n");
    res.write("data: " + JSON.stringify(shared.opencodeChatsFrame) + "\n\n");
    res.write("data: " + JSON.stringify(shared.claudeUsageFrame) + "\n\n");
    res.write("data: " + JSON.stringify(shared.codexLimitsFrame) + "\n\n");
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
      const threadJobs = listCompanionJobs(true).filter(j => j.threadId === body.threadId);
      const engine = threadJobs[0]?.engine || body.engine || "codex";
      if (body.engine && body.engine !== engine) return jsonReply(res, 400, { ok: false, error: "engine does not match this job's thread" });
      const liveJob = threadJobs.find(j => (j.engine || "codex") === engine && pidAlive(j.pid));
      if (liveJob) return jsonReply(res, 409, { ok: false, error: "job " + liveJob.id + " is still running on this thread - stop it first" });
      handleLaunch(res, body, buildCompanionTaskArgs({
        ...body,
        engine,
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
      } else if (body && ((body.source === "codex" && body.event === "PermissionRequest") || body.source === "opencode")) {
        if (body.source === "codex") kick(true);
        else { shared.opencodeWatermark = ""; opencodeChatsTick(); }
      }
      jsonReply(res, 200, { ok: true });
    });
  } else if (/^\/opencode\/transcript(?:\?|$)/.test(req.url)) {
    if (req.method !== "GET") { res.writeHead(405); return res.end("GET only"); }
    if (!trustedControlOrigin(req)) return refuseUntrusted(req, res);
    const u = new URL(req.url, "http://local");
    const offset = u.searchParams.has("offset") ? Number(u.searchParams.get("offset")) : null;
    const page = (offset == null || (Number.isSafeInteger(offset) && offset >= 0)) && opencodeTranscriptPage(u.searchParams.get("session") || "", offset);
    res.setHeader("Cache-Control", "no-store");
    jsonReply(res, page ? 200 : 404, page ? { ok: true, ...page } : { ok: false, error: "transcript not found" });
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
}

function createViewerServer() {
  uiAssets = loadUiAssetsOrExit();
  return http.createServer(handleRequest);
}


module.exports = { loadUiAssetsOrExit, createViewerServer, UI_ASSET_FILES, loadUiAssets };
