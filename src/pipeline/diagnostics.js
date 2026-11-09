/**
 * Diagnostics de la page d'origine : part réellement utilisée de chaque fichier CSS
 * et JS (couverture de code de Chromium), et images trop grandes pour leur taille
 * d'affichage. Aucun effet sur la compilation : sert à l'historique et aux décisions.
 */

/** Densité d'écran visée pour juger une image : un téléphone récent (Pixel 7 : 2,625) et un écran d'ordinateur standard. */
export const TARGET_DPR = { mobile: 2.625, desktop: 1 };

/** Octets utilisés d'un script, d'après la couverture V8 (blocs imbriqués appliqués dans l'ordre). */
export function jsUsedFlags(entry) {
  const len = (entry.source || '').length;
  const flags = new Uint8Array(len);
  for (const fn of entry.functions || []) {
    for (const r of fn.ranges || []) {
      flags.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(len, r.endOffset));
    }
  }
  return flags;
}

export function cssUsedFlags(entry) {
  const len = (entry.text || '').length;
  const flags = new Uint8Array(len);
  for (const r of entry.ranges || []) flags.fill(1, Math.max(0, r.start), Math.min(len, r.end));
  return flags;
}

/** Fusionne plusieurs relevés (mobile, ordinateur) : un octet utilisé dans l'un est utilisé. */
export function mergeCoverage(lists) {
  const byUrl = new Map();
  for (const { type, entries } of lists) {
    for (const e of entries) {
      if (!e.url || e.url.startsWith('data:')) continue;
      const flags = type === 'js' ? jsUsedFlags(e) : cssUsedFlags(e);
      const key = `${type} ${e.url}`;
      const cur = byUrl.get(key);
      if (!cur) byUrl.set(key, { type, url: e.url, flags });
      else if (cur.flags.length === flags.length) for (let i = 0; i < flags.length; i += 1) cur.flags[i] |= flags[i];
    }
  }
  return [...byUrl.values()].map(({ type, url, flags }) => {
    let used = 0;
    for (let i = 0; i < flags.length; i += 1) used += flags[i];
    return { type, url, total: flags.length, used, unusedRatio: flags.length ? 1 - used / flags.length : 0 };
  });
}

/** Clé commune aux déclinaisons d'une même image WordPress (-1024x576, -scaled, formats). */
export function imageKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.replace(/-(\d+)x(\d+)(?=\.\w+$)/, '').replace(/-scaled(?=\.\w+$)/, '').replace(/\.(jpe?g|png|webp|avif|gif)$/i, '');
  } catch {
    return url;
  }
}

/**
 * Relevé des images dans la page (exécuté dans le navigateur) : <img> et images de fond,
 * taille réelle et taille affichée. Les fonds sont chargés pour connaître leur taille réelle.
 */
