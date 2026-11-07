import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rankSuspects, changedFamilies } from '../../src/pipeline/compile.js';
import { SUSPECTS, effectiveThreshold } from '../../src/verify/index.js';
import { compareSeo } from '../../src/verify/seo.js';
import { loadSites, enabledFamilies, siteForUrl, ALL_FAMILIES } from '../../src/config.js';
import { median } from '../../src/pipeline/render.js';

test('suspects : seules les familles qui ont modifié la page sont retenues', () => {
  const failures = [{ type: 'visual_viewport_only', suspects: SUSPECTS.visual_viewport_only }];
  const active = ALL_FAMILIES;
  const changed = changedFamilies({ images: ['x'], animations: [], fonts: [], scripts: ['y'], navigation: ['z'], css: ['w'] });
  assert.deepEqual(rankSuspects(failures, active, changed), ['scripts', 'images', 'css']);
});

test('suspects : à défaut de famille modifiée, toutes les suspectes actives', () => {
  const failures = [{ type: 'console', suspects: SUSPECTS.console }];
  assert.deepEqual(rankSuspects(failures, ['css', 'images'], []), ['css', 'images']);
});

test('seuil : jamais en dessous du bruit mesuré', () => {
  assert.equal(effectiveThreshold(0.005, 0), 0.005);
  assert.ok(effectiveThreshold(0.005, 0.02) > 0.03);
});

test('SEO : parité détectée et écarts listés', () => {
  const a = '<html><head><title>A</title><link rel="canonical" href="https://x.fr/"></head><body><h1>T</h1></body></html>';
  const b = '<html><head><title>A</title><link rel="canonical" href="https://x.fr/autre/"></head><body><h1>T</h1></body></html>';
  assert.deepEqual(compareSeo(a, a), []);
  assert.deepEqual(compareSeo(a, b).map((d) => d.field), ['canonical']);
});

test('sites : secrets lus depuis l’environnement, exceptions de familles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-'));
  const file = path.join(dir, 'sites.yml');
  fs.writeFileSync(file, `sites:
  - id: site-27
    domains: [www.exemple.fr]
    secret_env: SECRET_SITE_27
    callback_url: https://www.exemple.fr/wp-json/compilateur/v1/recevoir
    families: { navigation: false }
`);
  const sites = loadSites(file, { SECRET_SITE_27: 'abc' });
  const site = sites.get('site-27');
  assert.equal(site.secret, 'abc');
  assert.equal(siteForUrl(sites, 'https://www.exemple.fr/page/').id, 'site-27');
  assert.ok(!enabledFamilies(site).includes('navigation'));
  assert.deepEqual(enabledFamilies(site, ['css', 'images']), ['images', 'css']);
});

test('médiane', () => {
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([100, null, 300]), 200);
  assert.equal(median([]), null);
});
