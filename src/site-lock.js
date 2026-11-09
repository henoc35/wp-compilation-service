import { Redis } from 'ioredis';
import { redisConnection } from './queue.js';

/**
 * Verrou par site : une seule compilation à la fois sur un même site, pour ne pas
 * surcharger son serveur (et ne pas déclencher son pare-feu). Le verrou est court et
 * renouvelé pendant la compilation : si un worker s'arrête brutalement (redéploiement),
 * il expire en moins de 2 minutes au lieu de bloquer le site.
 */

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const EXTEND = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;

export function createSiteLock(redisUrl, { ttlMs = 90 * 1000, prefix = 'page-compiler:site-lock:' } = {}) {
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
    /** Prolonge le verrou s'il appartient toujours à ce propriétaire. */
    async extend(siteId, owner) {
      return (await redis.eval(EXTEND, 1, prefix + siteId, String(owner), String(ttlMs))) === 1;
    },
    /** Garde le verrou tant que la compilation tourne ; retourne la fonction d'arrêt. */
    keepAlive(siteId, owner, everyMs = Math.floor(ttlMs / 3)) {
      const timer = setInterval(() => { this.extend(siteId, owner).catch(() => {}); }, everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    async holder(siteId) {
      return redis.get(prefix + siteId);
    },
    async close() {
      await redis.quit().catch(() => redis.disconnect());
    },
  };
}
