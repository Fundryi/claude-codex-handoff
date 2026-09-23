const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "viewer-ui.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const pureHelpers = script.match(/function firstLine[\s\S]*?(?=\n    function setConnection)/)[0];

function load() {
  const context = {};
  vm.runInNewContext(pureHelpers, context);
  return context;
}
const lib = load();
// Round-trips vm-context arrays/objects through JSON so deepEqual doesn't trip
// on cross-realm prototypes (Array from the vm context vs. this file's Array).
const plain = (value) => JSON.parse(JSON.stringify(value));

// A tiny DOM shim built from plain objects: renderMarkdown only ever calls
// createElement / createTextNode / createDocumentFragment / appendChild and
// sets .className / .textContent, so that's all this needs to provide.
function fakeDoc() {
  function makeNode(tag) {
    return {
      tag,
      className: "",
      textContent: "",
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      },
    };
  }
  return {
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => ({ tag: "#text", textContent: text }),
    createDocumentFragment: () => makeNode("#fragment"),
  };
}

// Flattens a shim node into plain text the way a browser's .textContent would,
// so tests can assert on rendered content without walking the tree by hand.
function flatten(node) {
  if (node.tag === "#text") return node.textContent;
  if (node.textContent && node.children.length === 0) return node.textContent;
  return node.children.map(flatten).join("");
}

test("parseMarkdown: headings 1-3", () => {
  const blocks = lib.parseMarkdown("# One\n## Two\n### Three");
  assert.deepEqual(
    plain(blocks.map((b) => [b.type, b.level])),
    [
      ["heading", 1],
      ["heading", 2],
      ["heading", 3],
    ],
  );
  assert.equal(blocks[0].inline[0].text, "One");
});

test("parseMarkdown: paragraphs", () => {
  const blocks = lib.parseMarkdown("First line\nstill first paragraph\n\nSecond paragraph");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "paragraph");
  assert.equal(blocks[0].inline.map((t) => t.text).join(""), "First line still first paragraph");
  assert.equal(blocks[1].inline.map((t) => t.text).join(""), "Second paragraph");
});

test("parseMarkdown: bold, italic, inline code", () => {
  const blocks = lib.parseMarkdown("Some **bold**, *italic*, and `code`.");
  const tokens = blocks[0].inline;
  assert.deepEqual(
    plain(tokens.map((t) => t.type)),
    ["text", "bold", "text", "italic", "text", "code", "text"],
  );
  assert.equal(tokens.find((t) => t.type === "bold").text, "bold");
  assert.equal(tokens.find((t) => t.type === "italic").text, "italic");
  assert.equal(tokens.find((t) => t.type === "code").text, "code");
});

