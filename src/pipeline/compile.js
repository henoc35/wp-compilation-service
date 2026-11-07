import { launchBrowser } from './browser.js';
import { capture, measureLcp, median } from './render.js';
import { optimize } from '../optimizer/index.js';
import { verifyCandidate } from '../verify/index.js';
import { compareScreenshots } from '../verify/visual.js';
import { resolveRules } from '../rules/index.js';
import { enabledFamilies } from '../config.js';
import { publishResult } from '../publish.js';

/** Familles qui ont réellement modifié la page (les autres ne peuvent rien casser). */
export function changedFamilies(notes) {
  return Object.entries(notes || {}).filter(([, n]) => Array.isArray(n) && n.length).map(([f]) => f);
}

/**
 * Familles suspectes, de la plus probable à la moins probable, d'après le type
 * des échecs. Seules les familles actives qui ont modifié la page sont retenues ;
 * à défaut, toutes les familles actives suspectes.
 */
export function rankSuspects(failures, active, changed) {
  const ordered = [];
  for (const f of failures) {
    for (const s of f.suspects || []) {
      if (active.includes(s) && !ordered.includes(s)) ordered.push(s);
    }
  }
  const effective = ordered.filter((s) => changed.includes(s));
  return effective.length ? effective : ordered;
}

/**
 * Compile une page : rendu de référence, optimisation, vérification, isolation
 * des échecs, publication.
 *
 * @param {object} p
 * @param {{ url: string, lang?: string, families?: string[], jobId?: string }} p.job
 * @param {object|null} p.site  configuration du site (null en ligne de commande sans site)
 * @param {object} p.config
 * @param {object} p.rules      base de règles chargée
 * @param {object} p.store      artifacts (voir artifacts.js)
 * @param {Function} [p.progress]
 * @param {object} [p.log]
 * @param {boolean} [p.publish=true]
 */
/**
 * URL finale de la page (redirections http→https, slash final) obtenue avec
 * l'en-tête de contournement. Les rendus utilisent directement cette URL : le
 * navigateur n'appliquerait l'en-tête qu'à la première requête d'une redirection.
 */
