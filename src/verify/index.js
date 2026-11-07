import { capture, measureLcp, median } from '../pipeline/render.js';
import { compareScreenshots } from './visual.js';
import { compareSeo } from './seo.js';

/** Familles suspectes selon le type d'échec, de la plus probable à la moins probable. */
export const SUSPECTS = {
  seo: ['navigation', 'css', 'scripts'],
  visual_viewport: ['animations', 'images', 'css', 'fonts', 'scripts'],
  // Différence à l'ouverture qui disparaît après défilement : ce qui manque au départ
  // arrive à la première interaction, signature typique d'un script retardé.
  visual_viewport_only: ['scripts', 'animations', 'images', 'fonts', 'css'],
  visual_full: ['css', 'images', 'animations', 'scripts', 'fonts'],
  height: ['css', 'images', 'animations', 'scripts'],
  interaction: ['scripts', 'css', 'animations'],
  console: ['scripts', 'css', 'images'],
  performance: ['scripts', 'css', 'navigation', 'fonts'],
};

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
export async function verifyCandidate(browser, { url, rawHtml, candidateHtml, reference, noise, referenceLcp, config, masks, save }) {
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
      failures.push({ type: 'console', viewport: name, detail: added.slice(0, 3).join(' | '), suspects: SUSPECTS.console });
    }
  }

  if (!failures.length && config.measureRuns > 0 && referenceLcp != null) {
    const runs = [];
    for (let i = 0; i < config.measureRuns; i += 1) runs.push(await measureLcp(browser, { url, candidateHtml, timeoutMs: config.pageTimeoutMs }));
    const candidateLcp = median(runs);
    metrics.lcp = { reference: referenceLcp, candidate: candidateLcp, runs };
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
