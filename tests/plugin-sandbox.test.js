const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const codexUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "codex.mjs")).href;

test("sandbox defaults to danger-full-access and honors CODEX_PLUGIN_SANDBOX", async () => {
  const { companionSandbox } = await import(codexUrl);
  delete process.env.CODEX_PLUGIN_SANDBOX;
  assert.equal(companionSandbox(), "danger-full-access");
  process.env.CODEX_PLUGIN_SANDBOX = "workspace-write";
  assert.equal(companionSandbox(), "workspace-write");
  delete process.env.CODEX_PLUGIN_SANDBOX;
});

test("no hardcoded sandbox literals remain on run paths", () => {
  const fs = require("node:fs");
  const companion = fs.readFileSync(path.join(__dirname, "..", "plugin", "scripts", "codex-companion.mjs"), "utf8");
  assert.ok(!companion.includes('sandbox: "danger-full-access"'), "companion should call companionSandbox()");
  assert.ok(!companion.includes('sandbox: "read-only"'));
});
