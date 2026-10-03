import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { binaryAvailable, resolveCliCommand } from "./process.mjs";

export const CODEX_HOOK_STEP = "open codex, run /hooks, trust the codex@fundryi hooks";
const OPENCODE_MARKER = 'id: "ai-live-viewer.notify"';

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

// Read only the scalar state entries Codex writes. Unknown TOML forms need trust.
export function codexHookStates(toml) {
  const states = new Map();
  let state = null, multiline = "";
  for (const raw of toml.split(/\r?\n/)) {
    // A header inside developer_instructions or a comment is not hook state.
    let line = "", quote = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i], triple = raw.slice(i, i + 3);
      if (multiline) {
        if (triple === multiline) { multiline = ""; i += 2; }
        else if (multiline === '"""' && c === "\\") i++;
      } else if (quote) {
        line += c;
        if (quote === '"' && c === "\\") { line += raw[++i] || ""; }
        else if (c === quote) quote = "";
      } else if (c === "#") break;
      else if (triple === '"""' || triple === "'''") { multiline = triple; line += "<multiline>"; i += 2; }
      else { line += c; if (c === '"' || c === "'") quote = c; }
    }
    if (quote) return new Map(); // invalid single-line TOML string
    if (/^\s*\[/.test(line)) {
      state = null;
      const match = line.match(/^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*"|'[^']*')\]\s*(?:#.*)?$/);
      if (!match) continue;
      try {
        const key = match[1].startsWith("'") ? match[1].slice(1, -1) : JSON.parse(match[1]);
        if (states.has(key)) { states.set(key, {}); continue; }
        state = {};
        states.set(key, state);
      } catch {}
    } else if (state) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const hash = line.match(/^\s*trusted_hash\s*=\s*("sha256:[a-f0-9]{64}"|'sha256:[a-f0-9]{64}')\s*(?:#.*)?$/);
      if (hash) state.hash = state.hash === undefined ? hash[1].slice(1, -1) : "";
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
      if (enabled) state.enabled = state.enabled === undefined ? enabled[1] === "true" : false;
      if (!hash && !enabled) state.enabled = false;
    }
  }
  return states;
}

// Codex hashes sorted JSON of the normalized TOML hook identity. The command
// override replaces command on Windows before hashing; plugin paths are excluded.
export function codexHookHash(event, handler, platform = process.platform) {
  const command = platform === "win32" ? handler.commandWindows || handler.command : handler.command;
  const identity = { event_name: event, hooks: [{ async: handler.async === true,
    command, timeout: handler.timeout || 600, type: "command" }] };
  return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function openCodePluginPath(env = process.env) {
  return path.join(env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode"),
    "plugins", "ai-live-viewer-notify.js");
}

export function readViewerIntegrations(pluginRoot, env = process.env, opencodeFound) {
  const toml = readText(path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml"));
  let shipped = false, enabled = false, trusted = false;
  try {
    const manifest = JSON.parse(readText(path.join(pluginRoot, ".codex-plugin", "plugin.json")));
    const hooks = JSON.parse(readText(path.join(pluginRoot, "codex-hooks", "hooks.json"))).hooks;
    shipped = !!hooks.PermissionRequest?.[0]?.hooks?.[0];
    enabled = manifest.hooks === "./codex-hooks/hooks.json";
    const states = codexHookStates(toml);
    const state = states.get("codex@fundryi:codex-hooks/hooks.json:permission_request:0:0");
    trusted = shipped && enabled && state?.enabled !== false
      && state?.hash === codexHookHash("permission_request", hooks.PermissionRequest[0].hooks[0]);
  } catch {}
  if (opencodeFound === undefined) {
    opencodeFound = false;
    let probe;
    try {
      const cli = resolveCliCommand("opencode");
      // OpenCode 2 creates its config folder even for --version. Keep that
      // side effect in a disposable home, so a report never changes user config.
      probe = fs.mkdtempSync(path.join(os.tmpdir(), "codex-opencode-version-"));
      const probeEnv = { ...env, OPENCODE_CONFIG_DIR: path.join(probe, "config"),
        XDG_CONFIG_HOME: path.join(probe, "config-root"), XDG_DATA_HOME: path.join(probe, "data"),
        XDG_CACHE_HOME: path.join(probe, "cache"), XDG_STATE_HOME: path.join(probe, "state") };
      const status = binaryAvailable(cli.command, [...cli.args, "--version"], { shell: false, env: probeEnv });
      opencodeFound = status.available && /(?:^|\s)v?2\.\d+\.\d+/.test(status.detail);
    } catch {} finally {
      if (probe && path.resolve(probe).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
        try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
      }
    }
  }
  const pluginPath = openCodePluginPath(env);
  let installed = false;
  try { installed = fs.lstatSync(pluginPath).isFile() && readText(pluginPath).includes(OPENCODE_MARKER); } catch {}
  const legacy = /^\s*notify\s*=\s*\[([\s\S]*?)\]/m.exec(toml)?.[1] || "";
  return {
    codexHooks: { shipped, enabled, trusted, step: CODEX_HOOK_STEP },
    opencodePlugin: { opencodeFound, installed, path: pluginPath },
    legacyNotifyHook: { found: /notify\.ps1/i.test(legacy) }
  };
}

export function manageOpenCodePlugin(pluginRoot, install, env = process.env) {
  const file = openCodePluginPath(env);
  let existing = null;
  try { existing = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && (!existing.isFile() || !readText(file).includes(OPENCODE_MARKER))) {
    throw new Error(`Refused to change a file that is not our OpenCode viewer plugin: ${file}`);
  }
  if (install) {
    if (!readViewerIntegrations(pluginRoot, env).opencodePlugin.opencodeFound) throw new Error("Install OpenCode 2 before the viewer plugin.");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(pluginRoot, "opencode", "ai-live-viewer-notify.js"), file);
    return `Installed OpenCode viewer plugin: ${file}. Restart OpenCode to load it.`;
  }
  if (existing) fs.unlinkSync(file);
  return `${existing ? "Removed" : "No installed"} OpenCode viewer plugin: ${file}.`;
}
