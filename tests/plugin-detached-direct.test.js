const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const libDir = path.join(__dirname, "..", "plugin", "scripts", "lib");
const href = (name) => pathToFileURL(path.join(libDir, name)).href;

// A SessionEnd in ANY Claude session of the workspace sends broker/shutdown,
// which aborts every turn the shared broker hosts. Detached workers therefore
// never ride the broker - they spawn their own app-server.
test("detached runs bypass the shared broker, inline runs keep it", async () => {
  const { turnConnectOptions } = await import(href("codex.mjs"));
  assert.deepEqual(turnConnectOptions({}), {});
  assert.deepEqual(turnConnectOptions({ detached: true }), { disableBroker: true });
  assert.deepEqual(turnConnectOptions({ detached: true, fast: true }), {
    disableBroker: true,
    configOverrides: ["service_tier=priority"]
  });
});

function fakeClient() {
  let resolveExit;
  const client = {
    exitError: null,
    exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
    notificationHandler: null,
    setNotificationHandler(handler) { this.notificationHandler = handler; },
    exit(error) { this.exitError = error ?? null; resolveExit(); }
  };
  return client;
}

// Before: the connection closing only rejected pending requests. The turn
// promise hung, every timer was unref'd, and Node exited 0 without a log line.
test("captureTurn rejects when the app-server connection closes mid-turn", async () => {
  const { captureTurn } = await import(href("codex.mjs"));
  const client = fakeClient();
  const capture = captureTurn(client, "thread-1", async () => ({ turn: { id: "turn-1", status: "inProgress" } }));

  client.exit(new Error("codex app-server exited unexpectedly (exit 1)."));

  await assert.rejects(capture, /exited unexpectedly/);
});

test("captureTurn rejects with a default reason when the close carries no error", async () => {
  const { captureTurn } = await import(href("codex.mjs"));
  const client = fakeClient();
  const capture = captureTurn(client, "thread-1", async () => ({ turn: { id: "turn-1", status: "inProgress" } }));

  client.exit(null);

  await assert.rejects(capture, /connection closed before the turn completed/);
});

test("captureTurn still resolves normally when the turn completes before close", async () => {
  const { captureTurn } = await import(href("codex.mjs"));
  const client = fakeClient();
  const capture = captureTurn(client, "thread-1", async () => ({ turn: { id: "turn-1", status: "inProgress" } }));

  await new Promise((resolve) => setImmediate(resolve));
  client.notificationHandler({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
  client.exit(null);

  const state = await capture;
  assert.equal(state.finalTurn.status, "completed");
});
