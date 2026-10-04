const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const trackedUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "tracked-jobs.mjs")).href;

// Retain the job SSE coverage from the removed desktop helper suite.
test("job broadcasts reach every notification client", () => {
  const { broadcast } = require("../server/events");
  const clients = new Set();
  const event = { type: "job", jobId: "job-1", status: "completed", title: "Two browsers" };
  assert.doesNotThrow(() => broadcast(event, clients));
  const writes = [[], []];
  for (const messages of writes) clients.add({ write(line) { messages.push(line); } });
  broadcast(event, clients);
  for (const messages of writes) assert.equal(messages[0], "data: " + JSON.stringify(event) + "\n\n");
  clients.add({ write() { throw new Error("disconnected client"); } });
  assert.doesNotThrow(() => broadcast(event, clients));
  for (const messages of writes) assert.equal(messages.length, 2);
});

test("notifyViewer posts job completion to the viewer port", async () => {
  const { notifyViewer } = await import(trackedUrl);
  const received = new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => { res.end("{}"); server.close(); resolve({ url: req.url, body: JSON.parse(body) }); });
    });
    server.listen(0, "127.0.0.1", () => {
      process.env.CODEX_VIEWER_PORT = String(server.address().port);
      notifyViewer({ jobId: "job-1", status: "completed", title: "T", workspaceRoot: "C:\\ws" });
    });
  });
  const { url, body } = await received;
  assert.equal(url, "/notify");
  assert.deepEqual(body, { jobId: "job-1", status: "completed", title: "T", workspaceRoot: "C:\\ws" });
  delete process.env.CODEX_VIEWER_PORT;
});

test("notifyViewer never throws when nothing listens", async () => {
  const { notifyViewer } = await import(trackedUrl);
  process.env.CODEX_VIEWER_PORT = "1"; // nothing listens there
  assert.doesNotThrow(() => notifyViewer({ jobId: "x", status: "failed", title: "", workspaceRoot: "" }));
  delete process.env.CODEX_VIEWER_PORT;
});

test("Codex approval trust requires its current CLI hash and enabled state", async () => {
  const { readViewerIntegrations } = await import(pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "viewer-integrations.mjs")).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-trust-"));
  const root = path.join(__dirname, "..", "plugin");
  const fixture = path.join(dir, "plugin");
  fs.mkdirSync(path.join(fixture, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(fixture, "codex-hooks"));
  fs.writeFileSync(path.join(fixture, ".codex-plugin", "plugin.json"), JSON.stringify({ hooks: "./codex-hooks/hooks.json" }));
  fs.copyFileSync(path.join(root, "codex-hooks", "hooks.json"), path.join(fixture, "codex-hooks", "hooks.json"));
  // Independent fixtures from Codex CLI 0.160.0 hooks/list on Windows.
  const hash = "sha256:17eda7c31d2a60da9969a2f132a235c72c999daf3fe83eb3671bd658b0e72439";
  const config = `[hooks.state."codex@fundryi:codex-hooks/hooks.json:permission_request:0:0"]\ntrusted_hash = "${hash}"`;
  const env = { CODEX_HOME: dir, XDG_CONFIG_HOME: dir };
  try {
    assert.equal(readViewerIntegrations(fixture, env, false).codexHooks.trusted, false);
    // Both platform commands now use the same Codex substitution and hash.
    fs.writeFileSync(path.join(dir, "config.toml"), config);
    assert.equal(readViewerIntegrations(fixture, env, false).codexHooks.trusted, true);
    fs.writeFileSync(path.join(dir, "config.toml"), `developer_instructions = '''\n${config}\n'''`);
    assert.equal(readViewerIntegrations(fixture, env, false).codexHooks.trusted, false, "text inside a multiline string grants no trust");
    fs.writeFileSync(path.join(dir, "config.toml"), `developer_instructions = '''\nIgnore these words\n'''\n${config}`);
    assert.equal(readViewerIntegrations(fixture, env, false).codexHooks.trusted, true);
    assert.equal(readViewerIntegrations(root, env, false).codexHooks.enabled, true, "the final manifest enables only Codex hooks");
    assert.equal(readViewerIntegrations(root, env, false).codexHooks.trusted, true);
    fs.writeFileSync(path.join(dir, "config.toml"), config + '\n[hooks.state."codex@fundryi:codex-hooks/hooks.json:stop:0:0"]\nenabled = false');
    assert.equal(readViewerIntegrations(root, env, false).codexHooks.trusted, true, "an old Stop entry is irrelevant to approval trust");
    for (const invalid of [config + "\nenabled = false", config.replace(hash, "sha256:" + "0".repeat(64)),
      config.replace('trusted_hash = "', '# trusted_hash = "'), config + '\n[hooks.state."codex@fundryi:codex-hooks/hooks.json:permission_request:0:0"]']) {
      fs.writeFileSync(path.join(dir, "config.toml"), invalid);
      assert.equal(readViewerIntegrations(fixture, env, false).codexHooks.trusted, false);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("OpenCode removal refuses a foreign file or a symlink", async () => {
  const { manageOpenCodePlugin, openCodePluginPath } = await import(pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "viewer-integrations.mjs")).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-plugin-"));
  const env = { XDG_CONFIG_HOME: dir };
  const file = openCodePluginPath(env);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'export default { id: "someone-else" };');
    assert.throws(() => manageOpenCodePlugin("", false, env), /Refused/);
    assert.ok(fs.existsSync(file));
    fs.writeFileSync(file, 'export default { id: "ai-live-viewer.notify" };');
    manageOpenCodePlugin("", false, env);
    assert.equal(fs.existsSync(file), false);
    // Junctions need no elevation on Windows and must be refused, too.
    fs.symlinkSync(dir, file, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => manageOpenCodePlugin("", false, env), /Refused/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
