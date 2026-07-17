const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const stateUrl = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "state.mjs")).href;

test("state root defaults to ~/.codex-companion/state", async () => {
  delete process.env.CODEX_COMPANION_STATE_ROOT;
  const state = await import(stateUrl + "?t=1");
  assert.equal(state.resolveStateRoot(), path.join(os.homedir(), ".codex-companion", "state"));
});

test("CODEX_COMPANION_STATE_ROOT overrides the state root", async () => {
  process.env.CODEX_COMPANION_STATE_ROOT = path.join(os.tmpdir(), "clv-test-root");
  const state = await import(stateUrl + "?t=2");
  assert.equal(state.resolveStateRoot(), path.join(os.tmpdir(), "clv-test-root"));
  const dir = state.resolveStateDir(process.cwd());
  assert.ok(dir.startsWith(path.join(os.tmpdir(), "clv-test-root")), dir);
  assert.match(path.basename(dir), /^[A-Za-z0-9._-]+-[0-9a-f]{16}$/);
  delete process.env.CODEX_COMPANION_STATE_ROOT;
});
