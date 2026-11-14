import { createFile, DataStream } from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { diffusionFill, dilateMask } from './diffusionFill';
import type { LogoVersion, WatermarkCorner } from './types';
import { resolveAssetUrl } from '../utils/assetUrl';
import { buildSeekablePlaybackBuffer, getRotationDegrees } from './mp4Utils.ts';
export { buildSeekablePlaybackBuffer, getRotationDegrees };

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
  logoVersion: LogoVersion;
  corner: WatermarkCorner;
  fillMode: 'auto' | 'on' | 'off';
  fillThreshold: number;
  fillRadius: number;
  forcePosition?: { x: number; y: number; size?: number } | null;
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
  forcePosition: null,
};

export interface VideoProgress {
  stage: 'demux' | 'process' | 'mux' | 'done';
  ratio: number;
  detectedVersion?: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
  detectedCorner?: WatermarkCorner;
}



const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const MAX_VIDEO_DIMENSION = 8192;
const MAX_VIDEO_DURATION_SECONDS = 15 * 60;
const BUFFER_LIMIT = 24;

let workerAssetBase: string | null = null;

/**
 * Workers cannot resolve `./` against the document. The main thread passes the
 * absolute public asset base once before processing starts.
 */
export function setVideoAssetBase(base: string): void {
  workerAssetBase = base;
}

function resolveMaskUrl(path: string): string {
  if (workerAssetBase) {
    const base = workerAssetBase.endsWith('/') ? workerAssetBase : `${workerAssetBase}/`;
    return new URL(path.replace(/^\/+/, ''), base).href;
  }
  return resolveAssetUrl(path);
}

export interface AlphaMapData {
  values: Float32Array;
  colorValues?: Float32Array;
  width: number;
  height: number;
  baseMaskSize: number;
}

async function loadMaskPixels(src: string, size: number): Promise<ImageData> {
  if (typeof document === 'undefined') {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      throw new Error('This browser cannot decode mask templates in a worker');
    }
    const response = await fetch(src);
    if (!response.ok) {
      throw new Error(`Failed to load video mask: ${src} (HTTP ${response.status})`);
    }
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('OffscreenCanvas 2D context failed');
      ctx.drawImage(bitmap, 0, 0, size, size);
      return ctx.getImageData(0, 0, size, size);
    } finally {
      bitmap.close();
    }
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error(`Failed to load video mask: ${src}`));
    img.src = src;
  });

  const canvas = document.createElement('canvas');
  // Always rasterize directly at the requested template size. Using the
  // natural image size here mixed rows whenever a larger asset was downscaled.
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D context failed');

  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

export async function loadAlphaMap(
  url: string,
  size: number,
  withColor: boolean
): Promise<AlphaMapData> {
  const resolvedUrl = resolveMaskUrl(url);
  const imageData = await loadMaskPixels(resolvedUrl, size);
  const data = imageData.data;
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
  version: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
}

export async function getMaskData(
  is1080p: boolean,
  logoVersion: 'sparkle' | 'classic' | 'new' | 'white' | 'old',
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
  } else if (logoVersion === 'sparkle') {
    maskUrl = is1080p ? '/masks/bg_96.png' : '/masks/bg_48.png';
    withColor = false;
    baseMaskSize = is1080p ? 96 : 48;
  } else {
    // 'classic' or 'old': 84px RGBA for 1080p, 48px for 720p
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
  logoVersion: LogoVersion,
  maskScale: number,
  width?: number,
  height?: number
): Promise<MaskCandidateSpec[]> {
  // If width and height are provided, generate resolution-aware candidate sizes
  const minDim = width && height ? Math.min(width, height) : 1080;
  const resScale = minDim / 1080;

  // At <= 720p, Google video watermarks are strictly the Classic Star (48px / bg_48).
  // 2026 Sparkle is exclusive to 1080p+ models (or when explicitly forced by user).
  const versions: Array<'sparkle' | 'classic' | 'new' | 'white' | 'old'> =
    logoVersion === 'auto'
      ? (minDim <= 720 ? ['classic'] : ['classic', 'new', 'sparkle'])
      : logoVersion === 'sparkle' || logoVersion === 'old'
      ? ['sparkle', 'new']
      : logoVersion === 'classic'
      ? ['classic']
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

  const getOrLoad = async (
    maskUrl: string,
    size: number,
    withColor: boolean
  ): Promise<AlphaMapData | null> => {
    const cacheKey = `${maskUrl}_${size}_${withColor}`;
    let alphaMap = maskCache.get(cacheKey);
    if (!alphaMap) {
      try {
        alphaMap = await loadAlphaMap(maskUrl, size, withColor);
        maskCache.set(cacheKey, alphaMap);
      } catch (e) {
        console.warn(`[VideoEngine] Mask load bypassed for ${maskUrl}:`, e);
        return null;
      }
    }
    return alphaMap;
  };

  for (const ver of versions) {
    for (const size of sizes) {
      if (ver === 'new') {
        const maskUrl = size >= 64 ? '/masks/sparkle-2026-96.png' : '/masks/sparkle-2026-48.png';
        const alphaMap = await getOrLoad(maskUrl, size, false);
        if (alphaMap) {
          results.push({ alphaMap, baseMaskSize: size, maskSize: size, version: ver });
        }
      } else if (ver === 'white') {
        const maskUrl = size >= 64 ? '/masks/sparkle-hw-96.png' : '/masks/sparkle-hw-48.png';
        const alphaMap = await getOrLoad(maskUrl, size, false);
        if (alphaMap) {
          results.push({ alphaMap, baseMaskSize: size, maskSize: size, version: ver });
        }
      } else {
        if (size <= 56) {
          const monoUrl = '/masks/bg_48.png';
          const monoAlpha = await getOrLoad(monoUrl, size, false);
          if (monoAlpha) {
            results.push({ alphaMap: monoAlpha, baseMaskSize: size, maskSize: size, version: ver });
          }
        } else {
          const pairedUrl = '/masks/gemini-star_paired_star_mask.png';
          const pairedAlpha = await getOrLoad(pairedUrl, size, true);
          if (pairedAlpha) {
            results.push({ alphaMap: pairedAlpha, baseMaskSize: size, maskSize: size, version: ver });
          }

          const monoUrl = '/masks/bg_96.png';
          const monoAlpha = await getOrLoad(monoUrl, size, false);
          if (monoAlpha) {
            results.push({ alphaMap: monoAlpha, baseMaskSize: size, maskSize: size, version: ver });
          }
        }
      }
    }
  }

  // Safety net: procedural astroid 4-point star if network/all masks fail
  if (results.length === 0) {
    for (const size of [84, 48]) {
      const values = new Float32Array(size * size);
      const center = (size - 1) / 2;
      const radius = size / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = Math.abs(x - center) / radius;
          const dy = Math.abs(y - center) / radius;
          const d = Math.pow(dx, 0.67) + Math.pow(dy, 0.67);
          if (d <= 1.0) {
            values[y * size + x] = Math.max(0, 1.0 - d);
          }
        }
      }
      results.push({
        alphaMap: { values, width: size, height: size, baseMaskSize: size },
        baseMaskSize: size,
        maskSize: size,
        version: 'old',
      });
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
          // MP4Box allocates a fresh sample buffer for every entry; keeping the
          // reference avoids a full second copy of the source video.
          data: s.data,
          cts: s.cts,
          dts: s.dts,
          duration: s.duration,
          timescale: s.timescale,
          is_sync: s.is_sync,
        });
      }
    };

    (buffer as ArrayBuffer & { fileStart?: number }).fileStart = 0;
    mp4file.appendBuffer(buffer);
    mp4file.flush();

    if (!videoTrack) {
      return reject(new Error('Failed to demux MP4: No valid video track found.'));
    }

    if (videoSamples.length === 0) {
      return reject(new Error('Failed to demux MP4: No video samples extracted.'));
    }

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