test("parseMarkdown: fenced code keeps the language line as text", () => {
  const blocks = lib.parseMarkdown("```js\nconst x = 1;\nreturn x;\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].lang, "js");
  assert.equal(blocks[0].text, "const x = 1;\nreturn x;");
});

test("parseMarkdown: an indented fence (inside a list item) is still recognized (fix round 1, #5)", () => {
  const blocks = lib.parseMarkdown("  ```js\n  const x = 1;\n  ```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].lang, "js");
  assert.equal(blocks[0].text, "  const x = 1;");
});

test("parseInline: asterisks in prose (glob patterns) don't get read as italics (fix round 1, #4)", () => {
  const tokens = lib.parseInline("glob src/*.js and lib/*.mjs");
  assert.deepEqual(
    plain(tokens.map((t) => t.type)),
    ["text"],
  );
  assert.equal(tokens[0].text, "glob src/*.js and lib/*.mjs");
  // A real italic run still works either side of ordinary prose.
  const real = lib.parseInline("plain *italic* plain");
  assert.deepEqual(plain(real.map((t) => t.type)), ["text", "italic", "text"]);
  assert.equal(real[1].text, "italic");
});

test("parseInline: the link-label regex is bounded, so an unclosed [ can't blow up (fix round 1, #3)", () => {
  const pathological = "[".repeat(40000);
  const started = Date.now();
  lib.parseInline(pathological);
  assert.ok(Date.now() - started < 500, "should resolve near-instantly, not quadratically");
});

test("parseMarkdown: nested-free lists", () => {
  const bullets = lib.parseMarkdown("- one\n- two\n- three");
  assert.equal(bullets.length, 1);
  assert.equal(bullets[0].type, "ul");
  assert.deepEqual(plain(bullets[0].items.map((inline) => inline.map((t) => t.text).join(""))), ["one", "two", "three"]);

  const numbered = lib.parseMarkdown("1. first\n2. second");
  assert.equal(numbered[0].type, "ol");
  assert.deepEqual(plain(numbered[0].items.map((inline) => inline.map((t) => t.text).join(""))), ["first", "second"]);
});

test("parseMarkdown: a numbered list keeps its starting number (fix round 1, #2)", () => {
  const separate = lib.parseMarkdown("1. keep\n\n2. delete");
  assert.equal(separate.length, 2);
  assert.equal(separate[0].start, 1);
  assert.equal(separate[1].start, 2);

  // An indented, non-list line breaks the ol into two blocks (nested-free);
  // the second block must still remember it starts at 2, not restart at 1.
  const brokenByNesting = lib.parseMarkdown("1. **A**\n   - detail\n2. **B**");
  const ols = brokenByNesting.filter((b) => b.type === "ol");
  assert.equal(ols.length, 2);
  assert.equal(ols[0].start, 1);
  assert.equal(ols[1].start, 2);

  const startsAtThree = lib.parseMarkdown("3. third");
  assert.equal(startsAtThree[0].start, 3);
});

test("renderMarkdown sets list.start on <ol> so numbering doesn't restart at 1", () => {
  const doc = fakeDoc();
  const fragment = lib.renderMarkdown("3. third", doc);
  assert.equal(fragment.children[0].tag, "ol");
  assert.equal(fragment.children[0].start, 3);
});

test("parseMarkdown: block quote", () => {
  const blocks = lib.parseMarkdown("> Keep the old API?\n> Options: keep, delete.");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "quote");
  assert.equal(blocks[0].inline.map((t) => t.text).join(""), "Keep the old API? Options: keep, delete.");
});

test("parseMarkdown: a link shows as text (url), never a clickable link", () => {
  const blocks = lib.parseMarkdown("See [the docs](https://example.com/x) for more.");
  const text = blocks[0].inline.map((t) => t.text).join("");
  assert.equal(text, "See the docs (https://example.com/x) for more.");
});

test("parseMarkdown: <script> and <img onerror> stay literal text (Review Focus 3)", () => {
  const dangerous = "<script>alert(1)</script> and <img src=x onerror=alert(2)>";
  const blocks = lib.parseMarkdown(dangerous);
  assert.equal(blocks[0].inline.map((t) => t.text).join(""), dangerous);
});

test("parseMarkdown: CRLF input", () => {
  const blocks = lib.parseMarkdown("# Title\r\n\r\nBody text\r\n- item one\r\n- item two");
  assert.deepEqual(
    plain(blocks.map((b) => b.type)),
    ["heading", "paragraph", "ul"],
  );
});

test("renderMarkdown builds DOM nodes only, no innerHTML anywhere in reach", () => {
  const doc = fakeDoc();
  const fragment = lib.renderMarkdown("# Title\n\nSome **bold** text.\n\n- a\n- b", doc);
  assert.equal(fragment.children.length, 3);
  assert.equal(fragment.children[0].tag, "div");
  assert.equal(fragment.children[0].className, "md-h1");
  assert.equal(flatten(fragment.children[0]), "Title");
  assert.equal(fragment.children[1].className, "md-p");
  assert.equal(flatten(fragment.children[1]), "Some bold text.");
  assert.equal(fragment.children[2].tag, "ul");
  assert.equal(fragment.children[2].children.length, 2);
});

// Mirrors the case list in tests/plugin-task-result.test.js (extractSection /
// readNeedsDecision) so the UI's copy of the rule never drifts from the plugin's.
const ANSWER = [
  "Fixed the retry loop.",
  "",
  "## Summary",
  "The uploader now retries 3 times.",
  "",
  "## Changed files",
  "- src/upload.js",
  "",
  "## Checks run",
  "npm test (green)",
  "",
  "## Needs decision",
  "Should the old API stay? Options: keep it (recommended), delete it.",
].join("\n");

test("extractResultSection stops at the next heading", () => {
  assert.equal(lib.extractResultSection(ANSWER, "Summary"), "The uploader now retries 3 times.");
  assert.equal(lib.extractResultSection(ANSWER, "Missing"), null);
});

test("readResultQuestion finds a real question and ignores empty answers", () => {
  assert.equal(
    lib.readResultQuestion(ANSWER),
    "Should the old API stay? Options: keep it (recommended), delete it.",
  );
  assert.equal(
    lib.readResultQuestion(ANSWER.replace(/\n/g, "\r\n")),
    "Should the old API stay? Options: keep it (recommended), delete it.",
  );
  assert.equal(lib.readResultQuestion("### Needs Decision:\nPick a name?\n## Other\nx"), "Pick a name?");
  assert.equal(lib.readResultQuestion("**Needs decision:**\nPick a name?"), "Pick a name?");
  assert.equal(
    lib.readResultQuestion("## Needs decision\n**Keep the old API?**\n- keep\n- delete"),
    "**Keep the old API?**\n- keep\n- delete",
    "a bold-line question keeps its options",
  );
  assert.equal(
    lib.readResultQuestion("## Needs decision\nKeep the old API?\n**Options:**\n- keep\n- delete\n**Summary**\nx"),
    "Keep the old API?\n**Options:**\n- keep\n- delete",
    "a bold label inside the section does not end it; a known bold heading does",
  );
  for (const empty of ["None", "none.", "-", "N/A", "", "None - all clear.", "No decision needed.", "No questions."]) {
    assert.equal(lib.readResultQuestion(`## Summary\nok\n## Needs decision\n${empty}`), null, `"${empty}" is not a question`);
  }
  assert.equal(lib.readResultQuestion("No headings at all."), null);
  assert.equal(lib.readResultQuestion(`## Needs decision\n${"q".repeat(3000)}`).length, 1000);
});

test("groupThinking: 3 consecutive thinking + message + 1 thinking makes 2 groups", () => {
  const events = [
    { kind: "think", ts: 1, text: "step one" },
    { kind: "think", ts: 2, text: "step two" },
    { kind: "think", ts: 3, text: "step three" },
    { kind: "agent", ts: 4, text: "here's the answer" },
    { kind: "think", ts: 5, text: "one more thought" },
  ];
  const grouped = lib.groupThinking(events);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].kind, "thinkgroup");
  assert.equal(grouped[0].steps.length, 3);
  assert.equal(grouped[0].text, "step one");
  assert.equal(grouped[1].kind, "agent");
  assert.equal(grouped[2].kind, "thinkgroup");
  assert.equal(grouped[2].steps.length, 1);
  assert.equal(grouped.filter((e) => e.kind === "thinkgroup").length, 2);
});

