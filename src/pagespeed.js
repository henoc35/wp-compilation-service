/**
 * Analyses PageSpeed Insights (API v5, runPagespeed), lancées à la demande depuis
 * l'interface ou depuis WordPress. Résultats enregistrés dans l'historique du site.
 *
 * Paramètres documentés : url, key, strategy (MOBILE | DESKTOP), category, locale.
 * Données réelles (CrUX) : loadingExperience (page) et originLoadingExperience (site) ;
 * Google prévoit de les retirer de cette API, elles sont donc facultatives ici.
 */

const LAB_AUDITS = {
  fcp: 'first-contentful-paint',
  lcp: 'largest-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbt: 'total-blocking-time',
  si: 'speed-index',
  ttfb: 'server-response-time',
};

/** Lien de commodité vers l'interface web de PageSpeed Insights (relance une analyse). */
export const reportUrl = (url, strategy = 'mobile') =>
  `https://pagespeed.web.dev/report?url=${encodeURIComponent(url)}&form_factor=${strategy === 'desktop' ? 'desktop' : 'mobile'}`;

function fieldData(experience) {
  if (!experience || !experience.metrics || !Object.keys(experience.metrics).length) return null;
  const metrics = {};
  for (const [key, m] of Object.entries(experience.metrics)) {
    metrics[key] = { percentile: m.percentile ?? null, category: m.category ?? null };
  }
  return { overall: experience.overall_category ?? null, metrics };
}

/** Extrait d'une réponse runPagespeed : score, mesures de laboratoire, données réelles. */
export function parsePageSpeed(data) {
  const lh = data?.lighthouseResult;
  if (!lh) throw new Error('réponse PageSpeed sans résultat Lighthouse');
  const metrics = {};
  for (const [name, id] of Object.entries(LAB_AUDITS)) {
    const a = lh.audits?.[id];
    if (a) metrics[name] = { value: a.numericValue ?? null, display: a.displayValue ?? null, score: a.score ?? null };
  }
  const page = fieldData(data.loadingExperience);
  const origin = fieldData(data.originLoadingExperience);
  return {
    score: lh.categories?.performance?.score ?? null,
    metrics,
    field: page || origin ? { page, origin } : null,
  };
}

export async function runPageSpeed({ url, strategy, apiKey, endpoint, fetchImpl = fetch, timeoutMs = 180000 }) {
  const params = new URLSearchParams({ url, strategy: strategy === 'desktop' ? 'DESKTOP' : 'MOBILE', category: 'PERFORMANCE', locale: 'fr' });
  if (apiKey) params.set('key', apiKey);
  const res = await fetchImpl(`${endpoint}?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`PageSpeed : ${message}`);
  }
  return parsePageSpeed(body);
}

/**
 * Lance les analyses en arrière-plan (au plus `concurrency` à la fois) et enregistre
 * les résultats. Retourne aussitôt les identifiants des analyses créées.
 */
export function createPageSpeedRunner({ repo, config, log, fetchImpl = fetch, concurrency = 2 }) {
  let active = 0;
  const waiting = [];
  const next = () => {
    while (active < concurrency && waiting.length) {
      const task = waiting.shift();
      active += 1;
      task().finally(() => {
        active -= 1;
        next();
      });
    }
  };

  async function apiKey() {
    return config.pagespeedApiKey || (await repo.settings.get('pagespeed_api_key')) || '';
  }

  return {
    apiKey,
    async start(siteId, url, strategies = ['mobile', 'desktop'], requestedBy = null) {
      const key = await apiKey();
      if (!key) throw Object.assign(new Error('clé PageSpeed non configurée'), { code: 'pagespeed_not_configured', statusCode: 400 });
      const ids = [];
      for (const strategy of strategies) {
        const id = await repo.pagespeed.start(siteId, url, strategy, requestedBy);
        ids.push(id);
        waiting.push(async () => {
          try {
            const r = await runPageSpeed({ url, strategy, apiKey: key, endpoint: config.pagespeedEndpoint, fetchImpl });
            await repo.pagespeed.finish(id, r);
          } catch (err) {
            log?.warn?.({ siteId, url, strategy, err: err.message }, 'PageSpeed en échec');
            await repo.pagespeed.fail(id, err.message).catch(() => {});
          }
        });
      }
      next();
      return ids;
    },
    idle: () => active === 0 && waiting.length === 0,
  };
}
