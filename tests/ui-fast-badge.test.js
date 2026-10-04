const assert = require("node:assert/strict");
const { uiSource } = require("./helpers/source");
const test = require("node:test");

// The header FAST chip follows row.fast (the newest job on the thread); tests/ui-rows.test.js covers that.
const html = uiSource();

test("global [hidden] rule forces display:none with !important", () => {
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});
