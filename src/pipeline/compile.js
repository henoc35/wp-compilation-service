import { launchBrowser } from './browser.js';
import { capture, measureVitals, median, medianFloat, summarizeResources } from './render.js';
import { mergeCoverage, analyze } from './diagnostics.js';
import * as cheerio from 'cheerio';
import { prepareResponsive } from '../optimizer/families/responsive.js';
import { prepareFonts } from '../optimizer/fonts-local.js';
import { rumScript } from '../rum.js';
import { optimize } from '../optimizer/index.js';
import { verifyCandidate } from '../verify/index.js';
import { compareScreenshots } from '../verify/visual.js';
import { resolveRules } from '../rules/index.js';
import { enabledFamilies } from '../config.js';
import { publishResult } from '../publish.js';

const pct = (x) => `${(x * 100).toFixed(1)} %`;

/** Échec lisible : « hauteur (mobile) : hauteur différente de 4.20 % ». */
export function describeFailure(f) {
  const labels = {
    visual_viewport: "écart à l'ouverture", visual_viewport_only: "écart à l'ouverture", visual_full: 'écart sur la page complète',
    height: 'hauteur', interaction: 'interaction', console: 'erreur JavaScript', seo: 'SEO', performance: 'LCP', cls: 'CLS',
  };
  return `${labels[f.type] || f.type}${f.viewport ? ` (${f.viewport})` : ''} : ${f.detail || ''}`.trim();
}

export function describeFailures(failures) {
  return failures.map(describeFailure).join(' ; ');
}

/**
 * Chemin public du dossier des fichiers déposés sur le site (polices locales), d'après
 * l'adresse donnée par le plugin ; uniquement sur le même domaine que la page.
 */
