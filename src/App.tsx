import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header';
import { DropZone } from './components/DropZone';
import { ComparisonSlider } from './components/ComparisonSlider';
import { ControlsPanel } from './components/ControlsPanel';
import { BatchQueue } from './components/BatchQueue';
import { watermarkEngine } from './engine/watermarkEngine';
import { DEFAULT_SETTINGS } from './engine/types';
import type { ProcessedItem, WatermarkSettings } from './engine/types';
import type { VideoProgress } from './engine/videoEngine';
import {
  MAX_FILES_PER_BATCH,
  MAX_IMAGE_DIMENSION,
  downloadFileName,
  encodeCanvasImage,
  getFileExtension,
  imageExtensionForMime,
  isVideoFile,
  validateFile,
} from './utils/media';
import { Loader2, AlertTriangle, RefreshCw, Trash2, X } from 'lucide-react';

const VideoPlayerComparison = React.lazy(() =>
  import('./components/VideoPlayerComparison').then((module) => ({
    default: module.VideoPlayerComparison,
  }))
);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function versionLabel(version?: string, size?: number): string {
  if (version === 'classic' || (version === 'old' && size === 84)) return 'Classic Dual-Star';
  if (version === 'sparkle' || (version === 'old' && size !== 84)) return 'Gemini Sparkle';
  if (version === 'new') return '2026 Sparkle';
  if (version === 'white') return 'White Sparkle';
  return 'Gemini Sparkle';
}

/**
 * Release a video's optional seekable playback proxy. It is never the same
 * object URL as the original or cleaned output, but keep the guard so future
 * reuse of the field cannot revoke a still-displayed result.
 */
function releasePlaybackUrl(
  item: Pick<ProcessedItem, 'playbackUrl' | 'originalUrl' | 'processedUrl'> | undefined,
  keep?: Pick<ProcessedItem, 'playbackUrl' | 'originalUrl' | 'processedUrl'>
): void {
  const url = item?.playbackUrl;
  if (!item || !url?.startsWith('blob:')) return;
  if (url === item.originalUrl || url === item.processedUrl) return;
  if (
    keep &&
    (url === keep.playbackUrl || url === keep.originalUrl || url === keep.processedUrl)
  ) {
    return;
  }
  URL.revokeObjectURL(url);
}

