/**
 * Mesure des visiteurs (RUM) : petit script ajouté aux pages compilées des sites qui
 * l'activent. À la fermeture ou au masquage de la page, il envoie LCP, CLS, INP et
 * TTFB au service (navigator.sendBeacon). Aucun cookie, aucun identifiant ; le
 * service n'enregistre ni l'IP ni l'adresse complète (chemin seulement).
 */

export function rumScript(endpoint) {
  const url = JSON.stringify(endpoint);
  return `<script data-pc-rum>(()=>{try{if(!('PerformanceObserver'in window)||!navigator.sendBeacon)return;var m={lcp:null,cls:0,inp:0},s=0,w=[],o=(t,f,x)=>{try{new PerformanceObserver(l=>l.getEntries().forEach(f)).observe(Object.assign({type:t,buffered:true},x||{}))}catch(e){}};`
    + `o('largest-contentful-paint',e=>{m.lcp=Math.round(e.startTime)});`
    + `o('layout-shift',e=>{if(e.hadRecentInput)return;var l=w[w.length-1];if(l&&e.startTime-l.startTime<1000&&e.startTime-w[0].startTime<5000){s+=e.value;w.push(e)}else{s=e.value;w=[e]}if(s>m.cls)m.cls=s});`
    + `o('event',e=>{if(e.interactionId&&e.duration>m.inp)m.inp=Math.round(e.duration)},{durationThreshold:40});`
    + `var n=performance.getEntriesByType('navigation')[0],p=document.prerendering||(n&&n.activationStart>0),sent=0;`
    + `addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden'||sent)return;sent=1;var a=n&&n.activationStart||0;`
    + `navigator.sendBeacon(${url},JSON.stringify({p:location.pathname,d:matchMedia('(max-width: 767px)').matches?'mobile':'desktop',lcp:m.lcp==null?null:Math.max(0,m.lcp-a),cls:Math.round(m.cls*10000)/10000,inp:m.inp||null,ttfb:n?Math.max(0,Math.round(n.responseStart-a)):null,pr:!!p}))},{capture:true})}catch(e){}})();</script>`;
}

const int = (v, max) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null);

/** Valide une mesure reçue ; null si elle est inexploitable. */
export function parseBeacon(raw) {
  let d;
  try {
    d = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!d || typeof d.p !== 'string' || !d.p.startsWith('/')) return null;
  const device = d.d === 'mobile' ? 'mobile' : d.d === 'desktop' ? 'desktop' : null;
  if (!device) return null;
  const out = {
    path: d.p.slice(0, 300),
    device,
    lcp: int(d.lcp, 120000),
    cls: Number.isFinite(d.cls) && d.cls >= 0 && d.cls <= 50 ? d.cls : null,
    inp: int(d.inp, 60000),
    ttfb: int(d.ttfb, 120000),
    prerendered: Boolean(d.pr),
  };
  if (out.lcp == null && out.cls == null && out.inp == null && out.ttfb == null) return null;
  return out;
}
