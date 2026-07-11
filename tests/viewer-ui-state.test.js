const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const navigationFunctions = script.match(
  /function filterIncludes[\s\S]*?(?=\n    function renderList)/,
)[0];

function navigation(overrides = {}) {
  const context = {
    prefs: { filter: "ACTIVE", autoFollow: true },
    selected: "selected",
    currentSession: () => ({ id: "selected", status: "LIVE" }),
    savePrefs() {},
    applyPrefs() {},
    renderFilters() {},
    renderList() {},
    selectSession(id) { context.selected = id; },
    ...overrides,
  };
  vm.runInNewContext(navigationFunctions, context);
  return context;
}

test("manual status filters pause automatic following", () => {
  const context = navigation();

  context.chooseFilter("DONE");

  assert.equal(context.prefs.filter, "DONE");
  assert.equal(context.prefs.autoFollow, false);
});

test("a filter only follows an actual selected-session status change", () => {
  const context = navigation();
  context.prefs.filter = "DONE";

  context.followSelectedStatus("LIVE");
  assert.equal(context.prefs.filter, "DONE");

  context.prefs.filter = "LIVE";
  context.currentSession = () => ({ id: "selected", status: "IDLE" });
  context.followSelectedStatus("LIVE");
  assert.equal(context.prefs.filter, "IDLE");
});

test("Follow newest deliberately returns to the running view", () => {
  const context = navigation();
  context.prefs.filter = "DONE";
  context.prefs.autoFollow = false;

  context.followRunningSession({ id: "running", status: "LIVE" });
  assert.equal(context.prefs.filter, "DONE");
  assert.equal(context.selected, "selected");

  context.prefs.autoFollow = true;
  context.followRunningSession({ id: "running", status: "LIVE" });
  assert.equal(context.prefs.filter, "LIVE");
  assert.equal(context.selected, "running");
});
