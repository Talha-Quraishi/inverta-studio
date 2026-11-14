export type LogoVersion = 'auto' | 'sparkle' | 'classic' | 'new' | 'white' | 'old';
export type FillMode = 'auto' | 'on' | 'off';
export type WatermarkCorner = 'auto' | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

export interface WatermarkSettings {
  nccGood: number;       // default 0.5: confidence threshold for good detection
  nccAccept: number;     // default 0.3: minimum acceptable correlation
  scanStride: number;    // default 8: coarse step size during quadrant search
  refineRadius: number;  // default 8: fine search radius around best candidate
  gainDrift: number;     // default 0.62: alpha gain factor when drifted/scaled
  alphaThreshold: number;// default 0.002: alpha cutoff below which pixels are untouched
  maxAlpha: number;      // default 0.99: alpha ceiling to avoid division by zero
  logoValue: number;     // default 255: color of the watermark logo (pure white)
  maskScale: number;     // default 1.0: scale multiplier for the mask
  logoVersion: LogoVersion; // 'auto' (recommended), 'new' (2026 sparkle), 'old' (classic), 'white'
  fillMode: FillMode;    // 'auto', 'on', 'off'
  fillThreshold: number; // default 0.75: relative alpha threshold for inpainting core
  fillRadius: number;    // default 1: dilation radius for inpainting mask
  corner: WatermarkCorner; // 'auto' (search BR first then all), or explicit quadrant
  forcePosition?: { x: number; y: number; size?: number } | null;
}

export const DEFAULT_SETTINGS: WatermarkSettings = {
  nccGood: 0.5,
  nccAccept: 0.3,
  scanStride: 8,
  refineRadius: 8,
  gainDrift: 0.62,
  alphaThreshold: 0.002,
  maxAlpha: 0.99,
  logoValue: 250,
  maskScale: 1.0,
  logoVersion: 'auto',
  fillMode: 'auto',
  fillThreshold: 0.85,
  fillRadius: 1,
  corner: 'auto',
  forcePosition: null,
};

export interface DetectionResult {
  detected: boolean;
  confidence: number;
  ncc: number;
  x: number;
  y: number;
  size: number;
  method: 'auto' | 'scan' | 'forced';
  autoX: number;
  autoY: number;
  drifted: boolean;
  gainApplied: number;
  detectedVersion?: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
  detectedCorner?: WatermarkCorner;
  /**
   * Exact template that produced this result. Removal must reuse this mask
   * instead of re-deriving it from `size`, otherwise a scale multiplier can be
   * applied twice and produce a size/data mismatch.
   */
  alphaMap?: Float32Array;
  maskSize?: number;
}

export interface RemovalResult {
  success: boolean;
  message: string;
  position: { x: number; y: number };
  size: number;
  confidence: number;
  pixelsModified: number;
  elapsedMs: number;
  method: 'auto' | 'scan' | 'forced';
  drifted: boolean;
  gainApplied: number;
  detectedVersion?: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
  detectedCorner?: WatermarkCorner;
}

export interface ProcessedItem {
  id: string;
  file: File;
  name: string;
  size: number;
  mediaType: 'image' | 'video';
  originalUrl: string;
  /** Seekable proxy of the source for videos whose own MP4 sync table is broken. */
  playbackUrl?: string;
  originalWidth: number;
  originalHeight: number;
  processedUrl?: string;
  /** File extension for the exported result (png, jpg, webp or mp4). */
  outputExtension?: string;
  /** Detected source frame rate for frame-accurate video stepping. */
  fps?: number;
  /** Non-fatal processing notice, e.g. an unsupported audio codec. */
  warning?: string;
  status: 'idle' | 'processing' | 'done' | 'error';
  result?: RemovalResult;
  videoProgress?: { stage: string; ratio: number };
  detectedVersion?: 'sparkle' | 'classic' | 'new' | 'white' | 'old';
  error?: string;
}
