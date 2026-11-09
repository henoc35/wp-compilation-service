import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import pg from 'pg';
import { openDatabase } from '../../src/store/db.js';
import { createRepo } from '../../src/store/repo.js';
import { createBox } from '../../src/store/security.js';
import { createSiteRegistry } from '../../src/store/registry.js';
import { createPageSpeedRunner } from '../../src/pagespeed.js';
import { buildServer } from '../../src/api/server.js';
import { loadConfig } from '../../src/config.js';
import { signedHeaders } from '../../src/signature.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'TEST_DATABASE_URL absente';
let pool; let repo; let app; let psiServer; let psiCalls = [];
const added = [];
const fakeQueue = { add: async (name, data) => { added.push(data); return { id: String(added.length) }; }, getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0 }) };

const PSI_RESPONSE = {
  lighthouseResult: {
    categories: { performance: { score: 0.87 } },
    audits: {
      'first-contentful-paint': { numericValue: 1200, displayValue: '1,2 s', score: 0.9 },
      'largest-contentful-paint': { numericValue: 2400, displayValue: '2,4 s', score: 0.8 },
      'cumulative-layout-shift': { numericValue: 0.05, displayValue: '0,05', score: 0.95 },
      'total-blocking-time': { numericValue: 150, displayValue: '150 ms', score: 0.9 },
      'speed-index': { numericValue: 2000, displayValue: '2,0 s', score: 0.9 },
    },
  },
  loadingExperience: { overall_category: 'AVERAGE', metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900, category: 'AVERAGE' } } },
};

before(async () => {
  if (skip) return;
  const admin = new pg.Pool({ connectionString: URL_ });
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  psiServer = http.createServer((req, res) => {
    psiCalls.push(new URL(req.url, 'http://x').searchParams);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(PSI_RESPONSE));
  });
  await new Promise((r) => psiServer.listen(0, '127.0.0.1', r));
  pool = await openDatabase(URL_);
  repo = createRepo(pool, createBox('cle-de-test-suffisamment-longue'));
  await repo.users.create({ email: 'admin@exemple.fr', password: 'mot-de-passe-solide' });
  const config = { ...loadConfig(), pagespeedApiKey: '', pagespeedEndpoint: `http://127.0.0.1:${psiServer.address().port}/run`, debounceMs: 0 };
  const yamlSites = new Map([['site-yaml', { id: 'site-yaml', domains: ['yaml.exemple.fr'], secret: 'secret-yaml', callbackUrl: null, families: {}, masks: [] }]]);
  const sites = createSiteRegistry({ repo, yamlSites });
  app = buildServer({ config, sites, queue: fakeQueue, repo, pagespeed: createPageSpeedRunner({ repo, config }), logger: false });
});
after(async () => { await app?.close(); await pool?.end(); psiServer?.close(); });

let cookie; let csrf;
const call = (method, url, body, { auth = true, token = csrf } = {}) => app.inject({
  method, url, payload: body,
  headers: { ...(auth && cookie ? { cookie } : {}), ...(token ? { 'x-csrf-token': token } : {}) },
});

test('connexion, session et CSRF', { skip }, async () => {
  assert.equal((await call('GET', '/admin/api/me', null, { auth: false })).statusCode, 401);
  assert.equal((await call('POST', '/admin/api/login', { email: 'admin@exemple.fr', password: 'faux' }, { auth: false })).statusCode, 401);
  const res = await call('POST', '/admin/api/login', { email: 'admin@exemple.fr', password: 'mot-de-passe-solide' }, { auth: false });
  assert.equal(res.statusCode, 200);
  const set = res.headers['set-cookie'];
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/); assert.match(set, /Path=\/admin/);
  cookie = set.split(';')[0];
  csrf = res.json().csrf;
  assert.equal((await call('GET', '/admin/api/me')).json().user.email, 'admin@exemple.fr');
  assert.equal((await call('POST', '/admin/api/clients', { name: 'X' }, { token: 'mauvais' })).statusCode, 403, 'modification sans jeton CSRF refusée');
  const page = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
});

