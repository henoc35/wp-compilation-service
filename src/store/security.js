import crypto from 'node:crypto';

/** Outils de sécurité : chiffrement des secrets, mots de passe, jetons, codes d'appairage. */

/* ---------- Chiffrement des secrets (AES-256-GCM) ---------- */

export function createBox(masterKey) {
  if (!masterKey || masterKey.length < 16) {
    throw new Error('MASTER_KEY manquante ou trop courte (16 caractères minimum, 64 recommandés : openssl rand -hex 32)');
  }
  const key = crypto.createHash('sha256').update(masterKey).digest();
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    },
    decrypt(blob) {
      const [v, iv, tag, data] = String(blob).split(':');
      if (v !== 'v1') throw new Error('format de secret inconnu');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}

/* ---------- Mots de passe (scrypt) ---------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const randomSecret = () => crypto.randomBytes(32).toString('hex');

/** Code d'appairage lisible : 8 caractères sans ambiguïté (pas de 0/O, 1/I/L), groupés 4-4. */
export function pairingCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export const json = (v, fallback) => {
  if (v == null) return fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
