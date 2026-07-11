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
const { execFile } = require("child_process");

const PORT = process.env.CODEX_VIEWER_PORT ? parseInt(process.env.CODEX_VIEWER_PORT, 10) : 8377;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const POLL_MS = 1000;          // how often we check files for growth
const LIVE_WINDOW_MS = 20000;  // file grew within this window => LIVE
const STALE_AFTER_MS = 10 * 60 * 1000; // quiet this long without task_complete => STALE
const MAX_SESSIONS = 40;       // most recent sessions to track
const MAX_EVENTS_KEPT = 500;   // per-session event ring buffer

// ---------------- session state ----------------
// key: absolute file path
// val: { id, file, offset, partial, meta, events[], lastGrow, size }
const sessions = new Map();
const sseClients = new Set();

function listRolloutFiles() {
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
  out.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
  });
  return out.slice(0, MAX_SESSIONS);
}

// Turn one raw rollout line into a display event (schema-tolerant).
function simplify(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const ts = o.timestamp || o.ts || null;
  const t = o.type || "";
  const p = o.payload || o;

  // session metadata
  if (t === "session_meta" || p.cwd && p.id && !p.type) {
    return { kind: "meta", ts, cwd: p.cwd || "", id: p.id || "", model: p.model || (p.turn_context && p.turn_context.model) || "", instructions: undefined };
  }
  // event_msg wrapper (agent messages, token counts, etc.)
  if (t === "event_msg") {
    const et = p.type || "";
    if (et === "user_message")  return { kind: "user",  ts, text: p.message || "" };
    if (et === "agent_message") return { kind: "agent", ts, text: p.message || "" };
    if (et === "agent_reasoning" || et === "agent_reasoning_delta") return null; // too chatty
    if (et === "token_count") return null;
    if (et === "task_started") return { kind: "sys", ts, text: "task started" };
    if (et === "task_complete") return { kind: "done", ts, text: "task complete" };
    if (et === "turn_aborted") return { kind: "err", ts, text: "turn aborted" };
    return null;
  }
  // response_item wrapper (model I/O, tool calls)
  if (t === "response_item") {
    const it = p.type || "";
    if (it === "message") {
      const role = p.role || "";
      const text = (p.content || []).map(c => c.text || c.input_text || c.output_text || "").join("");
      if (!text.trim()) return null;
      return { kind: role === "user" ? "user" : "agent", ts, text };
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
      return { kind: "tool", ts, text: p.name + " " + String(p.arguments || "").slice(0, 300) };
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
  // turn_context lines carry model/cwd on newer versions
  if (t === "turn_context") {
    return { kind: "meta", ts, cwd: p.cwd || "", model: p.model || "" };
  }
  return null;
}

function ingest(file) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  let s = sessions.get(file);
  if (!s) {
    s = { id: path.basename(file, ".jsonl"), file, offset: 0, partial: "", meta: {}, events: [], lastGrow: st.mtimeMs, size: 0 };
    sessions.set(file, s);
  }
  if (st.size < s.size) { s.offset = 0; s.partial = ""; s.events = []; } // truncated/rotated
  s.size = st.size;
  if (st.size <= s.offset) return;

  const fd = fs.openSync(file, "r");
  const len = st.size - s.offset;
  const buf = Buffer.alloc(Math.min(len, 5 * 1024 * 1024));
  fs.readSync(fd, buf, 0, buf.length, s.offset);
  fs.closeSync(fd);
  s.offset += buf.length;
  // mtime, not Date.now(): initial backfill of old files must not look like live growth
  s.lastGrow = st.mtimeMs;

  const chunk = s.partial + buf.toString("utf8");
  const lines = chunk.split("\n");
  s.partial = lines.pop() || "";
  const fresh = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const ev = simplify(line);
    if (!ev) continue;
    // rollouts log each message twice (event_msg + response_item) - drop consecutive duplicates
    const prevEv = s.events[s.events.length - 1];
    if (prevEv && prevEv.kind === ev.kind && prevEv.text === ev.text && ev.kind !== "meta") continue;
    if (ev.kind === "meta") {
      if (ev.cwd) s.meta.cwd = ev.cwd;
      if (ev.model) s.meta.model = ev.model;
      if (ev.id) s.meta.threadId = ev.id;
      continue;
    }
    s.events.push(ev);
    fresh.push(ev);
    if (s.events.length > MAX_EVENTS_KEPT) s.events.splice(0, s.events.length - MAX_EVENTS_KEPT);
  }
  if (fresh.length) broadcast({ type: "events", session: s.id, events: fresh });
}

