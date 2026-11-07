import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { launchBrowser } from '../../src/pipeline/browser.js';
import { measureLcp, capture } from '../../src/pipeline/render.js';

const CHROMIUM = process.env.CHROMIUM_PATH || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
const skip = !CHROMIUM ? 'Chromium absent' : false;

// Port libéré juste avant : la connexion est refusée, comme un site qui bannit l'IP du service.
async function refusedUrl() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return `http://127.0.0.1:${port}/page/`;
}

test('site injoignable pendant la mesure du LCP : null, sans planter le processus', { skip, timeout: 120000 }, async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const REFUSED = await refusedUrl();
  const browser = await launchBrowser({ chromiumPath: CHROMIUM, chromiumExtraArgs: (process.env.CHROMIUM_EXTRA_ARGS || '').split(' ').filter(Boolean) });
  try {
    assert.equal(await measureLcp(browser, { url: REFUSED, timeoutMs: 10000 }), null);
    await assert.rejects(capture(browser, { url: REFUSED, viewportName: 'mobile', timeoutMs: 10000 }), /ERR_CONNECTION_REFUSED/);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(unhandled, [], 'aucune erreur asynchrone non gérée');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await browser.close();
  }
});
