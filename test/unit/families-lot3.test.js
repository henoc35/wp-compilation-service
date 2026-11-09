import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { applyEmbeds, youtubeId, isMap } from '../../src/optimizer/families/embeds.js';
import { applyAssets } from '../../src/optimizer/families/assets.js';
import { applyResponsive, sameRatio, sizesAttr } from '../../src/optimizer/families/responsive.js';
import { prepareFonts, inlineLocalFonts, parseFontFaces } from '../../src/optimizer/fonts-local.js';
import { loadRules, resolveRules } from '../../src/rules/index.js';
import { clsWorse } from '../../src/verify/index.js';
import { medianFloat } from '../../src/pipeline/render.js';
import { assetsPathFor } from '../../src/pipeline/compile.js';

test('façades : YouTube et Maps chargés au clic, l\'iframe et ses attributs restent', () => {
  const $ = cheerio.load(`<div class="e"><iframe class="v" width="560" height="315" title="Présentation" src="https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0" allow="autoplay"></iframe>
    <iframe src="https://www.google.com/maps/embed?pb=!1m18"></iframe><iframe src="https://autre.fr/widget"></iframe></div>`);
  const notes = applyEmbeds($);
  assert.equal(notes.length, 2);
  const yt = $('iframe.v');
  assert.equal(yt.attr('width'), '560');
  assert.equal(yt.attr('src'), 'https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0', 'src conservé (masques, repli)');
  assert.match(yt.attr('srcdoc'), /i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg/);
  assert.match(yt.attr('srcdoc'), /autoplay=1/);
  assert.match(yt.attr('srcdoc'), /Lire la vidéo : Présentation/);
  assert.match($('iframe').eq(1).attr('srcdoc'), /Afficher la carte/);
  assert.equal($('iframe').eq(2).attr('srcdoc'), undefined, 'autres iframes inchangées');
  assert.equal(youtubeId('//www.youtube-nocookie.com/embed/abcdefghijk'), 'abcdefghijk');
  assert.ok(isMap('https://maps.google.com/maps?q=Paris&output=embed'));
  assert.ok(!isMap('https://www.google.com/maps/place/Paris'));
});

const rules = resolveRules(loadRules('rules'), '', null);

test('fichiers inutiles : Contact Form 7 retiré sans formulaire, gardé avec', () => {
  const html = (body) => `<html><head>
    <link rel="stylesheet" id="contact-form-7-css" href="/wp-content/plugins/contact-form-7/includes/css/styles.css?ver=5.9">
    <style id="contact-form-7-inline-css">.wpcf7 .screen-reader-response{}</style>
    <link rel="stylesheet" id="wp-block-library-css" href="/wp-includes/css/dist/block-library/style.min.css">
    <script>window._wpemojiSettings = {}; </script>
  </head><body>${body}
    <script id="contact-form-7-js-before">var wpcf7 = {};</script>
    <script id="contact-form-7-js" src="/wp-content/plugins/contact-form-7/includes/js/index.js"></script>
    <script src="/wp-content/themes/t/app.js"></script></body></html>`;
  let $ = cheerio.load(html('<p>Accueil</p>'));
  const notes = applyAssets($, { rules });
  assert.equal($('[id^="contact-form-7"]').length, 0, 'fichiers et compléments en ligne retirés');
  assert.equal($('#wp-block-library-css').length, 0, 'styles Gutenberg inutiles retirés');
  assert.ok(!$.html().includes('_wpemojiSettings'));
  assert.equal($('script[src*="app.js"]').length, 1, 'scripts du thème intacts');
  assert.ok(notes.some((n) => n.startsWith('Contact Form 7')));
  $ = cheerio.load(html('<div class="wpcf7"><form class="wpcf7-form"></form></div><p class="wp-block-paragraph">x</p>'));
  applyAssets($, { rules });
  assert.equal($('#contact-form-7-js').length, 1, 'gardé sur la page de contact');
  assert.equal($('#wp-block-library-css').length, 1, 'gardé si un bloc est présent');
});

