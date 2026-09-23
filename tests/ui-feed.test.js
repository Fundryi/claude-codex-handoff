const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const pureHelpers = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];

function lib() { const c = {}; vm.runInNewContext(pureHelpers, c); return c; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

const HANDOFF = { originator: "Claude Code" };
const CLI = { originator: "codex_cli_rs" };
const UNKNOWN = { originator: "" };
const FOOTER = "<return_format>\nEnd your final message with these four headings, in this order:\n## Summary\n## Needs decision\n</return_format>";

test("messageActor: who sent each message, by originator and prefix", () => {
  const { messageActor } = lib();
  const user = (text, extra) => Object.assign({ kind: "user", text }, extra);
  // A plain prompt is Claude's handoff in a Claude Code session, the human's anywhere else.
  assert.equal(messageActor(user("Fix the flaky test"), HANDOFF), "claude");
  assert.equal(messageActor(user("Fix the flaky test"), CLI), "you");
  assert.equal(messageActor(user("Fix the flaky test"), { originator: "Codex Desktop" }), "you");
  // Unknown originator (older rollouts, missing summary): never guess Claude.
  assert.equal(messageActor(user("Fix the flaky test"), UNKNOWN), "you");
  assert.equal(messageActor(user("Fix the flaky test"), null), "you");
  // The two answer prefixes win over the originator rule. Leading whitespace is tolerated.
  assert.equal(messageActor(user("Answer from the user: use B\n\n" + FOOTER), HANDOFF), "relay");
  assert.equal(messageActor(user("  Answer from the user: use B"), CLI), "relay");
  assert.equal(messageActor(user("Answer from Claude (automatic 1 of 2): use B"), HANDOFF), "claude");
  assert.equal(messageActor(user("Answer from Claude (automatic 2 of 2): use B"), CLI), "claude");
  // The prefix only counts at the start: quoting it mid-message changes nothing.
  assert.equal(messageActor(user("Please reply like 'Answer from the user: x'"), HANDOFF), "claude");
  // Injected context and hook text are System, whoever started the session.
  assert.equal(messageActor(user("<recommended_plugins>\nHere is a list", { internal: true }), HANDOFF), "system");
  assert.equal(messageActor(user("<environment_context>", { internal: true }), CLI), "system");
  assert.equal(messageActor({ kind: "agent", internal: true, text: "PONYTAIL MODE ACTIVE" }, HANDOFF), "system");
  assert.equal(messageActor({ kind: "agent", text: "<permissions instructions>\nx" }, CLI), "system");
  // Codex speech, Codex work, and turn markers.
  assert.equal(messageActor({ kind: "agent", text: "Done." }, HANDOFF), "codex");
  for (const kind of ["cmd", "out", "patch", "tool", "think", "thinkgroup"]) assert.equal(messageActor({ kind, text: "x" }, HANDOFF), "work", kind);
  for (const kind of ["done", "err", "sys"]) assert.equal(messageActor({ kind, text: "x" }, HANDOFF), "status", kind);
});

test("splitReturnFormat splits the plugin footer off a handoff prompt", () => {
  const { splitReturnFormat } = lib();
  assert.deepEqual(plain(splitReturnFormat("<goal>\nPick a name\n</goal>\n\n" + FOOTER)), { body: "<goal>\nPick a name\n</goal>", footer: FOOTER });
  // The footer must start on its own line: a mention inside a sentence is not the footer.
  assert.deepEqual(plain(splitReturnFormat("Keep the <return_format> tag as is")), { body: "Keep the <return_format> tag as is", footer: "" });
  assert.deepEqual(plain(splitReturnFormat("No footer here")), { body: "No footer here", footer: "" });
  // A message that is only the footer keeps an empty body; CRLF line ends still split.
  assert.deepEqual(plain(splitReturnFormat(FOOTER)), { body: "", footer: FOOTER });
  assert.equal(splitReturnFormat("Do it\r\n\r\n<return_format>\r\nx\r\n</return_format>").body, "Do it");
  assert.deepEqual(plain(splitReturnFormat(null)), { body: "", footer: "" });
});

test("promptMarkdown turns tag-only lines into section headings, but not inside code or mid-line", () => {
  const { promptMarkdown, parseMarkdown } = lib();
  const blocks = parseMarkdown(promptMarkdown("<goal>\nPick a name\n</goal>\n<done_when>\nTests pass\n</done_when>"));
  assert.deepEqual(plain(blocks.map((b) => [b.type, b.inline[0].text])), [["heading", "Goal"], ["paragraph", "Pick a name"], ["heading", "Done when"], ["paragraph", "Tests pass"]]);
  assert.equal(promptMarkdown("```xml\n<goal>\n```"), "```xml\n<goal>\n```");
  assert.equal(promptMarkdown("Keep <goal> as written"), "Keep <goal> as written");
});

test("answerPrefix names who answered and strips only the leading prefix", () => {
  const { answerPrefix } = lib();
  assert.deepEqual(plain(answerPrefix("Answer from Claude (automatic 1 of 2): use \"squeeze\".")), { tag: "automatic answer 1 of 2", text: "use \"squeeze\"." });
  assert.deepEqual(plain(answerPrefix("Answer from the user: keep the old API\nand rename it")), { tag: "relayed answer", text: "keep the old API\nand rename it" });
  assert.deepEqual(plain(answerPrefix("Fix it. Answer from the user: no")), { tag: "", text: "Fix it. Answer from the user: no" });
});

test("groupFeed folds runs of System blocks into one row and keeps everything else in order", () => {
  const { groupFeed, assignEventKeys } = lib();
  const events = [
    { kind: "agent", internal: true, ts: 1, text: "PONYTAIL MODE ACTIVE" },
    { kind: "user", internal: true, ts: 2, text: "<recommended_plugins>" },
    { kind: "user", ts: 3, text: "<goal>Do it</goal>\n\n" + FOOTER },
    { kind: "think", ts: 4, text: "a" },
    { kind: "think", ts: 5, text: "b" },
    { kind: "agent", internal: true, ts: 6, text: "<codex-jobs>" },
    { kind: "agent", ts: 7, text: "Done." },
  ];
  const grouped = groupFeed(events, HANDOFF);
  assert.deepEqual(plain(grouped.map((item) => item.kind)), ["sysgroup", "user", "thinkgroup", "sysgroup", "agent"]);
  assert.deepEqual(plain(grouped[0].steps.map((step) => step.ts)), [1, 2]);
  assert.equal(grouped[3].steps.length, 1);
  // A group keeps one key across renders, from its first block.
  assert.equal(assignEventKeys(grouped)[0], "sysgroup|1#0");
  assert.deepEqual(plain(assignEventKeys(groupFeed(events.slice(), HANDOFF))), plain(assignEventKeys(grouped)));
});

test("startedBy reads the originator; unknown shows nothing", () => {
  const { startedBy } = lib();
  assert.deepEqual(plain(startedBy("Claude Code")), { actor: "claude", label: "Claude (handoff)" });
  assert.deepEqual(plain(startedBy("codex_cli_rs")), { actor: "you", label: "you (Codex CLI)" });
  assert.deepEqual(plain(startedBy("codex_exec")), { actor: "you", label: "you (Codex CLI)" });
  assert.deepEqual(plain(startedBy("Codex Desktop")), { actor: "you", label: "you (Codex Desktop)" });
  assert.equal(startedBy(""), null);
  assert.equal(startedBy(undefined), null);
});

test("workingLine says what Codex is doing from its latest step", () => {
  const { workingLine } = lib();
  assert.equal(workingLine([{ kind: "user", text: "go" }, { kind: "cmd", text: "npm   test" }]), "running npm test");
  assert.equal(workingLine([{ kind: "patch", text: "a.js, b.js" }]), "editing a.js, b.js");
  assert.equal(workingLine([{ kind: "think", text: "x" }]), "thinking");
  assert.equal(workingLine([{ kind: "tool", text: "web_search {\"q\":1}" }]), "using web_search");
  assert.equal(workingLine([{ kind: "out", text: "ok" }]), "reading command output");
  assert.equal(workingLine([{ kind: "user", text: "go" }]), "reading the message");
  // Injected context and turn markers after the last step do not hide it.
  assert.equal(workingLine([{ kind: "cmd", text: "ls" }, { kind: "agent", internal: true, text: "<codex-jobs>" }, { kind: "sys", text: "task started" }]), "running ls");
  assert.equal(workingLine([]), "starting");
});

test("removeResultSection drops one heading's section and keeps the rest", () => {
  const { removeResultSection } = lib();
  const text = "## Summary\nDid it.\n\n## Needs decision\nA or B?\n\n## Verification\nnpm test";
  assert.equal(removeResultSection(text, "Needs decision"), "## Summary\nDid it.\n\n## Verification\nnpm test");
  assert.equal(removeResultSection("**Needs decision:**\nA or B?", "Needs decision"), "");
  assert.equal(removeResultSection("No headings", "Needs decision"), "No headings");
});

test("old saved prefs with internals load without it", () => {
  const load = script.match(/function loadPrefs\(\) \{[\s\S]*?\n    \}/)[0];
  const stored = { internals: true, tab: "HISTORY", chip: "FINISHED" };
  const c = {
    STORAGE_KEY: "k",
    defaults: { query: "", dismissed: [] },
    localStorage: { getItem: () => JSON.stringify(stored) },
  };
  vm.runInNewContext(load, c);
  const prefs = c.loadPrefs();
  assert.equal("internals" in prefs, false);
  assert.equal(prefs.tab, "HISTORY");
  assert.deepEqual(plain(prefs.dismissed), []);
  c.localStorage.getItem = () => "{not json";
  assert.equal("internals" in c.loadPrefs(), false);
});
