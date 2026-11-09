import { createFile, DataStream } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { diffusionFill, dilateMask } from './diffusionFill';
import type { WatermarkCorner } from './types';

export interface VideoSettings {
  baseStrength: number;
  opacityMode: 'auto' | 'custom' | string;
  opacityCustom: number;
  ceiling: number;
  overlayValue: number;
  edgeMode: 'auto' | 'on' | 'off';
  edgeStrength: number;
  edgeRadius: number;
  edgePasses: number;
  bitrateMult: number;
  corrThreshold: number;
  maskScale: number;
  logoVersion: 'auto' | 'old' | 'new' | 'white';
  corner: WatermarkCorner;
  fillMode: 'auto' | 'on' | 'off';
  fillThreshold: number;
  fillRadius: number;
}

export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  baseStrength: 1.0,
  opacityMode: 'auto',
  opacityCustom: 0.8,
  ceiling: 0.99,
  overlayValue: 250,
  edgeMode: 'off',
  edgeStrength: 0.6,
  edgeRadius: 2,
  edgePasses: 120,
  bitrateMult: 1.15,
  corrThreshold: 0.35,
  maskScale: 1.0,
  logoVersion: 'auto',
  corner: 'auto',
  fillMode: 'auto',
  fillThreshold: 0.85,
  fillRadius: 1,
};

export interface VideoProgress {
  stage: 'demux' | 'process' | 'mux' | 'done';
  ratio: number;
  detectedVersion?: 'old' | 'new' | 'white';
  detectedCorner?: WatermarkCorner;
}



const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

export interface AlphaMapData {
  values: Float32Array;
  colorValues?: Float32Array;
  width: number;
  height: number;
  baseMaskSize: number;
}

export async function loadAlphaMap(
  url: string,
  size: number,
  withColor: boolean
): Promise<AlphaMapData> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error(`Failed to load video mask: ${url}`));
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context failed');

  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const values = new Float32Array(size * size);
  const colorValues = withColor ? new Float32Array(size * size * 3) : undefined;

  for (let i = 0; i < values.length; i++) {
    const p = 4 * i;
    if (withColor && colorValues) {
      values[i] = data[p + 3] / 255.0;
      colorValues[3 * i] = data[p];
      colorValues[3 * i + 1] = data[p + 1];
      colorValues[3 * i + 2] = data[p + 2];
    } else {
      values[i] = Math.max(data[p], data[p + 1], data[p + 2]) / 255.0;
    }
  }

  return { values, colorValues, width: size, height: size, baseMaskSize: size };
}

const maskCache = new Map<string, AlphaMapData>();

export interface MaskCandidateSpec {
  alphaMap: AlphaMapData;
  baseMaskSize: number;
  maskSize: number;
  version: 'old' | 'new' | 'white';
}

export async function getMaskData(
  is1080p: boolean,
  logoVersion: 'old' | 'new' | 'white',
  maskScale: number
): Promise<MaskCandidateSpec> {
  let maskUrl: string;
  let withColor: boolean;
  let baseMaskSize: number;

  if (logoVersion === 'new') {
    maskUrl = is1080p ? '/masks/sparkle-2026-96.png' : '/masks/sparkle-2026-48.png';
    withColor = false;
    baseMaskSize = is1080p ? 96 : 48;
  } else if (logoVersion === 'white') {
    maskUrl = is1080p ? '/masks/sparkle-hw-96.png' : '/masks/sparkle-hw-48.png';
    withColor = false;
    baseMaskSize = is1080p ? 96 : 48;
  } else {
    // 'old' Classic Gemini Star: 84px RGBA for 1080p, 48px for 720p
    maskUrl = is1080p ? '/masks/gemini-star_paired_star_mask.png' : '/masks/bg_48.png';
    withColor = is1080p;
    baseMaskSize = is1080p ? 84 : 48;
  }

  const maskSize = Math.max(8, Math.round(baseMaskSize * Math.min(Math.max(maskScale, 0.5), 3)));
  const cacheKey = `${maskUrl}_${maskSize}_${withColor}`;
  let alphaMap = maskCache.get(cacheKey);
  if (!alphaMap) {
    alphaMap = await loadAlphaMap(maskUrl, maskSize, withColor);
    maskCache.set(cacheKey, alphaMap);
  }
  return { alphaMap, baseMaskSize, maskSize, version: logoVersion };
}

