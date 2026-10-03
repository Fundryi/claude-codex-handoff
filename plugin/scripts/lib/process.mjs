import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Resolve npm's Windows shim to its executable or Node entry point. Free-text
// arguments then use spawn's argv directly, without cmd.exe or PowerShell.
export function resolveCliCommand(command) {
  if (process.platform !== "win32") return { command, args: [] };
  const found = runCommand("where.exe", [command], { shell: false });
  for (const file of found.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    if (/\.exe$/i.test(file)) return { command: file, args: [] };
    if (!/\.(cmd|ps1)$/i.test(file)) continue;
    let shim;
    try { shim = fs.readFileSync(file, "utf8"); } catch { continue; }
    const target = shim.match(/(?:%dp0%|\$basedir)[\\/]([^"\r\n]+\.(?:exe|m?js))"/i)?.[1];
    if (!target) continue;
    const entry = path.resolve(path.dirname(file), target);
    if (fs.existsSync(entry)) return /\.exe$/i.test(entry)
      ? { command: entry, args: [] }
      : { command: process.execPath, args: [entry] };
  }
  throw new Error(`${command} CLI executable not found`);
}

export function runCommand(command, args = [], options = {}) {
  const shell = options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false);
  // One command string when a shell is used: Node joins file and args that way
  // anyway, and a non-empty args array with a shell trips DEP0190.
  // ponytail: shell-routed callers pass constant tokens (no spaces/metachars). The one
  // outside value that reaches a shell, CODEX_PLUGIN_FAST_TIER, goes through
  // app-server.mjs and fastTier() restricts it to [A-Za-z0-9_-]. Quote the args if
  // free text ever reaches a shell spawn.
  const result = spawnSync(shell ? [command, ...args].join(" ") : command, shell ? [] : args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env,
      // shell:false — runCommand's win32 default routes through $SHELL, and Git Bash
      // rewrites /PID into "C:/Program Files/Git/PID"; taskkill is a native exe.
      shell: false
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
