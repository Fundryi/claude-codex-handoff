const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const crypto = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");

function extract(name, context = {}) {
  const src = source.match(new RegExp("function " + name + "[\\s\\S]*?\\n}"))[0];
  vm.runInNewContext(src, context);
  return context;
}

test("parseFlags: defaults", () => {
  const ctx = extract("parseFlags");
  const f = ctx.parseFlags([]);
  assert.equal(f.cmd, "serve");
  assert.equal(f.host, null);
  assert.equal(f.tunnel, false);
  assert.equal(f.tunnelToken, null);
  assert.equal(f.token, null);
  assert.deepEqual(Array.from(f.flagArgv), []);
});

test("parseFlags: cmd plus flags in any order", () => {
  const ctx = extract("parseFlags");
  const f = ctx.parseFlags(["--host", "0.0.0.0", "serve", "--tunnel"]);
  assert.equal(f.cmd, "serve");
  assert.equal(f.host, "0.0.0.0");
  assert.equal(f.tunnel, true);
  assert.deepEqual(Array.from(f.flagArgv), ["--host", "0.0.0.0", "--tunnel"]);
});

test("parseFlags: --tunnel-token implies tunnel, --token pins auth token", () => {
  const ctx = extract("parseFlags");
  const f = ctx.parseFlags(["start", "--tunnel-token", "eyJhbGc", "--token", "mysecret"]);
  assert.equal(f.cmd, "start");
  assert.equal(f.tunnel, true);
  assert.equal(f.tunnelToken, "eyJhbGc");
  assert.equal(f.token, "mysecret");
});

function authCtx() {
  return extract("tunnelAuthDecision", { crypto, Buffer, URL });
}
const TOK = "aa11bb22cc33dd44ee55ff6677889900";

test("auth: tunnel inactive = open", () => {
  const ctx = authCtx();
  assert.deepEqual({ ...ctx.tunnelAuthDecision({ "cf-connecting-ip": "1.2.3.4" }, "/", null, false) }, { allow: true });
});

test("auth: no cf-connecting-ip header = open (localhost/LAN)", () => {
  const ctx = authCtx();
  assert.deepEqual({ ...ctx.tunnelAuthDecision({}, "/procs", TOK, true) }, { allow: true });
});

test("auth: tunnel request without token = 401", () => {
  const ctx = authCtx();
  assert.equal(ctx.tunnelAuthDecision({ "cf-connecting-ip": "1.2.3.4" }, "/", TOK, true).allow, false);
});

test("auth: valid ?token= sets cookie and redirects to clean URL", () => {
  const ctx = authCtx();
  const d = ctx.tunnelAuthDecision({ "cf-connecting-ip": "1.2.3.4" }, "/?token=" + TOK, TOK, true);
  assert.equal(d.allow, true);
  assert.equal(d.setCookie, true);
  assert.equal(d.redirect, "/");
});

test("auth: wrong ?token= = 401", () => {
  const ctx = authCtx();
  assert.equal(ctx.tunnelAuthDecision({ "cf-connecting-ip": "1.2.3.4" }, "/?token=wrong", TOK, true).allow, false);
});

test("auth: valid cookie = open, no redirect", () => {
  const ctx = authCtx();
  const headers = { "cf-connecting-ip": "1.2.3.4", cookie: "other=1; clv_token=" + TOK };
  assert.deepEqual({ ...ctx.tunnelAuthDecision(headers, "/events", TOK, true) }, { allow: true });
});

test("auth: wrong cookie = 401", () => {
  const ctx = authCtx();
  const headers = { "cf-connecting-ip": "1.2.3.4", cookie: "clv_token=" + TOK.slice(0, -1) + "X" };
  assert.equal(ctx.tunnelAuthDecision(headers, "/", TOK, true).allow, false);
});

function originCtx(opts = {}) {
  const hosts = new Set(opts.hosts || ["localhost:8377", "127.0.0.1:8377", "10.0.0.5:8377"]);
  return extract("trustedControlOrigin", {
    URL,
    FLAGS: { tunnel: opts.tunnel || false },
    controlHosts: () => hosts,
  });
}

test("origin: absent origin on known host = trusted", () => {
  assert.equal(originCtx().trustedControlOrigin({ headers: { host: "localhost:8377" } }), true);
});

