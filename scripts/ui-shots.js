// playwright-cli run-code body for the viewer-ui-rework tasks.
//
// run-code executes this in a restricted vm (no require/import/process), so
// config comes from globals set on the page's window before the call - or
// just the hard-coded defaults below, editing them per task is fine too.
//
// Usage (mkdir the out dir first - this script cannot):
//   node scripts/ui-fixture.mjs &
//   mkdir -p docs/superpowers/ui-audit/after/latest
//   playwright-cli -s=uifix run-code "globalThis.UI_SHOTS_OUT_DIR='docs/superpowers/ui-audit/after/latest'"
//   playwright-cli -s=uifix run-code --filename=scripts/ui-shots.js
//
// Selects elements by visible text or stable ids so this keeps working as
// later tasks change markup; a missing element logs a note and the shot is
// skipped instead of throwing, so the run never stops partway through.
async (page) => {
  const OUT = globalThis.UI_SHOTS_OUT_DIR || 'docs/superpowers/ui-audit/after/latest';
  const URL = globalThis.UI_SHOTS_URL || 'http://127.0.0.1:8399';

  const log = (...a) => console.log('[ui-shots]', ...a);
  const skipped = [];

  async function shot(name, opts = {}) {
    try {
      await page.screenshot({ path: OUT.replace(/\/$/, '') + '/' + name + '.png', ...opts });
      log('shot:', name);
    } catch (err) {
      skipped.push(name + ' (screenshot failed: ' + err.message + ')');
      log('shot FAILED:', name, err.message);
    }
  }

  async function clickText(text, { exact = false, timeout = 3000 } = {}) {
    try {
      const loc = page.getByText(text, { exact }).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click();
      return true;
    } catch {
      skipped.push('click text "' + text + '" not found');
      log('skip - text not found:', text);
      return false;
    }
  }

  async function clickId(id, { timeout = 3000 } = {}) {
    try {
      const loc = page.locator('#' + id);
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click();
      return true;
    } catch {
      skipped.push('click #' + id + ' not found/visible');
      log('skip - #' + id + ' not found/visible');
      return false;
    }
  }

  async function pressEscape() {
    try { await page.keyboard.press('Escape'); } catch {}
  }

  // ---- boot ----
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  // Let the SSE snapshot land - the session list is empty for a beat on first paint.
  await page.waitForTimeout(1500);

  // Fixture 12's other half: dismiss the "Fixture 2" session via the same
  // localStorage prefs the real UI reads/writes (loadPrefs/savePrefs).
  try {
    const dismissedTitle = 'Fixture 2';
    const targetId = await page.evaluate((needle) => {
      const hit = (window.sessions || []).find((s) => (s.title || '').includes(needle));
      return hit ? hit.id : null;
    }, dismissedTitle);
    if (targetId) {
      await page.evaluate(({ key, id }) => {
        let prefs = {};
        try { prefs = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
        prefs.dismissed = Array.from(new Set([...(prefs.dismissed || []), id]));
        localStorage.setItem(key, JSON.stringify(prefs));
      }, { key: 'codex-live-viewer-ui-v1', id: targetId });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      log('dismissed session set for', targetId);
    } else {
      skipped.push('could not find "Fixture 2" session to dismiss');
    }
  } catch (err) {
    skipped.push('dismiss setup failed: ' + err.message);
  }

  // ---- 1. default view ----
  await shot('01-default');

  // ---- 2. each tab/chip in #filters (id -> visible label, per FILTERS in viewer-ui.html) ----
  const chips = { ACTIVE: 'Active', JOBS: 'Jobs', LIVE: 'Running', IDLE: 'Waiting', STALE: 'Stuck', DONE: 'Finished', ARCHIVED: 'Archived', ALL: 'All' };
  for (const [id, label] of Object.entries(chips)) {
    const ok = await clickText(label, { exact: false });
    if (ok) {
      await page.waitForTimeout(200);
      await shot('02-chip-' + id);
    } else {
      skipped.push('chip not found: ' + id);
    }
  }
  await clickText('Active', { exact: false });

  // ---- 3. Now overview ----
  if (await clickId('home-button')) {
    await page.waitForTimeout(200);
    await shot('03-now-overview');
  }

  // ---- 4. a Running task ----
  // "Fixture 1 -" (with the trailing dash) - "Fixture 1" alone also matches
  // "Fixture 10/11/12/13" and .first() would grab the wrong card.
  if (await clickText('Fixture 1 -')) {
    await page.waitForTimeout(200);
    await shot('04-running-task');
  }

  // ---- 5. Finished handoff (result card lands in Task 8; baseline just shows the feed) ----
  // Fixture 4 is DONE, so it drops out of the default ACTIVE filter - widen it first.
  await clickText('All', { exact: false });
  if (await clickText('Fixture 4 -')) {
    await page.waitForTimeout(200);
    await shot('05-finished-handoff');
  }
  await clickText('Active', { exact: false });

  // ---- 6. the ... menu ----
  if (await clickId('actions-button')) {
    await page.waitForTimeout(200);
    await shot('06-actions-menu');
    await pressEscape();
  }

  // ---- 7. context menu on a row ----
  try {
    const row = page.getByText('Fixture 1 -', { exact: false }).first();
    await row.waitFor({ state: 'visible', timeout: 3000 });
    await row.click({ button: 'right' });
    await page.waitForTimeout(200);
    await shot('07-context-menu');
    await pressEscape();
  } catch (err) {
    skipped.push('context menu: ' + err.message);
  }

  // ---- 8. Start dialog per kind ----
  if (await clickId('new-task-button')) {
    await page.waitForTimeout(200);
    await shot('08-start-dialog-task');
    await pressEscape();
  }
  if (await clickText('Jobs')) {
    await page.waitForTimeout(200);
    if (await clickId('review-button')) {
      await page.waitForTimeout(200);
      await shot('08-start-dialog-review');
      await pressEscape();
    }
    if (await clickId('adversarial-review-button')) {
      await page.waitForTimeout(200);
      await shot('08-start-dialog-adversarial-review');
      await pressEscape();
    }
  } else {
    skipped.push('Jobs filter not found - could not reach review start dialogs');
  }

  // ---- 9. result dialog ----
  if (await clickId('home-button')) {
    await page.waitForTimeout(200);
    if (await clickText('Fixture 5 -')) {
      await page.waitForTimeout(200);
      await shot('09-result-dialog');
      await pressEscape();
    } else {
      skipped.push('result dialog: no finished job card found for Fixture 5');
    }
  }

  // ---- 10. search "retry" ----
  try {
    const search = page.locator('#search');
    await search.waitFor({ state: 'visible', timeout: 3000 });
    await search.fill('retry');
    await page.waitForTimeout(200);
    await shot('10-search-retry');
    await search.fill('');
  } catch (err) {
    skipped.push('search box: ' + err.message);
  }

  // ---- mobile: 390x844 (the side list starts closed - open the drawer first) ----
  await pressEscape(); // close the result dialog from step 9
  await clickText('Active', { exact: false }); // undo the Jobs filter step 8 left behind
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  if (await clickId('show-side')) {
    await page.waitForTimeout(200);
    await shot('11-mobile-drawer');
    if (await clickText('Fixture 1 -')) {
      await page.waitForTimeout(200);
      await shot('12-mobile-task-view');
    }
  }

  log('done. skipped:', skipped.length ? ('\n  - ' + skipped.join('\n  - ')) : 'none');
  return { out: OUT, skipped };
}
