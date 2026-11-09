# Service de compilation

Service central qui rend, optimise et **vérifie** les pages des sites WordPress/Elementor avant de renvoyer une version optimisée au plugin du site. Une page n'est publiée que si elle est visuellement identique à l'original, que ses interactions fonctionnent, que son SEO est intact et qu'elle n'est pas plus lente.

Ce dépôt contient la partie « service » de l'architecture décrite dans le cahier des charges. Le plugin WordPress (états des pages, service des pages compilées, réception) est livré dans le dépôt `page-compiler-plugin`, qui implémente le contrat décrit plus bas.

## Fonctionnement

```
Plugin du site ──(1. demande signée)──▶ API ──▶ File d'attente (Redis, 3 compilations max)
                                                     │
                                                     ▼
                                          Worker : pour chaque page
                                          a. rendu de référence (mobile + desktop)
                                          b. mesure du bruit (2e rendu de l'original)
                                          c. LCP de référence en conditions bridées
                                          d. optimisation par familles
                                          e. vérification de la version candidate
                                          f. isolation de la famille fautive si échec
                                                     │
Plugin du site ◀──(2. résultat signé : HTML ou échec)──┘
```

### Plafond de 3 compilations simultanées

Chaque compilation ouvre un Chromium. La file applique une **concurrence globale** (`CHROMIUM_CONCURRENCY`, 3 par défaut) : quel que soit le nombre de workers déployés, au plus 3 compilations tournent en même temps. Les demandes suivantes attendent leur tour. Ce plafond est vérifié par un test de bout en bout avec deux workers.

Les demandes répétées pour une même page pendant `DEBOUNCE_MS` (30 s par défaut) sont fusionnées : enregistrer cinq fois une page ne lance qu'une compilation.

**Une seule compilation à la fois par site.** Les 3 places servent à des sites différents : une page dont le site est déjà en cours de compilation repasse en attente (`SITE_RETRY_DELAY_MS`, 5 s par défaut) et laisse sa place à un autre site. Un site n'est donc jamais visité par plusieurs Chromium en même temps, ce qui évite de déclencher son pare-feu ou sa limite de requêtes (symptôme : `ERR_CONNECTION_REFUSED`). Le verrou est stocké dans Redis et expire de lui-même si un worker s'arrête brutalement.

### Retour systématique au plugin

Chaque demande reçoit une réponse signée du service, quel que soit son sort : page compilée, page ignorée (`skipped` : réponse HTTP 404, redirection hors du site…), échec de vérification ou compilation plantée (site injoignable, délai dépassé). Le motif est envoyé en clair dans `reason` et s'affiche dans WordPress ; aucune page ne reste « En cours ».

### Contrôle de départ

Deux contrôles passent avant toute optimisation :

1. **Stabilité** (avec `NOISE_CHECK`) : l'original est chargé deux fois. Si les deux chargements n'ont pas la même hauteur (écart supérieur à `HEIGHT_TOLERANCE`), la page change d'un chargement à l'autre (agenda, flux, contenu aléatoire) : elle est déclarée « Page instable », avec l'écart chiffré, sans autre rendu.
2. **Rejeu** (`BASELINE_CHECK`) : la page est servie **telle quelle** par le même chemin que la version compilée et comparée à l'original. Si elle diffère déjà alors que l'original est stable, le motif « Contrôle de départ en échec » détaille les écarts (format, type, pourcentage). Cause typique : un affichage qui dépend de la réponse du serveur (cookie posé par la page, en-tête), que la version compilée ne reproduirait pas non plus. Les captures sont dans `attempt-0/` du rapport.

Chaque essai écrit aussi le détail chiffré de ses écarts dans les journaux du worker (`details`).

### Familles d'optimisation

Chaque famille est indépendante, ce qui permet d'isoler celle qui casse.

