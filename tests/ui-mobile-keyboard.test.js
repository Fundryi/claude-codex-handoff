const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const slice = script.match(/function firstLine[\s\S]*?function setConnection[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }

test("rovingFocusIndex moves and wraps with ArrowRight/ArrowLeft", () => {
  const { rovingFocusIndex } = ctx();
  assert.equal(rovingFocusIndex(0, 3, "ArrowRight"), 1);
  assert.equal(rovingFocusIndex(2, 3, "ArrowRight"), 0); // wraps forward
  assert.equal(rovingFocusIndex(0, 3, "ArrowLeft"), 2); // wraps backward
  assert.equal(rovingFocusIndex(1, 3, "ArrowLeft"), 0);
});

test("rovingFocusIndex handles Home, End, unknown keys and empty rows", () => {
  const { rovingFocusIndex } = ctx();
  assert.equal(rovingFocusIndex(2, 5, "Home"), 0);
  assert.equal(rovingFocusIndex(2, 5, "End"), 4);
  assert.equal(rovingFocusIndex(2, 5, "Enter"), 2); // unrelated key is a no-op
  assert.equal(rovingFocusIndex(0, 0, "ArrowRight"), 0); // no items, nothing to move to
});

test("isEditableElement flags inputs, textareas, selects and contenteditable", () => {
  const { isEditableElement } = ctx();
  assert.equal(isEditableElement(null), false);
  assert.equal(isEditableElement({ tagName: "INPUT" }), true);
  assert.equal(isEditableElement({ tagName: "TEXTAREA" }), true);
  assert.equal(isEditableElement({ tagName: "SELECT" }), true);
  assert.equal(isEditableElement({ tagName: "DIV" }), false);
  assert.equal(isEditableElement({ tagName: "DIV", isContentEditable: true }), true);
});