export async function resolveFinalUrl(url, timeoutMs = 30000) {
  try {
    const res = await fetch(url, { headers: { 'x-page-compiler-bypass': '1' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.url || url;
  } catch {
    return url;
  }
}

async function compileCore({ job, site, config, rules, store, progress, log }) {
  const result = {
    jobId: job.jobId || null,
    siteId: site?.id || null,
    url: job.url,
    lang: job.lang || null,
    status: 'failed',
    familiesApplied: [],
    familiesDisabled: [],
    attempts: [],
    lcp: null,
    published: null,
  };

  // URL finale, restreinte aux domaines du site
  const finalUrl = await resolveFinalUrl(job.url, config.pageTimeoutMs);
  if (site && !site.domains.includes(new URL(finalUrl).hostname.toLowerCase())) {
    result.status = 'skipped';
    result.reason = `redirection hors des domaines du site : ${new URL(finalUrl).hostname}`;
    return result;
  }
  job = { ...job, url: finalUrl };

  const browser = await launchBrowser(config);
  try {
    // 1. Rendu de référence (mobile et desktop)
    await progress({ step: 'reference' });
    // Mêmes zones masquées pour tous les rendus : celles de toutes les fiches, présentes ou non.
    const masks = [...new Set([...rules.masks, ...rules.addons.flatMap((a) => a.masks || []), ...(site?.masks || [])])];
    const reference = {};
    for (const name of ['mobile', 'desktop']) {
      reference[name] = await capture(browser, {
        url: job.url, viewportName: name, masks, collectReference: true, timeoutMs: config.pageTimeoutMs,
      });
      await store.save(`${name}-reference-viewport.png`, reference[name].screenshots.viewport);
      await store.save(`${name}-reference-full.png`, reference[name].screenshots.full);
    }
    const rawHtml = reference.mobile.rawHtml;
    const url = reference.mobile.finalUrl || job.url;
    result.url = url;

    if (reference.mobile.status >= 400 || !rawHtml) {
      result.status = 'skipped';
      result.reason = `réponse HTTP ${reference.mobile.status}`;
      return result;
    }
    if (/<meta[^>]+name=["']page-compiler["']/i.test(rawHtml)) {
      result.status = 'skipped';
      result.reason = 'la page reçue est déjà une version compilée (vider le service des pages avant de recompiler)';
      return result;
    }
    await store.save('reference.html', rawHtml);

    const pageRules = resolveRules(rules, rawHtml, site);
    result.addonsDetected = pageRules.addonsDetected;

    // 2. Bruit : écart entre deux rendus de l'original, pour ne pas confondre instabilité et casse
    let noise = null;
    if (config.noiseCheck) {
      await progress({ step: 'noise' });
      noise = {};
      for (const name of ['mobile', 'desktop']) {
        const again = await capture(browser, { url, viewportName: name, masks, timeoutMs: config.pageTimeoutMs });
        noise[name] = {
          viewport: compareScreenshots(reference[name].screenshots.viewport, again.screenshots.viewport).ratio,
          full: compareScreenshots(reference[name].screenshots.full, again.screenshots.full).ratio,
        };
      }
      result.noise = noise;
    }

    // 3. LCP de référence en conditions bridées
    let referenceLcp = null;
    if (config.measureRuns > 0) {
      await progress({ step: 'measure-reference' });
      const runs = [];
      for (let i = 0; i < config.measureRuns; i += 1) runs.push(await measureLcp(browser, { url, timeoutMs: config.pageTimeoutMs }));
      referenceLcp = median(runs);
      result.lcp = { reference: referenceLcp, referenceRuns: runs, candidate: null };
    }

    const ctx = {
      url,
      config,
      rules: pageRules,
      cssCache: new Map(),
      reference: {
        mobile: { lcp: reference.mobile.lcp },
        desktop: { lcp: reference.desktop.lcp },
        animatedIds: [...new Set([...reference.mobile.animatedIds, ...reference.desktop.animatedIds])],
      },
    };
    result.reference = ctx.reference;

    // 4. Optimisation et vérification, avec isolation de la famille fautive
    const families = enabledFamilies(site, job.families);
    const runAttempt = async (attempt, active, cfg = config) => {
      await progress({ step: 'attempt', attempt, families: active });
      const save = store.scope(`attempt-${attempt}`);
      const optimized = await optimize(rawHtml, ctx, active);
      await save('candidate.html', optimized.html);
      const verdict = await verifyCandidate(browser, {
        url, rawHtml, candidateHtml: optimized.html, reference, noise, referenceLcp, config: cfg, masks, save,
      });
      result.attempts.push({
        attempt, families: active, notes: optimized.notes, ok: verdict.ok,
        failures: verdict.failures.map(({ diffs, ...f }) => f), metrics: verdict.metrics,
      });
      log.info?.({ url, attempt, ok: verdict.ok, failures: verdict.failures.map((f) => f.type) }, 'tentative terminée');
      return { optimized, verdict };
    };

    let best = null;
    const keep = (active, disabled, run) => {
      best = { active, disabled, ...run };
    };

    // Contrôle de départ : la page servie telle quelle, sans aucune optimisation, doit
    // déjà être identique à l'original. Sinon elle est instable et ne peut pas être
    // vérifiée : inutile de retirer les optimisations une à une.
    if (config.baselineCheck) {
      const baseline = await runAttempt(0, [], { ...config, measureRuns: 0 });
      if (!baseline.verdict.ok) {
        const types = [...new Set(baseline.verdict.failures.map((f) => f.type))].join(', ');
        result.status = 'failed';
        result.reason = `Page instable : sans aucune optimisation, elle diffère déjà de l'original (${types}). Causes fréquentes : contenu qui change à chaque chargement, cookie ou en-tête propre au site.`;
        return result;
      }
    }

    const first = await runAttempt(1, families);
    if (first.verdict.ok) {
      keep(families, [], first);
    } else {
      let candidates = rankSuspects(first.verdict.failures, families, changedFamilies(first.optimized.notes));
      // Familles qu'il faut laisser désactivées (désactiver `half` n'a pas suffi : il
      // peut y avoir plusieurs fautives, on ne les réactive pas).
      let base = [];
      let attempt = 2;
      while (attempt <= config.maxAttempts && candidates.length) {
        const half = candidates.slice(0, Math.ceil(candidates.length / 2));
        const rest = candidates.slice(half.length);
        const off = [...base, ...half];
        const active = families.filter((f) => !off.includes(f));
        if (!active.length) break;
        const run = await runAttempt(attempt, active);
        attempt += 1;
        if (run.verdict.ok) {
          keep(active, off, run); // une fautive est dans `half` : on resserre
          if (half.length === 1) break;
          candidates = half;
        } else {
          base = off;
          candidates = rest;
        }
      }
    }

    if (best) {
      result.status = best.disabled.length ? 'compiled_partial' : 'compiled';
      result.familiesApplied = best.optimized.applied;
      result.familiesDisabled = [...best.disabled];
      if (best.verdict.metrics.lcp) {
        result.lcp = { ...result.lcp, candidate: best.verdict.metrics.lcp.candidate, candidateRuns: best.verdict.metrics.lcp.runs };
      }
      result.html = best.optimized.html;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return result;
}

/**
 * Compile une page puis envoie le résultat au plugin du site — toujours, y compris
 * pour une page ignorée ou en échec, pour qu'aucune page ne reste « En cours ».
 */
export async function runCompilation({ job, site, config, rules, store, progress = async () => {}, log = console, publish = true }) {
  const startedAt = Date.now();
  const result = await compileCore({ job, site, config, rules, store, progress, log });
  result.durationMs = Date.now() - startedAt;

  if (publish && site) {
    await progress({ step: 'publish' });
    const { html, ...summary } = result;
    const ok = result.status === 'compiled' || result.status === 'compiled_partial';
    result.published = await publishResult(site, {
      ...summary,
      attempts: summary.attempts.map(({ attempt, families, ok: passed, failures }) => ({ attempt, families, ok: passed, failures })),
      html: ok ? html : null,
      compiledAt: new Date().toISOString(),
    }, { timeoutMs: config.callbackTimeoutMs });
  }

  const { html, ...report } = result;
  await store.save('report.json', JSON.stringify(report, null, 2));
  return result;
}
