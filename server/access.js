'use strict';

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const { PORT, FLAGS, HOST, TOKEN_FILE, LEGACY_TOKEN_FILE } = require("./runtime");

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
// ---------------- process control (kill stuck sessions) ----------------
// Rollout files carry no PID, so we list codex-related processes and let the
// user pick; the UI sorts them by closeness to the session start time.
function codexProcs(cb) {
  if (process.platform !== "win32") return cb([]); // kill feature is Windows-only for now
  const script =
    "$me=$PID;" +
    "Get-CimInstance Win32_Process | Where-Object {" +
    " ($_.ProcessId -ne $me) -and" +
    " ([string]$_.CommandLine -notmatch '(codex-live-viewer|ai-live-viewer)') -and" +
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
// upstream and adds none) looks exactly like a local process; /notify sends bounded notification text only.
function loopbackDirect(req) {
  const h = req.headers || {};
  if (h["x-forwarded-for"] || h.forwarded || h["x-real-ip"] || h["cf-connecting-ip"]) return false;
  const ip = (req.socket && req.socket.remoteAddress) || "";
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") return false;
  return h.host === "127.0.0.1:" + PORT || h.host === "localhost:" + PORT || h.host === "[::1]:" + PORT;
}


module.exports = { TOKEN, tunnelAuthDecision, codexProcs, refuseUntrusted, trustedControlOrigin, loopbackDirect, startTunnel, stopTunnel, loadToken, saveToken, parseTunnelUrl, controlHosts };
