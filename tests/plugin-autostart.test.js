const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const hookUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "session-lifecycle-hook.mjs")).href;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("viewerPort defaults to 8377 and accepts an override", async () => {
  const { viewerPort } = await import(hookUrl);
  assert.equal(viewerPort({}), 8377);
  assert.equal(viewerPort({ CODEX_VIEWER_PORT: "9123" }), 9123);
});

test("incomplete integrations show one hint per plugin version in companion state", async () => {
  const { firstIntegrationHint } = await import(hookUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-hint-"));
  const pluginRoot = path.join(__dirname, "..", "plugin");
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CODEX_HOME: dir,
    XDG_CONFIG_HOME: dir, CODEX_COMPANION_STATE_ROOT: path.join(dir, "state") };
  try {
    assert.equal(firstIntegrationHint(env), true);
    assert.equal(firstIntegrationHint(env), false);
    assert.equal(fs.readdirSync(env.CODEX_COMPANION_STATE_ROOT).length, 1);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["state"], "the hint does not install a plugin or edit Codex config");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("checkViewerHealth recognizes the viewer and a foreign server", async () => {
  const { checkViewerHealth } = await import(hookUrl);
  for (const [application, expected] of [["codex-live-viewer", "running"], ["something-else", "foreign"]]) {
    const server = await listen((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ application }));
    });
    try {
      assert.equal(await checkViewerHealth(server.address().port), expected);
    } finally {
      await close(server);
    }
  }
});

test("checkViewerHealth reports down on a closed port", async () => {
  const { checkViewerHealth } = await import(hookUrl);
  const server = await listen((_req, res) => res.end());
  const port = server.address().port;
  await close(server);
  assert.equal(await checkViewerHealth(port), "down");
});

test("maybeStartViewer honors opt-out and a missing bundle without spawning", async () => {
  const { maybeStartViewer } = await import(hookUrl);
  assert.equal(await maybeStartViewer({ CODEX_VIEWER_AUTOSTART: "0" }), "disabled");
  assert.equal(await maybeStartViewer({ CLAUDE_PLUGIN_ROOT: path.join(__dirname, "missing-plugin") }), "no-bundle");
});

test("the status line script: a stable copy, and only the two documented limit windows", async () => {
  const { syncStatusLineScript } = await import(hookUrl);
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clv-statusline-")), "sub", "claude-statusline.mjs");
  const root = path.join(__dirname, "..", "plugin");
  assert.equal(syncStatusLineScript({ CLAUDE_PLUGIN_ROOT: root }, dest), true, "copied on the first start");
  assert.equal(syncStatusLineScript({ CLAUDE_PLUGIN_ROOT: root }, dest), false, "unchanged: no write");
  assert.equal(syncStatusLineScript({}, dest), false, "no plugin root: nothing");
  const { statusLimits, statusText } = await import(pathToFileURL(path.join(root, "scripts", "claude-statusline.mjs")).href);
  const input = { model: { display_name: "Opus 5.5" }, session_id: "secret",
    rate_limits: { five_hour: { used_percentage: 12.4, resets_at: 1790800000 }, seven_day: { used_percentage: 21, resets_at: 1791000000 }, spend_limit: { used_percentage: 3 } } };
  const limits = statusLimits(input);
  assert.deepEqual(limits, { fiveHour: { usedPercent: 12.4, resetsAtMs: 1790800000000 }, sevenDay: { usedPercent: 21, resetsAtMs: 1791000000000 } });
  assert.equal(statusText(input, limits), "Opus 5.5 · 5h 12% · week 21%");
  assert.equal(statusLimits({ rate_limits: { five_hour: { used_percentage: "12" } } }), null, "not a number: nothing saved");
  assert.equal(statusLimits({}), null, "an API-key user has no rate_limits");
  assert.equal(statusText({ model: { display_name: "Opus 5.5" } }, null), "Opus 5.5");
});

// A plugin root whose bundled "viewer" only leaves a marker, so a test can see
// whether the hook started it.
function fakePluginRoot(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clv-autostart-"));
  fs.mkdirSync(path.join(root, ".claude-plugin"));
  fs.mkdirSync(path.join(root, "viewer"));
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(root, "viewer", "codex-live-viewer.js"), "require('fs').writeFileSync(require('path').join(__dirname, 'started'), '')\n");
  const started = async () => {
    for (let i = 0; i < 50 && !fs.existsSync(path.join(root, "viewer", "started")); i++) await new Promise((r) => setTimeout(r, 100));
    return fs.existsSync(path.join(root, "viewer", "started"));
  };
  // The hook's env, with its own state folder so no test touches the real one.
  const env = (port) => ({ CLAUDE_PLUGIN_ROOT: root, CODEX_VIEWER_PORT: String(port), CODEX_COMPANION_STATE_ROOT: path.join(root, "state") });
  return { root, started, env };
}

