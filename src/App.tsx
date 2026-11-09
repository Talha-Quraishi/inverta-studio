import React, { useState, useEffect, useCallback } from 'react';
import { Header } from './components/Header';
import { DropZone } from './components/DropZone';
import { ComparisonSlider } from './components/ComparisonSlider';
import { ControlsPanel } from './components/ControlsPanel';
import { BatchQueue } from './components/BatchQueue';
import { VideoPlayerComparison } from './components/VideoPlayerComparison';
import { watermarkEngine } from './engine/watermarkEngine';
import { processVideo } from './engine/videoEngine';
import { DEFAULT_SETTINGS } from './engine/types';
import type { ProcessedItem, WatermarkSettings } from './engine/types';
import { Loader2, AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';

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

  const activeItem = items.find((i) => i.id === activeId);

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
    watermarkEngine
      .initialize()
      .then(() => setEngineReady(true))
      .catch((err) => console.error('Failed to initialize engine:', err));
  }, []);

  // Process a single image item through analytical inversion
  const processImage = useCallback(
    async (item: ProcessedItem, currentSettings: WatermarkSettings): Promise<ProcessedItem> => {
      try {
        const img = new Image();
        img.src = item.originalUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        // Yield briefly before raster processing to maintain 60fps UI
        await new Promise((resolve) => setTimeout(resolve, 10));

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Could not get 2D canvas context');

        ctx.drawImage(img, 0, 0);
        const sourceImageData = ctx.getImageData(0, 0, img.width, img.height);

        // Run client-side mathematical inversion
        const { cleanImageData, result } = watermarkEngine.removeWatermark(
          sourceImageData,
          currentSettings
        );

        ctx.putImageData(cleanImageData, 0, 0);
        const cleanedBlob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), item.file.type || 'image/png')
        );
        const cleanedUrl = cleanedBlob ? URL.createObjectURL(cleanedBlob) : item.originalUrl;

        return {
          ...item,
          originalWidth: img.width,
          originalHeight: img.height,
          sourceImageData,
          processedUrl: cleanedUrl,
          processedImageData: cleanImageData,
          status: 'done',
          detectedVersion: result.detectedVersion,
          result,
        };
      } catch (err: unknown) {
        console.error('Processing error:', err);
        return {
          ...item,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    },
    []
  );

  // Process a video item via WebCodecs MP4 pipeline
  const processVideoItem = useCallback(
    async (item: ProcessedItem, currentSettings: WatermarkSettings): Promise<ProcessedItem> => {
      try {
        const buffer = await item.file.arrayBuffer();
        const videoRes = await processVideo(
          buffer,
          {
            logoVersion: currentSettings.logoVersion,
            maskScale: currentSettings.maskScale,
            corner: currentSettings.corner,
            fillMode: currentSettings.fillMode,
            fillThreshold: currentSettings.fillThreshold,
            fillRadius: currentSettings.fillRadius,
          },
          (prog) => {
            setItems((prev) =>
              prev.map((i) =>
                i.id === item.id
                  ? {
                      ...i,
                      videoProgress: prog,
                      ...(prog.detectedVersion ? { detectedVersion: prog.detectedVersion } : {}),
                    }
                  : i
              )
            );
          }
        );

        const cleanedUrl = URL.createObjectURL(videoRes.blob);
        return {
          ...item,
          processedUrl: cleanedUrl,
          status: 'done',
          detectedVersion: videoRes.hasWatermark ? videoRes.detectedVersion : undefined,
          result: {
            success: true,
            message: videoRes.hasWatermark
              ? `Auto-detected ${
                  videoRes.detectedVersion === 'old'
                    ? 'Classic Star'
                    : videoRes.detectedVersion === 'new'
                    ? '2026 Sparkle'
                    : 'White Sparkle'
                } in ${videoRes.detectedCorner || 'bottom-right'} (${Math.round(videoRes.confidence * 100)}% match)`
              : 'No watermark detected — original video preserved untouched',
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
        console.error('Video processing error:', err);
        return {
          ...item,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      }
    },
    []
  );

  // Add files to queue and dispatch with zero UI hang
  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      if (!engineReady) await watermarkEngine.initialize();

      const newItems: ProcessedItem[] = files.map((file) => {
        const isVideo = file.type.startsWith('video/') || file.name.endsWith('.mp4');
        return {
          id: Math.random().toString(36).substring(2, 9),
          file,
          name: file.name,
          size: file.size,
          mediaType: isVideo ? 'video' : 'image',
          originalUrl: URL.createObjectURL(file),
          originalWidth: 0,
          originalHeight: 0,
          status: 'processing',
        };
      });

      // Immediately register items into state so thumbnails and loaders appear instantly
      setItems((prev) => [...prev, ...newItems]);
      if (newItems.length > 0) {
        setActiveId(newItems[0].id);
      }
      setIsProcessing(true);

      // Micro-yield: Yield back to browser render loop so loading spinner and DOM paint with zero hang
      await new Promise((resolve) => setTimeout(resolve, 40));

      for (const item of newItems) {
        if (item.mediaType === 'video') {
          const processed = await processVideoItem(item, settings);
          setItems((prev) => prev.map((p) => (p.id === item.id ? processed : p)));
        } else {
          const processed = await processImage(item, settings);
          setItems((prev) => prev.map((p) => (p.id === item.id ? processed : p)));
        }
        // Yield between items in batch
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      setIsProcessing(false);
    },
    [engineReady, activeId, processImage, processVideoItem, settings]
  );

  // Re-process active item when settings or nudge change (with instant fast path)
  const reprocessActiveItem = useCallback(
    async (newSettings: WatermarkSettings) => {
      if (!activeItem) return;
      setIsProcessing(true);
      if (activeItem.mediaType === 'video') {
        const updated = await processVideoItem(activeItem, newSettings);
        setItems((prev) => prev.map((item) => (item.id === activeItem.id ? updated : item)));
      } else if (activeItem.sourceImageData) {
        // Fast path: Invert directly from cached memory buffer in ~3ms without re-rasterizing
        try {
          const { cleanImageData, result } = watermarkEngine.removeWatermark(
            activeItem.sourceImageData,
            newSettings
          );
          const canvas = document.createElement('canvas');
          canvas.width = activeItem.sourceImageData.width;
          canvas.height = activeItem.sourceImageData.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.putImageData(cleanImageData, 0, 0);
            const cleanedBlob = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob((b) => resolve(b), activeItem.file.type || 'image/png')
            );
            if (activeItem.processedUrl && activeItem.processedUrl.startsWith('blob:')) {
              URL.revokeObjectURL(activeItem.processedUrl);
            }
            const cleanedUrl = cleanedBlob ? URL.createObjectURL(cleanedBlob) : activeItem.originalUrl;
            const updated: ProcessedItem = {
              ...activeItem,
              processedUrl: cleanedUrl,
              processedImageData: cleanImageData,
              status: 'done',
              detectedVersion: result.detectedVersion,
              result,
            };
            setItems((prev) => prev.map((item) => (item.id === activeItem.id ? updated : item)));
          }
        } catch (err) {
          console.error('Fast reprocess error:', err);
        }
      } else {
        const updated = await processImage(activeItem, newSettings);
        setItems((prev) => prev.map((item) => (item.id === activeItem.id ? updated : item)));
      }
      setIsProcessing(false);
    },
    [activeItem, processImage, processVideoItem]
  );

  const handleUpdateSettings = (partial: Partial<WatermarkSettings>) => {
    const updated = { ...settings, ...partial };
    setSettings(updated);
    reprocessActiveItem(updated);
  };

  const handleResetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    reprocessActiveItem(DEFAULT_SETTINGS);
  };

  const handleNudge = (dx: number, dy: number) => {
    if (!activeItem?.result) return;
    const currentPos = activeItem.result.position;
    const currentSize = activeItem.result.size;

    const newForced = {
      x: currentPos.x + dx,
      y: currentPos.y + dy,
      size: currentSize,
    };

    const updatedSettings = {
      ...settings,
      forcePosition: newForced,
    };

    setSettings(updatedSettings);
    reprocessActiveItem(updatedSettings);
  };

  const handleDownload = () => {
    if (!activeItem?.processedUrl) return;
    const a = document.createElement('a');
    a.href = activeItem.processedUrl;
    a.download = `cleaned_${activeItem.name}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDownloadAll = () => {
    items.forEach((item) => {
      if (item.processedUrl && item.status === 'done') {
        const a = document.createElement('a');
        a.href = item.processedUrl;
        a.download = `cleaned_${item.name}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    });
  };

  const handleRemoveItem = (id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    if (activeId === id) {
      const remaining = items.filter((item) => item.id !== id);
      if (remaining.length > 0) setActiveId(remaining[0].id);
      else setActiveId('');
    }
  };

  const handleClearAll = () => {
    setItems([]);
    setActiveId('');
  };

  return (
    <div className="min-h-screen bg-[#f8f9fa] dark:bg-[#0b0c0e] text-zinc-950 dark:text-[#f4f5f6] flex flex-col font-sans selection:bg-zinc-900 selection:text-white dark:selection:bg-white dark:selection:text-black transition-colors">
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        hasItems={items.length > 0}
        onClearAll={handleClearAll}
      />

      <main className="flex-1 max-w-[1600px] mx-auto px-4 sm:px-6 py-6 w-full flex flex-col gap-5">
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
              <DropZone onFilesSelected={handleFilesSelected} />
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
                        onClick={() => reprocessActiveItem(settings)}
                        className="px-3 py-1.5 rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 text-xs font-medium flex items-center gap-1.5 hover:opacity-90 transition cursor-pointer shadow-xs"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retry Processing
                      </button>
                      <button
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
                    <VideoPlayerComparison item={activeItem} />
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
                    </div>
                  )
                ) : activeItem?.processedUrl ? (
                  <ComparisonSlider
                    originalUrl={activeItem.originalUrl}
                    cleanedUrl={activeItem.processedUrl}
                    result={activeItem.result}
                    width={activeItem.originalWidth}
                    height={activeItem.originalHeight}
                  />
                ) : (
                  <div className="h-[480px] rounded-xl border border-zinc-200 dark:border-white/[0.08] bg-white dark:bg-[#0c0d10] flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-zinc-950 dark:text-white animate-spin" />
                  </div>
                )}

                {/* Bottom Asset Filmstrip */}
                <BatchQueue
                  items={items}
                  activeId={activeId}
                  onSelectItem={setActiveId}
                  onRemoveItem={handleRemoveItem}
                  onDownloadAll={handleDownloadAll}
                />
              </div>

              {/* Right Inspector Column */}
              <div className="lg:col-span-4 xl:col-span-3 flex flex-col gap-4">
                <ControlsPanel
                  settings={settings}
                  result={activeItem?.result}
                  onUpdateSettings={handleUpdateSettings}
                  onResetSettings={handleResetSettings}
                  onDownload={handleDownload}
                  onNudge={handleNudge}
                  isProcessing={isProcessing}
                  fileName={activeItem?.name || 'cleaned_file'}
                  mediaType={activeItem?.mediaType}
                  hasOutput={Boolean(activeItem?.processedUrl)}
                />

                <DropZone onFilesSelected={handleFilesSelected} isCompact />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
