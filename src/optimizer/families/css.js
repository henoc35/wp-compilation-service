import Beasties from 'beasties';
import * as cheerio from 'cheerio';

/**
 * Famille « css ».
 *
 * Le CSS critique est intégré à la page et les feuilles complètes sont chargées
 * en asynchrone. Aucune règle n'est supprimée des feuilles d'origine
 * (pruneSource: false) et les sélecteurs protégés par les fiches d'addon restent
 * toujours dans le CSS critique.
 */

const FETCH_TIMEOUT_MS = 15000;
const MAX_CSS_BYTES = 2 * 1024 * 1024;

/**
 * Réécrit les url(...) relatives d'une feuille : le CSS critique est déplacé dans
 * la page, les chemins relatifs à la feuille deviendraient faux. Les ressources du
 * même site sont écrites relativement à la racine (/wp-content/...).
 */
export function absolutizeCssUrls(css, sheetUrl) {
  const sheet = new URL(sheetUrl);
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, ref) => {
    const r = ref.trim();
    if (/^(data:|https?:|\/\/|#|\/)/i.test(r)) return match;
    try {
      const abs = new URL(r, sheet);
      const out = abs.origin === sheet.origin ? abs.pathname + abs.search + abs.hash : abs.toString();
      return `url(${quote}${out}${quote})`;
    } catch {
      return match;
    }
  });
}

class RemoteBeasties extends Beasties {
  constructor(options, { pageUrl, cache, notes, skip }) {
    super(options);
    this.pageUrl = pageUrl;
    this.skip = skip;
    this.cache = cache;
    this.notes = notes;
  }

  async getCssAsset(href) {
    let absolute;
    try {
      absolute = new URL(href, this.pageUrl);
    } catch {
      return undefined;
    }
    // Uniquement les feuilles du site lui-même : un CDN tiers reste chargé tel quel.
    if (absolute.origin !== new URL(this.pageUrl).origin) return undefined;
    const key = absolute.toString();
    // Feuille limitée à un média (print, max-width…) : Beasties copierait ses règles
    // sans le @media. Elle reste chargée telle quelle.
    if (this.skip.has(href) || this.skip.has(key)) return undefined;
    if (this.cache.has(key)) return this.cache.get(key);
    const promise = (async () => {
      try {
        // Pas de redirection suivie : une redirection pourrait viser une adresse interne.
        const res = await fetch(key, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return undefined;
        const text = await res.text();
        if (text.length > MAX_CSS_BYTES) return undefined;
        return absolutizeCssUrls(text, key);
      } catch {
        this.notes.push(`feuille ignorée (inaccessible) : ${key}`);
        return undefined;
      }
    })();
    this.cache.set(key, promise);
    return promise;
  }
}

/** Médias pour lesquels le CSS critique peut être extrait sans changer le rendu. */
export function isUniversalMedia(media) {
  const m = String(media || '').trim().toLowerCase();
  return m === '' || m === 'all' || m === 'screen' || m === 'only screen';
}

/** href des feuilles à média restreint, à laisser intactes. */
export function restrictedMediaHrefs(html, pageUrl) {
  const $ = cheerio.load(html);
  const set = new Set();
  $('link[rel~="stylesheet"][href]').each((_, el) => {
    if (isUniversalMedia($(el).attr('media'))) return;
    const href = $(el).attr('href');
    set.add(href);
    try { set.add(new URL(href, pageUrl).toString()); } catch { /* ignoré */ }
  });
  return set;
}

export async function applyCriticalCss(html, ctx) {
  const notes = [];
  const skip = restrictedMediaHrefs(html, ctx.url);
  const restricted = (html.match(/<link[^>]+rel=["']?stylesheet[^>]*>/gi) || []).filter((l) => {
    const m = l.match(/\smedia=["']?([^"'>]+)/i);
    return m && !isUniversalMedia(m[1]);
  }).length;
  if (restricted) notes.push(`${restricted} feuille(s) à média restreint laissée(s) intacte(s)`);
  const beasties = new RemoteBeasties({
    path: '/nonexistent-beasties-root',
    publicPath: '/',
    external: true,
    preload: 'media',
    pruneSource: false,
    reduceInlineStyles: false,
    mergeStylesheets: false,
    inlineFonts: false,
    preloadFonts: false,
    keyframes: 'critical',
    allowRules: ctx.rules?.allowRules || [],
    logLevel: 'silent',
  }, { pageUrl: ctx.url, cache: ctx.cssCache || new Map(), notes, skip });
  const out = await beasties.process(html);
  const before = (html.match(/<link[^>]+rel=["']?stylesheet/gi) || []).length;
  const asyncLinks = (out.match(/media=["']?print["']?[^>]*onload/gi) || []).length;
  notes.push(`CSS critique intégré, ${asyncLinks}/${before} feuille(s) chargée(s) en asynchrone`);
  return { html: out, notes };
}
