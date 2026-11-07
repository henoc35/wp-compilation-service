import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../../src/api/server.js';
import { signedHeaders } from '../../src/signature.js';
import { loadConfig } from '../../src/config.js';

function setup() {
  const added = [];
  const queue = {
    getJobCounts: async () => ({ waiting: 0 }),
    add: async (name, data, opts) => {
      added.push({ name, data, opts });
      return { id: 'job-1' };
    },
    getJob: async () => null,
  };
  const sites = new Map([['site-27', { id: 'site-27', domains: ['www.exemple.fr'], secret: 'secret' }]]);
  const config = { ...loadConfig(), debounceMs: 30000 };
  const app = buildServer({ config, sites, queue, logger: false });
  return { app, added };
}

function signed(body, { secret = 'secret', siteId = 'site-27' } = {}) {
  const payload = JSON.stringify(body);
  return {
    payload,
    headers: { 'content-type': 'application/json', ...signedHeaders({ siteId, secret, method: 'POST', path: '/v1/compile', body: payload }) },
  };
}

test('santé', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.json().status, 'ok');
});

test('demande sans signature refusée', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'POST', url: '/v1/compile', payload: { url: 'https://www.exemple.fr/' } });
  assert.equal(res.statusCode, 401);
});

test('demande signée avec un mauvais secret refusée', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'POST', url: '/v1/compile', ...signed({ url: 'https://www.exemple.fr/' }, { secret: 'faux' }) });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'signature_invalide');
});

test('URL d’un autre domaine refusée', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'POST', url: '/v1/compile', ...signed({ url: 'https://autre-site.fr/' }) });
  assert.equal(res.statusCode, 403);
});

test('familles inconnues refusées', async () => {
  const { app } = setup();
  const res = await app.inject({ method: 'POST', url: '/v1/compile', ...signed({ url: 'https://www.exemple.fr/', families: ['magie'] }) });
  assert.equal(res.statusCode, 400);
});

test('demande valide mise en file avec regroupement', async () => {
  const { app, added } = setup();
  const res = await app.inject({ method: 'POST', url: '/v1/compile', ...signed({ url: 'https://www.exemple.fr/contact/#form', lang: 'fr' }) });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().jobId, 'job-1');
  assert.equal(added[0].data.url, 'https://www.exemple.fr/contact/');
  assert.equal(added[0].opts.delay, 30000);
  assert.ok(added[0].opts.deduplication.id);
});
