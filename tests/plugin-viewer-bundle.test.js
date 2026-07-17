const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

for (const f of ["codex-live-viewer.js", "viewer-ui.html"]) {
  test(`plugin/viewer/${f} is byte-identical to the repo copy (run: npm run sync:viewer)`, () => {
    const root = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const bundled = fs.readFileSync(path.join(__dirname, "..", "plugin", "viewer", f), "utf8");
    assert.equal(bundled, root);
  });
}
