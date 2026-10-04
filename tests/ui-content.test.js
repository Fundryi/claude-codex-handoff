const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const lib = {};
for (const name of ['highlight', 'content']) {
  const file = path.join(root, 'ui/js/' + name + '.js');
  if (fs.existsSync(file)) vm.runInNewContext(fs.readFileSync(file, 'utf8'), lib);
}
const plain = value => JSON.parse(JSON.stringify(value));
const types = new Set(['keyword', 'string', 'number', 'comment', 'function', 'type', 'punct', 'plain']);

test('format detection handles unterminated links linearly and bounds classification', () => {
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
    const c = {};
    vm.runInNewContext(fs.readFileSync(process.argv[1], 'utf8'), c);
    for (const n of [32000, 64000, 200000]) assert.equal(c.detectFormat('['.repeat(n)), 'plain');
    assert.equal(c.detectFormat(('a]('.repeat(10000))), 'plain');
    assert.equal(c.detectFormat('[Read](https://example.com)'), 'markdown');
    assert.equal(c.detectFormat('*bold*' + 'x'.repeat(210000)), 'plain');
    assert.equal(c.detectFormat('x'.repeat(210000), 'markdown'), 'markdown');
  `, path.join(root, 'ui/js/content.js')], { encoding: 'utf8', timeout: 2500 });
  assert.equal(result.status, 0, result.error ? String(result.error) : result.stderr);
});

test('Copy diff preserves Copied through a rebuild independently of Copy', () => {
  const c = { setTimeout() {}, navigator: { clipboard: { writeText() {} } } };
  for (const name of ['highlight', 'content']) vm.runInNewContext(fs.readFileSync(path.join(root, 'ui/js/' + name + '.js'), 'utf8'), c);
  const doc = { createElement(tag) {
    const n = { tag, children: [], style: {}, className: '', appendChild(child) { this.children.push(child); return child; } };
    n.classList = { toggle(cls, on) { const names = n.className.split(' ').filter(x => x && x !== cls); if (on) names.push(cls); n.className = names.join(' '); } };
    return n;
  }, createTextNode: text => ({ textContent: text }), createDocumentFragment() { return this.createElement('fragment'); } };
  const diff = '--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new';
  let result = c.renderDiff(diff, { key: 'scope|patch' }, doc);
  let buttons = result.children[0].children[0].children.filter(n => n.tag === 'button');
  buttons.find(n => n.textContent === 'Copy diff').onclick();
  result = c.renderDiff(diff, { key: 'scope|patch' }, doc);
  buttons = result.children[0].children[0].children.filter(n => n.tag === 'button');
  assert.deepEqual(buttons.map(n => n.textContent), ['Wrap', 'Copy', 'Copied']);
});

test('highlight keeps every character and tags keywords, strings, calls, types and numbers', () => {
  const code = "const a = 'x'; // note\nfunction f() { return new Widget(42); }\r\n\t🙂";
  const tokens = plain(lib.highlight(code, 'js'));
  assert.equal(tokens.map(t => t.text).join(''), code);
  for (const [type, text] of [['keyword', 'const'], ['number', '42'], ['string', "'x'"], ['type', 'Widget']]) {
    assert.ok(tokens.some(t => t.type === type && t.text === text), type);
  }
  assert.ok(tokens.some(t => t.type === 'comment'));
  assert.ok(tokens.some(t => t.type === 'function' && t.text === 'f'));
  assert.ok(tokens.every(t => types.has(t.type) && Object.keys(t).sort().join() === 'text,type'));
});

test('highlight gives meaningful tokens for every supported language', () => {
  const samples = {
    ts: 'interface User { id: number; }', json: '{"a": 42}', py: 'def f():\n  return "yes" # note',
    sh: 'if true; then echo "$HOME"; fi # note', ps1: 'function Get-X { Write-Host "x" } # note',
    php: '<?php function f() { return 42; }', rust: 'fn main() { let x = 42; }',
    css: '/* note */ .x { color: "red"; }', html: '<!-- note --><div id="x">text</div>',
    sql: 'SELECT * FROM users WHERE id = 42; -- note', yaml: 'key: "value" # note',
    toml: '[table]\nkey = 42 # note', md: '# Title\n**bold** and `code`', diff: '@@ -1 +1 @@\n-old\n+new',
  };
  for (const [lang, code] of Object.entries(samples)) {
    const tokens = plain(lib.highlight(code, lang));
    assert.equal(tokens.map(t => t.text).join(''), code, lang);
    assert.ok(tokens.some(t => t.type !== 'plain'), lang);
  }
  assert.deepEqual(plain(lib.highlight('x', 'brainfuck')), [{ text: 'x', type: 'plain' }]);
});

test('highlight limits lines and UTF-8 bytes before tokenizing', () => {
  const cap = 200 * 1024;
  for (const code of ['const x = 1;\n'.repeat(3001), 'x'.repeat(cap + 1), '🙂'.repeat(cap / 4 + 1)]) {
    assert.deepEqual(plain(lib.highlight(code, 'js')), [{ text: code, type: 'plain' }]);
  }
  assert.ok(lib.highlight('const\n'.repeat(2999) + 'const', 'js').some(t => t.type === 'keyword'));
  assert.ok(lib.highlight('const ' + ' '.repeat(cap - 6), 'js').some(t => t.type === 'keyword'));
});

test('highlight handles half-written strings and comments without losing text', () => {
  for (const code of ['const x = "half', '/* unclosed\ncomment', '`template ${x}', "'\\", '\u001b[31m<x>']) {
    assert.equal(lib.highlight(code, 'js').map(t => t.text).join(''), code);
  }
});

