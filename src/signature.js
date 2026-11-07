import crypto from 'node:crypto';

/**
 * Signature HMAC-SHA256 des échanges entre le plugin et le service.
 *
 * Message signé : `${timestamp}.${METHODE}.${chemin}.${corps}`
 * En-têtes :
 *   X-Compilateur-Site       identifiant du site
 *   X-Compilateur-Timestamp  secondes Unix
 *   X-Compilateur-Signature  sha256=<hex>
 */
export const HEADERS = {
  site: 'x-compilateur-site',
  timestamp: 'x-compilateur-timestamp',
  signature: 'x-compilateur-signature',
};

export function signatureMessage({ timestamp, method, path, body }) {
  return `${timestamp}.${String(method).toUpperCase()}.${path}.${body ?? ''}`;
}

export function sign(secret, parts) {
  const hmac = crypto.createHmac('sha256', secret).update(signatureMessage(parts)).digest('hex');
  return `sha256=${hmac}`;
}

/** Construit les en-têtes signés pour une requête sortante. */
export function signedHeaders({ siteId, secret, method, path, body, now = Date.now() }) {
  const timestamp = String(Math.floor(now / 1000));
  return {
    'X-Compilateur-Site': siteId,
    'X-Compilateur-Timestamp': timestamp,
    'X-Compilateur-Signature': sign(secret, { timestamp, method, path, body }),
  };
}

/**
 * Vérifie une signature. Retourne { ok: true } ou { ok: false, reason }.
 * Comparaison en temps constant ; horodatage limité pour bloquer le rejeu.
 */
export function verify({ secret, timestamp, signature, method, path, body, maxAgeSeconds = 300, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'secret_absent' };
  if (!timestamp || !signature) return { ok: false, reason: 'en_tetes_absents' };
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'horodatage_invalide' };
  if (Math.abs(Math.floor(now / 1000) - ts) > maxAgeSeconds) return { ok: false, reason: 'horodatage_expire' };
  const expected = Buffer.from(sign(secret, { timestamp, method, path, body }));
  const given = Buffer.from(String(signature));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature_invalide' };
  }
  return { ok: true };
}
