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

function originCtx() { return extract("trustedControlOrigin", { URL }); }

test("origin: absent = trusted", () => {
  assert.equal(originCtx().trustedControlOrigin({ headers: {} }), true);
});

test("origin: same host as request = trusted (localhost, LAN, tunnel)", () => {
  const ctx = originCtx();
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "http://localhost:8377", host: "localhost:8377" } }), true);
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "http://10.0.0.5:8377", host: "10.0.0.5:8377" } }), true);
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "https://x.trycloudflare.com", host: "x.trycloudflare.com" } }), true);
});

test("origin: foreign host = untrusted", () => {
  const ctx = originCtx();
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "https://evil.example", host: "localhost:8377" } }), false);
  assert.equal(ctx.trustedControlOrigin({ headers: { origin: "not a url", host: "localhost:8377" } }), false);
});

test("parseTunnelUrl: finds trycloudflare URL in cloudflared stderr chatter", () => {
  const ctx = extract("parseTunnelUrl");
  const noise = "2026-07-12T10:00:01Z INF +--------+\nINF |  https://witty-fox-example.trycloudflare.com  |\nINF +--------+\n";
  assert.equal(ctx.parseTunnelUrl(noise), "https://witty-fox-example.trycloudflare.com");
  assert.equal(ctx.parseTunnelUrl("no url here"), null);
});
