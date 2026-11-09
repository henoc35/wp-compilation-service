/**
 * Famille « embeds » : vidéos YouTube et Vimeo, cartes Google Maps chargées au clic.
 *
 * L'iframe reste en place (mêmes classes, dimensions et règles CSS du thème : aucun
 * décalage de mise en page), mais son contenu est remplacé par une vignette légère
 * (attribut srcdoc). Au clic, l'iframe charge le lecteur ou la carte d'origine.
 * Économie typique : plusieurs centaines de Ko de JavaScript par vidéo.
 */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function youtubeId(src) {
  const m = String(src).match(/^(?:https?:)?\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})(?:[?#]|$)/i);
  return m ? m[1] : null;
}
export const isVimeo = (src) => /^(?:https?:)?\/\/player\.vimeo\.com\/video\/\d+/i.test(String(src));
export const isMap = (src) => /^(?:https?:)?\/\/(?:www\.|maps\.)?google\.[a-z.]+\/maps(?:\/embed)?[/?]/i.test(String(src)) && /embed|output=embed/i.test(String(src));

/** URL du lecteur avec lecture automatique (le clic sur la vignette vaut lancement). */
export function withAutoplay(src) {
  const abs = String(src).startsWith('//') ? `https:${src}` : String(src);
  try {
    const u = new URL(abs);
    u.searchParams.set('autoplay', '1');
    return u.toString();
  } catch {
    return abs;
  }
}

const BASE_STYLE = '*{box-sizing:border-box;margin:0;padding:0}html,body{height:100%;overflow:hidden}'
  + 'a{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-decoration:none;font:600 15px/1.3 system-ui,sans-serif;color:#fff}'
  + 'img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}'
  + '.p{position:relative;width:68px;height:48px;border-radius:14px;background:rgba(0,0,0,.72);transition:background .2s}'
  + '.p:after{content:"";position:absolute;left:28px;top:14px;border-style:solid;border-width:10px 0 10px 17px;border-color:transparent transparent transparent #fff}'
  + 'a:hover .p,a:focus .p{background:#f00}';

export function videoSrcdoc({ href, thumbnail, label }) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>${BASE_STYLE}body{background:#000}</style></head><body>`
    + `<a href="${esc(href)}" aria-label="${esc(label)}">${thumbnail ? `<img src="${esc(thumbnail)}" alt="" decoding="async">` : ''}<span class="p"></span></a></body></html>`;
}

export function mapSrcdoc({ href, label }) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>${BASE_STYLE}`
    + 'body{background:#e8eaed linear-gradient(45deg,#dfe3e8 25%,transparent 25%,transparent 75%,#dfe3e8 75%) 0 0/40px 40px}'
    + 'a{color:#1a73e8}span{background:#fff;padding:10px 16px;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.25)}</style></head><body>'
    + `<a href="${esc(href)}"><span>📍 ${esc(label)}</span></a></body></html>`;
}

export function applyEmbeds($) {
  const notes = [];
  $('iframe[src]').each((_, el) => {
    const $el = $(el);
    if ($el.attr('srcdoc') || $el.attr('data-pc-facade') !== undefined) return;
    const src = $el.attr('src');
    const title = $el.attr('title') || '';
    let doc = null;
    const id = youtubeId(src);
    if (id) {
      doc = videoSrcdoc({ href: withAutoplay(src), thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, label: title ? `Lire la vidéo : ${title}` : 'Lire la vidéo' });
      notes.push(`vidéo YouTube ${id} chargée au clic`);
    } else if (isVimeo(src)) {
      doc = videoSrcdoc({ href: withAutoplay(src), thumbnail: null, label: title ? `Lire la vidéo : ${title}` : 'Lire la vidéo' });
      notes.push('vidéo Vimeo chargée au clic');
    } else if (isMap(src)) {
      doc = mapSrcdoc({ href: String(src).startsWith('//') ? `https:${src}` : src, label: 'Afficher la carte' });
      notes.push('carte Google Maps chargée au clic');
    }
    if (!doc) return;
    // srcdoc l'emporte sur src : le lecteur n'est chargé qu'au clic (lien dans l'iframe).
    $el.attr('srcdoc', doc);
    $el.attr('data-pc-facade', '');
    if (!$el.attr('loading')) $el.attr('loading', 'lazy');
  });
  return notes;
}
