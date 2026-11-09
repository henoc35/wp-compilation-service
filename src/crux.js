/**
 * Données réelles des visiteurs Chrome (rapport CrUX), via l'API CrUX History :
 * POST https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=…
 * Valeurs au 75e centile, par périodes de collecte (jusqu'à 40). Les périodes sans
 * données valent null ; le CLS est renvoyé sous forme de chaîne.
 * La clé est la même clé d'API Google que PageSpeed (API « Chrome UX Report » à activer).
 */

export const CRUX_METRICS = {
  largest_contentful_paint: 'lcp',
  interaction_to_next_paint: 'inp',
  cumulative_layout_shift: 'cls',
  first_contentful_paint: 'fcp',
  experimental_time_to_first_byte: 'ttfb',
};

/** Seuils « bon » / « mauvais » des Core Web Vitals (75e centile). */
export const THRESHOLDS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] };

export function rating(metric, value) {
  if (value == null || !THRESHOLDS[metric]) return null;
  const [good, poor] = THRESHOLDS[metric];
  return value <= good ? 'good' : value > poor ? 'poor' : 'average';
}

const toNumber = (v) => (v == null || v === 'NaN' ? null : Number(v));
const isoDate = (d) => (d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null);

export function parseHistory(data) {
  const record = data?.record;
  if (!record) return null;
  const metrics = {};
  for (const [name, key] of Object.entries(CRUX_METRICS)) {
    const p75s = record.metrics?.[name]?.percentilesTimeseries?.p75s;
    if (Array.isArray(p75s)) metrics[key] = p75s.map(toNumber);
  }
  const periods = (record.collectionPeriods || []).map((p) => ({ first: isoDate(p.firstDate), last: isoDate(p.lastDate || p.endDate) }));
  return { periods, metrics };
}

export async function queryCruxHistory({ origin, formFactor, apiKey, endpoint = 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord', fetchImpl = fetch, timeoutMs = 30000 }) {
  const res = await fetchImpl(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin, formFactor, metrics: Object.keys(CRUX_METRICS), collectionPeriodCount: 25 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => null);
  // Pas assez de trafic : aucun enregistrement pour cette origine (réponse d'erreur « not found »).
  if (res.status === 404 || /not found/i.test(body?.error?.message || '')) return { periods: [], metrics: {}, noData: true };
  if (!res.ok) throw new Error(`CrUX : ${body?.error?.message || `HTTP ${res.status}`}`);
  return parseHistory(body) || { periods: [], metrics: {}, noData: true };
}
