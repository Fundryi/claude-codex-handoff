const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// The header FAST chip follows row.fast (the newest job on the thread); tests/ui-rows.test.js covers that.
const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");

test("global [hidden] rule forces display:none with !important", () => {
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
