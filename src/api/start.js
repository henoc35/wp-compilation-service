import { loadConfig, loadSites } from '../config.js';
import { createQueue } from '../queue.js';
import { buildServer } from './server.js';
import { openDatabase } from '../store/db.js';
import { createRepo } from '../store/repo.js';
import { createBox } from '../store/security.js';
import { createSiteRegistry } from '../store/registry.js';
import { createPageSpeedRunner } from '../pagespeed.js';

const config = loadConfig();
const yamlSites = loadSites(config.sitesFile);
const queue = await createQueue(config);

let pool = null;
let repo = null;
if (config.databaseUrl) {
  pool = await openDatabase(config.databaseUrl);
  repo = createRepo(pool, createBox(config.masterKey));
}
const sites = createSiteRegistry({ repo, yamlSites });
// Journal de l'API, créé juste après : les analyses PageSpeed ne démarrent qu'une fois l'API lancée.
const logProxy = { warn: (...args) => app.log.warn(...args) };
const pagespeed = repo ? createPageSpeedRunner({ repo, config, log: logProxy }) : null;
const app = buildServer({ config, sites, queue, repo, pagespeed });

if (repo) {
  // Premier compte administrateur, à partir des variables ADMIN_EMAIL et ADMIN_PASSWORD.
  if ((await repo.users.count()) === 0) {
    if (config.adminEmail && config.adminPassword) {
      await repo.users.create({ email: config.adminEmail, password: config.adminPassword, role: 'admin' });
      app.log.info({ email: config.adminEmail }, 'compte administrateur créé');
    } else {
      app.log.warn('aucun compte : définir ADMIN_EMAIL et ADMIN_PASSWORD pour créer le premier administrateur');
    }
  }
  await repo.pagespeed.abandonStale();
} else {
  app.log.warn('DATABASE_URL absente : interface d\'administration désactivée, sites de SITES_YAML uniquement');
}

for (const site of (await sites.all()).values()) {
  if (!site.secret) app.log.warn({ siteId: site.id }, 'secret absent : les demandes de ce site seront refusées');
}

const shutdown = async () => {
  await app.close();
  await queue.close();
  await pool?.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info({ sites: (await sites.all()).size, concurrency: config.chromiumConcurrency, admin: Boolean(repo) }, 'API du service de compilation démarrée');
