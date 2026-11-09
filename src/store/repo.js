import { hashPassword, verifyPassword, sha256, randomToken, randomSecret, pairingCode, normalizeCode } from './security.js';

/** Identifiant de site : lettres minuscules, chiffres et tirets. */
export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
// Nom de domaine ; localhost et IPv4 acceptés pour les essais en local.
const DOMAIN_PATTERN = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})$/;

const fail = (code, message) => Object.assign(new Error(message), { code, statusCode: 400 });

export function normalizeDomains(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const out = [];
  for (const raw of list) {
    const d = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    if (!d) continue;
    if (!DOMAIN_PATTERN.test(d)) throw fail('invalid_domain', `domaine invalide : ${d}`);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Durées de conservation de l'historique. */
export const RETENTION = { detailDays: 90, summaryDays: 730 };

/**
 * Accès aux données (PostgreSQL). `box` chiffre les secrets des sites et la clé PageSpeed.
 */
export function createRepo(pool, box) {
  const all = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
  const run = async (sql, params = []) => (await pool.query(sql, params)).rowCount;

  /* ---------- Comptes ---------- */
  const DUMMY_HASH = hashPassword('mot-de-passe-factice');
  const users = {
    count: async () => (await one('SELECT COUNT(*)::int n FROM users')).n,
    async create({ email, name = null, password, role = 'admin' }) {
      if (!String(password || '').length || String(password).length < 10) throw fail('weak_password', 'mot de passe de 10 caractères minimum');
      const r = await one('INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [String(email).trim(), name, hashPassword(password), role]);
      return r.id;
    },
    byId: (id) => one('SELECT id, email, name, role, disabled, created_at, last_login_at FROM users WHERE id = $1', [id]),
    async authenticate(email, password) {
      const u = await one('SELECT * FROM users WHERE lower(email) = lower($1) AND NOT disabled', [String(email || '').trim()]);
      // Vérification faite même sans compte : même temps de réponse.
      const ok = verifyPassword(password, u?.password_hash || DUMMY_HASH);
      if (!u || !ok) return null;
      await run('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
      return users.byId(u.id);
    },
    async setPassword(id, password) {
      if (String(password || '').length < 10) throw fail('weak_password', 'mot de passe de 10 caractères minimum');
      await run('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), id]);
    },
    async checkPassword(id, password) {
      const u = await one('SELECT password_hash FROM users WHERE id = $1', [id]);
      return Boolean(u) && verifyPassword(password, u.password_hash);
    },
    /** Clients visibles par un compte : null = tous (administrateur). */
    async clientScope(user) {
      if (user.role === 'admin') return null;
      return (await all('SELECT client_id FROM user_clients WHERE user_id = $1', [user.id])).map((r) => r.client_id);
    },
  };

  /* ---------- Sessions ---------- */
  const sessions = {
    async create(userId, ttlHours) {
      const token = randomToken();
      const csrf = randomToken(24);
      await run('DELETE FROM sessions WHERE expires_at < now()');
      await run(`INSERT INTO sessions (id_hash, user_id, csrf, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
        [sha256(token), userId, csrf, ttlHours]);
      return { token, csrf };
    },
    async get(token) {
      if (!token) return null;
      const s = await one(`SELECT s.csrf, u.id, u.email, u.name, u.role, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.expires_at > now()`, [sha256(token)]);
      if (!s || s.disabled) return null;
      return { csrf: s.csrf, user: { id: s.id, email: s.email, name: s.name, role: s.role } };
    },
    destroy: (token) => run('DELETE FROM sessions WHERE id_hash = $1', [sha256(token || '')]),
    destroyForUser: (userId, exceptToken = null) => run('DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2', [userId, sha256(exceptToken || '')]),
  };

  /* ---------- Clients ---------- */
  const clients = {
    list: () => all(`SELECT c.*, (SELECT COUNT(*)::int FROM sites s WHERE s.client_id = c.id) AS sites FROM clients c ORDER BY lower(c.name)`),
    get: (id) => one('SELECT * FROM clients WHERE id = $1', [id]),
    async create({ name, notes = null }) {
      const n = String(name || '').trim();
      if (!n) throw fail('invalid_name', 'nom du client obligatoire');
      try {
        return (await one('INSERT INTO clients (name, notes) VALUES ($1, $2) RETURNING id', [n, notes || null])).id;
      } catch (err) {
        if (err.code === '23505') throw fail('duplicate_name', `le client « ${n} » existe déjà`);
        throw err;
      }
    },
    async update(id, { name, notes = null }) {
      const n = String(name || '').trim();
      if (!n) throw fail('invalid_name', 'nom du client obligatoire');
      try {
        return (await run('UPDATE clients SET name = $1, notes = $2 WHERE id = $3', [n, notes || null, id])) > 0;
      } catch (err) {
        if (err.code === '23505') throw fail('duplicate_name', `le client « ${n} » existe déjà`);
        throw err;
      }
    },
    remove: (id) => run('DELETE FROM clients WHERE id = $1', [id]),
  };

  /* ---------- Sites ---------- */
  const SITE_SELECT = `SELECT s.*, c.name AS client_name FROM sites s LEFT JOIN clients c ON c.id = s.client_id`;
  const rowToSite = (r, withSecret = false) => {
    if (!r) return null;
    const o = r.options || {};
    const site = {
      id: r.id,
      name: r.name,
      clientId: r.client_id,
      clientName: r.client_name ?? null,
      domains: r.domains || [],
      callbackUrl: r.callback_url,
      status: r.status,
      createdAt: r.created_at,
      pairedAt: r.paired_at,
      pluginVersion: r.plugin_version,
      options: o,
      // Champs attendus par le pipeline (mêmes noms que la configuration SITES_YAML).
      families: o.families || {},
      protectedSelectors: o.protected_selectors || [],
      thirdPartyExtra: o.third_party_extra || [],
      neverDelay: o.never_delay || [],
      masks: o.masks || [],
      navigationExclude: o.navigation_exclude || [],
      source: 'database',
    };
    if (withSecret) site.secret = box.decrypt(r.secret_enc);
    return site;
  };

  const sites = {
    async nextId() {
      const rows = await all("SELECT id FROM sites WHERE id ~ '^site-[0-9]+$'");
      const n = rows.reduce((m, r) => Math.max(m, Number.parseInt(r.id.slice(5), 10)), 0) + 1;
      return `site-${String(n).padStart(2, '0')}`;
    },
    async list(scope = null) {
      const rows = scope ? await all(`${SITE_SELECT} WHERE s.client_id = ANY($1) ORDER BY lower(c.name) NULLS LAST, lower(s.name)`, [scope])
        : await all(`${SITE_SELECT} ORDER BY lower(c.name) NULLS LAST, lower(s.name)`);
      return rows.map((r) => rowToSite(r));
    },
    async listWithSecrets() {
      return (await all(SITE_SELECT)).map((r) => rowToSite(r, true));
    },
    get: async (id, withSecret = false) => rowToSite(await one(`${SITE_SELECT} WHERE s.id = $1`, [id]), withSecret),
    /** Crée un site ; le secret est généré, ou repris lors d'un import depuis SITES_YAML. */
    async create({ id, name, clientId = null, domains, callbackUrl = null, options = {}, secret = null }) {
      const siteId = id ? String(id).trim().toLowerCase() : await sites.nextId();
      if (!SITE_ID_PATTERN.test(siteId)) throw fail('invalid_id', 'identifiant invalide (minuscules, chiffres, tirets)');
      const list = normalizeDomains(domains);
      if (!list.length) throw fail('invalid_domain', 'au moins un domaine');
      try {
        await run(`INSERT INTO sites (id, name, client_id, domains, secret_enc, callback_url, options) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [siteId, String(name || siteId).trim(), clientId || null, JSON.stringify(list), box.encrypt(secret || randomSecret()), callbackUrl || null, JSON.stringify(options || {})]);
      } catch (err) {
        if (err.code === '23505') throw fail('duplicate_id', `l'identifiant ${siteId} existe déjà`);
        throw err;
      }
      return siteId;
    },
    async update(id, patch) {
      const cur = await sites.get(id);
      if (!cur) return false;
      await run(`UPDATE sites SET name = $1, client_id = $2, domains = $3, callback_url = $4, options = $5, status = $6 WHERE id = $7`, [
        patch.name != null ? String(patch.name).trim() || cur.name : cur.name,
        patch.clientId !== undefined ? (patch.clientId || null) : cur.clientId,
        JSON.stringify(patch.domains !== undefined ? normalizeDomains(patch.domains) : cur.domains),
        patch.callbackUrl !== undefined ? (patch.callbackUrl || null) : cur.callbackUrl,
        JSON.stringify(patch.options !== undefined ? patch.options : cur.options),
        patch.status || cur.status,
        id,
      ]);
      return true;
    },
    /** Nouveau secret : le site doit être appairé de nouveau. */
    rotateSecret: (id) => run('UPDATE sites SET secret_enc = $1, paired_at = NULL WHERE id = $2', [box.encrypt(randomSecret()), id]),
    markPaired: (id, { callbackUrl, pluginVersion }) =>
      run('UPDATE sites SET paired_at = now(), callback_url = COALESCE($1, callback_url), plugin_version = $2 WHERE id = $3', [callbackUrl || null, pluginVersion || null, id]),
    remove: (id) => run('DELETE FROM sites WHERE id = $1', [id]),
    /** Activité des 30 derniers jours et derniers scores PageSpeed, par site (tableau de bord). */
    async summaries() {
      const out = {};
      for (const r of await all(`SELECT site_id, COUNT(*)::int total,
          COUNT(*) FILTER (WHERE status IN ('compiled','compiled_partial'))::int ok,
          COUNT(*) FILTER (WHERE status IN ('failed','skipped'))::int failed, MAX(created_at) last
        FROM compilations WHERE created_at > now() - interval '30 days' GROUP BY site_id`)) {
        out[r.site_id] = { compilations30d: r.total, compiled30d: r.ok, failed30d: r.failed, lastCompilation: r.last };
      }
      for (const r of await all(`SELECT DISTINCT ON (site_id, strategy) site_id, strategy, score FROM pagespeed_runs
          WHERE status = 'done' ORDER BY site_id, strategy, id DESC`)) {
        out[r.site_id] = out[r.site_id] || {};
        out[r.site_id][`pagespeed_${r.strategy}`] = r.score;
      }
      return out;
    },
  };

  /* ---------- Appairage ---------- */
  const pairing = {
    /** Nouveau code à usage unique ; les codes précédents du site sont annulés. */
    async create(siteId, ttlMinutes) {
      const code = pairingCode();
      await run('DELETE FROM pairing_codes WHERE site_id = $1 OR expires_at < now()', [siteId]);
      const r = await one(`INSERT INTO pairing_codes (code_hash, site_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING expires_at`,
        [sha256(normalizeCode(code)), siteId, ttlMinutes]);
      return { code, expires: r.expires_at };
    },
    /** Consomme un code (une seule fois, même en cas de requêtes simultanées). */
    async consume(code) {
      const hash = sha256(normalizeCode(code));
      const used = await one(`UPDATE pairing_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING site_id`, [hash]);
      if (used) return { site: await sites.get(used.site_id, true) };
      const row = await one('SELECT used_at, expires_at FROM pairing_codes WHERE code_hash = $1', [hash]);
      if (!row) return { error: 'invalid_code' };
      return { error: row.used_at ? 'used_code' : 'expired_code' };
    },
    pending: (siteId) => one('SELECT expires_at FROM pairing_codes WHERE site_id = $1 AND used_at IS NULL AND expires_at > now()', [siteId]),
  };

  /* ---------- Historique des compilations ---------- */
  const COMPILATION_LIST = `id, job_id, url, status, reason, lcp_reference, lcp_candidate, cls_reference, cls_candidate, families_disabled, weights, published, duration_ms, created_at`;
  const compilations = {
    record: (r) => run(`INSERT INTO compilations (job_id, site_id, url, status, reason, lcp_reference, lcp_candidate, families_applied, families_disabled, attempts, weights, resources, published, duration_ms, diagnostics, cls_reference, cls_candidate)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`, [
      r.jobId != null ? String(r.jobId) : null, r.siteId, r.url, r.status, r.reason || null,
      r.lcp?.reference ?? null, r.lcp?.candidate ?? null,
      JSON.stringify(r.familiesApplied || []), JSON.stringify(r.familiesDisabled || []),
      JSON.stringify((r.attempts || []).map(({ attempt, families, ok, failures }) => ({ attempt, families, ok, failures }))),
      r.weights ? JSON.stringify(r.weights) : null, r.resources ? JSON.stringify(r.resources) : null,
      r.published == null ? null : Boolean(r.published.published ?? r.published), r.durationMs ?? null,
      r.diagnostics ? JSON.stringify(r.diagnostics) : null,
      r.cls?.reference ?? null, r.cls?.candidate ?? null,
    ]),
    list: (siteId, { url = null, limit = 50, offset = 0 } = {}) => (url
      ? all(`SELECT ${COMPILATION_LIST} FROM compilations WHERE site_id = $1 AND url = $2 ORDER BY id DESC LIMIT $3 OFFSET $4`, [siteId, url, limit, offset])
      : all(`SELECT ${COMPILATION_LIST} FROM compilations WHERE site_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`, [siteId, limit, offset])),
    get: (siteId, id) => one('SELECT * FROM compilations WHERE site_id = $1 AND id = $2', [siteId, id]),
    /** Dernier état de chaque page du site. */
    pages: (siteId) => all(`SELECT DISTINCT ON (url) url, id, status, reason, lcp_reference, lcp_candidate, cls_reference, cls_candidate, weights, created_at
        FROM compilations WHERE site_id = $1 ORDER BY url, id DESC`, [siteId]),
    count: async (siteId) => (await one('SELECT COUNT(*)::int n FROM compilations WHERE site_id = $1', [siteId])).n,
    /** Dernier diagnostic de chaque page (agrégé par site dans l'interface). */
    latestDiagnostics: (siteId) => all(`SELECT DISTINCT ON (url) url, id, created_at, diagnostics FROM compilations
        WHERE site_id = $1 AND diagnostics IS NOT NULL ORDER BY url, id DESC`, [siteId]),
  };

  /* ---------- PageSpeed ---------- */
  const pagespeed = {
    start: async (siteId, url, strategy, requestedBy = null) =>
      (await one(`INSERT INTO pagespeed_runs (site_id, url, strategy, status, requested_by) VALUES ($1, $2, $3, 'pending', $4) RETURNING id`, [siteId, url, strategy, requestedBy])).id,
    finish: (id, { score, metrics, field }) =>
      run(`UPDATE pagespeed_runs SET status = 'done', score = $1, metrics = $2, field = $3, finished_at = now() WHERE id = $4`, [score, JSON.stringify(metrics), field ? JSON.stringify(field) : null, id]),
    fail: (id, error) => run(`UPDATE pagespeed_runs SET status = 'error', error = $1, finished_at = now() WHERE id = $2`, [String(error).slice(0, 500), id]),
    get: (siteId, id) => one('SELECT * FROM pagespeed_runs WHERE site_id = $1 AND id = $2', [siteId, id]),
    list: (siteId, { url = null, limit = 50 } = {}) => (url
      ? all('SELECT * FROM pagespeed_runs WHERE site_id = $1 AND url = $2 ORDER BY id DESC LIMIT $3', [siteId, url, limit])
      : all('SELECT * FROM pagespeed_runs WHERE site_id = $1 ORDER BY id DESC LIMIT $2', [siteId, limit])),
    /** Analyses restées « en cours » (service redémarré) : marquées en erreur. */
    abandonStale: () => run(`UPDATE pagespeed_runs SET status = 'error', error = 'analyse interrompue', finished_at = now()
        WHERE status = 'pending' AND created_at < now() - interval '10 minutes'`),
  };

  /* ---------- CrUX ---------- */
  const crux = {
    save: (siteId, origin, formFactor, data, error = null) =>
      run('INSERT INTO crux_snapshots (site_id, origin, form_factor, data, error) VALUES ($1, $2, $3, $4, $5)', [siteId, origin, formFactor, data ? JSON.stringify(data) : null, error]),
    /** Dernier relevé par type d'appareil. */
    latest: (siteId) => all(`SELECT DISTINCT ON (form_factor) * FROM crux_snapshots WHERE site_id = $1 ORDER BY form_factor, id DESC`, [siteId]),
  };

  /* ---------- Mesure des visiteurs (RUM) ---------- */
  const rum = {
    add: (siteId, e) => run('INSERT INTO rum_events (site_id, path, device, lcp, cls, inp, ttfb, prerendered) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [siteId, e.path, e.device, e.lcp, e.cls, e.inp, e.ttfb, e.prerendered]),
    /** 75e centile sur 28 jours, par appareil, et pages les plus lentes (LCP). */
    async summary(siteId) {
      const byDevice = await all(`SELECT device, COUNT(*)::int n,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY lcp) lcp, percentile_cont(0.75) WITHIN GROUP (ORDER BY cls) cls,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY inp) inp, percentile_cont(0.75) WITHIN GROUP (ORDER BY ttfb) ttfb,
          AVG(prerendered::int)::float prerendered
        FROM rum_events WHERE site_id = $1 AND created_at > now() - interval '28 days' GROUP BY device`, [siteId]);
      const pages = await all(`SELECT path, COUNT(*)::int n, percentile_cont(0.75) WITHIN GROUP (ORDER BY lcp) lcp,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY cls) cls, percentile_cont(0.75) WITHIN GROUP (ORDER BY inp) inp
        FROM rum_events WHERE site_id = $1 AND created_at > now() - interval '28 days' GROUP BY path HAVING COUNT(*) >= 5
        ORDER BY lcp DESC NULLS LAST LIMIT 20`, [siteId]);
      return { byDevice, pages };
    },
  };

  /* ---------- Réglages ---------- */
  const settings = {
    async get(key) {
      const r = await one('SELECT value, encrypted FROM settings WHERE key = $1', [key]);
      if (!r || r.value == null) return null;
      return r.encrypted ? box.decrypt(r.value) : r.value;
    },
    async set(key, value, { encrypted = false } = {}) {
      if (value == null || value === '') return run('DELETE FROM settings WHERE key = $1', [key]);
      return run(`INSERT INTO settings (key, value, encrypted, updated_at) VALUES ($1, $2, $3, now())
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = now()`,
      [key, encrypted ? box.encrypt(value) : String(value), encrypted]);
    },
  };

  /* ---------- Journal et conservation ---------- */
  const audit = {
    log: (userId, action, target = null, detail = null) =>
      run('INSERT INTO audit_log (user_id, action, target, detail) VALUES ($1, $2, $3, $4)', [userId || null, action, target, detail ? JSON.stringify(detail) : null]),
    list: (limit = 100) => all(`SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT $1`, [limit]),
  };

  /** Détail fichier par fichier effacé après 90 jours, historique effacé après 2 ans. */
  async function purge(retention = RETENTION) {
    const detail = await run(`UPDATE compilations SET resources = NULL, diagnostics = NULL WHERE (resources IS NOT NULL OR diagnostics IS NOT NULL) AND created_at < now() - make_interval(days => $1)`, [retention.detailDays]);
    const old = await run(`DELETE FROM compilations WHERE created_at < now() - make_interval(days => $1)`, [retention.summaryDays]);
    const psi = await run(`DELETE FROM pagespeed_runs WHERE created_at < now() - make_interval(days => $1)`, [retention.summaryDays]);
    await run(`DELETE FROM rum_events WHERE created_at < now() - make_interval(days => $1)`, [retention.detailDays]);
    await run(`DELETE FROM crux_snapshots WHERE created_at < now() - make_interval(days => $1)`, [retention.summaryDays]);
    const logs = await run(`DELETE FROM audit_log WHERE created_at < now() - make_interval(days => $1)`, [retention.summaryDays]);
    await run('DELETE FROM sessions WHERE expires_at < now()');
    await run(`DELETE FROM pairing_codes WHERE expires_at < now() - interval '1 day'`);
    return { detail, old, psi, logs };
  }

  return { pool, users, sessions, clients, sites, pairing, compilations, pagespeed, crux, rum, settings, audit, purge };
}
