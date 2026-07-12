# Remote Access (LAN + Cloudflare Tunnel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the viewer be reached from the LAN (`--host 0.0.0.0`) and the internet (`--tunnel` via cloudflared), with token auth applied only to tunnel traffic.

**Architecture:** Everything lives in the single zero-dependency file `codex-live-viewer.js`. New pure functions (`parseFlags`, `tunnelAuthDecision`, `parseTunnelUrl`, reworked `trustedControlOrigin`) are unit-tested by regex-extracting their source and running it in a `node:vm` context — the established pattern in `tests/search.test.js`. Tunnel = spawn locally installed `cloudflared`, parse the public URL from its stderr.

**Tech Stack:** Node >= 18 stdlib only (`http`, `crypto`, `child_process`, `os`, `node:test` + `node:vm` for tests). External runtime dependency: `cloudflared` binary on PATH (optional, only for `--tunnel`).

**Spec:** `docs/superpowers/specs/2026-07-12-remote-access-design.md`

## Global Constraints

- Zero npm dependencies — stdlib only.
- Token auth applies ONLY to requests carrying a `cf-connecting-ip` header (tunnel traffic). Localhost and LAN stay tokenless.
- Missing `cloudflared` must never be fatal — print hint, keep serving.
- Windows tray/notify-hook flow (localhost, no token) must keep working unchanged.
- Tests: `node --test tests/*.test.js`, vm-extraction pattern, no server startup in tests.
- Commit style: Conventional Commits, matches repo history (`feat(server): ...`).

---

### Task 1: Flag parsing + LAN binding

**Files:**
- Modify: `codex-live-viewer.js` (constants near line 23, `serve()` near line 659, `doStart()` near line 732, usage text near line 771)
- Test: `tests/remote-access.test.js` (create)

**Interfaces:**
- Produces: module-level `const FLAGS = parseFlags(process.argv.slice(2))` with shape `{ cmd, host, tunnel, tunnelToken, token, flagArgv }`. Later tasks read `FLAGS.tunnel`, `FLAGS.tunnelToken`, `FLAGS.token`. `flagArgv` is the array of consumed flag args (for re-spawning).

- [ ] **Step 1: Write failing tests for `parseFlags`**

Create `tests/remote-access.test.js`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
  assert.deepEqual(f.flagArgv, []);
});

test("parseFlags: cmd plus flags in any order", () => {
  const ctx = extract("parseFlags");
  const f = ctx.parseFlags(["--host", "0.0.0.0", "serve", "--tunnel"]);
  assert.equal(f.cmd, "serve");
  assert.equal(f.host, "0.0.0.0");
  assert.equal(f.tunnel, true);
  assert.deepEqual(f.flagArgv, ["--host", "0.0.0.0", "--tunnel"]);
});

test("parseFlags: --tunnel-token implies tunnel, --token pins auth token", () => {
  const ctx = extract("parseFlags");
  const f = ctx.parseFlags(["start", "--tunnel-token", "eyJhbGc", "--token", "mysecret"]);
  assert.equal(f.cmd, "start");
  assert.equal(f.tunnel, true);
  assert.equal(f.tunnelToken, "eyJhbGc");
  assert.equal(f.token, "mysecret");
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test tests/remote-access.test.js`
Expected: FAIL — `TypeError: ... match ... null` (parseFlags does not exist yet).

- [ ] **Step 3: Implement `parseFlags` + `FLAGS` + host binding**

In `codex-live-viewer.js`, after the `PORT` constant (line 23), add:

```js
function parseFlags(argv) {
  const flags = { cmd: null, host: null, tunnel: false, tunnelToken: null, token: null, flagArgv: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") { flags.host = argv[++i] || null; flags.flagArgv.push(a, flags.host); }
    else if (a === "--tunnel") { flags.tunnel = true; flags.flagArgv.push(a); }
    else if (a === "--tunnel-token") { flags.tunnelToken = argv[++i] || null; flags.tunnel = true; flags.flagArgv.push(a, flags.tunnelToken); }
    else if (a === "--token") { flags.token = argv[++i] || null; flags.flagArgv.push(a, flags.token); }
    else rest.push(a);
  }
  flags.cmd = rest[0] || "serve";
  return flags;
}
const FLAGS = parseFlags(process.argv.slice(2));
const HOST = FLAGS.host || process.env.CODEX_VIEWER_HOST || "127.0.0.1";
```

Replace the bottom CLI dispatch (line 764) `const cmd = process.argv[2] || "serve";` with:

```js
const cmd = FLAGS.cmd;
```

In `serve()`: replace all four `server.listen(PORT, "127.0.0.1")` calls (lines 688, 692, 698, 704) with `server.listen(PORT, HOST)`.

In the `server.on("listening", ...)` callback (line 666), after the existing `console.log("[OK] Codex Live Viewer -> ...")` line, add:

```js
    if (HOST !== "127.0.0.1") {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const iface of list || []) {
          if (iface.family === "IPv4" && !iface.internal) {
            console.log("[OK] LAN -> http://" + iface.address + ":" + PORT);
          }
        }
      }
    }
