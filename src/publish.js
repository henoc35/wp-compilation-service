import { signedHeaders } from './signature.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Envoie le résultat au plugin du site (corps JSON signé).
 * Statuts : "compiled", "compiled_partial" (avec html) ou "failed" (sans html :
 * le plugin continue de servir la page WordPress).
 * Jusqu'à 3 tentatives en cas d'erreur réseau ou de réponse 5xx.
 */
export async function publishResult(site, payload, { timeoutMs = 30000, retries = 3 } = {}) {
  if (!site?.callbackUrl) return { published: false, reason: 'pas_de_callback' };
  if (!site.secret) return { published: false, reason: 'secret_absent' };
  const url = new URL(site.callbackUrl);
  const body = JSON.stringify(payload);
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...signedHeaders({ siteId: site.id, secret: site.secret, method: 'POST', path: url.pathname + url.search, body }),
      };
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { published: true, httpStatus: res.status };
      last = { published: false, httpStatus: res.status, reason: `http_${res.status}` };
      if (res.status < 500) return last; // refus du plugin : inutile de réessayer
    } catch (e) {
      last = { published: false, reason: String(e.message || e).slice(0, 200) };
    }
    if (attempt < retries) await sleep(2000 * attempt);
  }
  return last;
}
