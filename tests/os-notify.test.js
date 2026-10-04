'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('notification broadcasts request one desktop pop-up with the retired tray filter', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/events.js'), 'utf8');
  const calls = [];
  const notificationClients = new Set();
  const sseClients = new Set();
  const env = {};
  let throwDesktop = false;
  const sandbox = {
    module: { exports: {} }, process: { env },
    require(name) {
      if (name === 'path') return path;
      if (name === './runtime') return { notificationClients, sseClients };
      if (name === './jobs') return { listCompanionJobs() { return []; } };
      if (name === './os-notify') return { notifyDesktop(event) {
        calls.push(JSON.parse(JSON.stringify(event)));
        if (throwDesktop) throw new Error('desktop unavailable');
      } };
      throw new Error('Unexpected module: ' + name);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'events.js' });
  const { broadcast } = sandbox.module.exports;
  for (const [event, expected] of [
    [{ type: 'complete', summary: 'Needs approval', title: 'Task title' }, { summary: 'Needs approval', title: 'Task title' }],
    [{ type: 'complete' }, { summary: 'AI task complete', title: 'Codex task' }],
    [{ type: 'job', status: 'completed', title: 'Completed title' }, { summary: 'AI task complete', title: 'Completed title' }],
    [{ type: 'job', status: 'failed' }, { summary: 'AI task failed', title: 'Codex task' }],
    [{ type: 'job', status: 'cancelled' }, { summary: 'AI task stopped', title: 'Codex task' }],
    [{ type: 'job', status: 'completed', summary: 'Custom heading' }, { summary: 'Custom heading', title: 'Codex task' }],
  ]) {
    const before = calls.length;
    broadcast(event, notificationClients);
    assert.equal(calls.length, before + 1, 'works with no SSE client');
    assert.deepEqual(calls.at(-1), expected);
  }
  for (const event of [{ type: 'job', status: 'running' }, { type: 'job', status: 'queued' }, { type: 'job' }, { type: 'sessions' }]) {
    const before = calls.length;
    broadcast(event, notificationClients);
    assert.equal(calls.length, before, 'nonterminal events do not notify');
  }
  const writes = [[], []];
  for (const messages of writes) notificationClients.add({ write(line) { messages.push(line); } });
  const event = { type: 'job', status: 'completed', title: 'Two browsers' };
  const before = calls.length;
  broadcast(event, notificationClients);
  assert.equal(calls.length, before + 1);
  for (const messages of writes) assert.equal(messages[0], 'data: ' + JSON.stringify(event) + '\n\n');
  env.CODEX_VIEWER_NOTIFICATIONS = '0';
  broadcast(event, notificationClients);
  assert.equal(calls.length, before + 1);
  for (const messages of writes) assert.equal(messages.length, 2, 'disable does not change job SSE');
  delete env.CODEX_VIEWER_NOTIFICATIONS;
  broadcast(event); // Normal dashboard frames are not desktop notifications.
  assert.equal(calls.length, before + 1);
  throwDesktop = true;
  assert.doesNotThrow(() => broadcast(event, notificationClients));
  for (const messages of writes) assert.equal(messages.length, 3, 'helper errors do not interrupt SSE');
});

test('desktop notification text stays data on every platform', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server/os-notify.js'), 'utf8');
  const hostile = '-"\' ` $(touch injected); & |\n<>&"\'';
  for (const platform of ['win32', 'linux', 'darwin']) {
    const calls = [];
    const sandbox = {
      module: { exports: {} },
      process: { platform, env: { PATH: 'test-path' } },
      require(name) {
        assert.match(name, /^(node:)?child_process$/);
        return { spawn(command, args, options) {
          const child = new EventEmitter();
          child.unref = () => {};
          calls.push({ command, args, options, child });
          return child;
        } };
      },
    };
    vm.runInNewContext(source, sandbox, { filename: 'os-notify.js' });
    const { notifyDesktop } = sandbox.module.exports;
    notifyDesktop({ summary: hostile, title: hostile + ' body' });
    notifyDesktop({ summary: 'Ordinary heading', title: 'Ordinary body' });
    notifyDesktop({ summary: hostile.repeat(20), title: hostile.repeat(20) });
    assert.equal(calls.length, 3, platform);
    const [attack, ordinary, long] = calls;
    for (const call of calls) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.detached, true);
      assert.equal(call.options.stdio, 'ignore');
      assert.ok(call.options.timeout > 0 && call.options.timeout <= 10000);
      assert.doesNotThrow(() => call.child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    }
    if (platform === 'linux') {
      assert.equal(attack.command, 'notify-send');
      assert.deepEqual(Array.from(attack.args), ['--app-name', 'AI Live Viewer', '--', hostile, hostile + ' body']);
      assert.equal(long.args.at(-2).length, 200);
      assert.equal(long.args.at(-1).length, 200);
    } else {
      assert.equal(attack.command, platform === 'win32' ? 'powershell.exe' : 'osascript');
      assert.deepEqual(Array.from(attack.args), Array.from(ordinary.args), 'script and argv must be constant');
      assert.equal(attack.options.env.AI_LIVE_VIEWER_NOTIFY_SUMMARY, hostile);
      assert.equal(attack.options.env.AI_LIVE_VIEWER_NOTIFY_TITLE, hostile + ' body');
      assert.equal(long.options.env.AI_LIVE_VIEWER_NOTIFY_SUMMARY.length, 200);
      assert.equal(long.options.env.AI_LIVE_VIEWER_NOTIFY_TITLE.length, 200);
      const script = attack.args.at(-1);
      assert.ok(!script.includes(hostile));
      if (platform === 'win32') {
        assert.match(script, /SecurityElement\]::Escape\(\$env:AI_LIVE_VIEWER_NOTIFY_SUMMARY\)/);
        assert.match(script, /SecurityElement\]::Escape\(\$env:AI_LIVE_VIEWER_NOTIFY_TITLE\)/);
      } else {
        assert.match(script, /system attribute "AI_LIVE_VIEWER_NOTIFY_SUMMARY"/);
        assert.match(script, /system attribute "AI_LIVE_VIEWER_NOTIFY_TITLE"/);
      }
    }
  }
});