let siteId; let pairCode;
test('client, site, code d\'appairage, tableau de bord', { skip }, async () => {
  const c = (await call('POST', '/admin/api/clients', { name: 'Client Démo' })).json();
  assert.ok(c.id);
  const bad = await call('POST', '/admin/api/sites', { name: 'Vitrine', domains: 'pas un domaine' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_domain');
  const res = (await call('POST', '/admin/api/sites', { name: 'Vitrine', clientId: c.id, domains: 'www.vitrine.fr vitrine.fr' })).json();
  siteId = res.id; pairCode = res.pairing.code;
  assert.equal(siteId, 'site-01');
  const dash = (await call('GET', '/admin/api/dashboard')).json();
  assert.equal(dash.sites[0].clientName, 'Client Démo');
  assert.deepEqual(dash.yamlSites.map((s) => s.id), ['site-yaml']);
  const detail = (await call('GET', `/admin/api/sites/${siteId}`)).json();
  assert.ok(detail.pairingPending);
  assert.equal(detail.site.secret, undefined, 'le secret n\'est jamais renvoyé dans la fiche');
});

let secret;
test('appairage par le plugin : domaine vérifié, code à usage unique', { skip }, async () => {
  const wrong = await app.inject({ method: 'POST', url: '/v1/pair', payload: { code: pairCode, home_url: 'https://autre.fr/' } });
  assert.equal(wrong.json().error, 'domain_mismatch');
  // Le code a été consommé par la tentative : un nouveau code est nécessaire (anti-essais).
  pairCode = (await call('POST', `/admin/api/sites/${siteId}/pairing`)).json().code;
  const ok = await app.inject({ method: 'POST', url: '/v1/pair', payload: { code: pairCode, home_url: 'https://www.vitrine.fr/', receive_url: 'https://www.vitrine.fr/wp-json/page-compiler/v1/receive', plugin_version: '0.3.0' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().site_id, siteId);
  secret = ok.json().secret;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/pair', payload: { code: pairCode, home_url: 'https://www.vitrine.fr/' } })).json().error, 'used_code');
  const site = (await call('GET', `/admin/api/sites/${siteId}`)).json().site;
  assert.ok(site.pairedAt);
  assert.equal(site.callbackUrl, 'https://www.vitrine.fr/wp-json/page-compiler/v1/receive');
  assert.equal(site.pluginVersion, '0.3.0');
});

const signed = (method, path, body, s = secret, id = siteId) => app.inject({
  method, url: path, payload: body ?? undefined,
  headers: { ...signedHeaders({ siteId: id, secret: s, method, path, body: body ? JSON.stringify(body) : '' }), ...(body ? { 'content-type': 'application/json' } : {}) },
});

test('demandes signées avec la clé appairée, site YAML toujours accepté', { skip }, async () => {
  const r = await signed('POST', '/v1/compile', { url: 'https://www.vitrine.fr/contact/' });
  assert.equal(r.statusCode, 202);
  assert.equal(added.at(-1).siteId, siteId);
  assert.equal((await signed('POST', '/v1/compile', { url: 'https://yaml.exemple.fr/' }, 'secret-yaml', 'site-yaml')).statusCode, 202);
  assert.equal((await signed('POST', '/v1/compile', { url: 'https://www.vitrine.fr/' }, 'mauvais-secret')).json().error, 'invalid_signature');
});

test('PageSpeed : clé requise, analyse mobile et ordinateur, résultats lisibles par le plugin', { skip }, async () => {
  assert.equal((await signed('POST', '/v1/pagespeed', { url: 'https://www.vitrine.fr/' })).json().error, 'pagespeed_not_configured');
  await call('PUT', '/admin/api/settings', { pagespeedApiKey: 'AIza-cle-test-1234' });
  assert.equal((await call('GET', '/admin/api/settings')).json().pagespeed.last4, '1234');
  const r = await signed('POST', '/v1/pagespeed', { url: 'https://www.vitrine.fr/' });
  assert.equal(r.statusCode, 202);
  assert.equal(r.json().ids.length, 2);
  for (let i = 0; i < 50; i += 1) {
    const items = (await signed('GET', `/v1/pagespeed?url=${encodeURIComponent('https://www.vitrine.fr/')}`)).json().items;
    if (items.every((x) => x.status !== 'pending')) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const items = (await signed('GET', `/v1/pagespeed?url=${encodeURIComponent('https://www.vitrine.fr/')}`)).json().items;
  assert.deepEqual(items.map((x) => x.strategy).sort(), ['desktop', 'mobile']);
  assert.ok(items.every((x) => x.status === 'done' && x.score === 0.87));
  assert.equal(items[0].metrics.lcp.value, 2400);
  assert.equal(items[0].field.page.metrics.LARGEST_CONTENTFUL_PAINT_MS.percentile, 2900);
  assert.match(items[0].reportUrl, /^https:\/\/pagespeed\.web\.dev\/report\?url=/);
  assert.deepEqual(psiCalls.map((p) => p.get('strategy')).sort(), ['DESKTOP', 'MOBILE']);
  assert.equal(psiCalls[0].get('key'), 'AIza-cle-test-1234');
  assert.equal((await call('GET', '/admin/api/dashboard')).json().sites[0].summary.pagespeed_mobile, 0.87);
});

test('rotation de clé : l\'ancienne est refusée aussitôt, pause du site', { skip }, async () => {
  await call('POST', `/admin/api/sites/${siteId}/rotate-secret`);
  assert.equal((await signed('POST', '/v1/compile', { url: 'https://www.vitrine.fr/' })).json().error, 'invalid_signature');
  const rev = await call('POST', `/admin/api/sites/${siteId}/reveal-secret`, { password: 'mot-de-passe-solide' });
  const fresh = rev.json().secret;
  assert.notEqual(fresh, secret);
  await call('PUT', `/admin/api/sites/${siteId}`, { status: 'paused' });
  assert.equal((await signed('POST', '/v1/compile', { url: 'https://www.vitrine.fr/' }, fresh)).json().error, 'site_paused');
});

test('import SITES_YAML : même identifiant, même secret', { skip }, async () => {
  const r = (await call('POST', '/admin/api/settings/import-yaml')).json();
  assert.deepEqual(r.imported, ['site-yaml']);
  assert.equal((await repo.sites.get('site-yaml', true)).secret, 'secret-yaml');
  assert.equal((await signed('POST', '/v1/compile', { url: 'https://yaml.exemple.fr/' }, 'secret-yaml', 'site-yaml')).statusCode, 202);
});

test('compte en lecture seule limité à un client', { skip }, async () => {
  const other = await repo.clients.create({ name: 'Autre client' });
  const uid = await repo.users.create({ email: 'lecture@exemple.fr', password: 'mot-de-passe-lecture', role: 'viewer' });
  await pool.query('INSERT INTO user_clients (user_id, client_id) VALUES ($1, $2)', [uid, other]);
  const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { email: 'lecture@exemple.fr', password: 'mot-de-passe-lecture' } });
  const c2 = res.headers['set-cookie'].split(';')[0];
  const t2 = res.json().csrf;
  const dash = (await app.inject({ method: 'GET', url: '/admin/api/dashboard', headers: { cookie: c2 } })).json();
  assert.equal(dash.sites.length, 0, 'aucun site de l\'autre client');
  assert.equal((await app.inject({ method: 'GET', url: `/admin/api/sites/${siteId}`, headers: { cookie: c2 } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/admin/api/clients', payload: { name: 'Z' }, headers: { cookie: c2, 'x-csrf-token': t2 } })).statusCode, 403);
});

test('mot de passe : changement et déconnexion des autres sessions', { skip }, async () => {
  assert.equal((await call('PUT', '/admin/api/account/password', { current: 'faux', next: 'nouveau-mot-de-passe' })).statusCode, 400);
  assert.equal((await call('PUT', '/admin/api/account/password', { current: 'mot-de-passe-solide', next: 'nouveau-mot-de-passe' })).statusCode, 200);
  assert.equal((await call('GET', '/admin/api/me')).statusCode, 200, 'la session courante reste ouverte');
  const audit = (await call('GET', '/admin/api/audit')).json().items.map((a) => a.action);
  for (const a of ['login', 'site_created', 'site_paired', 'secret_rotated', 'secret_revealed', 'password_changed']) assert.ok(audit.includes(a), a);
});
