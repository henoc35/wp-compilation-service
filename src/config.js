import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const env = process.env;

function int(name, fallback) {
  const v = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function float(name, fallback) {
  const v = Number.parseFloat(env[name] ?? '');
  return Number.isFinite(v) ? v : fallback;
}

function bool(name, fallback) {
  const v = (env[name] ?? '').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

/** Ensemble des familles d'optimisation, dans l'ordre d'application. */
export const ALL_FAMILIES = ['images', 'animations', 'fonts', 'scripts', 'navigation', 'css'];

export function loadConfig() {
  return {
    port: int('PORT', 3000),
    host: env.HOST || '0.0.0.0',
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    queueName: env.QUEUE_NAME || 'compilation',
    /** Nombre maximal de compilations (donc de Chromium) simultanées, tous workers confondus. */
    chromiumConcurrency: int('CHROMIUM_CONCURRENCY', 3),
    /** Délai avant de réessayer une tâche dont le site est déjà en cours de compilation (ms). */
    siteRetryDelayMs: int('SITE_RETRY_DELAY_MS', 5000),
    /** Regroupement des demandes d'une même page (ms). */
    debounceMs: int('DEBOUNCE_MS', 30000),
    sitesFile: env.SITES_FILE || path.resolve('config/sites.yml'),
    rulesDir: env.RULES_DIR || path.resolve('rules'),
    dataDir: env.DATA_DIR || path.resolve('data'),
    artifactsRetentionDays: int('ARTIFACTS_RETENTION_DAYS', 30),
    chromiumPath: env.CHROMIUM_PATH || undefined,
    /** Arguments Chromium supplémentaires, séparés par des espaces (utile en test local). */
    chromiumExtraArgs: (env.CHROMIUM_EXTRA_ARGS || '').split(/\s+/).filter(Boolean),
    maxAttempts: int('MAX_ATTEMPTS', 3),
    visualThreshold: float('VISUAL_THRESHOLD', 0.005),
    fullPageThreshold: float('FULLPAGE_THRESHOLD', 0.01),
    heightTolerance: float('HEIGHT_TOLERANCE', 0.02),
    noiseCheck: bool('NOISE_CHECK', true),
    /** Contrôle de départ sans optimisation (détecte les pages instables). */
    baselineCheck: bool('BASELINE_CHECK', true),
    measureRuns: int('MEASURE_RUNS', 3),
    lcpTolerance: float('LCP_TOLERANCE', 1.05),
    signatureMaxAgeSeconds: int('SIGNATURE_MAX_AGE', 300),
    navigationMode: env.NAVIGATION_MODE === 'prerender' ? 'prerender' : 'prefetch',
    pageTimeoutMs: int('PAGE_TIMEOUT_MS', 60000),
    callbackTimeoutMs: int('CALLBACK_TIMEOUT_MS', 30000),
  };
}

/**
 * Charge la liste des sites (fichier ou variable SITES_YAML). Chaque site donne son
 * secret directement (« secret », à réserver à SITES_YAML qui est une variable
 * protégée) ou le nom de la variable d'environnement qui le contient (« secret_env »).
 */
export function loadSites(file, environment = env) {
  // SITES_YAML (contenu YAML en variable d'environnement) est pratique sous Coolify.
  let source = environment.SITES_YAML || null;
  if (!source) {
    if (!fs.existsSync(file)) return new Map();
    source = fs.readFileSync(file, 'utf8');
  }
  const doc = YAML.parse(source) || {};
  const sites = new Map();
  for (const raw of doc.sites || []) {
    if (!raw.id) throw new Error('Site sans identifiant dans la configuration des sites');
    // Secret écrit directement dans la configuration (« secret »), ou nom de la
    // variable d'environnement qui le contient (« secret_env »).
    const secret = raw.secret ? String(raw.secret) : (raw.secret_env ? environment[raw.secret_env] : undefined);
    sites.set(raw.id, {
      id: raw.id,
      domains: (raw.domains || []).map((d) => String(d).toLowerCase()),
      secret,
      callbackUrl: raw.callback_url || null,
      families: raw.families || {},
      protectedSelectors: raw.protected_selectors || [],
      thirdPartyExtra: raw.third_party_extra || [],
      neverDelay: raw.never_delay || [],
      masks: raw.masks || [],
      navigationExclude: raw.navigation_exclude || [],
    });
  }
  return sites;
}

/** Retrouve la configuration d'un site à partir d'une URL (utile en ligne de commande). */
export function siteForUrl(sites, url) {
  const host = new URL(url).hostname.toLowerCase();
  for (const site of sites.values()) {
    if (site.domains.includes(host)) return site;
  }
  return null;
}

/** Familles activées pour un site, après ses exceptions éventuelles. */
export function enabledFamilies(site, override) {
  if (Array.isArray(override) && override.length) {
    return ALL_FAMILIES.filter((f) => override.includes(f));
  }
  const exceptions = site?.families || {};
  return ALL_FAMILIES.filter((f) => exceptions[f] !== false);
}
