import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Recadre une image PNG décodée sur une hauteur donnée. */
function crop(png, width, height) {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
  return out;
}

/**
 * Compare deux captures. Les hauteurs peuvent différer (page complète) :
 * l'écart de hauteur est rapporté à part, la comparaison porte sur la zone commune.
 *
 * @returns {{ ratio: number, heightDelta: number, diffPng: Buffer, width: number, height: number }}
 */
export function compareScreenshots(bufA, bufB, { pixelThreshold = 0.1 } = {}) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const heightDelta = Math.abs(a.height - b.height) / Math.max(a.height, b.height, 1);
  const ca = crop(a, width, height);
  const cb = crop(b, width, height);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(ca.data, cb.data, diff.data, width, height, {
    threshold: pixelThreshold,
    includeAA: false,
  });
  return {
    ratio: pixels / (width * height || 1),
    heightDelta,
    diffPng: PNG.sync.write(diff),
    width,
    height,
  };
}
