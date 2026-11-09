import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsUsedFlags, cssUsedFlags, mergeCoverage, imageKey, analyze } from '../../src/pipeline/diagnostics.js';
import { aggregateDiagnostics } from '../../src/api/admin.js';

const count = (f) => f.reduce((n, x) => n + x, 0);

test('couverture JS : blocs imbriqués (fonction appelée, branche jamais exécutée)', () => {
  const source = 'x'.repeat(100);
  const entry = { url: 'a.js', source, functions: [
    { ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] }, // script
    { ranges: [{ startOffset: 10, endOffset: 50, count: 1 }, { startOffset: 20, endOffset: 30, count: 0 }] }, // fonction, branche morte
    { ranges: [{ startOffset: 60, endOffset: 90, count: 0 }] }, // fonction jamais appelée
  ] };
  assert.equal(count(jsUsedFlags(entry)), 100 - 10 - 30);
});

test('couverture CSS et fusion mobile + ordinateur', () => {
  const text = 'y'.repeat(50);
  assert.equal(count(cssUsedFlags({ text, ranges: [{ start: 0, end: 10 }, { start: 40, end: 50 }] })), 20);
  const merged = mergeCoverage([
    { type: 'css', entries: [{ url: 'a.css', text, ranges: [{ start: 0, end: 10 }] }] },
    { type: 'css', entries: [{ url: 'a.css', text, ranges: [{ start: 5, end: 25 }] }] },
    { type: 'js', entries: [{ url: 'data:text/js,1', source: 'z', functions: [] }] },
  ]);
  assert.equal(merged.length, 1, 'scripts data: ignorés');
  assert.equal(merged[0].used, 25);
  assert.equal(merged[0].unusedRatio, 0.5);
});

test('variantes d\'une même image (srcset) regroupées : tailles mobile et ordinateur réunies', () => {
  const r = analyze({
    images: {
      mobile: { viewportHeight: 915, images: [{ kind: 'img', url: 'https://ex.fr/u/h-768x432.jpg', src: 'https://ex.fr/u/h.jpg', natural: [768, 432], display: [364, 205], top: 0, srcset: true }] },
      desktop: { viewportHeight: 900, images: [{ kind: 'img', url: 'https://ex.fr/u/h-1536x864.jpg', src: 'https://ex.fr/u/h.jpg', natural: [1536, 864], display: [640, 360], top: 0, srcset: true }] },
    },
    coverage: [],
    resources: [{ url: 'https://ex.fr/u/h-768x432.jpg', type: 'image', bytes: 60000 }, { url: 'https://ex.fr/u/h-1536x864.jpg', type: 'image', bytes: 200000 }],
  });
  assert.equal(r.images.length, 1);
  assert.deepEqual(Object.keys(r.images[0].display).sort(), ['desktop', 'mobile']);
  assert.equal(r.images[0].src, 'https://ex.fr/u/h.jpg');
  assert.equal(r.images[0].url, 'https://ex.fr/u/h-1536x864.jpg', 'variante la plus excessive : 1536 px pour 640 px sur ordinateur');
  assert.equal(r.images[0].oversize, 2.4);
});

test('clé d\'image WordPress : tailles et -scaled regroupées', () => {
  const k = imageKey('https://ex.fr/wp-content/uploads/2024/05/photo-1024x576.jpg');
  assert.equal(imageKey('https://ex.fr/wp-content/uploads/2024/05/photo-scaled.jpg'), k);
  assert.equal(imageKey('https://ex.fr/wp-content/uploads/2024/05/photo.webp'), k);
  assert.notEqual(imageKey('https://ex.fr/wp-content/uploads/2024/05/autre.jpg'), k);
});

test('analyse : image trop grande, gain estimé, doublon, image LCP', () => {
  const resources = [
    { url: 'https://ex.fr/u/hero-2560x1440.jpg', type: 'image', bytes: 400000, mime: 'image/jpeg' },
    { url: 'https://ex.fr/u/hero.jpg', type: 'image', bytes: 900000, mime: 'image/jpeg' },
    { url: 'https://ex.fr/u/logo.png', type: 'image', bytes: 8000, mime: 'image/png' },
    { url: 'https://ex.fr/a.css', type: 'stylesheet', bytes: 20000 },
  ];
  const r = analyze({
    images: {
      mobile: { viewportHeight: 915, images: [
        { kind: 'img', url: 'https://ex.fr/u/hero-2560x1440.jpg', natural: [2560, 1440], display: [412, 232], top: 0, srcset: false },
        { kind: 'img', url: 'https://ex.fr/u/logo.png', natural: [200, 80], display: [100, 40], top: 0, srcset: false },
      ] },
      desktop: { viewportHeight: 900, images: [{ kind: 'img', url: 'https://ex.fr/u/hero-2560x1440.jpg', natural: [2560, 1440], display: [1440, 810], top: 0 }] },
    },
    coverage: [{ type: 'css', url: 'https://ex.fr/a.css', total: 100000, used: 20000, unusedRatio: 0.8 }],
    resources,
    lcpUrl: 'https://ex.fr/u/hero-2560x1440.jpg',
  });
  const hero = r.images[0];
  assert.equal(hero.needed, 1440, 'la plus grande largeur utile (ordinateur 1440 px > mobile 412 × 2,625)');
  assert.equal(hero.oversize, 2.37, 'excès jugé sur le format le plus défavorable : mobile, 2560 px pour 1082 px utiles');
  assert.ok(hero.savings > 300000 && hero.savings < 340000);
  assert.ok(hero.lcp);
  const logo = r.images.find((i) => i.url.endsWith('logo.png'));
  assert.equal(logo.savings, 0, '200 px pour 100 px × 2,625 : pas trop grande');
  assert.equal(r.duplicates.length, 1, 'hero.jpg et hero-2560x1440.jpg : même image');
  assert.equal(r.summary.cssUnused, 80000);
  assert.equal(r.files[0].unusedTransfer, 16000);
});

test('agrégat du site : fichiers et images comptés une fois, partie inutilisée partout', () => {
  const page = (unused, needed) => ({ url: 'p', diagnostics: {
    files: [{ type: 'css', url: 'a.css', total: 1000, used: 1000 * (1 - unused), unusedRatio: unused, transfer: 300 }],
    images: [{ url: 'i.jpg', natural: [2000, 1000], needed, oversize: 2000 / needed, savings: needed < 1000 ? 5000 : 1000, bytes: 9000, display: {} }],
  } });
  const g = aggregateDiagnostics([page(0.9, 800), page(0.6, 1200)]);
  assert.equal(g.pages, 2);
  assert.equal(g.files.length, 1);
  assert.equal(g.files[0].pages, 2);
  assert.equal(g.files[0].unusedEverywhere, 0.6);
  assert.equal(g.images.length, 1);
  assert.equal(g.images[0].needed, 1200, 'la plus grande taille utile l\'emporte');
  assert.equal(g.summary.imagesSavings, 1000);
});