function sessionSummary(s) {
  // LIVE: file is growing. DONE: wrote task_complete. IDLE: quiet but recent
  // (slow tool call / thinking). STALE: quiet >10min and never completed - dead/aborted.
  const quiet = Date.now() - s.lastGrow;
  const status = quiet < LIVE_WINDOW_MS ? "LIVE"
    : s.events.some(e => e.kind === "done") ? "DONE"
    : quiet < STALE_AFTER_MS ? "IDLE" : "STALE";
  const last = s.events[s.events.length - 1];
  return {
    id: s.id,
    threadId: s.meta.threadId || "",
    cwd: s.meta.cwd || "",
    model: s.meta.model || "",
    status,
    lastGrow: s.lastGrow,
    lastEvent: last ? (last.kind + ": " + String(last.text).slice(0, 90)) : "",
    eventCount: s.events.length,
  };
}

function broadcast(obj) {
  const line = "data: " + JSON.stringify(obj) + "\n\n";
  for (const res of sseClients) { try { res.write(line); } catch {} }
}

function tick() {
  const files = listRolloutFiles();
  for (const f of files) ingest(f);
  for (const key of sessions.keys()) if (!files.includes(key)) sessions.delete(key);
  broadcast({ type: "sessions", sessions: files.map(f => sessions.get(f)).filter(Boolean).map(sessionSummary) });
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

// ---------------- HTTP ----------------
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Codex Live</title><style>
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
  const sig=JSON.stringify([filter,selected,shown.map(s=>[s.id,s.status,s.lastEvent,unread.has(s.id)])]);
  if(sig===lastSig)return;lastSig=sig;
  list.innerHTML='';
  for(const s of shown){
    const d=document.createElement('div');d.className='sess'+(s.id===selected?' sel':'');
    // session text (cwd, last message) comes from rollout files - never innerHTML it
    d.innerHTML='<div class="top"><span class="badge '+s.status+'">'+s.status+'</span>'
      +(unread.has(s.id)?'<span class="dot" title="new activity"></span>':'')
      +'<span class="when"></span></div><div class="cwd"></div><div class="lastev"></div>';
    d.querySelector('.when').textContent=new Date(s.lastGrow).toLocaleTimeString();
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
      +'The processes below are shared app-servers / hosts (Codex Desktop, VS Code extension, plugin handoff channel); '
      +'killing one affects ALL sessions running through it, not just this one.';
    stoplist.appendChild(w);
  }
  for(const p of procs){
    const closeMatch=t0&&Math.abs(p.started-t0)<15000;
    const r=document.createElement('div');r.className='proc'+(closeMatch?' close':'');
    const b=document.createElement('button');b.className='killbtn';b.textContent='KILL';
    b.onclick=async()=>{
      if(!confirm('Kill PID '+p.pid+' ('+p.name+') and its whole child process tree?\\nThis cannot be undone.'))return;
      let msg='';try{msg=await(await fetch('/kill?pid='+p.pid,{method:'POST'})).text()}catch(e){msg='request failed: '+e}
      alert(msg);stoplist.hidden=true;
    };
    const txt=document.createElement('span');
    txt.textContent='[pid '+p.pid+'] '+p.name+' | started '+(p.started?new Date(p.started).toLocaleTimeString():'?')
      +(closeMatch?' \\u2190 matches this session start':'')+' | '+String(p.cmd||'').slice(0,160);
    r.appendChild(b);r.appendChild(txt);stoplist.appendChild(r);
  }
};
// full feed rebuild ONLY on session switch / snapshot; live events append incrementally,
// so selecting text in the feed is never wiped by the 1s poll
function renderFeed(){
  feed.innerHTML='';const evs=store[selected]||[];
  renderHead();
  if(!evs.length){feed.innerHTML='<div id="empty">no displayable events yet</div>';return}
  for(const e of evs)feed.appendChild(evHtml(e));
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
    if(d.session===selected){for(const e of d.events)feed.appendChild(evHtml(e));feed.scrollTop=feed.scrollHeight}
    else if(seeded){unread.add(d.session);lastSig='';renderList()}}
};
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  } else if (req.url === "/procs") {
    codexProcs(list => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(list));
    });
  } else if (req.url.startsWith("/kill?pid=")) {
    if (process.platform !== "win32") { res.writeHead(501); return res.end("kill is Windows-only for now"); }
    if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
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
  } else if (req.url === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    sseClients.add(res);
    // initial state: session list + full event snapshots
    res.write("data: " + JSON.stringify({ type: "sessions", sessions: [...sessions.values()].map(sessionSummary) }) + "\n\n");
    for (const s of sessions.values())
      res.write("data: " + JSON.stringify({ type: "snapshot", session: s.id, events: s.events }) + "\n\n");
    req.on("close", () => sseClients.delete(res));
  } else {
    res.writeHead(404); res.end("not found");
  }
});

if (!fs.existsSync(SESSIONS_DIR)) {
  console.error("[X] Sessions dir not found: " + SESSIONS_DIR);
  console.error("    Run any codex command once, or set CODEX_HOME.");
  process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => {
  console.log("[OK] Codex Live Viewer -> http://localhost:" + PORT);
  console.log("[OK] Watching: " + SESSIONS_DIR);
  tick();
  setInterval(tick, POLL_MS);
});
