const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const mjs = (rel) => pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", rel)).href;

test("buildAppServerArgs injects -c overrides", async () => {
  const { buildAppServerArgs } = await import(mjs("app-server.mjs"));
  assert.deepEqual(buildAppServerArgs(), ["app-server"]);
  assert.deepEqual(buildAppServerArgs(["service_tier=priority"]), ["app-server", "-c", "service_tier=priority"]);
  assert.deepEqual(buildAppServerArgs(["a=1", "b=2"]), ["app-server", "-c", "a=1", "-c", "b=2"]);
});

test("fastTier defaults to priority, env-overridable", async () => {
  const { fastTier } = await import(mjs("codex.mjs"));
  delete process.env.CODEX_PLUGIN_FAST_TIER;
  assert.equal(fastTier(), "priority");
  process.env.CODEX_PLUGIN_FAST_TIER = "flex";
  assert.equal(fastTier(), "flex");
  delete process.env.CODEX_PLUGIN_FAST_TIER;
});

test("fastConnectOptions builds broker-bypassing overrides", async () => {
  const { fastConnectOptions } = await import(mjs("codex.mjs"));
  assert.deepEqual(fastConnectOptions(false), {});
  assert.deepEqual(fastConnectOptions(true), { disableBroker: true, configOverrides: ["service_tier=priority"] });
});
