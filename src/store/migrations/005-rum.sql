-- Mesures envoyées par les navigateurs des visiteurs (option « Mesure des visiteurs » du site).
-- Aucune donnée personnelle : ni IP, ni cookie, ni identifiant ; chemin de page seulement.
CREATE TABLE rum_events (
  id BIGSERIAL PRIMARY KEY,
  site_id TEXT NOT NULL,
  path TEXT NOT NULL,
  device TEXT NOT NULL CHECK (device IN ('mobile', 'desktop')),
  lcp INTEGER,
  cls DOUBLE PRECISION,
  inp INTEGER,
  ttfb INTEGER,
  prerendered BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rum_site ON rum_events (site_id, created_at DESC);
