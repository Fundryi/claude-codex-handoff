const assert = require("node:assert/strict");
const { uiSource } = require("./helpers/source");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = uiSource();
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

// A tiny DOM shim built from plain objects: nodes, appendChild, textContent,
// style and ordinary DOM properties are enough for the semantic renderer.
// Any HTML-parsing write throws, so the renderer must build text nodes only.
function fakeDoc() {
  function makeNode(tag) {
    return {
      tag,
      className: "",
      style: {},
      textContent: "",
      children: [],
      set innerHTML(_) { throw new Error("renderMarkdown wrote innerHTML"); },
      set outerHTML(_) { throw new Error("renderMarkdown wrote outerHTML"); },
      insertAdjacentHTML() { throw new Error("renderMarkdown called insertAdjacentHTML"); },
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

function collectNodes(node) {
  return [node, ...(node.children || []).flatMap(collectNodes)];
}

function inlineText(tokens) {
  return tokens.map((token) => token.type === "br" ? " " : token.children ? inlineText(token.children) : token.text).join("");
}

test("deep JSON and Markdown nesting render as complete plain text", () => {
  const doc = fakeDoc();
  for (const [text, render] of [
    ['['.repeat(4000) + '0' + ']'.repeat(4000), text => lib.renderContent(text, undefined, {}, doc)],
    ['>'.repeat(3000) + ' x', text => lib.renderMarkdown(text, doc, {})],
  ]) {
    let node;
    assert.doesNotThrow(() => { node = render(text); });
    assert.equal(flatten(node), text);
    assert.ok(collectNodes(node).some(n => n.tag === 'pre'));
  }
});

test("GFM table with alignment parses to a table block", () => {
  const blocks = plain(lib.parseMarkdown("| File | Lines |\n|---|---:|\n| ui/index.html | 159 |\n| ui/theme.css | 62 |"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].align, [null, "right"]);
  assert.equal(blocks[0].rows.length, 2);
  assert.deepEqual(blocks[0].rows[1][1], [{ type: "text", text: "62" }]);
});

test("a header-only table while streaming stays a table, not pipes in a paragraph", () => {
  const blocks = plain(lib.parseMarkdown("| A | B |\n|---|---|"));
  assert.equal(blocks[0].type, "table");
  assert.equal(blocks[0].rows.length, 0);
});

test("nested lists keep their depth and continuation lines", () => {
  const blocks = plain(lib.parseMarkdown("- parent\n  continued\n  - child one\n  - child two\n- next"));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].items.length, 2);
  assert.deepEqual(blocks[0].items[0].blocks[0], { type: "p", inline: [{ type: "text", text: "parent" }, { type: "br" }, { type: "text", text: "continued" }] });
  assert.equal(blocks[0].items[0].blocks[1].type, "ul");
  assert.equal(blocks[0].items[0].blocks[1].items.length, 2);
});

test("a fenced block inside a list item stays in the item", () => {
  const blocks = plain(lib.parseMarkdown("- S1 `git check-ignore -v`:\n  ```text\n  .gitignore:3:x\n  ```\n- S2 done"));
  assert.equal(blocks[0].items.length, 2);
  assert.deepEqual(blocks[0].items[0].blocks[1], { type: "code", lang: "text", info: "text", text: ".gitignore:3:x" });
});

test("horizontal rule, h4-h6, task list, strike", () => {
  const blocks = plain(lib.parseMarkdown("---\n#### Step\n- [ ] todo\n- [x] done\n~~old~~\n##### Five\n###### Six"));
  assert.equal(blocks[0].type, "hr");
  assert.deepEqual(blocks[1], { type: "heading", level: 4, inline: [{ type: "text", text: "Step" }] });
  assert.deepEqual(blocks[2].items.map((i) => i.checked), [false, true]);
  assert.equal(blocks[3].inline[0].type, "strike");
  assert.deepEqual(blocks.slice(4).map((b) => b.level), [5, 6]);
});

test("inline code and italic inside bold", () => {
  const inline = plain(lib.parseInline("**`900e8e1` and *this***"));
  assert.equal(inline[0].type, "bold");
  assert.deepEqual(inline[0].children[0], { type: "code", text: "900e8e1" });
  assert.equal(inline[0].children[2].type, "italic");
});

test("emphasis nests in both directions and permits real multiword italic prose", () => {
  assert.deepEqual(plain(lib.parseInline("*outer **bold** end*")), [{ type: "italic", children: [
    { type: "text", text: "outer " }, { type: "bold", children: [{ type: "text", text: "bold" }] }, { type: "text", text: " end" },
  ] }]);
  assert.deepEqual(plain(lib.parseInline("***both***")), [{ type: "bold", children: [{ type: "italic", children: [{ type: "text", text: "both" }] }] }]);
  assert.deepEqual(plain(lib.parseInline("*two words*")), [{ type: "italic", children: [{ type: "text", text: "two words" }] }]);
});

test("links: only http(s) get an href; angle-bracket targets with spaces parse", () => {
  const ok = plain(lib.parseInline("[docs](https://example.com/a)"))[0];
  assert.deepEqual(ok, { type: "link", href: "https://example.com/a", title: "https://example.com/a", children: [{ type: "text", text: "docs" }] });
  const local = plain(lib.parseInline("[probe](</D:/GIT/PC-XENNTEC FIRMA/probe>)"))[0];
  assert.equal(local.href, null);
  assert.equal(local.title, "/D:/GIT/PC-XENNTEC FIRMA/probe");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x", "vbscript:x", "//example.com", "java\tscript:alert(1)"]) {
    const token = plain(lib.parseInline("[x](<" + bad + ">)"))[0];
    assert.equal(token.href, null, bad);
    assert.equal(token.title, bad);
  }
  assert.equal(plain(lib.parseInline("see https://example.com/x."))[1].href, "https://example.com/x");
});

