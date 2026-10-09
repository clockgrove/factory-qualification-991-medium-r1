import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {expected} from './oracle.js';

const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8', timeout: 5000}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');
const storageKey = 'incident-explorer.triage.v1';
async function bounded(promise, label, milliseconds = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function poll(read, wanted) {
  const deadline = Date.now() + 10000;
  let actual;
  do {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(wanted)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.deepEqual(actual, wanted);
}
// Independent canonical-data reduction, with no production measure imports.
function measures(options) {
  const items = expected(options).items;
  return [...new Set(items.map(row => row.service))].map(service => {
    const matching = items.filter(row => row.service === service);
    const resolved = matching.filter(row => row.status === 'resolved');
    return {service, values: [matching.length, matching.filter(row => row.status !== 'resolved').length,
      matching.filter(row => ['critical', 'high'].includes(row.severity)).length,
      resolved.length ? resolved.reduce((sum, row) => sum + Date.parse(row.resolvedAt) - Date.parse(row.openedAt), 0) / resolved.length / 3600000 : null]};
  }).sort((a, b) => b.values[1] - a.values[1] || a.service.localeCompare(b.service));
}

test('combined real browser journeys: overview ownership, phone access and persistent personal triage', {timeout: 90000}, async t => {
  const before = await readFile('.runtime/incidents.json');
  let server, browser, port;
  const contexts = new Set();
  const start = async () => {
    server = await createAppServer();
    server.listen(port || 0, '127.0.0.1');
    await bounded(once(server, 'listening'), 'server startup');
    port = server.address().port;
  };
  const stop = async () => {
    if (!server?.listening) return;
    await bounded(new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    }), 'server shutdown');
  };
  const fresh = async options => {
    const context = await browser.newContext(options); contexts.add(context);
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
    return {context, page};
  };
  try {
    await start();
    browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, timeout: 15000, env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: resolve(alias, '../host-libs/usr/lib/x86_64-linux-gnu'),
      ALSA_CONFIG_PATH: resolve(alias, '../host-libs/usr/share/alsa/alsa.conf'),
      TMPDIR: '.runtime/browser-tmp', TMP: '.runtime/browser-tmp', TEMP: '.runtime/browser-tmp'
    }});
    const {context, page} = await fresh({viewport: {width: 1280, height: 900}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const base = `http://127.0.0.1:${port}`;
    const search = async q => { await page.locator('#search').fill(q); await page.locator('#search').press('Enter'); };
    const check = async (options = {}) => {
      await poll(() => page.locator('#overview').getAttribute('aria-busy'), 'false');
      await poll(() => page.locator('#overview-freshness').textContent().then(x => x.endsWith('Current selection.')), true);
      const wanted = measures(options).map(row => ({service: row.service, values: row.values.map((value, i) => value === null ? 'Unavailable' : value.toLocaleString(undefined, i === 3 ? {maximumFractionDigits: 1} : undefined))}));
      await poll(() => page.locator('.service-card').evaluateAll(cards => cards.map(card => ({service: card.querySelector('h3').textContent, values: [...card.querySelectorAll('dd')].map(x => x.textContent)}))), wanted);
      await poll(() => page.locator('#freshness').textContent(), 'Current selections');
      assert.deepEqual(await page.locator('#rows button').evaluateAll(nodes => nodes.map(x => x.dataset.incident)), expected(options).items.slice(((options.page || 1) - 1) * (options.pageSize || 25), (options.page || 1) * (options.pageSize || 25)).map(x => x.id));
    };
    const detail = async id => {
      await poll(() => page.locator('#detail-content dd').count(), 11);
      assert.equal(await page.locator('#detail-content dd').first().textContent(), id);
    };
    await page.goto(base); await check();
    await t.test('whole-filter overview updates, presentation invariance and visible empty state', async () => {
      await search('incident'); await page.locator('#service').getByLabel('Billing', {exact: true}).check();
      const options = {q: 'incident', service: ['Billing']}; await check(options);
      assert.ok(expected(options).items.length > 50);
      await page.locator('#next').click(); await check({...options, page: 2});
      await page.locator('#page-size').selectOption('50'); await check({...options, pageSize: 50});
      await page.locator('#status').getByLabel('open', {exact: true}).check(); await check({...options, pageSize: 50, status: ['open']});
      assert.ok((await page.locator('.service-card dd').allTextContents()).includes('Unavailable'));
      await search('no matching fictional incident xyz'); await check({...options, q: 'no matching fictional incident xyz', pageSize: 50, status: ['open']});
      assert.equal(await page.locator('#overview-message').isVisible(), true);
      assert.match(await page.locator('#overview-message').textContent(), /No services match/);
      await page.locator('#clear').click(); await check({pageSize: 50});
    });
    await t.test('bounded overlap, obsolete abort cleanup, genuine interruption and current retry', async () => {
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 800, downloadThroughput: -1, uploadThroughput: -1});
        const pending = page.waitForRequest(r => r.url().includes('/api/overview?') && new URL(r.url()).searchParams.get('q') === 'Billing');
        const obsolete = page.waitForEvent('requestfailed', {predicate: r => r.url().includes('/api/overview?') && new URL(r.url()).searchParams.get('q') === 'Billing'});
        await search('Billing'); await pending;
        assert.match(await page.locator('#overview-selection').textContent(), /Billing/);
        assert.equal(await page.locator('#overview').getAttribute('data-stale'), 'true');
        await stop(); await search('Uploads'); await obsolete;
        await poll(() => page.locator('#overview-message button').textContent(), 'Retry');
        await poll(() => page.locator('#overview').getAttribute('aria-busy'), 'false');
        assert.match(await page.locator('#overview-selection').textContent(), /Uploads/);
        assert.match(await page.locator('#overview-freshness').textContent(), /Previous selection/);
        await page.locator('.section-nav a[href="#overview"]').click();
        assert.equal(await page.locator('#announcement').textContent(), (await page.locator('#overview-message span').textContent()).replace('Service overview unavailable: ', ''));
        await start();
        await cdp.send('Network.emulateNetworkConditions', {offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
        await page.locator('#overview-message button').press('Enter');
        await page.locator('#result-message button').click(); await check({q: 'Uploads', pageSize: 50});
        assert.equal(await page.locator('#overview-message').textContent(), '');
      } finally { await cdp.detach(); }
    });
    await t.test('ordered deduplicated triage, edited literal notes, reload, detail return and note deletion', async () => {
      const selected = expected({q: 'Uploads', pageSize: 50}).items.slice(0, 2);
      const address = page.url();
      for (const row of selected) {
        await page.locator(`#rows button[data-incident="${row.id}"]`).press('Enter'); await detail(row.id);
        await page.getByRole('button', {name: 'Add to triage', exact: true}).press('Enter');
        await page.keyboard.press('Escape');
      }
      const ids = () => page.locator('#triage-list button[data-incident]').evaluateAll(nodes => nodes.map(x => x.dataset.incident));
      assert.deepEqual(await ids(), selected.map(row => row.id));
      await page.locator(`#rows button[data-incident="${selected[0].id}"]`).click(); await detail(selected[0].id);
      assert.equal(await page.getByRole('button', {name: 'Already in triage'}).isDisabled(), true);
      await page.keyboard.press('Escape'); assert.deepEqual(await ids(), selected.map(row => row.id));
      const note = '<img src=x onerror="alert(1)"> & "quotes", punctuation!\n雪';
      await page.getByLabel(`Note for ${selected[0].id}`).fill('First draft');
      await page.getByLabel(`Note for ${selected[0].id}`).fill(note);
      await page.reload(); await check({q: 'Uploads', pageSize: 50});
      assert.deepEqual(await ids(), selected.map(row => row.id));
      assert.equal(await page.getByLabel(`Note for ${selected[0].id}`).inputValue(), note);
      assert.equal(await page.locator('#triage-list img, #triage-list script').count(), 0);
      const opener = page.locator(`#triage-list button[data-incident="${selected[0].id}"]`);
      await opener.focus(); await opener.press('Enter'); await detail(selected[0].id);
      assert.equal(await page.locator('#announcement').textContent(), 'Incident details ready.');
      await page.keyboard.press('Escape');
      assert.equal(await opener.evaluate(x => x === document.activeElement), true);
      assert.equal(page.url(), address); await check({q: 'Uploads', pageSize: 50});
      await page.getByRole('button', {name: `Remove ${selected[0].id} from triage`}).press('Enter');
      const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
      assert.deepEqual(stored.map(row => row.id), [selected[1].id]);
      assert.equal(JSON.stringify(stored).includes(note), false);
      await page.reload(); await check({q: 'Uploads', pageSize: 50});
      await page.locator(`#rows button[data-incident="${selected[0].id}"]`).click(); await detail(selected[0].id);
      await page.getByRole('button', {name: 'Add to triage', exact: true}).click(); await page.keyboard.press('Escape');
      assert.deepEqual(await ids(), [selected[1].id, selected[0].id]);
      assert.equal(await page.getByLabel(`Note for ${selected[0].id}`).inputValue(), '');
    });
    await t.test('fresh phone overview-first landing, keyboard navigation, visible focus and complete narrow content', async () => {
      const {page: phone} = await fresh({viewport: {width: 375, height: 812}, isMobile: true, hasTouch: true});
      await phone.goto(base);
      await poll(() => phone.locator('.service-card').count(), 6);
      assert.equal(await phone.evaluate(() => scrollY), 0);
      const boxes = await phone.locator('main > *').evaluateAll(nodes => nodes.map(x => ({id: x.id, top: x.getBoundingClientRect().top})));
      assert.ok(boxes.find(x => x.id === 'overview').top < boxes.find(x => x.id === 'results').top);
      assert.ok(boxes.find(x => x.id === 'overview').top < 812);
      for (const [name, id] of [['Service overview', 'overview'], ['Incident results', 'results'], ['Personal triage', 'triage']]) {
        const link = phone.getByRole('link', {name, exact: true});
        await phone.keyboard.press('Tab'); await link.focus();
        assert.notEqual(await link.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
        await link.press('Enter');
        assert.equal(await phone.locator(`#${id}`).evaluate(x => x === document.activeElement), true);
      }
      await poll(() => phone.locator('#freshness').textContent(), 'Current selections');
      await phone.locator('#rows button').first().press('Enter');
      await poll(() => phone.locator('#detail-content dd').count(), 11);
      await phone.getByRole('button', {name: 'Add to triage', exact: true}).press('Enter'); await phone.keyboard.press('Escape');
      const note = phone.locator('#triage-list textarea'); await note.focus(); await note.press('a');
      assert.notEqual(await note.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await phone.locator('.service-card dd, #triage-list textarea, #triage-list button').evaluateAll(nodes => nodes.every(x => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })), true);
      // The existing results table retains all columns in a horizontal scroll container.
      assert.equal(await phone.locator('thead th').count(), 5);
      assert.equal(await phone.locator('.table-wrap').evaluate(x => getComputedStyle(x).overflowX), 'auto');
    });
    await t.test('fresh malformed storage and genuine quota failure retain usable visit state', async () => {
      const {page: isolated} = await fresh();
      await isolated.goto(base);
      await isolated.evaluate(key => localStorage.setItem(key, '{malformed'), storageKey);
      await isolated.reload();
      await poll(() => isolated.locator('#triage-message').textContent().then(x => x.includes('malformed')), true);
      await poll(() => isolated.locator('#freshness').textContent(), 'Current selections');
      await isolated.locator('#rows button').first().click();
      await poll(() => isolated.locator('#detail-content dd').count(), 11);
      const id = await isolated.locator('#detail-content dd').first().textContent();
      await isolated.getByRole('button', {name: 'Add to triage', exact: true}).click(); await isolated.keyboard.press('Escape');
      // Fill native storage to its actual quota; no storage/API methods are replaced.
      const quota = await isolated.evaluate(() => {
        let n = 0;
        try { for (; n < 1024; n++) localStorage.setItem(`quota-${n}`, 'x'.repeat(65536)); }
        catch (error) { return error.name; }
        return 'quota not reached';
      });
      assert.equal(quota, 'QuotaExceededError');
      await isolated.getByLabel(`Note for ${id}`).fill('<b>visit-only</b>'.repeat(10000));
      assert.match(await isolated.locator('#triage-message').textContent(), /could not be saved.*remain usable for this visit/);
      assert.equal(await isolated.getByLabel(`Note for ${id}`).inputValue(), '<b>visit-only</b>'.repeat(10000));
      await isolated.getByRole('button', {name: `Remove ${id} from triage`}).click();
      assert.equal(await isolated.locator('#triage-list button[data-incident]').count(), 0);
      assert.equal(await isolated.locator('#freshness').textContent(), 'Current selections');
    });
    assert.deepEqual(errors, []);
  } finally {
    try {
      for (const context of contexts) await bounded(context.close(), 'context cleanup');
    } finally {
      try { if (browser) await bounded(browser.close(), 'browser cleanup'); }
      finally { await stop(); assert.deepEqual(await readFile('.runtime/incidents.json'), before); }
    }
  }
});
