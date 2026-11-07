import http from 'node:http';
import { PNG } from 'pngjs';

/**
 * Faux site WordPress/Elementor pour les tests de bout en bout.
 * Le site est servi sur localhost, le « script tiers » sur 127.0.0.1 (autre origine).
 */

function solidPng(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    const x = (i / 4) % width;
    png.data[i] = (r + x) % 256;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const CSS = `body{margin:0;font-family:Arial,sans-serif}
.hero{height:420px;background-image:url(../../../../../img/hero.png);background-size:cover;display:flex;align-items:center;justify-content:center}
.hero h1{color:#fff;font-size:40px;margin:0}
.elementor-invisible{visibility:hidden}
.animated{animation:cwfade .6s both}
@keyframes cwfade{from{opacity:0}to{opacity:1}}
.elementor-menu-toggle{padding:10px;border:1px solid #333;display:inline-block;cursor:pointer;margin:10px}
.elementor-nav-menu--dropdown{display:none}
.elementor-menu-toggle.elementor-active+.elementor-nav-menu--dropdown{display:block}
.content{padding:20px}
.photo{width:100%;height:300px;display:block}
.banner{background:#c00;color:#fff;padding:30px;font-size:24px}
.never-used{color:red}`;

const FRONTEND_JS = `document.querySelectorAll('.elementor-menu-toggle').forEach(function(t){t.addEventListener('click',function(){t.classList.toggle('elementor-active')})});
window.addEventListener('load',function(){setTimeout(function(){document.querySelectorAll('.elementor-invisible').forEach(function(el){el.classList.remove('elementor-invisible');el.classList.add('animated')})},300)});`;

function page({ title, trackerUrl, script }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="Page de test du compilateur">
<link rel="canonical" href="https://www.exemple.fr/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Exemple"}</script>
<link rel="stylesheet" id="elementor-frontend-css" href="/wp-content/plugins/elementor/assets/css/frontend.css?ver=4.3.6" media="all">
</head>
<body class="elementor-page">
<header>
  <div class="elementor-menu-toggle" role="button">Menu</div>
  <nav class="elementor-nav-menu--dropdown"><a href="/a-propos/">À propos</a></nav>
</header>
<section class="hero elementor-element" data-id="hero1">
  <h1 class="elementor-element elementor-invisible" data-id="h1x" data-settings='{"_animation":"fadeInUp","_animation_delay":200}'>Bienvenue</h1>
</section>
<div class="content">
  <p>Contenu de la page.</p>
  ${'<p>Paragraphe de remplissage pour allonger la page.</p>'.repeat(12)}
  <img class="photo" src="/img/photo.png" alt="Photo">
</div>
<script src="/wp-content/plugins/elementor/assets/js/frontend.js?ver=4.3.6" id="elementor-frontend-js"></script>
<script src="${trackerUrl}/${script}" id="tracker-js"></script>
</body>
</html>`;
}

export async function startFixtureSite() {
  const hero = solidPng(800, 420, [30, 80, 140]);
  const photo = solidPng(600, 300, [200, 160, 40]);

  const tracker = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    if (req.url.startsWith('/banner.js')) {
      res.end("document.body.insertAdjacentHTML('afterbegin','<div class=\"banner\">Bandeau injecté par un script tiers</div>');");
    } else {
      res.end('window.__tracker = true;');
    }
  });
  await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
  const trackerUrl = `http://127.0.0.1:${tracker.address().port}`;

  const requests = [];
  const site = http.createServer((req, res) => {
    requests.push({ url: req.url, bypass: req.headers['x-page-compiler-bypass'] || null });
    const path = req.url.split('?')[0];
    if (path === '/' || path === '/broken/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page({
        title: path === '/' ? 'Accueil' : 'Page cassée par l’optimisation',
        trackerUrl,
        script: path === '/' ? 'tracker.js' : 'banner.js',
      }));
    } else if (path === '/unstable/') {
      // Contenu différent à chaque chargement (comme un agenda ou un flux) : hauteur variable.
      const n = 2 + Math.floor(Math.random() * 30);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page({ title: 'Page instable', trackerUrl, script: 'tracker.js' }).replace('<p>Contenu de la page.</p>', '<p>Contenu de la page.</p>' + '<p>Ligne variable</p>'.repeat(n)));
    } else if (path.endsWith('frontend.css')) {
      res.setHeader('Content-Type', 'text/css');
      res.end(CSS);
    } else if (path.endsWith('frontend.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(FRONTEND_JS);
    } else if (path === '/img/hero.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(hero);
    } else if (path === '/img/photo.png') {
      res.setHeader('Content-Type', 'image/png');
      res.end(photo);
    } else {
      res.statusCode = 404;
      res.end('not_found');
    }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${site.address().port}`;

  return {
    url,
    trackerUrl,
    trackerHost: '127.0.0.1',
    requests,
    close: async () => {
      await new Promise((r) => site.close(r));
      await new Promise((r) => tracker.close(r));
    },
  };
}
