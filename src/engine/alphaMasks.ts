import type { LogoVersion } from './types';
import { resolveAssetUrl } from '../utils/assetUrl';

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
    if (size === 84) {
      return this.alphaMap84Star || this.alphaMap96 || new Float32Array(84 * 84);
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
    const targetSize = Math.max(4, Math.round(baseSize * (scale || 1.0)));

    if (targetSize === baseSize) {
      return { alphaMap: baseMap, size: baseSize };
    }

    const cacheKey = `${version}_${baseSize}_${targetSize}`;
    const cached = this.scaledCache.get(cacheKey);
    if (cached) return cached;

    const scaled = this.rescaleBilinear(baseMap, baseSize, targetSize);
    const result: MaskData = { alphaMap: scaled, size: targetSize };
    this.scaledCache.set(cacheKey, result);
    return result;
  }

  private rescaleBilinear(src: Float32Array, srcSize: number, dstSize: number): Float32Array {
    if (srcSize === dstSize) return src;
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
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return reject(new Error('Canvas context unavailable'));
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, img.width, img.height));
      };
      img.onerror = () => reject(new Error(`Failed to load mask image: ${src}`));
      img.src = src;
    });
  }
}