test('highlight separates subtraction from identifiers and colors TypeScript templates', () => {
  const js = plain(lib.highlight('return-x', 'js'));
  assert.ok(js.some(t => t.type === 'keyword' && t.text === 'return'));
  assert.ok(js.some(t => t.type === 'punct' && t.text === '-'));
  assert.ok(lib.highlight('const value = `hello ${name}`', 'ts').some(t => t.type === 'string' && t.text === '`hello ${name}`'));
});

test('languageOf maps canonical ids, aliases and Windows or POSIX file extensions', () => {
  for (const [name, expected] of Object.entries({
    javascript: 'js', JSX: 'js', typescript: 'ts', tsx: 'ts', python: 'py', bash: 'sh',
    shell: 'sh', console: 'sh', powershell: 'ps1', pwsh: 'ps1', rs: 'rust', yml: 'yaml',
    xml: 'html', markdown: 'md', patch: 'diff', 'D:/x/server/http.js': 'js',
    'C:\\repo\\file.PS1': 'ps1', 'Cargo.toml': 'toml', 'a.d.ts': 'ts', '.bashrc': 'sh',
  })) assert.equal(lib.languageOf(name), expected, name);
  for (const lang of ['js', 'ts', 'json', 'py', 'sh', 'ps1', 'php', 'rust', 'css', 'html', 'sql', 'yaml', 'toml', 'md', 'diff']) {
    assert.equal(lib.languageOf(lang), lang);
  }
  assert.equal(lib.languageOf('nothing'), '');
  assert.equal(lib.languageOf('file.unknown'), '');
});

test('detectFormat honors hints and the ordered ANSI, diff, JSON, sections, Markdown, plain rules', () => {
  for (const [text, expected] of [
    ['\u001b[31mred\u001b[0m', 'ansi'],
    ['diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b', 'diff'],
    ['@@ -1 +1 @@\n old\n-new\n+newer', 'diff'],
    ['{"a": [1, 2]}', 'json'], ['[1, 2]', 'json'],
    ['<goal>Do it.</goal>\n<rules>None.</rules>', 'sections'],
    ['## Summary\n- one', 'markdown'], ['**bold**', 'markdown'],
    ['| a | b |\n| --- | --- |', 'markdown'], ['~~~js\nconst x = 1', 'markdown'],
    ['<goal>\nhalf written', 'markdown'], ['plain words', 'plain'], ['', 'plain'],
    ['{"half":', 'plain'], ['A report\ndiff --git a/x b/x\nmore prose\neven more prose', 'plain'],
  ]) assert.equal(lib.detectFormat(text), expected, text);
  assert.equal(lib.detectFormat('\u001b[31m{x}', 'json'), 'json');
  assert.equal(lib.detectFormat('x', 'code'), 'code');
});

