import { AlphaMaskManager } from './alphaMasks.ts';
import { diffusionFill, dilateMask } from './diffusionFill.ts';
import { isValidMask } from './maskGeometry.ts';
import { nccAt, scanCorner } from './nccMatcher.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import type {
  DetectionResult,
  LogoVersion,
  RemovalResult,
  WatermarkCorner,
  WatermarkSettings,
} from './types.ts';

export class WatermarkEngine {
  private maskManager: AlphaMaskManager;
  private ready = false;

  constructor(maskManager?: AlphaMaskManager) {
    this.maskManager = maskManager ?? new AlphaMaskManager();
  }

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
    if (!Number.isFinite(s.maskScale) || s.maskScale <= 0) s.maskScale = 1;
    const { width, height, data } = imageData;
    const minDim = Math.min(width, height);
    const resScale = minDim / 1080;
    const { logoSize: expectedLogoSize, margin: canonicalMargin } = this.getWatermarkConfig(width, height);

    const versionsToTest: Array<'sparkle' | 'classic' | 'new' | 'white' | 'old'> =
      s.logoVersion === 'auto'
        ? (minDim <= 720 ? ['sparkle'] : ['sparkle', 'new'])
        : s.logoVersion === 'sparkle' || s.logoVersion === 'old'
        ? ['sparkle', 'new']
        : s.logoVersion === 'new'
        ? ['new', 'sparkle']
        : [s.logoVersion];

    const computedClassic = Math.round(84 * resScale * s.maskScale);
    const computedSparkle = Math.round(96 * resScale * s.maskScale);

    // Every nominal template size is scaled exactly once. Removal reuses the
    // winning template, so the multiplier must never be applied a second time.
    const nominalSizes = [96, 84, 72, 64, 56, 48, 45, 42, 38, 36, 32, 28, 24];
    const sizeSet = new Set<number>();
    for (const nominal of nominalSizes) {
      const scaled = Math.round(nominal * s.maskScale);
      if (scaled >= 20 && scaled <= minDim * 0.4) sizeSet.add(scaled);
    }
    if (computedClassic >= 20 && computedClassic <= minDim * 0.4) sizeSet.add(computedClassic);
    if (computedSparkle >= 20 && computedSparkle <= minDim * 0.4) sizeSet.add(computedSparkle);

    const expectedSize = minDim <= 720 ? 48 : (width > 1024 && height > 1024 ? 96 : 84);
    const targetSizes = Array.from(sizeSet).sort(
      (a, b) => Math.abs(a - expectedSize) - Math.abs(b - expectedSize)
    );

    const baseSizes: Array<{ size: number; version: 'sparkle' | 'classic' | 'new' | 'white' | 'old'; alphaMap: Float32Array }> = [];
    const pushCandidate = (
      size: number,
      version: 'sparkle' | 'classic' | 'new' | 'white' | 'old',
      alphaMap: Float32Array
    ) => {
      // A mask whose array length does not match its declared size cannot be
      // correlated or inverted safely; skip it instead of reading garbage.
      if (isValidMask({ alphaMap, size })) baseSizes.push({ size, version, alphaMap });
    };

    let pushed84 = false;
    for (const ver of versionsToTest) {
      for (const sz of targetSizes) {
        if (sz === 96) {
          const v = ver === 'classic' ? 'classic' : ver === 'new' ? 'new' : ver === 'white' ? 'white' : 'sparkle';
          pushCandidate(96, v, this.maskManager.getBaseMap(96, ver as LogoVersion));
        } else if (sz === 84) {
          if (!pushed84 && (ver === 'classic' || s.logoVersion === 'auto' || ver === 'sparkle' || ver === 'old')) {
            pushed84 = true;
            pushCandidate(84, 'classic', this.maskManager.getBaseMap(84, 'classic'));
          }
        } else if (sz === 48) {
          const v = ver === 'classic' ? 'classic' : ver === 'new' ? 'new' : ver === 'white' ? 'white' : 'sparkle';
          pushCandidate(48, v, this.maskManager.getBaseMap(48, ver as LogoVersion));
        } else {
          // Scaled masks derive from their native assets
          const baseRef = sz > 64 ? 96 : ver === 'classic' ? 84 : 48;
          const scaled = this.maskManager.getScaledMask(baseRef, sz / baseRef, ver as LogoVersion);
          const v = ver === 'classic' ? 'classic' : ver === 'new' ? 'new' : ver === 'white' ? 'white' : 'sparkle';
          pushCandidate(scaled.size, v, scaled.alphaMap);
        }
      }
    }

