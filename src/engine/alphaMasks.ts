import type { LogoVersion } from './types.ts';
import { resolveAssetUrl } from '../utils/assetUrl.ts';
import {
  inferMaskSize,
  isValidMask,
  rescaleAlphaMap,
  resolveScaledMaskSize,
} from './maskGeometry.ts';

export interface MaskData {
  alphaMap: Float32Array;
  size: number;
}

export class AlphaMaskManager {
  private alphaMap48: Float32Array | null = null;
  private alphaMap84Star: Float32Array | null = null;
  private alphaMap96: Float32Array | null = null;
  private alphaMap48New: Float32Array | null = null;
  private alphaMap96New: Float32Array | null = null;
  private alphaMap48White: Float32Array | null = null;
  private alphaMap96White: Float32Array | null = null;

  private scaledCache = new Map<string, MaskData>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const [old48, old96, new48, new96, hw48, hw96, star84] = await Promise.all([
        this.loadImage(resolveAssetUrl('/masks/bg_48.png')).catch(() => null),
        this.loadImage(resolveAssetUrl('/masks/bg_96.png')).catch(() => null),
        this.loadImage(resolveAssetUrl('/masks/sparkle-2026-48.png')).catch(() => null),
        this.loadImage(resolveAssetUrl('/masks/sparkle-2026-96.png')).catch(() => null),
        this.loadImage(resolveAssetUrl('/masks/sparkle-hw-48.png')).catch(() => null),
        this.loadImage(resolveAssetUrl('/masks/sparkle-hw-96.png')).catch(() => null),
        this.loadImage(resolveAssetUrl('/masks/gemini-star_paired_star_mask.png')).catch(() => null),
      ]);

      if (old48) this.alphaMap48 = this.calculateAlphaMap(old48, 48, 48);
      if (old96) this.alphaMap96 = this.calculateAlphaMap(old96, 96, 96);
      if (star84) this.alphaMap84Star = this.calculateAlphaFromAlphaChannel(star84, 84, 84);
      this.alphaMap48New = new48 ? this.calculateAlphaMap(new48, 48, 48) : this.alphaMap48;
      this.alphaMap96New = new96 ? this.calculateAlphaMap(new96, 96, 96) : this.alphaMap96;
      this.alphaMap48White = hw48 ? this.calculateAlphaMap(hw48, 48, 48) : this.alphaMap48;
      this.alphaMap96White = hw96 ? this.calculateAlphaMap(hw96, 96, 96) : this.alphaMap96;

      // Fallback: If old is missing but new is present
      if (!this.alphaMap48 && this.alphaMap48New) this.alphaMap48 = this.alphaMap48New;
      if (!this.alphaMap96 && this.alphaMap96New) this.alphaMap96 = this.alphaMap96New;

      this.initialized = true;
    })();

    return this.initPromise;
  }

  public getBaseMap(size: number, version: LogoVersion): Float32Array {
    if (size === 84 || version === 'classic') {
      // The 84px asset is the classic paired star mask.
      return this.alphaMap84Star || new Float32Array(84 * 84);
    }
    const is96 = size === 96;
    if (is96) {
      if (version === 'new' && this.alphaMap96New) return this.alphaMap96New;
      if (version === 'white' && this.alphaMap96White) return this.alphaMap96White;
      return this.alphaMap96 || this.alphaMap96New || new Float32Array(96 * 96);
    } else {
      if (version === 'new' && this.alphaMap48New) return this.alphaMap48New;
      if (version === 'white' && this.alphaMap48White) return this.alphaMap48White;
      return this.alphaMap48 || this.alphaMap48New || new Float32Array(48 * 48);
    }
  }

  public getScaledMask(baseSize: number, scale: number, version: LogoVersion): MaskData {
    const baseMap = this.getBaseMap(baseSize, version);
    const actualBaseSize = inferMaskSize(baseMap) ?? baseSize;
    const targetSize = resolveScaledMaskSize(actualBaseSize, scale);

    if (targetSize === actualBaseSize) {
      return { alphaMap: baseMap, size: actualBaseSize };
    }

    const cacheKey = `${version}_${actualBaseSize}_${targetSize}`;
    const cached = this.scaledCache.get(cacheKey);
    if (cached) return cached;

    const scaled = rescaleAlphaMap(baseMap, actualBaseSize, targetSize);
    const result: MaskData = { alphaMap: scaled, size: targetSize };
    if (!isValidMask(result)) {
      throw new Error(`Mask rescale produced invalid ${targetSize}×${targetSize} data`);
    }
    this.scaledCache.set(cacheKey, result);
    return result;
  }

  private calculateAlphaFromAlphaChannel(imgData: ImageData, width: number, height: number): Float32Array {
    const raw = imgData.data;
    const alpha = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      alpha[i] = raw[4 * i + 3] / 255.0;
    }
    return alpha;
  }

  private calculateAlphaMap(imgData: ImageData, width: number, height: number): Float32Array {
    const raw = imgData.data;
    const alpha = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const r = raw[4 * i];
      const g = raw[4 * i + 1];
      const b = raw[4 * i + 2];
      const maxVal = Math.max(r, g, b);
      alpha[i] = maxVal / 255.0;
    }
    return alpha;
  }

  private loadImage(src: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return reject(new Error('Canvas context unavailable'));
        if (w !== h || w <= 0) {
          return reject(new Error(`Mask must be a non-empty square: ${src} is ${w}×${h}`));
        }
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, w, h));
      };
      img.onerror = () => reject(new Error(`Failed to load mask image: ${src}`));
      img.src = src;
    });
  }
}