export const App: React.FC = () => {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('inverta_theme');
      if (saved === 'light' || saved === 'dark') return saved;
    }
    return 'dark';
  });

  const [engineReady, setEngineReady] = useState(false);
  const [items, setItems] = useState<ProcessedItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [settings, setSettings] = useState<WatermarkSettings>(DEFAULT_SETTINGS);
  const [isProcessing, setIsProcessing] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const itemsRef = useRef(items);
  const settingsRef = useRef(settings);
  const activeIdRef = useRef(activeId);

  // Mirror state into refs inside effects so async callbacks and timers always
  // read the latest committed values without touching refs during render.
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  const reprocessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reprocessToken = useRef(0);
  // One abort controller per item lets a reprocess cancel only its own video
  // instead of interrupting a different item's batch job.
  const videoJobsRef = useRef(new Map<string, AbortController>());
  const processingCount = useRef(0);
  const cancelRequested = useRef(false);
  // Per-item generation counters let a newer reprocess win over a batch job
  // that started with older settings, without discarding other items' work.
  const itemVersions = useRef(new Map<string, number>());

  const activeItem = items.find((item) => item.id === activeId);

  const beginProcessing = useCallback(() => {
    processingCount.current += 1;
    setIsProcessing(true);
  }, []);

  const endProcessing = useCallback(() => {
    processingCount.current = Math.max(0, processingCount.current - 1);
    if (processingCount.current === 0) setIsProcessing(false);
  }, []);

  // Commit a finished job only if its item still exists. Revoking the fresh
  // blob URL otherwise prevents leaks when a file is removed mid-processing.
  const commitProcessed = useCallback((itemId: string, updated: ProcessedItem) => {
    setItems((prev) => {
      if (!prev.some((current) => current.id === itemId)) {
        if (updated.processedUrl?.startsWith('blob:')) {
          URL.revokeObjectURL(updated.processedUrl);
        }
        releasePlaybackUrl(updated);
        return prev;
      }
      return prev.map((current) => (current.id === itemId ? updated : current));
    });
  }, []);

  const bumpItemVersion = useCallback((itemId: string) => {
    const next = (itemVersions.current.get(itemId) ?? 0) + 1;
    itemVersions.current.set(itemId, next);
    return next;
  }, []);

  const getItemVersion = useCallback(
    (itemId: string) => itemVersions.current.get(itemId) ?? 0,
    []
  );

  // Sync theme with HTML root class and local storage
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('inverta_theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  // Initialize image engine on mount
  useEffect(() => {
    let cancelled = false;
    watermarkEngine
      .initialize()
      .then(() => {
        if (!cancelled) setEngineReady(true);
      })
      .catch((err) => {
        console.error('Failed to initialize engine:', err);
        if (!cancelled) {
          setFileError(
            'The watermark templates could not be loaded. Check that /masks assets are reachable.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Abort active work and release object URLs when the studio closes
  useEffect(() => {
    const videoJobs = videoJobsRef.current;
    return () => {
      if (reprocessTimer.current) clearTimeout(reprocessTimer.current);
      for (const controller of videoJobs.values()) controller.abort();
      videoJobs.clear();
      for (const item of itemsRef.current) {
        if (item.originalUrl.startsWith('blob:')) URL.revokeObjectURL(item.originalUrl);
        if (item.processedUrl?.startsWith('blob:')) URL.revokeObjectURL(item.processedUrl);
        releasePlaybackUrl(item);
      }
    };
  }, []);

  // Process a single image item through analytical inversion
  const processImage = useCallback(
    async (item: ProcessedItem, currentSettings: WatermarkSettings): Promise<ProcessedItem> => {
      try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = () => reject(new Error('The image could not be decoded'));
          img.src = item.originalUrl;
        });

        if (!img.naturalWidth || !img.naturalHeight) {
          throw new Error('The image has invalid dimensions');
        }
        if (
          img.naturalWidth > MAX_IMAGE_DIMENSION ||
          img.naturalHeight > MAX_IMAGE_DIMENSION
        ) {
          throw new Error(
            `Image is ${img.naturalWidth}×${img.naturalHeight}; the ${MAX_IMAGE_DIMENSION}px limit was exceeded`
          );
        }

        // Yield briefly before raster processing so the spinner can paint.
        await delay(10);

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Could not get 2D canvas context');

        ctx.drawImage(img, 0, 0);
        const sourceImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        if (!watermarkEngine.isReady()) {
          await watermarkEngine.initialize();
        }

        const { cleanImageData, result } = watermarkEngine.removeWatermark(
          sourceImageData,
          currentSettings
        );

        // No watermark means the source is already the desired output. Reuse the
        // original file URL so JPEGs and other lossy formats are not re-encoded.
        if (!result.success) {
          return {
            ...item,
            originalWidth: canvas.width,
            originalHeight: canvas.height,
            processedUrl: item.originalUrl,
            outputExtension:
              item.file.type && item.file.type !== 'application/octet-stream'
                ? imageExtensionForMime(item.file.type)
                : getFileExtension(item.name) || 'png',
            status: 'done',
            warning: undefined,
            detectedVersion: undefined,
            result,
          };
        }

        ctx.putImageData(cleanImageData, 0, 0);
        const encoded = await encodeCanvasImage(canvas, item.file.type || 'image/png');
        const cleanedUrl = URL.createObjectURL(encoded.blob);

        return {
          ...item,
          originalWidth: canvas.width,
          originalHeight: canvas.height,
          processedUrl: cleanedUrl,
          outputExtension: encoded.extension,
          status: 'done',
          warning: undefined,
          detectedVersion: result.detectedVersion,
          result,
        };
      } catch (err: unknown) {
        console.error('Processing error:', err);
        return {
          ...item,
          status: 'error',
          videoProgress: undefined,
          error: err instanceof Error ? err.message : 'Unknown image processing error',
        };
      }
    },
    []
  );

  // Process a video item via the WebCodecs worker pipeline
  const processVideoItem = useCallback(
    async (
      item: ProcessedItem,
      currentSettings: WatermarkSettings,
      signal: AbortSignal
    ): Promise<ProcessedItem> => {
      try {
        const buffer = await item.file.arrayBuffer();
        if (signal.aborted) {
          throw new DOMException('Video processing was cancelled.', 'AbortError');
        }

        const { processVideoInWorker } = await import('./engine/videoProcessor');
        const progressGate = { lastAt: 0 };

        const videoSettings = {
          logoVersion: currentSettings.logoVersion,
          maskScale: currentSettings.maskScale,
          corner: currentSettings.corner,
          fillMode: currentSettings.fillMode,
          fillThreshold: currentSettings.fillThreshold,
          fillRadius: currentSettings.fillRadius,
          forcePosition: currentSettings.forcePosition,
        };

        const forwardProgress = (progress: VideoProgress) => {
          const now = performance.now();
          if (progress.ratio < 1 && now - progressGate.lastAt < 100) return;
          progressGate.lastAt = now;
          setItems((prev) =>
            prev.map((current) =>
              current.id === item.id
                ? {
                    ...current,
                    videoProgress: progress,
                    ...(progress.detectedVersion
                      ? { detectedVersion: progress.detectedVersion }
                      : {}),
                  }
                : current
            )
          );
        };

        let videoRes;
        try {
          videoRes = await processVideoInWorker(buffer, videoSettings, forwardProgress, signal);
        } catch (err) {
          if (!(err instanceof Error) || err.name !== 'VideoWorkerUnavailableError') throw err;
          // The worker consumed the transferred buffer before discovering that
          // WebCodecs is window-only in this browser; re-read and retry here.
          console.warn('Video worker lacks WebCodecs; retrying on the main thread.');
          const retryBuffer = await item.file.arrayBuffer();
          if (signal.aborted) {
            throw new DOMException('Video processing was cancelled.', 'AbortError');
          }
          const { processVideo } = await import('./engine/videoEngine');
          videoRes = await processVideo(retryBuffer, videoSettings, forwardProgress, signal);
        }

        const cleanedUrl = URL.createObjectURL(videoRes.blob);
        const playbackUrl =
          videoRes.playbackBlob && !item.playbackUrl
            ? URL.createObjectURL(videoRes.playbackBlob)
            : item.playbackUrl;
        const detectedLabel = versionLabel(videoRes.detectedVersion, videoRes.size);

        return {
          ...item,
          playbackUrl,
          processedUrl: cleanedUrl,
          outputExtension: 'mp4',
          fps: videoRes.fps,
          warning: videoRes.warning,
          status: 'done',
          videoProgress: undefined,
          detectedVersion: videoRes.hasWatermark ? videoRes.detectedVersion : undefined,
          result: {
            success: videoRes.hasWatermark,
            message: videoRes.hasWatermark
              ? `Removed ${detectedLabel} in ${videoRes.detectedCorner || 'bottom-right'} (${Math.round(
                  videoRes.confidence * 100
                )}% match${videoRes.audioPreserved ? ', audio preserved' : ''})`
              : 'No watermark detected — the original video was preserved untouched',
            position: videoRes.position,
            size: videoRes.size,
            confidence: videoRes.confidence,
            pixelsModified: videoRes.hasWatermark ? videoRes.size * videoRes.size : 0,
            elapsedMs: 0,
            method: 'auto',
            drifted: false,
            gainApplied: 1.0,
            detectedVersion: videoRes.hasWatermark ? videoRes.detectedVersion : undefined,
            detectedCorner: videoRes.hasWatermark ? videoRes.detectedCorner : undefined,
          },
        };
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return {
            ...item,
            status: 'error',
            videoProgress: undefined,
            error: 'Processing cancelled.',
          };
        }
        console.error('Video processing error:', err);
        return {
          ...item,
          status: 'error',
          videoProgress: undefined,
          error: err instanceof Error ? err.message : 'Unknown video processing error',
        };
      }
    },
    []
  );

  // Add files to queue and dispatch sequentially
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (!files.length) return;

      const messages: string[] = [];
      let candidates = files;
      if (candidates.length > MAX_FILES_PER_BATCH) {
        messages.push(
          `Only the first ${MAX_FILES_PER_BATCH} files were added (${files.length} selected).`
        );
        candidates = candidates.slice(0, MAX_FILES_PER_BATCH);
      }

      const validFiles: File[] = [];
      for (const file of candidates) {
        const problem = validateFile(file);
        if (problem) messages.push(problem);
        else validFiles.push(file);
      }

      setFileError(messages.length > 0 ? messages.join('\n') : null);
      if (validFiles.length === 0) return;

      // A debounced settings change from the previous selection must not
      // reprocess the first file of this new batch.
      if (reprocessTimer.current) {
        clearTimeout(reprocessTimer.current);
        reprocessTimer.current = null;
      }

      try {
        if (!watermarkEngine.isReady()) await watermarkEngine.initialize();
        setEngineReady(true);
      } catch (err) {
        console.error('Failed to initialize engine:', err);
        setFileError('The watermark engine could not be initialized.');
        return;
      }

      const newItems: ProcessedItem[] = validFiles.map((file) => ({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        file,
        name: file.name,
        size: file.size,
        mediaType: isVideoFile(file) ? 'video' : 'image',
        originalUrl: URL.createObjectURL(file),
        originalWidth: 0,
        originalHeight: 0,
        status: 'processing',
      }));

      setItems((prev) => [...prev, ...newItems]);
      setActiveId(newItems[0].id);
      if (settingsRef.current.forcePosition) {
        const cleared = { ...settingsRef.current, forcePosition: null };
        settingsRef.current = cleared;
        setSettings(cleared);
      }
      beginProcessing();
      cancelRequested.current = false;

      // Let thumbnails and loaders paint before heavy work begins.
      await delay(40);

      try {
        for (let i = 0; i < newItems.length; i++) {
          if (cancelRequested.current) {
            const remaining = new Set(newItems.slice(i).map((item) => item.id));
            setItems((prev) =>
              prev.map((current) =>
                remaining.has(current.id) && current.status === 'processing'
                  ? {
                      ...current,
                      status: 'error',
                      videoProgress: undefined,
                      error: 'Processing cancelled.',
                    }
                  : current
              )
            );
            break;
          }

          const item = newItems[i];
          const itemVersion = getItemVersion(item.id);
          const controller = item.mediaType === 'video' ? new AbortController() : null;
          if (controller) {
            videoJobsRef.current.set(item.id, controller);
          }
          const processed =
            item.mediaType === 'video' && controller
              ? await processVideoItem(item, settingsRef.current, controller.signal)
              : await processImage(item, settingsRef.current);
          if (controller && videoJobsRef.current.get(item.id) === controller) {
            videoJobsRef.current.delete(item.id);
          }

          if (getItemVersion(item.id) !== itemVersion) {
            // A reprocess with newer settings took over this item; keep its
            // result and release this stale one.
            if (
              processed.processedUrl &&
              processed.processedUrl !== item.processedUrl &&
              processed.processedUrl !== item.originalUrl
            ) {
              URL.revokeObjectURL(processed.processedUrl);
            }
            releasePlaybackUrl(processed, item);
          } else {
            commitProcessed(item.id, processed);
          }
          await delay(10);
        }
      } finally {
        endProcessing();
      }
    },
    [beginProcessing, endProcessing, processImage, processVideoItem, commitProcessed, getItemVersion]
  );

  // Reprocess active item when settings or nudge change. Only the newest
  // request is allowed to commit, and video jobs are aborted on supersession.
  const reprocessActiveItem = useCallback(
    async (newSettings: WatermarkSettings) => {
      const item = itemsRef.current.find((current) => current.id === activeIdRef.current);
      if (!item) return;

      const token = ++reprocessToken.current;
      bumpItemVersion(item.id);
      beginProcessing();
      let videoController: AbortController | null = null;

      try {
        if (item.mediaType === 'video') {
          // Supersede only this item's running job. A different item may still
          // be processing in the batch queue.
          videoJobsRef.current.get(item.id)?.abort();
          videoController = new AbortController();
          videoJobsRef.current.set(item.id, videoController);
          const updated = await processVideoItem(item, newSettings, videoController.signal);

          if (token !== reprocessToken.current) {
            // A newer reprocess superseded this one. Release only a newly
            // created blob, never the currently displayed older result.
            if (
              updated.processedUrl &&
              updated.processedUrl !== item.processedUrl &&
              updated.processedUrl !== item.originalUrl
            ) {
              URL.revokeObjectURL(updated.processedUrl);
            }
            releasePlaybackUrl(updated, item);
            return;
          }
          if (updated.status === 'done') {
            const oldUrl = itemsRef.current.find((current) => current.id === item.id)?.processedUrl;
            if (oldUrl?.startsWith('blob:') && oldUrl !== item.originalUrl) {
              URL.revokeObjectURL(oldUrl);
            }
            commitProcessed(item.id, updated);
          } else if (updated.error !== 'Processing cancelled.') {
            commitProcessed(item.id, updated);
          }
          return;
        }

        const updated = await processImage(item, newSettings);
        if (token !== reprocessToken.current) {
          if (
            updated.processedUrl &&
            updated.processedUrl !== item.processedUrl &&
            updated.processedUrl !== item.originalUrl
          ) {
            URL.revokeObjectURL(updated.processedUrl);
          }
          return;
        }
        if (updated.status === 'done') {
          const oldUrl = itemsRef.current.find((current) => current.id === item.id)?.processedUrl;
          if (oldUrl?.startsWith('blob:') && oldUrl !== item.originalUrl) {
            URL.revokeObjectURL(oldUrl);
          }
        }
        commitProcessed(item.id, updated);
      } catch (err) {
        if (token === reprocessToken.current) {
          console.error('Reprocess error:', err);
          setItems((prev) =>
            prev.map((current) =>
              current.id === item.id
                ? {
                    ...current,
                    status: 'error',
                    videoProgress: undefined,
                    error: err instanceof Error ? err.message : 'Reprocessing failed',
                  }
                : current
            )
          );
        }
      } finally {
        if (videoController && videoJobsRef.current.get(item.id) === videoController) {
          videoJobsRef.current.delete(item.id);
        }
        endProcessing();
      }
    },
    [beginProcessing, endProcessing, processImage, processVideoItem, commitProcessed, bumpItemVersion]
  );

  const scheduleReprocess = useCallback(
    (nextSettings: WatermarkSettings) => {
      if (reprocessTimer.current) clearTimeout(reprocessTimer.current);
      const current = itemsRef.current.find((item) => item.id === activeIdRef.current);
      const wait = current?.mediaType === 'video' ? 300 : 140;
      reprocessTimer.current = setTimeout(() => {
        reprocessTimer.current = null;
        void reprocessActiveItem(nextSettings);
      }, wait);
    },
    [reprocessActiveItem]
  );

  const handleUpdateSettings = useCallback(
    (partial: Partial<WatermarkSettings>) => {
      const updated = { ...settingsRef.current, ...partial };
      settingsRef.current = updated;
      setSettings(updated);
      scheduleReprocess(updated);
    },
    [scheduleReprocess]
  );

  const handleResetSettings = useCallback(() => {
    settingsRef.current = DEFAULT_SETTINGS;
    setSettings(DEFAULT_SETTINGS);
    scheduleReprocess(DEFAULT_SETTINGS);
  }, [scheduleReprocess]);

  // Forced coordinates belong to one specific asset. Carrying them across a
  // selection or a new batch would pin unrelated media to the wrong corner.
  const clearForcedPosition = useCallback(() => {
    if (!settingsRef.current.forcePosition) return;
    const cleared = { ...settingsRef.current, forcePosition: null };
    settingsRef.current = cleared;
    setSettings(cleared);
  }, []);

  const handleSelectItem = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) return;
      // A pending settings debounce belongs to the item that was active when
      // the change was made, not to the item being selected.
      if (reprocessTimer.current) {
        clearTimeout(reprocessTimer.current);
        reprocessTimer.current = null;
      }
      setActiveId(id);
      clearForcedPosition();
    },
    [clearForcedPosition]
  );

  const handleNudge = useCallback(
    (dx: number, dy: number) => {
      const item = itemsRef.current.find((current) => current.id === activeIdRef.current);
      if (!item?.result) return;

      // Base the nudge on the pending forced alignment when one exists, so
      // rapid clicks accumulate instead of all resolving against the stale
      // detection position.
      const forced = settingsRef.current.forcePosition;
      const hasForced =
        forced && Number.isFinite(forced.x) && Number.isFinite(forced.y);
      const base = hasForced ? forced : item.result.position;
      const size = (hasForced && forced.size) || item.result.size;

      const updated = {
        ...settingsRef.current,
        forcePosition: {
          x: base.x + dx,
          y: base.y + dy,
          size,
        },
      };
      settingsRef.current = updated;
      setSettings(updated);
      scheduleReprocess(updated);
    },
    [scheduleReprocess]
  );

  const handleCancelProcessing = useCallback(() => {
    cancelRequested.current = true;
    for (const controller of videoJobsRef.current.values()) controller.abort();
  }, []);

  const handleDownload = useCallback(() => {
    const item = itemsRef.current.find((current) => current.id === activeIdRef.current);
    if (!item?.processedUrl) return;
    const extension =
      item.mediaType === 'video' ? 'mp4' : item.outputExtension || 'png';
    const prefix = item.result?.success === false ? 'original' : 'cleaned';
    const a = document.createElement('a');
    a.href = item.processedUrl;
    a.download = downloadFileName(item.name, extension, prefix);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, []);

  const handleDownloadAll = useCallback(() => {
    for (const item of itemsRef.current) {
      if (!item.processedUrl || item.status !== 'done') continue;
      const extension =
        item.mediaType === 'video' ? 'mp4' : item.outputExtension || 'png';
      const prefix = item.result?.success === false ? 'original' : 'cleaned';
      const a = document.createElement('a');
      a.href = item.processedUrl;
      a.download = downloadFileName(item.name, extension, prefix);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }, []);

  const handleRemoveItem = useCallback((id: string) => {
    const controller = videoJobsRef.current.get(id);
    if (controller) {
      controller.abort();
      videoJobsRef.current.delete(id);
    }

    const itemToRemove = itemsRef.current.find((item) => item.id === id);
    if (itemToRemove) {
      if (itemToRemove.originalUrl.startsWith('blob:')) {
        URL.revokeObjectURL(itemToRemove.originalUrl);
      }
      if (itemToRemove.processedUrl?.startsWith('blob:')) {
        URL.revokeObjectURL(itemToRemove.processedUrl);
      }
      releasePlaybackUrl(itemToRemove);
    }

    const removingActive = activeIdRef.current === id;
    if (removingActive && reprocessTimer.current) {
      clearTimeout(reprocessTimer.current);
      reprocessTimer.current = null;
    }
    const remaining = itemsRef.current.filter((item) => item.id !== id);
    itemVersions.current.delete(id);
    setItems(remaining);
    if (removingActive) {
      setActiveId(remaining[0]?.id || '');
      clearForcedPosition();
    }
  }, [clearForcedPosition]);

  const handleClearAll = useCallback(() => {
    cancelRequested.current = true;
    if (reprocessTimer.current) {
      clearTimeout(reprocessTimer.current);
      reprocessTimer.current = null;
    }
    for (const controller of videoJobsRef.current.values()) controller.abort();
    videoJobsRef.current.clear();
    for (const item of itemsRef.current) {
      if (item.originalUrl.startsWith('blob:')) URL.revokeObjectURL(item.originalUrl);
      if (item.processedUrl?.startsWith('blob:')) URL.revokeObjectURL(item.processedUrl);
      releasePlaybackUrl(item);
    }
    setItems([]);
    setActiveId('');
    itemVersions.current.clear();
    setFileError(null);
    clearForcedPosition();
  }, [clearForcedPosition]);

  const processingDisabled = !engineReady || isProcessing;

  return (
    <div className="min-h-screen bg-[#f8f9fa] dark:bg-[#0b0c0e] text-zinc-950 dark:text-[#f4f5f6] flex flex-col font-sans selection:bg-zinc-900 selection:text-white dark:selection:bg-white dark:selection:text-black transition-colors">
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        hasItems={items.length > 0}
        onClearAll={handleClearAll}
      />

      <main className="flex-1 max-w-[1600px] mx-auto px-4 sm:px-6 py-6 w-full flex flex-col gap-5">
        {fileError && (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-lg border border-amber-300/80 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span className="whitespace-pre-line flex-1">{fileError}</span>
            <button
              type="button"
              onClick={() => setFileError(null)}
              aria-label="Dismiss message"
              className="p-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-500/20 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {items.length === 0 ? (
          /* Studio Empty / Initial Stage */
          <div className="flex flex-col items-center justify-center my-auto py-12 gap-8">
            <div className="text-center max-w-xl mx-auto flex flex-col items-center gap-2.5">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-100 dark:bg-white/[0.04] border border-zinc-200 dark:border-white/[0.08] text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                <span>Zero Network Uploads · 100% In-Browser</span>
              </div>
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-950 dark:text-white">
                Analytical Watermark Inversion
              </h1>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed max-w-lg">
                Reconstructs original clean pixels from Gemini images and Veo MP4 videos via reverse
                Porter-Duff alpha compositing and hardware-accelerated WebCodecs decoding.
              </p>
            </div>

            <div className="w-full max-w-2xl flex flex-col gap-4">
              <DropZone onFilesSelected={handleFilesSelected} disabled={processingDisabled} />
            </div>

            {/* Technical Specification Matrix */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl w-full text-xs font-mono pt-4 border-t border-zinc-200 dark:border-white/[0.06]">
              <div className="p-3 rounded-lg bg-zinc-100/70 dark:bg-white/[0.02] border border-zinc-200/80 dark:border-white/[0.04]">
                <span className="text-zinc-500 dark:text-zinc-400 block mb-1 text-[10px] uppercase font-semibold">Reconstruction</span>
                <span className="text-zinc-800 dark:text-zinc-300 text-[11px]">Lossless algebraic alpha inversion</span>
              </div>
              <div className="p-3 rounded-lg bg-zinc-100/70 dark:bg-white/[0.02] border border-zinc-200/80 dark:border-white/[0.04]">
                <span className="text-zinc-500 dark:text-zinc-400 block mb-1 text-[10px] uppercase font-semibold">Video Pipeline</span>
                <span className="text-zinc-800 dark:text-zinc-300 text-[11px]">WebCodecs H.264 variable bitrate</span>
              </div>
              <div className="p-3 rounded-lg bg-zinc-100/70 dark:bg-white/[0.02] border border-zinc-200/80 dark:border-white/[0.04]">
                <span className="text-zinc-500 dark:text-zinc-400 block mb-1 text-[10px] uppercase font-semibold">Detection</span>
                <span className="text-zinc-800 dark:text-zinc-300 text-[11px]">Aspect-ratio invariant NCC matrix</span>
              </div>
            </div>
          </div>
        ) : (
          /* Active Studio Editor Layout */
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
              {/* Main Viewport Column */}
              <div className="lg:col-span-8 xl:col-span-9 flex flex-col gap-4">
                {activeItem?.status === 'error' ? (
                  <div className="h-[480px] rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50/40 dark:bg-red-950/20 flex flex-col items-center justify-center p-8 gap-4 select-none">
                    <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center text-red-600 dark:text-red-400">
                      <AlertTriangle className="w-6 h-6" />
                    </div>
                    <div className="text-center max-w-md flex flex-col gap-1.5">
                      <span className="text-sm font-semibold text-zinc-950 dark:text-white">
                        Processing Failed
                      </span>
                      <p className="text-xs text-zinc-600 dark:text-zinc-400 font-mono break-words bg-white/60 dark:bg-black/30 p-2.5 rounded-lg border border-zinc-200/50 dark:border-white/5">
                        {activeItem.error || 'Failed to process file. Please verify codec and format.'}
                      </p>
                      <span className="text-[11px] text-zinc-500 mt-1">
                        {activeItem.mediaType === 'video'
                          ? 'Client-side WebCodecs requires H.264 MP4 videos in supported browsers (Chrome, Edge, Safari).'
                          : 'Please ensure image is a valid PNG, WebP, or JPEG.'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <button
                        type="button"
                        onClick={() => void reprocessActiveItem(settingsRef.current)}
                        disabled={isProcessing}
                        className="px-3 py-1.5 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 text-xs font-medium flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer shadow-xs"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retry Processing
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(activeItem.id)}
                        className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs font-medium flex items-center gap-1.5 hover:bg-zinc-100 dark:hover:bg-white/5 transition cursor-pointer shadow-xs"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Remove File
                      </button>
                    </div>
                  </div>
                ) : activeItem?.mediaType === 'video' ? (
                  activeItem.status === 'done' ? (
                    <Suspense
                      fallback={
                        <div className="h-[480px] rounded-xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#0c0d10] flex items-center justify-center">
                          <Loader2 className="w-6 h-6 text-zinc-950 dark:text-white animate-spin" />
                        </div>
                      }
                    >
                      <VideoPlayerComparison key={activeItem.id} item={activeItem} />
                    </Suspense>
                  ) : (
                    <div className="h-[480px] rounded-xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#0c0d10] flex flex-col items-center justify-center p-8 gap-3 select-none">
                      <Loader2 className="w-6 h-6 text-zinc-950 dark:text-white animate-spin" />
                      <div className="text-center max-w-xs flex flex-col gap-1">
                        <span className="text-xs font-medium text-zinc-950 dark:text-white block">
                          Processing Video ({activeItem.videoProgress?.stage?.toUpperCase() || 'DEMUX'})
                        </span>
                        <div className="w-48 h-1 bg-zinc-200 dark:bg-white/[0.08] rounded-full overflow-hidden mx-auto my-1.5">
                          <div
                            className="h-full bg-zinc-950 dark:bg-white rounded-full transition-all duration-150"
                            style={{
                              width: `${Math.round((activeItem.videoProgress?.ratio || 0) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="text-[11px] text-zinc-500 font-mono">
                          {Math.round((activeItem.videoProgress?.ratio || 0) * 100)}% Completed · Zero Uploads
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleCancelProcessing}
                        className="mt-1 px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-white/5 transition cursor-pointer"
                      >
                        Cancel Processing
                      </button>
                    </div>
                  )
                ) : activeItem?.processedUrl ? (
                  <ComparisonSlider
                    key={activeItem.id}
                    originalUrl={activeItem.originalUrl}
                    cleanedUrl={activeItem.processedUrl}
                    result={activeItem.result}
                    width={activeItem.originalWidth}
                    height={activeItem.originalHeight}
                  />
                ) : (
                  <div className="h-[480px] rounded-xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#0c0d10] flex flex-col items-center justify-center gap-3">
                    <Loader2 className="w-6 h-6 text-zinc-950 dark:text-white animate-spin" />
                    <button
                      type="button"
                      onClick={handleCancelProcessing}
                      className="px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-700 dark:text-zinc-300 text-xs font-medium hover:bg-zinc-100 dark:hover:bg-white/5 transition cursor-pointer"
                    >
                      Cancel Processing
                    </button>
                  </div>
                )}

                {/* Bottom Asset Filmstrip */}
                <BatchQueue
                  items={items}
                  activeId={activeId}
                  onSelectItem={handleSelectItem}
                  onRemoveItem={handleRemoveItem}
                  onDownloadAll={handleDownloadAll}
                />
              </div>

              {/* Right Inspector Column */}
              <div className="lg:col-span-4 xl:col-span-3 flex flex-col gap-4">
                <ControlsPanel
                  settings={settings}
                  result={activeItem?.result}
                  warning={activeItem?.warning}
                  onUpdateSettings={handleUpdateSettings}
                  onResetSettings={handleResetSettings}
                  onDownload={handleDownload}
                  onNudge={handleNudge}
                  onCancel={handleCancelProcessing}
                  isProcessing={isProcessing}
                  fileName={activeItem?.name || 'cleaned_file'}
                  mediaType={activeItem?.mediaType}
                  hasOutput={Boolean(activeItem?.processedUrl && activeItem.status === 'done')}
                />

                <DropZone
                  onFilesSelected={handleFilesSelected}
                  isCompact
                  disabled={processingDisabled}
                />
              </div>
            </div>
          </div>
        )}

        <footer className="mt-auto pt-6 text-center text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-600 font-mono">
          Use only on media you own or are authorized to edit. Inverta Studio is an independent
          project and is not affiliated with or endorsed by Google.
        </footer>
      </main>
    </div>
  );
};

export default App;
