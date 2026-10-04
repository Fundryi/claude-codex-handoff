#!/usr/bin/env node
'use strict';

// Copy runtime sources only. The server and UI have no build step.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'plugin', 'viewer');
const requiredUi = [
  'index.html',
  'theme.css', 'layout.css', 'marks.css', 'surfaces.css', 'feed.css', 'responsive.css',
  ...[
    'state.js', 'markdown.js', 'feed-model.js', 'rows.js', 'workflow-model.js',
    'tree-model.js', 'navigation.js', 'tree.js', 'header.js', 'marks.js',
    'plans.js', 'node-header.js', 'feed.js', 'overview.js', 'pages.js',
    'workflows.js', 'jobs.js', 'controls.js', 'boot.js',
  ].map(name => 'js/' + name),
];

function regularFile(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('Expected regular file: ' + file);
}

function statIfPresent(file) {
  try { return fs.lstatSync(file); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function treeFiles(dir) {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Expected directory: ' + dir);
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) files.push(...treeFiles(file));
    else if (stat.isFile()) files.push(file);
    else throw new Error('Unsupported file type: ' + file);
  }
  return files;
}

// Resolve every destination and reject links before any write or deletion.
function bundlePath(relative, directory = false) {
  const target = path.resolve(bundle, relative);
  const within = path.relative(bundle, target);
  if (!within || within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) {
    throw new Error('Path is outside plugin/viewer: ' + target);
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const stat = statIfPresent(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error('Linked destination is not allowed: ' + current);
    }
    const expectsDirectory = current !== target || directory;
    if (expectsDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error('Unexpected destination file type: ' + current);
    }
  }
  return target;
}

// Validate the complete source inventory before changing generated files.
const sources = ['ai-live-viewer.js', 'assets/logo.svg'];
for (const relative of sources) regularFile(path.join(root, relative));
treeFiles(path.join(root, 'assets'));
const uiRoot = path.join(root, 'ui');
const uiFiles = treeFiles(uiRoot);
for (const relative of requiredUi) regularFile(path.join(uiRoot, relative));
sources.push(...uiFiles.map(file => path.relative(root, file)));

const serverRoot = path.join(root, 'server');
const serverFiles = treeFiles(serverRoot);
for (const name of [
  'runtime.js', 'access.js', 'jobs.js', 'readers.js', 'events.js', 'usage.js',
  'sessions.js', 'claude-workflows.js', 'opencode.js', 'claude-chats.js',
  'discovery.js', 'http.js',
]) regularFile(path.join(serverRoot, name));
sources.push(...serverFiles.map(file => path.relative(root, file)));

const copies = sources.map(relative => [path.join(root, relative), bundlePath(relative)]);
const uiTarget = bundlePath('ui', true);
const serverTarget = bundlePath('server', true);
const previous = [uiTarget, serverTarget].flatMap(target => statIfPresent(target) ? treeFiles(target) : []);
const destinations = new Set(copies.map(([, target]) => target));
const stale = previous.filter(file => !destinations.has(file));
for (const name of ['viewer-ui.html', 'codex-live-viewer.js']) {
  const legacy = bundlePath(name);
  if (statIfPresent(legacy)) {
    regularFile(legacy);
    stale.push(legacy);
  }
}
for (const file of stale) bundlePath(path.relative(bundle, file));

for (const [source, target] of copies) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
for (const file of stale) {
  // Verify the resolved deletion path again at the point of removal.
  fs.rmSync(bundlePath(path.relative(bundle, file)));
}
console.log('Synced ' + copies.length + ' files; removed ' + stale.length + ' stale files.');
