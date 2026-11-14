export interface MatchPoint {
  x: number;
  y: number;
  ncc: number;
}

/**
 * Computes Normalized Cross-Correlation (NCC) between the luminance of the
 * image patch at (posX, posY) and the given alphaMap template.
 * Luminance is computed using ITU-R BT.601 coefficients (0.299R + 0.587G + 0.114B).
 */
export function nccAt(
  data: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  template: Float32Array,
  templateSize: number,
  posX: number,
  posY: number
): number {
  if (posX < 0 || posY < 0 || posX + templateSize > imgWidth || posY + templateSize > imgHeight) {
    return -1;
  }

  let sumT = 0;
  let sumI = 0;
  let sumTT = 0;
  let sumII = 0;
  let sumTI = 0;
  let count = 0;

  for (let dy = 0; dy < templateSize; dy++) {
    const rowOffset = (posY + dy) * imgWidth;
    const tRowOffset = dy * templateSize;

    for (let dx = 0; dx < templateSize; dx++) {
      const pIdx = (rowOffset + (posX + dx)) * 4;
      // Luminance Y in [0, 1]
      const lum = (0.299 * data[pIdx] + 0.587 * data[pIdx + 1] + 0.114 * data[pIdx + 2]) / 255.0;
      const tVal = template[tRowOffset + dx];

      sumT += tVal;
      sumTT += tVal * tVal;
      sumI += lum;
      sumII += lum * lum;
      sumTI += tVal * lum;
      count++;
    }
  }

  if (count === 0) return -1;

  const meanT = sumT / count;
  const meanI = sumI / count;
  const covar = sumTI / count - meanT * meanI;
  const varT = Math.max(0, sumTT / count - meanT * meanT);
  const varI = Math.max(0, sumII / count - meanI * meanI);
  const stdT = Math.sqrt(varT);
  const stdI = Math.sqrt(varI);

  if (stdT < 0.001 || stdI < 0.001) return -1;
  return covar / (stdT * stdI);
}

/**
 * Searches a designated corner area of the image for the watermark location.
 * Uses a coarse grid step (scanStride), followed by a fine 1px search within refineRadius.
 */
export function scanCorner(
  data: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  template: Float32Array,
  templateSize: number,
  corner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' = 'bottom-right',
  scanStride: number = 8,
  refineRadius: number = 6
): MatchPoint {
  let startX = 0;
  let maxX = imgWidth - templateSize;
  let startY = 0;
  let maxY = imgHeight - templateSize;

  if (corner === 'bottom-right') {
    startX = Math.max(0, Math.floor(0.70 * imgWidth));
    startY = Math.max(0, Math.floor(0.70 * imgHeight));
  } else if (corner === 'bottom-left') {
    startX = 0;
    maxX = Math.min(imgWidth - templateSize, Math.floor(0.30 * imgWidth));
    startY = Math.max(0, Math.floor(0.70 * imgHeight));
  } else if (corner === 'top-right') {
    startX = Math.max(0, Math.floor(0.70 * imgWidth));
    startY = 0;
    maxY = Math.min(imgHeight - templateSize, Math.floor(0.30 * imgHeight));
  } else if (corner === 'top-left') {
    startX = 0;
    maxX = Math.min(imgWidth - templateSize, Math.floor(0.30 * imgWidth));
    startY = 0;
    maxY = Math.min(imgHeight - templateSize, Math.floor(0.30 * imgHeight));
  }

  if (maxX < startX || maxY < startY) {
    return { x: -1, y: -1, ncc: -1 };
  }

  let bestMatch: MatchPoint = { x: startX, y: startY, ncc: -1 };

  // Phase 1: Coarse Grid Search
  for (let y = startY; y <= maxY; y += scanStride) {
    for (let x = startX; x <= maxX; x += scanStride) {
      const score = nccAt(data, imgWidth, imgHeight, template, templateSize, x, y);
      if (score > bestMatch.ncc) {
        bestMatch = { x, y, ncc: score };
        if (score >= 0.75) break;
      }
    }
    if (bestMatch.ncc >= 0.75) break;
  }

  // Phase 2: Local Refinement within radius
  if (refineRadius > 0 && bestMatch.ncc > -1) {
    const rxMin = Math.max(startX, bestMatch.x - refineRadius);
    const ryMin = Math.max(startY, bestMatch.y - refineRadius);
    const rxMax = Math.min(maxX, bestMatch.x + refineRadius);
    const ryMax = Math.min(maxY, bestMatch.y + refineRadius);

    let refinedMatch = bestMatch;
    for (let y = ryMin; y <= ryMax; y++) {
      for (let x = rxMin; x <= rxMax; x++) {
        const score = nccAt(data, imgWidth, imgHeight, template, templateSize, x, y);
        if (score > refinedMatch.ncc) {
          refinedMatch = { x, y, ncc: score };
        }
      }
    }
    bestMatch = refinedMatch;
  }

  return bestMatch;
}

