import crypto from 'node:crypto';
import Fastify from 'fastify';
import { HEADERS, verify } from '../signature.js';
import { enqueueCompilation } from '../queue.js';
import { ALL_FAMILIES } from '../config.js';
import { registerAdmin, createLimiter } from './admin.js';
import { reportUrl } from '../pagespeed.js';
import { parseBeacon } from '../rum.js';

/**
 * API du service de compilation.
 *
 *   GET  /health                santé (public)
 *   POST /v1/compile            demande de compilation (signée par le site)
 *   GET  /v1/jobs/:id           état d'une compilation (signée par le site)
 *   GET  /v1/admin/overview     vue d'ensemble de la file (jeton administrateur)
 *   POST /v1/pair               appairage d'un site par code à usage unique (public, limité)
 *   GET  /v1/pagespeed          analyses PageSpeed d'une page (signée par le site)
 *   POST /v1/pagespeed          lance une analyse PageSpeed (signée par le site)
 *   /admin, /admin/api/*        interface d'administration (avec une base de données)
 *
 * `sites` : registre (base + SITES_YAML, voir store/registry.js) ou simple Map.
 */
export function buildServer({ config, sites, queue, repo = null, pagespeed = null, logger = true }) {
  // Derrière le proxy de Coolify : IP et protocole réels des visiteurs (journaux, cookies Secure).
  const app = Fastify({ logger, bodyLimit: 256 * 1024, trustProxy: config.trustProxy ?? true });
  const resolveSite = (id) => (typeof sites.resolve === 'function' ? sites.resolve(id) : sites.get(id) || null);

  // Mesures des visiteurs envoyées par sendBeacon (text/plain).
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: 4096 }, (req, body, done) => done(null, body));

  // Erreurs de validation des données (code + message lisible) : 400 au lieu de 500.
  app.setErrorHandler((err, req, reply) => {
    if (err.code && err.statusCode === 400 && !err.validation) return reply.code(400).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code || 'bad_request', message: err.message });
    req.log.error({ err: err.message }, 'erreur interne');
    return reply.code(500).send({ error: 'internal_error' });
  });

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
    const site = siteId ? await resolveSite(String(siteId)) : undefined;
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
    if (site.paused) return reply.code(409).send({ error: 'site_paused' });
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
    const { url, lang, families, reason, assets_url: assetsUrl } = req.body || {};
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
      // Dossier public du site où déposer les polices locales (plugin 0.3+).
      assetsUrl: typeof assetsUrl === 'string' && assetsUrl.length < 500 ? assetsUrl : null,
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

  if (repo) {
    const pairLimiter = createLimiter({ max: 20, windowMs: 15 * 60 * 1000 });

    /**
     * Appairage : le plugin envoie le code affiché dans l'interface et l'adresse de son
     * site ; il reçoit l'identifiant et la clé. Le code est à usage unique et expire.
     */
    app.post('/v1/pair', async (req, reply) => {
      if (!pairLimiter(req.ip)) return reply.code(429).send({ error: 'too_many_attempts' });
      const { code, home_url: homeUrl, receive_url: receiveUrl, plugin_version: pluginVersion } = req.body || {};
      let host;
      try {
        host = new URL(String(homeUrl)).hostname.toLowerCase();
      } catch {
        return reply.code(400).send({ error: 'invalid_home_url' });
      }
      const result = await repo.pairing.consume(code);
      if (result.error) return reply.code(400).send({ error: result.error });
      const site = result.site;
      if (!site.domains.includes(host)) {
        req.log.warn({ siteId: site.id, host }, 'appairage refusé : domaine non déclaré');
        return reply.code(400).send({ error: 'domain_mismatch', domains: site.domains });
      }
      let callbackUrl = null;
      try {
        const u = new URL(String(receiveUrl || ''));
        if (u.protocol === 'https:' && site.domains.includes(u.hostname.toLowerCase())) callbackUrl = u.toString();
      } catch { /* adresse de réception facultative */ }
      await repo.sites.markPaired(site.id, { callbackUrl, pluginVersion: pluginVersion ? String(pluginVersion).slice(0, 20) : null });
      await repo.audit.log(null, 'site_paired', site.id, { host, pluginVersion: pluginVersion || null });
      req.log.info({ siteId: site.id, host }, 'site appairé');
      return { site_id: site.id, secret: site.secret, name: site.name, domains: site.domains };
    });

    const pagespeedView = (r) => ({
      id: r.id, url: r.url, strategy: r.strategy, status: r.status, score: r.score, metrics: r.metrics, field: r.field,
      error: r.error, createdAt: r.created_at, finishedAt: r.finished_at, reportUrl: reportUrl(r.url, r.strategy),
    });

    app.get('/v1/pagespeed', { preHandler: authenticateSite }, async (req) => {
      const url = req.query.url ? String(req.query.url) : null;
      const runs = await repo.pagespeed.list(req.site.id, { url, limit: url ? 10 : 50 });
      return { configured: Boolean(await pagespeed.apiKey()), items: runs.map(pagespeedView) };
    });

    app.post('/v1/pagespeed', { preHandler: authenticateSite }, async (req, reply) => {
      let parsed;
      try {
        parsed = new URL(String(req.body?.url || ''));
      } catch {
        return reply.code(400).send({ error: 'invalid_url' });
      }
      if (!req.site.domains.includes(parsed.hostname.toLowerCase())) return reply.code(403).send({ error: 'domain_not_allowed' });
      const ids = await pagespeed.start(req.site.id, parsed.toString(), ['mobile', 'desktop'], `site:${req.site.id}`);
      return reply.code(202).send({ ids });
    });

    /**
     * Mesures des visiteurs (sendBeacon, en text/plain : pas de requête préalable CORS).
     * Acceptées seulement si le site a activé l'option et si l'origine est l'un de ses domaines.
     */
    const rumLimiter = createLimiter({ max: 120, windowMs: 60 * 1000 });
    app.post('/v1/rum/:siteId', async (req, reply) => {
      reply.header('cache-control', 'no-store');
      if (!rumLimiter(req.ip)) return reply.code(429).send();
      const site = await resolveSite(String(req.params.siteId));
      if (!site || site.paused || !site.options?.rum) return reply.code(404).send();
      let host = null;
      try {
        host = new URL(String(req.headers.origin || req.headers.referer || '')).hostname.toLowerCase();
      } catch { /* origine absente */ }
      if (!host || !site.domains.includes(host)) return reply.code(403).send();
      const event = parseBeacon(req.body);
      if (!event) return reply.code(400).send();
      await repo.rum.add(site.id, event);
      return reply.code(204).send();
    });

    registerAdmin(app, { config, repo, registry: sites, queue, pagespeed });
  }

  return app;
}
