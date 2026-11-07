import { chromium, devices } from 'playwright-core';

export const VIEWPORTS = {
  mobile: { ...devices['Pixel 7'] },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

// Une capture vaut 1 sur les écrans haute densité : les comparaisons restent légères.
VIEWPORTS.mobile.deviceScaleFactor = 1;

export async function launchBrowser(config) {
  return chromium.launch({
    executablePath: config.chromiumPath,
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', ...(config.chromiumExtraArgs || [])],
  });
}

/**
 * Script injecté avant le chargement : observe le LCP et note l'élément concerné.
 * Le LCP n'est plus mis à jour après la première interaction : on le lit avant tout défilement.
 */
export const OBSERVER_SCRIPT = `(() => {
  const cssPath = (el) => {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      let part = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(part + '#' + CSS.escape(el.id)); break; }
      const cls = Array.from(el.classList).filter((c) => !/^(elementor-invisible|animated|e-lazyloaded)$/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(' > ');
  };
  window.__cw = { lcp: null };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const el = e.element;
        const holder = el && el.closest ? el.closest('[data-id]') : null;
        window.__cw.lcp = {
          time: Math.round(e.startTime),
          url: e.url || null,
          tag: el ? el.tagName.toLowerCase() : null,
          isImg: !!el && el.tagName === 'IMG',
          selector: el ? cssPath(el) : null,
          dataId: holder ? holder.getAttribute('data-id') : null,
        };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
})();`;