/**
 * Searches the bottom-right corner area of the image for the watermark location.
 */
export function scanBottomRight(
  data: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  template: Float32Array,
  templateSize: number,
  scanStride: number = 8,
  refineRadius: number = 6
): MatchPoint {
  return scanCorner(data, imgWidth, imgHeight, template, templateSize, 'bottom-right', scanStride, refineRadius);
}

/**
 * How much smoother does the picture get along the logo's outline if the watermark is undone here?
 *
 * Returns (edge energy after inversion) / (edge energy before), using the best of a few plausible
 * opacities. Undoing a real translucent logo removes its edges (ratio well below 1), whereas
 * "undoing" a logo that is not there paints a brand-new logo-shaped edge (ratio above 1). This
 * separates the true mark from chance correlations with the artwork, which NCC alone cannot do.
 * Returns Infinity when there is no usable signal.
 */
export function restorationRatio(
  data: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  alphaMap: Float32Array,
  size: number,
  x0: number,
  y0: number,
  logoValue = 250
): number {
  const pad = 1;
  const span = size + 2 * pad;
  const lum = new Float32Array(span * span);
  for (let j = 0; j < span; j++) {
    const yy = Math.min(imgHeight - 1, Math.max(0, y0 - pad + j));
    for (let i = 0; i < span; i++) {
      const xx = Math.min(imgWidth - 1, Math.max(0, x0 - pad + i));
      const p = (yy * imgWidth + xx) * 4;
      lum[j * span + i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
  }

  const band: number[] = [];
  for (let k = 0; k < size * size; k++) {
    if (alphaMap[k] > 0.04) band.push(k);
  }
  if (band.length < 16) return Infinity;

  const meanGradient = (buf: Float32Array): number => {
    let sum = 0;
    for (const k of band) {
      const i = (k % size) + pad;
      const j = ((k / size) | 0) + pad;
      const gx = buf[j * span + i + 1] - buf[j * span + i - 1];
      const gy = buf[(j + 1) * span + i] - buf[(j - 1) * span + i];
      sum += Math.hypot(gx, gy);
    }
    return sum / band.length;
  };

  const before = meanGradient(lum);
  if (before < 0.5) return Infinity;

  let best = Infinity;
  const inverted = new Float32Array(lum.length);
  for (const gain of [1.0, 0.85, 0.75, 0.62]) {
    inverted.set(lum);
    for (let k = 0; k < size * size; k++) {
      const a = Math.min(alphaMap[k] * gain, 0.99);
      if (a < 0.002) continue;
      const idx = (((k / size) | 0) + pad) * span + (k % size) + pad;
      const v = (lum[idx] - a * logoValue) / (1 - a);
      inverted[idx] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    const after = meanGradient(inverted);
    if (after < best) best = after;
  }
  return best / before;
}
