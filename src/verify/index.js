import { capture, measureVitals, median, medianFloat } from '../pipeline/render.js';
import { compareScreenshots } from './visual.js';
import { compareSeo } from './seo.js';

/** Familles suspectes selon le type d'échec, de la plus probable à la moins probable. */
export const SUSPECTS = {
  seo: ['navigation', 'css', 'scripts'],
  visual_viewport: ['animations', 'images', 'responsive', 'assets', 'css', 'fonts', 'embeds', 'scripts'],
  // Différence à l'ouverture qui disparaît après défilement : ce qui manque au départ
  // arrive à la première interaction, signature typique d'un script retardé.
  visual_viewport_only: ['scripts', 'assets', 'animations', 'images', 'responsive', 'fonts', 'css'],
  visual_full: ['css', 'assets', 'images', 'responsive', 'embeds', 'animations', 'scripts', 'fonts'],
  height: ['css', 'assets', 'responsive', 'images', 'embeds', 'animations', 'scripts'],
  interaction: ['scripts', 'assets', 'css', 'animations'],
  console: ['assets', 'scripts', 'embeds', 'fonts', 'responsive', 'css', 'images'],
  performance: ['scripts', 'css', 'navigation', 'fonts'],
  // Décalages de mise en page : CSS chargé en différé, polices remplacées, images sans dimensions.
  cls: ['css', 'fonts', 'responsive', 'images', 'animations', 'embeds', 'assets'],
};

/** Adresses reconnaissables dans une erreur : la famille qui les introduit passe en tête. */
const ERROR_HINTS = [
  [/ytimg\.com|youtube|vimeo|google\.[a-z.]+\/maps/i, 'embeds'],
  [/page-compiler-assets|\.woff2/i, 'fonts'],
  [/wp-json\/wp\/v2\/media|-\d+x\d+\.(jpe?g|png|webp|avif)/i, 'responsive'],
];

export function consoleSuspects(errors) {
  const first = [];
  for (const [re, family] of ERROR_HINTS) if (errors.some((e) => re.test(e)) && !first.includes(family)) first.push(family);
  return [...first, ...SUSPECTS.console.filter((f) => !first.includes(f))];
}

/** Hausse de CLS tolérée : 0,02 ou 10 % de la valeur d'origine (bruit de mesure). */
export function clsWorse(reference, candidate) {
  if (reference == null || candidate == null) return false;
  return candidate > reference + Math.max(0.02, reference * 0.1);
}

