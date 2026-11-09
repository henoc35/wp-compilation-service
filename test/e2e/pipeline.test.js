import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'bullmq';
import { startFixtureSite } from '../fixtures/site.js';
import { loadConfig } from '../../src/config.js';
import { createQueue, redisConnection } from '../../src/queue.js';
import { buildServer } from '../../src/api/server.js';
import { createWorker } from '../../src/worker/start.js';
import { loadRules } from '../../src/rules/index.js';
import { signedHeaders, verify, HEADERS } from '../../src/signature.js';
import pg from 'pg';
import { openDatabase } from '../../src/store/db.js';
import { createRepo } from '../../src/store/repo.js';
import { createBox } from '../../src/store/security.js';

/**
 * Test de bout en bout : Redis, API, worker, Chromium, faux site et faux plugin
 * (récepteur du résultat signé). Ignoré si Chromium ou redis-server manquent.
 */

const CHROMIUM = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const hasRedis = (() => {
  try {
    execSync('redis-server --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const skip = !CHROMIUM || !hasRedis ? 'Chromium ou redis-server absent' : false;

const SECRET = 'secret-e2e';
let redis;
let fixture;
let receiver;
let received = [];
const events = [];
let config;
let queue;
let app;
let worker;
// Historique en base : seulement si TEST_DATABASE_URL est fournie.
const DB_URL = process.env.TEST_DATABASE_URL;
let pool;
let repo = null;

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startRedis() {
  const port = await freePort();
  const proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    const ok = await new Promise((r) => {
      const c = net.connect(port, '127.0.0.1', () => { c.end(); r(true); });
      c.on('error', () => r(false));
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, url: `redis://127.0.0.1:${port}` };
}

/** Faux plugin WordPress : vérifie la signature et garde le résultat. */
async function startReceiver() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const check = verify({
        secret: SECRET,
        timestamp: req.headers[HEADERS.timestamp],
        signature: req.headers[HEADERS.signature],
        method: req.method,
        path: req.url,
        body,
      });
      if (!check.ok) {
        res.statusCode = 401;
        return res.end();
      }
      received.push(JSON.parse(body));
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/wp-json/page-compiler/v1/receive` };
}

function signedRequest(method, url, body) {
  const payload = body ? JSON.stringify(body) : '';
  return {
    method,
    url,
    payload: payload || undefined,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...signedHeaders({ siteId: 'site-test', secret: SECRET, method, path: url, body: payload }),
    },
  };
}

async function waitForJob(jobId, timeoutMs = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.inject(signedRequest('GET', `/v1/jobs/${jobId}`));
    const job = res.json();
    if (job.state === 'completed' || job.state === 'failed') return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('compilation trop longue');
}

before(async () => {
  if (skip) return;
  redis = await startRedis();
  fixture = await startFixtureSite();
  receiver = await startReceiver();
  config = {
    ...loadConfig(),
    redisUrl: redis.url,
    queueName: `e2e-${Date.now()}`,
    debounceMs: 200,
    chromiumPath: CHROMIUM,
    chromiumExtraArgs: ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights'],
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'page-compiler-e2e-')),
    measureRuns: 1,
  };
  const sites = new Map([['site-test', {
    id: 'site-test',
    domains: ['localhost'],
    secret: SECRET,
    callbackUrl: receiver.url,
    families: {},
    protectedSelectors: [],
    thirdPartyExtra: [fixture.trackerHost],
    neverDelay: [],
    masks: [],
    navigationExclude: [],
  }]]);
  queue = await createQueue(config);
  app = buildServer({ config, sites, queue, logger: false });
  await app.ready();
  const record = (level) => (obj, msg) => events.push({ level, msg, at: Date.now(), ...obj });
  if (DB_URL) {
    const admin = new pg.Pool({ connectionString: DB_URL });
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await admin.end();
    pool = await openDatabase(DB_URL);
    repo = createRepo(pool, createBox('cle-de-test-suffisamment-longue'));
  }
  worker = createWorker({ config, sites, rules: loadRules('rules'), repo, logger: { info: record('info'), warn: record('warn'), error: record('error') } });
});

after(async () => {
  if (skip) return;
  await worker?.close();
  await pool?.end();
  await app?.close();
  await queue?.obliterate({ force: true }).catch(() => {});
  await queue?.close();
  await fixture?.close();
  await new Promise((r) => receiver.server.close(r));
  redis?.proc.kill();
});

test('la file plafonne à 3 compilations simultanées, tous workers confondus', { skip }, async () => {
  assert.equal(await queue.getGlobalConcurrency(), 3);

  // Vérification du plafond avec des tâches factices et deux workers de 3 chacun.
  const name = `plafond-${Date.now()}`;
  const q = await createQueue({ ...config, queueName: name });
  let activeNow = 0;
  let maxActive = 0;
  const processor = async () => {
    activeNow += 1;
    maxActive = Math.max(maxActive, activeNow);
    await new Promise((r) => setTimeout(r, 300));
    activeNow -= 1;
  };
  const w1 = new Worker(name, processor, { connection: redisConnection(config.redisUrl), concurrency: 3 });
  const w2 = new Worker(name, processor, { connection: redisConnection(config.redisUrl), concurrency: 3 });
  await Promise.all(Array.from({ length: 9 }, (_, i) => q.add('t', { i })));
  const start = Date.now();
  while ((await q.getJobCounts('completed')).completed < 9 && Date.now() - start < 20000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await w1.close();
  await w2.close();
  await q.obliterate({ force: true });
  await q.close();
  assert.equal(maxActive, 3);
});

test('les demandes répétées pour la même page sont regroupées', { skip }, async () => {
  const body = { url: `${fixture.url}/dedup/` };
  const a = await app.inject(signedRequest('POST', '/v1/compile', body));
  const b = await app.inject(signedRequest('POST', '/v1/compile', body));
  assert.equal(a.statusCode, 202);
  assert.equal(a.json().jobId, b.json().jobId);
  const job = await queue.getJob(a.json().jobId);
  await job.remove().catch(() => {});
});

test('une page compatible est compilée, vérifiée et publiée au plugin', { skip, timeout: 300000 }, async () => {
  const res = await app.inject(signedRequest('POST', '/v1/compile', { url: `${fixture.url}/` }));
  assert.equal(res.statusCode, 202);
  const job = await waitForJob(res.json().jobId);
  assert.equal(job.state, 'completed');
  assert.equal(job.result.status, 'compiled');
  assert.deepEqual(job.result.familiesDisabled, []);
  assert.equal(job.result.published.published, true);

  const payload = received.find((p) => p.url === `${fixture.url}/`);
  assert.ok(payload, 'résultat reçu par le plugin');
  assert.match(payload.html, /<link rel="preload" as="image" fetchpriority="high" href="\/img\/hero\.png">/);
  assert.match(payload.html, /class="hero elementor-element e-no-lazyload"/);
  assert.doesNotMatch(payload.html, /data-id="h1x"[^>]*elementor-invisible|elementor-invisible[^>]*data-id="h1x"/);
  assert.match(payload.html, /data-cw-delay/);
  assert.match(payload.html, /type="speculationrules"/);
  assert.match(payload.html, /media="print" onload="this.media='all'"/);
  assert.ok(fixture.requests.some((r) => r.bypass === '1'), 'le rendu de l’original demande à contourner le cache');
});

test('une optimisation qui casse l’affichage est isolée et retirée', { skip, timeout: 300000 }, async () => {
  const res = await app.inject(signedRequest('POST', '/v1/compile', { url: `${fixture.url}/broken/` }));
  const job = await waitForJob(res.json().jobId);
  assert.equal(job.state, 'completed');
  assert.ok(job.result, `résultat absent : ${JSON.stringify(job)}`);
  assert.equal(job.result.status, 'compiled_partial');
  assert.deepEqual(job.result.familiesDisabled, ['scripts']);
  const payload = received.find((p) => p.url === `${fixture.url}/broken/`);
  assert.equal(payload.status, 'compiled_partial');
  assert.doesNotMatch(payload.html, /data-cw-delay/);
});

test('jamais deux compilations en même temps sur un même site', { skip, timeout: 400000 }, async () => {
  const urls = [`${fixture.url}/?a=1`, `${fixture.url}/?b=2`, `${fixture.url}/?c=3`];
  const ids = [];
  for (const u of urls) {
    const res = await app.inject(signedRequest('POST', '/v1/compile', { url: u }));
    ids.push(res.json().jobId);
  }
  for (const id of ids) await waitForJob(id, 360000);
  const spans = ids.map((id) => {
    const start = events.find((e) => e.msg === 'compilation démarrée' && String(e.jobId) === String(id));
    const end = events.find((e) => e.msg === 'compilation terminée' && String(e.jobId) === String(id));
    return [start.at, end.at];
  }).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i += 1) {
    assert.ok(spans[i][0] >= spans[i - 1][1], 'deux compilations du même site se chevauchent');
  }
});

test('une compilation plantée (site injoignable) est signalée au plugin avec son motif', { skip, timeout: 120000 }, async () => {
  const closed = await freePort();
  const url = `http://localhost:${closed}/`;
  const res = await app.inject(signedRequest('POST', '/v1/compile', { url }));
  const job = await waitForJob(res.json().jobId);
  assert.equal(job.state, 'failed');
  const payload = received.find((p) => p.url === url);
  assert.ok(payload, 'échec reçu par le plugin');
  assert.equal(payload.status, 'failed');
  assert.equal(payload.html, null);
  assert.match(payload.reason, /injoignable|refusée/);
});

test('une page instable est détectée dès le contrôle de départ', { skip, timeout: 300000 }, async () => {
  const res = await app.inject(signedRequest('POST', '/v1/compile', { url: `${fixture.url}/unstable/` }));
  const job = await waitForJob(res.json().jobId);
  assert.equal(job.result.status, 'failed');
  const payload = received.find((p) => p.url === `${fixture.url}/unstable/`);
  assert.match(payload.reason, /Page instable : deux chargements successifs/);
  assert.match(payload.reason, /\d+\.\d %/, 'le motif chiffre l\'écart');
  assert.equal(payload.attempts.length, 0, 'aucun rendu supplémentaire pour une page instable');
});

test('un écart de rejeu sur une page stable est signalé comme tel, chiffré', { skip, timeout: 300000 }, async () => {
  const res = await app.inject(signedRequest('POST', '/v1/compile', { url: `${fixture.url}/cookie-dependent/` }));
  const job = await waitForJob(res.json().jobId);
  assert.equal(job.result.status, 'failed');
  const payload = received.find((p) => p.url === `${fixture.url}/cookie-dependent/`);
  assert.match(payload.reason, /Contrôle de départ en échec/);
  assert.doesNotMatch(payload.reason, /instable/);
  assert.match(payload.reason, /hauteur \((mobile|desktop)\) : hauteur différente de/);
  assert.equal(payload.attempts.length, 1);
  assert.equal(payload.attempts[0].attempt, 0);
});

test('une page en erreur 404 est signalée au plugin', { skip, timeout: 120000 }, async () => {
  const res = await app.inject(signedRequest('POST', '/v1/compile', { url: `${fixture.url}/missing/` }));
  const job = await waitForJob(res.json().jobId);
  assert.equal(job.result.status, 'skipped');
  const payload = received.find((p) => p.url === `${fixture.url}/missing/`);
  assert.equal(payload.status, 'skipped');
  assert.match(payload.reason, /404/);
});

test('historique en base : poids par catégorie, fichiers et échecs enregistrés', { skip: skip || (!DB_URL && 'TEST_DATABASE_URL absente'), timeout: 30000 }, async () => {
  const rows = await repo.compilations.list('site-test', { limit: 100 });
  assert.ok(rows.length >= 3, 'chaque compilation est enregistrée');
  const compiled = rows.find((r) => r.status === 'compiled' || r.status === 'compiled_partial');
  assert.ok(compiled, 'une compilation réussie');
  const detail = await repo.compilations.get('site-test', compiled.id);
  const ref = detail.weights.reference.mobile;
  assert.ok(ref.total > 0 && ref.html > 0 && ref.css > 0 && ref.js > 0 && ref.images > 0, 'poids par catégorie');
  assert.ok(ref.initial > 0 && ref.initial <= ref.total);
  assert.ok(detail.weights.compiled?.mobile?.total > 0, 'poids de la version compilée');
  const images = detail.resources.reference.mobile.filter((r) => r.type === 'image');
  assert.ok(images.length >= 1 && images.every((r) => r.bytes > 0 && r.url.startsWith('http')), 'détail des images');
  assert.ok(detail.lcp_reference > 0);
  // Diagnostic : couverture CSS/JS et images mesurées sur la page d'origine.
  const diag = detail.diagnostics;
  assert.ok(diag, 'diagnostic enregistré');
  assert.ok(diag.files.some((f) => f.type === 'css' && f.total > 0 && f.unusedRatio >= 0 && f.unusedRatio <= 1), 'couverture CSS');
  assert.ok(diag.files.some((f) => f.type === 'js' && f.total > 0), 'couverture JS');
  assert.ok(diag.images.length >= 1 && diag.images.every((i) => i.natural[0] > 0 && i.needed > 0), 'images mesurées');
  assert.equal(detail.weights.diagnostics.cssTotal, diag.summary.cssTotal, 'résumé gardé 2 ans dans weights');
  const failed = rows.find((r) => r.status === 'failed' && /injoignable|Page instable|Contrôle de départ|Erreur du service/.test(r.reason || ''));
  assert.ok(failed, 'les échecs sont enregistrés avec leur motif');
});
