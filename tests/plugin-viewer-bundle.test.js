const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { uiSource, UI_STYLES, UI_SCRIPTS, SERVER_SOURCES } = require("./helpers/source");

const rootDir = path.join(__dirname, "..");
const bundleDir = path.join(rootDir, "plugin", "viewer");

function regularFiles(dir, relative = "") {
  assert.ok(fs.lstatSync(path.join(dir, relative)).isDirectory(), "Expected directory: " + path.join(dir, relative));
  return fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isDirectory()) return regularFiles(dir, file);
    assert.ok(entry.isFile(), "Unsupported file type: " + path.join(dir, file));
    return [file];
  }).sort();
}

const files = ["ai-live-viewer.js", "assets/logo.svg", ...regularFiles(rootDir, "ui"), ...regularFiles(rootDir, "server")].sort();

test("ui/index.html references the fixed helper asset lists in order", () => {
  uiSource();
  const { UI_ASSET_FILES } = require("../server/http");
  assert.deepEqual([...UI_ASSET_FILES.values()].map(([file]) => file), ["ui/index.html", "assets/logo.svg", ...UI_STYLES, ...UI_SCRIPTS]);
  assert.deepEqual(SERVER_SOURCES.filter((file) => file.startsWith("server/")).sort(), regularFiles(rootDir, "server"));
});

test("plugin/viewer has exactly the runtime file set and no legacy viewer-ui.html", () => {
  assert.equal(fs.existsSync(path.join(bundleDir, "viewer-ui.html")), false, "remove stale plugin/viewer/viewer-ui.html (run: npm run sync:viewer)");
  assert.deepEqual(regularFiles(bundleDir), files, "plugin/viewer relative paths (run: npm run sync:viewer)");
});

for (const f of files) {
  test(`plugin/viewer/${f} is byte-identical to the repo copy (run: npm run sync:viewer)`, () => {
    assert.ok(fs.lstatSync(path.join(rootDir, ...f.split("/"))).isFile(), "Expected regular source file: " + f);
    assert.ok(fs.lstatSync(path.join(bundleDir, ...f.split("/"))).isFile(), "Expected regular bundled file: " + f);
    const root = fs.readFileSync(path.join(rootDir, ...f.split("/")));
    const bundled = fs.readFileSync(path.join(bundleDir, ...f.split("/")));
    assert.deepEqual(bundled, root);
  });
}
