import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enqueueCompilation } from '../queue.js';
import { reportUrl } from '../pagespeed.js';
import { ALL_FAMILIES } from '../config.js';
import { queryCruxHistory } from '../crux.js';

/**
 * Interface d'administration : pages statiques sous /admin et API JSON sous /admin/api.
 *
 * Session par cookie (HttpOnly, SameSite=Strict) ; toute modification exige en plus
 * l'en-tête X-CSRF-Token de la session. Les rôles et la limitation par client sont
 * déjà en place (un administrateur voit tout) pour l'ajout de comptes d'équipe.
 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'admin');
const COOKIE = 'pc_session';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Limiteur simple en mémoire (connexion, appairage) : `max` essais par fenêtre et par clé. */
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const t = Date.now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    list.push(t);
    hits.set(key, list);
    if (hits.size > 10000) hits.clear();
    return list.length <= max;
  };
}

const ROLE_RANK = { viewer: 0, editor: 1, admin: 2 };
const canEdit = (user) => ROLE_RANK[user.role] >= ROLE_RANK.editor;

/** Fichiers des captures d'une compilation (dossier jobs/<tâche>/), chemins relatifs. */
function listArtifacts(dir) {
  const out = [];
  const walk = (d, prefix) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else if (/\.(png|json|html)$/.test(e.name)) out.push(`${prefix}${e.name}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

export function registerAdmin(app, { config, repo, registry, queue, pagespeed }) {
  const loginLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const statics = new Map();
  for (const f of fs.existsSync(PUBLIC_DIR) ? fs.readdirSync(PUBLIC_DIR) : []) {
    statics.set(f, { body: fs.readFileSync(path.join(PUBLIC_DIR, f)), type: TYPES[path.extname(f)] || 'application/octet-stream' });
  }

  const sendStatic = (reply, name) => {
    const file = statics.get(name);
    if (!file) return reply.code(404).send({ error: 'not_found' });
    return reply.headers(SECURITY_HEADERS).type(file.type).send(file.body);
  };
  app.get('/admin', (req, reply) => sendStatic(reply, 'index.html'));
  app.get('/admin/', (req, reply) => sendStatic(reply, 'index.html'));
  app.get('/admin/assets/:name', (req, reply) => sendStatic(reply, req.params.name));

  const secureCookie = (req) => req.protocol === 'https';
  const setSession = (req, reply, token, maxAge) => reply.header('set-cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookie(req) ? '; Secure' : ''}`);

  /* ---------- Authentification ---------- */
  async function auth(req, reply) {
    reply.headers(SECURITY_HEADERS);
    const session = await repo.sessions.get(readCookie(req, COOKIE));
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) {
      return reply.code(403).send({ error: 'csrf' });
    }
    req.user = session.user;
    req.csrf = session.csrf;
    req.scope = await repo.users.clientScope(session.user);
  }
  const requireEditor = async (req, reply) => {
    if (!canEdit(req.user)) return reply.code(403).send({ error: 'forbidden' });
  };
  const requireAdmin = async (req, reply) => {
    if (req.user.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
  };
  /** Site visible par le compte connecté (404 sinon, sans révéler son existence). */
  async function loadSite(req, reply) {
    const site = await repo.sites.get(req.params.id);
    if (!site || (req.scope && !req.scope.includes(site.clientId))) return reply.code(404).send({ error: 'not_found' });
    req.site = site;
  }

  app.post('/admin/api/login', async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    if (!loginLimiter(req.ip)) return reply.code(429).send({ error: 'too_many_attempts' });
    if ((await repo.users.count()) === 0) return reply.code(409).send({ error: 'no_account' });
    const { email, password } = req.body || {};
    const user = await repo.users.authenticate(email, password);
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
    const { token, csrf } = await repo.sessions.create(user.id, config.sessionTtlHours);
    setSession(req, reply, token, config.sessionTtlHours * 3600);
    await repo.audit.log(user.id, 'login');
    return { user, csrf };
  });

  app.get('/admin/api/status', async (req, reply) => {
    reply.headers(SECURITY_HEADERS);
    return { accounts: (await repo.users.count()) > 0 };
  });

  app.post('/admin/api/logout', { preHandler: auth }, async (req, reply) => {
    await repo.sessions.destroy(readCookie(req, COOKIE));
    setSession(req, reply, '', 0);
    return { ok: true };
  });

  app.get('/admin/api/me', { preHandler: auth }, async (req) => ({ user: req.user, csrf: req.csrf }));

  app.put('/admin/api/account/password', { preHandler: auth }, async (req, reply) => {
    const { current, next } = req.body || {};
    if (!(await repo.users.checkPassword(req.user.id, current))) return reply.code(400).send({ error: 'invalid_current_password' });
    await repo.users.setPassword(req.user.id, next);
    await repo.sessions.destroyForUser(req.user.id, readCookie(req, COOKIE));
    await repo.audit.log(req.user.id, 'password_changed');
    return { ok: true };
  });

  /* ---------- Tableau de bord ---------- */
  app.get('/admin/api/dashboard', { preHandler: auth }, async (req) => {
    const [clients, sites, summaries, counts] = await Promise.all([
      repo.clients.list(), repo.sites.list(req.scope), repo.sites.summaries(), queue.getJobCounts('waiting', 'active', 'delayed'),
    ]);
    const visibleClients = req.scope ? clients.filter((c) => req.scope.includes(c.id)) : clients;
    const yaml = req.user.role === 'admin'
      ? [...registry.yamlSites.values()].filter((s) => !sites.some((d) => d.id === s.id)).map((s) => ({ id: s.id, domains: s.domains }))
      : [];
    return {
      clients: visibleClients,
      sites: sites.map((s) => ({ ...s, summary: summaries[s.id] || {} })),
      yamlSites: yaml,
      queue: counts,
    };
  });

  /* ---------- Clients ---------- */
  app.get('/admin/api/clients', { preHandler: auth }, async (req) => {
    const list = await repo.clients.list();
    return req.scope ? list.filter((c) => req.scope.includes(c.id)) : list;
  });
  app.post('/admin/api/clients', { preHandler: [auth, requireAdmin] }, async (req) => {
    const id = await repo.clients.create(req.body || {});
    await repo.audit.log(req.user.id, 'client_created', String(id), { name: req.body?.name });
    return { id };
  });
  app.put('/admin/api/clients/:cid', { preHandler: [auth, requireAdmin] }, async (req, reply) => {
    if (!(await repo.clients.update(Number(req.params.cid), req.body || {}))) return reply.code(404).send({ error: 'not_found' });
    await repo.audit.log(req.user.id, 'client_updated', req.params.cid);
    return { ok: true };
  });
  app.delete('/admin/api/clients/:cid', { preHandler: [auth, requireAdmin] }, async (req) => {
    await repo.clients.remove(Number(req.params.cid));
    await repo.audit.log(req.user.id, 'client_deleted', req.params.cid);
    return { ok: true };
  });

  /* ---------- Sites ---------- */
  app.post('/admin/api/sites', { preHandler: [auth, requireAdmin] }, async (req) => {
    const b = req.body || {};
    const id = await repo.sites.create({ id: b.id || null, name: b.name, clientId: b.clientId || null, domains: b.domains, callbackUrl: b.callbackUrl || null });
    await repo.audit.log(req.user.id, 'site_created', id);
    const code = await repo.pairing.create(id, config.pairingTtlMinutes);
    return { id, pairing: code };
  });

  app.get('/admin/api/sites/:id', { preHandler: [auth, loadSite] }, async (req) => {
    const [pending, pages, total, psi] = await Promise.all([
      repo.pairing.pending(req.site.id), repo.compilations.pages(req.site.id), repo.compilations.count(req.site.id), repo.pagespeed.list(req.site.id, { limit: 20 }),
    ]);
    return {
      site: req.site,
      pairingPending: pending,
      compilations: total,
      pages,
      pagespeed: psi.map((r) => ({ ...r, reportUrl: reportUrl(r.url, r.strategy) })),
      pagespeedConfigured: Boolean(await pagespeed.apiKey()),
    };
  });

  app.put('/admin/api/sites/:id', { preHandler: [auth, requireEditor, loadSite] }, async (req) => {
    const b = req.body || {};
    // Options de compilation du site : fusion avec les options existantes.
    let options;
    if (b.options && typeof b.options === 'object') {
      options = { ...req.site.options };
      if ('navigation_mode' in b.options) options.navigation_mode = ['prerender', 'prefetch'].includes(b.options.navigation_mode) ? b.options.navigation_mode : undefined;
      if (b.options.families && typeof b.options.families === 'object') {
        options.families = Object.fromEntries(Object.entries(b.options.families).filter(([k]) => ALL_FAMILIES.includes(k)).map(([k, v]) => [k, Boolean(v)]));
      }
      if ('rum' in b.options) options.rum = Boolean(b.options.rum);
    }
    await repo.sites.update(req.site.id, {
      name: b.name, clientId: b.clientId, domains: b.domains, callbackUrl: b.callbackUrl, options,
      status: b.status === 'paused' ? 'paused' : (b.status === 'active' ? 'active' : undefined),
    });
    await repo.audit.log(req.user.id, 'site_updated', req.site.id);
    return { site: await repo.sites.get(req.site.id) };
  });

  app.delete('/admin/api/sites/:id', { preHandler: [auth, requireAdmin, loadSite] }, async (req) => {
    await repo.sites.remove(req.site.id);
    await repo.audit.log(req.user.id, 'site_deleted', req.site.id);
    return { ok: true };
  });

  app.post('/admin/api/sites/:id/pairing', { preHandler: [auth, requireEditor, loadSite] }, async (req) => {
    const code = await repo.pairing.create(req.site.id, config.pairingTtlMinutes);
    await repo.audit.log(req.user.id, 'pairing_code_created', req.site.id);
    return code;
  });

  app.post('/admin/api/sites/:id/rotate-secret', { preHandler: [auth, requireAdmin, loadSite] }, async (req) => {
    await repo.sites.rotateSecret(req.site.id);
    const code = await repo.pairing.create(req.site.id, config.pairingTtlMinutes);
    await repo.audit.log(req.user.id, 'secret_rotated', req.site.id);
    return { pairing: code };
  });

  /** Secret en clair, pour une configuration manuelle (wp-config) : réservé à l'administrateur, journalisé. */
  app.post('/admin/api/sites/:id/reveal-secret', { preHandler: [auth, requireAdmin, loadSite] }, async (req, reply) => {
    if (!(await repo.users.checkPassword(req.user.id, req.body?.password))) return reply.code(400).send({ error: 'invalid_current_password' });
    await repo.audit.log(req.user.id, 'secret_revealed', req.site.id);
    return { secret: (await repo.sites.get(req.site.id, true)).secret };
  });

  app.get('/admin/api/sites/:id/compilations', { preHandler: [auth, loadSite] }, async (req) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    return { items: await repo.compilations.list(req.site.id, { url: req.query.url || null, limit, offset }) };
  });

  app.get('/admin/api/sites/:id/compilations/:cid', { preHandler: [auth, loadSite] }, async (req, reply) => {
    const c = await repo.compilations.get(req.site.id, Number(req.params.cid));
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const files = c.job_id && /^[\w-]+$/.test(c.job_id) ? listArtifacts(path.join(config.dataDir, 'jobs', c.job_id)) : [];
    return { compilation: c, files };
  });

  app.get('/admin/api/sites/:id/compilations/:cid/files/*', { preHandler: [auth, loadSite] }, async (req, reply) => {
    const c = await repo.compilations.get(req.site.id, Number(req.params.cid));
    if (!c?.job_id || !/^[\w-]+$/.test(c.job_id)) return reply.code(404).send({ error: 'not_found' });
    const base = path.resolve(config.dataDir, 'jobs', c.job_id);
    const file = path.resolve(base, req.params['*']);
    if (!file.startsWith(base + path.sep) || !/\.(png|json|html)$/.test(file) || !fs.existsSync(file)) return reply.code(404).send({ error: 'not_found' });
    const type = file.endsWith('.png') ? 'image/png' : (file.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
    // Le HTML capturé est servi en texte brut : jamais interprété dans l'interface.
    return reply.type(type).header('content-disposition', file.endsWith('.html') ? 'attachment' : 'inline').send(fs.createReadStream(file));
  });

  app.post('/admin/api/sites/:id/compile', { preHandler: [auth, requireEditor, loadSite] }, async (req, reply) => {
    const url = String(req.body?.url || '');
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    if (!req.site.domains.includes(host)) return reply.code(400).send({ error: 'domain_not_allowed' });
    const job = await enqueueCompilation(queue, config, { siteId: req.site.id, url, lang: null, families: null, requestedAt: new Date().toISOString() });
    await repo.audit.log(req.user.id, 'compile_requested', req.site.id, { url });
    return { jobId: job.id };
  });

  /** Diagnostic du site : dernier relevé de chaque page, fichiers et images regroupés. */
  app.get('/admin/api/sites/:id/diagnostics', { preHandler: [auth, loadSite] }, async (req) => aggregateDiagnostics(await repo.compilations.latestDiagnostics(req.site.id)));

  /* ---------- Visiteurs réels (CrUX) ---------- */
  app.get('/admin/api/sites/:id/crux', { preHandler: [auth, loadSite] }, async (req) => ({
    items: await repo.crux.latest(req.site.id),
    configured: Boolean(await pagespeed.apiKey()),
  }));

  app.post('/admin/api/sites/:id/crux', { preHandler: [auth, requireEditor, loadSite] }, async (req, reply) => {
    const key = await pagespeed.apiKey();
    if (!key) return reply.code(400).send({ error: 'pagespeed_not_configured' });
    const origin = `https://${req.site.domains[0]}`;
    for (const formFactor of ['PHONE', 'DESKTOP']) {
      try {
        await repo.crux.save(req.site.id, origin, formFactor, await queryCruxHistory({ origin, formFactor, apiKey: key, endpoint: config.cruxEndpoint }));
      } catch (err) {
        await repo.crux.save(req.site.id, origin, formFactor, null, err.message);
      }
    }
    return { items: await repo.crux.latest(req.site.id) };
  });

  app.get('/admin/api/sites/:id/rum', { preHandler: [auth, loadSite] }, async (req) => ({
    enabled: Boolean(req.site.options?.rum), publicUrl: Boolean(config.publicUrl), ...(await repo.rum.summary(req.site.id)),
  }));

  /* ---------- PageSpeed ---------- */
  app.get('/admin/api/sites/:id/pagespeed', { preHandler: [auth, loadSite] }, async (req) => {
    const runs = await repo.pagespeed.list(req.site.id, { url: req.query.url || null, limit: 50 });
    return { items: runs.map((r) => ({ ...r, reportUrl: reportUrl(r.url, r.strategy) })) };
  });

  app.post('/admin/api/sites/:id/pagespeed', { preHandler: [auth, requireEditor, loadSite] }, async (req, reply) => {
    const url = String(req.body?.url || `https://${req.site.domains[0]}/`);
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return reply.code(400).send({ error: 'invalid_url' });
    }
    if (!req.site.domains.includes(host)) return reply.code(400).send({ error: 'domain_not_allowed' });
    const ids = await pagespeed.start(req.site.id, url, ['mobile', 'desktop'], req.user.email);
    return { ids };
  });

  /* ---------- Réglages ---------- */
  app.get('/admin/api/settings', { preHandler: [auth, requireAdmin] }, async () => {
    const stored = await repo.settings.get('pagespeed_api_key');
    return {
      pagespeed: {
        configured: Boolean(config.pagespeedApiKey || stored),
        fromEnvironment: Boolean(config.pagespeedApiKey),
        last4: (config.pagespeedApiKey || stored || '').slice(-4) || null,
      },
      yamlSites: [...registry.yamlSites.values()].map((s) => ({ id: s.id, domains: s.domains, hasSecret: Boolean(s.secret) })),
    };
  });

  app.put('/admin/api/settings', { preHandler: [auth, requireAdmin] }, async (req) => {
    if (req.body && 'pagespeedApiKey' in req.body) {
      await repo.settings.set('pagespeed_api_key', String(req.body.pagespeedApiKey || '').trim(), { encrypted: true });
      await repo.audit.log(req.user.id, 'pagespeed_key_updated');
    }
    return { ok: true };
  });

  /** Reprend dans la base les sites de SITES_YAML (même identifiant, même secret : rien à refaire côté WordPress). */
  app.post('/admin/api/settings/import-yaml', { preHandler: [auth, requireAdmin] }, async (req) => {
    const imported = [];
    const skipped = [];
    for (const s of registry.yamlSites.values()) {
      if (!s.secret) {
        skipped.push({ id: s.id, reason: 'secret absent' });
        continue;
      }
      try {
        await repo.sites.create({
          id: s.id, name: s.name || s.id, domains: s.domains, callbackUrl: s.callbackUrl, secret: s.secret,
          options: {
            families: s.families, protected_selectors: s.protectedSelectors, third_party_extra: s.thirdPartyExtra,
            never_delay: s.neverDelay, masks: s.masks, navigation_exclude: s.navigationExclude,
          },
        });
        imported.push(s.id);
      } catch (err) {
        skipped.push({ id: s.id, reason: err.message });
      }
    }
    await repo.audit.log(req.user.id, 'yaml_imported', null, { imported, skipped });
    return { imported, skipped };
  });

  app.get('/admin/api/audit', { preHandler: [auth, requireAdmin] }, async () => ({ items: await repo.audit.list(100) }));
}

