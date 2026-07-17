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
