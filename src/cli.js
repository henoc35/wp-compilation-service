#!/usr/bin/env node
/**
 * Compilation d'une page en ligne de commande, sans file d'attente ni publication.
 * Idéal pour la phase 0 : tester le pipeline sur les sites pilotes.
 *
 *   node src/cli.js --url https://www.exemple.fr/ [--out ./sortie] [--families images,animations]
 *                   [--no-measure] [--no-noise] [--publish]
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, loadSites, siteForUrl, ALL_FAMILIES } from './config.js';
import { loadRules } from './rules/index.js';
import { runCompilation } from './pipeline/compile.js';
import { artifactStore } from './artifacts.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    out: { type: 'string' },
    families: { type: 'string' },
    'no-measure': { type: 'boolean', default: false },
    'no-noise': { type: 'boolean', default: false },
    publish: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || !values.url) {
  console.log(`Usage : node src/cli.js --url <URL> [--out <dossier>] [--families ${ALL_FAMILIES.join(',')}]
                     [--no-measure] [--no-noise] [--publish]`);
  process.exit(values.help ? 0 : 1);
}

const config = loadConfig();
if (values['no-measure']) config.measureRuns = 0;
if (values['no-noise']) config.noiseCheck = false;
const sites = loadSites(config.sitesFile);
const site = siteForUrl(sites, values.url);
const rules = loadRules(config.rulesDir);
const families = values.families ? values.families.split(',').map((s) => s.trim()) : null;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(values.out || path.join('sortie', `${new URL(values.url).hostname}-${stamp}`));

const result = await runCompilation({
  job: { url: values.url, families },
  site,
  config,
  rules,
  store: artifactStore(out),
  publish: values.publish,
  progress: async (p) => console.log(`… ${p.step}${p.attempt ? ` (tentative ${p.attempt} : ${p.families.join(', ')})` : ''}`),
  log: { info: () => {} },
});

if (result.html) await artifactStore(out).save('compiled.html', result.html);

console.log('\nRésultat :', result.status);
if (result.reason) console.log('Raison :', result.reason);
console.log('Familles appliquées :', result.familiesApplied.join(', ') || '—');
if (result.familiesDisabled.length) console.log('Familles désactivées :', result.familiesDisabled.join(', '));
if (result.lcp) console.log(`LCP bridé (médiane) : ${result.lcp.reference ?? '?'} ms → ${result.lcp.candidate ?? '?'} ms`);
for (const a of result.attempts) {
  console.log(`Tentative ${a.attempt} : ${a.ok ? 'réussie' : 'échec'}${a.failures.length ? ` — ${a.failures.map((f) => `${f.type}${f.viewport ? `/${f.viewport}` : ''} (${f.detail})`).join(' ; ')}` : ''}`);
}
console.log('Artefacts :', out);
process.exit(result.status === 'compiled' || result.status === 'compiled_partial' ? 0 : 2);
