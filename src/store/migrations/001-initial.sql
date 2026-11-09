-- Schéma initial.
-- Les comptes ont un rôle et peuvent être limités à certains clients (user_clients) :
-- prévu pour l'ajout de comptes d'équipe. Les sites sont regroupés par client.

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'editor', 'viewer')),
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email ON users (lower(email));

CREATE TABLE clients (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX clients_name ON clients (lower(name));

CREATE TABLE user_clients (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, client_id)
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE sites (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name TEXT NOT NULL,
  client_id BIGINT REFERENCES clients(id) ON DELETE SET NULL,
  domains JSONB NOT NULL DEFAULT '[]',
  secret_enc TEXT NOT NULL,
  callback_url TEXT,
  options JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paired_at TIMESTAMPTZ,
  plugin_version TEXT
);
CREATE INDEX sites_client ON sites (client_id);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

-- Une ligne par compilation. « weights » (poids totaux) est gardé 2 ans ;
-- « resources » (détail fichier par fichier) est effacé après 90 jours.
CREATE TABLE compilations (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT,
  site_id TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  lcp_reference DOUBLE PRECISION,
  lcp_candidate DOUBLE PRECISION,
  families_applied JSONB NOT NULL DEFAULT '[]',
  families_disabled JSONB NOT NULL DEFAULT '[]',
  attempts JSONB NOT NULL DEFAULT '[]',
  weights JSONB,
  resources JSONB,
  published BOOLEAN,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX compilations_site ON compilations (site_id, id DESC);
CREATE INDEX compilations_site_url ON compilations (site_id, url, id DESC);
CREATE INDEX compilations_created ON compilations (created_at);

CREATE TABLE pagespeed_runs (
  id BIGSERIAL PRIMARY KEY,
  site_id TEXT NOT NULL,
  url TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('mobile', 'desktop')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'error')),
  score DOUBLE PRECISION,
  metrics JSONB,
  field JSONB,
  error TEXT,
  requested_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX pagespeed_site ON pagespeed_runs (site_id, id DESC);
CREATE INDEX pagespeed_site_url ON pagespeed_runs (site_id, url, id DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Journal des actions d'administration (qui a fait quoi), utile avec plusieurs comptes.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC);
