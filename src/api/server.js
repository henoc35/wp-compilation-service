import crypto from 'node:crypto';
import Fastify from 'fastify';
import { HEADERS, verify } from '../signature.js';
import { enqueueCompilation } from '../queue.js';
import { ALL_FAMILIES } from '../config.js';

/**
 * API du service de compilation.
 *
 *   GET  /health                santé (public)
 *   POST /v1/compile            demande de compilation (signée par le site)
 *   GET  /v1/jobs/:id           état d'une compilation (signée par le site)
 *   GET  /v1/admin/overview     vue d'ensemble de la file (jeton administrateur)
 */
export function buildServer({ config, sites, queue, logger = true }) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

  // Corps conservé brut : la signature porte sur les octets reçus.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch {
      const err = new Error('JSON invalide');
      err.statusCode = 400;
      done(err);
    }
  });

  async function authenticateSite(req, reply) {
    const siteId = req.headers[HEADERS.site];
    const site = siteId ? sites.get(String(siteId)) : undefined;
    if (!site) return reply.code(401).send({ error: 'unknown_site' });
    const result = verify({
      secret: site.secret,
      timestamp: req.headers[HEADERS.timestamp],
      signature: req.headers[HEADERS.signature],
      method: req.method,
      path: req.url,
      body: req.rawBody ?? '',
      maxAgeSeconds: config.signatureMaxAgeSeconds,
    });
    if (!result.ok) {
      req.log.warn({ siteId, reason: result.reason }, 'signature refusée');
      return reply.code(401).send({ error: result.reason });
    }
    req.site = site;
  }

  async function authenticateAdmin(req, reply) {
    const token = process.env.ADMIN_TOKEN;
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const digest = (s) => crypto.createHash('sha256').update(s).digest();
    const ok = Boolean(token) && crypto.timingSafeEqual(digest(given), digest(token));
    if (!ok) return reply.code(401).send({ error: 'unauthorized' });
  }

  app.get('/health', async () => {
    // Une lecture réelle dans Redis, limitée à 3 s.
    const redis = await Promise.race([
      queue.getJobCounts('waiting').then(() => 'ok'),
      new Promise((resolve) => setTimeout(() => resolve('error'), 3000)),
    ]).catch(() => 'error');
    return { status: redis === 'ok' ? 'ok' : 'degraded', redis, concurrency: config.chromiumConcurrency };
  });

  app.post('/v1/compile', { preHandler: authenticateSite }, async (req, reply) => {
    const { url, lang, families, reason } = req.body || {};
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reply.code(400).send({ error: 'protocol_not_allowed' });
    }
    if (!req.site.domains.includes(parsed.hostname.toLowerCase())) {
      return reply.code(403).send({ error: 'domain_not_allowed' });
    }
    if (families !== undefined) {
      const ok = Array.isArray(families) && families.every((f) => ALL_FAMILIES.includes(f));
      if (!ok) return reply.code(400).send({ error: 'invalid_families', valid: ALL_FAMILIES });
    }
    parsed.hash = '';
    const job = await enqueueCompilation(queue, config, {
      siteId: req.site.id,
      url: parsed.toString(),
      lang: lang || null,
      families: families || null,
      reason: reason || 'manual',
      requestedAt: new Date().toISOString(),
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/v1/jobs/:id', { preHandler: authenticateSite }, async (req, reply) => {
    const job = await queue.getJob(req.params.id);
    if (!job || job.data.siteId !== req.site.id) return reply.code(404).send({ error: 'not_found' });
    const state = await job.getState();
    const result = job.returnvalue || null;
    return {
      jobId: job.id,
      state,
      url: job.data.url,
      progress: job.progress,
      result: result && {
        status: result.status,
        reason: result.reason || null,
        familiesApplied: result.familiesApplied,
        familiesDisabled: result.familiesDisabled,
        attempts: result.attempts?.length ?? 0,
        lcp: result.lcp,
        published: result.published,
      },
      failedReason: job.failedReason || null,
    };
  });

  app.get('/v1/admin/overview', { preHandler: authenticateAdmin }, async () => {
    const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed');
    const recent = await queue.getJobs(['completed', 'failed', 'active'], 0, 19, false);
    return {
      concurrency: config.chromiumConcurrency,
      counts,
      recent: await Promise.all(recent.map(async (j) => ({
        jobId: j.id,
        siteId: j.data.siteId,
        url: j.data.url,
        state: await j.getState(),
        status: j.returnvalue?.status ?? null,
        finishedOn: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
      }))),
    };
  });

  return app;
}