export async function loadAllMaskCandidates(
  logoVersion: 'auto' | 'old' | 'new' | 'white',
  maskScale: number,
  width?: number,
  height?: number
): Promise<MaskCandidateSpec[]> {
  // If width and height are provided, generate resolution-aware candidate sizes
  const minDim = width && height ? Math.min(width, height) : 1080;
  const resScale = minDim / 1080;

  // At <= 720p, Google video watermarks are strictly the Classic Star (48px / bg_48).
  // 2026 Sparkle is exclusive to 1080p+ models (or when explicitly forced by user).
  const versions: Array<'old' | 'new' | 'white'> =
    logoVersion === 'auto'
      ? (minDim <= 720 ? ['old'] : ['old', 'new'])
      : [logoVersion];

  const cClassic = Math.round(84 * resScale * maskScale);
  const cSparkle = Math.round(96 * resScale * maskScale);
  const cHalf = Math.round(48 * (minDim / 720) * maskScale);
  const cThird = Math.round(32 * (minDim / 480) * maskScale);

  const minAllowed = Math.max(20, Math.round(20 * maskScale));
  const sizeSet = new Set<number>();
  for (const sz of [cSparkle, cClassic, cHalf, cThird]) {
    if (sz >= minAllowed && sz <= minDim * 0.4) {
      sizeSet.add(sz);
    }
  }

  // Include standard nominal sizes across all resolutions down to mobile/compressed
  for (const sz of [96, 84, 72, 64, 56, 48, 45, 42, 38, 36, 34, 32, 30, 28, 24]) {
    const scaled = Math.round(sz * maskScale);
    if (scaled >= minAllowed && scaled <= minDim * 0.4) {
      sizeSet.add(scaled);
    }
  }

  const sizes = Array.from(sizeSet).sort((a, b) => b - a);
  const results: MaskCandidateSpec[] = [];

  for (const ver of versions) {
    for (const size of sizes) {
      if (ver === 'new') {
        const maskUrl = size >= 64 ? '/masks/sparkle-2026-96.png' : '/masks/sparkle-2026-48.png';
        const withColor = false;
        const cacheKey = `${maskUrl}_${size}_${withColor}`;
        let alphaMap = maskCache.get(cacheKey);
        if (!alphaMap) {
          alphaMap = await loadAlphaMap(maskUrl, size, withColor);
          maskCache.set(cacheKey, alphaMap);
        }
        results.push({ alphaMap, baseMaskSize: size, maskSize: size, version: ver });
      } else if (ver === 'white') {
        const maskUrl = size >= 64 ? '/masks/sparkle-hw-96.png' : '/masks/sparkle-hw-48.png';
        const withColor = false;
        const cacheKey = `${maskUrl}_${size}_${withColor}`;
        let alphaMap = maskCache.get(cacheKey);
        if (!alphaMap) {
          alphaMap = await loadAlphaMap(maskUrl, size, withColor);
          maskCache.set(cacheKey, alphaMap);
        }
        results.push({ alphaMap, baseMaskSize: size, maskSize: size, version: ver });
      } else {
        // 'old' Classic Gemini Star:
        // For <= 56px (720p/480p/compressed): use /masks/bg_48.png with withColor = false
        // For > 56px (1080p/4K): use /masks/gemini-star_paired_star_mask.png with withColor = true (and /masks/bg_96.png)
        if (size <= 56) {
          const monoUrl = '/masks/bg_48.png';
          const monoKey = `${monoUrl}_${size}_false`;
          let monoAlpha = maskCache.get(monoKey);
          if (!monoAlpha) {
            monoAlpha = await loadAlphaMap(monoUrl, size, false);
            maskCache.set(monoKey, monoAlpha);
          }
          results.push({ alphaMap: monoAlpha, baseMaskSize: size, maskSize: size, version: ver });
        } else {
          // Native 1080p chromatic paired star mask
          const pairedUrl = '/masks/gemini-star_paired_star_mask.png';
          const pairedKey = `${pairedUrl}_${size}_true`;
          let pairedAlpha = maskCache.get(pairedKey);
          if (!pairedAlpha) {
            pairedAlpha = await loadAlphaMap(pairedUrl, size, true);
            maskCache.set(pairedKey, pairedAlpha);
          }
          results.push({ alphaMap: pairedAlpha, baseMaskSize: size, maskSize: size, version: ver });

          // Also include bg_96 for monochromatic fallback
          const monoUrl = '/masks/bg_96.png';
          const monoKey = `${monoUrl}_${size}_false`;
          let monoAlpha = maskCache.get(monoKey);
          if (!monoAlpha) {
            monoAlpha = await loadAlphaMap(monoUrl, size, false);
            maskCache.set(monoKey, monoAlpha);
          }
          results.push({ alphaMap: monoAlpha, baseMaskSize: size, maskSize: size, version: ver });
        }
      }
    }
  }

  return results;
}

function demuxMp4(buffer: ArrayBuffer): Promise<{
  videoTrack: any;
  audioTrack: any;
  videoSamples: any[];
  audioSamples: any[];
  videoDescription: Uint8Array | null;
}> {
  return new Promise((resolve, reject) => {
    const mp4file = createFile();
    const videoSamples: any[] = [];
    const audioSamples: any[] = [];
    let videoTrack: any = null;
    let audioTrack: any = null;

    mp4file.onError = (e: any) => reject(new Error('MP4Box error: ' + e));

    mp4file.onReady = (info: any) => {
      videoTrack = info.videoTracks && info.videoTracks[0];
      audioTrack = info.audioTracks && info.audioTracks[0];

      if (!videoTrack) return reject(new Error('No video track found'));

      mp4file.setExtractionOptions(videoTrack.id, 'video', { nbSamples: 1000000 });
      if (audioTrack) {
        mp4file.setExtractionOptions(audioTrack.id, 'audio', { nbSamples: 1000000 });
      }
      mp4file.start();
    };

    mp4file.onSamples = (_id: number, user: string, samples: any[]) => {
      const isVideo = user === 'video';
      const target = isVideo ? videoSamples : audioSamples;
      for (const s of samples) {
        target.push({
          data: s.data.slice(0),
          cts: s.cts,
          dts: s.dts,
          duration: s.duration,
          timescale: s.timescale,
          is_sync: s.is_sync,
        });
      }
    };

    const copyBuffer = buffer.slice(0) as any;
    copyBuffer.fileStart = 0;
    mp4file.appendBuffer(copyBuffer);
    mp4file.flush();

    // Extract SPS/PPS description
    let videoDescription: Uint8Array | null = null;
    if (videoTrack) {
      const track = mp4file.getTrackById(videoTrack.id);
      const entries = track?.mdia?.minf?.stbl?.stsd?.entries || [];
      for (const entry of entries) {
        const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
        if (!box) continue;
        const DS = DataStream;
        if (!DS) break;
        const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
        box.write(stream);
        videoDescription = new Uint8Array(stream.buffer, 8);
        break;
      }
    }

    resolve({
      videoTrack,
      audioTrack,
      videoSamples,
      audioSamples,
      videoDescription,
    });
  });
}

