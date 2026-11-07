import { loadConfig, loadSites } from '../config.js';
import { createQueue } from '../queue.js';
import { buildServer } from './server.js';

const config = loadConfig();
const sites = loadSites(config.sitesFile);
const queue = await createQueue(config);
const app = buildServer({ config, sites, queue });

for (const site of sites.values()) {
  if (!site.secret) app.log.warn({ siteId: site.id }, 'secret absent : les demandes de ce site seront refusées');
}

const shutdown = async () => {
  await app.close();
  await queue.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info({ sites: sites.size, concurrency: config.chromiumConcurrency }, 'API du service de compilation démarrée');