test("fence edge cases: ~~~, longer fence around shorter, fence in a quote, unclosed fence", () => {
  const outer = plain(lib.parseMarkdown("````markdown\n```js\nx\n```\n````"));
  assert.equal(outer.length, 1);
  assert.equal(outer[0].text, "```js\nx\n```");
  assert.equal(plain(lib.parseMarkdown("~~~py\nprint(1)\n~~~"))[0].lang, "py");
  assert.equal(plain(lib.parseMarkdown("> ```\n> code\n> ```"))[0].blocks[0].type, "code");
  assert.equal(plain(lib.parseMarkdown("```js\nlet a = 1"))[0].text, "let a = 1");
  assert.deepEqual(plain(lib.parseMarkdown("```js title=x\na\n~~~\n``` trailing\nb\n````")), [{ type: "code", lang: "js", info: "js title=x", text: "a\n~~~\n``` trailing\nb" }]);
});

test("soft line break inside a paragraph is a br", () => {
  assert.deepEqual(plain(lib.parseMarkdown("Key: X\nValue: Y"))[0], { type: "p", inline: [{ type: "text", text: "Key: X" }, { type: "br" }, { type: "text", text: "Value: Y" }] });
});

test("render builds a table, an anchor only for http(s), and never parses HTML", () => {
  const frag = lib.renderMarkdown("| a |\n|---:|\n| <b>x</b> |\n\n[x](javascript:alert(1)) [y](https://e.com)", fakeDoc());
  const nodes = collectNodes(frag);
  assert.ok(nodes.some((n) => n.tag === "table" && n.className === "md-table"));
  for (const tag of ["thead", "tbody", "tr", "th", "td"]) assert.ok(nodes.some((n) => n.tag === tag), tag);
  assert.ok(nodes.filter((n) => n.tag === "th" || n.tag === "td").every((n) => n.style.textAlign === "right"));
  const anchors = nodes.filter((n) => n.tag === "a");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, "https://e.com");
  assert.equal(anchors[0].target, "_blank");
  assert.equal(anchors[0].rel, "noopener noreferrer");
  assert.equal(anchors[0].className, "md-link");
  assert.ok(nodes.some((n) => n.tag === "span" && n.title === "javascript:alert(1)"));
  assert.ok(flatten(frag).includes("<b>x</b>"));
  assert.ok(!nodes.some((n) => n.tag === "b"));
});