// A stand-in /health server. After /shutdown it closes ("closes"), keeps answering
// ("answers": the port never frees) or accepts and never replies ("hangs").
async function fakeViewer(body, { afterShutdown = "closes" } = {}) {
  let shutDown = false;
  const calls = [];
  const server = await listen((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (shutDown && afterShutdown === "hangs") return;
    if (req.url === "/shutdown") {
      res.end("bye");
      shutDown = true;
      if (afterShutdown === "closes") { server.close(); server.closeAllConnections(); }
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });
  return { server, calls, port: server.address().port };
}

test("an older viewer is shut down and replaced by the bundled one", async () => {
  const { maybeStartViewer } = await import(hookUrl);
  const plugin = fakePluginRoot("2.15.1");
  const viewer = await fakeViewer({ application: "codex-live-viewer", version: "2.11.6" });
  const outcome = await maybeStartViewer(plugin.env(viewer.port));
  assert.equal(outcome, "replaced");
  assert.ok(viewer.calls.includes("POST /shutdown"));
  assert.equal(await plugin.started(), true, "the bundled viewer starts on the freed port");
});

test("an equal or newer viewer and a foreign app are left alone", async () => {
  const { maybeStartViewer } = await import(hookUrl);
  const plugin = fakePluginRoot("2.15.1");
  for (const [body, expected] of [
    [{ application: "codex-live-viewer", version: "2.15.1" }, "running"],
    [{ application: "codex-live-viewer", version: "2.16.0" }, "running"],
    [{ application: "codex-live-viewer" }, "running"],
    [{ application: "something-else", version: "1.0.0" }, "foreign"]
  ]) {
    const viewer = await fakeViewer(body);
    try {
      assert.equal(await maybeStartViewer(plugin.env(viewer.port)), expected, JSON.stringify(body));
      assert.deepEqual(viewer.calls.filter((call) => call.startsWith("POST")), [], "never shut down");
    } finally {
      await close(viewer.server);
    }
  }
  assert.equal(fs.existsSync(path.join(plugin.root, "viewer", "started")), false);
});

test("an old viewer that never frees its port is given up on in time, once per version", async () => {
  const { maybeStartViewer } = await import(hookUrl);
  // "hangs": a health check that times out is not proof the port is free.
  for (const afterShutdown of ["answers", "hangs"]) {
    const plugin = fakePluginRoot("2.15.1");
    const viewer = await fakeViewer({ application: "codex-live-viewer", version: "2.11.6" }, { afterShutdown });
    try {
      const started = Date.now();
      assert.equal(await maybeStartViewer(plugin.env(viewer.port)), "port-busy", afterShutdown);
      assert.ok(Date.now() - started < 3500, `bounded wait (${afterShutdown})`);
      assert.equal(fs.existsSync(path.join(plugin.root, "viewer", "started")), false, "nothing started on a busy port");

      // CloudCLI runs this hook on every message: no second attempt for this version.
      const again = await maybeStartViewer(plugin.env(viewer.port));
      if (afterShutdown === "answers") assert.equal(again, "running");
      assert.equal(viewer.calls.filter((call) => call === "POST /shutdown").length, 1, "shut down once only");
    } finally {
      viewer.server.closeAllConnections();
      await close(viewer.server);
    }
  }
});

test("the another-program-on-the-port notice shows once per port and day", async () => {
  const { firstForeignNoticeToday } = await import(hookUrl);
  const env = { CODEX_COMPANION_STATE_ROOT: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clv-foreign-")), "state"), CODEX_VIEWER_PORT: "8377" };
  assert.equal(firstForeignNoticeToday(env, "2026-01-01"), true);
  assert.equal(firstForeignNoticeToday(env, "2026-01-01"), false, "CloudCLI runs the hook on every message");
  assert.equal(firstForeignNoticeToday({ ...env, CODEX_VIEWER_PORT: "8378" }, "2026-01-01"), true, "a new port is a new problem");
  assert.equal(firstForeignNoticeToday({ ...env, CODEX_VIEWER_PORT: "8378" }, "2026-01-02"), true, "and it is repeated the next day");
});
