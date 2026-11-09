/**
 * Registre des sites : ceux enregistrés dans l'interface (base de données) et ceux
 * déclarés dans SITES_YAML, conservé pour la transition. À identifiant égal, la
 * base l'emporte : un site importé depuis SITES_YAML se gère ensuite dans l'interface.
 */
export function createSiteRegistry({ repo = null, yamlSites = new Map() } = {}) {
  return {
    yamlSites,
    /** Site avec son secret, lu à chaque appel : une rotation de clé s'applique aussitôt. */
    async resolve(id) {
      if (!id) return null;
      if (repo) {
        const site = await repo.sites.get(String(id), true);
        if (site) return site.status === 'paused' ? { ...site, paused: true } : site;
      }
      const y = yamlSites.get(String(id));
      return y ? { ...y, name: y.name || y.id, source: 'yaml' } : null;
    },
    async all() {
      const out = new Map();
      for (const [id, s] of yamlSites) out.set(id, { ...s, name: s.name || id, source: 'yaml' });
      if (repo) for (const s of await repo.sites.listWithSecrets()) out.set(s.id, s);
      return out;
    },
  };
}
