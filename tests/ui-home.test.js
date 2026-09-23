const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Slice from firstLine through homeCards: homeCards calls firstLine (the question) and
// jobDetailLine (the detail line), both defined ahead of it.
const slice = script.match(/function firstLine[\s\S]*?function homeCards[\s\S]*?\n    \}/)[0];

function ctx() { const c = {}; vm.runInNewContext(slice, c); return c; }
// Arrays produced inside the vm sandbox are a different Array realm; JSON round-trip
// before deepEqual so comparisons don't fail on constructor identity (see ui-actions.test.js).
function plain(value) { return JSON.parse(JSON.stringify(value)); }

const NOW = 1_700_000_000_000;

// homeCards takes buildRows-shaped rows (Task 3/4's unified row model), so the overview
// agrees with the list. Row shape mirrors buildRows' output; only the fields homeCards
// actually reads are filled in per case.
function row(overrides) {
  return Object.assign({
    id: "r1", session: null, job: null, olderJobs: 0, status: "RUNNING",
    title: "Untitled", project: "D:\\repo", threadId: "t1", fast: false,
    needsAnswer: false, updatedMs: NOW, children: []
  }, overrides);
}

test("rows sort into answer, attention, running and finished sections by row status", () => {
  const { homeCards } = ctx();
  const rows = [
    row({ id: "a", status: "ANSWER", updatedMs: NOW }),
    row({ id: "r", status: "RUNNING", updatedMs: NOW - 1000 }),
    row({ id: "s", status: "ATTENTION", updatedMs: NOW - 2000 }),
    row({ id: "f", status: "FINISHED", updatedMs: NOW - 3000 }),
    row({ id: "w", status: "WAITING", updatedMs: NOW - 4000 }),
    row({ id: "x", status: "STOPPED", updatedMs: NOW - 5000 })
  ];
  const cards = homeCards(rows, [], NOW);
  assert.deepEqual(plain(cards.answer.map(c => c.id)), ["a"]);
  assert.deepEqual(plain(cards.running.map(c => c.id)), ["r"]);
  assert.deepEqual(plain(cards.attention.map(c => c.id)), ["s"]);
  assert.deepEqual(plain(cards.finished.map(c => c.id)), ["f"]);
  // Waiting and Stopped rows have no overview section.
});

test("dismissed and archived rows never become cards", () => {
  const { homeCards } = ctx();
  const rows = [
    row({ id: "dismissed", status: "RUNNING" }),
    row({ id: "archived", status: "ARCHIVED" }),
    row({ id: "kept", status: "RUNNING" })
  ];
  const cards = homeCards(rows, ["dismissed"], NOW);
  assert.deepEqual(plain(cards.running.map(c => c.id)), ["kept"]);
});

test("recently finished stays capped at 5, order preserved (newest first, as buildRows sorts)", () => {
  const { homeCards } = ctx();
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(row({ id: "f" + i, status: "FINISHED", updatedMs: NOW - i * 1000 }));
  const cards = homeCards(rows, [], NOW);
  assert.equal(cards.finished.length, 5);
  assert.deepEqual(plain(cards.finished.map(c => c.id)), ["f0", "f1", "f2", "f3", "f4"]);
});

test("a card keeps the row's data fields, and a needs-answer card carries the question (via firstLine)", () => {
  const { homeCards } = ctx();
  const job = {
    id: "j1", title: "Job one", model: "sol", effort: "high", fast: true,
    needsDecision: "Should I deploy?  \n  More detail here."
  };
  const session = { id: "s1", model: "sol", tokensUsed: 123 };
  const rows = [
    row({
      id: "s1", session, job, status: "ANSWER", needsAnswer: true, fast: true,
      title: "Job one", project: "D:\\repo", updatedMs: NOW,
      children: [row({ id: "kid" })]
    })
  ];
  const cards = homeCards(rows, [], NOW);
  const card = cards.answer[0];
  assert.equal(card.sessionId, "s1");
  assert.equal(card.title, "Job one");
  assert.equal(card.project, "D:\\repo");
  assert.equal(card.fast, true);
  assert.equal(card.agents, 1);
  assert.equal(card.lastMs, NOW);
  assert.equal(card.model, "sol");
  assert.equal(card.effort, "high");
  assert.equal(card.tokens, 123);
  assert.equal(card.needsAnswer, true);
  // firstLine collapses whitespace/newlines into one line, same as the row's '?' chip tooltip.
  assert.equal(card.question, "Should I deploy? More detail here.");
});

test("a job-only row (no session) still becomes a card with no sessionId", () => {
  const { homeCards } = ctx();
  const job = { id: "j1", title: "Queued job", workspaceRoot: "D:\\repo" };
  const rows = [row({ id: "job:j1", session: null, job, status: "RUNNING", title: "Queued job" })];
  const cards = homeCards(rows, [], NOW);
  assert.equal(cards.running[0].sessionId, null);
  assert.equal(cards.running[0].id, "job:j1");
});