/** Regroupe les diagnostics des pages d'un site : un fichier ou une image utilisés par plusieurs pages ne comptent qu'une fois. */
export function aggregateDiagnostics(rows) {
  const files = new Map();
  const images = new Map();
  for (const row of rows) {
    const d = row.diagnostics || {};
    for (const f of d.files || []) {
      const k = `${f.type} ${f.url}`;
      const cur = files.get(k) || { type: f.type, url: f.url, total: f.total, transfer: f.transfer, pages: 0, unusedSum: 0, minUnused: 1 };
      cur.pages += 1;
      cur.unusedSum += f.unusedRatio;
      cur.minUnused = Math.min(cur.minUnused, f.unusedRatio);
      files.set(k, cur);
    }
    for (const im of d.images || []) {
      const cur = images.get(im.url);
      if (!cur) images.set(im.url, { ...im, pages: 1, pageUrls: [row.url] });
      else {
        cur.pages += 1;
        if (cur.pageUrls.length < 5) cur.pageUrls.push(row.url);
        if (im.needed > cur.needed) Object.assign(cur, { needed: im.needed, oversize: im.oversize, savings: im.savings });
        cur.lcp = cur.lcp || im.lcp;
      }
    }
  }
  const fileList = [...files.values()].map((f) => ({
    type: f.type, url: f.url, total: f.total, transfer: f.transfer, pages: f.pages,
    unusedRatio: f.unusedSum / f.pages, // moyenne sur les pages
    unusedEverywhere: f.minUnused, // part inutilisée même sur la page qui en utilise le plus
  })).sort((a, b) => b.total * b.unusedEverywhere - a.total * a.unusedEverywhere);
  const imageList = [...images.values()].sort((a, b) => b.savings - a.savings || (b.bytes || 0) - (a.bytes || 0));
  const css = fileList.filter((f) => f.type === 'css');
  const js = fileList.filter((f) => f.type === 'js');
  const sum = (l, f) => l.reduce((n, x) => n + (f(x) || 0), 0);
  return {
    pages: rows.length,
    summary: {
      cssFiles: css.length, cssTotal: sum(css, (f) => f.total), cssUnusedEverywhere: sum(css, (f) => f.total * f.unusedEverywhere),
      jsFiles: js.length, jsTotal: sum(js, (f) => f.total), jsUnusedEverywhere: sum(js, (f) => f.total * f.unusedEverywhere),
      bfcacheBlocked: rows.filter((r) => r.diagnostics?.bfcache && !r.diagnostics.bfcache.eligible).length,
      bfcacheBlockers: [...new Set(rows.flatMap((r) => r.diagnostics?.bfcache?.blockers || []))],
      images: imageList.length, imagesOversized: imageList.filter((i) => i.savings > 0).length, imagesSavings: sum(imageList, (i) => i.savings),
    },
    files: fileList.slice(0, 200),
    images: imageList.slice(0, 200),
  };
}
