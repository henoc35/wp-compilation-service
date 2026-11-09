/**
 * Famille « responsive » : images à la bonne taille et espace réservé.
 *
 * - Images de la médiathèque (classe wp-image-ID) : srcset construit à partir des
 *   tailles que WordPress a déjà générées (API REST wp/v2/media, publique), et
 *   sizes calculé d'après la largeur réellement affichée sur mobile et ordinateur.
 *   Aucune image n'est créée ni stockée : le navigateur choisit la plus adaptée.
 * - Images sans dimensions : aspect-ratio ajouté d'après la taille réelle mesurée,
 *   pour réserver leur place avant chargement (moins de décalages, CLS).
 */

const MOBILE_WIDTH = 412; // largeur du rendu mobile (Pixel 7)

/** Récupère les tailles disponibles des images de la médiathèque présentes dans la page. */
export async function prepareResponsive(html, { url, timeoutMs = 8000, fetchImpl = fetch, max = 40 } = {}) {
  const ids = [...new Set([...html.matchAll(/\bwp-image-(\d+)\b/g)].map((m) => m[1]))].slice(0, max);
  const media = new Map();
  if (!ids.length) return media;
  const origin = new URL(url).origin;
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetchImpl(`${origin}/wp-json/wp/v2/media/${id}?_fields=id,source_url,media_details`, {
        headers: { 'x-page-compiler-bypass': '1', accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow',
      });
      if (!res.ok) return;
      const m = await res.json();
      const d = m.media_details || {};
      if (!d.width || !m.source_url) return;
      const sizes = [{ url: m.source_url, width: d.width, height: d.height }];
      for (const s of Object.values(d.sizes || {})) {
        if (s && s.source_url && s.width) sizes.push({ url: s.source_url, width: s.width, height: s.height });
      }
      media.set(id, sizes);
    } catch { /* API REST indisponible : l'image reste telle quelle */ }
  }));
  return media;
}

/** Tailles de même proportions que l'image affichée (les vignettes recadrées sont exclues). */
export function sameRatio(sizes, w, h) {
  if (!w || !h) return sizes;
  const r = w / h;
  return sizes.filter((s) => s.height && Math.abs(s.width / s.height - r) / r < 0.02);
}

export function sizesAttr(display) {
  const m = display?.mobile?.[0];
  const d = display?.desktop?.[0];
  if (!m || !d) return null;
  const vw = Math.min(100, Math.ceil((m / MOBILE_WIDTH) * 100));
  return `(max-width: 767px) ${vw}vw, ${Math.round(d)}px`;
}

export function applyResponsive($, ctx) {
  const notes = [];
  const media = ctx.media || new Map();
  const images = ctx.imageInfo || new Map(); // URL absolue → { natural, display }
  const abs = (src) => {
    try {
      return new URL(src, ctx.url).href;
    } catch {
      return null;
    }
  };
  let srcsets = 0;
  let ratios = 0;
  $('img').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src');
    if (!src || src.startsWith('data:')) return;
    const info = images.get(abs(src));
    const id = ($el.attr('class') || '').match(/\bwp-image-(\d+)\b/)?.[1];
    const sizes = id ? media.get(id) : null;
    if (sizes && info?.display) {
      const natural = info.natural || [];
      const list = sameRatio(sizes, natural[0], natural[1]).sort((a, b) => a.width - b.width);
      const sizesValue = sizesAttr(info.display);
      if (list.length >= 2 && sizesValue) {
        if (!$el.attr('srcset')) $el.attr('srcset', list.map((s) => `${s.url} ${s.width}w`).join(', '));
        $el.attr('sizes', sizesValue);
        srcsets += 1;
      }
    }
    // Espace réservé : proportions connues, mais ni width/height ni aspect-ratio dans la page.
    const style = $el.attr('style') || '';
    if (info?.natural?.[0] && !($el.attr('width') && $el.attr('height')) && !/aspect-ratio/i.test(style)) {
      $el.attr('style', `${style ? `${style.replace(/;?\s*$/, '')};` : ''}aspect-ratio:${info.natural[0]} / ${info.natural[1]}`);
      ratios += 1;
    }
  });
  if (srcsets) notes.push(`${srcsets} image(s) : tailles adaptées à l'écran (srcset/sizes)`);
  if (ratios) notes.push(`${ratios} image(s) : espace réservé (aspect-ratio)`);
  return notes;
}