export function assetsPathFor(assetsUrl, pageUrl) {
  if (!assetsUrl) return null;
  try {
    const a = new URL(assetsUrl);
    if (a.hostname !== new URL(pageUrl).hostname) return null;
    return a.pathname.endsWith('/') ? a.pathname : `${a.pathname}/`;
  } catch {
    return null;
  }
}

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
        url: job.url, viewportName: name, masks, collectReference: true, diagnose: config.diagnostics !== false, timeoutMs: config.pageTimeoutMs,
      });
      await store.save(`${name}-reference-viewport.png`, reference[name].screenshots.viewport);
      await store.save(`${name}-reference-full.png`, reference[name].screenshots.full);
    }
    result.resources = { reference: { mobile: reference.mobile.resources, desktop: reference.desktop.resources } };
    result.weights = { reference: { mobile: summarizeResources(reference.mobile.resources), desktop: summarizeResources(reference.desktop.resources) } };
    if (reference.mobile.diagnostics) {
      try {
        const coverage = mergeCoverage(['mobile', 'desktop'].flatMap((n) => [
          { type: 'js', entries: reference[n].diagnostics?.coverage?.js || [] },
          { type: 'css', entries: reference[n].diagnostics?.coverage?.css || [] },
        ]));
        result.diagnostics = analyze({
          images: { mobile: reference.mobile.diagnostics.images, desktop: reference.desktop.diagnostics?.images },
          coverage,
          resources: [...(reference.mobile.resources || []), ...(reference.desktop.resources || [])],
          lcpUrl: reference.mobile.lcp?.url || null,
        });
        result.diagnostics.bfcache = reference.mobile.diagnostics.bfcache;
        result.diagnostics.summary.bfcache = reference.mobile.diagnostics.bfcache?.eligible ?? null;
        result.weights.diagnostics = result.diagnostics.summary;
      } catch (err) {
        log.warn?.({ err: err.message }, 'diagnostic impossible');
      }
      // Les relevés bruts (sources complètes) ne sont pas conservés.
      for (const n of ['mobile', 'desktop']) if (reference[n]) reference[n].diagnostics = null;
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
        const full = compareScreenshots(reference[name].screenshots.full, again.screenshots.full);
        noise[name] = {
          viewport: compareScreenshots(reference[name].screenshots.viewport, again.screenshots.viewport).ratio,
          full: full.ratio,
          height: full.heightDelta,
        };
      }
      result.noise = noise;
      // Deux chargements de l'original n'ont pas la même hauteur : la page change
      // d'un chargement à l'autre et aucune version ne peut être vérifiée.
      const unstable = ['mobile', 'desktop'].filter((n) => noise[n].height > config.heightTolerance);
      if (unstable.length) {
        result.status = 'failed';
        result.reason = `Page instable : deux chargements successifs de l'original n'ont pas la même hauteur (${unstable.map((n) => `${n} ${pct(noise[n].height)}`).join(', ')}). Causes fréquentes : agenda, flux ou contenu aléatoire, bannière qui apparaît ou non.`;
        log.info?.({ url, noise }, 'page instable');
        return result;
      }
    }

    // 3. LCP de référence en conditions bridées
    let referenceLcp = null;
    let referenceCls = null;
    if (config.measureRuns > 0) {
      await progress({ step: 'measure-reference' });
      const vitals = [];
      for (let i = 0; i < config.measureRuns; i += 1) vitals.push(await measureVitals(browser, { url, timeoutMs: config.pageTimeoutMs }));
      const runs = vitals.map((v) => v.lcp);
      referenceLcp = median(runs);
      referenceCls = medianFloat(vitals.map((v) => v.cls));
      result.lcp = { reference: referenceLcp, referenceRuns: runs, candidate: null };
      result.cls = { reference: referenceCls, candidate: null };
    }

    const ctx = {
      url,
      // Réglage par site (interface) prioritaire sur la variable NAVIGATION_MODE.
      config: site?.options?.navigation_mode ? { ...config, navigationMode: site.options.navigation_mode } : config,
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

    // Préparations réseau des familles qui en ont besoin (faites une seule fois).
    // Par adresse chargée et par attribut src (le navigateur a pu choisir une autre taille dans le srcset).
    ctx.imageInfo = new Map();
    for (const i of result.diagnostics?.images || []) {
      const info = { natural: i.natural, display: i.display };
      ctx.imageInfo.set(i.url, info);
      if (i.src && !ctx.imageInfo.has(i.src)) ctx.imageInfo.set(i.src, info);
    }
    if (families.includes('responsive')) {
      ctx.media = await prepareResponsive(rawHtml, { url, timeoutMs: Math.min(config.pageTimeoutMs, 10000) });
    }
    const assetsPath = assetsPathFor(job.assetsUrl, url);
    if (families.includes('fonts') && assetsPath) {
      ctx.assetsPath = assetsPath;
      ctx.fontsLocal = await prepareFonts(cheerio.load(rawHtml), { assetsPath, hosts: config.fontsHosts });
      ctx.fontsUsed = (reference.mobile.resources || []).filter((r) => r.type === 'font' && r.initial).map((r) => r.url);
    }
    const runAttempt = async (attempt, active, cfg = config) => {
      await progress({ step: 'attempt', attempt, families: active });
      const save = store.scope(`attempt-${attempt}`);
      const optimized = await optimize(rawHtml, ctx, active);
      await save('candidate.html', optimized.html);
      const verdict = await verifyCandidate(browser, {
        url, rawHtml, candidateHtml: optimized.html, reference, noise, referenceLcp, referenceCls, config: cfg, masks, save,
      });
      result.attempts.push({
        attempt, families: active, notes: optimized.notes, ok: verdict.ok,
        failures: verdict.failures.map(({ diffs, ...f }) => f), metrics: verdict.metrics,
      });
      log.info?.({ url, attempt, ok: verdict.ok, failures: verdict.failures.map((f) => f.type), details: verdict.failures.map(describeFailure) }, 'tentative terminée');
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
        result.status = 'failed';
        result.reason = `Contrôle de départ en échec : la page servie par le service sans aucune optimisation diffère déjà de l'original (${describeFailures(baseline.verdict.failures)}), alors que deux chargements de l'original sont identiques. Le service ne peut pas la vérifier : voir les captures attempt-0 du rapport.`;
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
      // Famille désignée par l'erreur elle-même (adresse reconnue) : essayée seule d'abord.
      const hint = first.verdict.failures.map((f) => f.hint).find((h) => h && candidates.includes(h));
      if (hint && config.maxAttempts >= 2) {
        const active = families.filter((f) => f !== hint);
        const run = await runAttempt(attempt, active);
        attempt += 1;
        if (run.verdict.ok) {
          keep(active, [hint], run);
          candidates = [];
        } else {
          // La famille désignée reste désactivée ; la suite repart des écarts restants.
          base = [hint];
          candidates = rankSuspects(run.verdict.failures, active, changedFamilies(run.optimized.notes));
        }
      }
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
      if (best.verdict.metrics.cls) result.cls = { ...result.cls, candidate: best.verdict.metrics.cls.candidate };
      // Mesure des visiteurs (option du site) : script passif ajouté à la page publiée.
      if (site?.options?.rum && config.publicUrl && !result.html.includes('data-pc-rum')) {
        result.html = result.html.replace(/<\/body>/i, `${rumScript(`${config.publicUrl}/v1/rum/${encodeURIComponent(site.id)}`)}</body>`);
      }
      // Fichiers à déposer sur le site avec la page (polices locales).
      if (best.active.includes('fonts') && ctx.fontsLocal?.files?.size && best.optimized.html.includes('data-pc-fonts')) {
        result.assets = [...ctx.fontsLocal.files.values()].map(({ path, data, contentType }) => ({ path, content_type: contentType, data }));
      }
      result.html = best.optimized.html;
      const compiled = best.verdict.metrics.resources;
      if (compiled?.mobile) {
        result.resources.compiled = compiled;
        result.weights.compiled = { mobile: summarizeResources(compiled.mobile), desktop: summarizeResources(compiled.desktop || []) };
      }
    } else {
      const last = result.attempts[result.attempts.length - 1];
      result.reason = `Aucune version identique à l'original trouvée${last ? ` (dernier essai : ${describeFailures(last.failures)})` : ''}.`;
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
    const { html, resources, diagnostics, assets, ...summary } = result;
    const ok = result.status === 'compiled' || result.status === 'compiled_partial';
    result.published = await publishResult(site, {
      ...summary,
      attempts: summary.attempts.map(({ attempt, families, ok: passed, failures }) => ({ attempt, families, ok: passed, failures })),
      html: ok ? html : null,
      assets: ok && assets?.length ? assets : undefined,
      compiledAt: new Date().toISOString(),
    }, { timeoutMs: config.callbackTimeoutMs });
  }

  const { html, assets, ...report } = result;
  await store.save('report.json', JSON.stringify(report, null, 2));
  return result;
}
