import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, describeFailures } from '../../src/pipeline/compile.js';

test('échecs décrits lisiblement, avec le format et le chiffre', () => {
  assert.equal(describeFailure({ type: 'height', viewport: 'mobile', detail: 'hauteur différente de 4.20 %' }), 'hauteur (mobile) : hauteur différente de 4.20 %');
  assert.equal(
    describeFailures([
      { type: 'visual_viewport', viewport: 'desktop', detail: 'écart 3.00 % > 0.50 %' },
      { type: 'seo', detail: 'title' },
    ]),
    "écart à l'ouverture (desktop) : écart 3.00 % > 0.50 % ; SEO : title",
  );
});
