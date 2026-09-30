// ponytail: transition cleanup for pre-2.17 brokers, delete in the release after 2.17.0.
// Only SessionEnd uses this, to stop a shared broker an older plugin version left running.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir } from "./state.mjs";

const BROKER_STATE_FILE = "broker.json";

// Bounded: a frozen broker that accepts but never answers must not hold SessionEnd
// past its 3 s hook timeout, or broker.json is never cleared and every later
// SessionEnd hangs again. A bad endpoint also just resolves, so cleanup still runs.
export async function sendBrokerShutdown(endpoint, timeoutMs = 1000) {
  await new Promise((resolve) => {
    let socket;
    try {
      socket = net.createConnection({ path: parseBrokerEndpoint(endpoint).path });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, timeoutMs);
    socket.on("close", () => clearTimeout(timer));
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

// No pid kill: a live pre-2.17 broker exits itself on broker/shutdown, and a
// leftover pid from a dead one may already belong to an unrelated process.
export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null }) {
  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
