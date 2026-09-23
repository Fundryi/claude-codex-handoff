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
  // The UI's own list matches the server's: an unflagged injected block is still System,
  // a prompt that opens with any other tag is speech.
  assert.equal(messageActor(user("<environment_context>\n<cwd>/x</cwd>"), CLI), "system");
  assert.equal(messageActor(user("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>"), CLI), "system");
  assert.equal(messageActor(user("<role>\nYou are a reviewer.\n</role>"), HANDOFF), "claude");
  assert.equal(messageActor(user("<send_user_message_question_reply>B</send_user_message_question_reply>"), CLI), "you");
  // A child agent's plain prompts come from its lead agent; the answer prefixes still win.
  const CHILD = { originator: "Claude Code", parentThreadId: "t-lead" };
  assert.equal(messageActor(user("Check the tests"), CHILD), "codex-lead");
  assert.equal(messageActor(user("Check the tests"), { parentThreadId: "t-lead" }), "codex-lead");
  assert.equal(messageActor(user("Answer from the user: B"), CHILD), "relay");
  assert.equal(messageActor(user("Answer from Claude (automatic 1 of 2): B"), CHILD), "claude");
  // Codex speech, Codex work, and turn markers.
  assert.equal(messageActor({ kind: "agent", text: "Done." }, HANDOFF), "codex");
  assert.equal(messageActor({ kind: "agent", text: "Done." }, CHILD), "codex");
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

test("startedBy names the lead agent, then the originator by its readable name; unknown shows nothing", () => {
  const { startedBy } = lib();
  const by = (session) => plain(startedBy(session));
  assert.deepEqual(by({ originator: "Claude Code" }), { actor: "claude", label: "Claude (handoff)" });
  assert.deepEqual(by({ originator: "codex_cli_rs" }), { actor: "you", label: "you (Codex CLI)" });
  assert.deepEqual(by({ originator: "codex_vscode" }), { actor: "you", label: "you (VS Code)" });
  assert.deepEqual(by({ originator: "Codex Desktop" }), { actor: "you", label: "you (Codex Desktop)" });
  assert.deepEqual(by({ originator: "some_new_client" }), { actor: "you", label: "you (some_new_client)" });
  // A child agent was started by its lead, whatever originator its rollout names.
  assert.deepEqual(by({ originator: "Claude Code", parentThreadId: "t-lead" }), { actor: "codex-lead", label: "Codex (lead agent)" });
  assert.equal(startedBy({ originator: "" }), null);
  assert.equal(startedBy(null), null);
});

test("isResumePrompt matches only the exact texts a Resume sends", () => {
  const { isResumePrompt } = lib();
  assert.equal(isResumePrompt("Continue the previous task where it left off and finish it."), true);
  assert.equal(isResumePrompt("  Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.\n"), true);
  assert.equal(isResumePrompt("Continue the previous task where it left off and finish it. Also fix the docs."), false);
  assert.equal(isResumePrompt(""), false);
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

test("a reply's question moves whole into the callout and nothing is lost or reshaped", () => {
  const { removeResultSection, feedQuestion } = lib();
  // Sub-headed options stay with their question: the section ends only at one of the 4 known headings.
  const text = "## Summary\nDid it.\n\n## Needs decision\nWhich store?\n\n### Option A: SQLite\nLocal file.\n\n### Option B: JSON\nNo schema.\n\n## Checks run\nnpm test";
  assert.equal(feedQuestion(text), "Which store?\n\n### Option A: SQLite\nLocal file.\n\n### Option B: JSON\nNo schema.");
  assert.equal(removeResultSection(text, "Needs decision"), "## Summary\nDid it.\n\n## Checks run\nnpm test");
  // A following heading of the same or a higher level ends the callout and stays in the reply.
  const verified = "## Needs decision\nWhich store?\n### Option A\nLocal file.\n\n## Verification\nnpm test";
  assert.equal(feedQuestion(verified), "Which store?\n### Option A\nLocal file.");
  assert.equal(removeResultSection(verified, "Needs decision"), "## Verification\nnpm test");
  // A section that opens with a sub-heading still asks.
  assert.equal(feedQuestion("## Needs decision\n### Option A or B?\nA is faster."), "### Option A or B?\nA is faster.");
  // A ### Needs decision ends at the next ###; a bold one counts as ## and ends at ## or #.
  assert.equal(feedQuestion("### Needs decision\nA or B?\n### Notes\nx"), "A or B?");
  const bold = "**Needs decision:**\nA or B?\n### Option A\nx\n## Verification\ny";
  assert.equal(feedQuestion(bold), "A or B?\n### Option A\nx");
  assert.equal(removeResultSection(bold, "Needs decision"), "## Verification\ny");
  // A long question is never cut short: every character shows in the callout.
  const long = "Pick one. " + "x".repeat(1200) + " END";
  assert.equal(feedQuestion("## Needs decision\n" + long), long);
  assert.equal(removeResultSection("## Needs decision\n" + long, "Needs decision"), "");
  // Blank lines inside a code fence survive; a known heading inside a fence does not end the section.
  const fenced = "## Summary\nRan:\n```\na\n\n\n\nb\n```\n\n## Needs decision\nKeep it?\n```\n## Summary\n```\n";
  assert.equal(removeResultSection(fenced, "Needs decision"), "## Summary\nRan:\n```\na\n\n\n\nb\n```");
  assert.equal(feedQuestion(fenced), "Keep it?\n```\n## Summary\n```");
  // No question: "None", no section, or bold heading with nothing under it.
  assert.equal(feedQuestion("## Needs decision\nNone"), null);
  assert.equal(feedQuestion("No headings"), null);
  assert.equal(removeResultSection("No headings", "Needs decision"), "No headings");
  assert.equal(removeResultSection("**Needs decision:**\nA or B?", "Needs decision"), "");
});

test("the UI and the server flag the same injected blocks", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "codex-live-viewer.js"), "utf8");
  const list = (src) => src.match(/INJECTED_BLOCK = (\/.*\/);/)[1];
  assert.equal(list(script), list(server));
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
