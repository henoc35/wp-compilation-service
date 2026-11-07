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
let config;
let queue;
let app;
let worker;

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
  return { server, url: `http://127.0.0.1:${server.address().port}/wp-json/compilateur/v1/recevoir` };
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
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'compilateur-e2e-')),
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
  worker = createWorker({ config, sites, rules: loadRules('rules'), logger: { info() {}, error() {} } });
});

after(async () => {
  if (skip) return;
  await worker?.close();
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
  const body = { url: `${fixture.url}/regroupement/` };
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
  const res = await app.inject(signedRequest('POST', '/v1/compile', { url: `${fixture.url}/casse/` }));
  const job = await waitForJob(res.json().jobId);
  assert.equal(job.state, 'completed');
  assert.equal(job.result.status, 'compiled_partial');
  assert.deepEqual(job.result.familiesDisabled, ['scripts']);
  const payload = received.find((p) => p.url === `${fixture.url}/casse/`);
  assert.equal(payload.status, 'compiled_partial');
  assert.doesNotMatch(payload.html, /data-cw-delay/);
});
