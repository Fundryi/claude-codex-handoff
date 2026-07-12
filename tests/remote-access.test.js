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