/**
 * Computes correlation between frame luminance and alpha map
 */
export function scoreCandidate(
  imageData: ImageData,
  cand: { x: number; y: number; alphaMap: AlphaMapData }
): number {
  let sumL = 0;
  let sumLL = 0;
  let sumA = 0;
  let sumAA = 0;
  let sumLA = 0;
  let count = 0;

  const { data, width } = imageData;
  const { values, width: aW, height: aH } = cand.alphaMap;

  for (let y = 0; y < aH; y++) {
    for (let x = 0; x < aW; x++) {
      const alpha = values[y * aW + x];
      if (alpha <= 0.08) continue;

      const pIdx = ((cand.y + y) * width + (cand.x + x)) * 4;
      const lum = (data[pIdx] + data[pIdx + 1] + data[pIdx + 2]) / 765.0;

      sumL += lum;
      sumLL += lum * lum;
      sumA += alpha;
      sumAA += alpha * alpha;
      sumLA += lum * alpha;
      count++;
    }
  }

  if (count === 0) return -1;
  const meanL = sumL / count;
  const meanA = sumA / count;

  const varL = sumLL / count - meanL * meanL;
  const varA = sumAA / count - meanA * meanA;

  if (varL <= 1e-7 || varA <= 1e-7) return -1;

  const stdL = Math.sqrt(Math.max(0, varL));
  const stdA = Math.sqrt(Math.max(0, varA));
  const covar = sumLA / count - meanL * meanA;

  return covar / (stdL * stdA);
}

/**
 * Dilation and neighbor-averaging edge cleanup to smooth compression boundaries
 */
function applyEdgeCleanup(
  pixels: Uint8ClampedArray,
  frameWidth: number,
  _frameHeight: number,
  targetX: number,
  targetY: number,
  maskWidth: number,
  maskHeight: number,
  watermarkTouched: Uint8Array,
  edgeStrength: number,
  edgeRadius: number,
  maxPasses: number
) {
  const u = maskWidth;
  const h = maskHeight;
  const dilated = new Uint8Array(u * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < u; x++) {
      if (watermarkTouched[y * u + x]) {
        for (let dy = -edgeRadius; dy <= edgeRadius; dy++) {
          for (let dx = -edgeRadius; dx <= edgeRadius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < u && ny >= 0 && ny < h) {
              dilated[ny * u + nx] = 1;
            }
          }
        }
      }
    }
  }

  const boundary = new Uint8Array(dilated);
  const passes = Math.min(maxPasses, Math.max(8, u + h));

  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    const nextBoundary = new Uint8Array(boundary);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < u; x++) {
        if (!boundary[y * u + x]) continue;

        let neighborCount = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= u || ny < 0 || ny >= h || boundary[ny * u + nx]) continue;

            const pIdx = ((targetY + ny) * frameWidth + (targetX + nx)) * 4;
            sumR += pixels[pIdx];
            sumG += pixels[pIdx + 1];
            sumB += pixels[pIdx + 2];
            neighborCount++;
          }
        }

        if (neighborCount === 0) continue;

        const pIdx = ((targetY + y) * frameWidth + (targetX + x)) * 4;
        const avgR = sumR / neighborCount;
        const avgG = sumG / neighborCount;
        const avgB = sumB / neighborCount;

        pixels[pIdx] = Math.round(pixels[pIdx] * (1 - edgeStrength) + avgR * edgeStrength);
        pixels[pIdx + 1] = Math.round(pixels[pIdx + 1] * (1 - edgeStrength) + avgG * edgeStrength);
        pixels[pIdx + 2] = Math.round(pixels[pIdx + 2] * (1 - edgeStrength) + avgB * edgeStrength);

        nextBoundary[y * u + x] = 0;
        changed++;
      }
    }

    boundary.set(nextBoundary);
    if (changed === 0) break;
  }
}

export interface TargetCandidate {
  x: number;
  y: number;
  alphaMap: AlphaMapData;
  score: number;
  opacity: number;
  baseStrength: number;
  method: string;
  version: 'old' | 'new' | 'white';
  corner: WatermarkCorner;
  hasWatermark: boolean;
  edgeCleanup?: { strength: number; radius: number; maxPasses: number };
}

/**
 * Closed-form adaptive opacity search based on surrounding 25% boundary ring:
 * Computes restored background luminance across candidate opacities [1.0, 0.85, 0.75, 0.62]
 * and picks the opacity that minimizes edge disparity with the surrounding background.
 */
