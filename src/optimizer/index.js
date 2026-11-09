import * as cheerio from 'cheerio';
import { applyImages } from './families/images.js';
import { applyAnimations } from './families/animations.js';
import { applyFonts } from './families/fonts.js';
import { applyScripts } from './families/scripts.js';
import { applyNavigation } from './families/navigation.js';
import { applyCriticalCss } from './families/css.js';
import { applyEmbeds } from './families/embeds.js';
import { applyAssets } from './families/assets.js';
import { applyResponsive } from './families/responsive.js';

// Ordre d'application (le CSS critique est calculé en dernier, sur la page finale).
// « responsive » passe avant « images » : le préchargement de l'image LCP reprend
// alors son srcset (imagesrcset), sans téléchargement en double.
const DOM_FAMILIES = {
  responsive: applyResponsive,
  images: applyImages,
  animations: applyAnimations,
  fonts: applyFonts,
  embeds: applyEmbeds,
  assets: applyAssets,
  scripts: applyScripts,
  navigation: applyNavigation,
};

/**
 * Applique les familles demandées au HTML d'origine.
 * Chaque famille est indépendante : c'est ce qui permet d'isoler celle qui casse.
 *
 * @returns {{ html: string, applied: string[], notes: Record<string, string[]> }}
 */
export async function optimize(html, ctx, families) {
  const $ = cheerio.load(html);
  const applied = [];
  const notes = {};

  for (const [name, apply] of Object.entries(DOM_FAMILIES)) {
    if (!families.includes(name)) continue;
    notes[name] = apply($, ctx);
    applied.push(name);
  }

  // Marqueur discret, utile au plugin et au diagnostic.
  $('head').append(`<meta name="page-compiler" content="${applied.concat(families.includes('css') ? ['css'] : []).join(',')}">`);
  let out = $.html();

  if (families.includes('css')) {
    const res = await applyCriticalCss(out, ctx);
    out = res.html;
    notes.css = res.notes;
    applied.push('css');
  }
  return { html: out, applied, notes };
}