test("Markdown images and hostile HTML stay text, even with an https image target", () => {
  const text = "![x](data:image/svg+xml,<svg/onload=alert(1)>) ![remote](https://e.com/x.png) <img src=x onerror=alert(2)>";
  const frag = lib.renderMarkdown(text, fakeDoc());
  assert.equal(flatten(frag), text);
  assert.ok(!collectNodes(frag).some((n) => n.tag === "img" || n.tag === "a"));
});

test("table cells keep escaped pipes, inline code and missing cells", () => {
  const blocks = plain(lib.parseMarkdown("A | B | C\n:--- | :---: | ---:\n`x|y` | a\\|b\n**v** | *w* | z | ignored"));
  assert.equal(blocks[0].type, "table");
  assert.deepEqual(blocks[0].align, ["left", "center", "right"]);
  assert.deepEqual(blocks[0].rows[0], [[{ type: "code", text: "x|y" }], [{ type: "text", text: "a|b" }], [{ type: "text", text: "" }]]);
  assert.equal(blocks[0].rows[1].length, 3);
  assert.equal(plain(lib.parseMarkdown("A | B\n---|---|---"))[0].type, "p", "mismatched delimiter is prose");
});

test("container content columns handle mixed lists, quotes, blank continuations and ordered starts", () => {
  const blocks = plain(lib.parseMarkdown("3. parent\n   + child\n     > quote\n     >\n     > **second**\n\n   more\n4. next\n\noutside"));
  assert.equal(blocks[0].type, "ol");
  assert.equal(blocks[0].start, 3);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[0].items[0].blocks[1].type, "ul");
  assert.equal(blocks[0].items[0].blocks[1].start, null);
  const quote = blocks[0].items[0].blocks[1].items[0].blocks[1];
  assert.equal(quote.type, "quote");
  assert.equal(quote.blocks.length, 2);
  assert.equal(blocks[0].items[0].blocks[2].inline[0].text, "more");
  assert.equal(blocks[1].inline[0].text, "outside");
});

test("inline scanner handles escapes, arbitrary backticks, nested emphasis and literal unclosed markers", () => {
  assert.deepEqual(plain(lib.parseInline("\\*literal\\* ``a ` b`` ~~**old**~~")), [
    { type: "text", text: "*literal* " }, { type: "code", text: "a ` b" }, { type: "text", text: " " },
    { type: "strike", children: [{ type: "bold", children: [{ type: "text", text: "old" }] }] },
  ]);
  for (const text of ["**open", "*open", "~~open", "`open", "[open](target", "src/*.js and lib/*.mjs"]) {
    assert.deepEqual(plain(lib.parseInline(text)), [{ type: "text", text }], text);
  }
  const link = plain(lib.parseInline("[**docs** `api`](https://e.com/a_(b))"))[0];
  assert.equal(link.href, "https://e.com/a_(b)");
  assert.deepEqual(link.children.map((t) => t.type), ["bold", "text", "code"]);
});