test("origin: known host + matching origin = trusted (localhost, LAN)", () => {
  const ctx = originCtx();
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "http://localhost:8377", host: "localhost:8377" } }), true);
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "http://10.0.0.5:8377", host: "10.0.0.5:8377" } }), true);
});

test("origin: DNS-rebound Host = untrusted even without Origin", () => {
  const ctx = originCtx();
  assert.equal(ctx.trustedControlOrigin({ headers: { host: "rebind.attacker.com" } }), false);
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "http://rebind.attacker.com", host: "rebind.attacker.com" } }), false);
});

test("origin: foreign or malformed Origin on known host = untrusted", () => {
  const ctx = originCtx();
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "https://evil.example", host: "localhost:8377" } }), false);
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "not a url", host: "localhost:8377" } }), false);
});

test("origin: tunnel-proxied request keeps same-host rule (domain unknown to server)", () => {
  const ctx = originCtx({ tunnel: true });
  const h = { "cf-connecting-ip": "1.2.3.4", origin: "https://x.trycloudflare.com", host: "x.trycloudflare.com" };
  assert.equal(ctx.trustedControlOrigin({ headers: h }), true);
  assert.equal(ctx.trustedControlOrigin({ headers: { ...h, origin: "https://evil.example" } }), false);
});

test("origin: forged cf-connecting-ip without --tunnel does not bypass allowlist", () => {
  const ctx = originCtx({ tunnel: false });
  const h = { "cf-connecting-ip": "1.2.3.4", origin: "http://rebind.attacker.com", host: "rebind.attacker.com" };
  assert.equal(ctx.trustedControlOrigin({ headers: h }), false);
});

test("controlHosts: loopback always, LAN interfaces only when bound beyond loopback", () => {
  const os = { networkInterfaces: () => ({ eth0: [{ family: "IPv4", address: "10.0.0.5", internal: false }] }) };
  const process = { env: {} };
  const lan = extract("controlHosts", { os, process, PORT: 8377, HOST: "0.0.0.0" }).controlHosts();
  assert.equal(lan.has("localhost:8377"), true);
  assert.equal(lan.has("127.0.0.1:8377"), true);
  assert.equal(lan.has("10.0.0.5:8377"), true);
  const loop = extract("controlHosts", { os, process, PORT: 8377, HOST: "127.0.0.1" }).controlHosts();
  assert.equal(loop.has("10.0.0.5:8377"), false);
});

test("controlHosts: CODEX_VIEWER_ALLOWED_HOSTS adds proxy names as the browser sends them", () => {
  const os = { networkInterfaces: () => ({}) };
  const process = { env: { CODEX_VIEWER_ALLOWED_HOSTS: " Viewer.Example.com , https://b.example/, c.example:8443,," } };
  const hosts = extract("controlHosts", { os, process, URL, PORT: 8377, HOST: "127.0.0.1" }).controlHosts();
  assert.equal(hosts.has("viewer.example.com"), true);
  assert.equal(hosts.has("b.example"), true);
  assert.equal(hosts.has("c.example:8443"), true);
  assert.equal(hosts.has(""), false);
  const ctx = originCtx({ hosts: [...hosts] });
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "https://viewer.example.com", host: "viewer.example.com" } }), true);
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "https://evil.example", host: "viewer.example.com" } }), false);
});

test("parseTunnelUrl: finds trycloudflare URL in cloudflared stderr chatter", () => {
  const ctx = extract("parseTunnelUrl");
  const noise = "2026-07-12T10:00:01Z INF +--------+\nINF |  https://witty-fox-example.trycloudflare.com  |\nINF +--------+\n";
  assert.equal(ctx.parseTunnelUrl(noise), "https://witty-fox-example.trycloudflare.com");
  assert.equal(ctx.parseTunnelUrl("no url here"), null);
});

function transcriptCtx(opts = {}) {
  const ctx = { PORT: 8377, PROXY_DECLARED: opts.proxy || false, FLAGS: { tunnel: opts.tunnel || false }, trustedControlOrigin: () => opts.originOk !== false };
  extract("loopbackDirect", ctx);
  return extract("claudeTranscriptAllowed", ctx);
}
const fakeReq = (headers, remoteAddress = "127.0.0.1") => ({ headers: { host: "127.0.0.1:8377", ...headers }, socket: { remoteAddress } });

