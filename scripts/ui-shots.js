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

  async function clickSel(selector, { timeout = 3000 } = {}) {
    try {
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click();
      return true;
    } catch {
      skipped.push('click ' + selector + ' not found/visible');
      log('skip - ' + selector + ' not found/visible');
      return false;
    }
  }

  // Sidebar views: tabs and chips carry data-tab / data-chip (ids from TABS in viewer-ui.html).
  async function view(tab, chip) {
    const ok = await clickSel('#tabs [data-tab="' + tab + '"]');
    return ok && (!chip || await clickSel('#chips [data-chip="' + chip + '"]'));
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
        // Start from empty prefs so every run begins in the same view (Now/All, default width).
        localStorage.setItem(key, JSON.stringify({ dismissed: [id] }));
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

  // ---- 2. every tab and every chip inside it ----
  const tabs = {
    NOW: ['ALL', 'RUNNING', 'WAITING', 'ATTENTION', 'ANSWER'],
    HANDOFFS: ['ALL', 'RUNNING', 'ATTENTION', 'ANSWER', 'FINISHED', 'STOPPED'],
    HISTORY: ['FINISHED', 'STOPPED', 'ARCHIVED', 'DISMISSED', 'EVERYTHING']
  };
  for (const [tab, chips] of Object.entries(tabs)) {
    for (const chip of chips) {
      if (await view(tab, chip)) {
        await page.waitForTimeout(200);
        await shot('02-' + tab + '-' + chip);
      }
    }
  }
  await view('NOW', 'ALL');

  // ---- 3. Now overview ----
  // Re-clicking the already-active Now tab opens the overview (Task 5); no more #home-button.
  if (await clickSel('#tabs [data-tab="NOW"]')) {
    await page.waitForTimeout(200);
    await shot('03-now-overview');
  }

  // ---- 3b. Auto-open toggle, on and off ----
  if (await clickId('auto-open-toggle')) {
    await page.waitForTimeout(150);
    await shot('03-auto-open-off');
    await clickId('auto-open-toggle');
    await page.waitForTimeout(150);
    await shot('03-auto-open-on');
  }

  // ---- 3c. "Show more" under Recently finished -> History/Finished ----
  if (await clickText('Show more')) {
    await page.waitForTimeout(200);
    await shot('03-show-more-history-finished');
  }
  await view('NOW', 'ALL'); // undo the Show more navigation for the steps below

  // ---- 4. a Running task ----
  // "Fixture 1 -" (with the trailing dash) - "Fixture 1" alone also matches
  // "Fixture 10/11/12/13" and .first() would grab the wrong card.
  if (await clickText('Fixture 1 -')) {
    await page.waitForTimeout(200);
    await shot('04-running-task');
  }

  // ---- 5. Finished handoff: result card above the feed (Task 8) ----
  // Fixture 4 is finished, so it is not in Now/All - widen to History/Everything first.
  await view('HISTORY', 'EVERYTHING');
  if (await clickText('Fixture 4 -')) {
    await page.waitForTimeout(400);
    await shot('05-finished-handoff');
    // 5b. Needs decision question + answer box, then the resume confirm prefilled from it.
    try {
      const box = page.locator('#result-card .answer-box textarea');
      await box.waitFor({ state: 'visible', timeout: 3000 });
      await box.fill('--force: cover the archived-session sweep here, "Task 11" only adds tests.');
      await page.waitForTimeout(150);
      await shot('05-result-card-answer-typed');
      if (await clickText('Answer and resume', { exact: true })) {
        await page.waitForTimeout(200);
        await shot('05-answer-resume-dialog');
        // Never reach the real /resume from the harness: answer it here with the server's 409.
        await page.route('**/resume', (route) => route.fulfill({
          status: 409, contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'job job-fixture-04 is still running on this thread - stop it first' })
        }));
        if (await clickId('control-modal-confirm')) {
          await page.waitForTimeout(300);
          await shot('05-answer-resume-409');
        }
        await page.unroute('**/resume');
        await pressEscape();
      }
      await box.fill('');
    } catch (err) {
      skipped.push('result card answer box: ' + err.message);
    }
  }
  // 5c. plain answer (no known headings) and 5d. a thread with 3 runs.
  if (await clickText('Fixture 5 -')) {
    await page.waitForTimeout(400);
    await shot('05-result-card-plain');
  }
  if (await clickText('Fixture 6 -')) {
    await page.waitForTimeout(400);
    await shot('05-result-card-3-runs');
  }
  await view('NOW', 'ALL');

  // ---- 6. the grouped ... menu (Fixture 4 is still open: Job, Session, Terminal commands, Diagnostics) ----
  if (await clickId('actions-button')) {
    await page.waitForTimeout(200);
    await shot('06-actions-menu');
    await pressEscape(); // Escape closes the ... menu (ruling R2)
  }

  // ---- 7. context menu on a row ----
  try {
    const row = page.getByText('Fixture 1 -', { exact: false }).first();
    await row.waitFor({ state: 'visible', timeout: 3000 });
    // Scroll first: the list's scroll event closes the context menu, and it can land after the click.
    await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await row.click({ button: 'right' });
    await page.waitForTimeout(200);
    await shot('07-context-menu');
    await pressEscape();
    // A possibly-stuck handoff: Cancel job lives in the menus now, not inline on the row.
    const stuck = page.getByText('Fixture 9 -', { exact: false }).first();
    await stuck.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await stuck.click({ button: 'right' });
    await page.waitForTimeout(200);
    await shot('07-context-menu-cancel-job');
    await pressEscape();
  } catch (err) {
    skipped.push('context menu: ' + err.message);
  }

  // ---- 8. One Start dialog: Kind switch (Task/Review/Adversarial) + Custom model ----
  if (await clickId('start-button')) {
    await page.waitForTimeout(200);
    await shot('08-start-dialog-task');
    try {
      await page.locator('#start-kind').selectOption('review');
      await page.waitForTimeout(200);
      await shot('08-start-dialog-review');
      await page.locator('#start-kind').selectOption('adversarial-review');
      await page.waitForTimeout(200);
      await shot('08-start-dialog-adversarial-review');
      await page.locator('#start-model').selectOption('custom');
      await page.waitForTimeout(200);
      await shot('08-start-dialog-custom-model');
    } catch (err) {
      skipped.push('start dialog kind/model switch: ' + err.message);
    }
    await pressEscape();
  }

  // ---- 9. result dialog: open Fixture 5, then ... > Job > Show full result ----
  async function showFullResult(title) {
    await view('HISTORY', 'EVERYTHING');
    if (!await clickText(title)) return false;
    await page.waitForTimeout(200);
    if (!await clickId('actions-button')) return false;
    await page.waitForTimeout(150);
    if (!await clickSel('#action-menu [data-action="show-result"]')) return false;
    await page.waitForTimeout(400);
    return true;
  }
  if (await showFullResult('Fixture 5 -')) {
    await shot('09-result-dialog');
    await pressEscape();
  }

  // ---- 9b. run picker: Fixture 6 has 3 runs on one thread ----
  if (await showFullResult('Fixture 6 -')) {
    await shot('09-run-picker');
    try {
      const runs = page.locator('#job-modal-runs');
      const values = await runs.locator('option').evaluateAll((options) => options.map((o) => o.value));
      await runs.selectOption(values[values.length - 1]);
      await page.waitForTimeout(400);
      await shot('09-run-picker-oldest-run');
    } catch (err) {
      skipped.push('run picker: ' + err.message);
    }
    await pressEscape();
  }

  // ---- 9c. header: reason line (Fixture 9, possibly stuck) and Resume (Fixture 8, dead job) ----
  await view('NOW', 'ALL');
  if (await clickText('Fixture 9 -')) {
    await page.waitForTimeout(200);
    await shot('09-header-reason-line');
  }
  if (await clickText('Fixture 8 -')) {
    await page.waitForTimeout(200);
    await shot('09-header-resume');
    if (await clickId('resume-session-button')) {
      await page.waitForTimeout(200);
      await shot('09-header-resume-dialog');
      await pressEscape();
    }
  }

  // ---- 10. search "retry" ----
  try {
    const search = page.locator('#search');
    await search.waitFor({ state: 'visible', timeout: 3000 });
    await search.fill('retry');
    await page.waitForTimeout(200);
    await shot('10-search-retry');
    // Matches the project path, not the title: rows show a "matched: project" hint.
    await search.fill('workspace');
    await page.waitForTimeout(400);
    await shot('10-search-match-hint');
    await search.fill('');
  } catch (err) {
    skipped.push('search box: ' + err.message);
  }

  // ---- 13. open task outside the current view: "Open: ... (not in this view) · Show" ----
  await pressEscape(); // close the result dialog from step 9
  await view('NOW', 'ALL');
  if (await clickText('Fixture 1 -')) {
    await view('HISTORY', 'FINISHED');
    await page.waitForTimeout(200);
    await shot('13-open-outside-view');
    if (await clickId('open-elsewhere-show')) {
      await page.waitForTimeout(200);
      await shot('13-open-outside-view-show');
    }
  }

  // ---- 14. a job-only row (queued, no session yet) opens the job result dialog ----
  await view('HANDOFFS', 'RUNNING');
  if (await clickText('Fixture 7 -')) {
    await page.waitForTimeout(300);
    await shot('14-job-only-row-dialog');
    await pressEscape();
  }

  // ---- mobile: 390x844 (the side list starts closed - open the drawer first) ----
  await view('NOW', 'ALL'); // undo the Handoffs view the steps above left behind
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

  // ---- 12b. the grouped ... menu at mobile width ----
  if (await clickId('actions-button')) {
    await page.waitForTimeout(200);
    await shot('12-mobile-actions-menu');
    await pressEscape();
  }

  // ---- 12c. result card with the answer box at mobile width ----
  if (await clickId('show-side')) {
    await page.waitForTimeout(200);
    await view('HISTORY', 'EVERYTHING');
    if (await clickText('Fixture 4 -')) {
      await page.waitForTimeout(400);
      await shot('12-mobile-result-card');
    }
    // Back to Now/All with the drawer closed, so step 15's Now click opens the overview.
    if (await clickId('show-side')) {
      await view('NOW', 'ALL');
      await clickId('hide-side');
      await page.waitForTimeout(200);
    }
  }

  // ---- 15. Now overview at mobile width, Auto-open toggle stays visible ----
  if (await clickId('show-side')) {
    await page.waitForTimeout(200);
    if (await clickSel('#tabs [data-tab="NOW"]')) {
      await page.waitForTimeout(200);
      await shot('15-mobile-now-overview');
    }
  }

  log('done. skipped:', skipped.length ? ('\n  - ' + skipped.join('\n  - ')) : 'none');
  return { out: OUT, skipped };
}
