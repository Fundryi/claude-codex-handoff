import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { binaryAvailable, resolveCliCommand, terminateProcessTree } from "./process.mjs";

export function ensureOpenCodeAvailable(cwd) {
  try {
    const cli = resolveCliCommand("opencode");
    if (binaryAvailable(cli.command, [...cli.args, "--version"], { cwd, shell: false }).available) return;
  } catch {}
  throw new Error("OpenCode CLI not found; install it and run `opencode` once");
}

// JSON lines are the public CLI boundary. Keep only the last text message;
// step_finish is not a done event and may belong to a message without text.
export function createOpenCodeOutput({ onSession, onProgress } = {}) {
  let threadId = null, messageId = null, parts = [], error = null;
  return {
    get threadId() { return threadId; },
    get finalMessage() { return parts.join("\n"); },
    get error() { return error; },
    readLine(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      if (!threadId && typeof event.sessionID === "string" && event.sessionID.startsWith("ses_")) {
        threadId = event.sessionID;
        onSession?.(threadId);
      }
      if (event.type === "error") {
        const value = event.error;
        error = { message: typeof value === "string" ? value : String(value?.data?.message || value?.message || value?.name || "OpenCode error") };
        return;
      }
      const part = event.part;
      if (!part || typeof part !== "object") return;
      if (event.type === "text" && typeof part.text === "string" && typeof part.messageID === "string") {
        if (messageId !== part.messageID) { messageId = part.messageID; parts = []; }
        parts.push(part.text);
        onProgress?.({ phase: "responding", message: part.text.replace(/\s+/g, " ").slice(0, 160), threadId });
      } else if (event.type === "tool_use") {
        onProgress?.({ phase: "tool", message: `OpenCode tool: ${String(part.tool || part.name || "tool")}`, threadId });
      } else if (event.type === "step_start") {
        onProgress?.({ phase: "working", message: "OpenCode is working", threadId });
      }
    }
  };
}

export async function runOpenCode(cwd, options = {}) {
  const cli = resolveCliCommand("opencode");
  const args = [...cli.args, "run", "--standalone", "--auto", "--format", "json", "--agent", options.write ? "build" : "plan"];
  if (options.model) args.push("-m", options.model);
  if (options.resumeThreadId) args.push("-s", options.resumeThreadId);
  if (options.title) args.push("--title", options.title);
  const child = spawn(cli.command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"],
    shell: false, windowsHide: true, detached: process.platform !== "win32" });
  child.once("spawn", () => options.onSpawn?.(child.pid));
  const output = createOpenCodeOutput({
    onProgress: options.onProgress,
    onSession: threadId => options.onProgress?.({ threadId, phase: "working", message: `OpenCode session: ${threadId}` })
  });
  let stderr = "", interrupted = false;
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", line => output.readLine(line));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", text => { stderr = (stderr + text).slice(-4000); });
  // A failed spawn or an early CLI exit can close stdin before the prompt write.
  child.stdin.on("error", () => {});
  let cancelError = null;
  const cancel = setInterval(() => {
    if (interrupted || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (options.shouldCancel?.()) {
        const stopped = terminateProcessTree(child.pid);
        if (stopped.delivered) interrupted = true;
      }
    } catch (error) { cancelError = error; }
  }, 250);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve(code ?? 1));
      child.stdin.end(options.prompt || "");
    });
    return { status: interrupted || output.error ? 1 : status, interrupted,
      threadId: output.threadId || options.resumeThreadId || null, turnId: null,
      finalMessage: output.finalMessage, error: output.error || (cancelError ? { message: cancelError.message } : null),
      stderr, touchedFiles: [], reasoningSummary: "", agents: [] };
  } finally {
    clearInterval(cancel);
    lines.close();
    options.onSpawn?.(null);
  }
}