test('tailles d\'images : srcset depuis la médiathèque, sizes mesuré, espace réservé', () => {
  const url = 'https://ex.fr/';
  const $ = cheerio.load('<img class="size-full wp-image-12" src="/u/hero.jpg"><img src="/u/logo.png" width="100" height="40"><img src="/u/photo.jpg">');
  const media = new Map([['12', [
    { url: 'https://ex.fr/u/hero.jpg', width: 2560, height: 1440 }, { url: 'https://ex.fr/u/hero-1024x576.jpg', width: 1024, height: 576 },
    { url: 'https://ex.fr/u/hero-768x432.jpg', width: 768, height: 432 }, { url: 'https://ex.fr/u/hero-150x150.jpg', width: 150, height: 150 },
  ]]]);
  const imageInfo = new Map([
    ['https://ex.fr/u/hero.jpg', { natural: [2560, 1440], display: { mobile: [412, 232], desktop: [1440, 810] } }],
    ['https://ex.fr/u/photo.jpg', { natural: [800, 600], display: { mobile: [380, 285] } }],
  ]);
  const notes = applyResponsive($, { url, media, imageInfo });
  const hero = $('img').eq(0);
  assert.equal(hero.attr('srcset'), 'https://ex.fr/u/hero-768x432.jpg 768w, https://ex.fr/u/hero-1024x576.jpg 1024w, https://ex.fr/u/hero.jpg 2560w', 'vignette carrée exclue');
  assert.equal(hero.attr('sizes'), '(max-width: 767px) 100vw, 1440px');
  assert.match(hero.attr('style'), /aspect-ratio:2560 \/ 1440/);
  assert.equal($('img').eq(1).attr('style'), undefined, 'dimensions déjà présentes');
  assert.match($('img').eq(2).attr('style'), /aspect-ratio:800 \/ 600/);
  assert.equal(notes.length, 2);
  assert.equal(sameRatio([{ width: 300, height: 300 }, { width: 300, height: 169 }], 1600, 900).length, 1);
  assert.equal(sizesAttr({ mobile: [200, 100], desktop: [600, 300] }), '(max-width: 767px) 49vw, 600px');
});

test('polices locales : latin et latin-ext sur le site, autres jeux chez Google, préchargement', async () => {
  const css = `/* cyrillic */\n@font-face { font-family: 'Roboto'; src: url(https://fonts.gstatic.com/s/roboto/cyr.woff2) format('woff2'); unicode-range: U+0400-045F; }
/* latin-ext */\n@font-face { font-family: 'Roboto'; src: url(https://fonts.gstatic.com/s/roboto/ext.woff2) format('woff2'); unicode-range: U+0100-02BA; }
/* latin */\n@font-face { font-family: 'Roboto'; src: url(https://fonts.gstatic.com/s/roboto/lat.woff2) format('woff2'); unicode-range: U+0000-00FF; }`;
  assert.deepEqual(parseFontFaces(css).map((b) => b.subset), ['cyrillic', 'latin-ext', 'latin']);
  const fetchImpl = async (u) => (u.includes('googleapis')
    ? { ok: true, text: async () => css }
    : { ok: true, arrayBuffer: async () => Buffer.alloc(2000, u.includes('lat') ? 1 : 2) });
  const $ = cheerio.load('<head><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto:400&display=swap"></head><body></body>');
  const prepared = await prepareFonts($, { assetsPath: '/wp-content/cache/page-compiler/assets/', hosts: ['fonts.googleapis.com'], fetchImpl });
  assert.equal(prepared.files.size, 2);
  const notes = inlineLocalFonts($, prepared, { hosts: ['fonts.googleapis.com'], usedFontUrls: ['https://fonts.gstatic.com/s/roboto/lat.woff2'], assetsPath: '/wp-content/cache/page-compiler/assets/' });
  const style = $('style[data-pc-fonts]').html();
  assert.match(style, /\/wp-content\/cache\/page-compiler\/assets\/fonts\/[0-9a-f]{32}\.woff2/);
  assert.match(style, /fonts\.gstatic\.com\/s\/roboto\/cyr\.woff2/, 'cyrillique laissé chez Google');
  assert.equal($('link[href*="fonts.googleapis.com"]').length, 0);
  assert.equal($('link[rel=preload][as=font]').length, 1);
  assert.equal(notes.length, 2);
});

