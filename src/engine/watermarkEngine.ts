import { AlphaMaskManager } from './alphaMasks';
import { diffusionFill, dilateMask } from './diffusionFill';
import { nccAt, scanCorner } from './nccMatcher';
import { DEFAULT_SETTINGS } from './types';
import type {
  DetectionResult,
  RemovalResult,
  WatermarkCorner,
  WatermarkSettings,
} from './types';

export class WatermarkEngine {
  private maskManager = new AlphaMaskManager();
  private ready = false;

  public async initialize(): Promise<void> {
    if (this.ready) return;
    await this.maskManager.initialize();
    this.ready = true;
  }

  public isReady(): boolean {
    return this.ready;
  }

  /**
   * Determine expected watermark size and default margins for given dimensions.
   */
  public getWatermarkConfig(width: number, height: number): { logoSize: number; margin: number; x: number; y: number } {
    const isLarge = width > 1024 && height > 1024;
    const logoSize = isLarge ? 96 : 48;
    const margin = isLarge ? 64 : 32;
    return {
      logoSize,
      margin,
      x: width - margin - logoSize,
      y: height - margin - logoSize,
    };
  }

  /**
   * Detects the watermark location and correlation score without modifying the image.
   */
  public detect(imageData: ImageData, customSettings?: Partial<WatermarkSettings>): DetectionResult {
    const s: WatermarkSettings = { ...DEFAULT_SETTINGS, ...customSettings };
    const { width, height, data } = imageData;
    const minDim = Math.min(width, height);
    const resScale = minDim / 1080;

    const versionsToTest: Array<'old' | 'new' | 'white'> =
      s.logoVersion === 'auto'
        ? ['new', 'old', 'white']
        : [s.logoVersion];

    const computedClassic = Math.round(84 * resScale * s.maskScale);
    const computedSparkle = Math.round(96 * resScale * s.maskScale);

    const sizeSet = new Set<number>([96, 84, 72, 64, 56, 48, 45, 42, 38, 36, 32, 28, 24]);
    if (computedClassic >= 24 && computedClassic <= minDim * 0.4) sizeSet.add(computedClassic);
    if (computedSparkle >= 24 && computedSparkle <= minDim * 0.4) sizeSet.add(computedSparkle);

    const targetSizes = Array.from(sizeSet).sort((a, b) => b - a);

    const baseSizes: Array<{ size: number; version: 'old' | 'new' | 'white'; alphaMap: Float32Array }> = [];
    for (const ver of versionsToTest) {
      for (const sz of targetSizes) {
        if (sz === 96) {
          baseSizes.push({ size: 96, version: ver, alphaMap: this.maskManager.getBaseMap(96, ver) });
        } else if (sz === 84) {
          baseSizes.push({ size: 84, version: ver, alphaMap: this.maskManager.getBaseMap(84, ver) });
        } else if (sz === 48) {
          baseSizes.push({ size: 48, version: ver, alphaMap: this.maskManager.getBaseMap(48, ver) });
        } else {
          const baseRef = sz > 64 ? 96 : (ver === 'old' ? 84 : 48);
          const scaled = this.maskManager.getScaledMask(baseRef, sz / baseRef, ver);
          baseSizes.push({ size: sz, version: ver, alphaMap: scaled.alphaMap });
        }
      }
    }

    let bestCandidate: {
      size: number;
      version: 'old' | 'new' | 'white';
      corner: WatermarkCorner;
      alphaMap: Float32Array;
      x: number;
      y: number;
      ncc: number;
      autoX: number;
      autoY: number;
      method: 'auto' | 'scan' | 'forced';
    } | null = null;

    if (s.forcePosition && Number.isFinite(s.forcePosition.x) && Number.isFinite(s.forcePosition.y)) {
      const targetSize = s.forcePosition.size || (width > 1024 && height > 1024 ? 96 : 48);
      // Exact size if available, otherwise the closest template (never an arbitrary one).
      const chosen = baseSizes.reduce((best, b) =>
        Math.abs(b.size - targetSize) < Math.abs(best.size - targetSize) ? b : best
      );
      const clampedX = Math.max(0, Math.min(width - chosen.size, Math.round(s.forcePosition.x)));
      const clampedY = Math.max(0, Math.min(height - chosen.size, Math.round(s.forcePosition.y)));
      const score = nccAt(data, width, height, chosen.alphaMap, chosen.size, clampedX, clampedY);

      bestCandidate = {
        size: chosen.size,
        version: chosen.version,
        corner: 'bottom-right',
        alphaMap: chosen.alphaMap,
        x: clampedX,
        y: clampedY,
        ncc: score, // real match quality, so the HUD doesn't overstate confidence
        autoX: width - 64 - chosen.size,
        autoY: height - 64 - chosen.size,
        method: 'forced',
      };
    } else {
      // Priority standard and resolution-scaled margin pairs checked first
      const baseMargins = [222, 186, 144, 138, 132, 128, 120, 96, 72, 64, 48, 36, 32, 28, 24, 20, 16];
      const mSet = new Set<number>();
      for (const m of baseMargins) {
        mSet.add(m);
        const scaled = Math.round(m * resScale);
        if (scaled >= 12 && scaled < minDim * 0.4) mSet.add(scaled);
      }
      const margins = Array.from(mSet);
      const marginPairs: [number, number][] = [];
      for (const m of margins) {
        marginPairs.push([m, m]);
      }
      const commonRatios = [
        [1.2, 1.0], [1.0, 1.2],
        [1.33, 1.0], [1.0, 1.33],
        [1.5, 1.0], [1.0, 1.5],
      ];
      for (const m of margins) {
        for (const [rx, ry] of commonRatios) {
          const mx = Math.round(m * rx);
          const my = Math.round(m * ry);
          if (mx < minDim * 0.4 && my < minDim * 0.4) {
            marginPairs.push([mx, my]);
          }
        }
      }

      const cornerOrder: Array<'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'> =
        s.corner === 'auto'
          ? ['bottom-right', 'bottom-left', 'top-right', 'top-left']
          : [s.corner];

      for (const cornerKey of cornerOrder) {
        // Phase 1: Test multi-margin candidate grid across all template sizes and versions for this corner
        for (const candidate of baseSizes) {
          for (const [mx, my] of marginPairs) {
            let autoX = 0;
            let autoY = 0;
            if (cornerKey === 'bottom-right') {
              autoX = Math.max(0, Math.min(width - candidate.size, width - mx - candidate.size));
              autoY = Math.max(0, Math.min(height - candidate.size, height - my - candidate.size));
            } else if (cornerKey === 'bottom-left') {
              autoX = Math.max(0, Math.min(width - candidate.size, mx));
              autoY = Math.max(0, Math.min(height - candidate.size, height - my - candidate.size));
            } else if (cornerKey === 'top-right') {
              autoX = Math.max(0, Math.min(width - candidate.size, width - mx - candidate.size));
              autoY = Math.max(0, Math.min(height - candidate.size, my));
            } else if (cornerKey === 'top-left') {
              autoX = Math.max(0, Math.min(width - candidate.size, mx));
              autoY = Math.max(0, Math.min(height - candidate.size, my));
            }

            const score = nccAt(data, width, height, candidate.alphaMap, candidate.size, autoX, autoY);

            if (!bestCandidate || score > bestCandidate.ncc) {
              bestCandidate = {
                size: candidate.size,
                version: candidate.version,
                corner: cornerKey,
                alphaMap: candidate.alphaMap,
                x: autoX,
                y: autoY,
                ncc: score,
                autoX,
                autoY,
                method: 'auto',
              };
            }
            if (bestCandidate && bestCandidate.ncc >= 0.70) break;
          }
          if (bestCandidate && bestCandidate.ncc >= 0.70) break;
        }

        // If highly confident match found in margins, break early
        if (bestCandidate && bestCandidate.ncc >= 0.65) break;

        // Phase 2: Corner spatial scan if margin check is below acceptance threshold
        if (!bestCandidate || bestCandidate.ncc < s.nccAccept) {
          for (const candidate of baseSizes) {
            const scan = scanCorner(
              data,
              width,
              height,
              candidate.alphaMap,
              candidate.size,
              cornerKey,
              s.scanStride || 8,
              s.refineRadius || 6
            );
            if (!bestCandidate || scan.ncc > bestCandidate.ncc) {
              bestCandidate = {
                size: candidate.size,
                version: candidate.version,
                corner: cornerKey,
                alphaMap: candidate.alphaMap,
                x: scan.x,
                y: scan.y,
                ncc: scan.ncc,
                autoX: scan.x,
                autoY: scan.y,
                method: 'scan',
              };
            }
            if (bestCandidate && bestCandidate.ncc >= 0.50) break;
          }
        }

        // If confirmed in this corner, no need to scan remaining corners
        if (bestCandidate && bestCandidate.ncc >= s.nccAccept) break;
      }
    }

    if (!bestCandidate) {
      return {
        detected: false,
        confidence: 0,
        ncc: 0,
        x: 0,
        y: 0,
        size: 48,
        method: 'auto',
        autoX: 0,
        autoY: 0,
        drifted: false,
        gainApplied: 1.0,
      };
    }

    const isDrifted = bestCandidate.x !== bestCandidate.autoX || bestCandidate.y !== bestCandidate.autoY;
    // A manually placed watermark isn't a "drifted" detection: capping its gain would leave a ghost
    // for full-strength marks, so let the adaptive opacity estimator pick the strength instead.
    const gainApplied = isDrifted && bestCandidate.method !== 'forced' ? s.gainDrift : 1.0;

    return {
      detected: bestCandidate.method === 'forced' || bestCandidate.ncc >= s.nccAccept,
      confidence: Math.max(0, Math.min(1, bestCandidate.ncc)),
      ncc: bestCandidate.ncc,
      x: bestCandidate.x,
      y: bestCandidate.y,
      size: bestCandidate.size,
      method: bestCandidate.method,
      autoX: bestCandidate.autoX,
      autoY: bestCandidate.autoY,
      drifted: isDrifted,
      gainApplied,
      detectedVersion: bestCandidate.version,
      detectedCorner: bestCandidate.corner,
    };
  }

