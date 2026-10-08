'use strict';

const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const APP_ID = "codex-live-viewer";
const APP_VERSION = "2.27.2";
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
const OPENCODE_DB = process.env.OPENCODE_DB || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db");
// The viewer never writes under CODEX_HOME, so the token lives in the companion state root.
// Older builds kept it in CODEX_HOME; that copy is only read, so old tunnel links keep working.
const TOKEN_FILE = path.join(process.env.CODEX_COMPANION_STATE_ROOT
  || path.join(os.homedir(), ".codex-companion", "state"), "live-viewer-token");
const LEGACY_TOKEN_FILE = path.join(CODEX_HOME, "live-viewer-token");
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
const rolloutStats = new Map(); // file -> { mtimeMs, size } from the last stat, or null
const resumedFiles = new Set(); // untracked rollouts a full pass saw grow, followed until read to the end

const IDLE_POLL_MS = 5000;
const COMPANION_STATE_ROOT = process.env.CODEX_COMPANION_STATE_ROOT
  || path.join(os.homedir(), ".codex-companion", "state");
const jobStateCache = new Map(); // dir name -> { mtimeMs, size, at, jobs }
const CLAUDE_SCAN_MS = 5000;              // new runs appear within this
const CLAUDE_MAX_RUNS = 20;               // newest runs tracked; running runs always kept on top
const CLAUDE_KEEP_MS = 24 * 60 * 60 * 1000; // no activity this long => dropped from memory (files stay)
const CLAUDE_TOOL_GRACE_MS = 30 * 60 * 1000; // an agent waiting on its own tool stays Running this long
const CLAUDE_MAX_AGENTS_SENT = 150;       // per run in the frame; counts stay exact
const CLAUDE_RUN_ID = /^wf_[A-Za-z0-9-]{3,40}$/;
const CLAUDE_AGENT_ID = /^a[0-9a-f]{6,40}$/;
const claudeRuns = new Map();             // runId -> run (claudeNewRun has the shape)
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
const CLAUDE_LIMITS_FILE = path.join(os.homedir(), ".codex-companion", "claude-limits.json");
const CODEX_LIMITS_MS = 5 * 60 * 1000;

const shared = {
  searchIndexReady: false,
  claudeActive: 0,
  claudeFrame: { type: "claudeRuns", runs: [] },
  claudeChatsFrame: { type: "claudeChats", chats: [], ghosts: [] },
  opencodeRows: [],
  opencodeWatermark: "",
  opencodeChatsFrame: { type: "opencodeChats", chats: [] },
  claudeUsageFrame: { type: "claudeUsage", usage: null },
  codexLimitsFrame: { type: "codexLimits", limits: null },
};


module.exports = { PORT, FLAGS, HOST, TOKEN_FILE, LEGACY_TOKEN_FILE, sessions, sseClients, shared, SESSIONS_DIR, ARCHIVED_DIR, POLL_MS, LIVE_WINDOW_MS, MAX_SESSIONS, MAX_EVENTS_KEPT, notificationClients, searchIndex, pinnedFiles, rolloutStats, resumedFiles, IDLE_POLL_MS, ROOT, COMPANION_STATE_ROOT, jobStateCache, CLAUDE_TOOL_GRACE_MS, CLAUDE_MAX_AGENTS_SENT, CLAUDE_AGENT_ID, claudeRuns, claudeWfReaders, CLAUDE_PROJECTS, CLAUDE_MAX_RUNS, CLAUDE_KEEP_MS, CLAUDE_RUN_ID, CLAUDE_CHAT_ID, CLAUDE_SWEEP_MS, claudeChatFiles, claudeChats, claudeLinks, CLAUDE_ROOT_MS, CLAUDE_MAX_ROOTS, CLAUDE_MAX_CHILDREN_SENT, CLAUDE_SCAN_CAP, CLAUDE_SLICE_MS, CLAUDE_SESSIONS_DIR, OPENCODE_DB, CLAUDE_STATE_FILE, CLAUDE_LIMITS_FILE, CODEX_LIMITS_MS, APP_ID, APP_VERSION, MAX_PINNED, PID_FILE, CLAUDE_SCAN_MS };
