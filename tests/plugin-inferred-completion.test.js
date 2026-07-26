const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const libDir = path.join(__dirname, "..", "plugin", "scripts", "lib");
const href = (name) => pathToFileURL(path.join(libDir, name)).href;

function fakeState(overrides = {}) {
  let resolved = null;
  const state = {
    completed: false,
    finalTurn: null,
    finalAnswerSeen: true,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    turnId: "turn-1",
    onProgress: null,
    resolveCompletion: (s) => { resolved = s; },
    ...overrides
  };
  return { state, wasResolved: () => resolved !== null };
}

test("inferred completion waits well past 250ms so the real turn/completed can win", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return (async () => {
    const { scheduleInferredCompletion } = await import(href("codex.mjs"));
    const { state, wasResolved } = fakeState();

    scheduleInferredCompletion(state);

    // A real turn/completed typically lands within a few seconds of the final
    // answer; inferring at 250ms aborted turns that were about to complete.
    t.mock.timers.tick(3000);
    assert.equal(wasResolved(), false, "inferred completion fired inside the grace window");

    t.mock.timers.tick(10000);
    assert.equal(wasResolved(), true, "inferred completion never fired after the grace window");
    assert.equal(state.finalTurn.status, "completed");
  })();
});

test("a real completion inside the grace window cancels the inferred timer", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return (async () => {
    const { scheduleInferredCompletion, completeTurn } = await import(href("codex.mjs"));
    const { state } = fakeState();

    scheduleInferredCompletion(state);
    completeTurn(state, { id: "turn-1", status: "completed" });
    assert.equal(state.finalTurn.id, "turn-1");

    t.mock.timers.tick(60000);
    assert.equal(state.finalTurn.id, "turn-1", "inferred completion overwrote the real turn");
  })();
});
