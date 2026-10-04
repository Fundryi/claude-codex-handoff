const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const UI_STYLES = Object.freeze([
  "ui/theme.css",
  "ui/layout.css",
  "ui/marks.css",
  "ui/surfaces.css",
  "ui/feed.css",
  "ui/responsive.css",
]);
const UI_SCRIPTS = Object.freeze([
  "ui/js/state.js",
  "ui/js/markdown.js",
  "ui/js/highlight.js",
  "ui/js/content.js",
  "ui/js/feed-model.js",
  "ui/js/rows.js",
  "ui/js/workflow-model.js",
  "ui/js/tree-model.js",
  "ui/js/navigation.js",
  "ui/js/tree.js",
  "ui/js/header.js",
  "ui/js/marks.js",
  "ui/js/plans.js",
  "ui/js/node-header.js",
  "ui/js/feed.js",
  "ui/js/overview.js",
  "ui/js/pages.js",
  "ui/js/workflows.js",
  "ui/js/jobs.js",
  "ui/js/controls.js",
  "ui/js/boot.js",
]);
// Extraction input only: these modules are never evaluated as a combined script.
const SERVER_SOURCES = [
  "ai-live-viewer.js",
  ...[
    "runtime.js", "access.js", "jobs.js", "readers.js", "events.js", "usage.js",
    "sessions.js", "claude-workflows.js", "opencode.js", "claude-chats.js",
    "discovery.js", "media.js", "http.js",
  ].map((file) => "server/" + file),
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function uiScript() {
  return UI_SCRIPTS.map(read).join("\n");
}

function uiCss() {
  return UI_STYLES.map(read).join("\n");
}

function uiSource() {
  const index = read("ui/index.html");
  const styles = [...index.matchAll(/<link\b[^>]*>/gi)]
    .filter(([tag]) => /\brel\s*=\s*(["'])stylesheet\1/i.test(tag))
    .map(([tag]) => tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2]);
  const scripts = [...index.matchAll(/<script\b[^>]*>/gi)]
    .map(([tag]) => tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2])
    .filter((src) => src !== undefined);
  assert.deepEqual(styles, UI_STYLES.map((file) => "/" + file), "ui/index.html stylesheet order");
  assert.deepEqual(scripts, UI_SCRIPTS.map((file) => "/" + file), "ui/index.html script order");
  // Test-only envelope for existing regex + vm extraction; this is never served.
  return index + "\n<style>\n" + uiCss() +
    "\n</style>\n<script>\n" + uiScript() + "\n</script>\n";
}

function serverSource() {
  return SERVER_SOURCES.map(read).join("\n");
}

module.exports = { uiSource, uiScript, uiCss, serverSource, UI_SCRIPTS, UI_STYLES, SERVER_SOURCES };
