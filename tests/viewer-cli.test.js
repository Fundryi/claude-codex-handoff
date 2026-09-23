const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// End to end: the real viewer CLI against a fake "running viewer" on a spare port.
// This is what /codex:viewer runs: `start "<argument>"`.
const SCRIPT = path.join(__dirname, "..", "codex-live-viewer.js");
const VERSION = require("../package.json").version;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "clv-cli-"));
fs.mkdirSync(path.join(home, "sessions")); // serve refuses to run without it

function cli(port, ...args) {
  const env = { ...process.env, CODEX_VIEWER_PORT: String(port), CODEX_HOME: home, CODEX_COMPANION_STATE_ROOT: path.join(home, "state") };
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args, "--no-open"], { env, timeout: 20000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, out: stdout + stderr });
    });
  });
}

// A fake viewer that reports `version` and shuts down on POST /shutdown, as the real one does.
// slowMs delays /health past the CLI's 1 s wait, like a viewer that is still loading.
function fakeViewer(version, slowMs = 0) {
  return new Promise((resolve) => {
    const fake = { shutdowns: 0 };
    fake.server = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.setHeader("Content-Type", "application/json");
        const answer = () => res.end(JSON.stringify({ application: "codex-live-viewer", version }));
        return slowMs ? setTimeout(answer, slowMs) : answer();
      }
      if (req.method === "POST" && req.url === "/shutdown") {
        fake.shutdowns += 1;
        res.end("{}");
        fake.server.close();
        fake.server.closeAllConnections();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    fake.server.listen(0, "127.0.0.1", () => resolve(fake));
  });
}

test("start replaces an older viewer; status shows the version; stop confirms it is down", async () => {
  const fake = await fakeViewer("1.0.0");
  const port = fake.server.address().port;
  try {
    // An empty argument (plain /codex:viewer) is a start, never the foreground serve.
    const started = await cli(port, "start", "");
    assert.equal(started.code, 0, started.out);
    assert.match(started.out, /Replacing viewer 1\.0\.0 with /);
    assert.equal(fake.shutdowns, 1);
    // Overlapping health checks once printed this line up to four times.
    assert.equal(started.out.match(/running -> /g).length, 1, started.out);

    // The running viewer records its pid so kill can find it even when hung.
    assert.equal(alive(Number(fs.readFileSync(pidFile(port), "utf8"))), true);

    const status = await cli(port, "start", "status");
    assert.match(status.out, new RegExp("running " + VERSION.replace(/\./g, "\\.") + " -> "));

    const stopped = await cli(port, "start", "stop");
    assert.equal(stopped.code, 0, stopped.out);
    assert.match(stopped.out, /Viewer stopped/);
    assert.doesNotMatch(stopped.out, /still answers/);
    assert.match((await cli(port, "status")).out, /not running/);
    assert.equal(fs.existsSync(pidFile(port)), false, "a clean stop removes the pid record");
  } finally {
    await cli(port, "stop");
    fake.server.close();
  }
});

test("start leaves a newer viewer alone; restart replaces it anyway", async () => {
  const fake = await fakeViewer("99.0.0");
  const port = fake.server.address().port;
  try {
    const started = await cli(port, "start");
    assert.match(started.out, /already running/);
    assert.equal(fake.shutdowns, 0);

    const restarted = await cli(port, "start", "Restart");
    assert.equal(restarted.code, 0, restarted.out);
    assert.match(restarted.out, /Restarting viewer/);
    assert.equal(fake.shutdowns, 1);
    assert.match((await cli(port, "status")).out, new RegExp("running " + VERSION.replace(/\./g, "\\.")));
  } finally {
    await cli(port, "stop");
    fake.server.close();
  }
});

test("a viewer too slow to answer is reported busy, never replaced or stopped", async () => {
  const fake = await fakeViewer("1.0.0", 1500);
  const port = fake.server.address().port;
  try {
    for (const action of ["status", "", "restart", "stop"]) {
      const run = await cli(port, "start", action);
      assert.match(run.out, /not answering/, action + ": " + run.out);
      assert.equal(run.code, 1, action);
    }
    assert.equal(fake.shutdowns, 0);
  } finally {
    fake.server.close();
    fake.server.closeAllConnections();
  }
});

function pidFile(port) {
  return path.join(os.tmpdir(), "codex-live-viewer-" + port + ".pid");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("kill force-quits a hung viewer, and never a process a stale record points at", async () => {
  const { spawn } = require("node:child_process");
  const port = await freePort();
  // A "viewer" that holds the port but never answers: its path names codex-live-viewer,
  // like the real one, so kill accepts it.
  const script = path.join(home, "codex-live-viewer-hung.js");
  fs.writeFileSync(script, `require("http").createServer(() => {}).listen(${port}, "127.0.0.1");`);
  const hung = spawn(process.execPath, [script], { stdio: "ignore" });
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && !(await new Promise((r) => http.get(`http://127.0.0.1:${port}/`).on("error", () => r(false)).setTimeout(100, () => r(true)))); i++);
    fs.writeFileSync(pidFile(port), String(hung.pid));
    assert.match((await cli(port, "start", "stop")).out, /not answering.*kill/);

    const killed = await cli(port, "start", "kill");
    assert.equal(killed.code, 0, killed.out);
    assert.ok(killed.out.includes("Viewer killed (pid " + hung.pid + ")"), killed.out);
    assert.equal(alive(hung.pid), false);
    assert.equal(fs.existsSync(pidFile(port)), false);
    assert.match((await cli(port, "status")).out, /not running/);

    // A recycled pid that belongs to something else is left alone.
    fs.writeFileSync(pidFile(port), String(other.pid));
    assert.match((await cli(port, "kill")).out, /not a viewer/);
    assert.equal(alive(other.pid), true);
    assert.match((await cli(port, "kill")).out, /No viewer process recorded/);
  } finally {
    for (const child of [hung, other]) try { child.kill("SIGKILL"); } catch {}
    try { fs.unlinkSync(pidFile(port)); } catch {}
  }
});