test("groupThinking passes non-thinking events through untouched", () => {
  const events = [
    { kind: "cmd", ts: 1, text: "ls" },
    { kind: "out", ts: 2, text: "file.txt" },
  ];
  assert.deepEqual(plain(lib.groupThinking(events)), events);
});

// technicalEventKey is the stable identity a re-render uses to find "the same"
// row again and restore whether the reader had it open (fix round 1, #1).
test("technicalEventKey: stable per kind+ts, and a thinking group keys off its first step", () => {
  assert.equal(lib.technicalEventKey({ kind: "cmd", ts: 100 }), "cmd|100");
  assert.equal(lib.technicalEventKey({ kind: "patch", ts: 200 }), "patch|200");

  const group = { kind: "thinkgroup", ts: 999, steps: [{ ts: 100 }, { ts: 200 }, { ts: 300 }] };
  assert.equal(lib.technicalEventKey(group), "thinkgroup|100");

  // Re-grouping the same underlying events (a fresh object each render) yields the same key.
  const events = [
    { kind: "think", ts: 100, text: "a" },
    { kind: "think", ts: 200, text: "b" },
  ];
  const groupedFirst = lib.groupThinking(events)[0];
  const groupedAgain = lib.groupThinking(events.slice())[0];
  assert.notEqual(groupedFirst, groupedAgain, "a fresh object each call");
  assert.equal(lib.technicalEventKey(groupedFirst), lib.technicalEventKey(groupedAgain));
});

// Fix round 2, #1: two rows with the same kind+ts (parallel tool calls in one
// Codex turn) must not collide onto one technicalEventKey.
test("assignEventKeys: same kind+ts rows get distinct, order-stable keys", () => {
  const events = [
    { kind: "cmd", ts: 100, text: "first" },
    { kind: "cmd", ts: 100, text: "second - same kind and ts as the first" },
    { kind: "patch", ts: 100, text: "unrelated, different kind" },
    { kind: "cmd", ts: 100, text: "third - same kind and ts again" },
  ];
  const keys = lib.assignEventKeys(events);
  assert.deepEqual(plain(keys), ["cmd|100#0", "cmd|100#1", "patch|100#0", "cmd|100#2"]);
  assert.equal(new Set(keys).size, keys.length, "every key is unique");

  // Recomputing from the same ordered list (what every render does) assigns
  // the same keys again, so a given row keeps its key and its open state.
  assert.deepEqual(plain(lib.assignEventKeys(events.slice())), plain(keys));
});
