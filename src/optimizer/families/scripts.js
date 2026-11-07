/**
 * Famille « scripts ».
 *
 * Seuls les scripts tiers (statistiques, pixels, suivi) sont retardés jusqu'à la
 * première interaction. Les scripts nécessaires à l'affichage et à l'interaction
 * (Elementor, jQuery, sliders, menus…) ne sont jamais touchés.
 */

// Chargeur injecté en fin de page : réexécute les scripts retardés, dans l'ordre,
// à la première interaction de l'utilisateur.
export const DELAY_LOADER = `(function(){var done=false,ev=["pointerdown","keydown","touchstart","scroll","wheel"];function run(){if(done)return;done=true;ev.forEach(function(e){removeEventListener(e,run,{passive:true})});var list=Array.prototype.slice.call(document.querySelectorAll("script[data-cw-delay]")),i=0;function next(){if(i>=list.length)return;var old=list[i++],s=document.createElement("script");for(var a=0;a<old.attributes.length;a++){var at=old.attributes[a];if(["type","data-cw-delay","data-cw-src","data-cw-type"].indexOf(at.name)<0)s.setAttribute(at.name,at.value)}var t=old.getAttribute("data-cw-type");if(t)s.type=t;var src=old.getAttribute("data-cw-src");if(src){s.src=src;s.async=false;s.onload=s.onerror=next;old.parentNode.replaceChild(s,old)}else{s.text=old.text;old.parentNode.replaceChild(s,old);next()}}next()}ev.forEach(function(e){addEventListener(e,run,{passive:true})})})();`;

const UNTOUCHED_TYPES = ['application/ld+json', 'speculationrules', 'importmap', 'text/template', 'text/x-template'];

function matchesAny(value, needles) {
  return needles.some((n) => n && value.includes(n));
}

export function isThirdParty({ src, id, content }, rules) {
  const tp = rules.thirdParty;
  const ref = `${src || ''} ${id || ''}`;
  if (matchesAny(ref, rules.neverDelay)) return false;
  if (src) {
    let host = '';
    try {
      host = new URL(src, 'https://exemple.invalid').hostname;
    } catch {
      return false;
    }
    if (tp.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    if (matchesAny(src, tp.paths)) return true;
    return false;
  }
  return matchesAny(content || '', tp.inlineSignatures);
}

export function applyScripts($, ctx) {
  const notes = [];
  let delayed = 0;
  $('script').each((_, el) => {
    const $s = $(el);
    const type = ($s.attr('type') || '').trim().toLowerCase();
    if (UNTOUCHED_TYPES.includes(type) || $s.attr('data-cw-delay') !== undefined) return;
    if (type && !['text/javascript', 'module', 'application/javascript'].includes(type)) return;
    const src = $s.attr('src');
    const candidate = { src, id: $s.attr('id'), content: src ? '' : $s.html() };
    if (!isThirdParty(candidate, ctx.rules)) return;
    if (type) $s.attr('data-cw-type', type);
    $s.attr('type', 'text/plain');
    $s.attr('data-cw-delay', '');
    if (src) {
      $s.attr('data-cw-src', src);
      $s.removeAttr('src');
    }
    delayed += 1;
  });
  if (delayed) {
    $('body').append(`<script data-cw-loader>${DELAY_LOADER}</script>`);
    notes.push(`${delayed} script(s) tiers retardé(s) jusqu'à la première interaction`);
  }
  return notes;
}
