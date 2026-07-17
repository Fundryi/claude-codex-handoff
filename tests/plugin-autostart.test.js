const assert = require("node:assert/strict");
const http = require("node:http");
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
