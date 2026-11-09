/**
 * Environment-aware asset path resolver for Inverta Studio.
 * Ensures public assets (masks, samples, icons) correctly resolve on any host,
 * including GitHub Pages subpaths (/inverta-studio/), localhost, and custom domains.
 */
export function resolveAssetUrl(path: string): string {
  if (!path) return '';
  if (
    path.startsWith('data:') ||
    path.startsWith('blob:') ||
    path.startsWith('http://') ||
    path.startsWith('https://')
  ) {
    return path;
  }

  const cleanPath = path.startsWith('/') ? path.slice(1) : path;

  if (typeof window !== 'undefined' && window.location) {
    try {
      const base = import.meta.env.BASE_URL || './';
      const baseObj = new URL(base, window.location.href);
      return new URL(cleanPath, baseObj).href;
    } catch {
      // Fallback if URL parsing fails
    }
  }

  const base = import.meta.env.BASE_URL || './';
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  return `${cleanBase}${cleanPath}`;
}
