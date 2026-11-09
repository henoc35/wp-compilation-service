import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Connexion PostgreSQL et migrations.
 *
 * Les migrations sont des fichiers SQL numérotés (src/store/migrations/NNN-nom.sql),
 * appliqués dans l'ordre au démarrage, chacun dans une transaction. Un verrou
 * consultatif évite que l'API et le worker les appliquent en même temps. Pour faire
 * évoluer le schéma : ajouter un nouveau fichier, ne jamais modifier un ancien.
 */

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_ID = 7234021; // identifiant arbitraire du verrou de migration

// Les colonnes BIGINT (identifiants) sont rendues en nombres JavaScript.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d{3}-[\w-]+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number.parseInt(f.slice(0, 3), 10), name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

export async function migrate(pool, { dir = MIGRATIONS_DIR, log = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied = [];
    for (const m of listMigrations(dir)) {
      if (done.has(m.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
        applied.push(m.name);
        log?.info?.({ migration: m.name }, 'migration appliquée');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.name} en échec : ${err.message}`);
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

export async function openDatabase(databaseUrl, { log = null, max = 5 } = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL manquante (ex. postgres://page_compiler:motdepasse@postgres:5432/page_compiler)');
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  pool.on('error', (err) => log?.error?.({ err: err.message }, 'erreur PostgreSQL'));
  await migrate(pool, { log });
  return pool;
}