| Famille | Ce qu'elle fait |
| --- | --- |
| `images` | Image LCP mesurée (mobile et desktop) préchargée en priorité haute et sortie du lazy-load, y compris une image de fond (classe `e-no-lazyload` d'Elementor) ; autres images en lazy-load natif |
| `responsive` | Images de la médiathèque (`wp-image-ID`) : `srcset` construit avec les tailles **déjà générées** par WordPress (API REST publique `wp/v2/media`), `sizes` calculé d'après la largeur réellement affichée ; `aspect-ratio` ajouté aux images sans dimensions (espace réservé, moins de CLS). Aucune image créée ni stockée |
| `animations` | Animations d'entrée Elementor retirées sur les éléments visibles à l'ouverture ; conservées plus bas |
| `fonts` | Google Fonts **hébergées sur le site** (jeux latin et latin-ext, envoyés au plugin avec la page ; autres jeux laissés chez Google), polices utilisées à l'ouverture préchargées ; `font-display: swap` partout |
| `embeds` | Vidéos YouTube et Vimeo, cartes Google Maps **chargées au clic** : l'iframe reste en place (mêmes dimensions et CSS), son contenu est remplacé par une vignette légère (`srcdoc`) |
| `assets` | Fichiers CSS/JS d'une extension retirés des pages qui ne l'utilisent pas, selon `rules/assets.yml` : Contact Form 7, emojis WordPress, styles des blocs Gutenberg, Dashicons, WooCommerce hors boutique |
| `scripts` | Scripts tiers (statistiques, pixels) retardés jusqu'à la première interaction ; scripts Elementor, jQuery, sliders et menus jamais touchés |
| `navigation` | Règles de spéculation : **rendu anticipé** (`prerender`) de la page suivante au survol d'un lien, la page s'affiche instantanément ; `prefetch` (HTML seul) réglable par site ou par `NAVIGATION_MODE` |
| `css` | CSS critique intégré à la page (Beasties), feuilles complètes chargées en asynchrone, **aucune règle supprimée**, sélecteurs protégés par addon |

Chaque famille peut être désactivée par site dans l'interface (*Réglages du site*).

### Vérification

Comparée à la page d'origine, en mobile (Pixel 7) et en desktop (1440 px) :

- captures à l'ouverture et de la page complète après défilement, comparées au pixel (pixelmatch), avec zones variables masquées et sliders figés ;
- seuils jamais inférieurs au **bruit** mesuré entre deux rendus de l'original ;
- menu mobile et sliders : s'ils fonctionnent sur l'original, ils doivent fonctionner sur la candidate ;
- aucune nouvelle erreur JavaScript en console ;
- parité SEO : title, meta description, robots, canonical, hreflang, Open Graph, JSON-LD, H1 ;
- LCP en conditions bridées (CPU ×4, réseau 4G lente, cache vide), médiane de `MEASURE_RUNS` mesures : pas plus lent que l'original (tolérance `LCP_TOLERANCE`) ;
- CLS (décalages de mise en page) dans les mêmes conditions : pas de hausse au-delà de 0,02 ou 10 % de la valeur d'origine.

La version candidate est servie au navigateur **à l'adresse réelle de la page** par interception de la requête du document : elle est testée dans les conditions exactes du site sans jamais être publiée avant d'avoir réussi.

### Isolation des échecs

En cas d'échec, les familles suspectes sont classées selon le type d'échec et seules celles qui ont réellement modifié la page sont retenues. Le service désactive alors la première moitié des suspectes et recommence, puis resserre :

- si la page passe, la fautive est dans la moitié désactivée : on teste une moitié plus petite pour en garder le plus possible ;
- sinon, la fautive est dans l'autre moitié.

Quand une erreur désigne elle-même une famille (adresse d'une vignette YouTube, d'une police déposée, d'une taille d'image), cette famille est essayée seule en premier. La meilleure version vérifiée est publiée (`compiled_partial`, avec la liste des familles désactivées). Après `MAX_ATTEMPTS` essais (4 par défaut) sans version valide, le résultat est `failed` : le plugin continue de servir la page WordPress.

Un indice oriente le classement : une différence visible à l'ouverture qui disparaît après défilement désigne d'abord les scripts retardés (ce qui manque arrive à la première interaction).

## Interface d'administration

Le service sert une interface web sur **`/admin`** (même domaine que l'API) :

- **Sites**, regroupés par **client** : état d'appairage, compilations des 30 derniers jours, derniers scores PageSpeed.
- **Nouveau site** : nom, client, domaines. L'identifiant (`site-01`, `site-02`…) et la clé sont créés automatiquement ; un **code d'appairage** à usage unique (15 min) s'affiche.
- **Fiche site** :
  - *Pages* : dernier résultat de chaque page, LCP avant → après, poids à l'ouverture et poids total ; boutons Recompiler et PageSpeed.
  - *Historique* : chaque compilation, avec ses essais et écarts, le **poids de la page par catégorie** (HTML, CSS, JS, images, polices) avant et après compilation, la **liste des fichiers** (images, CSS, JS, polices) avec leur poids, et les **captures** (référence, version compilée, différences).
  - *PageSpeed* : analyses à la demande (mobile + ordinateur) : score, FCP, LCP, CLS, TBT, et données réelles (CrUX) si le site a assez de trafic ; lien vers PageSpeed Insights.
  - *Appairage* : nouveau code, changement de clé (le site doit être réappairé), affichage de la clé pour une configuration manuelle (mot de passe demandé, action journalisée).
  - *Réglages du site* : nom, client, domaines, adresse de réception, mise en pause.
- **Réglages** : clé PageSpeed (chiffrée en base), import des sites de `SITES_YAML`.
- **Journal** : qui a fait quoi (connexions, créations, appairages, changements de clé…).

### Comptes

Un compte administrateur est créé au premier démarrage à partir de `ADMIN_EMAIL` et `ADMIN_PASSWORD`. Le modèle prévoit déjà plusieurs comptes : rôles `admin`, `editor`, `viewer` et rattachement d'un compte à certains clients (table `user_clients`) ; un compte non administrateur ne voit que les sites de ses clients. L'écran de gestion des comptes viendra avec l'ouverture à l'équipe.

Sécurité : mots de passe hachés (scrypt), session par cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` derrière HTTPS), jeton anti-CSRF sur toute modification, 10 essais de connexion par 15 min et par IP, en-têtes CSP stricts, aucune donnée affichée interprétée comme HTML.

### Appairage d'un site

1. Dans l'interface : **Nouveau site** → le code s'affiche.
2. Dans WordPress : *Réglages › Page Compiler*, section « Associer ce site au service » : adresse du service + code → « Associer ».
3. Le plugin reçoit l'identifiant et la clé ; le service enregistre l'adresse de réception et la version du plugin. Le domaine de WordPress doit faire partie des domaines déclarés.

Le code est à usage unique (une tentative avec un mauvais domaine le consomme) et limité à 20 essais par 15 min et par IP.

### PageSpeed

Analyses lancées **uniquement à la demande**, depuis l'interface ou depuis WordPress (API v5 `runPagespeed`, `strategy=MOBILE|DESKTOP`, catégorie performance). Il faut une clé d'API Google : voir la page « Get started » de la [documentation PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started). Google prévoit de retirer les données réelles (CrUX) de cette API : elles s'affichent tant qu'elles sont fournies. Le lien « PageSpeed Insights ↗ » est un lien de commodité qui relance une analyse sur le site de Google.

### Diagnostic CSS, JS et images

À chaque compilation, le rendu de référence (mobile et ordinateur, défilement, menu et slider compris) mesure :

- la **part utilisée de chaque fichier CSS et JS** (couverture de code de Chromium) ;
- chaque **image** : taille réelle, taille affichée, largeur utile (largeur affichée × densité d'écran : 2,6 sur mobile, 1 sur ordinateur), excès et **gain estimé** (au prorata des pixels en trop, à format égal), présence d'un `srcset`, image LCP ;
- les **doublons** (plusieurs fichiers pour la même image de la médiathèque) ;
- ce qui désactive le **cache avant/arrière** du navigateur (`Cache-Control: no-store`, gestionnaires `unload`).

Interface : onglet *Diagnostic* du site (agrégé sur la dernière compilation de chaque page ; « inutilisé partout » = part inutilisée même sur la page qui en utilise le plus, candidat au retrait) et section *Diagnostic* de chaque compilation.

### Visiteurs réels

- **CrUX** (onglet *Visiteurs réels*, bouton *Actualiser*) : API CrUX History de Google, 75e centile LCP, INP, CLS, FCP, TTFB sur le site entier, mobile et ordinateur, 25 périodes de 28 jours, avec courbe d'évolution. Même clé d'API que PageSpeed ; l'API « Chrome UX Report » doit être autorisée pour cette clé. Les petits sites n'ont souvent pas assez de trafic pour que Google publie des données.
- **Mesure des visiteurs** (option par site, désactivée par défaut) : un petit script ajouté aux pages compilées envoie LCP, CLS, INP et TTFB au service à la fermeture de la page (`POST /v1/rum/:site`, `sendBeacon`). Ni cookie, ni identifiant ; le service n'enregistre ni l'IP ni l'adresse complète (chemin seulement) ; mesures acceptées uniquement depuis les domaines du site ; conservées 90 jours. Nécessite `PUBLIC_URL`. **À valider avec la politique de confidentialité du client avant activation.**

### Base de données

PostgreSQL, partagé par l'API et le worker. Le schéma évolue par **migrations SQL numérotées** (`src/store/migrations/NNN-nom.sql`), appliquées automatiquement au démarrage, dans une transaction, sous verrou (l'API et le worker peuvent démarrer ensemble). Pour faire évoluer le schéma : ajouter un fichier, ne jamais modifier un fichier déjà livré.

Conservation : le détail fichier par fichier d'une compilation est effacé après **90 jours** ; les compilations (statut, poids totaux, LCP) et les analyses PageSpeed sont gardées **2 ans**. Purge quotidienne par le worker.

`MASTER_KEY` chiffre les clés des sites et la clé PageSpeed (AES-256-GCM). La perdre ou la changer rend ces clés illisibles : il faudrait réappairer tous les sites.

## Démarrage rapide (local)

Prérequis : Node.js 20+, Redis, Chrome ou Chromium.

```bash
npm install
cp .env.example .env            # puis adapter
cp config/sites.example.yml config/sites.yml
export $(grep -v '^#' .env | xargs)
export CHROMIUM_PATH=/usr/bin/google-chrome

npm run start:api               # terminal 1
npm run start:worker            # terminal 2
```

### Tester une page sans file ni plugin (phase 0)

```bash
CHROMIUM_PATH=/usr/bin/google-chrome node src/cli.js --url https://www.exemple.fr/
```

Options : `--families images,animations`, `--no-measure`, `--no-noise`, `--out ./sortie`, `--publish` (envoi au plugin si le site est configuré).

Le dossier de sortie contient `report.json`, `reference.html`, `compiled.html`, les captures de référence et, pour chaque tentative, les captures candidates et les images de différence (`*-diff-*.png`, pixels différents en rouge).

## API

Toutes les routes `/v1/*` (sauf administration) sont signées par le site.

### Signature

Message signé : `${timestamp}.${MÉTHODE}.${chemin}.${corps}` (le chemin inclut la query string, le corps est la chaîne JSON exacte envoyée, vide pour un GET).

| En-tête | Valeur |
| --- | --- |
| `X-Page-Compiler-Site` | identifiant du site (`id` dans la configuration) |
| `X-Page-Compiler-Timestamp` | secondes Unix ; écart maximal `SIGNATURE_MAX_AGE` (300 s) |
| `X-Page-Compiler-Signature` | `sha256=` + HMAC-SHA256 hexadécimal avec le secret du site |

Exemple PHP côté plugin :

```php
$body = wp_json_encode( [ 'url' => $url, 'lang' => $lang ] );
$ts   = (string) time();
$sig  = 'sha256=' . hash_hmac( 'sha256', "$ts.POST./v1/compile.$body", $secret );
wp_remote_post( $service . '/v1/compile', [
  'headers' => [
    'Content-Type'            => 'application/json',
    'X-Page-Compiler-Site'      => $site_id,
    'X-Page-Compiler-Timestamp' => $ts,
    'X-Page-Compiler-Signature' => $sig,
  ],
  'body' => $body,
] );
```

### Routes

| Route | Rôle | Réponse |
| --- | --- | --- |
| `GET /health` | Santé (public) | `{ status, redis, concurrence }` |
| `POST /v1/compile` | Demande de compilation : `{ url, lang?, families?, reason? }` | `202 { jobId }` |
| `GET /v1/jobs/:id` | État d'une compilation du site | `{ state, result: { status, familiesApplied, familiesDisabled, lcp, published } }` |
| `GET /v1/admin/overview` | Vue d'ensemble de la file (`Authorization: Bearer <ADMIN_TOKEN>`) | compteurs et 20 dernières compilations |
| `POST /v1/pair` | Appairage (non signé, limité) : `{ code, home_url, receive_url?, plugin_version? }` | `{ site_id, secret, name, domains }` ; erreurs `invalid_code`, `used_code`, `expired_code`, `domain_mismatch` |
| `GET /v1/pagespeed?url=` | Analyses PageSpeed du site (signée) | `{ configured, items: [{ strategy, status, score, metrics, field, reportUrl }] }` |
| `POST /v1/pagespeed` | Lance une analyse mobile + ordinateur (signée) : `{ url }` | `202 { ids }` ; `400 pagespeed_not_configured` |
| `POST /v1/rum/:site` | Mesure d'un visiteur (`sendBeacon`, option du site, origine vérifiée) | `204` |
| `/admin`, `/admin/api/*` | Interface d'administration (session) | — |

Codes d'erreur : `401` signature ou site invalide, `403` URL hors des domaines du site, `400` URL ou familles invalides.

### Contrat avec le plugin

Le plugin doit :

1. **Servir la page WordPress d'origine** quand la requête porte l'en-tête `X-Page-Compiler-Bypass: 1`, jamais la version compilée. Le service l'envoie pour tous les rendus de l'original. Si une page reçue contient déjà `<meta name="page-compiler">`, la compilation est abandonnée (`skipped`).
2. **Exposer un point d'accès** (`callback_url`) qui reçoit en `POST` un JSON signé de la même façon (chemin = celui du `callback_url`) :

```json
{
  "jobId": "…",
  "siteId": "site-27",
  "url": "https://www.exemple.fr/contact/",
  "lang": "fr",
  "status": "compiled | compiled_partial | failed",
  "html": "<!DOCTYPE html>… (null si failed)",
  "familiesApplied": ["images", "animations", "fonts", "navigation", "css"],
  "familiesDisabled": ["scripts"],
  "lcp": { "reference": 4200, "candidate": 1900 },
  "attempts": [{ "attempt": 1, "families": ["…"], "ok": false, "failures": [{ "type": "visual_viewport_only", "viewport": "mobile", "detail": "…" }] }],
  "compiledAt": "2026-11-07T10:00:00.000Z"
}
```

Le plugin vérifie la signature, puis écrit le HTML de façon atomique (fichier temporaire, puis renommage). Toute réponse 2xx vaut accusé de réception ; une 5xx déclenche jusqu'à 3 tentatives, une 4xx aucune.

## Configuration

### Sites

`config/sites.yml` (voir `config/sites.example.yml`), ou le même contenu dans la variable `SITES_YAML` (pratique sous Coolify). Chaque site déclare ses domaines, son secret, son `callback_url` et ses exceptions éventuelles. Le secret s'écrit soit directement (`secret`, le plus simple), soit par le nom d'une variable d'environnement (`secret_env`).

### Base de règles

Le dossier `rules/` contient :

- `addons/*.yml` : une fiche par addon, appliquée quand l'addon est détecté dans le HTML. Elle déclare les sélecteurs CSS à protéger, les scripts à ne jamais retarder et les zones à masquer ;
- `third-party.yml` : domaines, chemins et signatures des scripts tiers retardables ;
- `masks.yml` : zones masquées sur tous les sites (vidéos, cartes).

Un problème corrigé dans une fiche l'est pour tous les sites qui utilisent cet addon.

### Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Connexion Redis |
| `CHROMIUM_CONCURRENCY` | `3` | Compilations simultanées, tous workers confondus |
| `DEBOUNCE_MS` | `30000` | Regroupement des demandes d'une même page |
| `ADMIN_TOKEN` | — | Jeton de `/v1/admin/overview` |
| `SITES_FILE` / `SITES_YAML` | `config/sites.yml` | Configuration des sites |
| `MAX_ATTEMPTS` | `4` | Essais par page, isolation comprise |
| `MEASURE_RUNS` | `3` | Mesures de LCP bridées (0 pour désactiver) |
| `DATABASE_URL` | — | PostgreSQL (construite par le docker-compose) |
| `MASTER_KEY` | — | Chiffrement des clés en base (`openssl rand -hex 32`), obligatoire avec une base |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Premier compte de l'interface `/admin` |
| `PAGESPEED_API_KEY` | — | Clé PageSpeed (sinon saisie dans l'interface) |
| `SESSION_TTL_HOURS` | `12` | Durée d'une session de l'interface |
| `PAIRING_TTL_MINUTES` | `15` | Validité d'un code d'appairage |
| `TRUST_PROXY` | `true` | IP et protocole réels derrière le proxy de Coolify |
| `NOISE_CHECK` | `true` | Second rendu de l'original pour mesurer le bruit |
| `BASELINE_CHECK` | `true` | Contrôle de départ : page sans optimisation comparée à l'original |
| `SITE_RETRY_DELAY_MS` | `5000` | Attente d'une page dont le site est déjà en cours de compilation |
| `VISUAL_THRESHOLD` | `0.005` | Écart toléré à l'ouverture (0,5 % des pixels) |
| `FULLPAGE_THRESHOLD` | `0.01` | Écart toléré sur la page complète |
| `HEIGHT_TOLERANCE` | `0.02` | Écart de hauteur toléré |
| `LCP_TOLERANCE` | `1.05` | LCP candidat au plus 5 % au-dessus de l'original |
| `NAVIGATION_MODE` | `prerender` | `prefetch` : HTML seulement (réglable aussi par site dans l'interface) |
| `DIAGNOSTICS` | `true` | Diagnostic CSS/JS/images pendant le rendu de référence |
| `FONTS_HOSTS` | `fonts.googleapis.com` | Hôtes des feuilles de polices hébergées localement |
| `PUBLIC_URL` | — | Adresse publique du service (ex. `https://compiler.exemple.fr`), nécessaire à la mesure des visiteurs |
| `PAGE_TIMEOUT_MS` | `60000` | Délai de chargement d'une page |
| `DATA_DIR` | `data` | Artefacts (captures, rapports) |
| `ARTIFACTS_RETENTION_DAYS` | `30` | Purge automatique des artifacts |
| `CHROMIUM_PATH` | — | Chemin de Chrome hors Docker |
| `CHROMIUM_EXTRA_ARGS` | — | Arguments Chromium supplémentaires |

## Déploiement avec Coolify

Le dépôt fournit un `Dockerfile` (image Playwright officielle, Chromium inclus) et un `docker-compose.yml` avec trois services : `redis`, `api` (seul service à exposer) et `worker`. La procédure complète est dans le document « Procédure de déploiement du service ».

En bref :

1. Ressource Git, construction **Compose**, fichier `docker-compose.yml` à la racine.
2. Variables : `ADMIN_TOKEN` et `SITES_YAML` (configuration des sites avec leur secret, au format JSON sur une ligne, qui est du YAML valide).
3. Domaine HTTPS sur le service `api`, avec le port interne : `https://compiler.exemple.fr:3000`.
4. Déployer, puis vérifier `GET /health`.

Ajout d'un site : ajouter le site, avec son `secret`, à `SITES_YAML`, puis redéployer. Aucune modification du dépôt n'est nécessaire. (Avec `secret_env`, il faut en plus déclarer la variable dans la section `environment` de `api` **et** de `worker`.)

Dimensionnement indicatif : de l'ordre d'un cœur et 1 Go de mémoire par compilation simultanée. Avec `CHROMIUM_CONCURRENCY=3`, prévoir au moins 4 cœurs et 6 à 8 Go. Les mesures de LCP sont sensibles à la charge du serveur.

La version de l'image (`PLAYWRIGHT_VERSION` dans le Dockerfile) doit rester identique à celle de `playwright-core` dans `package.json`.

## Tests

```bash
npm run test:unit                                   # sans dépendance externe
CHROMIUM_PATH=/usr/bin/google-chrome npm run test:e2e   # Redis + Chromium requis
```

Le test de bout en bout démarre Redis, l'API, un worker, un faux site Elementor et un faux plugin qui vérifie les signatures. Il contrôle :

- le plafond de 3 compilations simultanées avec deux workers ;
- le regroupement des demandes répétées ;
- une compilation complète publiée au plugin (préchargement du fond LCP, animation retirée, script tiers retardé, CSS critique, règles de spéculation) ;
- une page cassée par un script tiers retardé : la famille `scripts` est isolée et retirée, le reste est publié.

L'intégration continue GitHub Actions (`.github/workflows/ci.yml`) lance les deux suites à chaque push.

## Test d'intégration avec le plugin

Le couple service + plugin a été testé sur un vrai WordPress (7.2 bêta, SQLite, PHP 8.3) : enregistrement d'une page → demande signée → compilation → retour signé → page servie avant WordPress (`X-Page-Compiler: HIT`), LCP 700 → 264 ms sur la page de test. Voir le README du plugin pour le détail des scénarios.

## Limites de cette version (0.4)

- **Images** : pas encore de conversion WebP/AVIF ni de redimensionnement ; seuls les attributs de chargement sont optimisés. Prévu avec sharp (phase 2).
- **Polices** : pas encore d'hébergement local des Google Fonts.
- **Interactions testées** : menu mobile et sliders (Swiper, Slick). Popups, onglets et accordéons sont à ajouter aux fiches d'addon.
- **Mesure** : LCP mesuré par le service en conditions bridées, comparable entre original et candidate, mais distinct du score PageSpeed officiel.
- **Stockage** : état des compilations dans Redis et rapports en fichiers ; la base PostgreSQL et le tableau de bord du parc viendront en phase 3.
- **Formulaires** : le comportement des jetons de sécurité dans une page en cache reste à valider côté plugin.
