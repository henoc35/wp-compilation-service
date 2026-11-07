import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import { Worker, DelayedError } from 'bullmq';
import { loadConfig, loadSites } from '../config.js';
import { redisConnection } from '../queue.js';
import { loadRules } from '../rules/index.js';
import { runCompilation } from '../pipeline/compile.js';
import { artifactStore, purgeArtifacts } from '../artifacts.js';
import { publishResult } from '../publish.js';
import { createSiteLock } from '../site-lock.js';

const log = pino({ name: 'worker' });

/** Première ligne d'un message d'erreur, lisible dans WordPress. */
export function errorReason(err) {
  const first = String(err?.message || err || 'erreur inconnue').split('\n')[0].trim();
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(first)) return `Site injoignable depuis le service (connexion refusée) : ${first}`;
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(first)) return `Domaine introuvable depuis le service : ${first}`;
  if (/Timeout|ERR_TIMED_OUT/i.test(first)) return `Le site a mis trop de temps à répondre : ${first}`;
  return `Erreur du service : ${first}`;
}

export function createWorker({ config, sites, rules, logger = log }) {
  const jobsDir = path.join(config.dataDir, 'jobs');
  const siteLock = createSiteLock(config.redisUrl);

  const worker = new Worker(config.queueName, async (job, token) => {
    const site = sites.get(job.data.siteId);
    if (!site) throw new Error(`site inconnu : ${job.data.siteId}`);

    // Une seule compilation à la fois par site : sinon la tâche repasse en attente.
    if (!(await siteLock.acquire(site.id, job.id))) {
      const delay = config.siteRetryDelayMs + Math.floor(Math.random() * 1000);
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }

    logger.info({ jobId: job.id, siteId: site.id, url: job.data.url }, 'compilation démarrée');
    try {
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
    } catch (err) {
      // Compilation plantée : le site est prévenu tout de suite, avec le motif.
      const reason = errorReason(err);
      const published = await publishResult(site, {
        jobId: job.id,
        siteId: site.id,
        url: job.data.url,
        lang: job.data.lang || null,
        status: 'failed',
        reason,
        html: null,
        familiesApplied: [],
        familiesDisabled: [],
        attempts: [],
        lcp: null,
        compiledAt: new Date().toISOString(),
      }, { timeoutMs: config.callbackTimeoutMs, retries: 2 }).catch(() => null);
      logger.error({ jobId: job.id, siteId: site.id, url: job.data.url, reason, published: published?.published ?? false }, 'compilation en erreur');
      err.reported = true;
      throw err;
    } finally {
      await siteLock.release(site.id, job.id).catch(() => {});
    }
  }, {
    connection: redisConnection(config.redisUrl),
    // Plafond local ; la file applique en plus un plafond global (setGlobalConcurrency).
    concurrency: config.chromiumConcurrency,
    lockDuration: 10 * 60 * 1000,
  });

  worker.on('completed', (job, res) => logger.info({ jobId: job.id, url: job.data.url, status: res?.status }, 'compilation terminée'));
  worker.on('failed', (job, err) => {
    if (!err?.reported) logger.error({ jobId: job?.id, err: err?.message }, 'compilation en erreur');
  });
  const close = worker.close.bind(worker);
  worker.close = async (...args) => {
    await close(...args);
    await siteLock.close();
  };
  return worker;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig();
  const sites = loadSites(config.sitesFile);
  const rules = loadRules(config.rulesDir);
  // Filet de sécurité : une erreur asynchrone imprévue est journalisée sans arrêter
  // le worker (les compilations des autres sites continuent).
  process.on('unhandledRejection', (err) => log.error({ err: String(err?.message || err).split('\n')[0] }, 'erreur asynchrone non gérée'));
  const worker = createWorker({ config, sites, rules });
  log.info({ concurrency: config.chromiumConcurrency, perSite: 1, sites: sites.size, rules: rules.addons.length }, 'worker démarré');
  for (const site of sites.values()) {
    if (!site.secret) log.warn({ siteId: site.id }, 'secret absent : les résultats de ce site ne pourront pas être envoyés');
  }

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
