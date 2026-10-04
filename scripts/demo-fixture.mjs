#!/usr/bin/env node
// Invented data only. Import startDemo() for automation, or run this file and
// press Ctrl+C to stop. The viewer and every default data path use a temp home.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = 8398;
export const CHAT_ID = '22222222-2222-4222-8222-000000000001';
export const RUN_ID = 'wf_demo-checkout';
export const FINISHED_JOB = 'task-demo001-cafe01';
const RUNNING_JOB = 'task-demo002-cafe02';
const SHOP = 'C:/Users/dev/projects/acme-shop';
const iso = ms => new Date(ms).toISOString();

// Same rollout builders and companion state layout as ui-fixture.mjs.
function metaLine(ts, id, cwd, handoff) {
  return JSON.stringify({ timestamp: iso(ts), type: 'session_meta', payload: {
    id, timestamp: iso(ts), cwd, model: 'gpt-6.1-sol',
    originator: handoff ? 'Claude Code' : 'codex_cli_rs', cli_version: '0.153.0',
  } });
}
function eventLine(ts, type, message) {
  return JSON.stringify({ timestamp: iso(ts), type: 'event_msg', payload: { type, ...(message ? { message } : {}) } });
}
function cmdLine(ts, command) {
  return JSON.stringify({ timestamp: iso(ts), type: 'response_item', payload: {
    type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }),
  } });
}
function outputLine(ts, output) {
  return JSON.stringify({ timestamp: iso(ts), type: 'response_item', payload: { type: 'function_call_output', output } });
}
function claudeLine(ts, type, content, extra = {}) {
  return { type, timestamp: iso(ts), sessionId: CHAT_ID, cwd: SHOP, entrypoint: 'cli', version: '2.1.284',
    ...extra, message: { role: type, content, ...(type === 'assistant' ? {
      id: 'msg-demo-' + ts, model: 'claude-opus-4-6', stop_reason: 'end_turn',
      usage: { input_tokens: 2400, cache_read_input_tokens: 18000, output_tokens: 740 },
    } : {}), ...extra.message } };
}
function textBlock(text) { return { type: 'text', text }; }
function write(file, content, at) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (at) fs.utimesSync(file, new Date(at), new Date(at));
  return file;
}
function json(file, value, at) { return write(file, JSON.stringify(value, null, 2) + '\n', at); }
function jsonl(file, lines, at) { return write(file, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n', at); }

const RESULT = `## Summary
Added accessible checkout validation. Each field now explains how to fix an error, and focus moves to the first invalid field.

## Changed files
- \`src/checkout/validation.ts\` — validate required fields before submitting.
- \`src/checkout/CheckoutForm.tsx\` — connect error text with aria-describedby.
- \`src/checkout/checkout.css\` — add visible focus and error styles.

## Checks run
- \`npm test -- checkout\` — 18 checks passed.
- \`npm run lint\` — passed.
- Chrome: keyboard navigation, empty form and corrected submission verified.

## Needs decision
None`;

function buildData(root, now) {
  const codex = path.join(root, '.codex');
  const claude = path.join(root, '.claude');
  const state = path.join(root, '.codex-companion', 'state');
  for (const dir of [path.join(codex, 'sessions'), path.join(codex, 'archived_sessions'), state, path.join(claude, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
  function rollout(index, cwd, title, result, age, running = false, handoff = false) {
    const id = '11111111-1111-4111-8111-' + String(index).padStart(12, '0');
    const ts = now - age * 60000;
    const day = iso(ts).slice(0, 10).split('-');
    const stamp = iso(ts).replace(/[:.]/g, '-').slice(0, 19);
    const area = cwd === SHOP ? 'checkout' : cwd.endsWith('docs-site') ? 'docs' : 'webhooks';
    const lines = [metaLine(ts, id, cwd, handoff), eventLine(ts + 500, 'user_message', title), eventLine(ts + 1000, 'task_started'),
      eventLine(ts + 3000, 'agent_message', 'I will check the existing behavior, make the focused change, and verify it in Chrome.'),
      cmdLine(ts + 6000, `rg -n "${area}" src`), outputLine(ts + 9000, `Found the existing ${area} entry point and its checks.`),
      eventLine(ts + 20000, 'agent_message', running ? result : 'The implementation is ready. I am checking the form with keyboard navigation.'),
      cmdLine(ts + 24000, `npm test -- ${area}`), outputLine(ts + 30000, '18 checks passed. No failures.'),
      JSON.stringify({ timestamp: iso(ts + 31000), type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { total_tokens: 38400 + index * 2400 }, last_token_usage: { total_tokens: 14200 + index * 800 }, model_context_window: 272000,
      } } })];
    if (!running) lines.push(eventLine(ts + 45000, 'agent_message', result), eventLine(ts + 46000, 'task_complete'));
    const file = jsonl(path.join(codex, 'sessions', ...day, `rollout-${stamp}-${id}.jsonl`), lines, running ? now : ts + 46000);
    return { id, file, ts };
  }
  const finished = rollout(1, SHOP, 'Add accessible checkout validation', RESULT, 12, false, true);
  const running = rollout(2, SHOP, 'Review checkout edge cases', 'Checking slow responses, repeated submits and the recovery path after a network error.', 5, true, true);
  rollout(3, 'C:/Users/dev/projects/docs-site', 'Improve the quickstart guide', 'Updated the quickstart with a working local setup example and clearer navigation. Verified all internal links and built the site.', 34);
  rollout(4, 'C:/Users/dev/projects/billing-api', 'Handle duplicate webhook delivery', 'Added an idempotency guard around invoice events. Replayed the same sample event twice; the invoice was created once.', 55);
  const jobs = [
    { id: FINISHED_JOB, cwd: SHOP, kind: 'task', title: 'Add accessible checkout validation', status: 'completed', pid: null,
      threadId: finished.id, sessionId: CHAT_ID, summary: 'Accessible field errors and keyboard focus verified.', needsDecision: '',
      createdAt: iso(finished.ts), updatedAt: iso(finished.ts + 46000), completedAt: iso(finished.ts + 46000) },
    { id: RUNNING_JOB, cwd: SHOP, kind: 'review', title: 'Review checkout edge cases', status: 'running', pid: process.pid,
      threadId: running.id, sessionId: CHAT_ID, createdAt: iso(running.ts), updatedAt: iso(now), heartbeatAt: iso(now) },
  ];
  const stateDir = path.join(state, 'demo-workspace-0000000000000000');
  function saveJobs() {
    json(path.join(stateDir, 'state.json'), { version: 1, config: { stopReviewGate: false }, jobs });
    for (const job of jobs) json(path.join(stateDir, 'jobs', job.id + '.json'), {
      ...job, ...(job.id === FINISHED_JOB ? { result: { rawOutput: RESULT, touchedFiles: ['src/checkout/validation.ts', 'src/checkout/CheckoutForm.tsx', 'src/checkout/checkout.css'] }, rendered: RESULT } : {}),
    });
  }
  saveJobs();
  const project = path.join(claude, 'projects', 'C--Users-dev-projects-acme-shop');
  const chatFile = jsonl(path.join(project, CHAT_ID + '.jsonl'), [
    claudeLine(now - 20 * 60000, 'user', 'Make checkout errors easier to understand and verify the flow before we ship.'),
    { type: 'ai-title', sessionId: CHAT_ID, aiTitle: 'Polish the checkout experience', timestamp: iso(now - 19 * 60000) },
    claudeLine(now - 13 * 60000, 'assistant', [textBlock('I have handed the validation change to Codex. A workflow will check accessibility, error recovery and release readiness.'),
      { type: 'tool_use', id: 'launch-validation', name: 'Bash', input: { command: 'node tools/codex-companion.mjs task --background "Add accessible checkout validation"' } }], { message: { stop_reason: 'tool_use' } }),
    claudeLine(now - 12 * 60000, 'user', [{ type: 'tool_result', tool_use_id: 'launch-validation', content: `Codex job: ${FINISHED_JOB} · thread: ${finished.id}` }]),
    claudeLine(now - 6 * 60000, 'assistant', [{ type: 'tool_use', id: 'launch-review', name: 'Bash', input: { command: 'node tools/codex-companion.mjs review --background "Review checkout edge cases"' } }], { message: { stop_reason: 'tool_use' } }),
    claudeLine(now - 5 * 60000, 'user', [{ type: 'tool_result', tool_use_id: 'launch-review', content: `Codex job: ${RUNNING_JOB} · thread: ${running.id}` }]),
    claudeLine(now - 4000, 'assistant', [textBlock('The validation change has passed its checks. I am comparing the workflow findings while Codex finishes the edge-case review.')], { message: { stop_reason: null }, effort: 'high' }),
  ], now);
  json(path.join(claude, 'sessions', process.pid + '.json'), { pid: process.pid, sessionId: CHAT_ID, status: 'working' });
  const sessionDir = path.join(project, CHAT_ID);
  const runDir = path.join(sessionDir, 'subagents', 'workflows', RUN_ID);
  const phases = ['Inspect', 'Verify'];
  write(path.join(sessionDir, 'workflows', 'scripts', `checkout-review-${RUN_ID}.js`), `export const meta = {
  name: 'Checkout readiness',
  description: 'Review keyboard access, error recovery and release checks.',
  phases: [{ title: 'Inspect' }, { title: 'Verify' }]
};\n`);
  const journal = [{ type: 'launched', timestamp: iso(now - 9 * 60000) }];
  const progress = [];
  const topics = [
    ['Accessibility', 'Check labels and error announcements', 'Verify keyboard focus', 'All form controls have labels. Field errors are announced and the first invalid field receives focus.'],
    ['Error recovery', 'Inspect failed submissions', 'Verify retry behavior', 'The form preserves entered values after a network failure. Retry sends one request and clears the error after success.'],
    ['Release checks', 'Review validation changes', 'Run checkout smoke checks', 'The patch is focused and all checkout checks pass. No dependency or configuration changes are required.'],
  ];
  let count = 0;
  for (const [topic, inspect, verify, finding] of topics) {
    for (const [phase, description] of [['Inspect', inspect], ['Verify', verify]]) {
      const id = 'a' + String(++count).padStart(6, '0');
      const label = `${phase.toLowerCase()}:${topic}:${description}`;
      const start = now - (phase === 'Inspect' ? 9 : 7) * 60000 + count * 1000;
      const end = start + 70000;
      journal.push({ type: 'started', agentId: id, label, phase, timestamp: iso(start) }, { type: 'result', agentId: id, label, phase, timestamp: iso(end), result: finding });
      jsonl(path.join(runDir, 'agent-' + id + '.jsonl'), [
        claudeLine(start, 'user', description),
        claudeLine(start + 5000, 'assistant', [{ type: 'thinking', thinking: 'Check the existing flow and record concrete evidence for the readiness review.' },
          { type: 'tool_use', id: 'check-' + id, name: 'Bash', input: { command: phase === 'Inspect' ? 'rg -n "onSubmit|aria-describedby" src/checkout' : 'npm test -- checkout' } }], { message: { stop_reason: 'tool_use' } }),
        claudeLine(start + 25000, 'user', [{ type: 'tool_result', tool_use_id: 'check-' + id, content: phase === 'Inspect' ? 'Validation and error wiring found in CheckoutForm.tsx.' : '18 checks passed. No failures.' }]),
        claudeLine(end, 'assistant', [textBlock(finding)], { effort: 'high' }),
      ], end);
      json(path.join(runDir, 'agent-' + id + '.meta.json'), { description: label, workflowPhase: phase });
      progress.push({ agentId: id, label, phaseTitle: phase, lastProgressAt: end, state: 'done', model: 'claude-opus-4-6' });
    }
  }
  jsonl(path.join(runDir, 'journal.jsonl'), journal, now - 5 * 60000);
  json(path.join(sessionDir, 'workflows', RUN_ID + '.json'), {
    status: 'completed', startTime: now - 9 * 60000, timestamp: iso(now - 4 * 60000), durationMs: 5 * 60000,
    totalTokens: 253680, totalToolCalls: 6, defaultModel: 'claude-opus-4-6', workflowName: 'Checkout readiness', phases: phases.map(title => ({ title })), workflowProgress: progress,
  }, now - 4 * 60000);
  const usage = { cachedUsageUtilization: { fetchedAtMs: now, utilization: { limits: [
    { kind: 'session', is_active: true, percent: 28, resets_at: iso(now + 2 * 3600000) },
    { kind: 'weekly_all', is_active: true, percent: 43, resets_at: iso(now + 3 * 86400000) },
  ] } } };
  json(path.join(root, '.claude.json'), usage);
  json(path.join(claude, '.claude.json'), usage);
  json(path.join(root, '.codex-companion', 'claude-limits.json'), { atMs: now + 1,
    fiveHour: { usedPercent: 28, resetsAtMs: now + 2 * 3600000 }, sevenDay: { usedPercent: 43, resetsAtMs: now + 3 * 86400000 } });
  const dbPath = path.join(root, 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      time_created INTEGER, time_updated INTEGER, time_idle INTEGER, idle_outcome TEXT);
      CREATE TABLE session_message (session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT, PRIMARY KEY(session_id, seq));`);
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'ses_demoDocsSearch', null, 'C:/Users/dev/projects/docs-site', 'Improve documentation search',
      JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-6', variant: 'high' }), 0.18, 12400, 980, 8100, 0, now - 17 * 60000, now - 8 * 60000, now - 8 * 60000, 'succeeded');
    const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)');
    const messages = [
      ['user', { text: 'Make search results easier to scan. Show a short excerpt and keep keyboard navigation working.' }],
      ['assistant', { content: [{ type: 'reasoning', text: 'Keep the existing search index and improve how results are presented.' }, { type: 'tool', id: 'docs-search', name: 'bash', state: { status: 'completed', input: { command: 'npm run check' }, output: 'Type checks and 12 search checks passed.', metadata: { exit: 0 } } }], tokens: { input: 12400, output: 980, cache: { read: 8100, write: 0 } } }],
      ['assistant', { content: [textBlock('Added highlighted excerpts and clearer page titles. Arrow keys move through results, Enter opens the selected page, and Escape closes search. Verified in Chrome at desktop and mobile widths.')] }],
      ['idle', { outcome: 'succeeded' }],
    ];
    messages.forEach(([type, data], i) => insert.run('ses_demoDocsSearch', i + 1, type, now - (16 - i * 2) * 60000, JSON.stringify(data)));
  } finally { db.close(); }
  return { codex, claude, state, dbPath, pulse() {
    const at = Date.now();
    fs.utimesSync(running.file, new Date(at), new Date(at));
    fs.utimesSync(chatFile, new Date(at), new Date(at));
    jobs[1].updatedAt = jobs[1].heartbeatAt = iso(at);
    saveJobs();
  } };
}

// Byte scan includes SQLite and viewer-created files, not just JSON transcripts.
// Words that must never reach the demo: this PC's user name and home folder, plus one word per
// line from scripts/.demo-privacy.local (gitignored, so private names never land on GitHub).
// `allow` is text to cut out first, such as the demo's own temp root.
function privacyWords() {
  const words = [os.userInfo().username, os.homedir()];
  try { words.push(...fs.readFileSync(new URL('./.demo-privacy.local', import.meta.url), 'utf8').split(/\r?\n/)); } catch {}
  return words.map(w => w.trim().replace(/\\/g, '/').toLowerCase()).filter(w => w.length > 2 && !w.startsWith('#'));
}
export function privacyCheck(text, label = 'content', allow = '') {
  let t = String(text);
  if (allow) t = t.split(allow).join('<demo-root>');
  t = t.replace(/\\/g, '/').toLowerCase();
  const hits = privacyWords().filter(word => t.includes(word));
  if (hits.length) throw new Error(`Privacy check failed for ${label}: ${hits.length} private word(s) found`);
}
export function auditDemo(root) {
  let files = 0, bytes = 0;
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else { const data = fs.readFileSync(file); privacyCheck(data.toString('utf8'), path.relative(root, file), root); files++; bytes += data.length; }
    }
  }
  scan(root);
  return `Privacy grep: ${files} files, ${bytes} bytes (including SQLite): no hits.`;
}

async function checkPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', () => reject(new Error(`Port ${PORT} is occupied; stop that demo first. No existing viewer was stopped.`))); probe.listen(PORT, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}

export async function startDemo() {
  await checkPort(); // The viewer's normal takeover behavior must never stop someone else's server.
  // A public system temp path also keeps an owner's username out of path labels.
  const temp = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:/Windows', 'Temp') : os.tmpdir();
  const root = fs.mkdtempSync(path.join(temp, 'viewer-demo-'));
  let child, heartbeat, stopping;
  const log = [];
  const now = Date.now();
  // Also cover an importing caller's process.exit() or an uncaught exception.
  // Normal shutdown waits for the child before deleting; this exit fallback
  // uses retrying synchronous cleanup because no async work can finish here.
  function onExit() {
    clearInterval(heartbeat);
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { console.error('[demo] Temporary root cleanup failed: ' + error.message); }
  }
  process.once('exit', onExit);
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(heartbeat);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill();
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      process.off('exit', onExit);
      console.log('[demo] Viewer stopped; temporary root removed.');
    })();
    return stopping;
  }
  try {
    const data = buildData(root, now);
    for (const dir of ['tmp', 'AppData/Roaming', 'AppData/Local', '.config', '.local/share']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    // Allowlist environment: no inherited credentials, config overrides or Node preloads.
    // PATH excludes agent CLIs: plan polling cannot start a real authenticated agent.
    const env = { USERPROFILE: root, HOME: root, CODEX_HOME: data.codex, CLAUDE_CONFIG_DIR: data.claude,
      CODEX_COMPANION_STATE_ROOT: data.state, OPENCODE_DB: data.dbPath, CODEX_VIEWER_AUTOSTART: '0',
      CODEX_VIEWER_PORT: String(PORT), CODEX_VIEWER_HOST: '127.0.0.1', CODEX_PLUGIN_UPDATE_CHECK: '0',
      APPDATA: path.join(root, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(root, '.config'), XDG_DATA_HOME: path.join(root, '.local', 'share'),
      TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TMPDIR: path.join(root, 'tmp'),
      PATH: path.dirname(process.execPath), ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot || 'C:/Windows', ComSpec: process.env.ComSpec || 'C:/Windows/System32/cmd.exe' } : {}) };
    const home = execFileSync(process.execPath, ['-p', 'require("node:os").homedir()'], { env, encoding: 'utf8', windowsHide: true }).trim();
    if (path.resolve(home) !== path.resolve(root)) throw new Error('Child home isolation check failed.');
    console.log(`[demo] Temporary home: ${root}`);
    console.log('[demo] ' + auditDemo(root));
    child = spawn(process.execPath, [path.join(REPO, 'ai-live-viewer.js'), 'serve'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { const text = chunk.toString(); log.push(text); process.stdout.write(text); });
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const poll = setInterval(() => {
        if (log.join('').includes('AI Live Viewer ->')) { clearInterval(poll); resolve(); }
        else if (spawnError || child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
          clearInterval(poll); reject(spawnError || new Error('Demo viewer did not start.'));
        }
      }, 100);
    });
    heartbeat = setInterval(data.pulse, 3000);
    const signals = ['SIGINT', 'SIGTERM'];
    const onSignal = () => { stop().catch(error => { console.error(error.message); process.exitCode = 1; }); };
    signals.forEach(signal => process.on(signal, onSignal));
    child.once('exit', () => {
      signals.forEach(signal => process.off(signal, onSignal));
      if (!stopping) { process.exitCode = child.exitCode || 0; stop().catch(error => { console.error(error.message); process.exitCode = 1; }); }
    });
    console.log(`[demo] http://127.0.0.1:${PORT} — invented data only; Ctrl+C stops this viewer.`);
    return { root, now, url: `http://127.0.0.1:${PORT}`, stop, log };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDemo().catch(error => { console.error('[demo] ' + error.message); process.exitCode = 1; });
}
