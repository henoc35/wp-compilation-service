import crypto from 'node:crypto';

/**
 * Hébergement local des Google Fonts : la feuille de styles Google est téléchargée,
 * les fichiers woff2 des jeux de caractères latin et latin-ext sont envoyés au site
 * avec la page compilée, et la page les charge depuis le site lui-même. Les autres
 * jeux (cyrillique, grec…) restent chez Google : rien ne change pour ces textes.
 * Gains : une connexion de moins vers Google, préchargement possible, aucun appel
 * à Google pour les visiteurs sur ces polices (RGPD).
 */

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const LOCAL_SUBSETS = new Set(['latin', 'latin-ext']);
const MAX_FILES = 40;
const MAX_FILE_BYTES = 400 * 1024;

/** Liens vers les feuilles Google Fonts dans la page. */
export function googleFontLinks($, hosts = ['fonts.googleapis.com']) {
  const out = [];
  $('link[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const rel = ($(el).attr('rel') || '').toLowerCase();
    if (!/stylesheet/.test(rel)) return;
    try {
      const u = new URL(href.startsWith('//') ? `https:${href}` : href);
      if (hosts.includes(u.hostname) && /^\/css2?$/.test(u.pathname)) out.push({ el, href: u.toString() });
    } catch { /* lien illisible */ }
  });
  return out;
}

/** Découpe la feuille Google en blocs @font-face, avec le jeu de caractères indiqué en commentaire. */
export function parseFontFaces(css) {
  const blocks = [];
  const re = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const urlMatch = m[2].match(/url\(([^)]+)\)\s*format\(['"]?woff2['"]?\)/);
    blocks.push({ subset: m[1] || null, body: m[2], url: urlMatch ? urlMatch[1].replace(/["']/g, '') : null, raw: m[0] });
  }
  return blocks;
}

/**
 * Prépare les polices locales : retourne, par feuille Google, la feuille réécrite et
 * les fichiers à envoyer au site. `assetsPath` : chemin public du dossier des fichiers
 * sur le site (ex. /wp-content/cache/page-compiler/assets/).
 */
export async function prepareFonts($, { assetsPath, hosts, fetchImpl = fetch, timeoutMs = 15000 }) {
  const sheets = new Map();
  const files = new Map(); // URL d'origine → { path, data, contentType }
  if (!assetsPath) return { sheets, files };
  for (const { href } of googleFontLinks($, hosts)) {
    if (sheets.has(href)) continue;
    try {
      const res = await fetchImpl(href, { headers: { 'user-agent': CHROME_UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      let css = await res.text();
      for (const block of parseFontFaces(css)) {
        if (!block.url || !LOCAL_SUBSETS.has(block.subset) || files.size >= MAX_FILES) continue;
        let local = files.get(block.url);
        if (!local) {
          const r = await fetchImpl(block.url, { signal: AbortSignal.timeout(timeoutMs) });
          if (!r.ok) continue;
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > MAX_FILE_BYTES || buf.length < 100) continue;
          const name = `fonts/${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.woff2`;
          local = { path: name, data: buf.toString('base64'), contentType: 'font/woff2', bytes: buf.length };
          files.set(block.url, local);
        }
        css = css.split(block.url).join(`${assetsPath}${local.path}`);
      }
      if (!/font-display/.test(css)) css = css.replace(/@font-face\s*\{/g, '@font-face{font-display:swap;');
      sheets.set(href, css);
    } catch { /* Google injoignable : la feuille reste chargée depuis Google */ }
  }
  return { sheets, files };
}

/** Remplace les liens Google par les feuilles réécrites, et précharge les polices utilisées à l'ouverture. */
export function inlineLocalFonts($, { sheets, files }, { hosts, usedFontUrls = [], assetsPath }) {
  const notes = [];
  if (!sheets?.size) return notes;
  for (const { el, href } of googleFontLinks($, hosts)) {
    const css = sheets.get(href);
    if (!css) continue;
    $(el).replaceWith(`<style data-pc-fonts>${css}</style>`);
    notes.push('Google Fonts hébergées sur le site (latin, latin-ext)');
  }
  const preload = usedFontUrls.map((u) => files.get(u)).filter(Boolean).slice(0, 2);
  for (const f of preload) {
    $('head').prepend(`<link rel="preload" href="${assetsPath}${f.path}" as="font" type="font/woff2" crossorigin>`);
  }
  if (preload.length) notes.push(`${preload.length} police(s) préchargée(s)`);
  // La connexion anticipée vers Google n'est plus utile si toutes les feuilles sont locales.
  if (!googleFontLinks($, hosts).length) {
    $('link[rel~="preconnect"][href*="fonts.googleapis.com"], link[rel~="dns-prefetch"][href*="fonts.googleapis.com"]').remove();
  }
  return [...new Set(notes)];
}
