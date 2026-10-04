#!/usr/bin/env node
// Starts its own isolated demo, uses a fresh Chrome profile, and always cleans
// both up. Run: node scripts/readme-shot.mjs [--workflow]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemo, auditDemo, privacyCheck, CHAT_ID, RUN_ID, FINISHED_JOB } from './demo-fixture.mjs';

// Set PLAYWRIGHT_MODULE to a file:// URL when Playwright is not installed where Node finds it.
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE || 'playwright';
const IMAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images');
const MAX_BYTES = 1500000;

async function preparePage(browser, demo, scale) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: scale, colorScheme: 'dark' });
  // The browser reads only the demo. No persisted profile, external requests,
  // or routes that can resume/kill a process are used by this screenshot script.
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === demo.url) return route.continue();
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date(demo.now)); // Date stays fixed; polling and animation timers still run.
  await page.addInitScript(() => {
    localStorage.setItem('codex-live-viewer-ui-v1', JSON.stringify({
      tab: 'LIVE', chip: 'ALL', autoFollow: false, home: false, kinds: {}, dismissed: [],
      sideWidth: 440, sideWidthSet: true, openNodes: {}, openFolds: {}, closedGroups: {},
    }));
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(({ chat, run, finished }) => {
    if (typeof currentModel !== 'function') return false;
    const nodes = Object.values(currentModel().nodes);
    return nodes.some(n => n.id === 'chat:' + chat) && nodes.some(n => n.runId === run && n.kind === 'workflow')
      && nodes.filter(n => n.kind === 'wfgroup').length === 3
      && nodes.some(n => n.kind === 'opencode')
      && nodes.some(n => n.row?.job?.id === finished) && nodes.filter(n => n.kind === 'codex').length >= 2;
  }, { chat: CHAT_ID, run: RUN_ID, finished: FINISHED_JOB }, { timeout: 20000 });
  console.log('[readme-shot] All four sources and three topic groups loaded.');
  await page.waitForFunction(() => {
    const nodes = Object.values(currentModel().nodes);
    const groups = nodes.filter(n => n.kind === 'wfgroup');
    return groups.length === 3 && groups.every(n => !n.group.partial);
  }, null, { timeout: 20000 });
  await page.evaluate(({ chat, run, finished }) => {
    chooseView('LIVE', 'ALL'); // Startup migrates saved chips; choose the final view after that migration.
    const model = currentModel();
    prefs.openNodes['chat:' + chat] = true;
    prefs.openFolds['chat:' + chat] = true;
    const workflow = Object.values(model.nodes).find(n => n.runId === run && n.kind === 'workflow');
    prefs.openNodes[workflow.id] = true;
    prefs.openFolds[workflow.id] = true;
    // Keep topic headings visible; each can expand to its two agents in the live demo.
    Object.values(model.nodes).filter(n => n.kind === 'wfgroup').forEach(n => { prefs.openNodes[n.id] = false; });
    const handoff = Object.values(model.nodes).find(n => n.row?.job?.id === finished);
    savePrefs();
    selectNode(handoff.id, true);
    renderList();
  }, { chat: CHAT_ID, run: RUN_ID, finished: FINISHED_JOB });
  await page.locator('#result-card').waitFor({ state: 'visible', timeout: 10000 });
  // The normal result card suppresses an empty decision ('None'). Wait for the
  // substantive sections; the raw fixture result still has all four headings.
  await page.waitForFunction(() => /checks run/i.test(document.querySelector('#result-card')?.innerText || ''), null, { timeout: 10000 }).catch(async error => {
    console.error('[readme-shot] Result card: ' + await page.locator('#result-card').innerText());
    if (errors.length) console.error('[readme-shot] Browser errors: ' + errors.join('; '));
    throw error;
  });
  await page.evaluate(() => document.fonts.ready);
  if (errors.length) throw new Error('Browser errors: ' + errors.join('; '));
  return { context, page, errors };
}

async function privacyProof(page, demo) {
  const text = await page.locator('body').innerText();
  privacyCheck(text, 'rendered page text');
  const dataProof = auditDemo(demo.root);
  const logs = demo.log.join('');
  const watching = logs.split(/\r?\n/).filter(line => /Watching:|Claude workflows:/.test(line));
  if (watching.length < 2 || watching.some(line => !line.includes(demo.root))) throw new Error('Viewer watch paths escaped the demo root.');
  privacyCheck(logs, 'viewer log', demo.root);
  const proof = [dataProof, `Privacy grep: rendered page (${text.length} characters): no hits.`,
    'Words: this user name, the home folder, and scripts/.demo-privacy.local.',
    'Child os.homedir() verified equal to the temporary root.', ...watching];
  proof.forEach(line => console.log(line));
  return proof;
}

async function capture(page, filename) {
  await page.mouse.move(1590, 990); // Keep hover menus out of the preview.
  await page.screenshot({ path: path.join(IMAGES, filename), animations: 'disabled' });
  const bytes = fs.statSync(path.join(IMAGES, filename)).size;
  console.log(`docs/images/${filename}: ${bytes} bytes`);
  return bytes;
}

async function main() {
  const unknown = process.argv.slice(2).filter(arg => arg !== '--workflow');
  if (unknown.length) throw new Error('Usage: node scripts/readme-shot.mjs [--workflow]');
  const { chromium } = await import(PLAYWRIGHT);
  const demo = await startDemo();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    fs.mkdirSync(IMAGES, { recursive: true });
    let proof;
    for (const scale of [2, 1.5]) {
      const { context, page, errors } = await preparePage(browser, demo, scale);
      try {
        proof = await privacyProof(page, demo);
        const sizes = [await capture(page, 'viewer-preview.png')];
        if (process.argv.includes('--workflow')) {
          await page.evaluate(run => {
            const workflow = Object.values(currentModel().nodes).find(n => n.runId === run && n.kind === 'workflow');
            selectNode(workflow.id, true);
            (workflow.run.groups || []).forEach(group => { openTopics[run + '/' + group.key] = true; });
            lastClaudeOverviewSignature = '';
            renderClaudeOverview();
          }, RUN_ID);
          await page.waitForFunction(() => document.body.classList.contains('claude-tab'));
          privacyCheck(await page.locator('body').innerText(), 'workflow page text');
          sizes.push(await capture(page, 'viewer-workflow.png'));
        }
        if (errors.length) throw new Error('Browser errors: ' + errors.join('; '));
        if (sizes.every(bytes => bytes < MAX_BYTES)) {
          fs.writeFileSync(path.join(IMAGES, '..', 'superpowers', 'demo-privacy.txt'), proof.join('\n') + `\nScreenshots: 1600x1000 CSS pixels; deviceScaleFactor ${scale}.\n`);
          return;
        }
        if (scale === 1.5) throw new Error('A PNG exceeds 1.5 MB at deviceScaleFactor 1.5.');
        console.log('Retrying at deviceScaleFactor 1.5 to stay below 1.5 MB.');
      } finally { await context.close(); }
    }
  } finally {
    try { if (browser) await browser.close(); } finally { await demo.stop(); }
  }
}

main().catch(error => { console.error('[readme-shot] ' + error.message); process.exitCode = 1; });
