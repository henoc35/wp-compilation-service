import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

function readYaml(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8')) || {};
}

/** Charge la base de règles : fiches par addon, scripts tiers, zones masquées. */
export function loadRules(dir) {
  const addonsDir = path.join(dir, 'addons');
  const addons = fs.existsSync(addonsDir)
    ? fs.readdirSync(addonsDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
      .map((f) => ({ file: f, ...readYaml(path.join(addonsDir, f)) }))
    : [];
  const thirdPartyFile = path.join(dir, 'third-party.yml');
  const masksFile = path.join(dir, 'masks.yml');
  const thirdParty = fs.existsSync(thirdPartyFile) ? readYaml(thirdPartyFile) : {};
  const masks = fs.existsSync(masksFile) ? readYaml(masksFile).masks || [] : [];
  return {
    addons,
    thirdParty: {
      hosts: thirdParty.hosts || [],
      paths: thirdParty.paths || [],
      inlineSignatures: thirdParty.inline_signatures || [],
    },
    masks,
  };
}

/** "/motif/" → RegExp ; toute autre chaîne reste un sélecteur littéral. */
export function toAllowRule(value) {
  const s = String(value);
  const m = s.match(/^\/(.+)\/([gimsuy]*)$/);
  return m ? new RegExp(m[1], m[2]) : s;
}

/**
 * Règles applicables à une page : celles des addons détectés dans son HTML,
 * complétées par les exceptions du site.
 */
export function resolveRules(rules, html, site) {
  const detected = rules.addons.filter((a) => (a.detect || []).some((needle) => html.includes(needle)));
  const protectedSelectors = [
    ...detected.flatMap((a) => a.protected_selectors || []),
    ...(site?.protectedSelectors || []),
  ];
  return {
    addonsDetected: detected.map((a) => a.name),
    allowRules: protectedSelectors.map(toAllowRule),
    neverDelay: [...detected.flatMap((a) => a.never_delay || []), ...(site?.neverDelay || [])],
    masks: [...rules.masks, ...detected.flatMap((a) => a.masks || []), ...(site?.masks || [])],
    thirdParty: {
      hosts: [...rules.thirdParty.hosts, ...(site?.thirdPartyExtra || []).filter((x) => !x.startsWith('/'))],
      paths: [...rules.thirdParty.paths, ...(site?.thirdPartyExtra || []).filter((x) => x.startsWith('/'))],
      inlineSignatures: rules.thirdParty.inlineSignatures,
    },
    navigationExclude: site?.navigationExclude || [],
  };
}