test("render draws nested lists, quotes, rules, disabled tasks and recursive inline nodes", () => {
  const frag = lib.renderMarkdown("***\n- [x] **`done` *now***\n  - [ ] ~~todo~~\n\n> line one\n> line two", fakeDoc());
  const nodes = collectNodes(frag);
  assert.ok(nodes.some((n) => n.tag === "hr" && n.className === "md-hr"));
  assert.equal(nodes.filter((n) => n.tag === "ul").length, 2);
  const inputs = nodes.filter((n) => n.tag === "input");
  assert.deepEqual(inputs.map((n) => [n.type, n.disabled, n.checked]), [["checkbox", true, true], ["checkbox", true, false]]);
  assert.equal(nodes.filter((n) => n.tag === "li" && n.className === "md-task").length, 2);
  const strong = nodes.find((n) => n.tag === "strong");
  assert.ok(strong.children.some((n) => n.tag === "code"));
  assert.ok(strong.children.some((n) => n.tag === "em"));
  assert.ok(nodes.some((n) => n.tag === "del"));
  assert.ok(nodes.some((n) => n.tag === "blockquote" && n.children[0].tag === "p"));
  assert.ok(nodes.some((n) => n.tag === "br"));
});

test("inline parsing stays bounded on a 1 MB hostile line and keeps all text", () => {
  const { spawnSync } = require("node:child_process");
  const source = path.join(__dirname, "..", "ui", "js", "markdown.js");
  const result = spawnSync(process.execPath, ["-e", `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const context = {};
    vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), context);
    const text = '[x]('.repeat(262144);
    assert.equal(JSON.stringify(context.parseInline(text)), JSON.stringify([{ type: 'text', text }]));
  `, source], { encoding: "utf8", timeout: 2500 });
  assert.equal(result.status, 0, result.error ? String(result.error) : result.stderr);
});

test("nested lists and quotes have no artificial container depth limit", () => {
  const depth = 80;
  const text = Array.from({ length: depth }, (_, i) => " ".repeat(i * 2) + "- level " + i).join("\n");
  let list = lib.parseMarkdown(text)[0];
  for (let i = 0; i < depth; i++) {
    assert.equal(list.type, "ul", "list depth " + i);
    assert.equal(list.items[0].blocks[0].inline[0].text, "level " + i);
    list = list.items[0].blocks[1];
  }
  let quote = lib.parseMarkdown("> ".repeat(depth) + "leaf")[0];
  for (let i = 0; i < depth; i++) {
    assert.equal(quote.type, "quote", "quote depth " + i);
    quote = quote.blocks[0];
  }
  assert.equal(quote.type, "p");
  assert.equal(quote.inline[0].text, "leaf");
});

test("long blank continuations inside a list are scanned once", () => {
  const { spawnSync } = require("node:child_process");
  const source = path.join(__dirname, "..", "ui", "js", "markdown.js");
  const result = spawnSync(process.execPath, ["-e", `
    const vm = require('node:vm');
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const context = {};
    vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), context);
    const blocks = context.parseMarkdown('- first\\n' + '\\n'.repeat(50000) + '  continued\\n- next');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].items.length, 2);
    assert.equal(blocks[0].items[0].blocks[1].inline[0].text, 'continued');
  `, source], { encoding: "utf8", timeout: 2500 });
  assert.equal(result.status, 0, result.error ? String(result.error) : result.stderr);
});

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
  assert.equal(blocks[0].type, "p");
  assert.equal(inlineText(blocks[0].inline), "First line still first paragraph");
  assert.equal(inlineText(blocks[1].inline), "Second paragraph");
});

test("parseMarkdown: bold, italic, inline code", () => {
  const blocks = lib.parseMarkdown("Some **bold**, *italic*, and `code`.");
  const tokens = blocks[0].inline;
  assert.deepEqual(
    plain(tokens.map((t) => t.type)),
    ["text", "bold", "text", "italic", "text", "code", "text"],
  );
  assert.equal(inlineText(tokens.find((t) => t.type === "bold").children), "bold");
  assert.equal(inlineText(tokens.find((t) => t.type === "italic").children), "italic");
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
  assert.equal(inlineText(real[1].children), "italic");
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
  assert.deepEqual(plain(bullets[0].items.map((item) => inlineText(item.blocks[0].inline))), ["one", "two", "three"]);

  const numbered = lib.parseMarkdown("1. first\n2. second");
  assert.equal(numbered[0].type, "ol");
  assert.deepEqual(plain(numbered[0].items.map((item) => inlineText(item.blocks[0].inline))), ["first", "second"]);
});

