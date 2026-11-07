import * as cheerio from 'cheerio';

/** Balises SEO relevées dans une page (Yoast, Rank Math et WordPress les écrivent dans le HTML). */
export function extractSeo(html) {
  const $ = cheerio.load(html);
  const meta = (sel) => $(sel).toArray().map((el) => ($(el).attr('content') || '').trim());
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  return {
    title: norm($('head > title').first().text()),
    description: meta('meta[name="description"]'),
    robots: meta('meta[name="robots"]'),
    canonical: $('link[rel="canonical"]').toArray().map((el) => $(el).attr('href')),
    hreflang: $('link[rel="alternate"][hreflang]').toArray()
      .map((el) => `${$(el).attr('hreflang')}=${$(el).attr('href')}`).sort(),
    openGraph: $('meta[property^="og:"]').toArray()
      .map((el) => `${$(el).attr('property')}=${($(el).attr('content') || '').trim()}`).sort(),
    jsonLd: $('script[type="application/ld+json"]').toArray().map((el) => {
      const txt = $(el).html() || '';
      try {
        return JSON.stringify(JSON.parse(txt));
      } catch {
        return norm(txt);
      }
    }),
    h1: $('h1').toArray().map((el) => norm($(el).text())),
  };
}

/** Compare les balises SEO ; retourne la liste des différences (vide = parité). */
export function compareSeo(referenceHtml, candidateHtml) {
  const a = extractSeo(referenceHtml);
  const b = extractSeo(candidateHtml);
  const diffs = [];
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diffs.push({ field: key, reference: a[key], candidate: b[key] });
    }
  }
  return diffs;
}