  /**
   * Performs watermark removal on a clone of the provided ImageData.
   */
  public removeWatermark(
    sourceImageData: ImageData,
    customSettings?: Partial<WatermarkSettings>
  ): { cleanImageData: ImageData; result: RemovalResult } {
    const startTime = performance.now();
    const s: WatermarkSettings = { ...DEFAULT_SETTINGS, ...customSettings };

    const detection = this.detect(sourceImageData, s);

    if (!detection.detected && detection.method !== 'forced') {
      return {
        cleanImageData: sourceImageData,
        result: {
          success: false,
          message: `No watermark detected (best NCC ${detection.ncc.toFixed(3)} < threshold ${s.nccAccept})`,
          position: { x: detection.x, y: detection.y },
          size: detection.size,
          confidence: detection.confidence,
          pixelsModified: 0,
          elapsedMs: Math.round(performance.now() - startTime),
          method: detection.method,
          drifted: detection.drifted,
          gainApplied: detection.gainApplied,
          detectedVersion: detection.detectedVersion,
        },
      };
    }

    // Clone image data so source is not mutated
    const cleanImageData = new ImageData(
      new Uint8ClampedArray(sourceImageData.data),
      sourceImageData.width,
      sourceImageData.height
    );
    const { width, height, data } = cleanImageData;

    // Retrieve the scaled mask using detected watermark version
    const activeVersion = detection.detectedVersion || (s.logoVersion === 'auto' ? 'old' : s.logoVersion);
    const scaledMask = this.maskManager.rescaleMask(
      this.maskManager.getMaskForSize(detection.size, activeVersion),
      s.maskScale,
      activeVersion
    );
    const mask = scaledMask.alphaMap;
    const maskSize = scaledMask.size;

    // Center offset if mask was scaled
    const centerOffset = detection.method === 'forced' ? 0 : Math.floor((maskSize - detection.size) / 2);
    const originX = detection.x - centerOffset;
    const originY = detection.y - centerOffset;

    const startX = Math.max(0, originX);
    const startY = Math.max(0, originY);
    const endX = Math.min(width, originX + maskSize);
    const endY = Math.min(height, originY + maskSize);

    if (startX >= endX || startY >= endY) {
      return {
        cleanImageData,
        result: {
          success: false,
          message: 'Watermark bounding region is out of bounds',
          position: { x: originX, y: originY },
          size: maskSize,
          confidence: detection.confidence,
          pixelsModified: 0,
          elapsedMs: Math.round(performance.now() - startTime),
          method: detection.method,
          drifted: detection.drifted,
          gainApplied: detection.gainApplied,
        },
      };
    }

    const optimalGain = computeAdaptiveOpacity(
      data,
      width,
      height,
      originX,
      originY,
      mask,
      maskSize,
      s.logoValue || 250
    );
    const effectiveGain = Math.min(detection.gainApplied, optimalGain);

    // Determine if inpainting should run
    const useInpainting = s.fillMode === 'on' || (s.fillMode === 'auto' && s.logoVersion === 'white');
    const inpaintMask = useInpainting ? new Uint8Array(maskSize * maskSize) : null;
    let maxMaskAlpha = 0;
    if (inpaintMask) {
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] > maxMaskAlpha) maxMaskAlpha = mask[i];
      }
    }
    const inpaintAlphaCutoff = maxMaskAlpha * effectiveGain * s.fillThreshold;

    let modifiedPixels = 0;

    // Invert alpha blending
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const maskY = y - originY;
        const maskX = x - originX;
        if (maskY < 0 || maskY >= maskSize || maskX < 0 || maskX >= maskSize) continue;

        let alpha = mask[maskY * maskSize + maskX] * effectiveGain;
        if (alpha < s.alphaThreshold) continue;

        // If pixel is in saturated core, defer to inpainting
        if (inpaintMask && alpha >= inpaintAlphaCutoff) {
          inpaintMask[maskY * maskSize + maskX] = 1;
          continue;
        }

        if (alpha > s.maxAlpha) alpha = s.maxAlpha;
        const invAlpha = 1.0 - alpha;
        const pixelIdx = (y * width + x) * 4;

        for (let c = 0; c < 3; c++) {
          const val = (data[pixelIdx + c] - alpha * s.logoValue) / invAlpha;
          data[pixelIdx + c] = Math.round(Math.max(0, Math.min(255, val)));
        }
        modifiedPixels++;
      }
    }

    // Perform harmonic diffusion inpainting on saturated core
    let filledPixels = 0;
    if (inpaintMask) {
      dilateMask(inpaintMask, maskSize, s.fillRadius);
      filledPixels = diffusionFill(
        data,
        width,
        height,
        { x: originX, y: originY, size: maskSize },
        inpaintMask
      );
      modifiedPixels += filledPixels;
    }

    const elapsedMs = Math.round(performance.now() - startTime);

    return {
      cleanImageData,
      result: {
        success: true,
        message: `Watermark successfully removed (${maskSize}×${maskSize} at ${originX},${originY})`,
        position: { x: originX, y: originY },
        size: maskSize,
        confidence: detection.confidence,
        pixelsModified: modifiedPixels,
        elapsedMs,
        method: detection.method,
        drifted: detection.drifted,
        gainApplied: detection.gainApplied,
        detectedVersion: detection.detectedVersion,
        detectedCorner: detection.detectedCorner,
      },
    };
  }
}

