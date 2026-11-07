/**
 * Famille « navigation ».
 *
 * Ajoute des règles de spéculation (Speculation Rules) : le navigateur précharge
 * la page suivante au survol d'un lien. Par défaut en mode « prefetch » (le HTML
 * seulement, sans exécuter de script) ; le mode « prerender » (rendu complet en
 * arrière-plan) s'active par NAVIGATION_MODE=prerender, en connaissance de cause :
 * les scripts de statistiques s'exécutent alors aussi pour les pages préchargées.
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
