import crypto from 'node:crypto';
import { Queue } from 'bullmq';

/** Options de connexion Redis pour BullMQ à partir d'une URL redis://. */
export function redisConnection(redisUrl) {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/**
 * Crée la file et fixe la concurrence GLOBALE : quel que soit le nombre de
 * workers déployés, au plus `chromiumConcurrency` compilations tournent en même temps.
 */
export async function createQueue(config) {
  const queue = new Queue(config.queueName, {
    connection: redisConnection(config.redisUrl),
    defaultJobOptions: {
      attempts: 1, // les reprises sont gérées par le pipeline (isolation des échecs)
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
    },
  });
  await queue.setGlobalConcurrency(config.chromiumConcurrency);
  return queue;
}

/** Identifiant de regroupement : une même page d'un même site n'est compilée qu'une fois à la fois. */
export function dedupId(siteId, url, lang) {
  return crypto.createHash('sha1').update(`${siteId}|${url}|${lang || ''}`).digest('hex');
}

/**
 * Ajoute une demande. Les demandes répétées pour la même page pendant le délai
 * de regroupement sont fusionnées (le délai repart de zéro).
 */
export async function enqueueCompilation(queue, config, data) {
  const id = dedupId(data.siteId, data.url, data.lang);
  const job = await queue.add('compiler', data, {
    delay: config.debounceMs,
    deduplication: { id, keepLastIfActive: true, reschedule: true },
  });
  return job;
}
