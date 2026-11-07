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

### Familles d'optimisation

Chaque famille est indépendante, ce qui permet d'isoler celle qui casse.

| Famille | Ce qu'elle fait |
| --- | --- |
| `images` | Image LCP mesurée (mobile et desktop) préchargée en priorité haute et sortie du lazy-load, y compris une image de fond (classe `e-no-lazyload` d'Elementor) ; autres images en lazy-load natif |
| `animations` | Animations d'entrée Elementor retirées sur les éléments visibles à l'ouverture ; conservées plus bas |
| `fonts` | Google Fonts en `display=swap`, connexion anticipée, `font-display: swap` sur les `@font-face` en ligne |
| `scripts` | Scripts tiers (statistiques, pixels) retardés jusqu'à la première interaction ; scripts Elementor, jQuery, sliders et menus jamais touchés |
| `navigation` | Règles de spéculation : préchargement de la page suivante au survol d'un lien (`prefetch` par défaut) |
| `css` | CSS critique intégré à la page (Beasties), feuilles complètes chargées en asynchrone, **aucune règle supprimée**, sélecteurs protégés par addon |

### Vérification

Comparée à la page d'origine, en mobile (Pixel 7) et en desktop (1440 px) :

- captures à l'ouverture et de la page complète après défilement, comparées au pixel (pixelmatch), avec zones variables masquées et sliders figés ;
- seuils jamais inférieurs au **bruit** mesuré entre deux rendus de l'original ;
- menu mobile et sliders : s'ils fonctionnent sur l'original, ils doivent fonctionner sur la candidate ;
- aucune nouvelle erreur JavaScript en console ;
- parité SEO : title, meta description, robots, canonical, hreflang, Open Graph, JSON-LD, H1 ;
- LCP en conditions bridées (CPU ×4, réseau 4G lente, cache vide), médiane de `MEASURE_RUNS` mesures : pas plus lent que l'original (tolérance `LCP_TOLERANCE`).

La version candidate est servie au navigateur **à l'adresse réelle de la page** par interception de la requête du document : elle est testée dans les conditions exactes du site sans jamais être publiée avant d'avoir réussi.

### Isolation des échecs

En cas d'échec, les familles suspectes sont classées selon le type d'échec et seules celles qui ont réellement modifié la page sont retenues. Le service désactive alors la première moitié des suspectes et recommence, puis resserre :

- si la page passe, la fautive est dans la moitié désactivée : on teste une moitié plus petite pour en garder le plus possible ;
- sinon, la fautive est dans l'autre moitié.

La meilleure version vérifiée est publiée (`compiled_partial`, avec la liste des familles désactivées). Après `MAX_ATTEMPTS` essais (3 par défaut) sans version valide, le résultat est `failed` : le plugin continue de servir la page WordPress.

Un indice oriente le classement : une différence visible à l'ouverture qui disparaît après défilement désigne d'abord les scripts retardés (ce qui manque arrive à la première interaction).

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

`config/sites.yml` (voir `config/sites.example.yml`), ou le même contenu dans la variable `SITES_YAML` (pratique sous Coolify). Chaque site déclare ses domaines, le **nom** de la variable d'environnement qui contient son secret, son `callback_url` et ses exceptions éventuelles.

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
| `MAX_ATTEMPTS` | `3` | Essais par page, isolation comprise |
| `MEASURE_RUNS` | `3` | Mesures de LCP bridées (0 pour désactiver) |
| `NOISE_CHECK` | `true` | Second rendu de l'original pour mesurer le bruit |
| `VISUAL_THRESHOLD` | `0.005` | Écart toléré à l'ouverture (0,5 % des pixels) |
| `FULLPAGE_THRESHOLD` | `0.01` | Écart toléré sur la page complète |
| `HEIGHT_TOLERANCE` | `0.02` | Écart de hauteur toléré |
| `LCP_TOLERANCE` | `1.05` | LCP candidat au plus 5 % au-dessus de l'original |
| `NAVIGATION_MODE` | `prefetch` | `prerender` : rendu complet anticipé (les statistiques s'exécutent alors aussi) |
| `PAGE_TIMEOUT_MS` | `60000` | Délai de chargement d'une page |
| `DATA_DIR` | `data` | Artefacts (captures, rapports) |
| `ARTIFACTS_RETENTION_DAYS` | `30` | Purge automatique des artifacts |
| `CHROMIUM_PATH` | — | Chemin de Chrome hors Docker |
| `CHROMIUM_EXTRA_ARGS` | — | Arguments Chromium supplémentaires |

## Déploiement avec Coolify

Le dépôt fournit un `Dockerfile` (image Playwright officielle, Chromium inclus) et un `docker-compose.yml` avec trois services : `redis`, `api` (seul service à exposer) et `worker`. La procédure complète est dans le document « Procédure de déploiement du service ».

En bref :

1. Ressource Git, construction **Compose**, fichier `docker-compose.yml` à la racine.
2. Variables : `ADMIN_TOKEN`, `SITES_YAML` (configuration des sites, au format JSON sur une ligne, qui est du YAML valide) et un `SECRET_SITE_xx` par site.
3. Domaine HTTPS sur le service `api`, avec le port interne : `https://compiler.exemple.fr:3000`.
4. Déployer, puis vérifier `GET /health`.

Ajout d'un site : ajouter `SECRET_SITE_xx` dans la section `environment` de `api` **et** de `worker` (commit), renseigner sa valeur dans Coolify, ajouter le site à `SITES_YAML`, redéployer.

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

## Limites de cette version (0.1)

- **Images** : pas encore de conversion WebP/AVIF ni de redimensionnement ; seuls les attributs de chargement sont optimisés. Prévu avec sharp (phase 2).
- **Polices** : pas encore d'hébergement local des Google Fonts.
- **Interactions testées** : menu mobile et sliders (Swiper, Slick). Popups, onglets et accordéons sont à ajouter aux fiches d'addon.
- **Mesure** : LCP mesuré par le service en conditions bridées, comparable entre original et candidate, mais distinct du score PageSpeed officiel.
- **Stockage** : état des compilations dans Redis et rapports en fichiers ; la base PostgreSQL et le tableau de bord du parc viendront en phase 3.
- **Formulaires** : le comportement des jetons de sécurité dans une page en cache reste à valider côté plugin.