```

In `doStart()` (line 735), forward flags to the background process:

```js
    spawn(process.execPath, [__filename, "serve", ...FLAGS.flagArgv], { detached: true, stdio: "ignore", windowsHide: true }).unref();
```

In the usage text (lines 771-777), add after the `serve` line:

```js
  console.log("Flags:");
  console.log("  --host <addr>         bind address (default 127.0.0.1; 0.0.0.0 = LAN)");
  console.log("  --tunnel              expose via Cloudflare quick tunnel (needs cloudflared)");
  console.log("  --tunnel-token <t>    named Cloudflare tunnel (custom domain); implies --tunnel");
  console.log("  --token <t>           fixed tunnel access token (default: auto-generated)");
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/remote-access.test.js` — expected: 3 pass.
Run: `node --test tests/*.test.js` — expected: all pass (no regressions).

- [ ] **Step 5: Smoke check**

Run: `node codex-live-viewer.js badcmd` — expected: usage text incl. new Flags section, exit 1.

- [ ] **Step 6: Commit**

```bash
git add codex-live-viewer.js tests/remote-access.test.js
git commit -m "feat(server): --host flag for LAN binding + CLI flag parsing"
```

---

### Task 2: Tunnel token auth

**Files:**
- Modify: `codex-live-viewer.js` (requires near line 15, token helpers after `HOST` const, request handler at line 560)
- Test: `tests/remote-access.test.js`

**Interfaces:**
- Consumes: `FLAGS` from Task 1.
- Produces: `tunnelAuthDecision(headers, rawUrl, token, tunnelActive)` returning `{ allow: boolean, setCookie?: true, redirect?: string }`; module-level `const TOKEN` (string when `FLAGS.tunnel`, else `null`); `loadToken()`.

- [ ] **Step 1: Write failing tests**

Append to `tests/remote-access.test.js`:

```js
const crypto = require("node:crypto");

function authCtx() {
  return extract("tunnelAuthDecision", { crypto, Buffer, URL });
}
const TOK = "aa11bb22cc33dd44ee55ff6677889900";

test("auth: tunnel inactive = open", () => {
  const ctx = authCtx();
  assert.deepEqual(ctx.tunnelAuthDecision({ "cf-connecting-ip": "1.2.3.4" }, "/", null, false), { allow: true });
});

test("auth: no cf-connecting-ip header = open (localhost/LAN)", () => {
  const ctx = authCtx();
  assert.deepEqual(ctx.tunnelAuthDecision({}, "/procs", TOK, true), { allow: true });
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
  assert.deepEqual(ctx.tunnelAuthDecision(headers, "/events", TOK, true), { allow: true });
});

test("auth: wrong cookie = 401", () => {
  const ctx = authCtx();
  const headers = { "cf-connecting-ip": "1.2.3.4", cookie: "clv_token=" + TOK.slice(0, -1) + "X" };
  assert.equal(ctx.tunnelAuthDecision(headers, "/", TOK, true).allow, false);
});
```

- [ ] **Step 2: Run tests, verify new ones fail**

Run: `node --test tests/remote-access.test.js`
Expected: Task 1 tests pass, auth tests FAIL (function missing).

- [ ] **Step 3: Implement**

In `codex-live-viewer.js` line 19 area, add to requires:

```js
const crypto = require("crypto");
```

After the `HOST` constant from Task 1, add:

```js
const TOKEN_FILE = path.join(CODEX_HOME, "live-viewer-token");

function loadToken() {
  if (FLAGS.token) return FLAGS.token;
  if (process.env.CODEX_VIEWER_TOKEN) return process.env.CODEX_VIEWER_TOKEN;
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString("hex");
  try { fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 }); } catch {}
  return t;
}
const TOKEN = FLAGS.tunnel ? loadToken() : null;

// Token auth for tunnel traffic only. cloudflared always sets cf-connecting-ip
// and tunnel visitors cannot strip it; requests without it are local/LAN and trusted.
function tunnelAuthDecision(headers, rawUrl, token, tunnelActive) {
  if (!tunnelActive) return { allow: true };
  if (!headers["cf-connecting-ip"]) return { allow: true };
  if (!token) return { allow: false };
  const eq = t => !!t && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  const u = new URL(rawUrl, "http://local");
  const qtoken = u.searchParams.get("token");
  if (qtoken !== null) {
    if (!eq(qtoken)) return { allow: false };
    u.searchParams.delete("token");
    return { allow: true, setCookie: true, redirect: u.pathname + u.search };
  }
  const m = /(?:^|;\s*)clv_token=([^;]*)/.exec(headers.cookie || "");
  if (m && eq(m[1])) return { allow: true };
  return { allow: false };
}
```

At the very top of the request handler (line 560, first thing inside `http.createServer((req, res) => {`):

```js
  const auth = tunnelAuthDecision(req.headers, req.url, TOKEN, FLAGS.tunnel);
  if (!auth.allow) { res.writeHead(401, { "Content-Type": "text/plain" }); return res.end("token required"); }
  if (auth.setCookie) res.setHeader("Set-Cookie", "clv_token=" + TOKEN + "; HttpOnly; Path=/; SameSite=Lax; Secure");
  if (auth.redirect) { res.writeHead(302, { Location: auth.redirect }); return res.end(); }
```

(`Secure` is safe: cookie only ever set on tunnel traffic, which is always HTTPS.)

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/*.test.js` — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add codex-live-viewer.js tests/remote-access.test.js
git commit -m "feat(server): token auth for tunnel traffic (cf-connecting-ip gated)"
```

---

### Task 3: Same-host origin check

**Files:**
- Modify: `codex-live-viewer.js:654-657` (`trustedControlOrigin`)
- Test: `tests/remote-access.test.js`

**Interfaces:**
- Produces: `trustedControlOrigin(req)` — same name/callers as today, new rule: no `Origin` header, or origin host === request `Host` header.

- [ ] **Step 1: Write failing tests**

Append to `tests/remote-access.test.js`:

```js
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
```

- [ ] **Step 2: Run tests, verify the same-host LAN/tunnel cases fail**

Run: `node --test tests/remote-access.test.js`
Expected: FAIL — current implementation only accepts hardcoded localhost origins.

- [ ] **Step 3: Replace implementation (line 654-657)**

```js
function trustedControlOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/*.test.js` — expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add codex-live-viewer.js tests/remote-access.test.js
git commit -m "fix(server): origin check accepts same-host (LAN/tunnel) instead of hardcoded localhost"
```

---

### Task 4: cloudflared tunnel spawn

**Files:**
- Modify: `codex-live-viewer.js` (after `tunnelAuthDecision`; `serve()` listening callback)
- Test: `tests/remote-access.test.js`

**Interfaces:**
- Consumes: `FLAGS`, `TOKEN`, `PORT`.
- Produces: `parseTunnelUrl(text) -> string|null`; `startTunnel(token)`; `stopTunnel()`.

- [ ] **Step 1: Write failing tests**

Append to `tests/remote-access.test.js`:

```js
test("parseTunnelUrl: finds trycloudflare URL in cloudflared stderr chatter", () => {
  const ctx = extract("parseTunnelUrl");
  const noise = "2026-07-12T10:00:01Z INF +--------+\nINF |  https://witty-fox-example.trycloudflare.com  |\nINF +--------+\n";
  assert.equal(ctx.parseTunnelUrl(noise), "https://witty-fox-example.trycloudflare.com");
  assert.equal(ctx.parseTunnelUrl("no url here"), null);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node --test tests/remote-access.test.js` — expected: FAIL (function missing).

- [ ] **Step 3: Implement**

After `tunnelAuthDecision` in `codex-live-viewer.js`, add:

```js
function parseTunnelUrl(text) {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
  return m ? m[0] : null;
}

let tunnelChild = null;
function startTunnel(token) {
  const args = FLAGS.tunnelToken
    ? ["tunnel", "run", "--token", FLAGS.tunnelToken]
    : ["tunnel", "--url", "http://127.0.0.1:" + PORT];
  tunnelChild = spawn("cloudflared", args, { stdio: ["ignore", "ignore", "pipe"] });
  tunnelChild.on("error", () => {
    tunnelChild = null;
    console.error("[X] cloudflared not found on PATH - tunnel disabled, local serving continues.");
    console.error("    Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  });
  if (FLAGS.tunnelToken) {
    console.log("[OK] Named tunnel starting - open your configured hostname with /?token=" + token);
    return;
  }
  let buf = "";
  let printed = false;
  tunnelChild.stderr.on("data", d => {
    if (printed) return;
    buf += d.toString();
    const url = parseTunnelUrl(buf);
    if (url) { printed = true; console.log("[OK] Tunnel -> " + url + "/?token=" + token); }
  });
}
function stopTunnel() {
  if (!tunnelChild) return;
  try { tunnelChild.kill(); } catch {}
  tunnelChild = null;
}
```

In `serve()`, inside the `server.on("listening", ...)` callback, after the LAN print from Task 1, add:

```js
    if (FLAGS.tunnel) startTunnel(TOKEN);
```

At the end of `serve()` (after `server.listen(PORT, HOST)`), add:

```js
  process.on("exit", stopTunnel);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
```

(Covers Ctrl-C, kill, and `/shutdown`'s `process.exit(0)` — cloudflared child never left orphaned.)

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test tests/*.test.js` — expected: all pass.

- [ ] **Step 5: Manual smoke (no cloudflared needed)**

Run: `node codex-live-viewer.js serve --tunnel` on a machine WITHOUT cloudflared.
Expected: `[X] cloudflared not found on PATH - tunnel disabled, local serving continues.` and viewer still answers `http://localhost:8377/health`. Ctrl-C exits cleanly.

- [ ] **Step 6: Commit**

```bash
git add codex-live-viewer.js tests/remote-access.test.js
git commit -m "feat(server): --tunnel / --tunnel-token cloudflared integration"
```

---

### Task 5: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add "Remote access" section**

After the existing usage/quick-start section in `README.md`, add:

```markdown
## Remote access

By default the viewer only listens on `127.0.0.1`. Three ways to open it up:

### Home LAN

    node codex-live-viewer.js serve --host 0.0.0.0

Open `http://<server-ip>:8377` from any machine on your network. No auth — your LAN is trusted.

### Internet, zero setup (Cloudflare quick tunnel)

Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then:

    node codex-live-viewer.js serve --tunnel

The viewer prints a ready-to-click `https://<random>.trycloudflare.com/?token=...` URL. Free, no Cloudflare account, new URL each start. Tunnel visitors need the token (auto-generated once, stored in `~/.codex/live-viewer-token`); local/LAN access stays tokenless.

### Internet, custom domain (named tunnel)

Create a named tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/) pointing at `http://localhost:8377`, copy its token, then:

    node codex-live-viewer.js serve --tunnel-token <TUNNEL_TOKEN>

Stable URL on your own domain. Access token works the same as above.

Pin a fixed access token with `--token <secret>` or `CODEX_VIEWER_TOKEN` instead of the auto-generated one.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: remote access (LAN + cloudflare tunnel)"
```

---

## Final verification

- `node --test tests/*.test.js` — everything green.
- Manual on Linux server: `serve --host 0.0.0.0` reachable from main PC; `serve --tunnel` end-to-end through trycloudflare URL, SSE live updates flowing, wrong token gets 401.