interface MaskStats {
  xs: Int16Array;
  ys: Int16Array;
  alphas: Float32Array;
  count: number;
}

const maskStatsCache = new WeakMap<AlphaMapData, MaskStats>();

function getMaskStats(alphaMap: AlphaMapData): MaskStats {
  const cached = maskStatsCache.get(alphaMap);
  if (cached) return cached;

  const xs: number[] = [];
  const ys: number[] = [];
  const alphas: number[] = [];
  const { values, width, height } = alphaMap;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = values[y * width + x];
      if (alpha > 0.04) {
        xs.push(x);
        ys.push(y);
        alphas.push(alpha);
      }
    }
  }

  const stats: MaskStats = {
    xs: Int16Array.from(xs),
    ys: Int16Array.from(ys),
    alphas: Float32Array.from(alphas),
    count: xs.length,
  };
  maskStatsCache.set(alphaMap, stats);
  return stats;
}

/**
 * Computes correlation between frame luminance and alpha map.
 * Template pixels are pre-indexed so repeated candidate scans do not revisit
 * the mostly-zero background of every watermark template.
 */
export function scoreCandidate(
  imageData: ImageData,
  cand: { x: number; y: number; alphaMap: AlphaMapData },
  sampleStep = 1
): number {
  const { data, width, height } = imageData;
  const stats = getMaskStats(cand.alphaMap);
  if (stats.count === 0) return -1;
  if (cand.x < 0 || cand.y < 0) return -1;
  if (cand.x + cand.alphaMap.width > width || cand.y + cand.alphaMap.height > height) return -1;

  const step = Math.max(1, Math.floor(sampleStep));
  let sumL = 0;
  let sumLL = 0;
  let sumA = 0;
  let sumAA = 0;
  let sumLA = 0;
  let count = 0;

  for (let k = 0; k < stats.count; k += step) {
    const alpha = stats.alphas[k];
    const pIdx = ((cand.y + stats.ys[k]) * width + (cand.x + stats.xs[k])) * 4;
    const lum = (data[pIdx] + data[pIdx + 1] + data[pIdx + 2]) / 765.0;

    sumL += lum;
    sumLL += lum * lum;
    sumA += alpha;
    sumAA += alpha * alpha;
    sumLA += lum * alpha;
    count++;
  }

  if (count < 8) return -1;
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
  frameHeight: number,
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
  const inFrame = (lx: number, ly: number) => {
    const gx = targetX + lx;
    const gy = targetY + ly;
    return gx >= 0 && gx < frameWidth && gy >= 0 && gy < frameHeight;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < u; x++) {
      if (watermarkTouched[y * u + x]) {
        for (let dy = -edgeRadius; dy <= edgeRadius; dy++) {
          for (let dx = -edgeRadius; dx <= edgeRadius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < u && ny >= 0 && ny < h && inFrame(nx, ny)) {
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
        if (!boundary[y * u + x] || !inFrame(x, y)) continue;

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
            if (!inFrame(nx, ny)) continue;

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
  version: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
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

        // A candidate at the edge of a frame can extend past the image. Ignore
        // those local pixels instead of reading neighbouring rows.
        const gx = target.x + x;
        const gy = target.y + y;
        if (gx < 0 || gx >= imageData.width || gy < 0 || gy >= imageData.height) continue;

        const hIdx = (gy * width + gx) * 4;
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
  if (masks.length === 0) {
    throw new Error('No watermark templates are available for video detection');
  }

  const minDim = Math.min(width, height);
  const resScale = minDim / 1080;
  const deadline = performance.now() + 8000;
  const allConfigs = getCornerConfigs(width, height);

  const makeCandidate = (
    maskItem: MaskCandidateSpec,
    corner: WatermarkCorner,
    x: number,
    y: number,
    score: number,
    method: string
  ): TargetCandidate => ({
    x,
    y,
    alphaMap: maskItem.alphaMap,
    score,
    opacity: 1.0,
    baseStrength: 1.0,
    method,
    version: maskItem.version,
    corner,
    hasWatermark: score >= s.corrThreshold,
  });

  // Explicit user alignment always wins over the search heuristic.
  if (s.forcePosition && Number.isFinite(s.forcePosition.x) && Number.isFinite(s.forcePosition.y)) {
    const targetSize =
      s.forcePosition.size || (minDim > 720 ? Math.round(84 * resScale) : 48);
    const chosen = masks.reduce(
      (best, current) =>
        Math.abs(current.alphaMap.width - targetSize) <
        Math.abs(best.alphaMap.width - targetSize)
          ? current
          : best,
      masks[0]
    );
    const x = Math.max(
      0,
      Math.min(width - chosen.alphaMap.width, Math.round(s.forcePosition.x))
    );
    const y = Math.max(
      0,
      Math.min(height - chosen.alphaMap.height, Math.round(s.forcePosition.y))
    );
    const score = scoreCandidate(imgData, { x, y, alphaMap: chosen.alphaMap });
    const forced = makeCandidate(chosen, 'bottom-right', x, y, score, 'forced');
    forced.hasWatermark = true;
    return configureCandidateEdge(forced, s, imgData);
  }

  const baseMargins = [222, 186, 144, 138, 132, 128, 120, 96, 72, 64, 48, 36, 32, 28, 24, 20, 16];
  const marginSet = new Set<number>();
  for (const m of baseMargins) {
    marginSet.add(m);
    const scaled = Math.round(m * resScale);
    if (scaled >= 12 && scaled < minDim * 0.4) marginSet.add(scaled);
  }
  const margins = Array.from(marginSet);
  const marginPairs: [number, number][] = [];
  for (const m of margins) {
    marginPairs.push([m, m]);
  }

  const commonRatios = [
    [1.2, 1.0], [1.0, 1.2],
    [1.33, 1.0], [1.0, 1.33],
    [1.5, 1.0], [1.0, 1.5],
  ];
  const ratioPairs: [number, number][] = [];
  for (const m of margins) {
    for (const [rx, ry] of commonRatios) {
      const mx = Math.round(m * rx);
      const my = Math.round(m * ry);
      if (mx < minDim * 0.4 && my < minDim * 0.4) {
        ratioPairs.push([mx, my]);
      }
    }
  }

  // Try the most plausible physical sizes first. This shortens the common case
  // without excluding any template from the search.
  const expectedSize = minDim <= 720 ? 48 : Math.round(84 * resScale);
  const orderedMasks = [...masks].sort(
    (a, b) => Math.abs(a.alphaMap.width - expectedSize) - Math.abs(b.alphaMap.width - expectedSize)
  );

  const evaluateCorner = (
    cornerKey: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  ): TargetCandidate | null => {
    const cfg = allConfigs[cornerKey];
    let cornerBest: TargetCandidate | null = null;
    let iterations = 0;
    const tested = new Set<string>();

    const consider = (
      maskItem: MaskCandidateSpec,
      x: number,
      y: number,
      score: number,
      method: string
    ) => {
      if (score < -0.99) return;
      const key = `${maskItem.version}:${maskItem.alphaMap.width}:${x}:${y}`;
      if (tested.has(key)) return;
      tested.add(key);
      if (!cornerBest || score > cornerBest.score) {
        cornerBest = makeCandidate(maskItem, cornerKey, x, y, score, method);
      }
    };

    const runMarginPairs = (pairs: [number, number][], label: string): boolean => {
      for (const maskItem of orderedMasks) {
        const aW = maskItem.alphaMap.width;
        const aH = maskItem.alphaMap.height;
        for (const [mx, my] of pairs) {
          iterations++;
          if ((iterations & 63) === 0 && performance.now() > deadline) return true;
          const { x, y } = cfg.getCandXY(mx, my, aW, aH);
          const score = scoreCandidate(imgData, { x, y, alphaMap: maskItem.alphaMap });
          consider(maskItem, x, y, score, `${cornerKey} ${label} (${mx}, ${my})`);
          if (score >= 0.72) return true;
        }
      }
      return false;
    };

    runMarginPairs(marginPairs, 'margin');
    if (!cornerBest || (cornerBest as TargetCandidate).score < Math.max(0.4, s.corrThreshold)) {
      runMarginPairs(ratioPairs, 'ratio margin');
    }

    // Sub-pixel/local refinement is only worth running for the single best
    // margin match, not for every candidate (which used to cost 289 extra
    // correlations per hit).
    if (cornerBest) {
      let refined = cornerBest as TargetCandidate;
      const aW = refined.alphaMap.width;
      const aH = refined.alphaMap.height;
      for (let dy = -8; dy <= 8; dy++) {
        for (let dx = -8; dx <= 8; dx++) {
          if (dx === 0 && dy === 0) continue;
          const tx = Math.max(0, Math.min(width - aW, refined.x + dx));
          const ty = Math.max(0, Math.min(height - aH, refined.y + dy));
          const score = scoreCandidate(imgData, { x: tx, y: ty, alphaMap: refined.alphaMap });
          if (score > refined.score) {
            refined.x = tx;
            refined.y = ty;
            refined.score = score;
            refined.hasWatermark = score >= s.corrThreshold;
          }
        }
      }
      cornerBest = refined;
    }

    if (cornerBest && cornerBest.score >= Math.max(0.4, s.corrThreshold)) {
      return cornerBest;
    }

    // Tier 2: coarse spatial scan of the corner. Only a small, plausible subset
    // of masks is scanned, using sampled correlations for the coarse pass.
    const scanMasks = orderedMasks
      .filter((m) => m.alphaMap.width >= 20 && m.alphaMap.width <= minDim * 0.25)
      .slice(0, 10);
    const stride = Math.max(6, Math.round(minDim / 160));

    for (const maskItem of scanMasks) {
      if (performance.now() > deadline) break;
      const { startX, maxX, startY, maxY } = cfg.getSpatialBounds(
        maskItem.alphaMap.width,
        maskItem.alphaMap.height
      );
      if (maxX < startX || maxY < startY) continue;

      let localBestX = -1;
      let localBestY = -1;
      let localBestScore = -1;

      outer: for (let y = startY; y <= maxY; y += stride) {
        for (let x = startX; x <= maxX; x += stride) {
          if ((iterations++ & 127) === 0 && performance.now() > deadline) break outer;
          const score = scoreCandidate(imgData, { x, y, alphaMap: maskItem.alphaMap }, 4);
          if (score > localBestScore) {
            localBestScore = score;
            localBestX = x;
            localBestY = y;
          }
          if (localBestScore >= 0.78) break outer;
        }
      }

      if (localBestX >= 0 && localBestScore > 0.12) {
        const rMinX = Math.max(startX, localBestX - stride);
        const rMaxX = Math.min(maxX, localBestX + stride);
        const rMinY = Math.max(startY, localBestY - stride);
        const rMaxY = Math.min(maxY, localBestY + stride);

        for (let y = rMinY; y <= rMaxY; y++) {
          for (let x = rMinX; x <= rMaxX; x++) {
            const score = scoreCandidate(imgData, { x, y, alphaMap: maskItem.alphaMap });
            if (score > localBestScore) {
              localBestScore = score;
              localBestX = x;
              localBestY = y;
            }
          }
        }

        if (!cornerBest || localBestScore > cornerBest.score) {
          cornerBest = makeCandidate(
            maskItem,
            cornerKey,
            localBestX,
            localBestY,
            localBestScore,
            `${cornerKey} spatial scan refined`
          );
        }
      }

      if (cornerBest && cornerBest.score >= 0.72) break;
    }

    return cornerBest;
  };

  const primaryCorner: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' =
    s.corner === 'auto' ? 'bottom-right' : s.corner;

  let bestCand = evaluateCorner(primaryCorner);

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

  const fallbackMask = orderedMasks[0];
  const resultCand: TargetCandidate = bestCand || {
    x: Math.max(0, width - fallbackMask.alphaMap.width - 64),
    y: Math.max(0, height - fallbackMask.alphaMap.height - 64),
    alphaMap: fallbackMask.alphaMap,
    score: 0,
    opacity: 1.0,
    baseStrength: 1.0,
    method: 'fallback',
    version: fallbackMask.version,
    corner: 'bottom-right' as WatermarkCorner,
    hasWatermark: false,
  };

  resultCand.hasWatermark = resultCand.score >= s.corrThreshold;
  return configureCandidateEdge(resultCand, s, imgData);
}

const softCleaningMaskCache = new WeakMap<AlphaMapData, Float32Array>();

/**
 * Video codecs low-pass the watermark edge. The 84px color mask carries a
 * deliberately brighter antialiased rim, and inverting that rim at full
 * strength leaves a dark star outline on compressed footage. A small separable
 * binomial blur models the codec's edge softening without changing the mask
 * used for detection. Only color masks need this; alpha-only templates are
 * already smooth and are tuned for the image engine.
 */
function getSoftColorMaskValues(alphaMap: AlphaMapData): Float32Array {
  const cached = softCleaningMaskCache.get(alphaMap);
  if (cached) return cached;

  const { values, width, height } = alphaMap;
  const kernel = [0.25, 0.5, 0.25];
  const horizontal = new Float32Array(values.length);
  const result = new Float32Array(values.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -1; k <= 1; k++) {
        const nx = x + k;
        if (nx >= 0 && nx < width) sum += values[row + nx] * kernel[k + 1];
      }
      horizontal[row + x] = sum;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -1; k <= 1; k++) {
        const ny = y + k;
        if (ny >= 0 && ny < height) sum += horizontal[ny * width + x] * kernel[k + 1];
      }
      result[y * width + x] = sum;
    }
  }

  softCleaningMaskCache.set(alphaMap, result);
  return result;
}

/** How far a mask pixel may look for non-watermark neighbours, in mask pixels.
 * The star's bottom tip is ~8px of near-solid mask before outside pixels
 * appear, so the radius must span it or tip pixels fall back to the template
 * alpha and over-subtract. Deep-interior pixels remain out of reach by design. */
const BG_SCAN_RADIUS = 12;

/**
 * Per-frame local background estimate for color-mask pixels. For every mask
 * pixel that still reaches non-watermark pixels within the scan radius, the
 * nearest outside pixels along the eight compass directions are averaged with
 * distance weighting, so the estimate stays local even where the watermark rim
 * crosses a brightness boundary. Pixels deeper inside the star cannot reach
 * outside and stay unmarked; they keep the template's closed-form inversion,
 * which already restores their texture correctly.
 */
function buildLocalBackgroundEstimate(
  imageData: ImageData,
  target: { x: number; y: number },
  values: Float32Array,
  u: number,
  h: number
): { colors: Float32Array; hasEstimate: Uint8Array } | null {
  const { width, height, data } = imageData;
  const colors = new Float32Array(u * h * 3);
  const hasEstimate = new Uint8Array(u * h);
  const directions: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  let estimated = 0;

  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < u; lx++) {
      if (values[ly * u + lx] <= 0.05) continue;
      let weightSum = 0;
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;

      for (const [dx, dy] of directions) {
        for (let k = 1; k <= BG_SCAN_RADIUS; k++) {
          const nx = lx + dx * k;
          const ny = ly + dy * k;
          if (nx < 0 || nx >= u || ny < 0 || ny >= h) break;
          if (values[ny * u + nx] > 0.02) continue;
          const gx = target.x + nx;
          const gy = target.y + ny;
          if (gx < 0 || gx >= width || gy < 0 || gy >= height) break;
          const weight = 1 / k;
          const pIdx = (gy * width + gx) * 4;
          rSum += weight * data[pIdx];
          gSum += weight * data[pIdx + 1];
          bSum += weight * data[pIdx + 2];
          weightSum += weight;
          break;
        }
      }

      if (weightSum <= 0) continue;
      const o = (ly * u + lx) * 3;
      colors[o] = rSum / weightSum;
      colors[o + 1] = gSum / weightSum;
      colors[o + 2] = bSum / weightSum;
      hasEstimate[ly * u + lx] = 1;
      estimated++;
    }
  }

  return estimated > 0 ? { colors, hasEstimate } : null;
}

