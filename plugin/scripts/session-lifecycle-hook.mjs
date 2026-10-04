#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { checkForUpdate, compareVersions } from "./lib/update-check.mjs";
import { readViewerIntegrations } from "./lib/viewer-integrations.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function viewerPort(env = process.env) {
  return Number(env.CODEX_VIEWER_PORT) || 8377;
}

// state: "running" (our viewer), "foreign" (another app owns the port) or "down".
// timedOut: nothing answered in time. That counts as "down" for starting a viewer,
// but never as proof that a port was freed.
function viewerHealth(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => { if (body.length < 1000) body += c; });
      res.on("end", () => {
        let data = null;
        try { data = JSON.parse(body); } catch {}
        resolve(data?.application === "codex-live-viewer"
          ? { state: "running", version: data.version ?? null }
          : { state: "foreign", version: null });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ state: "down", version: null, timedOut: true }); });
    req.on("error", () => resolve({ state: "down", version: null }));
  });
}

export async function checkViewerHealth(port, timeoutMs = 700) {
  return (await viewerHealth(port, timeoutMs)).state;
}

export function bundledViewerPath(pluginRoot) {
  return path.join(pluginRoot, "viewer", "ai-live-viewer.js");
}

function pluginVersion(pluginRoot) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
}

// Where the update check keeps its cache; the failed-replacement record sits beside it.
function companionDir(env) {
  return env.CODEX_COMPANION_STATE_ROOT || path.join(os.homedir(), ".codex-companion");
}

const REPLACE_WAIT_MS = 1500;
const REPLACE_RECORD = "viewer-replace-failed.json";

// Ask the old viewer to stop (as `ai-live-viewer.js stop` does), then wait a bounded
// time for the port to free. False when it never does: nothing new starts then.
async function stopOldViewer(port) {
  await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/shutdown", method: "POST", timeout: 500 }, (res) => {
      res.resume();
      res.on("end", resolve);
    });
    req.on("timeout", () => { req.destroy(); resolve(); });
    req.on("error", resolve);
    req.end();
  });
  const deadline = Date.now() + REPLACE_WAIT_MS;
  while (Date.now() < deadline) {
    const health = await viewerHealth(port, 300);
    if (health.state === "down" && !health.timedOut) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Starts the bundled viewer when none runs, and replaces one an older plugin started:
// that viewer would otherwise keep the port forever. An equal or newer viewer, one
// with no readable version, and a foreign app are all left alone.
// A failed replacement is recorded for this plugin version and not retried (under
// CloudCLI this hook runs on every message), so "port-busy" comes back only once.
export async function maybeStartViewer(env = process.env) {
  try {
    if (env.CODEX_VIEWER_AUTOSTART === "0") return "disabled";
    const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return "no-plugin-root";
    const script = bundledViewerPath(pluginRoot);
    if (!fs.existsSync(script)) return "no-bundle";
    const port = viewerPort(env);
    const health = await viewerHealth(port);
    const version = pluginVersion(pluginRoot);
    const record = path.join(companionDir(env), REPLACE_RECORD);
    let outcome = "started";
    // compareVersions reads anything but x.y.z as equal, so an unknown viewer stays.
    if (health.state === "running" && compareVersions(health.version, version) < 0) {
      let failedBefore = false;
      try { failedBefore = JSON.parse(fs.readFileSync(record, "utf8")).version === version; } catch {}
      if (failedBefore) return "running";
      if (!(await stopOldViewer(port))) {
        try {
          fs.mkdirSync(path.dirname(record), { recursive: true });
          fs.writeFileSync(record, `${JSON.stringify({ version, oldVersion: health.version, port })}\n`, "utf8");
        } catch {}
        return "port-busy";
      }
      outcome = "replaced";
    } else if (health.state !== "down") {
      return health.state; // running, or a foreign process owns the port
    }
    spawn(process.execPath, [script, "serve"], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
    return outcome;
  } catch {
    return "error";
  }
}

// This hook runs on every message under CloudCLI, so the "another program has the
// port" notice is shown once per port and day, not on every message.
export function firstForeignNoticeToday(env = process.env, today = new Date().toISOString().slice(0, 10)) {
  const record = path.join(companionDir(env), "viewer-port-foreign.json");
  const key = `${viewerPort(env)}@${today}`;
  try { if (JSON.parse(fs.readFileSync(record, "utf8")).key === key) return false; } catch {}
  try {
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.writeFileSync(record, `${JSON.stringify({ key })}
`, "utf8");
  } catch {}
  return true;
}

export async function sessionUpdateNotice(env = process.env) {
  try {
    const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return null;
    return await checkForUpdate({
      currentVersion: pluginVersion(pluginRoot),
      cacheFile: path.join(companionDir(env), "update-check.json"),
      env
    });
  } catch {
    return null;
  }
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

// The statusLine setting needs a path that survives plugin updates (the plugin folder name holds
// the version), so the status line script is kept as a copy in ~/.codex-companion.
export const STATUSLINE_COPY = path.join(os.homedir(), ".codex-companion", "claude-statusline.mjs");
export function syncStatusLineScript(env = process.env, dest = STATUSLINE_COPY) {
  if (!env.CLAUDE_PLUGIN_ROOT) return false;
  try {
    const body = fs.readFileSync(path.join(env.CLAUDE_PLUGIN_ROOT, "scripts", "claude-statusline.mjs"));
    let old = null;
    try { old = fs.readFileSync(dest); } catch {}
    if (old && old.equals(body)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    return true;
  } catch {
    return false;
  }
}

async function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  syncStatusLineScript();
  if (firstIntegrationHint()) console.log("Run /codex:setup for the optional Codex approval hook and the OpenCode viewer plugin.");
  const viewer = await maybeStartViewer();
  if (viewer === "port-busy") {
    console.log(`[codex plugin] An older Codex viewer on port ${viewerPort()} did not stop, so the updated viewer could not start. Run /codex:viewer restart, or /codex:viewer kill if it hangs. This is not retried for this plugin version.`);
  } else if (viewer === "foreign" && firstForeignNoticeToday()) {
    console.log(`[codex plugin] Port ${viewerPort()} is used by another program, so the Codex viewer did not start. Set CODEX_VIEWER_PORT to a free port (for example ${viewerPort() + 1}) where Claude and Codex run.`);
  }
  const notice = await sessionUpdateNotice();
  if (notice) console.log(notice);
}

export function firstIntegrationHint(env = process.env) {
  try {
    const root = env.CLAUDE_PLUGIN_ROOT;
    if (!root) return false;
    const version = pluginVersion(root);
    const record = path.join(env.CODEX_COMPANION_STATE_ROOT || path.join(os.homedir(), ".codex-companion", "state"),
      `viewer-integrations-hint-${version}.json`);
    if (fs.existsSync(record)) return false;
    const { codexHooks, opencodePlugin } = readViewerIntegrations(root, env);
    const approvalNotices = codexHooks.shipped && codexHooks.enabled && !codexHooks.trusted;
    const openCodeMissing = opencodePlugin.opencodeFound && !opencodePlugin.installed;
    if (!approvalNotices && !openCodeMissing) return false;
    fs.mkdirSync(path.dirname(record), { recursive: true });
    // Exclusive create also limits simultaneous SessionStart hooks to one hint.
    fs.writeFileSync(record, "{}\n", { flag: "wx" });
    return true;
  } catch { return false; }
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    await handleSessionStart(input);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
