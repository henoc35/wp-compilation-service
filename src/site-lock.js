import { Redis } from 'ioredis';
import { redisConnection } from './queue.js';

/**
 * Verrou par site : une seule compilation à la fois sur un même site, pour ne pas
 * surcharger son serveur (et ne pas déclencher son pare-feu). Le verrou expire de
 * lui-même si un worker s'arrête brutalement.
 */

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

export function createSiteLock(redisUrl, { ttlMs = 20 * 60 * 1000, prefix = 'page-compiler:site-lock:' } = {}) {
  const redis = new Redis(redisConnection(redisUrl));
  return {
    /** Tente de prendre le verrou du site ; retourne true si obtenu. */
    async acquire(siteId, owner) {
      const ok = await redis.set(prefix + siteId, String(owner), 'PX', ttlMs, 'NX');
      return ok === 'OK';
    },
    /** Libère le verrou s'il appartient toujours à ce propriétaire. */
    async release(siteId, owner) {
      await redis.eval(RELEASE, 1, prefix + siteId, String(owner));
    },
    async holder(siteId) {
      return redis.get(prefix + siteId);
    },
    async close() {
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
