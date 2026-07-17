const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const trackedUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "tracked-jobs.mjs")).href;

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
