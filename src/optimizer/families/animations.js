/**
 * Famille « animations ».
 *
 * Les éléments visibles à l'ouverture de la page (mobile ou desktop) perdent
 * leur animation d'entrée Elementor : ils restaient invisibles tant que le
 * JavaScript ne s'était pas exécuté. Les animations plus bas sont conservées.
 */

const ANIMATION_KEYS = [
  '_animation', 'animation',
  '_animation_mobile', 'animation_mobile',
  '_animation_tablet', 'animation_tablet',
  '_animation_delay', 'animation_delay',
];

export function applyAnimations($, ctx) {
  const notes = [];
  const ids = new Set(ctx.reference?.animatedIds || []);
  for (const id of ids) {
    if (!/^[\w-]+$/.test(String(id))) continue; // identifiant venu de la page : jamais inséré tel quel
    $(`[data-id="${id}"]`).each((_, el) => {
      const $el = $(el);
      $el.removeClass('elementor-invisible');
      const raw = $el.attr('data-settings');
      if (raw) {
        try {
          const settings = JSON.parse(raw);
          let changed = false;
          for (const k of ANIMATION_KEYS) {
            if (k in settings) {
              delete settings[k];
              changed = true;
            }
          }
          if (changed) $el.attr('data-settings', JSON.stringify(settings));
        } catch {
          // data-settings illisible : on se contente de rendre l'élément visible
        }
      }
      notes.push(`animation retirée sur data-id=${id}`);
    });
  }
  return notes;
}