/**
 * Observed watermark opacity at one pixel, derived from the local background:
 * a white overlay composites as P = bg + a * (255 - bg), so
 * a = (P - bg) / (255 - bg). The median of the three channel estimates is
 * robust against codec noise. A non-positive result means the pixel is not
 * brighter than its background and the template must not subtract anything;
 * that is what previously carved a dark outline along the rim.
 */
function observedAlphaForColorMask(
  data: Uint8ClampedArray,
  pIdx: number,
  bgR: number,
  bgG: number,
  bgB: number
): number | null {
  const estimates: number[] = [];
  const channels: Array<[number, number]> = [
    [data[pIdx], bgR],
    [data[pIdx + 1], bgG],
    [data[pIdx + 2], bgB],
  ];
  for (const [p, bg] of channels) {
    const denom = 255 - bg;
    if (denom <= 8) return null; // near-white background: estimate unstable
    estimates.push((p - bg) / denom);
  }
  estimates.sort((a, b) => a - b);
  const median = estimates[1];
  if (!Number.isFinite(median)) return null;
  if (median <= 0) return 0;
  return Math.min(1, median);
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
  // Mutate directly in-place on the frame buffer to eliminate multi-gigabyte memory churn
  const out = imageData.data;
  const alphaMap = target.alphaMap;
  const u = alphaMap.width;
  const h = alphaMap.height;

  // Candidates can extend past the frame when a template is larger than a tiny
  // source video or a forced alignment sits near an edge. Only touch pixels
  // that actually exist; indexing beyond the row previously corrupted data.
  const startX = Math.max(0, target.x);
  const startY = Math.max(0, target.y);
  const endX = Math.min(width, target.x + u);
  const endY = Math.min(height, target.y + h);
  if (startX >= endX || startY >= endY) return imageData;

  const opacity = target.opacity ?? 1.0;
  const baseStrength = target.baseStrength ?? settings.baseStrength;
  const ceiling = target.ceiling ?? settings.ceiling;
  const hasColor = alphaMap.colorValues !== undefined;
  const colorValues = alphaMap.colorValues;
  const maskValues = hasColor ? getSoftColorMaskValues(alphaMap) : alphaMap.values;
  const overlayValue = settings.overlayValue ?? 250;
  // Color masks: estimate each pixel's local background once, before any
  // mutation. Rim pixels then clean with the opacity the frame actually shows
  // instead of the template's, which removes the dark star outline.
  const backgroundEstimate =
    hasColor && colorValues
      ? buildLocalBackgroundEstimate(imageData, target, alphaMap.values, u, h)
      : null;
  const needEdge = !!target.edgeCleanup;
  const touched = needEdge ? new Uint8Array(u * h) : null;

  // Inpainting mask for saturated white core and blown-out highlights
  const useInpainting = settings.fillMode === 'on' || settings.fillMode === 'auto';
  const inpaintMask = useInpainting ? new Uint8Array(u * h) : null;
  const inpaintThreshold = settings.fillThreshold || 0.85;

  for (let gy = startY; gy < endY; gy++) {
    const y = gy - target.y;
    for (let gx = startX; gx < endX; gx++) {
      const x = gx - target.x;
      const n = y * u + x;
      const pIdx = (gy * width + gx) * 4;

      let effAlpha = Math.min(maskValues[n] * baseStrength * opacity, ceiling, 0.94);
      if (backgroundEstimate && backgroundEstimate.hasEstimate[n]) {
        const o = n * 3;
        const observed = observedAlphaForColorMask(
          data,
          pIdx,
          backgroundEstimate.colors[o],
          backgroundEstimate.colors[o + 1],
          backgroundEstimate.colors[o + 2]
        );
        if (observed !== null) {
          effAlpha = Math.min(effAlpha, observed);
        }
      }
      if (effAlpha < 0.002) continue;

      const invAlpha = 1.0 - effAlpha;
      if (invAlpha <= 1e-4) continue;

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

  return imageData;
}

export interface VideoProcessResult {
  blob: Blob;
  /** Optional seekable proxy of the source (same encoded samples, corrected stss). */
  playbackBlob?: Blob;
  hasWatermark: boolean;
  detectedVersion: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
  detectedCorner?: WatermarkCorner;
  confidence: number;
  position: { x: number; y: number };
  size: number;
  fps: number;
  wasProcessed: boolean;
  audioPreserved: boolean;
  warning?: string;
}

/**
 * Full in-browser WebCodecs Video Watermark Remover
 */
export async function processVideo(
  videoBuffer: ArrayBuffer,
  customSettings?: Partial<VideoSettings>,
  onProgress?: (progress: VideoProgress) => void,
  signal?: AbortSignal
): Promise<VideoProcessResult> {
  const s: VideoSettings = { ...DEFAULT_VIDEO_SETTINGS, ...customSettings };

  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') {
    throw new Error('WebCodecs API is not supported in this browser.');
  }
  if (!(videoBuffer instanceof ArrayBuffer) || videoBuffer.byteLength === 0) {
    throw new Error('The selected video is empty or could not be read.');
  }
  if (videoBuffer.byteLength > MAX_VIDEO_BYTES) {
    throw new Error(
      `Video exceeds the ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB safety limit.`
    );
  }

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new DOMException('Video processing was cancelled.', 'AbortError');
    }
  };

  let lastProgressAt = 0;
  let lastProgressStage = '';
  const reportProgress = (progress: VideoProgress) => {
    const now = performance.now();
    if (
      progress.stage === lastProgressStage &&
      progress.ratio < 1 &&
      now - lastProgressAt < 100
    ) {
      return;
    }
    lastProgressAt = now;
    lastProgressStage = progress.stage;
    onProgress?.(progress);
  };

  throwIfAborted();
  reportProgress({ stage: 'demux', ratio: 0 });
  const { videoTrack, audioTrack, videoSamples, audioSamples, videoDescription } =
    await demuxMp4(videoBuffer);
  throwIfAborted();
  reportProgress({ stage: 'demux', ratio: 1 });

  // Build this before decoding starts: the decode loop releases each sample's
  // payload to keep memory bounded.
  const playbackBuffer = buildSeekablePlaybackBuffer(videoBuffer, videoSamples, videoTrack);
  const playbackBlob = playbackBuffer
    ? new Blob([playbackBuffer], { type: 'video/mp4' })
    : undefined;

  const codedWidth = Number(videoTrack.video?.width || videoTrack.track_width) || 0;
  const codedHeight = Number(videoTrack.video?.height || videoTrack.track_height) || 0;
  if (!codedWidth || !codedHeight) {
    throw new Error('The video track does not expose valid dimensions.');
  }
  if (codedWidth > MAX_VIDEO_DIMENSION || codedHeight > MAX_VIDEO_DIMENSION) {
    throw new Error(
      `Video dimensions ${codedWidth}×${codedHeight} exceed the ${MAX_VIDEO_DIMENSION}px safety limit.`
    );
  }

  const rotation = getRotationDegrees(videoTrack);
  const width = rotation === 90 || rotation === 270 ? codedHeight : codedWidth;
  const height = rotation === 90 || rotation === 270 ? codedWidth : codedHeight;

  const frameCount = videoSamples.length;
  if (frameCount === 0) {
    throw new Error('No decodable video frames were found in this MP4.');
  }

  const timescale = videoSamples[0]?.timescale || videoTrack.timescale || 30000;
  const avgDuration =
    videoSamples.reduce((acc, cur) => acc + (cur.duration || 0), 0) / frameCount || 1;
  const fps = Math.max(1, Math.min(120, Math.round(timescale / avgDuration)));
  const durationSeconds =
    ((videoTrack.duration || 0) / (videoTrack.timescale || timescale)) || (frameCount / fps);
  if (durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(
      `Video is ${Math.round(durationSeconds / 60)} minutes long. The limit is ${MAX_VIDEO_DURATION_SECONDS / 60} minutes.`
    );
  }

  const decoderConfig: VideoDecoderConfig = {
    codec: videoTrack.codec,
    codedWidth,
    codedHeight,
    description: videoDescription || undefined,
  };
  try {
    const support = await VideoDecoder.isConfigSupported(decoderConfig);
    if (!support.supported) {
      throw new Error(`Video codec ${videoTrack.codec} is not supported by this browser.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('not supported')) throw error;
    throw new Error(`Unable to prepare the ${videoTrack.codec} decoder for this video.`, {
      cause: error,
    });
  }

  // Preload resolution-aware mask candidate templates across versions
  const maskTemplates = await loadAllMaskCandidates(s.logoVersion, s.maskScale, width, height);
  throwIfAborted();

  const audioCodec = String(audioTrack?.codec || '');
  const audioInfo = audioTrack?.audio as
    | { sample_rate?: number; channel_count?: number }
    | undefined;
  const isAacAudio =
    Boolean(audioTrack) &&
    Boolean(audioInfo?.sample_rate) &&
    Boolean(audioInfo?.channel_count) &&
    audioSamples.length > 0 &&
    (audioCodec.startsWith('mp4a.40') || audioCodec.toLowerCase().includes('aac'));
  let warning: string | undefined = audioTrack && !isAacAudio
    ? 'The source audio track could not be copied; the cleaned MP4 is silent.'
    : undefined;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
    video: {
      codec: 'avc',
      width,
      height,
    },
    audio: isAacAudio
      ? {
          codec: 'aac',
          sampleRate: audioTrack.audio.sample_rate,
          numberOfChannels: audioTrack.audio.channel_count,
        }
      : undefined,
  });

  const bitrate = Math.max(500_000, Math.round(width * height * fps * 0.12 * s.bitrateMult));

  // WebCodecs emits chunks in decode order but only exposes presentation
  // timestamps. Hardware H.264 encoders may emit B-frames, whose decode order
  // walks presentation time backwards; mp4-muxer treats an unmodified chunk
  // timestamp as the decode timestamp and rejects the regression ("Timestamps
  // must be monotonically increasing"). Assign the decode timestamp from the
  // output order instead and pass the PTS−DTS delta as the composition offset
  // so the muxer writes a correct ctts table. For B-frame-free encoders every
  // offset is 0 and the muxing is identical to the previous behaviour.
  const frameDurationUs = 1e6 / fps;
  let decodeIndex = 0;
  let encoderError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const decodeTimestamp = Math.round(decodeIndex * frameDurationUs);
      decodeIndex++;
      muxer.addVideoChunk(chunk, meta, chunk.timestamp, chunk.timestamp - decodeTimestamp);
    },
    error: (e) => {
      encoderError = e;
      console.error('VideoEncoder error:', e);
    },
  });

  let targetProfile = 'avc1.640028';
  if (width > 1920 || height > 1080) {
    targetProfile = 'avc1.640033';
  } else if (fps > 30) {
    targetProfile = 'avc1.64002a';
  }

  const candidateCodecs = [targetProfile, 'avc1.640028', 'avc1.4d4028', 'avc1.42001f'];
  let chosenCodec: string | null = null;
  for (const candCodec of candidateCodecs) {
    try {
      const checkConfig: VideoEncoderConfig = {
        codec: candCodec,
        width,
        height,
        bitrate,
        framerate: fps,
      };
      const res = await VideoEncoder.isConfigSupported(checkConfig);
      if (res.supported) {
        chosenCodec = candCodec;
        break;
      }
    } catch {
      // Try the next profile.
    }
  }

  if (!chosenCodec) {
    throw new Error('No H.264 encoder profile is available for this video in this browser.');
  }

  const encoderConfig: VideoEncoderConfig = {
    codec: chosenCodec,
    width,
    height,
    bitrate,
    bitrateMode: 'variable',
    framerate: fps,
    avc: { format: 'avc' },
  };
  encoder.configure(encoderConfig);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  let encodedFrames = 0;
  let decodedFrames = 0;
  const keyframeInterval = Math.max(1, 2 * fps);
  let decoderError: unknown = null;

  interface BufferedDecodedFrame {
    imgData: ImageData;
    timestamp: number;
    duration?: number | null;
    frameIndex: number;
    brLum: number;
  }

  const initialBuffer: BufferedDecodedFrame[] = [];
  let detectionDone = false;
  let targetCandidate: TargetCandidate | null = null;
  let hasWatermark = false;
  let detectionScore = 0;
  let skipReencode = false;

  const encodeImageData = (
    imgData: ImageData,
    timestamp: number,
    duration: number | null | undefined,
    frameIndex: number
  ) => {
    const videoFrameInit: VideoFrameBufferInit = {
      format: 'RGBA',
      codedWidth: width,
      codedHeight: height,
      timestamp,
    };
    if (duration !== null && duration !== undefined) {
      videoFrameInit.duration = duration;
    }

    const cleanFrameObj = new VideoFrame(imgData.data.buffer, videoFrameInit);
    encoder.encode(cleanFrameObj, {
      keyFrame: frameIndex % keyframeInterval === 0,
    });
    cleanFrameObj.close();
    encodedFrames++;
  };

  const flushBufferedFrames = () => {
    for (const b of initialBuffer) {
      const frameData =
        hasWatermark && targetCandidate
          ? cleanFrame(b.imgData, targetCandidate, s)
          : b.imgData;
      encodeImageData(frameData, b.timestamp, b.duration, encodedFrames);
      reportProgress({ stage: 'process', ratio: encodedFrames / frameCount });
    }
    initialBuffer.length = 0;
  };

  const executeDetection = () => {
    if (detectionDone || initialBuffer.length === 0) return;

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
      if (!f || f.brLum < 4) continue;
      const cand = detectBestWatermarkCandidate(f.imgData, width, height, s, maskTemplates);
      if (!bestCand || cand.score > bestCand.score) {
        bestCand = cand;
        bestFrame = f;
      }
      if (bestCand && bestCand.score >= 0.97) break;
    }

    detectionScore = bestCand ? bestCand.score : 0;

    if (!bestCand || bestCand.score < s.corrThreshold) {
      hasWatermark = false;
      targetCandidate = null;
      detectionDone = true;
      skipReencode = true;
      initialBuffer.length = 0;
      reportProgress({ stage: 'process', ratio: 0 });
      return;
    }

    const cand = bestCand;

    if (cand.score >= 0.70) {
      hasWatermark = true;
      targetCandidate = cand;
    } else if (cand.score >= s.corrThreshold) {
      // Moderate confidence: verify against a distant frame because real
      // watermarks are stationary while scene detail is not.
      const verifyFrames = initialBuffer.filter(
        (f) =>
          f !== bestFrame &&
          Math.abs(f.frameIndex - bestFrame.frameIndex) >= 3 &&
          f.brLum > 8
      );
      if (verifyFrames.length > 0) {
        const vf = verifyFrames[verifyFrames.length - 1];
        const vScore = scoreCandidate(vf.imgData, {
          x: cand.x,
          y: cand.y,
          alphaMap: cand.alphaMap,
        });
        if (vScore >= s.corrThreshold * 0.75) {
          hasWatermark = true;
          targetCandidate = cand;
        }
      } else if (cand.score >= 0.45) {
        hasWatermark = true;
        targetCandidate = cand;
      }
    }

    detectionDone = true;

    if (hasWatermark && targetCandidate) {
      reportProgress({
        stage: 'process',
        ratio: 0,
        detectedVersion: targetCandidate.version,
        detectedCorner: targetCandidate.corner,
      });
      flushBufferedFrames();
    } else {
      skipReencode = true;
      initialBuffer.length = 0;
      reportProgress({ stage: 'process', ratio: 0 });
    }
  };

  const drawFrameToCanvas = (frame: VideoFrame) => {
    ctx.save();
    if (rotation !== 0) {
      ctx.translate(width / 2, height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.drawImage(
        frame,
        -codedWidth / 2,
        -codedHeight / 2,
        codedWidth,
        codedHeight
      );
    } else {
      ctx.drawImage(frame, 0, 0, codedWidth, codedHeight);
    }
    ctx.restore();
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        if (signal?.aborted) {
          decoderError = new DOMException('Video processing was cancelled.', 'AbortError');
          frame.close();
          return;
        }

        const timestamp = frame.timestamp;
        const duration = frame.duration;
        drawFrameToCanvas(frame);
        frame.close();

        const imgData = ctx.getImageData(0, 0, width, height);

        if (!detectionDone) {
          const sx = Math.floor(width * 0.7);
          const sy = Math.floor(height * 0.7);
          let sum = 0;
          let count = 0;
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
            frameIndex: decodedFrames++,
            brLum,
          });

          if (initialBuffer.length >= BUFFER_LIMIT || (initialBuffer.length >= 12 && brLum > 30)) {
            executeDetection();
          }
        } else if (!skipReencode) {
          const frameData =
            hasWatermark && targetCandidate
              ? cleanFrame(imgData, targetCandidate, s)
              : imgData;
          encodeImageData(frameData, timestamp, duration, encodedFrames);
          decodedFrames++;
          reportProgress({ stage: 'process', ratio: encodedFrames / frameCount });
        } else {
          decodedFrames++;
        }
      } catch (e) {
        decoderError = e;
        try {
          frame.close();
        } catch {
          // Frame was already closed above.
        }
      }
    },
    error: (e) => {
      decoderError = e;
      console.error('VideoDecoder error:', e);
    },
  });

  decoder.configure(decoderConfig);
  reportProgress({ stage: 'process', ratio: 0 });

  try {
    for (let i = 0; i < videoSamples.length; i++) {
      throwIfAborted();
      if (decoderError) throw decoderError;
      if (skipReencode) break;

      const sample = videoSamples[i];
      const chunk = new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: Math.round((1e6 * sample.cts) / sample.timescale),
        duration: Math.round((1e6 * sample.duration) / sample.timescale),
        data: sample.data,
      });
      decoder.decode(chunk);
      // EncodedVideoChunk copies the sample payload; release the demux copy.
      sample.data = null;

      while (decoder.decodeQueueSize > 4 || encoder.encodeQueueSize > 4) {
        throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
    }

    await decoder.flush();
    if (!detectionDone) {
      executeDetection();
    }
    if (!skipReencode) {
      await encoder.flush();
    }
  } finally {
    try {
      if (decoder.state !== 'closed') decoder.close();
    } catch {
      // Already closed.
    }
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      // Already closed.
    }
  }

  if (decoderError) throw decoderError;
  if (encoderError) throw encoderError;

  // Preserve the original file byte-for-byte when no watermark was confirmed.
  if (skipReencode || !hasWatermark) {
    reportProgress({ stage: 'done', ratio: 1 });
    return {
      blob: new Blob([videoBuffer], { type: 'video/mp4' }),
      playbackBlob,
      hasWatermark: false,
      detectedVersion: s.logoVersion === 'auto' ? 'classic' : s.logoVersion,
      confidence: detectionScore,
      position: { x: 0, y: 0 },
      size: 0,
      fps,
      wasProcessed: false,
      audioPreserved: Boolean(audioTrack),
      warning: warning || 'No watermark detected — the original video was returned unchanged.',
    };
  }

  // Copy AAC audio samples untouched when possible.
  let audioPreserved = false;
  if (isAacAudio && audioSamples.length > 0) {
    try {
      const sampleRate = audioInfo?.sample_rate ?? audioTrack.audio.sample_rate;
      const channels = audioInfo?.channel_count ?? audioTrack.audio.channel_count;
      // Validate every sample before adding any: a failure halfway through
      // would leave the muxer with a truncated audio track.
      for (const sample of audioSamples) {
        if (!sample?.data || !Number.isFinite(sample.cts) || !sample.timescale) {
          throw new Error('Malformed AAC sample');
        }
      }

      let rateIdx = AAC_SAMPLE_RATES.indexOf(sampleRate);
      if (rateIdx < 0) rateIdx = 4;

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
        const duration = sample.duration
          ? Math.round((1e6 * sample.duration) / sample.timescale)
          : undefined;
        muxer.addAudioChunk(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round((1e6 * sample.cts) / sample.timescale),
            ...(duration ? { duration } : {}),
            data: sample.data,
          }),
          audioConfig
        );
      }
      audioPreserved = true;
    } catch (e) {
      console.warn('Audio copy failed, continuing silent:', e);
      warning = [warning, 'Audio could not be preserved; the cleaned MP4 is silent.']
        .filter(Boolean)
        .join(' ');
    }
  }

  reportProgress({ stage: 'mux', ratio: 0.99 });
  muxer.finalize();
  reportProgress({ stage: 'done', ratio: 1.0 });

  const finalBlob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  // Detection state is written from decoder callbacks, which control-flow
  // analysis cannot track; re-assert the union before the final guard.
  const resolvedTarget = targetCandidate as TargetCandidate | null;
  if (!resolvedTarget) {
    throw new Error('Internal error: watermark detected without a retained template.');
  }

  return {
    blob: finalBlob,
    playbackBlob,
    hasWatermark: true,
    detectedVersion: resolvedTarget.version,
    detectedCorner: resolvedTarget.corner,
    confidence: resolvedTarget.score,
    position: { x: resolvedTarget.x, y: resolvedTarget.y },
    size: resolvedTarget.alphaMap.width,
    fps,
    wasProcessed: true,
    audioPreserved,
    warning,
  };
}
