import { collectImages } from './diagnostics.js';
import { VIEWPORTS, OBSERVER_SCRIPT } from './browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sameDocument(a, b) {
  const strip = (u) => {
    const x = new URL(u);
    x.hash = '';
    return x.toString().replace(/\/$/, '');
  };
  try {
    return strip(a) === strip(b);
  } catch {
    return false;
  }
}

/**
 * Sert la version candidate à l'adresse réelle de la page : seul le document est
 * remplacé, toutes les autres ressources viennent du site en ligne.
 */
async function routeCandidate(context, url, html) {
  await context.route((u) => sameDocument(u.toString(), url), async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue().catch(() => {});
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }).catch(() => {});
  });
}

/**
 * Rendu de l'original : la requête du document porte l'en-tête X-Page-Compiler-Bypass,
 * pour que le plugin serve la page WordPress et non une version déjà compilée.
 * L'en-tête n'est ajouté qu'au document (jamais aux ressources tierces).
 */
async function routeBypass(context, url) {
  await context.route((u) => sameDocument(u.toString(), url), async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue().catch(() => {});
    return route.continue({ headers: { ...route.request().headers(), 'x-page-compiler-bypass': '1' } }).catch(() => {});
  });
}

/** Récupère le document d'origine (avec contournement du cache) et le sert par interception. */
async function routeOriginalDocument(context, url) {
  await context.route((u) => sameDocument(u.toString(), url), async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue().catch(() => {});
    // Une erreur ici (site injoignable) ne doit jamais remonter hors du gestionnaire :
    // elle ferait planter tout le worker. La navigation échoue alors normalement.
    try {
      const response = await route.fetch({ headers: { ...route.request().headers(), 'x-page-compiler-bypass': '1' } });
      await route.fulfill({ response });
    } catch {
      await route.abort('connectionrefused').catch(() => {});
    }
  });
}

/** Met en pause les sliders et attend les polices : deux captures doivent être comparables. */
async function stabilise(page) {
  await page.evaluate(async () => {
    document.querySelectorAll('.swiper, .swiper-container').forEach((el) => {
      const s = el.swiper;
      if (s) {
        try {
          s.autoplay && s.autoplay.stop();
          s.slideTo(0, 0);
        } catch (e) { /* slider non standard */ }
      }
    });
    if (window.jQuery && window.jQuery.fn && window.jQuery.fn.slick) {
      try { window.jQuery('.slick-initialized').slick('slickPause').slick('slickGoTo', 0, true); } catch (e) { /* ignoré */ }
    }
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  }).catch(() => {});
  await sleep(400);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    const limit = Math.min(document.documentElement.scrollHeight, 30000);
    for (let y = 0; y < limit; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await sleep(800);
}

function collectAnimatedInViewport() {
  const re = /"_?animation(?:_mobile|_tablet)?"\s*:\s*"(?!none")[^"]+"/;
  return Array.from(document.querySelectorAll('[data-settings][data-id]'))
    .filter((el) => re.test(el.getAttribute('data-settings') || ''))
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    })
    .map((el) => el.getAttribute('data-id'));
}

async function testMenu(page) {
  const toggle = page.locator('.elementor-menu-toggle:visible, .jet-mobile-menu__toggle:visible').first();
  if (!(await toggle.count())) return { present: false };
  try {
    await toggle.click({ timeout: 3000 });
    await sleep(700);
    const works = await page.evaluate(() => {
      const visible = (el) => !!el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
      const dd = Array.from(document.querySelectorAll('.elementor-nav-menu--dropdown, .jet-mobile-menu__container'));
      return dd.some(visible) || !!document.querySelector('.elementor-menu-toggle.elementor-active');
    });
    return { present: true, works };
  } catch (e) {
    return { present: true, works: false, error: String(e.message || e).slice(0, 200) };
  }
}

async function testSlider(page) {
  const next = page.locator('.swiper-button-next:visible, .elementor-swiper-button-next:visible, .slick-next:visible').first();
  if (!(await next.count())) return { present: false };
  const active = () => page.evaluate(() => {
    const el = document.querySelector('.swiper-slide-active, .slick-current');
    return el ? (el.getAttribute('data-swiper-slide-index') || el.getAttribute('data-slick-index') || el.textContent.trim().slice(0, 80)) : null;
  });
  try {
    const before = await active();
    await next.click({ timeout: 3000 });
    await sleep(900);
    const after = await active();
    return { present: true, works: before !== after };
  } catch (e) {
    return { present: true, works: false, error: String(e.message || e).slice(0, 200) };
  }
}

/**
 * Rend une page (version d'origine, ou candidate si `candidateHtml` est fourni)
 * et rapporte captures, LCP, erreurs et résultat des interactions.
 */
/**
 * Relève les ressources chargées par la page (poids transféré, type), pour
 * l'historique : poids par image, CSS, JS et poids total de la page.
 */
export function trackResources(page) {
  const pending = [];
  let markAt = null;
  page.on('requestfinished', (request) => {
    const at = Date.now();
    pending.push((async () => {
      const response = await request.response().catch(() => null);
      const sizes = await request.sizes().catch(() => null);
      return {
        url: request.url().slice(0, 500),
        type: request.resourceType(),
        status: response ? response.status() : 0,
        bytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0,
        body: sizes ? sizes.responseBodySize : 0,
        mime: response ? String(response.headers()['content-type'] || '').split(';')[0] : '',
        at,
      };
    })().catch(() => null));
  });
  return {
    /** Fin du chargement initial : les ressources suivantes viennent du défilement. */
    mark: () => { markAt = Date.now(); },
    done: async () => (await Promise.all(pending))
      .filter((r) => r && !r.url.startsWith('data:'))
      .map(({ at, ...r }) => ({ ...r, initial: markAt == null || at <= markAt })),
  };
}

