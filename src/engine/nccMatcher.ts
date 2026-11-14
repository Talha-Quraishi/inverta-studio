export interface MatchPoint {
  x: number;
  y: number;
  ncc: number;
}

interface TemplateStats {
  sum: number;
  sumSq: number;
  count: number;
}

const templateStatsCache = new WeakMap<Float32Array, TemplateStats>();

function getTemplateStats(template: Float32Array): TemplateStats {
  let stats = templateStatsCache.get(template);
  if (stats) return stats;

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < template.length; i++) {
    const value = template[i];
    sum += value;
    sumSq += value * value;
  }
  stats = { sum, sumSq, count: template.length };
  templateStatsCache.set(template, stats);
  return stats;
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

  const templateStats = getTemplateStats(template);
  const count = templateSize * templateSize;
  if (templateStats.count !== count) return -1;

  let sumI = 0;
  let sumII = 0;
  let sumTI = 0;

  for (let dy = 0; dy < templateSize; dy++) {
    const rowOffset = (posY + dy) * imgWidth;
    const tRowOffset = dy * templateSize;

    for (let dx = 0; dx < templateSize; dx++) {
      const pIdx = (rowOffset + (posX + dx)) * 4;
      // Luminance Y in [0, 1]
      const lum = (0.299 * data[pIdx] + 0.587 * data[pIdx + 1] + 0.114 * data[pIdx + 2]) / 255.0;
      const tVal = template[tRowOffset + dx];

      sumI += lum;
      sumII += lum * lum;
      sumTI += tVal * lum;
    }
  }

  if (count === 0) return -1;

  const meanT = templateStats.sum / count;
  const meanI = sumI / count;
  const covar = sumTI / count - meanT * meanI;
  const varT = Math.max(0, templateStats.sumSq / count - meanT * meanT);
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
