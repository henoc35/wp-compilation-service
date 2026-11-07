import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { applyImages } from '../../src/optimizer/families/images.js';
import { applyAnimations } from '../../src/optimizer/families/animations.js';
import { applyScripts, isThirdParty } from '../../src/optimizer/families/scripts.js';
import { applyFonts } from '../../src/optimizer/families/fonts.js';
import { applyNavigation } from '../../src/optimizer/families/navigation.js';
import { absolutizeCssUrls } from '../../src/optimizer/families/css.js';
import { loadRules, resolveRules } from '../../src/rules/index.js';
import { optimize } from '../../src/optimizer/index.js';

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>T</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">
<style>@font-face{font-family:X;src:url(x.woff2)}</style>
<link rel="stylesheet" href="/wp-content/plugins/elementor/assets/css/frontend.css">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body>
<section class="hero" data-id="hero1"><h1 class="elementor-invisible" data-id="h1x" data-settings='{"_animation":"fadeInUp","_animation_delay":200,"sticky":"top"}'>Titre</h1></section>
<img src="data:image/svg+xml,placeholder" data-lazy-src="https://www.exemple.fr/wp-content/uploads/hero.jpg" class="rocket-lazyload">
<img src="/wp-content/uploads/photo.jpg">
<script src="/wp-content/plugins/elementor/assets/js/frontend.min.js" id="elementor-frontend-js"></script>
<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>
<script>gtag('config','G-1');</script>
<script>console.log('script du site');</script>
</body></html>`;

const rules = resolveRules(loadRules('rules'), HTML, null);

function ctx(reference) {
  return { url: 'https://www.exemple.fr/', rules, config: {}, reference };
}

test('images : fond LCP préchargé et exclu du lazy-load d’Elementor', () => {
  const $ = cheerio.load(HTML);
  applyImages($, ctx({ mobile: { lcp: { url: 'https://www.exemple.fr/wp-content/uploads/fond.jpg', isImg: false, dataId: 'hero1' } } }));
  assert.equal($('link[rel="preload"][as="image"]').attr('href'), '/wp-content/uploads/fond.jpg');
  assert.equal($('link[rel="preload"]').attr('fetchpriority'), 'high');
  assert.ok($('[data-id="hero1"]').hasClass('e-no-lazyload'));
});

test('images : image LCP sortie du lazy-load de WP Rocket, autres images en lazy natif', () => {
  const $ = cheerio.load(HTML);
  applyImages($, ctx({ desktop: { lcp: { url: 'https://www.exemple.fr/wp-content/uploads/hero.jpg', isImg: true } } }));
  const hero = $('img').first();
  assert.equal(hero.attr('src'), 'https://www.exemple.fr/wp-content/uploads/hero.jpg');
  assert.equal(hero.attr('data-lazy-src'), undefined);
  assert.equal(hero.attr('fetchpriority'), 'high');
  assert.equal(hero.attr('loading'), 'eager');
  assert.equal($('img').eq(1).attr('loading'), 'lazy');
});

test('animations : retirées sur les éléments visibles, autres réglages conservés', () => {
  const $ = cheerio.load(HTML);
  applyAnimations($, ctx({ animatedIds: ['h1x'] }));
  const h1 = $('[data-id="h1x"]');
  assert.ok(!h1.hasClass('elementor-invisible'));
  assert.deepEqual(JSON.parse(h1.attr('data-settings')), { sticky: 'top' });
});

test('scripts : seuls les scripts tiers sont retardés', () => {
  const $ = cheerio.load(HTML);
  const notes = applyScripts($, ctx({}));
  assert.equal($('script[data-cw-delay]').length, 2);
  assert.equal($('#elementor-frontend-js').attr('type'), undefined);
  assert.equal($('script[type="application/ld+json"]').length, 1);
  assert.equal($('script[data-cw-loader]').length, 1);
  assert.match($('script[data-cw-delay]').first().attr('data-cw-src'), /googletagmanager/);
  assert.match(notes[0], /2 script/);
});

test('scripts : une règle never_delay l’emporte sur la liste des tiers', () => {
  const r = { ...rules, neverDelay: [...rules.neverDelay, 'googletagmanager'] };
  assert.equal(isThirdParty({ src: 'https://www.googletagmanager.com/gtm.js' }, r), false);
  assert.equal(isThirdParty({ src: 'https://connect.facebook.net/fbevents.js' }, r), true);
});

test('polices : display=swap, connexion anticipée, font-display ajouté', () => {
  const $ = cheerio.load(HTML);
  applyFonts($);
  assert.match($('link[href*="fonts.googleapis.com"]').attr('href'), /display=swap/);
  assert.equal($('link[rel="preconnect"][href="https://fonts.gstatic.com"]').length, 1);
  assert.match($('style').first().html(), /font-display:swap/);
});

test('navigation : règles de spéculation en prefetch par défaut', () => {
  const $ = cheerio.load(HTML);
  applyNavigation($, ctx({}));
  const json = JSON.parse($('script[type="speculationrules"]').html());
  assert.ok(json.prefetch);
  assert.equal(json.prefetch[0].eagerness, 'moderate');
});

test('css : url() relatives réécrites depuis la racine du site', () => {
  const css = '.a{background:url(../img/a.png)}.b{background:url("https://cdn.x/b.png")}.c{background:url(data:image/png;base64,AA)}';
  const out = absolutizeCssUrls(css, 'https://www.exemple.fr/wp-content/themes/t/css/style.css?ver=1');
  assert.match(out, /url\(\/wp-content\/themes\/t\/img\/a\.png\)/);
  assert.match(out, /https:\/\/cdn\.x\/b\.png/);
  assert.match(out, /data:image\/png/);
});

test('optimiseur : seules les familles demandées sont appliquées', async () => {
  const res = await optimize(HTML, ctx({ animatedIds: ['h1x'] }), ['animations', 'fonts']);
  assert.deepEqual(res.applied, ['animations', 'fonts']);
  assert.ok(!res.html.includes('data-cw-delay'));
  assert.ok(!res.html.includes('speculationrules'));
  assert.match(res.html, /<meta name="page-compiler" content="animations,fonts">/);
});

test('règles : addons détectés dans le HTML', () => {
  assert.ok(rules.addonsDetected.includes('elementor'));
  assert.ok(rules.allowRules.some((r) => r instanceof RegExp && r.test('.elementor-nav-menu--dropdown')));
});

test('css : les feuilles à média restreint sont repérées pour être laissées intactes', async () => {
  const { restrictedMediaHrefs, isUniversalMedia } = await import('../../src/optimizer/families/css.js');
  const html = '<link rel="stylesheet" href="/a.css" media="all"><link rel="stylesheet" href="/small.css" media="only screen and (max-width: 768px)"><link rel="stylesheet" href="/p.css" media="print">';
  const set = restrictedMediaHrefs(html, 'https://www.exemple.fr/');
  assert.ok(set.has('/small.css') && set.has('/p.css') && !set.has('/a.css'));
  assert.ok(isUniversalMedia('screen') && !isUniversalMedia('print'));
});

test('images : srcset sans src ne produit jamais href="undefined"', () => {
  const $ = cheerio.load('<html><head><meta charset="utf-8"></head><body><img srcset="/a-400.jpg 400w, /a-800.jpg 800w" sizes="100vw"></body></html>');
  applyImages($, ctx({ mobile: { lcp: { url: 'https://www.exemple.fr/a-800.jpg', isImg: true } } }));
  const link = $('link[rel="preload"]');
  assert.equal(link.attr('href'), undefined);
  assert.equal(link.attr('imagesrcset'), '/a-400.jpg 400w, /a-800.jpg 800w');
});

test('animations : un data-id piégé est ignoré sans erreur', () => {
  const $ = cheerio.load(HTML);
  assert.doesNotThrow(() => applyAnimations($, ctx({ animatedIds: ['x"]', 'h1x'] })));
});