test("parseMarkdown: a numbered list keeps its starting number (fix round 1, #2)", () => {
  const separate = lib.parseMarkdown("1. keep\n\n2. delete");
  assert.equal(separate.length, 2);
  assert.equal(separate[0].start, 1);
  assert.equal(separate[1].start, 2);

  // The detail now belongs to the first item. The next item still numbers 2,
  // rather than restarting at 1 in a separate list.
  const brokenByNesting = lib.parseMarkdown("1. **A**\n   - detail\n2. **B**");
  const ols = brokenByNesting.filter((b) => b.type === "ol");
  assert.equal(ols.length, 1);
  assert.equal(ols[0].start, 1);
  assert.equal(ols[0].items.length, 2);
  assert.equal(ols[0].start + 1, 2);
  assert.equal(inlineText(ols[0].items[1].blocks[0].inline), "B");
  assert.equal(ols[0].items[0].blocks[1].type, "ul");
  assert.equal(inlineText(ols[0].items[0].blocks[1].items[0].blocks[0].inline), "detail");

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
  assert.equal(blocks[0].blocks[0].type, "p");
  assert.equal(inlineText(blocks[0].blocks[0].inline), "Keep the old API? Options: keep, delete.");
});

test("parseMarkdown: a link shows as text (url), never a clickable link", () => {
  // Keep this regression's name; the v2 interface deliberately permits http(s).
  // Unsafe targets still show text with a tooltip and never become anchors.
  const blocks = lib.parseMarkdown("See [the docs](https://example.com/x) for more.");
  assert.equal(inlineText(blocks[0].inline), "See the docs for more.");
  assert.equal(blocks[0].inline[1].title, "https://example.com/x");
  assert.equal(blocks[0].inline[1].href, "https://example.com/x");
  const unsafe = lib.renderMarkdown("See [the docs](file:///C:/x) for more.", fakeDoc());
  assert.equal(flatten(unsafe), "See the docs for more.");
  assert.ok(!collectNodes(unsafe).some((n) => n.tag === "a"));
  assert.ok(collectNodes(unsafe).some((n) => n.title === "file:///C:/x"));
});

test("parseMarkdown: <script> and <img onerror> stay literal text (Review Focus 3)", () => {
  const dangerous = "<script>alert(1)</script> and <img src=x onerror=alert(2)>";
  const blocks = lib.parseMarkdown(dangerous);
  assert.equal(blocks[0].inline.map((t) => t.text).join(""), dangerous);
  assert.equal(flatten(lib.renderMarkdown(dangerous, fakeDoc())), dangerous);
});

