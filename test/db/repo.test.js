import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { openDatabase, migrate, listMigrations } from '../../src/store/db.js';
import { createRepo, normalizeDomains } from '../../src/store/repo.js';
import { createBox } from '../../src/store/security.js';

// Base de test vidée à chaque exécution : TEST_DATABASE_URL obligatoire (sinon tests ignorés).
const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'TEST_DATABASE_URL absente';
let pool;
let repo;

before(async () => {
  if (skip) return;
  const admin = new pg.Pool({ connectionString: URL_ });
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  pool = await openDatabase(URL_);
  repo = createRepo(pool, createBox('cle-de-test-suffisamment-longue'));
});
after(async () => pool?.end());

test('migrations idempotentes', { skip }, async () => {
  assert.deepEqual(await migrate(pool), []);
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  assert.equal(rows.length, listMigrations().length, 'toutes les migrations appliquées, une seule fois');
});

test('comptes : création, connexion, sessions, mot de passe', { skip }, async () => {
  await assert.rejects(repo.users.create({ email: 'a@b.fr', password: 'court' }), /10 caractères/);
  const id = await repo.users.create({ email: 'Admin@Exemple.fr', password: 'un-mot-de-passe-long' });
  assert.equal(await repo.users.count(), 1);
  assert.equal(await repo.users.authenticate('admin@exemple.fr', 'faux-mot-de-passe'), null);
  const u = await repo.users.authenticate('ADMIN@exemple.fr', 'un-mot-de-passe-long');
  assert.equal(u.id, id);
  const s = await repo.sessions.create(id, 1);
  const got = await repo.sessions.get(s.token);
  assert.equal(got.user.email, 'Admin@Exemple.fr');
  assert.equal(got.csrf, s.csrf);
  assert.equal(await repo.sessions.get('jeton-inconnu'), null);
  await repo.sessions.destroy(s.token);
  assert.equal(await repo.sessions.get(s.token), null);
  assert.equal(await repo.users.clientScope(u), null, 'un administrateur voit tous les clients');
});

test('clients et sites : secret chiffré, identifiants, domaines', { skip }, async () => {
  const c = await repo.clients.create({ name: 'Client A' });
  await assert.rejects(repo.clients.create({ name: 'client a' }), /existe déjà/);
  const id = await repo.sites.create({ name: 'Vitrine', clientId: c, domains: 'https://www.exemple.fr/, exemple.fr' });
  assert.equal(id, 'site-01');
  assert.equal(await repo.sites.nextId(), 'site-02');
  const site = await repo.sites.get(id, true);
  assert.deepEqual(site.domains, ['www.exemple.fr', 'exemple.fr']);
  assert.match(site.secret, /^[0-9a-f]{64}$/);
  const raw = (await pool.query('SELECT secret_enc FROM sites WHERE id = $1', [id])).rows[0].secret_enc;
  assert.ok(!raw.includes(site.secret), 'le secret n\'est jamais stocké en clair');
  await assert.rejects(repo.sites.create({ id: 'site-01', domains: 'x.fr' }), /existe déjà/);
  await assert.rejects(repo.sites.create({ id: 'Site_01', domains: 'x.fr' }), /identifiant invalide/);
  assert.throws(() => normalizeDomains('pas un domaine'), /domaine invalide/);
  assert.equal((await repo.sites.list())[0].clientName, 'Client A');
  await repo.sites.rotateSecret(id);
  assert.notEqual((await repo.sites.get(id, true)).secret, site.secret);
});

test('appairage : usage unique, expiration, codes précédents annulés', { skip }, async () => {
  const id = await repo.sites.create({ name: 'B', domains: 'b.fr' });
  const first = await repo.pairing.create(id, 15);
  const { code } = await repo.pairing.create(id, 15);
  assert.equal((await repo.pairing.consume(first.code)).error, 'invalid_code', 'un nouveau code annule le précédent');
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const ok = await repo.pairing.consume(code.toLowerCase().replace('-', ' '));
  assert.equal(ok.site.id, id);
  assert.ok(ok.site.secret);
  assert.equal((await repo.pairing.consume(code)).error, 'used_code');
  const expired = await repo.pairing.create(id, 15);
  await pool.query("UPDATE pairing_codes SET expires_at = now() - interval '1 minute'");
  assert.equal((await repo.pairing.consume(expired.code)).error, 'expired_code');
});

test('historique : enregistrement, pages, conservation 90 jours / 2 ans', { skip }, async () => {
  const base = { siteId: 'site-01', status: 'compiled', lcp: { reference: 3000, candidate: 1800 }, weights: { total: 1000 }, resources: [{ url: 'a.jpg', bytes: 10 }] };
  await repo.compilations.record({ ...base, url: 'https://www.exemple.fr/' });
  await repo.compilations.record({ ...base, url: 'https://www.exemple.fr/', status: 'failed', reason: 'motif' });
  await repo.compilations.record({ ...base, url: 'https://www.exemple.fr/contact/' });
  const pages = await repo.compilations.pages('site-01');
  assert.equal(pages.length, 2);
  assert.equal(pages.find((p) => p.url.endsWith('.fr/')).status, 'failed', 'dernier état de la page');
  await pool.query("UPDATE compilations SET created_at = now() - interval '100 days' WHERE url LIKE '%contact%'");
  await pool.query("UPDATE compilations SET created_at = now() - interval '800 days' WHERE status = 'failed'");
  const r = await repo.purge();
  assert.equal(r.old, 1);
  const contact = (await repo.compilations.list('site-01', { url: 'https://www.exemple.fr/contact/' }))[0];
  const detail = await repo.compilations.get('site-01', contact.id);
  assert.equal(detail.resources, null, 'détail effacé après 90 jours');
  assert.deepEqual(detail.weights, { total: 1000 }, 'résumé conservé');
  const summary = await repo.sites.summaries();
  assert.ok(summary['site-01']);
});

test('réglages chiffrés et PageSpeed', { skip }, async () => {
  await repo.settings.set('pagespeed_api_key', 'AIza-test', { encrypted: true });
  assert.equal(await repo.settings.get('pagespeed_api_key'), 'AIza-test');
  const raw = (await pool.query("SELECT value FROM settings WHERE key = 'pagespeed_api_key'")).rows[0].value;
  assert.ok(!raw.includes('AIza'));
  const run = await repo.pagespeed.start('site-01', 'https://www.exemple.fr/', 'mobile');
  await repo.pagespeed.finish(run, { score: 0.91, metrics: { lcp: 2100 }, field: null });
  assert.equal((await repo.sites.summaries())['site-01'].pagespeed_mobile, 0.91);
});
