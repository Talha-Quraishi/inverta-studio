/**
 * Pure mask geometry helpers.
 *
 * Kept free of DOM/browser imports so they can be exercised by Node's built-in
 * test runner as well as the browser bundle.
 */

export interface MaskSizeData {
  alphaMap: Float32Array;
  size: number;
}

/**
 * A mask is valid only when its declared size matches the actual sample count.
 * 48x48 data mislabeled as 72x72 used to silently corrupt output pixels.
 */
export function isValidMask(
  mask: MaskSizeData | null | undefined
): mask is MaskSizeData {
  if (!mask) return false;
  if (!Number.isInteger(mask.size) || mask.size <= 0) return false;
  return mask.alphaMap.length === mask.size * mask.size;
}

/**
 * Infer the square size of a mask array. Returns null for non-square buffers.
 */
export function inferMaskSize(alphaMap: Float32Array): number | null {
  const size = Math.round(Math.sqrt(alphaMap.length));
  if (size <= 0 || size * size !== alphaMap.length) return null;
  return size;
}

/**
 * Bilinear resample of a square alpha mask.
 */
export function rescaleAlphaMap(
  src: Float32Array,
  srcSize: number,
  dstSize: number
): Float32Array {
  if (srcSize === dstSize) return src;
  if (src.length !== srcSize * srcSize) {
    throw new Error(
      `Invalid source mask: expected ${srcSize * srcSize} samples, got ${src.length}`
    );
  }
  if (dstSize <= 0) {
    throw new Error(`Invalid destination mask size: ${dstSize}`);
  }

  const dst = new Float32Array(dstSize * dstSize);
  const scaleFactor = (srcSize - 1) / Math.max(1, dstSize - 1);

  for (let dy = 0; dy < dstSize; dy++) {
    const sy = dy * scaleFactor;
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcSize - 1, y0 + 1);
    const dyFract = sy - y0;

    for (let dx = 0; dx < dstSize; dx++) {
      const sx = dx * scaleFactor;
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcSize - 1, x0 + 1);
      const dxFract = sx - x0;

      const p00 = src[y0 * srcSize + x0];
      const p10 = src[y0 * srcSize + x1];
      const p01 = src[y1 * srcSize + x0];
      const p11 = src[y1 * srcSize + x1];

      dst[dy * dstSize + dx] =
        p00 * (1 - dxFract) * (1 - dyFract) +
        p10 * dxFract * (1 - dyFract) +
        p01 * (1 - dxFract) * dyFract +
        p11 * dxFract * dyFract;
    }
  }

  return dst;
}

/**
 * Clamp a requested scale multiplier to a safe mask size range.
 */
export function resolveScaledMaskSize(
  baseSize: number,
  scale: number,
  maxSize = 4096
): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.max(4, Math.min(maxSize, Math.round(baseSize * safeScale)));
}