test("parseMarkdown: CRLF input", () => {
  const blocks = lib.parseMarkdown("# Title\r\n\r\nBody text\r\n- item one\r\n- item two");
  assert.deepEqual(
    plain(blocks.map((b) => b.type)),
    ["heading", "p", "ul"],
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

// Same fixture as tests/plugin-task-result.test.js, which pins the expected values;
// the parity test below holds the UI's copy of the parser to the plugin's.
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

test("resultCardModel: sections, recorded edits merged into Changed files, question", () => {
  const text = "## Summary\nDid it.\n\n## Changes\n- x\n\n## Needs decision\nArchive sweep too?\n\n## Verification\nok";
  const model = plain(lib.resultCardModel(text, ["scripts/a.mjs", "scripts/b_c.js"]));
  assert.equal(model.plain, "");
  assert.deepEqual(model.sections.map((s) => s.heading), ["Summary", "Changed files"]);
  assert.equal(model.sections[0].body, "Did it.");
  assert.match(model.sections[1].body, /^Recorded file edits/);
  assert.match(model.sections[1].body, /`scripts\/b_c\.js`/, "paths as inline code, so _ is never emphasis");
  assert.equal(model.question, "Archive sweep too?");
});

test("resultCardModel: recorded edits Codex already listed are not repeated", () => {
  const text = "## Changed files\n- `scripts/a.mjs`\n\n## Checks run\nnpm test";
  const model = plain(lib.resultCardModel(text, ["D:\\repo\\scripts\\a.mjs", "scripts/b.mjs", "scripts/b.mjs", ""]));
  const changed = model.sections.find((s) => s.heading === "Changed files").body;
  assert.equal(changed.match(/a\.mjs/g).length, 1, "absolute backslash path matches Codex's relative entry");
  assert.equal(changed.match(/b\.mjs/g).length, 1, "duplicates collapse");
  assert.deepEqual(model.sections.map((s) => s.heading), ["Changed files", "Checks run"]);
  assert.equal(model.question, null);
});

test("resultCardModel: no known heading shows the plain answer, empty decision is no question", () => {
  const plainModel = plain(lib.resultCardModel("Done. Row count matches.\n", []));
  assert.equal(plainModel.plain, "Done. Row count matches.");
  assert.deepEqual(plainModel.sections, []);
  assert.equal(plainModel.question, null);
  // Only a Needs decision heading, answered "None": sections mode, nothing to ask.
  const none = plain(lib.resultCardModel("## Needs decision\nNone.", null));
  assert.equal(none.plain, "");
  assert.equal(none.question, null);
  assert.deepEqual(plain(lib.resultCardModel(null, undefined)), { plain: "", sections: [], question: null });
  // Codex answered above the headings and left Summary a stub: the answer still shows.
  const preface = plain(lib.resultCardModel("I printed 1, 2, 3, 4, 5 in order.\n\n## Summary\nCompleted.\n\n## Checks run\nnone", []));
  assert.equal(preface.plain, "I printed 1, 2, 3, 4, 5 in order.");
  assert.deepEqual(preface.sections.map((s) => s.heading), ["Summary", "Checks run"]);
});

test("answerTarget: newest finished run, thread idle, resume folder as resumeTarget", () => {
  const done = { id: "j2", threadId: "t", status: "completed", live: "completed", workspaceRoot: "D:\\w", cwd: "D:\\c", updatedAt: "2026-01-02" };
  const older = { id: "j1", threadId: "t", status: "completed", live: "completed", updatedAt: "2026-01-01" };
  const row = { job: done, project: "D:\\p" };
  assert.deepEqual(plain(lib.answerTarget(row, [done, older])), { threadId: "t", cwd: "D:\\w" });
  assert.deepEqual(plain(lib.answerTarget({ job: { ...done, workspaceRoot: "" }, project: "D:\\p" }, [done])), { threadId: "t", cwd: "D:\\c" });
  // Another run on the same thread still works (even an older-dated one): no answer box.
  for (const live of ["working", "possibly-stuck"]) {
    assert.equal(lib.answerTarget(row, [done, { ...older, status: "running", live }]), null, live);
  }
  assert.equal(lib.answerTarget(row, [done, { id: "q", threadId: "t", status: "queued" }]), null, "queued, no live yet");
  // A dead run on the thread, or work on another thread, does not block.
  assert.deepEqual(plain(lib.answerTarget(row, [done, { ...older, status: "running", live: "dead" }])), { threadId: "t", cwd: "D:\\w" });
  assert.deepEqual(plain(lib.answerTarget(row, [done, { id: "o", threadId: "other", live: "working" }])), { threadId: "t", cwd: "D:\\w" });
  // Not finished, or no thread to resume: none.
  assert.equal(lib.answerTarget({ job: { ...done, status: "failed", live: "failed" } }, []), null);
  assert.equal(lib.answerTarget({ job: { ...done, threadId: null } }, []), null);
  assert.equal(lib.answerTarget({ job: null, session: {} }, []), null);
  // The thread runs again (resumed in a terminal): answering here would start a second Codex.
  assert.equal(lib.answerTarget({ ...row, session: { status: "LIVE" } }, [done]), null, "LIVE session");
  // The session wrote after the run asked: answered outside the viewer, the box goes.
  const asked = Date.parse(done.updatedAt);
  assert.equal(lib.answerTarget({ ...row, session: { status: "IDLE", lastGrow: asked + 6000 } }, [done]), null, "answered elsewhere");
  assert.deepEqual(plain(lib.answerTarget({ ...row, session: { status: "IDLE", lastGrow: asked + 4000 } }, [done])), { threadId: "t", cwd: "D:\\w" }, "within 5 s");
});

test("resultCardModel: recorded edits match Codex's list by whole path, not substring", () => {
  const text = "## Changed files\n- `src/a.json`\n- `lib/b.js:12`.\n";
  const model = plain(lib.resultCardModel(text, ["src/a.js", "D:\\repo\\lib\\b.js"]));
  const changed = model.sections.find((s) => s.heading === "Changed files").body;
  assert.match(changed, /`src\/a\.js`/, "src/a.js is its own file, not part of src/a.json");
  assert.equal(changed.match(/b\.js/g).length, 1, "a line reference still names the listed file");
});

test("the UI section parser and the plugin's parser agree (ruling R3 drift guard)", async () => {
  const renderUrl = require("node:url").pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "render.mjs")).href;
  const { extractPreface, extractSection, readNeedsDecision } = await import(renderUrl);
  const inputs = [
    ANSWER, ANSWER.replace(/\n/g, "\r\n"),
    "### Needs Decision:\nPick a name?\n## Other\nx", "**Needs decision:**\nPick a name?",
    "## Needs decision\n**Keep the old API?**\n- keep\n- delete",
    "## Needs decision\nKeep the old API?\n**Options:**\n- keep\n- delete\n**Summary**\nx",
    ...["None", "none.", "-", "N/A", "", "None - all clear.", "No decision needed.", "No questions."].map((e) => `## Summary\nok\n## Needs decision\n${e}`),
    "No headings at all.", `## Needs decision\n${"q".repeat(3000)}`,
    "## Summary\nDid it.\n**Changed files:**\n- a.js\n# Top\nx", "**Checks run**:\nnpm test", null, undefined, "",
    "Template:\n```md\n## Needs decision\nPick one\n```\n\n## Summary\nDone\n\n## Needs decision\nNone"
  ];
  for (const text of inputs) {
    const label = String(JSON.stringify(text)).slice(0, 60);
    assert.equal(lib.readResultQuestion(text), readNeedsDecision(text), "question: " + label);
    assert.equal(lib.resultPreface(text), extractPreface(text), "preface: " + label);
    for (const heading of ["Summary", "Changed files", "Checks run", "Needs decision", "Missing"]) {
      assert.equal(lib.extractResultSection(text, heading), extractSection(text, heading), heading + ": " + label);
    }
  }
});

test("selectionInside: a non-empty selection that touches the feed holds its rebuild", () => {
  const feed = { contains: (node) => node === "in" };
  const sel = (text, anchorNode, focusNode) => ({ isCollapsed: !text, rangeCount: 1, toString: () => text, anchorNode, focusNode });
  assert.equal(lib.selectionInside(sel("abc", "in", "in"), feed), true);
  assert.equal(lib.selectionInside(sel("abc", "out", "in"), feed), true, "dragged in from outside");
  assert.equal(lib.selectionInside(sel("abc", "out", "out"), feed), false, "selection elsewhere on the page");
  assert.equal(lib.selectionInside(sel("", "in", "in"), feed), false, "a caret is not a selection");
  assert.equal(lib.selectionInside({ ...sel("abc", "in", "in"), rangeCount: 0 }, feed), false);
  assert.equal(lib.selectionInside(null, feed), false);
});