    // All mask templates failed to load or were malformed. Report a clean
    // non-detection instead of dereferencing an empty candidate list.
    if (baseSizes.length === 0) {
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

    let bestCandidate: {
      size: number;
      version: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
      corner: WatermarkCorner;
      alphaMap: Float32Array;
      x: number;
      y: number;
      ncc: number;
      effScore?: number;
      autoX: number;
      autoY: number;
      method: 'auto' | 'scan' | 'forced';
    } | null = null;

    if (s.forcePosition && Number.isFinite(s.forcePosition.x) && Number.isFinite(s.forcePosition.y)) {
      const targetSize = s.forcePosition.size || (width > 1024 && height > 1024 ? 96 : 48);
      const chosen = baseSizes.reduce(
        (best, current) =>
          Math.abs(current.size - targetSize) < Math.abs(best.size - targetSize) ? current : best,
        baseSizes[0]
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
        ncc: Math.max(score, s.nccAccept),
        autoX: width - 64 - chosen.size,
        autoY: height - 64 - chosen.size,
        method: 'forced',
      };
    } else {
      // Standard Gemini image margins checked first
      const standardMargins = [64, 32, 48, 96, 72, 24, 20, 16, 28, 36];
      const fallbackMargins = [120, 128, 132, 138, 144, 186, 222];
      const stdSet = new Set<number>();
      for (const m of standardMargins) {
        stdSet.add(m);
        const scaled = Math.round(m * resScale);
        if (scaled >= 12 && scaled < minDim * 0.4) stdSet.add(scaled);
      }
      const standardPairs: [number, number][] = Array.from(stdSet).map((m) => [m, m]);

      const fallbackSet = new Set<number>();
      for (const m of fallbackMargins) {
        fallbackSet.add(m);
        const scaled = Math.round(m * resScale);
        if (scaled >= 12 && scaled < minDim * 0.4) fallbackSet.add(scaled);
      }
      const fallbackPairs: [number, number][] = Array.from(fallbackSet).map((m) => [m, m]);

      const commonRatios = [
        [1.2, 1.0], [1.0, 1.2],
        [1.33, 1.0], [1.0, 1.33],
        [1.5, 1.0], [1.0, 1.5],
      ];
      const ratioPairs: [number, number][] = [];
      for (const m of stdSet) {
        for (const [rx, ry] of commonRatios) {
          const mx = Math.round(m * rx);
          const my = Math.round(m * ry);
          if (mx < minDim * 0.4 && my < minDim * 0.4) {
            ratioPairs.push([mx, my]);
          }
        }
      }

      const cornerOrder: Array<'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'> =
        s.corner === 'auto'
          ? ['bottom-right', 'bottom-left', 'top-right', 'top-left']
          : [s.corner];

      for (const cornerKey of cornerOrder) {
        const testMarginPairs = (pairs: [number, number][]): void => {
          for (const candidate of baseSizes) {
            for (const [mx, my] of pairs) {
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
              const isCanonical =
                cornerKey === 'bottom-right' &&
                mx === canonicalMargin &&
                my === canonicalMargin &&
                candidate.size === expectedLogoSize;
              const effScore = isCanonical ? score + 0.03 : score;

              if (!bestCandidate || effScore > (bestCandidate.effScore ?? bestCandidate.ncc)) {
                bestCandidate = {
                  size: candidate.size,
                  version: candidate.version,
                  corner: cornerKey,
                  alphaMap: candidate.alphaMap,
                  x: autoX,
                  y: autoY,
                  ncc: score,
                  effScore,
                  autoX,
                  autoY,
                  method: 'auto',
                };
              }
              if (bestCandidate && bestCandidate.ncc >= 0.70) break;
            }
            if (bestCandidate && bestCandidate.ncc >= 0.70) break;
          }
        };

        // Phase 1a: Test standard symmetric margin candidates
        testMarginPairs(standardPairs);

        // Phase 1b: Test fallback / non-symmetric ratio margins only if standard margins didn't find acceptable match
        if (!bestCandidate || bestCandidate.ncc < Math.max(0.4, s.nccAccept)) {
          testMarginPairs(fallbackPairs);
          testMarginPairs(ratioPairs);
        }

        // If confirmed in margins for this corner, do not evaluate further corners
        if (bestCandidate && bestCandidate.ncc >= s.nccAccept) break;

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
            if (!bestCandidate || scan.ncc > (bestCandidate.effScore ?? bestCandidate.ncc)) {
              bestCandidate = {
                size: candidate.size,
                version: candidate.version,
                corner: cornerKey,
                alphaMap: candidate.alphaMap,
                x: scan.x,
                y: scan.y,
                ncc: scan.ncc,
                effScore: scan.ncc,
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
    const gainApplied = isDrifted ? s.gainDrift : 1.0;

    return {
      detected: bestCandidate.ncc >= s.nccAccept,
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
      alphaMap: bestCandidate.alphaMap,
      maskSize: bestCandidate.size,
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

    // Reuse the exact template that produced the detection. Re-deriving it from
    // detection.size would apply maskScale twice and could return a smaller
    // cached base map (e.g. a 48px map labelled as 72px).
    const activeVersion = detection.detectedVersion || (s.logoVersion === 'auto' ? 'sparkle' : s.logoVersion);
    const mask = detection.alphaMap;
    const maskSize = detection.maskSize ?? detection.size;

    if (!mask || !isValidMask({ alphaMap: mask, size: maskSize })) {
      return {
        cleanImageData: sourceImageData,
        result: {
          success: false,
          message: 'Watermark mask is unavailable or has an invalid size; no pixels were modified',
          position: { x: detection.x, y: detection.y },
          size: maskSize,
          confidence: detection.confidence,
          pixelsModified: 0,
          elapsedMs: Math.round(performance.now() - startTime),
          method: detection.method,
          drifted: detection.drifted,
          gainApplied: detection.gainApplied,
          detectedVersion: activeVersion,
        },
      };
    }

    const originX = detection.x;
    const originY = detection.y;

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
    const useInpainting =
      s.fillMode === 'on' || (s.fillMode === 'auto' && activeVersion === 'white');
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

    if (modifiedPixels === 0) {
      return {
        cleanImageData,
        result: {
          success: false,
          message: 'Detection succeeded but the mask contained no removable pixels',
          position: { x: originX, y: originY },
          size: maskSize,
          confidence: detection.confidence,
          pixelsModified: 0,
          elapsedMs,
          method: detection.method,
          drifted: detection.drifted,
          gainApplied: detection.gainApplied,
          detectedVersion: detection.detectedVersion,
          detectedCorner: detection.detectedCorner,
        },
      };
    }

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

        if (originX + x < 0 || originX + x >= width || originY + y < 0 || originY + y >= height) {
          continue;
        }
        const hIdx = ((originY + y) * width + (originX + x)) * 4;
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
