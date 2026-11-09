import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHistory, rating, queryCruxHistory } from '../../src/crux.js';
import { parseBeacon, rumScript } from '../../src/rum.js';

const HISTORY = {
  record: {
    key: { origin: 'https://ex.fr', formFactor: 'PHONE' },
    metrics: {
      largest_contentful_paint: { percentilesTimeseries: { p75s: [3100, null, 2600] } },
      cumulative_layout_shift: { percentilesTimeseries: { p75s: ['0.15', '0.12', '0.08'] } },
    },
    collectionPeriods: [
      { firstDate: { year: 2026, month: 9, day: 1 }, lastDate: { year: 2026, month: 9, day: 28 } },
      { firstDate: { year: 2026, month: 9, day: 8 }, lastDate: { year: 2026, month: 10, day: 5 } },
      { firstDate: { year: 2026, month: 9, day: 15 }, lastDate: { year: 2026, month: 10, day: 12 } },
    ],
  },
};

test('CrUX : séries p75 (null conservé, CLS en chaîne converti), périodes, appréciation', async () => {
  const h = parseHistory(HISTORY);
  assert.deepEqual(h.metrics.lcp, [3100, null, 2600]);
  assert.deepEqual(h.metrics.cls, [0.15, 0.12, 0.08]);
  assert.equal(h.periods.at(-1).last, '2026-10-12');
  assert.equal(rating('lcp', 2600), 'average');
  assert.equal(rating('cls', 0.08), 'good');
  assert.equal(rating('inp', 600), 'poor');
  let sent;
  const r = await queryCruxHistory({ origin: 'https://ex.fr', formFactor: 'PHONE', apiKey: 'K', endpoint: 'https://x/q', fetchImpl: async (url, opts) => { sent = { url, body: JSON.parse(opts.body) }; return { ok: true, status: 200, json: async () => HISTORY }; } });
  assert.equal(sent.url, 'https://x/q?key=K');
  assert.equal(sent.body.formFactor, 'PHONE');
  assert.ok(sent.body.metrics.includes('interaction_to_next_paint'));
  assert.deepEqual(r.metrics.lcp, [3100, null, 2600]);
  const none = await queryCruxHistory({ origin: 'https://petit.fr', formFactor: 'PHONE', apiKey: 'K', fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'chrome ux report data not found' } }) }) });
  assert.equal(none.noData, true);
});

test('mesure des visiteurs : script et validation des mesures reçues', () => {
  const s = rumScript('https://compiler.ex.fr/v1/rum/site-01');
  assert.match(s, /sendBeacon\("https:\/\/compiler\.ex\.fr\/v1\/rum\/site-01"/);
  assert.match(s, /data-pc-rum/);
  assert.doesNotMatch(s, /cookie/i);
  assert.deepEqual(parseBeacon('{"p":"/contact/","d":"mobile","lcp":2100,"cls":0.04,"inp":120,"ttfb":300,"pr":true}'),
    { path: '/contact/', device: 'mobile', lcp: 2100, cls: 0.04, inp: 120, ttfb: 300, prerendered: true });
  assert.equal(parseBeacon('pas du json'), null);
  assert.equal(parseBeacon('{"p":"https://autre.fr/","d":"mobile","lcp":1}'), null, 'chemin seulement');
  assert.equal(parseBeacon('{"p":"/","d":"tv","lcp":1}'), null);
  assert.equal(parseBeacon('{"p":"/","d":"desktop","lcp":-5,"cls":99}'), null, 'valeurs hors limites ignorées');
});
