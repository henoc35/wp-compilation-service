import { toAllowRule } from '../../rules/index.js';

/**
 * Famille « assets » : retire les fichiers CSS et JS d'une extension sur les pages
 * qui ne contiennent aucun de ses éléments (règles dans rules/assets.yml), avec
 * leurs compléments en ligne (handle-js-extra, -js-before, -js-after, -inline-css).
 */

const matches = (url, patterns) => patterns.some((p) => (p instanceof RegExp ? p.test(url) : url.includes(p)));

function present($, selectors) {
  return selectors.some((sel) => {
    try {
      return $(sel).length > 0;
    } catch {
      return true; // sélecteur illisible : on ne retire rien
    }
  });
}

export function applyAssets($, ctx) {
  const notes = [];
  for (const rule of ctx.rules?.conditionalAssets || []) {
    const keepIf = rule.keep_if || [];
    if (present($, keepIf)) continue;
    const patterns = (rule.match || []).map(toAllowRule);
    const removed = [];
    $('script[src], link[rel~="stylesheet"][href]').each((_, el) => {
      const $el = $(el);
      const url = $el.attr('src') || $el.attr('href') || '';
      if (!matches(url, patterns)) return;
      const id = $el.attr('id') || '';
      const handle = id.replace(/-(js|css)$/, '');
      if (handle && handle !== id) {
        for (const suffix of ['-js-extra', '-js-before', '-js-after', '-js-translations', '-inline-css']) $(`[id="${handle}${suffix}"]`).remove();
      }
      $el.remove();
      removed.push(url.split('?')[0].split('/').pop());
    });
    for (const needle of rule.inline || []) {
      $('script:not([src]), style').each((_, el) => {
        if (($(el).html() || '').includes(needle)) {
          $(el).remove();
          removed.push(`en ligne (${needle})`);
        }
      });
    }
    if (removed.length) notes.push(`${rule.name} : ${removed.length} élément(s) retiré(s) (${[...new Set(removed)].slice(0, 4).join(', ')})`);
  }
  return notes;
}
