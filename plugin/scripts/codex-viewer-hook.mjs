#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";

// The POST only asks the viewer to refresh sooner. A missing viewer must never affect the Codex turn.
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const event = input?.hook_event_name;
  if (event === "PermissionRequest") {
    const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
    const body = JSON.stringify({
      source: "codex", event,
      sessionId: text(input.session_id, 200), turnId: text(input.turn_id, 200),
      cwd: text(input.cwd, 4096), message: text(input.last_assistant_message, 160),
      tool: text(input.tool_name, 160)
    });
    const req = http.request({
      hostname: "127.0.0.1", port: Number(process.env.CODEX_VIEWER_PORT) || 8377,
      path: "/notify", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    }, (res) => { res.on("error", () => {}); res.resume(); });
    const timer = setTimeout(() => req.destroy(), 1500);
    req.on("close", () => clearTimeout(timer));
    req.on("error", () => {});
    req.end(body);
  }
} catch {}