test('CLS, médiane et dossier des fichiers déposés', () => {
  assert.equal(clsWorse(0.05, 0.06), false, 'bruit toléré');
  assert.equal(clsWorse(0.05, 0.09), true);
  assert.equal(clsWorse(0.5, 0.54), false, '10 % tolérés sur une valeur élevée');
  assert.equal(clsWorse(null, 0.3), false);
  assert.equal(medianFloat([0.1, 0.02, 0.05]), 0.05);
  assert.equal(medianFloat([0.1, 0.02]), 0.06);
  assert.equal(assetsPathFor('https://ex.fr/wp-content/cache/page-compiler/assets', 'https://ex.fr/page/'), '/wp-content/cache/page-compiler/assets/');
  assert.equal(assetsPathFor('https://autre.fr/x/', 'https://ex.fr/'), null, 'autre domaine refusé');
});

test('image LCP avec tailles adaptées : préchargée par son srcset, pas en double', async () => {
  const { optimize } = await import('../../src/optimizer/index.js');
  const html = '<html><head></head><body><img class="size-full wp-image-12" src="https://ex.fr/u/hero.jpg"></body></html>';
  const media = new Map([['12', [{ url: 'https://ex.fr/u/hero.jpg', width: 2560, height: 1440 }, { url: 'https://ex.fr/u/hero-768x432.jpg', width: 768, height: 432 }]]]);
  const imageInfo = new Map([['https://ex.fr/u/hero.jpg', { natural: [2560, 1440], display: { mobile: [412, 232], desktop: [1440, 810] } }]]);
  const ctx = {
    url: 'https://ex.fr/', config: {}, media, imageInfo, rules: { allowRules: [], neverDelay: [], thirdParty: { hosts: [], paths: [], inlineSignatures: [] }, conditionalAssets: [] },
    reference: { mobile: { lcp: { url: 'https://ex.fr/u/hero.jpg', isImg: true, selector: 'img' } }, desktop: { lcp: null }, animatedIds: [] },
  };
  const { html: out } = await optimize(html, ctx, ['responsive', 'images']);
  const $ = (await import('cheerio')).load(out);
  const preload = $('link[rel=preload][as=image]');
  assert.equal(preload.length, 1);
  assert.match(preload.attr('imagesrcset') || '', /hero-768x432\.jpg 768w/);
  assert.equal(preload.attr('imagesizes'), '(max-width: 767px) 100vw, 1440px');
});

test('préchargement de l\'image LCP placé après la balise viewport', async () => {
  const { applyImages } = await import('../../src/optimizer/families/images.js');
  const $ = (await import('cheerio')).load('<html><head><meta charset="utf-8"><title>t</title><meta name="viewport" content="width=device-width"></head><body><img src="https://ex.fr/a.jpg" srcset="https://ex.fr/a.jpg 2000w, https://ex.fr/a-768.jpg 768w" sizes="100vw"></body></html>');
  applyImages($, { url: 'https://ex.fr/', rules: { allowRules: [] }, reference: { mobile: { lcp: { url: 'https://ex.fr/a.jpg', isImg: true, selector: 'img' } }, desktop: { lcp: null } } });
  const order = $('head').children().toArray().map((el) => el.attribs?.name || el.attribs?.rel || el.tagName);
  assert.ok(order.indexOf('preload') > order.indexOf('viewport'), order.join(','));
});
