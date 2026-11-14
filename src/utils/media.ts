/**
 * Media validation, naming, and browser encoding helpers.
 */

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 16384;
export const MAX_FILES_PER_BATCH = 30;

const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

const IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

export function getFileExtension(name: string): string {
  const match = /\.([^.]+)$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

export function isVideoFile(file: File): boolean {
  return file.type === 'video/mp4' || getFileExtension(file.name) === 'mp4';
}

export function isSupportedImageFile(file: File): boolean {
  if (file.type in IMAGE_MIME_TO_EXTENSION) return true;
  const extension = getFileExtension(file.name);
  return extension in IMAGE_EXTENSION_TO_MIME;
}

export function isSupportedMediaFile(file: File): boolean {
  return isVideoFile(file) || isSupportedImageFile(file);
}

export function validateFile(file: File): string | null {
  if (isVideoFile(file)) {
    if (file.size > MAX_VIDEO_BYTES) {
      return `${file.name}: video exceeds the ${Math.round(MAX_VIDEO_BYTES / (1024 * 1024))} MB limit`;
    }
    return null;
  }

  if (!isSupportedImageFile(file)) {
    return `${file.name}: unsupported file type`;
  }

  if (file.size > MAX_IMAGE_BYTES) {
    return `${file.name}: image exceeds the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB limit`;
  }

  return null;
}

export function normalizeImageMime(mime: string): string {
  const normalized = (mime || '').toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return normalized in IMAGE_MIME_TO_EXTENSION ? normalized : 'image/png';
}

export function imageExtensionForMime(mime: string): string {
  return IMAGE_MIME_TO_EXTENSION[normalizeImageMime(mime)] || 'png';
}

export function sanitizeBaseName(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, '');
  const cleaned = withoutExtension
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what must be stripped
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'media';
}

export function downloadFileName(
  originalName: string,
  extension: string,
  prefix = 'cleaned'
): string {
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${prefix}_${sanitizeBaseName(originalName)}.${safeExtension}`;
}

export interface EncodedImage {
  blob: Blob;
  mime: string;
  extension: string;
}

/**
 * Encode a canvas while preserving the source format when it is browser
 * supported. BMP sources fall back to lossless PNG instead of silently
 * producing a file whose extension lies about its contents.
 */
export async function encodeCanvasImage(
  canvas: HTMLCanvasElement,
  preferredMime: string
): Promise<EncodedImage> {
  const requestedMime = normalizeImageMime(preferredMime);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(
      (result) => resolve(result),
      requestedMime,
      requestedMime === 'image/jpeg' ? 0.95 : undefined
    );
  });

  if (!blob) {
    throw new Error('The browser could not encode the cleaned image');
  }

  const actualMime = normalizeImageMime(blob.type || requestedMime);
  return {
    blob,
    mime: actualMime,
    extension: imageExtensionForMime(actualMime),
  };
}
