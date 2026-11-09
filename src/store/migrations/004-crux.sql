-- Relevés CrUX (visiteurs réels, 75e centile) par site et par type d'appareil.
CREATE TABLE crux_snapshots (
  id BIGSERIAL PRIMARY KEY,
  site_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  form_factor TEXT NOT NULL CHECK (form_factor IN ('PHONE', 'DESKTOP')),
  data JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX crux_site ON crux_snapshots (site_id, id DESC);
