/**
 * Famille « images ».
 *
 * - L'image LCP mesurée (mobile et desktop) est préchargée avec une priorité
 *   haute et retirée du lazy-load, y compris quand c'est une image de fond.
 * - Les autres images reçoivent le lazy-load natif du navigateur.
 */

const LAZY_ATTRS = [
  ['data-lazy-src', 'src'], // WP Rocket
  ['data-lazy-srcset', 'srcset'],
  ['data-lazy-sizes', 'sizes'],
];

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    return url;
  }
}

function imageReferences($img) {
  return ['src', 'srcset', 'data-src', 'data-srcset', 'data-lazy-src', 'data-lazy-srcset']
    .map((a) => $img.attr(a) || '')
    .join(' ');
}

/** URL du même site écrite relativement à la racine. */
function sameSiteRelative(url, pageUrl) {
  try {
    const u = new URL(url, pageUrl);
    return u.origin === new URL(pageUrl).origin ? u.pathname + u.search : u.toString();
  } catch {
    return url;
  }
}

function addPreload($, attrs, notes) {
  const key = attrs.href || attrs.imagesrcset;
  const exists = $('link[rel="preload"][as="image"]').toArray()
    .some((el) => ($(el).attr('href') || $(el).attr('imagesrcset')) === key);
  if (exists) return;
  const link = $('<link>').attr({ rel: 'preload', as: 'image', fetchpriority: 'high', ...attrs });
  const anchor = $('head meta[charset]').first();
  if (anchor.length) anchor.after(link);
  else $('head').prepend(link);
  notes.push(`préchargement de ${key}`);
}

export function applyImages($, ctx) {
  const notes = [];
  const lcps = [ctx.reference?.mobile?.lcp, ctx.reference?.desktop?.lcp].filter((l) => l && l.url);
  const lcpPaths = new Set();

  for (const lcp of lcps) {
    const p = pathOf(lcp.url);
    if (lcpPaths.has(p)) continue;
    lcpPaths.add(p);

    if (lcp.isImg) {
      const $img = $('img').filter((_, el) => imageReferences($(el)).includes(p)).first();
      if ($img.length) {
        for (const [from, to] of LAZY_ATTRS) {
          const v = $img.attr(from);
          if (v) {
            $img.attr(to, v);
            $img.removeAttr(from);
          }
        }
        $img.removeClass('rocket-lazyload lazyload lazy');
        $img.attr('loading', 'eager');
        $img.attr('fetchpriority', 'high');
        $img.attr('decoding', 'async');
        const srcset = $img.attr('srcset');
        const src = $img.attr('src');
        const attrs = srcset
          ? { imagesrcset: srcset, imagesizes: $img.attr('sizes') || '100vw' }
          : { href: src || sameSiteRelative(lcp.url, ctx.url) };
        if (srcset && src && !src.startsWith('data:')) attrs.href = src;
        addPreload($, attrs, notes);
        continue;
      }
    }

    // Image de fond (ou image introuvable dans le HTML d'origine) : préchargement de l'URL.
    addPreload($, { href: sameSiteRelative(lcp.url, ctx.url) }, notes);
    // Désactive le lazy-load des fonds d'Elementor sur l'élément concerné.
    if (lcp.dataId && /^[\w-]+$/.test(lcp.dataId)) {
      const $el = $(`[data-id="${lcp.dataId}"]`).first();
      if ($el.length) {
        $el.addClass('e-no-lazyload');
        notes.push(`fond sans lazy-load sur data-id=${lcp.dataId}`);
      }
    }
  }

  let lazied = 0;
  $('img').each((_, el) => {
    const $img = $(el);
    if ($img.attr('loading') || $img.attr('fetchpriority') === 'high') return;
    if ([...lcpPaths].some((p) => imageReferences($img).includes(p))) return;
    $img.attr('loading', 'lazy');
    if (!$img.attr('decoding')) $img.attr('decoding', 'async');
    lazied += 1;
  });
  if (lazied) notes.push(`${lazied} image(s) en lazy-load natif`);
  return notes;
}
