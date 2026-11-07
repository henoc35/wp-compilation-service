import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify, signedHeaders } from '../../src/signature.js';

const secret = 'secret-de-test';
const parts = { method: 'POST', path: '/v1/compile', body: '{"url":"https://exemple.fr/"}' };

test('une signature valide est acceptée', () => {
  const now = Date.now();
  const h = signedHeaders({ siteId: 's1', secret, ...parts, now });
  const r = verify({ secret, timestamp: h['X-Page-Compiler-Timestamp'], signature: h['X-Page-Compiler-Signature'], ...parts, now });
  assert.deepEqual(r, { ok: true });
});

test('un corps modifié est refusé', () => {
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const signature = sign(secret, { timestamp, ...parts });
  const r = verify({ secret, timestamp, signature, ...parts, body: '{"url":"https://pirate.fr/"}', now });
  assert.equal(r.reason, 'invalid_signature');
});

test('un horodatage trop ancien est refusé (rejeu)', () => {
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000) - 3600);
  const signature = sign(secret, { timestamp, ...parts });
  const r = verify({ secret, timestamp, signature, ...parts, now, maxAgeSeconds: 300 });
  assert.equal(r.reason, 'expired_timestamp');
});

test('sans secret configuré, tout est refusé', () => {
  const r = verify({ secret: undefined, timestamp: '1', signature: 'sha256=00', ...parts });
  assert.equal(r.reason, 'missing_secret');
});

test('une signature de longueur différente est refusée sans erreur', () => {
  const now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const r = verify({ secret, timestamp, signature: 'sha256=court', ...parts, now });
  assert.equal(r.reason, 'invalid_signature');
});