// Global Singleton for easy browser consumption
export const watermarkEngine = new WatermarkEngine();

function computeAdaptiveOpacity(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  originX: number,
  originY: number,
  mask: Float32Array,
  maskSize: number,
  logoValue = 250
): number {
  const candidateOpacities = [1.0, 0.85, 0.75, 0.62];
  const pad = Math.max(8, Math.round(0.25 * maskSize));
  const rMin = Math.max(0, originX - pad);
  const nMin = Math.max(0, originY - pad);
  const iMax = Math.min(width, originX + maskSize + pad);
  const oMax = Math.min(height, originY + maskSize + pad);

  let surrLumSum = 0;
  let surrCount = 0;

  for (let y = nMin; y < oMax; y++) {
    for (let x = rMin; x < iMax; x++) {
      if (x >= originX && x < originX + maskSize && y >= originY && y < originY + maskSize) {
        continue;
      }
      const idx = (y * width + x) * 4;
      surrLumSum += 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
      surrCount++;
    }
  }

  if (surrCount === 0) return candidateOpacities[0];
  const avgSurrLum = surrLumSum / surrCount;

  let bestOpacity = candidateOpacities[0];
  let minError = Infinity;

  for (const op of candidateOpacities) {
    let errSum = 0;
    let weightSum = 0;

    for (let y = 0; y < maskSize; y++) {
      for (let x = 0; x < maskSize; x++) {
        const sVal = mask[y * maskSize + x];
        if (sVal <= 0.04) continue;

        const effA = Math.min(sVal * op, op);
        const invA = 1.0 - effA;
        if (invA <= 1e-4) continue;

        const px = originX + x;
        const py = originY + y;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const hIdx = (py * width + px) * 4;
        const invR = (data[hIdx] - effA * logoValue) / invA;
        const invG = (data[hIdx + 1] - effA * logoValue) / invA;
        const invB = (data[hIdx + 2] - effA * logoValue) / invA;
        const restoredLum = 0.2126 * invR + 0.7152 * invG + 0.0722 * invB;
        const weight = Math.min(1.0, 8.0 * sVal);

        errSum += Math.abs(restoredLum - avgSurrLum) * weight;
        weightSum += weight;
      }
    }

    const err = weightSum > 0 ? errSum / weightSum : Infinity;
    if (err < minError) {
      minError = err;
      bestOpacity = op;
    }
  }

  return bestOpacity;
}