export async function collectImages() {
  const out = [];
  const docTop = (el) => el.getBoundingClientRect().top + window.scrollY;
  for (const img of Array.from(document.images)) {
    if (!img.complete || !img.naturalWidth) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push({
      kind: 'img', url: img.currentSrc || img.src, src: img.src, natural: [img.naturalWidth, img.naturalHeight], display: [Math.round(r.width), Math.round(r.height)],
      srcset: Boolean(img.getAttribute('srcset')), sizes: img.getAttribute('sizes') || null, loading: img.getAttribute('loading') || null,
      top: Math.round(docTop(img)),
    });
  }
  const seen = new Set();
  const backgrounds = [];
  const all = Array.from(document.querySelectorAll('body *')).slice(0, 4000);
  for (const el of all) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (!m || m[1].startsWith('data:')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const url = new URL(m[1], location.href).href;
    const key = `${url}|${Math.round(r.width)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    backgrounds.push({ kind: 'background', url, display: [Math.round(r.width), Math.round(r.height)], top: Math.round(docTop(el)) });
    if (backgrounds.length >= 40) break;
  }
  // Taille réelle des fichiers : pour une image avec srcset, naturalWidth est divisée par
  // la densité déduite de sizes ; on relit donc le fichier, comme pour les images de fond.
  const sizes = new Map();
  const toMeasure = [...backgrounds.map((b) => b.url), ...out.filter((i) => i.srcset).map((i) => i.url)];
  await Promise.all([...new Set(toMeasure)].slice(0, 80).map((url) => new Promise((resolve) => {
    const im = new Image();
    const done = () => { sizes.set(url, [im.naturalWidth, im.naturalHeight]); resolve(); };
    im.onload = done;
    im.onerror = () => resolve();
    setTimeout(resolve, 4000);
    im.src = url;
  })));
  for (const i of out) if (i.srcset && sizes.get(i.url)?.[0]) i.natural = sizes.get(i.url);
  for (const b of backgrounds) if (sizes.get(b.url)?.[0]) out.push({ ...b, natural: sizes.get(b.url) });
  return { images: out, viewportHeight: window.innerHeight };
}

/**
 * Analyse : images surdimensionnées (gain estimé au prorata des pixels en trop),
 * doublons d'une même image, part inutilisée des CSS et JS.
 *
 * @param {object} p
 * @param {Record<string, {images: object[], viewportHeight: number}>} p.images  relevé par format (mobile, desktop)
 * @param {object[]} p.coverage    sortie de mergeCoverage
 * @param {object[]} p.resources   ressources du rendu mobile (poids transférés)
 * @param {string|null} p.lcpUrl   image LCP mobile
 */
export function analyze({ images, coverage, resources, lcpUrl = null }) {
  const bytesOf = new Map();
  for (const r of resources || []) bytesOf.set(r.url, { bytes: r.bytes, mime: r.mime });

  // Images : regroupées par image (attribut src) ; chaque format d'écran a pu charger
  // une variante différente du srcset. L'excès est jugé sur la variante la plus excessive.
  const byKey = new Map();
  for (const [viewport, data] of Object.entries(images || {})) {
    for (const im of data?.images || []) {
      const key = im.src || im.url;
      const needed = Math.ceil(im.display[0] * (TARGET_DPR[viewport] || 1));
      const use = { viewport, url: im.url, natural: im.natural, display: im.display, needed, aboveFold: im.top < (data.viewportHeight || 900) };
      const cur = byKey.get(key);
      if (!cur) byKey.set(key, { key, kind: im.kind, srcset: im.srcset || false, uses: [use] });
      else cur.uses.push(use);
    }
  }
  const imageList = [];
  for (const im of byKey.values()) {
    let worst = null;
    for (const u of im.uses) {
      const oversize = u.needed > 0 ? u.natural[0] / u.needed : 1;
      const bytes = bytesOf.get(u.url)?.bytes ?? null;
      const savings = bytes && oversize > 1.15 ? Math.round(bytes * (1 - 1 / (oversize * oversize))) : 0;
      if (!worst || savings > worst.savings || (savings === worst.savings && oversize > worst.oversize)) worst = { ...u, oversize, bytes, savings };
    }
    const largest = im.uses.reduce((m, u) => (u.natural[0] > m.natural[0] ? u : m), im.uses[0]);
    imageList.push({
      url: worst.url, src: im.key !== worst.url ? im.key : undefined, kind: im.kind, natural: largest.natural,
      needed: Math.max(...im.uses.map((u) => u.needed)), oversize: Math.round(worst.oversize * 100) / 100,
      display: Object.fromEntries(im.uses.map((u) => [u.viewport, u.display])), aboveFold: im.uses.some((u) => u.aboveFold),
      srcset: im.srcset, bytes: worst.bytes, mime: bytesOf.get(worst.url)?.mime || null, savings: worst.savings,
      lcp: Boolean(lcpUrl && im.uses.some((u) => u.url === lcpUrl)), key: imageKey(im.key),
    });
  }
  // Doublons : plusieurs fichiers différents pour la même image d'origine.
  const groups = new Map();
  for (const r of (resources || []).filter((x) => x.type === 'image' || /^image\//.test(x.mime || ''))) {
    const k = imageKey(r.url);
    if (!groups.has(k)) groups.set(k, new Set());
    groups.get(k).add(r.url);
  }
  const duplicates = [...groups.entries()].filter(([, s]) => s.size > 1).map(([key, s]) => ({
    key, files: [...s], bytes: [...s].reduce((n, u) => n + (bytesOf.get(u)?.bytes || 0), 0),
  }));

  const files = (coverage || []).map((c) => {
    const transfer = bytesOf.get(c.url)?.bytes ?? null;
    return { ...c, transfer, unusedTransfer: transfer != null ? Math.round(transfer * c.unusedRatio) : null };
  }).sort((a, b) => (b.total - b.used) - (a.total - a.used));

  const sum = (list, f) => list.reduce((n, x) => n + (f(x) || 0), 0);
  const css = files.filter((f) => f.type === 'css');
  const js = files.filter((f) => f.type === 'js');
  const summary = {
    cssTotal: sum(css, (f) => f.total), cssUnused: sum(css, (f) => f.total - f.used),
    jsTotal: sum(js, (f) => f.total), jsUnused: sum(js, (f) => f.total - f.used),
    imagesOversized: imageList.filter((i) => i.savings > 0).length, imagesSavings: sum(imageList, (i) => i.savings),
    duplicates: duplicates.length,
  };
  imageList.sort((a, b) => b.savings - a.savings || (b.bytes || 0) - (a.bytes || 0));
  return { summary, images: imageList.slice(0, 150), duplicates: duplicates.slice(0, 50), files: files.slice(0, 150) };
}