test("loopbackDirect: loopback socket and loopback Host, no proxy headers", () => {
  const ctx = transcriptCtx();
  assert.equal(ctx.loopbackDirect(fakeReq({})), true);
  assert.equal(ctx.loopbackDirect(fakeReq({ host: "localhost:8377" }, "::1")), true);
  assert.equal(ctx.loopbackDirect(fakeReq({ host: "[::1]:8377" }, "::ffff:127.0.0.1")), true);
  for (const h of ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip"]) {
    assert.equal(ctx.loopbackDirect(fakeReq({ [h]: "1.2.3.4" })), false, h);
  }
  assert.equal(ctx.loopbackDirect(fakeReq({}, "10.0.0.5")), false, "LAN address");
  assert.equal(ctx.loopbackDirect(fakeReq({ host: "rebind.attacker.com" })), false, "DNS-rebound Host");
  assert.equal(ctx.loopbackDirect(fakeReq({ host: "127.0.0.1:9999" })), false, "other port");
});

test("claudeTranscriptAllowed: this PC's browser or the tunnel link only", () => {
  assert.equal(transcriptCtx().claudeTranscriptAllowed(fakeReq({})), true);
  assert.equal(transcriptCtx({ originOk: false }).claudeTranscriptAllowed(fakeReq({})), false, "loopback but foreign origin");
  assert.equal(transcriptCtx().claudeTranscriptAllowed(fakeReq({ "x-forwarded-for": "1.2.3.4" })), false, "local proxy");
  assert.equal(transcriptCtx().claudeTranscriptAllowed(fakeReq({ "cf-connecting-ip": "1.2.3.4" })), false, "forged tunnel header, tunnel off");
  const tunnel = fakeReq({ host: "x.trycloudflare.com", "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4" });
  assert.equal(transcriptCtx({ tunnel: true }).claudeTranscriptAllowed(tunnel), true, "tunnel (token already checked)");
  assert.equal(transcriptCtx({ tunnel: true, originOk: false }).claudeTranscriptAllowed(tunnel), false, "tunnel, origin refused");
  assert.equal(transcriptCtx({ proxy: true }).claudeTranscriptAllowed(fakeReq({})), false, "declared proxy, nginx-default headers");
  assert.equal(transcriptCtx({ proxy: true, tunnel: true }).claudeTranscriptAllowed(tunnel), true, "declared proxy, tunnel still works");
});

