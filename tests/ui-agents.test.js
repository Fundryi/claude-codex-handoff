const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function slice(re) {
  const c = {};
  vm.runInNewContext(script.match(re)[0], c);
  return c;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

const NOW = 1_700_000_000_000;

test("isInternal honours the server's internal flag", () => {
  const { isInternal } = slice(/function isInternal[\s\S]*?\n    \}/);
  assert.equal(isInternal({ kind: "agent", internal: true, text: "PONYTAIL MODE ACTIVE" }), true);
  assert.equal(isInternal({ kind: "user", internal: true, text: "<recommended_plugins>" }), true);
  assert.equal(isInternal({ kind: "user", text: "Fix the bug" }), false);
  assert.equal(isInternal({ kind: "agent", text: "Done." }), false);
});

test("sessionTitle falls back to the job title, then the agent nickname", () => {
  const { sessionTitle } = slice(/function sessionTitle[\s\S]*?\n    \}/);
  const jobs = [{ threadId: "t1", title: "Fix the flaky test" }];
  assert.equal(sessionTitle({ title: "Own title", threadId: "t1" }, jobs), "Own title");
  assert.equal(sessionTitle({ threadId: "t1" }, jobs), "Fix the flaky test");
  assert.equal(sessionTitle({ threadId: "t2", agentNickname: "Kierkegaard" }, jobs), "Agent Kierkegaard");
  assert.equal(sessionTitle({ threadId: "t3" }, jobs), "Untitled Codex task");
  assert.equal(sessionTitle({ threadId: "t3" }, null), "Untitled Codex task");
});

test("childSessions groups agents under their parent and leaves orphans alone", () => {
  const { childSessions } = slice(/function childSessions[\s\S]*?\n    \}/);
  const sessions = [
    { id: "p", threadId: "t-parent" },
    { id: "c1", threadId: "t-c1", parentThreadId: "t-parent", agentNickname: "Kierkegaard" },
    { id: "c2", threadId: "t-c2", parentThreadId: "t-parent", agentNickname: "Wegener" },
    { id: "orphan", threadId: "t-o", parentThreadId: "t-missing", agentNickname: "Lost" },
  ];
  const grouped = childSessions(sessions);
  assert.deepEqual(plain(grouped.byParent["t-parent"].map((s) => s.id)), ["c1", "c2"]);
  assert.equal(grouped.isChild("c1"), true);
  assert.equal(grouped.isChild("orphan"), false);
  assert.equal(grouped.isChild("p"), false);
});

// A session that names itself as parent, or two sessions that name each other,
// must not become a child. The list draws each card once and nests one level,
// so bad data can never grow the DOM without end.
test("childSessions ignores self-parent links and the list never recurses past one level", () => {
  const { childSessions } = slice(/function childSessions[\s\S]*?\n    \}/);
  const grouped = childSessions([
    { id: "self", threadId: "t-self", parentThreadId: "t-self" },
    { id: "a", threadId: "t-a", parentThreadId: "t-b" },
    { id: "b", threadId: "t-b", parentThreadId: "t-a" },
  ]);
  assert.equal(grouped.isChild("self"), false);
  assert.equal(grouped.byParent["t-self"], undefined);
  assert.match(html, /if \(drawn\[session\.id\]\) return;/);
  assert.match(html, /if \(!depth && kids\.length\) \{/);
  assert.match(html, /sessionCard\(kid, 1, group\)/);
});

test("homeCards folds child agents into the parent card", () => {
  const { homeCards } = slice(/function jobDetailLine[\s\S]*?function homeCards[\s\S]*?\n    \}/);
  const sessions = [
    { id: "p", threadId: "t-parent", status: "LIVE", title: "Parent run", cwd: "D:\\repo", lastGrow: NOW - 1000 },
    { id: "c1", threadId: "t-c1", parentThreadId: "t-parent", agentNickname: "Kierkegaard", status: "LIVE", cwd: "D:\\repo", lastGrow: NOW - 500 },
    { id: "c2", threadId: "t-c2", parentThreadId: "t-parent", agentNickname: "Wegener", status: "IDLE", cwd: "D:\\repo", lastGrow: NOW - 400 },
    { id: "orphan", threadId: "t-o", parentThreadId: "t-missing", agentNickname: "Lost", status: "LIVE", cwd: "D:\\repo", lastGrow: NOW - 300 },
  ];
  const { active } = homeCards(sessions, [], NOW);
  assert.deepEqual(plain(active.map((c) => c.id)), ["orphan", "p"]);
  assert.equal(active[1].agents, 2);
  assert.equal(active[0].title, "Agent Lost");
});

test("jobDetailLine lists the agents a job used", () => {
  const { jobDetailLine } = slice(/function jobStatusLabel[\s\S]*?function jobDetailLine[\s\S]*?\n    \}/);
  const line = jobDetailLine({ phase: "done", agents: ["Kierkegaard", "Wegener"] }, NOW);
  assert.match(line, /agents: Kierkegaard, Wegener/);
  assert.doesNotMatch(jobDetailLine({ phase: "done", agents: [] }, NOW), /agents/);
});

test("child sessions render nested with a nickname chip", () => {
  assert.match(html, /\.session\.child\s*\{/);
  assert.match(html, /\.status\.AGENT\s*\{/);
  assert.match(html, /STALE: \{ label: 'Possibly stuck', help: 'The job process died or stopped its heartbeat before completing\.' \}/);
});
