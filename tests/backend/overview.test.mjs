import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../../server/app.mjs';

// This oracle reads canonical records directly and imports no app calculations.
function selected(rows, options) {
  return rows.filter(row => {
    const term = (options.q ?? '').toUpperCase();
    if (![row.id, row.title, row.description].some(text => text.toUpperCase().includes(term))) return false;
    for (const key of ['service', 'status', 'severity']) {
      if (options[key]?.length && !options[key].includes(row[key])) return false;
    }
    const opened = Date.parse(row.openedAt);
    return (!options.from || opened >= Date.parse(`${options.from}T00:00:00Z`)) &&
      (!options.to || opened < Date.parse(`${options.to}T00:00:00Z`) + 86400000);
  });
}

function measures(rows) {
  const services = [...new Set(rows.map(row => row.service))].map(service => {
    const incidents = rows.filter(row => row.service === service);
    const resolved = incidents.filter(row => row.status === 'resolved');
    const elapsed = resolved.map(row => new Date(row.resolvedAt).getTime() - new Date(row.openedAt).getTime());
    return {
      service,
      incidentCount: incidents.length,
      unresolvedCount: incidents.filter(row => row.status === 'open' || row.status === 'in_progress').length,
      highSeverityCount: incidents.filter(row => row.severity === 'critical' || row.severity === 'high').length,
      averageResolutionHours: elapsed.length ? elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length / 3600000 : null,
    };
  });
  services.sort((a, b) => b.unresolvedCount - a.unresolvedCount || a.service.localeCompare(b.service, 'en'));
  return { services };
}

function parameters(options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

test('overview: independent canonical measures through real loopback HTTP', { timeout: 20000 }, async t => {
  const dataURL = new URL('../../.runtime/incidents.json', import.meta.url);
  const before = await readFile(dataURL);
  const rows = JSON.parse(before);
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = path => fetch(base + path, { signal: AbortSignal.timeout(3000) });
    const check = async (options = {}) => {
      const response = await get(`/api/overview?${parameters(options)}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const actual = await response.json();
      assert.deepEqual(actual, measures(selected(rows, options)));
      return actual;
    };

    await t.test('all services use complete counts and resolved-only averages', async () => {
      const actual = await check();
      assert.equal(actual.services.reduce((sum, service) => sum + service.incidentCount, 0), 2400);
      for (const service of actual.services) {
        const incidents = rows.filter(row => row.service === service.service);
        assert.ok(incidents.some(row => row.status === 'resolved'));
        assert.ok(incidents.some(row => row.status !== 'resolved'));
        assert.ok(service.averageResolutionHours > 0);
      }
    });

    await t.test('combined filters span pages and ignore every valid presentation choice', async () => {
      const options = { q: 'iNcIdEnT', service: ['Accounts', 'Billing'], status: ['open', 'resolved'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13' };
      const matches = selected(rows, options);
      assert.ok(matches.length > 50);
      assert.ok(matches.some(row => row.status === 'resolved'));
      assert.ok(matches.some(row => row.status === 'open'));
      const first = await check(options);
      for (const sort of ['openedAt', 'severity']) {
        for (const direction of ['asc', 'desc']) {
          for (const pageSize of [25, 50]) {
            for (const page of [1, 2, 99999]) {
              assert.deepEqual(await check({ ...options, sort, direction, pageSize, page }), first);
            }
          }
        }
      }
      const list = await get(`/api/incidents?${parameters({ ...options, page: 2, pageSize: 25 })}`);
      const body = await list.json();
      assert.equal(body.total, matches.length);
      assert.equal(body.items.length, 25);
      assert.ok(first.services.reduce((sum, service) => sum + service.incidentCount, 0) > body.items.length);
    });

    await t.test('resolved-only means and alphabetical ties; unresolved-only averages are null', async () => {
      const resolved = await check({ status: ['resolved'] });
      assert.ok(resolved.services.length > 1);
      assert.deepEqual(resolved.services.map(row => row.service), resolved.services.map(row => row.service).sort());
      assert.ok(resolved.services.every(row => row.unresolvedCount === 0 && row.averageResolutionHours > 0));
      const unresolved = await check({ status: ['open', 'in_progress'] });
      assert.ok(unresolved.services.length > 0);
      assert.ok(unresolved.services.every(row => row.averageResolutionHours === null && row.unresolvedCount === row.incidentCount));
    });

    await t.test('literal search, repeated facets and inclusive UTC boundaries', async () => {
      for (const options of [
        { q: 'inc-000001' }, { q: 'SECOND LINE: <sample>' }, { q: 'retry, then continue' },
        { service: ['Billing', 'Billing', 'Search'] },
        { from: '2026-04-01', to: '2026-04-01' },
        { from: '2026-06-29', to: '2026-06-29' },
        { from: '2026-06-13' }, { to: '2026-04-15' },
      ]) {
        assert.ok(selected(rows, options).length > 0);
        await check(options);
      }
    });

    await t.test('empty results contain no services', async () => {
      for (const options of [{ q: '.*' }, { q: 'no such incident', page: 42 }, { from: '2027-01-01' }]) {
        assert.deepEqual(await check(options), { services: [] });
      }
    });

    await t.test('invalid queries preserve the incident-list error envelope and GET-only behavior', async () => {
      const bad = ['unknown=yes', 'q=a&q=b', 'service=billing', 'status=closed', 'severity=urgent', 'from=2026-02-30', 'to=2026-13-01', 'from=2026-06-01&to=2026-04-01', 'sort=id', 'sort=severity&sort=openedAt', 'direction=down', 'page=0', 'page=1.5', 'page=9007199254740992', 'page=1&page=2', 'pageSize=100', 'pageSize=25&pageSize=50'];
      for (const params of bad) {
        const overview = await get(`/api/overview?${params}`);
        const incidents = await get(`/api/incidents?${params}`);
        assert.equal(overview.status, 400, params);
        assert.equal(incidents.status, 400, params);
        const error = await overview.json();
        assert.equal(error.error.code, 'INVALID_QUERY');
        assert.ok(error.error.message.length);
        assert.deepEqual(error, await incidents.json());
      }
      const response = await fetch(`${base}/api/overview`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    assert.equal(server.listening, false);
    assert.deepEqual(await readFile(dataURL), before);
  }
});