test('detectFormat and prettyJson reject oversized JSON and invalid input', () => {
  for (const text of ['["' + 'x'.repeat(200 * 1024) + '"]', '["' + '🙂'.repeat(52000) + '"]']) {
    assert.notEqual(lib.detectFormat(text), 'json');
    assert.equal(lib.prettyJson(text), null);
  }
  assert.equal(lib.prettyJson('{"a":[1,2]}'), '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(lib.prettyJson('{half'), null);
  assert.equal(lib.prettyJson('true'), 'true');
  assert.equal(lib.prettyJson('null'), 'null');
});

test('parseAnsi keeps text, maps basic colors and resets each independent attribute', () => {
  const input = '\u001b[31;44;1mERR\u001b[22m normal\u001b[39m fg\u001b[49m bg\u001b[0m end';
  assert.deepEqual(plain(lib.parseAnsi(input)), [
    { text: 'ERR', fg: 'red', bg: 'blue', bold: true },
    { text: ' normal', fg: 'red', bg: 'blue', bold: false },
    { text: ' fg', fg: null, bg: 'blue', bold: false },
    { text: ' bg end', fg: null, bg: null, bold: false },
  ]);
  assert.deepEqual(plain(lib.parseAnsi('\u001b[91;104mbright\u001b[mplain')), [
    { text: 'bright', fg: 'bright-red', bg: 'bright-blue', bold: false },
    { text: 'plain', fg: null, bg: null, bold: false },
  ]);
});

test('parseAnsi drops OSC hyperlinks, other escape families, unsupported SGR and incomplete escapes', () => {
  const input = 'A\u001b]8;;http://evil\u001b\\link\u001b]8;;\u0007B\u001b[2JC\u001bPsecret\u001b\\D\u001b(0E\u001b[999mF\u001b]unfinished';
  assert.equal(lib.parseAnsi(input).map(s => s.text).join(''), 'AlinkBCDEF');
  assert.equal(lib.parseAnsi('ok\u001b[31').map(s => s.text).join(''), 'ok');
  assert.equal(lib.parseAnsi('ok\u001b').map(s => s.text).join(''), 'ok');
  assert.deepEqual(plain(lib.parseAnsi('')), []);
});

test('parseAnsi maps indexed and truecolor foregrounds and backgrounds to the nearest palette color', () => {
  const result = plain(lib.parseAnsi('\u001b[38;5;1;48;5;12mx\u001b[38;2;255;0;0;48;2;0;0;128my'));
  assert.deepEqual(result, [
    { text: 'x', fg: 'red', bg: 'bright-blue', bold: false },
    { text: 'y', fg: 'bright-red', bg: 'blue', bold: false },
  ]);
  assert.equal(lib.parseAnsi('\u001b[38;5;196mred')[0].fg, 'bright-red');
  assert.equal(lib.parseAnsi('\u001b[38;5;999mplain')[0].fg, null);
});

test('parseAnsi accepts colon-delimited indexed and truecolor SGR', () => {
  const segments = plain(lib.parseAnsi('\u001b[38:5:1;48:2::0:0:128mx\u001b[38:2:255:0:0my'));
  assert.deepEqual(segments, [
    { text: 'x', fg: 'red', bg: 'blue', bold: false },
    { text: 'y', fg: 'bright-red', bg: 'blue', bold: false },
  ]);
});

test('parseDiff reads paths, hunks, line numbers and counts', () => {
  const files = plain(lib.parseDiff('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n x\n-old\n+new\n\\ No newline at end of file'));
  assert.deepEqual(files, [{ path: 'a.js', oldPath: 'a.js', op: 'update', added: 1, removed: 1, hunks: [{
    header: '@@ -1,2 +1,2 @@', lines: [
      { kind: 'ctx', text: 'x', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'old', oldNo: 2, newNo: null },
      { kind: 'add', text: 'new', oldNo: null, newNo: 2 },
      { kind: 'meta', text: '\\ No newline at end of file', oldNo: null, newNo: null },
    ],
  }] }]);
});

test('parseDiff handles multiple files, add/delete, rename and repeated hunks', () => {
  const text = 'diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/old.js b/new.js\nrename from old.js\nrename to new.js\n--- a/old.js\n+++ b/new.js\n@@ -2 +2 @@\n-a\n+b\n@@ -10 +11 @@\n x';
  const files = plain(lib.parseDiff(text));
  assert.deepEqual(files.map(f => [f.path, f.oldPath, f.op, f.added, f.removed]), [
    ['new.txt', '/dev/null', 'add', 2, 0], ['old.txt', 'old.txt', 'delete', 0, 1], ['new.js', 'old.js', 'update', 1, 1],
  ]);
  assert.deepEqual(files[2].hunks[1].lines[0], { kind: 'ctx', text: 'x', oldNo: 10, newNo: 11 });
});

test('parseDiff accepts header-only unified diffs, CRLF and header-looking content inside hunks', () => {
  const text = '--- a/path with spaces.txt\told\r\n+++ b/path with spaces.txt\tnew\r\n@@ -1,2 +1,2 @@\r\n--- old text\r\n+++ new text\r\n same\r\n';
  const files = plain(lib.parseDiff(text));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'path with spaces.txt');
  assert.equal(files[0].hunks[0].lines[0].text, '-- old text');
  assert.equal(files[0].hunks[0].lines[1].text, '++ new text');
  assert.deepEqual(plain(lib.parseDiff('plain words')), []);
});

test('parseDiff rename paths keep real leading a/ or b/ directories', () => {
  const files = plain(lib.parseDiff('diff --git a/a/old.js b/b/new.js\nrename from a/old.js\nrename to b/new.js'));
  assert.equal(files[0].oldPath, 'a/old.js');
  assert.equal(files[0].path, 'b/new.js');
});

test('parseDiff accepts a hunk-only diff recognized by detectFormat', () => {
  const text = '@@ -1 +1 @@\n-old\n+new';
  assert.equal(lib.detectFormat(text), 'diff');
  const files = plain(lib.parseDiff(text));
  assert.equal(files.length, 1);
  assert.deepEqual([files[0].path, files[0].oldPath, files[0].op, files[0].added, files[0].removed], ['', '', 'update', 1, 1]);
});

test('parseSections splits inline and multiline tags, preserves bodies and labels done_when', () => {
  assert.deepEqual(plain(lib.parseSections('Intro\n<goal>\nShip it.\n</goal>\n<done_when>Tests pass.</done_when>\nTail')), [
    { tag: '', label: '', body: 'Intro' }, { tag: 'goal', label: 'Goal', body: 'Ship it.' },
    { tag: 'done_when', label: 'Done when', body: 'Tests pass.' }, { tag: '', label: '', body: 'Tail' },
  ]);
  assert.equal(lib.parseSections('<goal>Use <detail>x</detail>.</goal>')[0].body, 'Use <detail>x</detail>.');
});

test('parseSections rejects unbalanced, streaming, attributed or mainly prose tags and fenced examples', () => {
  for (const text of ['<goal>\nhalf written', '<goal>x</rules>', '<goal>x</goal><rules>half',
    '<GOAL>x</GOAL>', '<goal id="x">x</goal>', 'ordinary prose '.repeat(30) + '<goal>x</goal>',
    '```xml\n<goal>x</goal>\n```', '`<goal>x</goal>`', 'words only']) {
    assert.equal(lib.parseSections(text), null, text);
  }
});

test('stripMarkdown makes a clean first-sentence preview with an optional heading', () => {
  for (const [text, expected] of [
    ['## Summary\nUpdated **packaging** for `ui/`. More text.', 'Summary: Updated packaging for ui/.'],
    ['<goal>Ship **it**.</goal><rules>More.</rules>', 'Ship it.'],
    ['[Read this](https://example.com) and ![image](data:image/png;base64,x). Later.', 'Read this and image.'],
    ['- [x] Fix ~~old~~ *markup*. Later.', 'Fix old markup.'],
    ['__Bold__ and _italic_. Later.', 'Bold and italic.'],
    ['Use `file.js` now! Then continue.', 'Use file.js now!'],
    ['```js\nconst x = 1;\n```', 'const x = 1;'],
    ['<img src=x onerror=evil>safe text', 'safe text'], ['', ''],
  ]) assert.equal(lib.stripMarkdown(text), expected, text);
  assert.equal(lib.stripMarkdown('x'.repeat(500)).length, 200);
});

test('firstLine previews use stripMarkdown and retain their length limit', () => {
  const state = fs.readFileSync(path.join(root, 'ui/js/state.js'), 'utf8');
  vm.runInNewContext(state.match(/function firstLine\([^]*?\n    }/)[0], lib);
  assert.equal(lib.firstLine('**Thinking** about `files`. Next.', 140), 'Thinking about files.');
  assert.equal(lib.firstLine('a'.repeat(220), 60).length, 60);
  const feed = fs.readFileSync(path.join(root, 'ui/js/feed.js'), 'utf8');
  assert.match(feed, /moreSummary\.textContent = stripMarkdown\(body\)/);
});

test('firstLine remains callable when extracted alone by legacy view-model checks', () => {
  const state = fs.readFileSync(path.join(root, 'ui/js/state.js'), 'utf8');
  const isolated = {};
  vm.runInNewContext(state.match(/function firstLine\([^]*?\n    }/)[0], isolated);
  assert.equal(isolated.firstLine('normal   words', 60), 'normal words');
});