// The guards above are only predicates; this checks they are wired into the real
// request handler. A spawned viewer must refuse a wrong method or a foreign origin
// on every state-changing route, and keep running after a refused /shutdown.
test("serve: control routes refuse GET and foreign origins, with no side effects", async () => {
  const http = require("node:http");
  const net = require("node:net");
  const os = require("node:os");
  const { spawn } = require("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clv-guard-"));
  fs.mkdirSync(path.join(home, "sessions"));
  const stateRoot = path.join(home, "state");
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  // One fake Claude workflow run (real 2.1.284 line shapes), written before the viewer starts.
  const runDir = path.join(home, "claude", "projects", "p", "s1", "subagents", "workflows", "wf_test-001");
  fs.mkdirSync(runDir, { recursive: true });
  const scripts = path.join(home, "claude", "projects", "p", "s1", "workflows", "scripts"); // saved at launch
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, "scout-wf_test-001.js"), "export const meta = {\n  name: 'scout',\n  phases: [{ title: 'Scout' }],\n}\n");
  fs.writeFileSync(path.join(runDir, "journal.jsonl"), '{"type":"launched"}\n{"type":"started","key":"v2:t","agentId":"a0123456789abcdef","label":"scout","phase":"Scout"}\n');
  const line = (o) => JSON.stringify({ isSidechain: true, agentId: "a0123456789abcdef", timestamp: new Date().toISOString(), cwd: home, sessionId: "s1", ...o }) + "\n";
  fs.writeFileSync(path.join(runDir, "agent-a0123456789abcdef.jsonl"),
    line({ type: "user", message: { role: "user", content: "[Workflow harness] scout" } }) +
    line({ type: "attachment", attachment: { type: "hook_success" } }) +
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "found it" }], usage: { input_tokens: 5 } } }));
  const env = { ...process.env, CODEX_VIEWER_PORT: String(port), CODEX_HOME: home, CODEX_COMPANION_STATE_ROOT: stateRoot, CLAUDE_CONFIG_DIR: path.join(home, "claude") };
  delete env.CODEX_VIEWER_ALLOWED_HOSTS; // the owner's own settings must not widen the bind
  delete env.CODEX_VIEWER_HOST;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "codex-live-viewer.js"), "serve", "--no-open"], { env, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const call = (method, url, headers = {}, body) => new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    req.end(body);
  });
  const getJson = (url) => new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: url }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; });
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    }).on("error", () => resolve({ status: 0, body: null }));
  });
  try {
    let up = 0;
    for (let i = 0; i < 50 && up !== 200; i++) {
      up = await call("GET", "/health");
      if (up !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(up, 200, "viewer did not start");

    const trusted = { Origin: "http://127.0.0.1:" + port, "Content-Type": "application/json" };
    const evil = { Origin: "https://evil.example", "Content-Type": "application/json" };
    const valid = JSON.stringify({ jobId: "job-x", threadId: "thread-x", cwd: home });
    const routes = ["/cancel", "/resume", "/open?id=x"];
    if (process.platform === "win32") routes.push("/kill?pid=1"); // other platforms answer 501 before any guard
    for (const route of routes) {
      assert.equal(await call("GET", route), 405, "GET " + route);
      assert.equal(await call("POST", route, evil, valid), 403, "foreign origin " + route);
    }
    assert.equal(await call("POST", "/cancel", { ...trusted, Host: "rebind.attacker.com" }, valid), 403, "rebound Host");
    // The guard does not just refuse everything: a trusted caller reaches validation.
    assert.equal(await call("POST", "/cancel", trusted, "{}"), 400);
    assert.equal(await call("POST", "/resume", trusted, "{}"), 400);
    assert.equal(await call("POST", "/open?id=x", trusted), 404);

    // Claude transcripts: loopback-direct only. The gate must not just refuse everything.
    const agentUrl = "/claude/agent?run=wf_test-001&agent=a0123456789abcdef";
    let page = { status: 0 };
    for (let i = 0; i < 20 && page.status !== 200; i++) {
      page = await getJson(agentUrl);
      if (page.status !== 200) await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(page.status, 200, "plain loopback request");
    assert.deepEqual(page.body.events.map((e) => e.kind), ["user", "agent"]);
    assert.equal(await call("GET", agentUrl, { "X-Forwarded-For": "1.2.3.4" }), 403);
    assert.equal(await call("GET", agentUrl, { Forwarded: "for=1.2.3.4" }), 403);
    assert.equal(await call("GET", agentUrl, { Host: "rebind.attacker.com" }), 403);
    assert.equal(await call("GET", "/claude/agent?run=wf_nope-000&agent=a0123456789abcdef"), 404);
    assert.equal(await call("GET", "/claude/agent?run=wf_test-001&agent=../../x"), 404);
    assert.equal(await call("GET", "/claude/run?run=wf_test-001", { "X-Forwarded-For": "1.2.3.4" }), 403);
    assert.equal(await call("GET", "/claude/run?run=wf_test-001"), 200);

    // /notify: only the companion's own request (loopback, no Origin, no proxy headers).
    const job = JSON.stringify({ jobId: "j" });
    assert.equal(await call("POST", "/notify", { "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4" }, job), 403);
    assert.equal(await call("POST", "/notify", { "Content-Type": "application/json", Origin: "https://evil.example" }, job), 403);
    assert.equal(await call("POST", "/notify", { "Content-Type": "application/json" }, job), 200);

    assert.equal(await call("GET", "/shutdown"), 405);
    assert.equal(await call("POST", "/shutdown", evil), 403);
    assert.equal(await call("GET", "/health"), 200, "a refused /shutdown must not stop the viewer");

    assert.equal(await call("POST", "/shutdown", trusted), 200);
    await exited;
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), "codex-live-viewer-" + port + ".pid"), { force: true });
  }
});
