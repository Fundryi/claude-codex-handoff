const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const mjs = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "update-check.mjs")).href;

test("compareVersions orders semver triples", async () => {
  const { compareVersions } = await import(mjs);
  assert.equal(compareVersions("2.2.0", "2.3.0"), -1);
  assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
  assert.equal(compareVersions("2.2.0", "2.2.0"), 0);
  assert.equal(compareVersions("garbage", "2.2.0"), 0); // unparsable -> treated equal (no notice)
});

test("buildUpdateNotice formats the exact message, or null when up to date", async () => {
  const { buildUpdateNotice } = await import(mjs);
  assert.equal(
    buildUpdateNotice("2.2.0", "2.3.0"),
    "[codex plugin] Update available: 2.2.0 -> 2.3.0. Update with: /plugin marketplace update fundryi  (then restart the Claude Code session)"
  );
  assert.equal(buildUpdateNotice("2.3.0", "2.3.0"), null);
  assert.equal(buildUpdateNotice("2.3.0", "2.2.0"), null);
  assert.equal(buildUpdateNotice("2.2.0", null), null);
});

test("cacheIsFresh respects the 24h window", async () => {
  const { cacheIsFresh } = await import(mjs);
  const now = 1_700_000_000_000;
  assert.equal(cacheIsFresh({ checkedAt: now - 1000 }, now), true);
  assert.equal(cacheIsFresh({ checkedAt: now - 25 * 3600 * 1000 }, now), false);
  assert.equal(cacheIsFresh(null, now), false);
  assert.equal(cacheIsFresh({}, now), false);
});

test("checkForUpdate uses a fresh cache without fetching and is silent when disabled", async () => {
  const { checkForUpdate } = await import(mjs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-upd-"));
  const cacheFile = path.join(dir, "update-check.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), latestVersion: "9.9.9" }));
  const notice = await checkForUpdate({ currentVersion: "2.2.0", cacheFile, fetcher: async () => { throw new Error("must not fetch"); } });
  assert.match(notice, /2\.2\.0 -> 9\.9\.9/);
  const disabled = await checkForUpdate({ currentVersion: "2.2.0", cacheFile, env: { CODEX_PLUGIN_UPDATE_CHECK: "0" } });
  assert.equal(disabled, null);
});

test("sessionUpdateNotice reads version from plugin root and uses the state-root cache file", async () => {
  const hook = await import(pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "session-lifecycle-hook.mjs")).href);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clv-upd2-"));
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.0.0" }));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clv-upd3-"));
  fs.writeFileSync(path.join(stateRoot, "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latestVersion: "1.1.0" }));
  const notice = await hook.sessionUpdateNotice({ CLAUDE_PLUGIN_ROOT: dir, CODEX_COMPANION_STATE_ROOT: stateRoot });
  assert.match(notice, /1\.0\.0 -> 1\.1\.0/);
});
