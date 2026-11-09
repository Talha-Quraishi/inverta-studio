/**
 * Dilation of binary mask by radius r.
 */
export function dilateMask(mask: Uint8Array, size: number, radius: number): void {
  if (radius <= 0) return;
  const copy = new Uint8Array(mask);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!copy[y * size + x]) continue;
      const yMin = Math.max(0, y - radius);
      const yMax = Math.min(size - 1, y + radius);
      const xMin = Math.max(0, x - radius);
      const xMax = Math.min(size - 1, x + radius);
      for (let ny = yMin; ny <= yMax; ny++) {
        for (let nx = xMin; nx <= xMax; nx++) {
          mask[ny * size + nx] = 1;
        }
      }
    }
  }
}

/**
 * Iterative 8-neighbor harmonic diffusion inpainting for saturated core pixels.
 * Replaces masked pixels with the average of neighboring unmasked pixels.
 */
export function diffusionFill(
  imageData: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  region: { x: number; y: number; size: number },
  mask: Uint8Array
): number {
  const { x: rx, y: ry, size } = region;
  const currentMask = new Uint8Array(mask);
  const maxPasses = size + 2;
  let totalFilled = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    let passFilled = 0;
    const nextMask = new Uint8Array(currentMask);

    for (let ly = 0; ly < size; ly++) {
      for (let lx = 0; lx < size; lx++) {
        if (!currentMask[ly * size + lx]) continue;

        const gx = rx + lx;
        const gy = ry + ly;

        if (gx < 0 || gx >= imageWidth || gy < 0 || gy >= imageHeight) {
          nextMask[ly * size + lx] = 0;
          continue;
        }

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let neighborCount = 0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dy === 0 && dx === 0) continue;
            const nly = ly + dy;
            const nlx = lx + dx;

            // If neighbor is within mask region and still masked, skip
            if (nly >= 0 && nly < size && nlx >= 0 && nlx < size && currentMask[nly * size + nlx]) {
              continue;
            }

            const ngx = gx + dx;
            const ngy = gy + dy;
            if (ngx < 0 || ngx >= imageWidth || ngy < 0 || ngy >= imageHeight) continue;

            const nIdx = (ngy * imageWidth + ngx) * 4;
            sumR += imageData[nIdx];
            sumG += imageData[nIdx + 1];
            sumB += imageData[nIdx + 2];
            neighborCount++;
          }
        }

        if (neighborCount === 0) continue;

        const targetIdx = (gy * imageWidth + gx) * 4;
        imageData[targetIdx] = Math.round(sumR / neighborCount);
        imageData[targetIdx + 1] = Math.round(sumG / neighborCount);
        imageData[targetIdx + 2] = Math.round(sumB / neighborCount);

        nextMask[ly * size + lx] = 0;
        passFilled++;
      }
    }

    currentMask.set(nextMask);
    totalFilled += passFilled;
    if (passFilled === 0) break;
  }

  return totalFilled;
}