export function computeOptimalOpacity(
  imageData: ImageData,
  target: { x: number; y: number; alphaMap: AlphaMapData; baseStrength?: number }
): number {
  if (target.alphaMap.colorValues !== undefined) return 1.0;

  const candidateOpacities = [1.0, 0.85, 0.75, 0.62];
  const pad = Math.max(8, Math.round(0.25 * target.alphaMap.width));
  const rMin = Math.max(0, target.x - pad);
  const nMin = Math.max(0, target.y - pad);
  const iMax = Math.min(imageData.width, target.x + target.alphaMap.width + pad);
  const oMax = Math.min(imageData.height, target.y + target.alphaMap.height + pad);

  let surrLumSum = 0;
  let surrCount = 0;
  const { data, width } = imageData;

  for (let y = nMin; y < oMax; y++) {
    for (let x = rMin; x < iMax; x++) {
      if (
        x >= target.x &&
        x < target.x + target.alphaMap.width &&
        y >= target.y &&
        y < target.y + target.alphaMap.height
      ) {
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
  const baseStrength = target.baseStrength ?? 1.0;
  const aW = target.alphaMap.width;
  const aH = target.alphaMap.height;
  const values = target.alphaMap.values;

  for (const op of candidateOpacities) {
    let errSum = 0;
    let weightSum = 0;

    for (let y = 0; y < aH; y++) {
      for (let x = 0; x < aW; x++) {
        const oIdx = y * aW + x;
        const sVal = values[oIdx];
        if (sVal <= 0.04) continue;

        const effA = Math.min(sVal * baseStrength * op, op);
        const invA = 1.0 - effA;
        if (invA <= 1e-4) continue;

        const hIdx = ((target.y + y) * width + (target.x + x)) * 4;
        const invR = (data[hIdx] - effA * 250) / invA;
        const invG = (data[hIdx + 1] - effA * 250) / invA;
        const invB = (data[hIdx + 2] - effA * 250) / invA;
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

function configureCandidateEdge(
  cand: TargetCandidate,
  s: VideoSettings,
  imgData?: ImageData
): TargetCandidate {
  if (imgData) {
    if (s.opacityMode === 'auto') {
      cand.opacity = computeOptimalOpacity(imgData, cand);
    } else if (s.opacityMode === 'custom') {
      cand.opacity = s.opacityCustom ?? 0.8;
    } else {
      const parsed = parseFloat(s.opacityMode as string);
      cand.opacity = Number.isFinite(parsed) ? parsed : computeOptimalOpacity(imgData, cand);
    }
  }

  const isColorMask = cand.alphaMap.colorValues !== undefined;
  const shouldEdge = s.edgeMode === 'on' || (s.edgeMode === 'auto' && !isColorMask);
  if (shouldEdge) {
    cand.edgeCleanup = {
      strength: s.edgeStrength,
      radius: s.edgeRadius,
      maxPasses: s.edgePasses,
    };
  } else {
    delete cand.edgeCleanup;
  }
  return cand;
}

interface CornerScanConfig {
  corner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  getCandXY: (mx: number, my: number, aW: number, aH: number) => { x: number; y: number };
  getSpatialBounds: (aW: number, aH: number) => { startX: number; maxX: number; startY: number; maxY: number };
}

function getCornerConfigs(width: number, height: number): Record<'bottom-right' | 'bottom-left' | 'top-right' | 'top-left', CornerScanConfig> {
  return {
    'bottom-right': {
      corner: 'bottom-right',
      getCandXY: (mx, my, aW, aH) => ({
        x: Math.min(Math.max(width - mx - aW, 0), width - aW),
        y: Math.min(Math.max(height - my - aH, 0), height - aH),
      }),
      getSpatialBounds: (aW, aH) => ({
        startX: Math.max(0, Math.floor(0.68 * width)),
        maxX: width - aW,
        startY: Math.max(0, Math.floor(0.68 * height)),
        maxY: height - aH,
      }),
    },
    'bottom-left': {
      corner: 'bottom-left',
      getCandXY: (mx, my, aW, aH) => ({
        x: Math.min(Math.max(mx, 0), width - aW),
        y: Math.min(Math.max(height - my - aH, 0), height - aH),
      }),
      getSpatialBounds: (aW, aH) => ({
        startX: 0,
        maxX: Math.min(width - aW, Math.floor(0.32 * width)),
        startY: Math.max(0, Math.floor(0.68 * height)),
        maxY: height - aH,
      }),
    },
    'top-right': {
      corner: 'top-right',
      getCandXY: (mx, my, aW, aH) => ({
        x: Math.min(Math.max(width - mx - aW, 0), width - aW),
        y: Math.min(Math.max(my, 0), height - aH),
      }),
      getSpatialBounds: (aW, aH) => ({
        startX: Math.max(0, Math.floor(0.68 * width)),
        maxX: width - aW,
        startY: 0,
        maxY: Math.min(height - aH, Math.floor(0.32 * height)),
      }),
    },
    'top-left': {
      corner: 'top-left',
      getCandXY: (mx, my, aW, aH) => ({
        x: Math.min(Math.max(mx, 0), width - aW),
        y: Math.min(Math.max(my, 0), height - aH),
      }),
      getSpatialBounds: (aW, aH) => ({
        startX: 0,
        maxX: Math.min(width - aW, Math.floor(0.32 * width)),
        startY: 0,
        maxY: Math.min(height - aH, Math.floor(0.32 * height)),
      }),
    },
  };
}

/**
 * Aspect-ratio & multi-corner invariant watermark detector:
 * Evaluates candidate margins (symmetric & asymmetric for 16:9, 9:16, 1:1, 4:3, 21:9, letterboxed),
 * followed by 2D spatial search across the specified corner or all 4 corners in auto mode.
 */
export function detectBestWatermarkCandidate(
  imgData: ImageData,
  width: number,
  height: number,
  s: VideoSettings,
  masks: MaskCandidateSpec[]
): TargetCandidate {
  let bestCand: TargetCandidate | null = null;
  const minDim = Math.min(width, height);
  const resScale = minDim / 1080;

  const baseMargins = [222, 186, 144, 138, 132, 128, 120, 96, 72, 64, 48, 36, 32, 28, 24, 20, 16];
  const marginSet = new Set<number>();
  for (const m of baseMargins) {
    marginSet.add(m);
    const scaled = Math.round(m * resScale);
    if (scaled >= 12 && scaled < minDim * 0.4) marginSet.add(scaled);
  }
  const margins = Array.from(marginSet).sort((a, b) => b - a);
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

  const allConfigs = getCornerConfigs(width, height);
  const primaryCorner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' =
    s.corner === 'auto' ? 'bottom-right' : s.corner;

  const evaluateCorner = (cornerKey: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left') => {
    const cfg = allConfigs[cornerKey];
    let cornerBest: TargetCandidate | null = null;

    // Tier 1: Multi-margin matrix for this corner
    for (const maskItem of masks) {
      const { alphaMap, version } = maskItem;
      const aW = alphaMap.width;
      const aH = alphaMap.height;

      for (const [mx, my] of marginPairs) {
        const { x: candX, y: candY } = cfg.getCandXY(mx, my, aW, aH);
        const score = scoreCandidate(imgData, { x: candX, y: candY, alphaMap });

        if (score > 0.15) {
          let refinedScore = score;
          let rx = candX;
          let ry = candY;
          for (let dy = -8; dy <= 8; dy++) {
            for (let dx = -8; dx <= 8; dx++) {
              const tx = Math.min(Math.max(candX + dx, 0), width - aW);
              const ty = Math.min(Math.max(candY + dy, 0), height - aH);
              const sc = scoreCandidate(imgData, { x: tx, y: ty, alphaMap });
              if (sc > refinedScore) {
                refinedScore = sc;
                rx = tx;
                ry = ty;
              }
            }
          }
          if (!cornerBest || refinedScore > cornerBest.score) {
            cornerBest = {
              x: rx,
              y: ry,
              alphaMap,
              score: refinedScore,
              opacity: 1.0,
              baseStrength: 1.0,
              method: `${cornerKey} margin (${mx}, ${my}) refined`,
              version,
              corner: cornerKey,
              hasWatermark: refinedScore >= s.corrThreshold,
            };
          }
        } else if (!cornerBest || score > cornerBest.score) {
          cornerBest = {
            x: candX,
            y: candY,
            alphaMap,
            score,
            opacity: 1.0,
            baseStrength: 1.0,
            method: `${cornerKey} margin (${mx}, ${my})`,
            version,
            corner: cornerKey,
            hasWatermark: score >= s.corrThreshold,
          };
        }
      }
    }

    if (cornerBest && cornerBest.score >= 0.42) {
      return cornerBest;
    }

    // Tier 2: 2D Spatial Quadrant Scan
    const stride = 4;
    for (const maskItem of masks) {
      const { alphaMap, version } = maskItem;
      const { startX, maxX, startY, maxY } = cfg.getSpatialBounds(alphaMap.width, alphaMap.height);
      if (maxX < startX || maxY < startY) continue;

      let localBestX = -1;
      let localBestY = -1;
      let localBestScore = -1;

      for (let y = startY; y <= maxY; y += stride) {
        for (let x = startX; x <= maxX; x += stride) {
          const score = scoreCandidate(imgData, { x, y, alphaMap });
          if (score > localBestScore) {
            localBestScore = score;
            localBestX = x;
            localBestY = y;
          }
        }
      }

      if (localBestX >= 0 && localBestScore > 0.15) {
        const rMinX = Math.max(startX, localBestX - stride);
        const rMaxX = Math.min(maxX, localBestX + stride);
        const rMinY = Math.max(startY, localBestY - stride);
        const rMaxY = Math.min(maxY, localBestY + stride);

        for (let y = rMinY; y <= rMaxY; y++) {
          for (let x = rMinX; x <= rMaxX; x++) {
            const score = scoreCandidate(imgData, { x, y, alphaMap });
            if (score > localBestScore) {
              localBestScore = score;
              localBestX = x;
              localBestY = y;
            }
          }
        }

        if (!cornerBest || localBestScore > cornerBest.score) {
          cornerBest = {
            x: localBestX,
            y: localBestY,
            alphaMap,
            score: localBestScore,
            opacity: 1.0,
            baseStrength: 1.0,
            method: `${cornerKey} spatial scan refined`,
            version,
            corner: cornerKey,
            hasWatermark: localBestScore >= s.corrThreshold,
          };
        }
      }
    }

    return cornerBest;
  };

  // Phase 1: Search primary corner (bottom-right in auto mode)
  bestCand = evaluateCorner(primaryCorner);

  // If auto mode and primary corner didn't find watermark (score < threshold), search secondary corners
  if (s.corner === 'auto' && (!bestCand || bestCand.score < s.corrThreshold)) {
    const secondaryCorners: Array<'bottom-left' | 'top-right' | 'top-left'> = [
      'bottom-left',
      'top-right',
      'top-left',
    ];
    for (const sc of secondaryCorners) {
      const cand = evaluateCorner(sc);
      if (cand && (!bestCand || cand.score > bestCand.score)) {
        bestCand = cand;
      }
      if (bestCand && bestCand.score >= s.corrThreshold) break;
    }
  }

  if (bestCand && bestCand.score >= s.corrThreshold) {
    return configureCandidateEdge(bestCand, s, imgData);
  }

  const resultCand: TargetCandidate = bestCand || {
    x: Math.max(0, width - masks[0].alphaMap.width - 64),
    y: Math.max(0, height - masks[0].alphaMap.height - 64),
    alphaMap: masks[0].alphaMap,
    score: 0,
    opacity: 1.0,
    baseStrength: 1.0,
    method: 'fallback',
    version: masks[0].version,
    corner: 'bottom-right' as WatermarkCorner,
    hasWatermark: false,
  };

  resultCand.hasWatermark = resultCand.score >= s.corrThreshold;
  return configureCandidateEdge(resultCand, s, imgData);
}

/**
 * Removes watermark from one frame's ImageData with closed-form inversion and harmonic inpainting
 */
export function cleanFrame(
  imageData: ImageData,
  target: {
    x: number;
    y: number;
    alphaMap: AlphaMapData;
    opacity?: number;
    baseStrength?: number;
    ceiling?: number;
    edgeCleanup?: { strength: number; radius: number; maxPasses: number };
  },
  settings: VideoSettings
): ImageData {
  const { data, width, height } = imageData;
  const out = new Uint8ClampedArray(data);
  const alphaMap = target.alphaMap;
  const u = alphaMap.width;
  const h = alphaMap.height;

  const opacity = target.opacity ?? 1.0;
  const baseStrength = target.baseStrength ?? settings.baseStrength;
  const ceiling = target.ceiling ?? settings.ceiling;
  const hasColor = alphaMap.colorValues !== undefined;
  const colorValues = alphaMap.colorValues;
  const overlayValue = settings.overlayValue ?? 250;
  const needEdge = !!target.edgeCleanup;
  const touched = needEdge ? new Uint8Array(u * h) : null;

  // Inpainting mask for saturated white core and blown-out highlights
  const useInpainting = settings.fillMode === 'on' || settings.fillMode === 'auto';
  const inpaintMask = useInpainting ? new Uint8Array(u * h) : null;
  const inpaintThreshold = settings.fillThreshold || 0.85;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < u; x++) {
      const n = y * u + x;
      const effAlpha = Math.min(alphaMap.values[n] * baseStrength * opacity, ceiling, 0.94);
      if (effAlpha < 0.002) continue;

      const invAlpha = 1.0 - effAlpha;
      if (invAlpha <= 1e-4) continue;

      const pIdx = ((target.y + y) * width + (target.x + x)) * 4;

      // Detect genuinely blown-out highlight underneath (sensor saturation at white)
      const isBlownHighlight =
        effAlpha > 0.60 &&
        data[pIdx] >= 248 &&
        data[pIdx + 1] >= 248 &&
        data[pIdx + 2] >= 248;

      const forceInpaint = settings.fillMode === 'on' && effAlpha >= inpaintThreshold;

      if (inpaintMask && (forceInpaint || isBlownHighlight)) {
        inpaintMask[n] = 1;
        if (touched) touched[n] = 1;
        continue;
      }

      if (touched) touched[n] = 1;

      for (let c = 0; c < 3; c++) {
        const bgVal = hasColor && colorValues ? colorValues[3 * n + c] : overlayValue;
        const restored = (data[pIdx + c] - effAlpha * bgVal) / invAlpha;
        out[pIdx + c] = Math.round(Math.min(255, Math.max(0, restored)));
      }
    }
  }

  // Harmonic diffusion inpainting on saturated core
  if (inpaintMask) {
    let hasMaskedPixels = false;
    for (let i = 0; i < inpaintMask.length; i++) {
      if (inpaintMask[i]) {
        hasMaskedPixels = true;
        break;
      }
    }
    if (hasMaskedPixels) {
      dilateMask(inpaintMask, u, settings.fillRadius || 1);
      diffusionFill(out, width, height, { x: target.x, y: target.y, size: u }, inpaintMask);
    }
  }

  if (target.edgeCleanup && touched) {
    applyEdgeCleanup(
      out,
      width,
      height,
      target.x,
      target.y,
      u,
      h,
      touched,
      target.edgeCleanup.strength,
      target.edgeCleanup.radius,
      target.edgeCleanup.maxPasses
    );
  }

  return new ImageData(out, width, height);
}

export interface VideoProcessResult {
  blob: Blob;
  hasWatermark: boolean;
  detectedVersion: 'old' | 'new' | 'white';
  detectedCorner?: WatermarkCorner;
  confidence: number;
  position: { x: number; y: number };
  size: number;
}

/**
 * Full in-browser WebCodecs Video Watermark Remover
 */
export async function processVideo(
  videoBuffer: ArrayBuffer,
  customSettings?: Partial<VideoSettings>,
  onProgress?: (progress: VideoProgress) => void
): Promise<VideoProcessResult> {
  const s: VideoSettings = { ...DEFAULT_VIDEO_SETTINGS, ...customSettings };

  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs API is not supported in this browser.');
  }

  onProgress?.({ stage: 'demux', ratio: 0 });
  const { videoTrack, audioTrack, videoSamples, audioSamples, videoDescription } =
    await demuxMp4(videoBuffer);
  onProgress?.({ stage: 'demux', ratio: 1 });

  const width = videoTrack.video.width;
  const height = videoTrack.video.height;
  const frameCount = videoSamples.length || 1;
  const timescale = videoSamples[0]?.timescale || videoTrack.timescale || 30000;
  const avgDuration = videoSamples.reduce((acc, cur) => acc + cur.duration, 0) / frameCount;
  const fps = Math.max(1, Math.round(timescale / avgDuration));

  // Preload resolution-aware mask candidate templates across versions
  const maskTemplates = await loadAllMaskCandidates(s.logoVersion, s.maskScale, width, height);

  // Setup MP4 Muxer
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio: audioTrack
      ? {
          codec: 'aac',
          sampleRate: audioTrack.audio.sample_rate,
          numberOfChannels: audioTrack.audio.channel_count,
        }
      : undefined,
  });

  // Bitrate calculation
  const bitrate = Math.round(width * height * fps * 0.12 * s.bitrateMult);

  let encoderError: any = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      encoderError = e;
      console.error('VideoEncoder error:', e);
    },
  });

  const encoderConfig: VideoEncoderConfig = {
    codec: 'avc1.640028', // H.264 High Profile
    width,
    height,
    bitrate,
    bitrateMode: 'variable',
    framerate: fps,
    avc: { format: 'avc' },
  };

  const isSupported = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!isSupported.supported) {
    encoderConfig.codec = 'avc1.42001f'; // Fallback to Baseline
  }
  encoder.configure(encoderConfig);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  let processedFrames = 0;
  const keyframeInterval = Math.max(1, 2 * fps);
  let decoderError: any = null;

  interface BufferedDecodedFrame {
    imgData: ImageData;
    timestamp: number;
    duration?: number | null;
    frameIndex: number;
    brLum: number;
  }

  const initialBuffer: BufferedDecodedFrame[] = [];
  const BUFFER_LIMIT = 24;
  let detectionDone = false;
  let targetCandidate: TargetCandidate | null = null;
  let hasWatermark = false;

  const flushBufferedFrames = () => {
    for (const b of initialBuffer) {
      const frameData = hasWatermark && targetCandidate
        ? cleanFrame(b.imgData, targetCandidate, s)
        : b.imgData;

      const videoFrameInit: VideoFrameBufferInit = {
        format: 'RGBA',
        codedWidth: width,
        codedHeight: height,
        timestamp: b.timestamp,
      };
      if (b.duration !== null && b.duration !== undefined) {
        videoFrameInit.duration = b.duration;
      }

      const cleanFrameObj = new VideoFrame(frameData.data.buffer, videoFrameInit);
      encoder.encode(cleanFrameObj, {
        keyFrame: b.frameIndex % keyframeInterval === 0,
      });
      cleanFrameObj.close();
    }
    initialBuffer.length = 0;
  };

  const executeDetection = () => {
    if (detectionDone || initialBuffer.length === 0) return;

    // Sample representative frames across the buffer (first, middle, end, plus peak lum)
    const sampleIndices = new Set<number>();
    sampleIndices.add(0);
    sampleIndices.add(initialBuffer.length - 1);
    sampleIndices.add(Math.floor(initialBuffer.length / 3));
    sampleIndices.add(Math.floor((initialBuffer.length * 2) / 3));

    let maxLumIdx = 0;
    for (let i = 0; i < initialBuffer.length; i++) {
      if (initialBuffer[i].brLum > initialBuffer[maxLumIdx].brLum) {
        maxLumIdx = i;
      }
    }
    sampleIndices.add(maxLumIdx);

    let bestCand: TargetCandidate | null = null;
    let bestFrame = initialBuffer[0];

    for (const idx of sampleIndices) {
      const f = initialBuffer[idx];
      if (f.brLum < 4) continue;
      const cand = detectBestWatermarkCandidate(f.imgData, width, height, s, maskTemplates);
      if (!bestCand || cand.score > bestCand.score) {
        bestCand = cand;
        bestFrame = f;
      }
      if (bestCand && bestCand.score >= 0.97) break; // Decisive near-perfect match found
    }

    if (!bestCand || bestCand.score < s.corrThreshold) {
      hasWatermark = false;
      targetCandidate = null;
      detectionDone = true;
      console.log(
        `[VideoEngine] No watermark detected (score < ${s.corrThreshold}). Preserving all frames 100% untouched.`
      );
      flushBufferedFrames();
      return;
    }

    const cand = bestCand;

    if (cand.score >= 0.70) {
      // Definitive watermark match (>= 70%) -> confirmed watermark
      hasWatermark = true;
      targetCandidate = cand;
    } else if (cand.score >= s.corrThreshold) {
      // Moderate confidence (0.35 - 0.70): verify against a distant frame
      const verifyFrames = initialBuffer.filter(
        (f) => f !== bestFrame && Math.abs(f.frameIndex - bestFrame.frameIndex) >= 4 && f.brLum > 8
      );
      if (verifyFrames.length > 0) {
        const vf = verifyFrames[verifyFrames.length - 1];
        const vScore = scoreCandidate(vf.imgData, {
          x: cand.x,
          y: cand.y,
          alphaMap: cand.alphaMap,
        });
        console.log(
          `[VideoEngine] Frame ${bestFrame.frameIndex} score: ${cand.score.toFixed(3)}, distant frame ${vf.frameIndex} score: ${vScore.toFixed(3)}`
        );
        // Real watermark is stationary across frames
        if (vScore >= s.corrThreshold * 0.75) {
          hasWatermark = true;
          targetCandidate = cand;
        } else {
          console.log('[VideoEngine] Transient visual feature rejected by multi-frame temporal check.');
          hasWatermark = false;
          targetCandidate = null;
        }
      } else {
        if (cand.score >= 0.45) {
          hasWatermark = true;
          targetCandidate = cand;
        } else {
          hasWatermark = false;
          targetCandidate = null;
        }
      }
    } else {
      hasWatermark = false;
      targetCandidate = null;
    }

    detectionDone = true;

    if (hasWatermark && targetCandidate) {
      console.log(
        `[VideoEngine] Watermark CONFIRMED: '${targetCandidate.version}' at (${targetCandidate.x}, ${targetCandidate.y}) via ${targetCandidate.method} with correlation score ${targetCandidate.score.toFixed(3)} [template: ${targetCandidate.alphaMap.width}x${targetCandidate.alphaMap.height}, frame: ${width}x${height}]`
      );
      console.log(
        `[VideoEngine] Candidate details: opacity=${targetCandidate.opacity}, hasColor=${targetCandidate.alphaMap.colorValues !== undefined}, edgeCleanup=${!!targetCandidate.edgeCleanup}`
      );
      onProgress?.({
        stage: 'process',
        ratio: 0,
        detectedVersion: targetCandidate.version,
        detectedCorner: targetCandidate.corner,
      });
    } else {
      console.log(
        `[VideoEngine] No watermark detected (score < ${s.corrThreshold}). Preserving all frames 100% untouched.`
      );
      onProgress?.({
        stage: 'process',
        ratio: 0,
      });
    }

    flushBufferedFrames();
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        const timestamp = frame.timestamp;
        const duration = frame.duration;
        ctx.drawImage(frame, 0, 0, width, height);
        frame.close();

        const imgData = ctx.getImageData(0, 0, width, height);

        if (!detectionDone) {
          // Compute bottom-right quadrant luminance
          const sx = Math.floor(width * 0.7);
          const sy = Math.floor(height * 0.7);
          let sum = 0, count = 0;
          for (let y = sy; y < height; y += 4) {
            for (let x = sx; x < width; x += 4) {
              const idx = (y * width + x) * 4;
              sum += (imgData.data[idx] + imgData.data[idx + 1] + imgData.data[idx + 2]) / 3;
              count++;
            }
          }
          const brLum = count > 0 ? sum / count : 0;

          initialBuffer.push({
            imgData,
            timestamp,
            duration,
            frameIndex: processedFrames++,
            brLum,
          });

          // Trigger detection if we have gathered enough frames or an illuminated frame after at least 12 frames
          if (initialBuffer.length >= BUFFER_LIMIT || (initialBuffer.length >= 12 && brLum > 30)) {
            executeDetection();
          }
        } else {
          // Direct streaming path
          const frameData = hasWatermark && targetCandidate
            ? cleanFrame(imgData, targetCandidate, s)
            : imgData;

          const videoFrameInit: VideoFrameBufferInit = {
            format: 'RGBA',
            codedWidth: width,
            codedHeight: height,
            timestamp,
          };
          if (duration !== null && duration !== undefined) {
            videoFrameInit.duration = duration;
          }

          const cleanFrameObj = new VideoFrame(frameData.data.buffer, videoFrameInit);
          encoder.encode(cleanFrameObj, {
            keyFrame: processedFrames % keyframeInterval === 0,
          });
          cleanFrameObj.close();

          processedFrames++;
          onProgress?.({ stage: 'process', ratio: processedFrames / frameCount });
        }
      } catch (e) {
        decoderError = e;
        try {
          frame.close();
        } catch {}
      }
    },
    error: (e) => {
      decoderError = e;
      console.error('VideoDecoder error:', e);
    },
  });

  decoder.configure({
    codec: videoTrack.codec,
    codedWidth: width,
    codedHeight: height,
    description: videoDescription || undefined,
  });

  onProgress?.({ stage: 'process', ratio: 0 });

  for (let i = 0; i < videoSamples.length; i++) {
    if (decoderError) throw decoderError;
    const sample = videoSamples[i];

    decoder.decode(
      new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: Math.round((1e6 * sample.cts) / sample.timescale),
        duration: Math.round((1e6 * sample.duration) / sample.timescale),
        data: sample.data,
      })
    );

    // Dynamic backpressure prevents hardware queue exhaustion and dropped frames
    while (decoder.decodeQueueSize > 5 || encoder.encodeQueueSize > 5) {
      await new Promise((r) => setTimeout(r, 4));
    }
  }

  if (!detectionDone) {
    executeDetection();
  }

  await decoder.flush();
  await encoder.flush();
  decoder.close();
  encoder.close();

  if (decoderError) throw decoderError;
  if (encoderError) throw encoderError;

  // Copy AAC audio samples untouched
  if (audioTrack && audioSamples.length > 0) {
    try {
      const sampleRate = audioTrack.audio.sample_rate;
      const channels = audioTrack.audio.channel_count;
      let rateIdx = AAC_SAMPLE_RATES.indexOf(sampleRate);
      if (rateIdx < 0) rateIdx = 4; // 44.1kHz default

      const audioConfig = {
        decoderConfig: {
          codec: 'mp4a.40.2',
          sampleRate,
          numberOfChannels: channels,
          description: new Uint8Array([
            (16 | (rateIdx >> 1)) & 0xff,
            (((rateIdx & 1) << 7) | (channels << 3)) & 0xff,
          ]),
        },
      };

      for (const sample of audioSamples) {
        muxer.addAudioChunk(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round((1e6 * sample.cts) / sample.timescale),
            duration: Math.round((1e6 * sample.duration) / sample.timescale),
            data: sample.data,
          }),
          audioConfig
        );
      }
    } catch (e) {
      console.warn('Audio copy failed, continuing silent:', e);
    }
  }

  onProgress?.({ stage: 'mux', ratio: 0.99 });
  muxer.finalize();
  onProgress?.({ stage: 'done', ratio: 1.0 });

  const finalBlob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  const resolvedTarget = (hasWatermark ? targetCandidate : null) as TargetCandidate | null;
  const detectedVersion: 'old' | 'new' | 'white' = resolvedTarget
    ? resolvedTarget.version
    : s.logoVersion === 'auto'
    ? 'old'
    : s.logoVersion;

  return {
    blob: finalBlob,
    hasWatermark,
    detectedVersion,
    detectedCorner: resolvedTarget?.corner || 'bottom-right',
    confidence: resolvedTarget ? resolvedTarget.score : 0,
    position: resolvedTarget ? { x: resolvedTarget.x, y: resolvedTarget.y } : { x: 0, y: 0 },
    size: resolvedTarget ? resolvedTarget.alphaMap.width : 0,
  };
}
