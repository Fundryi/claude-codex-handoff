#!/usr/bin/env node
/*
 * ai-live-viewer.js
 * Read-only live dashboard for ALL Codex sessions on this machine,
 * including headless handoffs spawned by the Claude Code codex plugin.
 *
 * How: Codex appends every event of every session to
 *   %USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-*.jsonl
 * as it runs. This server tails that folder and streams updates
 * to a browser page via Server-Sent Events. Zero npm dependencies.
 *
 * Run:  node ai-live-viewer.js        (then open http://localhost:8377)
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const { execFile, spawn } = require("child_process");
const { APP_ID, APP_VERSION, PORT, PID_FILE, FLAGS, HOST, CLAUDE_PROJECTS, SESSIONS_DIR, POLL_MS, sseClients, notificationClients, CLAUDE_SCAN_MS } = require("./server/runtime");
const { TOKEN, startTunnel, stopTunnel } = require("./server/access");
const { buildSearchIndex, tick, watchSessions } = require("./server/sessions");
const { pidAlive } = require("./server/jobs");
const { claudeTick } = require("./server/claude-workflows");
const { claudeDiscover } = require("./server/discovery");
const { claudeChatsTick } = require("./server/claude-chats");
const { opencodeChatsTick } = require("./server/opencode");
const { refreshCodexLimits } = require("./server/usage");
const { loadUiAssetsOrExit, createViewerServer } = require("./server/http");

// ---------------- CLI ----------------
const BASE = "http://127.0.0.1:" + PORT;

function serve() {
  // Fail before listen or any attempt to take over a port.
  const server = createViewerServer();
  if (!fs.existsSync(SESSIONS_DIR) && !fs.existsSync(CLAUDE_PROJECTS)) {
    console.error("[X] Neither Codex sessions (" + SESSIONS_DIR + ") nor Claude projects (" + CLAUDE_PROJECTS + ") found.");
    console.error("    Run any codex or claude command once, or set CODEX_HOME / CLAUDE_CONFIG_DIR.");
    process.exit(1);
  }
  let retries = 0;
  server.on("listening", () => {
    console.log("[OK] AI Live Viewer -> http://localhost:" + PORT);
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
    opencodeChatsTick();
    let claudeIdleTurn = 0, claudeIdleScan = 0;
    setInterval(() => { if (sseClients.size || ++claudeIdleScan % 5 === 0) claudeDiscover(); }, CLAUDE_SCAN_MS);
    setInterval(() => {
      if (!sseClients.size && ++claudeIdleTurn % 5 !== 0) return;
      try { claudeTick(); } finally { try { claudeChatsTick(); } finally { opencodeChatsTick(); } }
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
// serve writes, and the process must still be the viewer, by either file name (a recycled pid
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
    if (!/(?:codex-live-viewer|ai-live-viewer)/.test(String(cmdline || ""))) {
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
  loadUiAssetsOrExit();
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
    if (up2) { done = true; clearInterval(t); console.log("[OK] AI Live Viewer running -> " + BASE); openBrowser(); }
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
  console.log("Usage: ai-live-viewer <start|stop|restart|status|kill|serve>");
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
