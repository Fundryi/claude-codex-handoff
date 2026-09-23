#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { checkForUpdate } from "./lib/update-check.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

export function viewerPort(env = process.env) {
  return Number(env.CODEX_VIEWER_PORT) || 8377;
}

// state: "running" (our viewer), "foreign" (another app owns the port) or "down".
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
    req.on("timeout", () => { req.destroy(); resolve({ state: "down", version: null }); });
    req.on("error", () => resolve({ state: "down", version: null }));
  });
}

export async function checkViewerHealth(port, timeoutMs = 700) {
  return (await viewerHealth(port, timeoutMs)).state;
}

export function bundledViewerPath(pluginRoot) {
  return path.join(pluginRoot, "viewer", "codex-live-viewer.js");
}

function pluginVersion(pluginRoot) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
}

// True only when both are x.y.z and `running` is lower. Anything unreadable counts as
// not older, so an unknown viewer is left alone.
function isOlderVersion(running, current) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ""))?.slice(1).map(Number);
  const a = parse(running);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

const REPLACE_WAIT_MS = 2000;

// Ask the old viewer to stop (as `codex-live-viewer.js stop` does), then wait a bounded
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
    if ((await viewerHealth(port, 300)).state === "down") return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// Starts the bundled viewer when none runs, and replaces one an older plugin started:
// that viewer would otherwise keep the port forever. An equal or newer viewer, one
// with no readable version, and a foreign app are all left alone. The tray launcher
// never restarts its viewer on its own, so the two cannot fight over the port.
export async function maybeStartViewer(env = process.env) {
  try {
    if (env.CODEX_VIEWER_AUTOSTART === "0") return "disabled";
    const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return "no-plugin-root";
    const script = bundledViewerPath(pluginRoot);
    if (!fs.existsSync(script)) return "no-bundle";
    const port = viewerPort(env);
    const health = await viewerHealth(port);
    let outcome = "started";
    if (health.state === "running" && isOlderVersion(health.version, pluginVersion(pluginRoot))) {
      if (!(await stopOldViewer(port))) return "port-busy";
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

export async function sessionUpdateNotice(env = process.env) {
  try {
    const pluginRoot = env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) return null;
    const stateRoot = env.CODEX_COMPANION_STATE_ROOT || path.join(os.homedir(), ".codex-companion");
    return await checkForUpdate({
      currentVersion: pluginVersion(pluginRoot),
      cacheFile: path.join(stateRoot, "update-check.json"),
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

async function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  await maybeStartViewer();
  const notice = await sessionUpdateNotice();
  if (notice) console.log(notice);
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;

  if (brokerEndpoint) {
    await sendBrokerShutdown(brokerEndpoint);
  }

  // Job workers are detached and own their app-server, so a SessionEnd must not
  // touch them. Under CloudCLI a SessionEnd fires on every superseded turn.
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    killProcess: terminateProcessTree
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    await handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