/** Poids totaux par catégorie (octets transférés). */
export function summarizeResources(resources = []) {
  const cat = (r) => {
    if (r.type === 'document') return 'html';
    if (r.type === 'stylesheet') return 'css';
    if (r.type === 'script') return 'js';
    if (r.type === 'image' || /^image\//.test(r.mime)) return 'images';
    if (r.type === 'font' || /font/.test(r.mime)) return 'fonts';
    if (r.type === 'media') return 'media';
    return 'other';
  };
  const out = { total: 0, requests: 0, initial: 0, initialRequests: 0, html: 0, css: 0, js: 0, images: 0, fonts: 0, media: 0, other: 0 };
  for (const r of resources) {
    out[cat(r)] += r.bytes;
    out.total += r.bytes;
    out.requests += 1;
    if (r.initial) {
      out.initial += r.bytes;
      out.initialRequests += 1;
    }
  }
  return out;
}

export async function capture(browser, { url, viewportName, candidateHtml = null, masks = [], timeoutMs = 60000, collectReference = false, diagnose = false }) {
  const context = await browser.newContext({ ...VIEWPORTS[viewportName], ignoreHTTPSErrors: false });
  const errors = [];
  try {
    if (candidateHtml) await routeCandidate(context, url, candidateHtml);
    else await routeBypass(context, url);
    await context.addInitScript(OBSERVER_SCRIPT);
    const page = await context.newPage();
    const resources = trackResources(page);
    // Diagnostic (rendu de référence) : part utilisée de chaque CSS et JS.
    if (diagnose) {
      await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false });
      await page.coverage.startCSSCoverage({ resetOnNavigation: false });
    }
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // Ressource introuvable : l'adresse en cause aide à désigner la famille fautive.
      const where = /Failed to load resource/.test(m.text()) && m.location()?.url ? ` (${m.location().url.slice(0, 200)})` : '';
      errors.push(`${m.text().slice(0, 300)}${where}`);
    });
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e.message || e).slice(0, 300)}`));

    const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    const status = response ? response.status() : 0;
    const rawHtml = collectReference && response ? await response.text() : null;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await sleep(1200);

    const lcp = await page.evaluate(() => (window.__cw ? window.__cw.lcp : null));
    const animatedIds = collectReference ? await page.evaluate(collectAnimatedInViewport) : [];

    const maskLocators = masks.map((s) => page.locator(s));
    await stabilise(page);
    resources.mark();
    const viewport = await page.screenshot({ animations: 'disabled', caret: 'hide', mask: maskLocators });
    await autoScroll(page);
    await stabilise(page);
    const full = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', mask: maskLocators });

    const images = diagnose ? await page.evaluate(collectImages).catch(() => null) : null;
    // Cache avant/arrière : en-tête no-store ou gestionnaire unload le désactivent.
    let bfcache = null;
    if (diagnose && response) {
      const blockers = [];
      if (/no-store/i.test(response.headers()['cache-control'] || '')) blockers.push('en-tête Cache-Control: no-store sur la page');
      const unload = await page.evaluate(() => (window.__cw ? window.__cw.unload : 0) + (typeof window.onunload === 'function' ? 1 : 0)).catch(() => 0);
      if (unload) blockers.push(`${unload} gestionnaire(s) « unload » (script d'une extension ou d'un service tiers)`);
      bfcache = { eligible: blockers.length === 0, blockers };
    }
    const interactions = viewportName === 'mobile'
      ? { menu: await testMenu(page), slider: await testSlider(page) }
      : { slider: await testSlider(page) };
    // Couverture arrêtée après les interactions : le CSS et le JS du menu et du slider comptent comme utilisés.
    const coverage = diagnose ? {
      js: await page.coverage.stopJSCoverage().catch(() => []),
      css: await page.coverage.stopCSSCoverage().catch(() => []),
    } : null;

    return { status, finalUrl: page.url(), rawHtml, lcp, animatedIds, screenshots: { viewport, full }, interactions, errors, resources: await resources.done(), diagnostics: diagnose ? { images, coverage, bfcache } : null };
  } finally {
    await context.close();
  }
}

/**
 * Mesure le LCP en conditions bridées (mobile, CPU ×4, réseau 4G lente, cache vide),
 * proches de celles de PageSpeed. Retourne la valeur en ms, ou null.
 */
export async function measureLcp(browser, opts) {
  return (await measureVitals(browser, opts)).lcp;
}

/** LCP et CLS en conditions bridées (mêmes conditions que measureLcp). */
export async function measureVitals(browser, { url, candidateHtml = null, timeoutMs = 60000 }) {
  const context = await browser.newContext({ ...VIEWPORTS.mobile });
  try {
    // Les deux documents sont servis par interception (hors bridage réseau) :
    // seule la suite du chargement est bridée, à l'identique pour les deux.
    if (candidateHtml) await routeCandidate(context, url, candidateHtml);
    else await routeOriginalDocument(context, url);
    await context.addInitScript(OBSERVER_SCRIPT);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1638.4 * 1024) / 8,
      uploadThroughput: (675 * 1024) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs * 2 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await sleep(1000);
    return await page.evaluate(() => ({
      lcp: window.__cw && window.__cw.lcp ? window.__cw.lcp.time : null,
      cls: window.__cw && typeof window.__cw.cls === 'number' ? Math.round(window.__cw.cls * 10000) / 10000 : null,
    }));
  } catch {
    return { lcp: null, cls: null };
  } finally {
    await context.close();
  }
}

/** Médiane sans arrondi (CLS). */
export function medianFloat(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round(((v[m - 1] + v[m]) / 2) * 10000) / 10000;
}

export function median(values) {
  const v = values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}
