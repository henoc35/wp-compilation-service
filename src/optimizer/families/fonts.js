import { inlineLocalFonts } from '../fonts-local.js';
/**
 * Famille « polices ».
 *
 * - Google Fonts : affichage immédiat avec la police de secours (display=swap)
 *   et connexion anticipée au serveur des fichiers de police.
 * - @font-face en ligne sans font-display : ajout de font-display: swap.
 *
 * L'hébergement local des Google Fonts est prévu dans une version ultérieure.
 */

export function applyFonts($, ctx = {}) {
  // Polices Google hébergées sur le site, si elles ont été préparées (voir fonts-local.js).
  const notes = ctx.fontsLocal
    ? inlineLocalFonts($, ctx.fontsLocal, { hosts: ctx.config?.fontsHosts, usedFontUrls: ctx.fontsUsed || [], assetsPath: ctx.assetsPath })
    : [];
  let googleFonts = false;

  $('link[rel="stylesheet"][href*="fonts.googleapis.com/css"]').each((_, el) => {
    const $l = $(el);
    googleFonts = true;
    const href = $l.attr('href');
    if (!/[?&]display=/.test(href)) {
      $l.attr('href', `${href}${href.includes('?') ? '&' : '?'}display=swap`);
      notes.push('display=swap ajouté à Google Fonts');
    }
  });

  if (googleFonts && !$('link[rel="preconnect"][href^="https://fonts.gstatic.com"]').length) {
    $('head').prepend('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    notes.push('connexion anticipée à fonts.gstatic.com');
  }

  let patched = 0;
  $('style').each((_, el) => {
    const css = $(el).html();
    if (!css || !css.includes('@font-face')) return;
    const next = css.replace(/@font-face\s*{([^}]*)}/g, (block, body) => {
      if (/font-display\s*:/.test(body)) return block;
      patched += 1;
      return `@font-face{${body.trim().replace(/;?$/, ';')}font-display:swap}`;
    });
    if (next !== css) $(el).html(next);
  });
  if (patched) notes.push(`${patched} @font-face en font-display: swap`);
  return notes;
}