/** Normalise un message d'erreur pour comparer origine et candidate. */
function normalizeError(msg) {
  return msg.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Seuil effectif : jamais en dessous du bruit mesuré entre deux rendus de l'original. */
export function effectiveThreshold(base, noise) {
  return Math.max(base, (noise || 0) * 1.5 + 0.001);
}

/**
 * Vérifie une version candidate contre le rendu de référence.
 * Les contrôles sans navigateur passent d'abord (SEO), puis les rendus.
 */
export async function verifyCandidate(browser, { url, rawHtml, candidateHtml, reference, noise, referenceLcp, referenceCls = null, config, masks, save }) {
  const failures = [];
  const metrics = { viewports: {} };

  const seoDiffs = compareSeo(rawHtml, candidateHtml);
  if (seoDiffs.length) {
    failures.push({ type: 'seo', detail: seoDiffs.map((d) => d.field).join(', '), suspects: SUSPECTS.seo, diffs: seoDiffs });
    return { ok: false, failures, metrics };
  }

  for (const name of ['mobile', 'desktop']) {
    const ref = reference[name];
    const cand = await capture(browser, { url, viewportName: name, candidateHtml, masks, timeoutMs: config.pageTimeoutMs });
    const vp = compareScreenshots(ref.screenshots.viewport, cand.screenshots.viewport);
    const full = compareScreenshots(ref.screenshots.full, cand.screenshots.full);
    await save(`${name}-candidate-viewport.png`, cand.screenshots.viewport);
    await save(`${name}-candidate-full.png`, cand.screenshots.full);
    await save(`${name}-diff-viewport.png`, vp.diffPng);
    await save(`${name}-diff-full.png`, full.diffPng);

    const vpThreshold = effectiveThreshold(config.visualThreshold, noise?.[name]?.viewport);
    const fullThreshold = effectiveThreshold(config.fullPageThreshold, noise?.[name]?.full);
    metrics.resources = { ...(metrics.resources || {}), [name]: cand.resources };
    metrics.viewports[name] = {
      viewportDiff: round(vp.ratio), viewportThreshold: round(vpThreshold),
      fullDiff: round(full.ratio), fullThreshold: round(fullThreshold),
      heightDelta: round(full.heightDelta),
      lcpCandidate: cand.lcp,
    };

    const heightFail = full.heightDelta > config.heightTolerance;
    const fullFail = !heightFail && full.ratio > fullThreshold;
    if (vp.ratio > vpThreshold) {
      const onlyAtOpening = !heightFail && !fullFail;
      failures.push({
        type: onlyAtOpening ? 'visual_viewport_only' : 'visual_viewport',
        viewport: name,
        detail: `écart ${pct(vp.ratio)} > ${pct(vpThreshold)}${onlyAtOpening ? ', absent après défilement' : ''}`,
        suspects: onlyAtOpening ? SUSPECTS.visual_viewport_only : SUSPECTS.visual_viewport,
      });
    }
    if (heightFail) {
      failures.push({ type: 'height', viewport: name, detail: `hauteur différente de ${pct(full.heightDelta)}`, suspects: SUSPECTS.height });
    } else if (fullFail) {
      failures.push({ type: 'visual_full', viewport: name, detail: `écart ${pct(full.ratio)} > ${pct(fullThreshold)}`, suspects: SUSPECTS.visual_full });
    }

    for (const [kind, refResult] of Object.entries(ref.interactions)) {
      const candResult = cand.interactions[kind];
      if (refResult.present && refResult.works && !(candResult && candResult.works)) {
        failures.push({ type: 'interaction', viewport: name, detail: `${kind} ne fonctionne plus`, suspects: SUSPECTS.interaction });
      }
    }

    const known = new Set(ref.errors.map(normalizeError));
    const added = cand.errors.filter((e) => !known.has(normalizeError(e)));
    if (added.length) {
      const suspects = consoleSuspects(added);
      const hint = ERROR_HINTS.some(([re, f]) => f === suspects[0] && added.some((e) => re.test(e))) ? suspects[0] : null;
      failures.push({ type: 'console', viewport: name, detail: added.slice(0, 3).join(' | '), suspects, hint });
    }
  }

  if (!failures.length && config.measureRuns > 0 && referenceLcp != null) {
    const vitals = [];
    for (let i = 0; i < config.measureRuns; i += 1) vitals.push(await measureVitals(browser, { url, candidateHtml, timeoutMs: config.pageTimeoutMs }));
    const runs = vitals.map((v) => v.lcp);
    const candidateLcp = median(runs);
    const candidateCls = medianFloat(vitals.map((v) => v.cls));
    metrics.lcp = { reference: referenceLcp, candidate: candidateLcp, runs };
    metrics.cls = { reference: referenceCls, candidate: candidateCls };
    if (clsWorse(referenceCls, candidateCls)) {
      failures.push({ type: 'cls', detail: `CLS ${candidateCls} > ${referenceCls} (décalages de mise en page en hausse)`, suspects: SUSPECTS.cls });
    }
    if (candidateLcp == null) {
      failures.push({ type: 'performance', detail: 'LCP de la version candidate non mesurable', suspects: SUSPECTS.performance });
    } else if (candidateLcp > referenceLcp * config.lcpTolerance) {
      failures.push({ type: 'performance', detail: `LCP ${candidateLcp} ms > ${referenceLcp} ms`, suspects: SUSPECTS.performance });
    }
  }

  return { ok: failures.length === 0, failures, metrics };
}

const round = (x) => Math.round(x * 10000) / 10000;
const pct = (x) => `${(x * 100).toFixed(2)} %`;
