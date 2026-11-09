/**
 * Famille « navigation ».
 *
 * Ajoute des règles de spéculation (Speculation Rules) : le navigateur prépare la
 * page suivante au survol d'un lien. Par défaut en « prerender » (rendu complet en
 * arrière-plan : la page suivante s'affiche instantanément) ; « prefetch » (HTML
 * seulement) par NAVIGATION_MODE=prefetch ou par site dans l'interface. Les outils
 * de statistiques récents attendent l'affichage réel d'une page rendue d'avance
 * avant de la compter ; les anciens scripts peuvent la compter dès le préchargement.
 */

const DEFAULT_EXCLUDE = [
  '/wp-admin/*', '/wp-login.php*', '/wp-json/*', '/feed/*', '/*\\?*',
  '/panier/*', '/cart/*', '/checkout/*', '/commande/*', '/mon-compte/*', '/my-account/*',
];

export function speculationRules(mode, extraExclude = []) {
  return {
    [mode]: [{
      source: 'document',
      where: {
        and: [
          { href_matches: '/*' },
          { not: { href_matches: [...DEFAULT_EXCLUDE, ...extraExclude] } },
          { not: { selector_matches: 'a[rel~=nofollow], a[target=_blank], .no-prefetch, .no-prefetch a' } },
        ],
      },
      eagerness: 'moderate',
    }],
  };
}

export function applyNavigation($, ctx) {
  if ($('script[data-cw-speculation]').length) return [];
  const mode = ctx.config?.navigationMode === 'prerender' ? 'prerender' : 'prefetch';
  const rules = speculationRules(mode, ctx.rules?.navigationExclude || []);
  $('head').append(`<script type="speculationrules" data-cw-speculation>${JSON.stringify(rules)}</script>`);
  return [`règles de spéculation ajoutées (${mode} au survol)`];
}
