/* Interface d'administration de Page Compiler — sans dépendance, sans innerHTML pour les données. */
(() => {
  'use strict';

  const state = { user: null, csrf: null, timers: [] };
  const app = document.getElementById('app');

  /* ---------- Outils ---------- */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'style') Object.assign(el.style, v); // objet : compatible avec la CSP (pas d'attribut style)
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  /** append qui ignore les valeurs absentes (null, false) au lieu d'afficher « null ». */
  const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const clearTimers = () => { state.timers.forEach(clearTimeout); state.timers = []; };
  const later = (fn, ms) => state.timers.push(setTimeout(fn, ms));

  const ERRORS = {
    invalid_credentials: 'Adresse ou mot de passe incorrect.',
    too_many_attempts: 'Trop de tentatives. Réessayez dans 15 minutes.',
    no_account: 'Aucun compte : définissez ADMIN_EMAIL et ADMIN_PASSWORD dans Coolify puis redéployez.',
    invalid_domain: 'Domaine invalide.',
    duplicate_id: 'Cet identifiant existe déjà.',
    invalid_id: 'Identifiant invalide : minuscules, chiffres et tirets.',
    duplicate_name: 'Ce client existe déjà.',
    invalid_name: 'Le nom est obligatoire.',
    invalid_current_password: 'Mot de passe actuel incorrect.',
    weak_password: 'Mot de passe de 10 caractères minimum.',
    pagespeed_not_configured: 'Clé PageSpeed non configurée : voir Réglages.',
    domain_not_allowed: 'Cette adresse n\'appartient pas aux domaines du site.',
    invalid_url: 'Adresse invalide.',
    forbidden: 'Action non autorisée pour votre compte.',
    csrf: 'Session expirée : rechargez la page.',
  };
  const errorText = (e) => ERRORS[e?.error] || e?.message || 'Erreur inattendue.';

  async function api(method, path, body) {
    const res = await fetch(`/admin/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(state.csrf ? { 'x-csrf-token': state.csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') {
      state.user = null;
      location.hash = '#/login';
      throw data;
    }
    if (!res.ok) throw data;
    return data;
  }

  function toast(text) {
    const t = h('div', { class: 'toast', role: 'status' }, text);
    document.put(body, t);
    setTimeout(() => t.remove(), 4000);
  }

  const num = (v, d = 0) => Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtBytes = (b) => (b == null ? '—' : b < 1024 ? `${b} o` : b < 1048576 ? `${num(b / 1024)} Ko` : `${num(b / 1048576, 2)} Mo`);
  const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${num(ms / 1000, 2)} s`);
  const fmtPct = (r) => `${num(r * 100)} %`;
  const fmtCls = (v) => (v == null ? '—' : num(v, 3));
  const fmtDate = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

  const STATUS = {
    compiled: ['Compilée', 'ok'], compiled_partial: ['Compilée en partie', 'ok'], failed: ['Échec', 'bad'],
    skipped: ['Ignorée', 'warn'], pending: ['En cours', 'info'], done: ['Terminée', 'ok'], error: ['Erreur', 'bad'],
  };
  const statusBadge = (s) => { const [l, c] = STATUS[s] || [s, 'neutral']; return h('span', { class: `badge ${c}` }, l); };
  function scoreBadge(score) {
    if (score == null) return h('span', { class: 'score none' }, '—');
    const v = Math.round(score * 100);
    return h('span', { class: `score ${v >= 90 ? 'good' : v >= 50 ? 'avg' : 'poor'}`, title: 'Score de performance PageSpeed' }, v);
  }

  /* ---------- Mise en page ---------- */
  const NAV = [['#/', 'Sites'], ['#/clients', 'Clients'], ['#/settings', 'Réglages', 'admin'], ['#/audit', 'Journal', 'admin'], ['#/account', 'Mon compte']];
  function layout(content) {
    const current = location.hash.split('/').slice(0, 2).join('/') || '#/';
    const nav = NAV.filter(([, , role]) => !role || state.user.role === role).map(([href, label]) =>
      h('a', { href, class: (href === '#/' ? ['#/', '#/sites'].includes(current) : current === href) ? 'active' : null }, label));
    app.replaceChildren(
      h('header', { class: 'topbar' },
        h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Page Compiler'),
        h('nav', { class: 'nav', 'aria-label': 'Navigation principale' }, nav),
        h('span', { class: 'who' }, state.user.email),
        h('button', { class: 'btn small', onclick: logout }, 'Déconnexion')),
      h('main', {}, content));
  }
  const pageHead = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null), h('div', { class: 'actions' }, actions));
  const loading = () => layout(h('p', { class: 'muted' }, 'Chargement…'));

  /* ---------- Connexion ---------- */
  async function viewLogin() {
    const status = await fetch('/admin/api/status').then((r) => r.json()).catch(() => ({ accounts: true }));
    const msg = h('div');
    if (!status.accounts) msg.append(h('div', { class: 'notice warn' }, ERRORS.no_account));
    const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true });
    const password = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/login', { email: email.value, password: password.value });
          state.user = r.user; state.csrf = r.csrf;
          location.hash = '#/';
        } catch (err) {
          msg.replaceChildren(h('div', { class: 'notice bad', role: 'alert' }, errorText(err)));
        }
      },
    }, h('div', { class: 'row' }, h('label', { for: 'email' }, 'Adresse e-mail'), email),
    h('div', { class: 'row' }, h('label', { for: 'password' }, 'Mot de passe'), password),
    h('button', { class: 'btn primary', type: 'submit' }, 'Se connecter'));
    app.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'card login' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Page Compiler'), msg, form)));
    email.focus();
  }

  async function logout() {
    await api('POST', '/logout').catch(() => {});
    state.user = null; state.csrf = null;
    location.hash = '#/login';
  }

  /* ---------- Tableau de bord ---------- */
  async function viewDashboard() {
    loading();
    const d = await api('GET', '/dashboard');
    const paired = d.sites.filter((s) => s.pairedAt).length;
    const sum = (k) => d.sites.reduce((n, s) => n + (s.summary[k] || 0), 0);
    const stats = h('div', { class: 'grid stats' },
      [[d.sites.length, 'sites enregistrés'], [paired, 'sites appairés'], [sum('compiled30d'), 'compilations réussies (30 j)'],
        [sum('failed30d'), 'échecs (30 j)'], [(d.queue.waiting || 0) + (d.queue.delayed || 0) + (d.queue.active || 0), 'pages dans la file']]
        .map(([v, l]) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l))));

    const rows = [];
    const groups = new Map();
    for (const s of d.sites) {
      const k = s.clientName || 'Sans client';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }
    for (const [client, list] of groups) {
      rows.push(h('tr', { class: 'group-row' }, h('td', { colspan: 7 }, client, h('span', { class: 'muted small' }, ` · ${list.length} site${list.length > 1 ? 's' : ''}`))));
      for (const s of list) {
        rows.push(h('tr', {},
          h('td', {}, h('a', { href: `#/sites/${s.id}` }, s.name), h('div', { class: 'muted small mono' }, s.id)),
          h('td', { class: 'small' }, s.domains.join(', ')),
          h('td', {}, s.status === 'paused' ? h('span', { class: 'badge warn' }, 'En pause')
            : s.pairedAt ? h('span', { class: 'badge ok' }, 'Appairé') : h('span', { class: 'badge neutral' }, 'Non appairé')),
          h('td', { class: 'num' }, s.summary.compiled30d ?? 0, s.summary.failed30d ? h('span', { class: 'badge bad' }, ` ${s.summary.failed30d} échec(s)`) : null),
          h('td', { class: 'num' }, scoreBadge(s.summary.pagespeed_mobile)),
          h('td', { class: 'num' }, scoreBadge(s.summary.pagespeed_desktop)),
          h('td', { class: 'small' }, fmtDate(s.summary.lastCompilation))));
      }
    }
    const table = d.sites.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Site'), h('th', {}, 'Domaines'), h('th', {}, 'État'), h('th', { class: 'num' }, 'Compilations 30 j'),
          h('th', { class: 'num' }, 'PageSpeed mobile'), h('th', { class: 'num' }, 'PageSpeed ordinateur'), h('th', {}, 'Dernière compilation'))),
        h('tbody', {}, rows)))
      : h('div', { class: 'empty' }, 'Aucun site enregistré. Commencez par « Nouveau site ».');

    layout([
      pageHead('Sites', 'Tout le parc, regroupé par client.', state.user.role === 'admin' ? h('a', { class: 'btn primary', href: '#/sites/new' }, 'Nouveau site') : null),
      d.yamlSites.length ? h('div', { class: 'notice warn' }, `${d.yamlSites.length} site(s) sont encore définis uniquement dans SITES_YAML (${d.yamlSites.map((s) => s.id).join(', ')}). `,
        h('a', { href: '#/settings' }, 'Les importer')) : null,
      stats,
      h('div', { class: 'card flush' }, table),
    ]);
  }

  /* ---------- Nouveau site ---------- */
  async function viewNewSite() {
    loading();
    const clients = await api('GET', '/clients');
    const msg = h('div');
    const f = {
      name: h('input', { type: 'text', id: 'name', required: true, placeholder: 'Ex. Boulangerie Martin' }),
      client: h('select', { id: 'client' }, h('option', { value: '' }, '— Sans client —'), clients.map((c) => h('option', { value: c.id }, c.name)), h('option', { value: '__new' }, '+ Nouveau client…')),
      newClient: h('input', { type: 'text', id: 'newClient', placeholder: 'Nom du nouveau client', hidden: true }),
      domains: h('input', { type: 'text', id: 'domains', required: true, placeholder: 'www.exemple.fr exemple.fr' }),
      id: h('input', { type: 'text', id: 'siteid', placeholder: 'automatique (site-01, site-02…)' }),
    };
    f.client.addEventListener('change', () => { f.newClient.hidden = f.client.value !== '__new'; });
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          let clientId = f.client.value || null;
          if (clientId === '__new') clientId = (await api('POST', '/clients', { name: f.newClient.value })).id;
          const r = await api('POST', '/sites', { name: f.name.value, clientId: clientId ? Number(clientId) : null, domains: f.domains.value, id: f.id.value.trim() || null });
          sessionStorage.setItem(`pairing:${r.id}`, JSON.stringify(r.pairing));
          location.hash = `#/sites/${r.id}`;
        } catch (err) {
          msg.replaceChildren(h('div', { class: 'notice bad', role: 'alert' }, errorText(err)));
        }
      },
    },
    h('div', { class: 'row' }, h('label', { for: 'name' }, 'Nom du site'), f.name),
    h('div', { class: 'row' }, h('label', { for: 'client' }, 'Client'), f.client, f.newClient),
    h('div', { class: 'row' }, h('label', { for: 'domains' }, 'Domaines ', h('span', { class: 'hint' }, '— celui de WordPress, avec et sans www, séparés par des espaces')), f.domains),
    h('div', { class: 'row' }, h('label', { for: 'siteid' }, 'Identifiant ', h('span', { class: 'hint' }, '— facultatif')), f.id),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Créer le site et son code d\'appairage'), h('a', { class: 'btn', href: '#/' }, 'Annuler')));
    layout([pageHead('Nouveau site', 'L\'identifiant et la clé sont créés automatiquement ; le site les reçoit par un code d\'appairage.'), h('div', { class: 'card' }, msg, form)]);
    f.name.focus();
  }

  const FAMILY_LABELS = [['images', 'Images (priorité LCP, chargement différé)'], ['responsive', 'Tailles d\'images adaptées et espace réservé'], ['animations', 'Animations d\'entrée au-dessus de la ligne de flottaison'],
    ['fonts', 'Polices (affichage immédiat, hébergement local)'], ['scripts', 'Scripts tiers retardés'], ['navigation', 'Navigation instantanée'], ['css', 'CSS critique'],
    ['embeds', 'Vidéos et cartes chargées au clic'], ['assets', 'CSS et JS inutiles retirés']];

  /* ---------- Fiche site ---------- */
  const SITE_TABS = [['pages', 'Pages'], ['diagnostic', 'Diagnostic'], ['history', 'Historique'], ['pagespeed', 'PageSpeed'], ['crux', 'Visiteurs réels'], ['pairing', 'Appairage'], ['settings', 'Réglages du site']];

  async function viewSite(id, tab = 'pages', extra = null) {
    clearTimers();
    loading();
    let d;
    try {
      d = await api('GET', `/sites/${encodeURIComponent(id)}`);
    } catch (err) {
      layout(h('div', { class: 'notice bad' }, err.error === 'not_found' ? 'Site introuvable.' : errorText(err)));
      return;
    }
    const s = d.site;
    const tabs = h('nav', { class: 'tabs', 'aria-label': 'Sections du site' }, SITE_TABS.map(([k, l]) => h('a', { href: `#/sites/${s.id}/${k}`, class: k === tab ? 'active' : null }, l)));
    const head = pageHead(s.name, [s.clientName || 'Sans client', ' · ', h('span', { class: 'mono' }, s.id), ' · ', s.domains.join(', ')],
      s.status === 'paused' ? h('span', { class: 'badge warn' }, 'En pause') : null,
      s.pairedAt ? h('span', { class: 'badge ok' }, `Appairé le ${fmtDate(s.pairedAt)}`) : h('a', { class: 'badge neutral', href: `#/sites/${s.id}/pairing` }, 'Non appairé'));
    const body = h('div');
    layout([head, tabs, body]);
    const render = { pages: tabPages, diagnostic: tabDiagnostic, history: tabHistory, pagespeed: tabPageSpeed, crux: tabCrux, pairing: tabPairing, settings: tabSiteSettings }[tab] || tabPages;
    await render(body, d, extra);
  }

  async function tabPages(body, d) {
    const s = d.site;
    if (!d.pages.length) {
      put(body, h('div', { class: 'card empty' }, s.pairedAt ? 'Aucune compilation pour l\'instant. Lancez « Compiler tout le site » dans WordPress.'
        : 'Appairez le site pour commencer (onglet Appairage).'));
      return;
    }
    const rows = d.pages.map((p) => {
      const ref = p.weights?.reference?.mobile;
      const comp = p.weights?.compiled?.mobile;
      return h('tr', {},
        h('td', { class: 'url' }, h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, pathOf(p.url))),
        h('td', {}, statusBadge(p.status), p.reason ? h('div', { class: 'muted small' }, p.reason) : null),
        h('td', { class: 'num' }, fmtMs(p.lcp_reference), ' → ', fmtMs(p.lcp_candidate)),
        h('td', { class: 'num' }, fmtCls(p.cls_reference), ' → ', fmtCls(p.cls_candidate)),
        h('td', { class: 'num' }, fmtBytes(ref?.initial), comp ? [' → ', fmtBytes(comp.initial)] : null),
        h('td', { class: 'num' }, fmtBytes(ref?.total)),
        h('td', { class: 'small' }, fmtDate(p.created_at)),
        h('td', {}, h('div', { class: 'actions' },
          h('a', { class: 'btn small', href: `#/sites/${s.id}/history/${p.id}` }, 'Détail'),
          state.user.role !== 'viewer' ? h('button', { class: 'btn small', onclick: () => compile(s.id, p.url) }, 'Recompiler') : null,
          state.user.role !== 'viewer' ? h('button', { class: 'btn small', onclick: () => runPageSpeed(s.id, p.url) }, 'PageSpeed') : null)));
    });
    put(body, h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Page'), h('th', {}, 'Dernier résultat'), h('th', { class: 'num' }, 'LCP avant → après'), h('th', { class: 'num' }, 'CLS avant → après'),
        h('th', { class: 'num', title: 'Poids chargé à l\'ouverture, sur mobile' }, 'Poids à l\'ouverture'), h('th', { class: 'num', title: 'Après défilement complet' }, 'Poids total'),
        h('th', {}, 'Date'), h('th', {}, ''))),
      h('tbody', {}, rows)))));
  }

  async function compile(siteId, url) {
    try {
      await api('POST', `/sites/${siteId}/compile`, { url });
      toast('Compilation demandée : elle démarrera dans la file du service.');
    } catch (err) { toast(errorText(err)); }
  }

  async function runPageSpeed(siteId, url) {
    try {
      await api('POST', `/sites/${siteId}/pagespeed`, { url });
      location.hash = `#/sites/${siteId}/pagespeed`;
      toast('Analyses PageSpeed lancées (mobile et ordinateur), environ une minute.');
    } catch (err) { toast(errorText(err)); }
  }

  async function tabHistory(body, d, compilationId) {
    const s = d.site;
    if (compilationId) return compilationDetail(body, s, compilationId);
    const { items } = await api('GET', `/sites/${s.id}/compilations?limit=100`);
    if (!items.length) { put(body, h('div', { class: 'card empty' }, 'Aucune compilation enregistrée.')); return; }
    put(body, h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Page'), h('th', {}, 'Résultat'), h('th', { class: 'num' }, 'LCP avant → après'),
        h('th', { class: 'num' }, 'Poids total'), h('th', { class: 'num' }, 'Durée'), h('th', {}, ''))),
      h('tbody', {}, items.map((c) => h('tr', {},
        h('td', { class: 'small' }, fmtDate(c.created_at)),
        h('td', { class: 'url small' }, pathOf(c.url)),
        h('td', {}, statusBadge(c.status), c.reason ? h('div', { class: 'muted small' }, c.reason) : null,
          c.families_disabled?.length ? h('div', { class: 'small' }, `Désactivé : ${c.families_disabled.join(', ')}`) : null),
        h('td', { class: 'num' }, fmtMs(c.lcp_reference), ' → ', fmtMs(c.lcp_candidate)),
        h('td', { class: 'num' }, fmtBytes(c.weights?.reference?.mobile?.total)),
        h('td', { class: 'num' }, c.duration_ms ? `${Math.round(c.duration_ms / 1000)} s` : '—'),
        h('td', {}, h('a', { class: 'btn small', href: `#/sites/${s.id}/history/${c.id}` }, 'Détail')))))))));
  }

  const CATS = [['html', 'HTML'], ['css', 'CSS'], ['js', 'JavaScript'], ['images', 'Images'], ['fonts', 'Polices'], ['media', 'Vidéo/audio'], ['other', 'Autres']];
  function weightBars(ref, comp) {
    const max = Math.max(1, ...CATS.map(([k]) => Math.max(ref?.[k] || 0, comp?.[k] || 0)));
    return h('div', { class: 'bars' }, CATS.filter(([k]) => (ref?.[k] || comp?.[k])).map(([k, l]) => h('div', {},
      h('div', { class: 'bar' }, h('span', {}, l), h('span', { class: 'track' }, h('span', { class: 'fill', style: { width: `${((ref?.[k] || 0) / max) * 100}%` } })), h('span', { class: 'num' }, fmtBytes(ref?.[k]))),
      comp ? h('div', { class: 'bar' }, h('span', { class: 'muted' }, 'compilée'), h('span', { class: 'track' }, h('span', { class: 'fill alt', style: { width: `${((comp?.[k] || 0) / max) * 100}%` } })), h('span', { class: 'num' }, fmtBytes(comp?.[k]))) : null)));
  }

  function resourceTable(title, list) {
    if (!list.length) return null;
    const total = list.reduce((n, r) => n + r.bytes, 0);
    return h('div', {}, h('h3', {}, `${title} — ${list.length} fichier(s), ${fmtBytes(total)}`),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Fichier'), h('th', { class: 'num' }, 'Poids'), h('th', {}, 'Chargé'))),
        h('tbody', {}, list.slice(0, 40).map((r) => h('tr', {},
          h('td', { class: 'url small' }, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.url.length > 110 ? `${r.url.slice(0, 110)}…` : r.url)),
          h('td', { class: 'num' }, fmtBytes(r.bytes)),
          h('td', { class: 'small' }, r.initial ? 'à l\'ouverture' : 'au défilement')))))),
      list.length > 40 ? h('p', { class: 'muted small' }, `… et ${list.length - 40} autre(s).`) : null);
  }

  /* ---------- Diagnostic CSS / JS / images ---------- */
  const shortUrl = (u, n = 90) => (u.length > n ? `${u.slice(0, n)}…` : u);
  const fileLink = (u) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, shortUrl(u));
  const dims = (d) => (d ? `${d[0]}×${d[1]}` : '—');

  function imagesTable(list, { withPages = false } = {}) {
    if (!list.length) return h('p', { class: 'muted' }, 'Aucune image mesurée.');
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Image'), h('th', { class: 'num' }, 'Poids'), h('th', { class: 'num' }, 'Taille réelle'),
        h('th', { class: 'num', title: 'Taille affichée en pixels CSS' }, 'Affichée (mobile / ordi.)'), h('th', { class: 'num', title: 'Largeur utile pour un écran haute densité' }, 'Largeur utile'),
        h('th', { class: 'num' }, 'Excès'), h('th', { class: 'num' }, 'Gain estimé'), withPages ? h('th', { class: 'num' }, 'Pages') : null)),
      h('tbody', {}, list.slice(0, 60).map((i) => h('tr', {},
        h('td', { class: 'url small' }, fileLink(i.url), h('div', {},
          i.lcp ? h('span', { class: 'badge info' }, 'image LCP') : null, ' ',
          i.kind === 'background' ? h('span', { class: 'badge neutral' }, 'image de fond') : null, ' ',
          i.kind === 'img' && !i.srcset ? h('span', { class: 'badge warn', title: 'Pas de srcset : une seule taille pour tous les écrans' }, 'sans srcset') : null, ' ',
          i.mime ? h('span', { class: 'muted' }, i.mime.replace('image/', '')) : null)),
        h('td', { class: 'num' }, fmtBytes(i.bytes)),
        h('td', { class: 'num' }, dims(i.natural)),
        h('td', { class: 'num small' }, dims(i.display?.mobile), ' / ', dims(i.display?.desktop)),
        h('td', { class: 'num' }, `${i.needed} px`),
        h('td', { class: 'num' }, i.oversize > 1.15 ? h('span', { class: `badge ${i.oversize >= 2 ? 'bad' : 'warn'}` }, `×${num(i.oversize, 1)}`) : h('span', { class: 'muted' }, 'adaptée')),
        h('td', { class: 'num' }, i.savings ? fmtBytes(i.savings) : '—'),
        withPages ? h('td', { class: 'num' }, i.pages) : null)))),
    list.length > 60 ? h('p', { class: 'muted small' }, `… et ${list.length - 60} autre(s).`) : null);
  }

  function filesTable(list, type, { site = false } = {}) {
    const rows = list.filter((f) => f.type === type);
    if (!rows.length) return h('p', { class: 'muted' }, 'Aucun fichier mesuré.');
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Fichier'), h('th', { class: 'num', title: 'Taille décompressée' }, 'Taille'), h('th', { class: 'num' }, 'Transféré'),
        h('th', { class: 'num' }, site ? 'Inutilisé (moyenne)' : 'Inutilisé'), site ? h('th', { class: 'num', title: 'Part inutilisée même sur la page qui en utilise le plus' }, 'Inutilisé partout') : null, site ? h('th', { class: 'num' }, 'Pages') : null)),
      h('tbody', {}, rows.slice(0, 60).map((f) => {
        const ratio = f.unusedRatio;
        return h('tr', {},
          h('td', { class: 'url small' }, fileLink(f.url)),
          h('td', { class: 'num' }, fmtBytes(f.total)),
          h('td', { class: 'num' }, fmtBytes(f.transfer)),
          h('td', { class: 'num' }, h('span', { class: `badge ${ratio >= 0.8 ? 'bad' : ratio >= 0.5 ? 'warn' : 'ok'}` }, fmtPct(ratio)), site ? null : h('div', { class: 'muted small' }, fmtBytes(f.total - f.used))),
          site ? h('td', { class: 'num' }, fmtPct(f.unusedEverywhere)) : null,
          site ? h('td', { class: 'num' }, f.pages) : null);
      }))));
  }

  function diagnosticSummary(sm, extra = []) {
    const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
    return h('div', { class: 'grid stats' },
      stat(fmtBytes(sm.cssUnused ?? sm.cssUnusedEverywhere), `CSS inutilisé sur ${fmtBytes(sm.cssTotal)}`),
      stat(fmtBytes(sm.jsUnused ?? sm.jsUnusedEverywhere), `JavaScript inutilisé sur ${fmtBytes(sm.jsTotal)}`),
      stat(sm.imagesOversized, 'images trop grandes'),
      stat(fmtBytes(sm.imagesSavings), 'gain estimé sur les images'),
      extra);
  }

  async function tabDiagnostic(body, d) {
    const s = d.site;
    const g = await api('GET', `/sites/${s.id}/diagnostics`);
    if (!g.pages) { put(body, h('div', { class: 'card empty' }, 'Aucun diagnostic : il est produit à chaque compilation.')); return; }
    put(body, ...[
      h('p', { class: 'muted' }, `Dernière compilation de chacune des ${g.pages} page(s). Un fichier ou une image présents sur plusieurs pages ne comptent qu'une fois.`),
      diagnosticSummary(g.summary),
      g.summary.bfcacheBlocked ? h('div', { class: 'notice warn' }, `Cache avant/arrière désactivé sur ${g.summary.bfcacheBlocked} page(s) : le retour en arrière recharge la page au lieu d'être instantané. Cause : `, g.summary.bfcacheBlockers.join(' ; '), '.') : null,
      h('div', { class: 'card' }, h('h2', {}, 'Images'),
        h('p', { class: 'muted small' }, `Largeur utile = largeur affichée × densité d'écran (2,6 sur mobile, 1 sur ordinateur). Gain estimé au prorata des pixels en trop, à format égal.`),
        imagesTable(g.images, { withPages: true })),
      h('div', { class: 'card' }, h('h2', {}, 'CSS'), h('p', { class: 'muted small' }, 'Part des règles jamais appliquées, menu et slider compris. « Inutilisé partout » : candidat au retrait sur tout le site.'), filesTable(g.files, 'css', { site: true })),
      h('div', { class: 'card' }, h('h2', {}, 'JavaScript'), h('p', { class: 'muted small' }, 'Part du code jamais exécutée pendant le chargement, le défilement, le menu et le slider. Un code d\'interaction plus rare (formulaire, popup) peut apparaître inutilisé.'), filesTable(g.files, 'js', { site: true }))]);
  }

  async function compilationDetail(body, s, id) {
    const { compilation: c, files } = await api('GET', `/sites/${s.id}/compilations/${id}`);
    const w = c.weights || {};
    const res = c.resources?.reference?.mobile || [];
    const byType = (pred) => res.filter(pred).sort((a, b) => b.bytes - a.bytes);
    const isImg = (r) => r.type === 'image' || /^image\//.test(r.mime);
    // Références d'abord, puis chaque essai : version compilée et différences.
    const shots = files.filter((f) => f.endsWith('.png')).sort((a, b) => (a.includes('/') - b.includes('/')) || a.localeCompare(b));
    put(body, 
      h('p', {}, h('a', { href: `#/sites/${s.id}/history` }, '← Historique')),
      h('div', { class: 'card' },
        h('h2', {}, pathOf(c.url)),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Résultat'), h('dd', {}, statusBadge(c.status), c.reason ? h('div', {}, c.reason) : null),
          h('dt', {}, 'Date'), h('dd', {}, fmtDate(c.created_at), c.duration_ms ? ` · ${Math.round(c.duration_ms / 1000)} s` : ''),
          h('dt', {}, 'LCP (mobile bridé)'), h('dd', {}, fmtMs(c.lcp_reference), ' → ', fmtMs(c.lcp_candidate)),
          h('dt', {}, 'CLS (mobile bridé)'), h('dd', {}, fmtCls(c.cls_reference), ' → ', fmtCls(c.cls_candidate)),
          h('dt', {}, 'Optimisations'), h('dd', {}, c.families_applied.join(', ') || '—', c.families_disabled.length ? h('div', { class: 'small' }, `Désactivées : ${c.families_disabled.join(', ')}`) : null),
          h('dt', {}, 'Envoi au site'), h('dd', {}, c.published == null ? '—' : c.published ? 'reçu par WordPress' : 'refusé ou injoignable'),
          h('dt', {}, 'Tâche'), h('dd', { class: 'mono' }, c.job_id || '—'))),
      c.attempts.length ? h('div', { class: 'card' }, h('h2', {}, 'Essais'), h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Optimisations actives'), h('th', {}, 'Résultat'), h('th', {}, 'Écarts'))),
        h('tbody', {}, c.attempts.map((a) => h('tr', {}, h('td', {}, a.attempt), h('td', { class: 'small' }, (a.families || []).join(', ') || 'aucune (contrôle de départ)'),
          h('td', {}, a.ok ? h('span', { class: 'badge ok' }, 'identique') : h('span', { class: 'badge bad' }, 'différent')),
          h('td', { class: 'small' }, (a.failures || []).map((f) => h('div', {}, `${f.type}${f.viewport ? ` (${f.viewport})` : ''} : ${f.detail || ''}`))))))))) : null,
      w.reference ? h('div', { class: 'card' }, h('h2', {}, 'Poids de la page (mobile)'),
        h('div', { class: 'split' },
          h('div', {}, h('dl', { class: 'kv' },
            h('dt', {}, 'À l\'ouverture'), h('dd', {}, fmtBytes(w.reference.mobile.initial), ` (${w.reference.mobile.initialRequests} requêtes)`, w.compiled ? [' → ', fmtBytes(w.compiled.mobile.initial), ` (${w.compiled.mobile.initialRequests})`] : null),
            h('dt', {}, 'Page entière'), h('dd', {}, fmtBytes(w.reference.mobile.total), ` (${w.reference.mobile.requests} requêtes)`, w.compiled ? [' → ', fmtBytes(w.compiled.mobile.total)] : null),
            h('dt', {}, 'Ordinateur'), h('dd', {}, fmtBytes(w.reference.desktop?.total))),
          h('p', { class: 'muted small' }, 'Octets transférés. « À l\'ouverture » : avant tout défilement ; « page entière » : après défilement jusqu\'en bas.')),
          weightBars(w.reference.mobile, w.compiled?.mobile))) : null,
      c.diagnostics ? h('div', { class: 'card' }, h('h2', {}, 'Diagnostic'),
        diagnosticSummary(c.diagnostics.summary, h('div', { class: 'stat' }, h('div', { class: 'v' }, c.diagnostics.summary.duplicates), h('div', { class: 'l' }, 'images en plusieurs exemplaires'))),
        c.diagnostics.bfcache && !c.diagnostics.bfcache.eligible ? h('div', { class: 'notice warn' }, 'Cache avant/arrière désactivé : ', c.diagnostics.bfcache.blockers.join(' ; '), '.') : null,
        h('h3', {}, 'Images'), imagesTable(c.diagnostics.images),
        c.diagnostics.duplicates.length ? [h('h3', {}, 'Même image chargée plusieurs fois'), h('ul', { class: 'small' }, c.diagnostics.duplicates.map((dup) => h('li', {}, `${dup.files.length} fichiers, ${fmtBytes(dup.bytes)} : `, dup.files.map((f, i) => [i ? ', ' : '', fileLink(f)]))))] : null,
        h('h3', {}, 'CSS'), filesTable(c.diagnostics.files, 'css'),
        h('h3', {}, 'JavaScript'), filesTable(c.diagnostics.files, 'js')) : null,
      res.length ? h('div', { class: 'card' }, h('h2', {}, 'Fichiers chargés (original, mobile)'),
        resourceTable('Images', byType(isImg)), resourceTable('CSS', byType((r) => r.type === 'stylesheet')), resourceTable('JavaScript', byType((r) => r.type === 'script')),
        resourceTable('Polices', byType((r) => r.type === 'font'))) : (c.weights ? h('div', { class: 'notice' }, 'Le détail fichier par fichier est conservé 90 jours.') : null),
      shots.length ? h('div', { class: 'card' }, h('h2', {}, 'Captures'),
        h('div', { class: 'shots' }, shots.map((f) => {
          const src = `/admin/api/sites/${s.id}/compilations/${c.id}/files/${f.split('/').map(encodeURIComponent).join('/')}`;
          return h('a', { class: 'shot', href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: f, loading: 'lazy' }), h('div', { class: 'cap' }, f));
        }))) : null);
  }

  const FIELD_LABELS = {
    LARGEST_CONTENTFUL_PAINT_MS: ['LCP', 'ms'], INTERACTION_TO_NEXT_PAINT: ['INP', 'ms'], CUMULATIVE_LAYOUT_SHIFT_SCORE: ['CLS', 'cls'],
    FIRST_CONTENTFUL_PAINT_MS: ['FCP', 'ms'], EXPERIMENTAL_TIME_TO_FIRST_BYTE: ['TTFB', 'ms'],
  };
  const CAT = { FAST: ['bon', 'ok'], AVERAGE: ['moyen', 'warn'], SLOW: ['lent', 'bad'] };
  function fieldCell(field) {
    const data = field?.page || field?.origin;
    if (!data) return h('span', { class: 'muted small' }, 'pas assez de trafic');
    return h('div', { class: 'small' }, field.page ? null : h('div', { class: 'muted' }, 'site entier'),
      Object.entries(data.metrics).filter(([k]) => FIELD_LABELS[k]).map(([k, m]) => {
        const [label, unit] = FIELD_LABELS[k];
        const v = unit === 'cls' ? num(m.percentile / 100, 2) : fmtMs(m.percentile);
        const [cl, cc] = CAT[m.category] || [m.category || '', 'neutral'];
        return h('div', {}, `${label} ${v} `, h('span', { class: `badge ${cc}` }, cl));
      }));
  }

  async function tabPageSpeed(body, d) {
    const s = d.site;
    if (!d.pagespeedConfigured) {
      put(body, h('div', { class: 'notice warn' }, 'Clé PageSpeed non configurée. ', state.user.role === 'admin' ? h('a', { href: '#/settings' }, 'La saisir dans Réglages.') : 'Demandez-la à un administrateur.'));
    }
    const url = h('input', { type: 'url', value: `https://${s.domains[0]}/`, 'aria-label': 'Adresse à analyser' });
    if (state.user.role !== 'viewer') {
      put(body, h('div', { class: 'card' }, h('h2', {}, 'Lancer une analyse'),
        h('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); runPageSpeed(s.id, url.value); later(() => viewSite(s.id, 'pagespeed'), 600); } },
          url, h('button', { class: 'btn primary', type: 'submit', disabled: !d.pagespeedConfigured }, 'Analyser (mobile + ordinateur)')),
        h('p', { class: 'muted small' }, 'Mesures de laboratoire de Google (Lighthouse) et, si le site a assez de visiteurs, données réelles du rapport CrUX.')));
    }
    const { items } = await api('GET', `/sites/${s.id}/pagespeed`);
    if (!items.length) { put(body, h('div', { class: 'card empty' }, 'Aucune analyse PageSpeed.')); return; }
    const m = (r, k) => r.metrics?.[k]?.display || '—';
    put(body, h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Page'), h('th', {}, 'Appareil'), h('th', { class: 'num' }, 'Score'),
        h('th', { class: 'num' }, 'FCP'), h('th', { class: 'num' }, 'LCP'), h('th', { class: 'num' }, 'CLS'), h('th', { class: 'num' }, 'TBT'), h('th', {}, 'Visiteurs réels (p75)'), h('th', {}, ''))),
      h('tbody', {}, items.map((r) => h('tr', {},
        h('td', { class: 'small' }, fmtDate(r.created_at)),
        h('td', { class: 'url small' }, pathOf(r.url)),
        h('td', {}, r.strategy === 'mobile' ? 'Mobile' : 'Ordinateur'),
        h('td', { class: 'num' }, r.status === 'done' ? scoreBadge(r.score) : statusBadge(r.status), r.error ? h('div', { class: 'muted small' }, r.error) : null),
        h('td', { class: 'num' }, m(r, 'fcp')), h('td', { class: 'num' }, m(r, 'lcp')), h('td', { class: 'num' }, m(r, 'cls')), h('td', { class: 'num' }, m(r, 'tbt')),
        h('td', {}, r.status === 'done' ? fieldCell(r.field) : null),
        h('td', {}, h('a', { href: r.reportUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small' }, 'PageSpeed Insights ↗')))))))));
    if (items.some((r) => r.status === 'pending')) later(() => viewSite(s.id, 'pagespeed'), 5000);
  }

  /* ---------- Visiteurs réels (CrUX) ---------- */
  const CRUX = [['lcp', 'LCP', 'ms'], ['inp', 'INP', 'ms'], ['cls', 'CLS', 'cls'], ['fcp', 'FCP', 'ms'], ['ttfb', 'TTFB', 'ms']];
  const CRUX_T = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] };
  const RATE = { good: ['bon', 'ok'], average: ['à améliorer', 'warn'], poor: ['mauvais', 'bad'] };
  const rate = (k, v) => (v == null ? null : v <= CRUX_T[k][0] ? 'good' : v > CRUX_T[k][1] ? 'poor' : 'average');

  function sparkline(values, k) {
    const NS = 'http://www.w3.org/2000/svg';
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 160 40'); svg.setAttribute('width', '160'); svg.setAttribute('height', '40');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Évolution du 75e centile');
    if (pts.length < 2) return svg;
    const max = Math.max(...pts.map(([, v]) => v), CRUX_T[k][1]);
    const x = (i) => (i / (values.length - 1)) * 156 + 2;
    const y = (v) => 38 - (v / max) * 34;
    const good = document.createElementNS(NS, 'line');
    good.setAttribute('x1', 2); good.setAttribute('x2', 158); good.setAttribute('y1', y(CRUX_T[k][0])); good.setAttribute('y2', y(CRUX_T[k][0]));
    good.setAttribute('class', 'spark-threshold');
    const path = document.createElementNS(NS, 'polyline');
    path.setAttribute('points', pts.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '));
    path.setAttribute('class', 'spark-line');
    svg.append(good, path);
    return svg;
  }

  async function tabCrux(body, d) {
    const s = d.site;
    const r = await api('GET', `/sites/${s.id}/crux`);
    const refresh = async (btn) => {
      btn.disabled = true; btn.textContent = 'Interrogation de Google…';
      try { await api('POST', `/sites/${s.id}/crux`); viewSite(s.id, 'crux'); } catch (err) { toast(errorText(err)); btn.disabled = false; }
    };
    put(body, h('div', { class: 'card' }, h('h2', {}, 'Visiteurs réels (rapport CrUX de Google)'),
      h('p', { class: 'muted' }, `75e centile des visiteurs Chrome sur le site entier (${s.domains[0]}), par période de 28 jours. Mise à jour de Google chaque semaine ; les effets d'une compilation apparaissent donc progressivement.`),
      !r.configured ? h('div', { class: 'notice warn' }, 'Clé d\'API Google non configurée (Réglages). Elle doit aussi avoir accès à l\'API « Chrome UX Report ».') : null,
      state.user.role !== 'viewer' ? h('button', { class: 'btn primary', disabled: !r.configured, onclick: (e) => refresh(e.currentTarget) }, 'Actualiser') : null));
    const rum = await api('GET', `/sites/${s.id}/rum`);
    const rumCard = h('div', { class: 'card' }, h('h2', {}, 'Mesure des visiteurs du site (28 derniers jours)'));
    if (!rum.enabled) put(rumCard, h('p', { class: 'muted' }, 'Option désactivée pour ce site (Réglages du site). Elle complète CrUX pour les sites qui ont peu de trafic.'));
    else if (!rum.publicUrl) put(rumCard, h('div', { class: 'notice warn' }, 'Variable PUBLIC_URL absente : le service ne connaît pas son adresse publique et ne peut pas recevoir les mesures.'));
    else if (!rum.byDevice.length) put(rumCard, h('p', { class: 'muted' }, 'Aucune mesure reçue pour l\'instant. Elles arrivent après la prochaine compilation des pages.'));
    else {
      const fmtR = (k, v) => (v == null ? '—' : k === 'cls' ? num(v, 2) : fmtMs(v));
      put(rumCard, h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Appareil'), h('th', { class: 'num' }, 'Visites'), ...CRUX.filter(([k]) => k !== 'fcp').map(([, l]) => h('th', { class: 'num' }, `${l} p75`)), h('th', { class: 'num' }, 'Rendu anticipé'))),
        h('tbody', {}, rum.byDevice.map((r) => h('tr', {}, h('td', {}, r.device === 'mobile' ? 'Mobile' : 'Ordinateur'), h('td', { class: 'num' }, r.n),
          ...CRUX.filter(([k]) => k !== 'fcp').map(([k]) => { const rt = RATE[rate(k, r[k])]; return h('td', { class: 'num' }, fmtR(k, r[k]), rt ? [' ', h('span', { class: `badge ${rt[1]}` }, rt[0])] : null); }),
          h('td', { class: 'num' }, fmtPct(r.prerendered || 0))))))),
      rum.pages.length ? [h('h3', {}, 'Pages les plus lentes (LCP p75, 5 visites minimum)'), h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Page'), h('th', { class: 'num' }, 'Visites'), h('th', { class: 'num' }, 'LCP'), h('th', { class: 'num' }, 'CLS'), h('th', { class: 'num' }, 'INP'))),
        h('tbody', {}, rum.pages.map((p) => h('tr', {}, h('td', { class: 'url small' }, p.path), h('td', { class: 'num' }, p.n), h('td', { class: 'num' }, fmtR('lcp', p.lcp)), h('td', { class: 'num' }, fmtR('cls', p.cls)), h('td', { class: 'num' }, fmtR('inp', p.inp)))))))] : null);
    }
    put(body, rumCard);
    if (!r.items.length) { put(body, h('div', { class: 'card empty' }, 'Aucun relevé CrUX. Cliquez sur « Actualiser ».')); return; }
    for (const snap of r.items) {
      const label = snap.form_factor === 'PHONE' ? 'Mobile' : 'Ordinateur';
      const card = h('div', { class: 'card' }, h('h2', {}, `${label} · relevé du ${fmtDate(snap.created_at)}`));
      if (snap.error) put(card, h('div', { class: 'notice bad' }, snap.error));
      else if (snap.data?.noData || !snap.data?.periods?.length) put(card, h('p', { class: 'muted' }, 'Pas assez de trafic Chrome pour que Google publie des données sur ce site.'));
      else {
        const p = snap.data.periods;
        put(card, h('p', { class: 'muted small' }, `Dernière période : du ${p.at(-1).first} au ${p.at(-1).last} · ${p.length} périodes`),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Mesure'), h('th', { class: 'num' }, 'Actuel (p75)'), h('th', {}, 'Appréciation'), h('th', { class: 'num' }, 'Il y a 3 mois'), h('th', {}, 'Évolution'))),
            h('tbody', {}, CRUX.filter(([k]) => snap.data.metrics[k]).map(([k, l, unit]) => {
              const series = snap.data.metrics[k];
              const last = series.at(-1);
              const before = series.length > 13 ? series.at(-14) : null;
              const fmt = (v) => (v == null ? '—' : unit === 'cls' ? num(v, 2) : fmtMs(v));
              const rt = RATE[rate(k, last)];
              return h('tr', {}, h('td', {}, l), h('td', { class: 'num' }, fmt(last)), h('td', {}, rt ? h('span', { class: `badge ${rt[1]}` }, rt[0]) : '—'),
                h('td', { class: 'num' }, fmt(before)), h('td', {}, sparkline(series, k)));
            })))));
      }
      put(body, card);
    }
  }

  function pairingBox(siteId, pairing) {
    const until = new Date(pairing.expires);
    const left = h('span');
    const tick = () => {
      const sec = Math.max(0, Math.round((until - Date.now()) / 1000));
      left.textContent = sec ? `expire dans ${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} s` : 'expiré : générez un nouveau code';
      if (sec) later(tick, 1000);
    };
    tick();
    return h('div', {},
      h('div', { class: 'code-box' }, h('span', { class: 'code', 'aria-label': 'Code d\'appairage' }, pairing.code),
        h('button', { class: 'btn small', onclick: () => navigator.clipboard?.writeText(pairing.code).then(() => toast('Code copié.')) }, 'Copier'),
        h('span', { class: 'muted' }, left)),
      h('ol', { class: 'steps' },
        h('li', {}, 'Dans le WordPress du site, installez et activez l\'extension Page Compiler.'),
        h('li', {}, 'Ouvrez Réglages › Page Compiler, section « Associer ce site au service ».'),
        h('li', {}, ['Saisissez l\'adresse du service (', h('span', { class: 'mono' }, location.origin), ') et ce code, puis cliquez sur « Associer ».']),
        h('li', {}, 'Le site reçoit son identifiant et sa clé : rien à copier dans wp-config.php.')),
      h('p', { class: 'muted small' }, 'Code à usage unique. Le domaine du WordPress doit faire partie des domaines du site.'));
  }

  async function tabPairing(body, d) {
    const s = d.site;
    const stored = sessionStorage.getItem(`pairing:${s.id}`);
    const fresh = stored ? JSON.parse(stored) : null;
    if (fresh) sessionStorage.removeItem(`pairing:${s.id}`);
    const box = h('div');
    const generate = async () => {
      try { box.replaceChildren(pairingBox(s.id, await api('POST', `/sites/${s.id}/pairing`))); } catch (err) { toast(errorText(err)); }
    };
    if (fresh) box.append(pairingBox(s.id, fresh));
    const canEdit = state.user.role !== 'viewer';
    put(body, h('div', { class: 'card' },
      h('h2', {}, 'Appairage avec WordPress'),
      s.pairedAt ? h('div', { class: 'notice ok' }, `Site appairé le ${fmtDate(s.pairedAt)}`, s.pluginVersion ? ` (extension ${s.pluginVersion})` : '', '. Adresse de réception : ', h('span', { class: 'mono' }, s.callbackUrl || '—'))
        : h('div', { class: 'notice' }, d.pairingPending && !fresh ? `Un code est en attente (expire à ${fmtDate(d.pairingPending.expires_at)}). Pour l'afficher de nouveau, générez-en un autre.` : 'Ce site n\'est pas encore appairé.'),
      box,
      canEdit ? h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: generate }, s.pairedAt ? 'Générer un code (réappairer)' : 'Générer un code d\'appairage')) : null));

    if (state.user.role === 'admin') {
      const pwd = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Votre mot de passe' });
      const out = h('div');
      put(body, h('div', { class: 'card' },
        h('h2', {}, 'Clé du site'),
        h('p', {}, 'Changer la clé coupe immédiatement le site : il faudra le réappairer avec le nouveau code affiché.'),
        h('div', { class: 'actions' }, h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!confirm('Changer la clé ? Le site ne pourra plus communiquer avec le service tant qu\'il n\'est pas réappairé.')) return;
            const r = await api('POST', `/sites/${s.id}/rotate-secret`).catch((e) => { toast(errorText(e)); return null; });
            if (r) box.replaceChildren(pairingBox(s.id, r.pairing));
          },
        }, 'Changer la clé')),
        h('h3', {}, 'Configuration manuelle'),
        h('p', { class: 'muted small' }, 'Sans appairage : afficher la clé pour la placer dans wp-config.php (action journalisée).'),
        h('form', { class: 'inline-form', onsubmit: async (e) => {
          e.preventDefault();
          try {
            const r = await api('POST', `/sites/${s.id}/reveal-secret`, { password: pwd.value });
            out.replaceChildren(h('pre', { class: 'mono notice' }, `define( 'PAGE_COMPILER_SECRET', '${r.secret}' );\n// Identifiant du site à saisir dans les réglages : ${s.id}`));
            pwd.value = '';
          } catch (err) { out.replaceChildren(h('div', { class: 'notice bad' }, errorText(err))); }
        } }, pwd, h('button', { class: 'btn', type: 'submit' }, 'Afficher la clé')), out));
    }
  }

  async function tabSiteSettings(body, d) {
    const s = d.site;
    const clients = await api('GET', '/clients');
    const canEdit = state.user.role !== 'viewer';
    const f = {
      name: h('input', { type: 'text', id: 'sname', value: s.name }),
      client: h('select', { id: 'sclient' }, h('option', { value: '' }, '— Sans client —'), clients.map((c) => h('option', { value: c.id, selected: c.id === s.clientId }, c.name))),
      domains: h('input', { type: 'text', id: 'sdomains', value: s.domains.join(' ') }),
      callback: h('input', { type: 'url', id: 'scallback', value: s.callbackUrl || '', placeholder: `https://${s.domains[0]}/wp-json/page-compiler/v1/receive` }),
      nav: h('select', { id: 'snav' }, h('option', { value: '' }, 'Par défaut du service'), h('option', { value: 'prerender', selected: s.options.navigation_mode === 'prerender' }, 'Rendu anticipé (page suivante instantanée)'), h('option', { value: 'prefetch', selected: s.options.navigation_mode === 'prefetch' }, 'Préchargement du HTML seulement')),
      rum: h('input', { type: 'checkbox', id: 'srum', checked: Boolean(s.options.rum) }),
      families: FAMILY_LABELS.map(([k, l]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: (s.options.families || {})[k] !== false }), ` ${l}`)),
      status: h('select', { id: 'sstatus' }, h('option', { value: 'active', selected: s.status === 'active' }, 'Actif'), h('option', { value: 'paused', selected: s.status === 'paused' }, 'En pause (aucune compilation)')),
    };
    const msg = h('div');
    put(body, h('div', { class: 'card' }, msg, h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const families = Object.fromEntries(f.families.map((lab) => { const i = lab.querySelector('input'); return [i.value, i.checked]; }));
          await api('PUT', `/sites/${s.id}`, { name: f.name.value, clientId: f.client.value ? Number(f.client.value) : null, domains: f.domains.value, callbackUrl: f.callback.value, status: f.status.value, options: { navigation_mode: f.nav.value || null, families, rum: f.rum.checked } });
          toast('Site enregistré.');
          viewSite(s.id, 'settings');
        } catch (err) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText(err))); }
      },
    },
    h('div', { class: 'row' }, h('label', { for: 'sname' }, 'Nom'), f.name),
    h('div', { class: 'row' }, h('label', { for: 'sclient' }, 'Client'), f.client),
    h('div', { class: 'row' }, h('label', { for: 'sdomains' }, 'Domaines'), f.domains),
    h('div', { class: 'row' }, h('label', { for: 'scallback' }, 'Adresse de réception ', h('span', { class: 'hint' }, '— remplie automatiquement à l\'appairage')), f.callback),
    h('div', { class: 'row' }, h('label', { for: 'sstatus' }, 'État'), f.status),
    h('div', { class: 'row' }, h('label', { for: 'snav' }, 'Navigation entre les pages'), f.nav,
      h('span', { class: 'hint' }, 'Le rendu anticipé affiche la page suivante instantanément ; certains anciens scripts de statistiques peuvent compter la page dès son préchargement.')),
    h('div', { class: 'row' }, h('label', { class: 'check', for: 'srum' }, f.rum, ' Mesure des visiteurs (LCP, CLS, INP, TTFB envoyés par les navigateurs)'),
      h('span', { class: 'hint' }, 'Sans cookie ni identifiant ; le service n\'enregistre ni l\'IP ni l\'adresse complète. À valider avec la politique de confidentialité du client avant activation. Prend effet à la prochaine compilation.')),
    h('fieldset', { class: 'row' }, h('legend', {}, 'Optimisations appliquées à ce site'), h('div', { class: 'checks' }, f.families),
      h('span', { class: 'hint' }, 'Décocher une optimisation qui pose problème sur ce site ; elle s\'appliquera dès la prochaine compilation.')),
    canEdit ? h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer') : null)));
    if (state.user.role === 'admin') {
      put(body, h('div', { class: 'card' }, h('h2', {}, 'Supprimer le site'),
        h('p', { class: 'muted' }, 'Le site ne pourra plus demander de compilations. L\'historique est conservé selon la durée habituelle.'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!confirm(`Supprimer le site ${s.name} (${s.id}) ?`)) return;
          await api('DELETE', `/sites/${s.id}`).then(() => { toast('Site supprimé.'); location.hash = '#/'; }).catch((e2) => toast(errorText(e2)));
        } }, 'Supprimer le site')));
    }
  }

  /* ---------- Clients ---------- */
  async function viewClients() {
    loading();
    const clients = await api('GET', '/clients');
    const name = h('input', { type: 'text', placeholder: 'Nom du client', 'aria-label': 'Nom du nouveau client' });
    const isAdmin = state.user.role === 'admin';
    layout([
      pageHead('Clients', 'Les sites sont regroupés par client dans le tableau de bord.'),
      isAdmin ? h('div', { class: 'card' }, h('form', { class: 'inline-form', onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/clients', { name: name.value }); toast('Client ajouté.'); viewClients(); } catch (err) { toast(errorText(err)); }
      } }, name, h('button', { class: 'btn primary', type: 'submit' }, 'Ajouter'))) : null,
      h('div', { class: 'card flush' }, clients.length ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Client'), h('th', { class: 'num' }, 'Sites'), h('th', {}, 'Créé le'), h('th', {}, ''))),
        h('tbody', {}, clients.map((c) => h('tr', {},
          h('td', {}, c.name), h('td', { class: 'num' }, c.sites), h('td', { class: 'small' }, fmtDate(c.created_at)),
          h('td', {}, isAdmin ? h('div', { class: 'actions' },
            h('button', { class: 'btn small', onclick: async () => {
              const n = prompt('Nouveau nom du client', c.name);
              if (n && n !== c.name) await api('PUT', `/clients/${c.id}`, { name: n }).then(viewClients).catch((e) => toast(errorText(e)));
            } }, 'Renommer'),
            h('button', { class: 'btn small danger', onclick: async () => {
              if (confirm(`Supprimer le client ${c.name} ? Ses sites restent, sans client.`)) await api('DELETE', `/clients/${c.id}`).then(viewClients).catch((e) => toast(errorText(e)));
            } }, 'Supprimer')) : null)))))
        : h('div', { class: 'empty' }, 'Aucun client.')),
    ]);
  }

  /* ---------- Réglages ---------- */
  async function viewSettings() {
    loading();
    const s = await api('GET', '/settings');
    const key = h('input', { type: 'password', id: 'psikey', autocomplete: 'off', placeholder: s.pagespeed.configured ? `•••• ${s.pagespeed.last4}` : 'AIza…' });
    const importOut = h('div');
    layout([
      pageHead('Réglages'),
      h('div', { class: 'card' }, h('h2', {}, 'PageSpeed Insights'),
        s.pagespeed.fromEnvironment ? h('div', { class: 'notice' }, 'La clé est définie par la variable PAGESPEED_API_KEY : elle l\'emporte sur celle saisie ici.') : null,
        h('p', {}, 'Clé d\'API Google, gratuite. Elle se crée depuis la page « Get started » de la documentation PageSpeed Insights, ou dans la console Google Cloud.'),
        h('p', {}, h('a', { href: 'https://developers.google.com/speed/docs/insights/v5/get-started', target: '_blank', rel: 'noopener noreferrer' }, 'Documentation PageSpeed Insights API ↗')),
        h('form', { class: 'inline-form', onsubmit: async (e) => {
          e.preventDefault();
          await api('PUT', '/settings', { pagespeedApiKey: key.value }).then(() => { toast(key.value ? 'Clé enregistrée (chiffrée).' : 'Clé supprimée.'); viewSettings(); }).catch((err) => toast(errorText(err)));
        } }, key, h('button', { class: 'btn primary', type: 'submit' }, 'Enregistrer')),
        h('p', { class: 'muted small' }, 'Laisser vide et enregistrer pour supprimer la clé. Les analyses ne se lancent qu\'à la demande.')),
      h('div', { class: 'card' }, h('h2', {}, 'Sites définis dans SITES_YAML'),
        s.yamlSites.length ? [
          h('p', {}, 'Ces sites peuvent être repris dans la base : même identifiant et même clé, donc rien à refaire dans WordPress. Une fois importés, retirez-les de SITES_YAML.'),
          h('ul', {}, s.yamlSites.map((y) => h('li', {}, h('span', { class: 'mono' }, y.id), ` — ${y.domains.join(', ')}`, y.hasSecret ? '' : ' (secret absent : non importable)'))),
          h('button', { class: 'btn primary', onclick: async () => {
            const r = await api('POST', '/settings/import-yaml').catch((e) => { toast(errorText(e)); return null; });
            if (r) importOut.replaceChildren(h('div', { class: 'notice ok' }, `Importés : ${r.imported.join(', ') || 'aucun'}.`, r.skipped.length ? ` Ignorés : ${r.skipped.map((x) => `${x.id} (${x.reason})`).join(', ')}.` : ''));
          } }, 'Importer dans la base'), importOut]
          : h('p', { class: 'muted' }, 'Aucun site défini dans SITES_YAML.')),
    ]);
  }

  async function viewAudit() {
    loading();
    const { items } = await api('GET', '/audit');
    const LABELS = {
      login: 'Connexion', site_created: 'Site créé', site_updated: 'Site modifié', site_deleted: 'Site supprimé', site_paired: 'Site appairé',
      pairing_code_created: 'Code d\'appairage créé', secret_rotated: 'Clé changée', secret_revealed: 'Clé affichée', client_created: 'Client créé',
      client_updated: 'Client modifié', client_deleted: 'Client supprimé', password_changed: 'Mot de passe changé', pagespeed_key_updated: 'Clé PageSpeed modifiée',
      yaml_imported: 'Import SITES_YAML', compile_requested: 'Compilation demandée',
    };
    layout([pageHead('Journal', 'Les 100 dernières actions d\'administration.'),
      h('div', { class: 'card flush' }, h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Compte'), h('th', {}, 'Action'), h('th', {}, 'Cible'))),
        h('tbody', {}, items.map((a) => h('tr', {}, h('td', { class: 'small' }, fmtDate(a.created_at)), h('td', { class: 'small' }, a.email || 'WordPress'),
          h('td', {}, LABELS[a.action] || a.action), h('td', { class: 'mono' }, a.target || '—')))))))]);
  }

  async function viewAccount() {
    const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', id: 'next', autocomplete: 'new-password', minlength: 10 });
    const msg = h('div');
    layout([pageHead('Mon compte', `${state.user.email} · rôle ${state.user.role}`), h('div', { class: 'card' }, h('h2', {}, 'Changer le mot de passe'), msg,
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('PUT', '/account/password', { current: cur.value, next: next.value });
          msg.replaceChildren(h('div', { class: 'notice ok' }, 'Mot de passe changé. Vos autres sessions ont été fermées.'));
          cur.value = ''; next.value = '';
        } catch (err) { msg.replaceChildren(h('div', { class: 'notice bad' }, errorText(err))); }
      } }, h('div', { class: 'row' }, h('label', { for: 'cur' }, 'Mot de passe actuel'), cur),
      h('div', { class: 'row' }, h('label', { for: 'next' }, 'Nouveau mot de passe ', h('span', { class: 'hint' }, '— 10 caractères minimum')), next),
      h('button', { class: 'btn primary', type: 'submit' }, 'Changer')))]);
  }

  /* ---------- Routage ---------- */
  async function route() {
    clearTimers();
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'login') return viewLogin();
    if (!state.user) {
      try {
        const me = await api('GET', '/me');
        state.user = me.user; state.csrf = me.csrf;
      } catch { return undefined; }
    }
    try {
      if (!parts.length) return await viewDashboard();
      if (parts[0] === 'sites' && parts[1] === 'new') return await viewNewSite();
      if (parts[0] === 'sites' && parts[1]) {
        const fresh = sessionStorage.getItem(`pairing:${parts[1]}`);
        return await viewSite(parts[1], parts[2] || (fresh ? 'pairing' : 'pages'), parts[3] || null);
      }
      if (parts[0] === 'clients') return await viewClients();
      if (parts[0] === 'settings') return await viewSettings();
      if (parts[0] === 'audit') return await viewAudit();
      if (parts[0] === 'account') return await viewAccount();
      return await viewDashboard();
    } catch (err) {
      if (state.user) layout(h('div', { class: 'notice bad' }, errorText(err)));
      return undefined;
    }
  }
  window.addEventListener('hashchange', route);
  route();
})();
