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

// The job log is the record that lets someone check what Codex really ran. A chained
// command used to be cut at 96 characters ("rg ... &..."), hiding the second half.
test("the job log shows each command in full, and marks a giant one as truncated", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { captureTurn } = await import(href("codex.mjs"));
  const { createProgressReporter } = await import(href("tracked-jobs.mjs"));
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clv-cmdlog-")), "job.log");
  fs.writeFileSync(logFile, "");
  const client = fakeClient();
  const capture = captureTurn(client, "thread-1", async () => ({ turn: { id: "turn-1", status: "inProgress" } }), {
    onProgress: createProgressReporter({ logFile })
  });
  await new Promise((resolve) => setImmediate(resolve));

  const chained = `rg -n "resolveWorkspaceRoot" plugin/scripts --glob '*.mjs' ${"-e pattern ".repeat(12)}&& git rev-parse --show-toplevel && echo CHAINED-TAIL`;
  const giant = `echo ${"z".repeat(9000)} GIANT-TAIL`;
  const item = (command, extra = {}) => ({ type: "commandExecution", id: command.slice(0, 8), command, ...extra });
  const send = (method, params) => client.notificationHandler({ method, params: { threadId: "thread-1", turnId: "turn-1", ...params } });
  send("item/started", { item: item(chained) });
  send("item/completed", { item: item(chained, { status: "completed", exitCode: 0 }) });
  send("item/started", { item: item(giant) });
  send("turn/completed", { turn: { id: "turn-1", status: "completed" } });
  await capture;

  const log = fs.readFileSync(logFile, "utf8");
  assert.ok(chained.length > 200, "the scenario needs a long chained command");
  assert.ok(log.includes(`Running command: ${chained}`), "started line carries the whole chain");
  assert.ok(log.includes(`Command completed: ${chained} (exit 0)`), "completed line carries the whole chain");
  assert.equal(log.includes("GIANT-TAIL"), false, "a giant command is capped");
  assert.match(log, /Running command: echo z{3000,} \(truncated\)/, "the cap is generous and marked");
});
