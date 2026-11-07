import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { Worker } from 'bullmq';
import { loadConfig, loadSites } from '../config.js';
import { redisConnection } from '../queue.js';
import { loadRules } from '../rules/index.js';
import { runCompilation } from '../pipeline/compile.js';
import { artifactStore, purgeArtifacts } from '../artifacts.js';

const log = pino({ name: 'worker' });

export function createWorker({ config, sites, rules, logger = log }) {
  const jobsDir = path.join(config.dataDir, 'jobs');
  const worker = new Worker(config.queueName, async (job) => {
    const site = sites.get(job.data.siteId);
    if (!site) throw new Error(`site inconnu : ${job.data.siteId}`);
    const store = artifactStore(path.join(jobsDir, String(job.id)));
    const result = await runCompilation({
      job: { ...job.data, jobId: job.id },
      site,
      config,
      rules,
      store,
      log: logger,
      progress: (p) => job.updateProgress(p),
    });
    const { html, ...summary } = result;
    return summary;
  }, {
    connection: redisConnection(config.redisUrl),
    // Plafond local ; la file applique en plus un plafond global (setGlobalConcurrency).
    concurrency: config.chromiumConcurrency,
    lockDuration: 10 * 60 * 1000,
  });

  worker.on('completed', (job, res) => logger.info({ jobId: job.id, url: job.data.url, status: res?.status }, 'compilation terminée'));
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err?.message }, 'compilation en erreur'));
  return worker;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig();
  const sites = loadSites(config.sitesFile);
  const rules = loadRules(config.rulesDir);
  const worker = createWorker({ config, sites, rules });
  log.info({ concurrency: config.chromiumConcurrency, sites: sites.size, rules: rules.addons.length }, 'worker démarré');

  const purge = async () => {
    const n = await purgeArtifacts(path.join(config.dataDir, 'jobs'), config.artifactsRetentionDays);
    if (n) log.info({ removed: n }, 'artifacts anciens supprimés');
  };
  purge();
  const timer = setInterval(purge, 24 * 3600 * 1000);

  const shutdown = async () => {
    clearInterval(timer);
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
