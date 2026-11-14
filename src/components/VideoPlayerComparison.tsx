import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  Volume2,
  VolumeX,
  Columns2,
  SlidersHorizontal,
  Crosshair,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import type { ProcessedItem } from '../engine/types';

interface VideoPlayerComparisonProps {
  item: ProcessedItem;
}

export const VideoPlayerComparison: React.FC<VideoPlayerComparisonProps> = ({ item }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [viewMode, setViewMode] = useState<'split' | 'slider' | 'cleaned' | 'original'>('slider');
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sliderPos, setSliderPos] = useState(50); // 0 - 100%
  const [videoDims, setVideoDims] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [zoomCorner, setZoomCorner] = useState(false);

  const originalVideoRef = useRef<HTMLVideoElement>(null);
  const cleanedVideoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoWrapperRef = useRef<HTMLDivElement>(null);
  const isDraggingSlider = useRef(false);
  const cachedRect = useRef<DOMRect | null>(null);
  const rafId = useRef<number | null>(null);
  const nextPos = useRef<number>(50);
  const playbackTimeRef = useRef(0);
  const appliedViewModeRef = useRef(viewMode);

  const cleanedUrl = item.processedUrl || item.originalUrl;
  // Broken MP4 sync tables make the raw source unseekable in Chromium. The
  // worker returns a byte-identical playback copy with a corrected stss table.
  const originalUrl = item.playbackUrl || item.originalUrl;
  const fps = item.fps && item.fps > 0 ? item.fps : 30;

  // Read video resolution from metadata
  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) {
      setVideoDims((prev) =>
        prev.width === v.videoWidth && prev.height === v.videoHeight
          ? prev
          : { width: v.videoWidth, height: v.videoHeight }
      );
    }
    if (Number.isFinite(v.duration) && v.duration > 0) {
      setDuration((prev) => (Math.abs(prev - v.duration) < 0.01 ? prev : v.duration));
    }
  };

  const isPortrait = videoDims.height > videoDims.width && videoDims.width > 0;
  const aspectLabel =
    videoDims.width === 0
      ? 'Loading...'
      : isPortrait
      ? `${videoDims.width}×${videoDims.height} · 9:16 Portrait`
      : videoDims.width === videoDims.height
      ? `${videoDims.width}×${videoDims.height} · 1:1 Square`
      : `${videoDims.width}×${videoDims.height} · 16:9 Widescreen`;

  // Watermark focal coordinates from detection telemetry, clamped so an edge
  // watermark cannot transform the loupe outside the visible stage.
  const hasDetection = item.result?.success === true;
  const wmOriginX = hasDetection && item.result && videoDims.width > 0
    ? Math.max(0, Math.min(100, Math.round(((item.result.position.x + item.result.size / 2) / videoDims.width) * 100)))
    : (isPortrait ? 84 : 90);
  const wmOriginY = hasDetection && item.result && videoDims.height > 0
    ? Math.max(0, Math.min(100, Math.round(((item.result.position.y + item.result.size / 2) / videoDims.height) * 100)))
    : (isPortrait ? 91 : 86);

  // Only one element may own the audio output. Playing both unmuted created an
  // audible echo because the two tracks were never sample-aligned.
  const audioOwner: 'original' | 'cleaned' = viewMode === 'cleaned' ? 'cleaned' : 'original';
  const originalMuted = isMuted || audioOwner !== 'original';
  const cleanedMuted = isMuted || audioOwner !== 'cleaned';

  useEffect(() => {
    if (originalVideoRef.current) originalVideoRef.current.muted = originalMuted;
    if (cleanedVideoRef.current) cleanedVideoRef.current.muted = cleanedMuted;
  }, [originalMuted, cleanedMuted]);

  // Synchronized play / pause
  const togglePlay = useCallback(() => {
    const orig = originalVideoRef.current;
    const clean = cleanedVideoRef.current;
    if (isPlaying) {
      orig?.pause();
      clean?.pause();
      setIsPlaying(false);
    } else {
      if (orig && clean) {
        clean.currentTime = orig.currentTime;
      }
      orig?.play().catch(() => {});
      clean?.play().catch(() => {});
      setIsPlaying(true);
    }
  }, [isPlaying]);

  // Synchronized seek & active drift compensation
  const handleTimeUpdate = () => {
    const orig = originalVideoRef.current;
    const clean = cleanedVideoRef.current;
    if (orig) {
      setCurrentTime(orig.currentTime);
      if (Number.isFinite(orig.duration) && orig.duration > 0) {
        setDuration((prev) => (Math.abs(prev - orig.duration) < 0.01 ? prev : orig.duration));
      }

      // Active drift correction: keep cleaned video aligned to master original video within 40ms
      if (clean && !clean.seeking && !orig.seeking) {
        const drift = Math.abs(orig.currentTime - clean.currentTime);
        if (drift > 0.04) {
          clean.currentTime = orig.currentTime;
        }
      }
    } else if (clean) {
      setCurrentTime(clean.currentTime);
      if (Number.isFinite(clean.duration) && clean.duration > 0) {
        setDuration((prev) => (Math.abs(prev - clean.duration) < 0.01 ? prev : clean.duration));
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (cleanedVideoRef.current) cleanedVideoRef.current.currentTime = time;
    if (originalVideoRef.current) originalVideoRef.current.currentTime = time;
  };

  const stepFrame = useCallback((frames: number) => {
    const v = cleanedVideoRef.current || originalVideoRef.current;
    if (!v) return;
    const frameDuration = 1 / fps;
    const newTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + frames * frameDuration));
    if (cleanedVideoRef.current) cleanedVideoRef.current.currentTime = newTime;
    if (originalVideoRef.current) originalVideoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [fps]);

  const handleRestart = useCallback(() => {
    if (cleanedVideoRef.current) cleanedVideoRef.current.currentTime = 0;
    if (originalVideoRef.current) originalVideoRef.current.currentTime = 0;
    setCurrentTime(0);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  // Toggle Corner Loupe with automatic watermark divider alignment
  const toggleCornerLoupe = useCallback(() => {
    if (zoomCorner) {
      setZoomCorner(false);
    } else {
      setZoomCorner(true);
      if (viewMode === 'slider') {
        setSliderPos(wmOriginX);
      }
    }
  }, [zoomCorner, viewMode, wmOriginX]);

  // 60-120fps buttery smooth slider tracking via RAF
  const handleSliderMove = useCallback((clientX: number) => {
    let rect = cachedRect.current;
    if (!rect) {
      const target = videoWrapperRef.current || containerRef.current;
      if (!target) return;
      rect = target.getBoundingClientRect();
      cachedRect.current = rect;
    }
    if (rect.width <= 0) return;
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(100, (x / rect.width) * 100));
    nextPos.current = pct;

    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(() => {
        setSliderPos(nextPos.current);
        rafId.current = null;
      });
    }
  }, []);

  const endSliderDrag = useCallback(() => {
    isDraggingSlider.current = false;
    cachedRect.current = null;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // Keep playback state honest if the browser pauses media on its own.
  useEffect(() => {
    const videos = [originalVideoRef.current, cleanedVideoRef.current].filter(
      (v): v is HTMLVideoElement => Boolean(v)
    );
    const onPause = () => {
      if (videos.every((v) => v.paused)) setIsPlaying(false);
    };
    const onPlay = () => setIsPlaying(true);
    for (const v of videos) {
      v.addEventListener('pause', onPause);
      v.addEventListener('play', onPlay);
    }
    return () => {
      for (const v of videos) {
        v.removeEventListener('pause', onPause);
        v.removeEventListener('play', onPlay);
      }
    };
    // Switching view modes replaces the <video> nodes, so the listeners must
    // be reattached even though the effect body only reads refs.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [viewMode]);

  // Track the timeline outside render so a view-mode switch can restore the
  // newly mounted <video> node to the same seek position.
  useEffect(() => {
    playbackTimeRef.current = currentTime;
  }, [currentTime]);

  // Changing the view mode replaces the <video> elements. Seek the new nodes
  // back to the current time; playback itself is reset in `selectViewMode` so
  // the Pause button can never describe a fresh, paused video as playing.
  useEffect(() => {
    const previousViewMode = appliedViewModeRef.current;
    appliedViewModeRef.current = viewMode;
    if (previousViewMode === viewMode) return;

    const time = playbackTimeRef.current;
    const videos = [originalVideoRef.current, cleanedVideoRef.current].filter(
      (v): v is HTMLVideoElement => Boolean(v)
    );

    for (const video of videos) {
      if (time > 0) {
        try {
          video.currentTime =
            Number.isFinite(video.duration) && video.duration > 0
              ? Math.min(time, video.duration)
              : time;
        } catch {
          // Metadata may not be available yet; the pending seek is retained.
        }
      }
    }
  }, [viewMode]);

  const selectViewMode = useCallback(
    (mode: typeof viewMode) => {
      if (mode === viewMode) return;
      setIsPlaying(false);
      setViewMode(mode);
    },
    [viewMode]
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (viewMode !== 'slider' || e.button !== 0) return;
    isDraggingSlider.current = true;
    const target = videoWrapperRef.current || containerRef.current;
    if (target) cachedRect.current = target.getBoundingClientRect();
    handleSliderMove(e.clientX);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Capture is a progressive enhancement.
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDraggingSlider.current) {
      handleSliderMove(e.clientX);
    }
  };

  const handlePointerEnd = (e: React.PointerEvent) => {
    endSliderDrag();
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already have been released.
    }
  };

  // Keyboard shortcuts are scoped to the focused player, so typing elsewhere
  // is never interrupted.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (viewMode === 'slider' && !isPlaying) {
          setSliderPos((p) => Math.max(0, p - (e.shiftKey ? 5 : 1)));
        } else {
          stepFrame(e.shiftKey ? -5 : -1);
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (viewMode === 'slider' && !isPlaying) {
          setSliderPos((p) => Math.min(100, p + (e.shiftKey ? 5 : 1)));
        } else {
          stepFrame(e.shiftKey ? 5 : 1);
        }
        break;
      case 'm':
      case 'M':
        e.preventDefault();
        toggleMute();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        handleRestart();
        break;
      case 'z':
      case 'Z':
        e.preventDefault();
        toggleCornerLoupe();
        break;
      case '1':
        selectViewMode('slider');
        break;
      case '2':
        selectViewMode('split');
        break;
      case '3':
        selectViewMode('cleaned');
        break;
      case '4':
        selectViewMode('original');
        break;
      default:
        break;
    }
  };

  const formatTimecode = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const videoAspectStyle =
    videoDims.width && videoDims.height
      ? { aspectRatio: `${videoDims.width} / ${videoDims.height}` }
      : undefined;

  const viewButtonClass = (mode: typeof viewMode) =>
    `px-2 py-1 rounded text-[11px] font-mono transition cursor-pointer ${
      viewMode === mode
        ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
        : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
    }`;

  return (
    <div className="flex flex-col gap-3 bg-white dark:bg-[#111316] border border-zinc-200/90 dark:border-white/[0.08] rounded-xl p-3 sm:p-4 select-none shadow-sm transition-colors">
      {/* Top View Mode Switcher and Dimension Telemetry */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs border-b border-zinc-200 dark:border-white/[0.06] pb-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-950 dark:text-white tracking-tight text-xs uppercase">Video Viewport</span>
          <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-700 dark:text-zinc-300 font-mono text-[11px] border border-zinc-200 dark:border-white/[0.06]">
            {aspectLabel}
          </span>
          <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-700 dark:text-zinc-300 font-mono text-[11px] border border-zinc-200 dark:border-white/[0.06]">
            {fps} fps
          </span>
          {item.detectedVersion && (
            <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-700 dark:text-zinc-300 font-mono text-[11px] border border-zinc-200 dark:border-white/[0.06]">
              Template: {item.detectedVersion === 'old' ? 'Classic Star' : item.detectedVersion === 'new' ? '2026 Sparkle' : 'White Sparkle'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {/* Zoom Loupe Toggle */}
          <button
            type="button"
            onClick={toggleCornerLoupe}
            aria-pressed={zoomCorner}
            aria-label={zoomCorner ? 'Reset view to fit' : 'Inspect watermark corner at 2.2x'}
            title={zoomCorner ? 'Reset View to 1:1' : 'Inspect Watermark Corner (2.2x)'}
            className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border transition cursor-pointer ${
              zoomCorner
                ? 'bg-zinc-950 text-white font-semibold border-zinc-950 dark:bg-white dark:text-zinc-950 dark:border-white shadow-xs'
                : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700 hover:text-zinc-950 border-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:text-zinc-300 dark:hover:text-white dark:border-white/[0.06]'
            }`}
          >
            <Crosshair className="w-3 h-3" />
            <span>{zoomCorner ? '1:1 Fit View' : 'Corner Loupe (2.2×)'}</span>
          </button>

          {/* View Mode Segmented Controls */}
          <div
            role="group"
            aria-label="Video view mode"
            className="flex items-center gap-0.5 bg-zinc-100 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06] rounded-md p-0.5"
          >
            <button
              type="button"
              onClick={() => selectViewMode('slider')}
              aria-pressed={viewMode === 'slider'}
              title="Swipe comparison (1)"
              className={viewButtonClass('slider')}
            >
              <SlidersHorizontal className="w-3 h-3" />
              <span className="hidden sm:inline">Swipe</span>
            </button>
            <button
              type="button"
              onClick={() => selectViewMode('split')}
              aria-pressed={viewMode === 'split'}
              title="Side-by-side (2)"
              className={viewButtonClass('split')}
            >
              <Columns2 className="w-3 h-3" />
              <span className="hidden sm:inline">Split</span>
            </button>
            <button
              type="button"
              onClick={() => selectViewMode('cleaned')}
              aria-pressed={viewMode === 'cleaned'}
              title="Cleaned output only (3)"
              className={viewButtonClass('cleaned')}
            >
              Cleaned
            </button>
            <button
              type="button"
              onClick={() => selectViewMode('original')}
              aria-pressed={viewMode === 'original'}
              title="Original reference only (4)"
              className={viewButtonClass('original')}
            >
              Original
            </button>
          </div>
        </div>
      </div>

      {item.warning && (
        <div
          role="status"
          className="rounded-lg border border-amber-300/80 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          {item.warning}
        </div>
      )}

      {/* Screen Canvas Container */}
      <div
        ref={containerRef}
        tabIndex={0}
        role="group"
        aria-label="Video comparison player. Space plays or pauses, arrow keys step or move the split, M mutes, R restarts, Z toggles the loupe, and 1-4 change the view."
        aria-keyshortcuts="Space ArrowLeft ArrowRight M R Z 1 2 3 4"
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={endSliderDrag}
        className={`relative w-full rounded-lg overflow-hidden bg-[#07080a] border border-white/[0.06] flex items-center justify-center touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#111316] ${
          viewMode === 'slider' ? 'cursor-ew-resize' : 'cursor-default'
        } ${isPortrait ? 'h-[520px] sm:h-[600px] max-h-[72vh]' : 'h-[440px] sm:h-[500px] max-h-[65vh]'}`}
      >
        {/* Mode 1: Swipe Slider (Single Canvas with Hairline Divider) */}
        {viewMode === 'slider' && (
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            <div
              ref={videoWrapperRef}
              className="relative max-h-full max-w-full flex items-center justify-center select-none transition-transform duration-150 ease-out"
              style={{
                ...videoAspectStyle,
                height: '100%',
                transform: zoomCorner ? 'scale(2.2)' : undefined,
                transformOrigin: zoomCorner ? `${wmOriginX}% ${wmOriginY}%` : 'center center',
              }}
            >
              {/* Base: Cleaned Video */}
              <video
                ref={cleanedVideoRef}
                src={cleanedUrl}
                playsInline
                loop
                muted={cleanedMuted}
                aria-hidden="true"
                onLoadedMetadata={handleLoadedMetadata}
                className="w-full h-full object-contain rounded pointer-events-none select-none"
              />

              {/* Clipped Overlay: Original Video */}
              <div
                className="absolute inset-0 overflow-hidden pointer-events-none rounded select-none"
                style={{
                  clipPath: `polygon(0 0, ${sliderPos}% 0, ${sliderPos}% 100%, 0 100%)`,
                }}
              >
                <video
                  ref={originalVideoRef}
                  src={originalUrl}
                  playsInline
                  loop
                  muted={originalMuted}
                  aria-hidden="true"
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={handleTimeUpdate}
                  className="w-full h-full object-contain rounded pointer-events-none select-none"
                />
              </div>

              {/* Hairline Divider with Precision Drag Notch */}
              <div
                className="absolute top-0 bottom-0 w-[2px] bg-white pointer-events-none shadow-[0_0_10px_rgba(0,0,0,0.9)] z-20"
                style={{ left: `${sliderPos}%` }}
              >
                <div
                  aria-hidden="true"
                  className="absolute top-1/2 -translate-y-1/2 -left-3.5 w-7 h-7 rounded-full bg-white text-zinc-950 border border-black/20 shadow-lg flex items-center justify-center active:scale-105 transition-transform pointer-events-none cursor-ew-resize"
                >
                  <div className="flex gap-0.5">
                    <span className="w-0.5 h-2.5 bg-zinc-800 rounded-full" />
                    <span className="w-0.5 h-2.5 bg-zinc-800 rounded-full" />
                  </div>
                </div>
              </div>
            </div>

            {/* Indicator Labels */}
            <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-black/80 backdrop-blur text-[10px] font-mono text-zinc-400 border border-white/[0.08] pointer-events-none z-10">
              Original Reference
            </span>
            <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-white text-zinc-950 text-[10px] font-mono font-medium shadow pointer-events-none z-10">
              Cleaned Output
            </span>
          </div>
        )}

        {/* Mode 2: Split View (Side-by-Side) */}
        {viewMode === 'split' && (
          <div className="w-full h-full flex flex-row overflow-hidden divide-x divide-white/[0.08]">
            {/* Left Column: Original */}
            <div className="relative w-1/2 h-full bg-[#07080a] flex items-center justify-center overflow-hidden p-2">
              <div
                className="relative max-h-full max-w-full flex items-center justify-center transition-transform duration-150 ease-out"
                style={{
                  ...videoAspectStyle,
                  height: '100%',
                  transform: zoomCorner ? 'scale(2.2)' : undefined,
                  transformOrigin: zoomCorner ? `${wmOriginX}% ${wmOriginY}%` : 'center center',
                }}
              >
                <video
                  ref={originalVideoRef}
                  src={originalUrl}
                  playsInline
                  loop
                  muted={originalMuted}
                  aria-hidden="true"
                  onLoadedMetadata={handleLoadedMetadata}
                  onTimeUpdate={handleTimeUpdate}
                  className="w-full h-full object-contain rounded pointer-events-none select-none"
                />
              </div>
              <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-black/80 backdrop-blur text-[10px] font-mono text-zinc-400 border border-white/[0.08] pointer-events-none z-10">
                Original (Reference)
              </span>
            </div>

            {/* Right Column: Cleaned */}
            <div className="relative w-1/2 h-full bg-[#07080a] flex items-center justify-center overflow-hidden p-2">
              <div
                className="relative max-h-full max-w-full flex items-center justify-center transition-transform duration-150 ease-out"
                style={{
                  ...videoAspectStyle,
                  height: '100%',
                  transform: zoomCorner ? 'scale(2.2)' : undefined,
                  transformOrigin: zoomCorner ? `${wmOriginX}% ${wmOriginY}%` : 'center center',
                }}
              >
                <video
                  ref={cleanedVideoRef}
                  src={cleanedUrl}
                  playsInline
                  loop
                  muted={cleanedMuted}
                  aria-hidden="true"
                  onLoadedMetadata={handleLoadedMetadata}
                  className="w-full h-full object-contain rounded pointer-events-none select-none"
                />
              </div>
              <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-white text-zinc-950 text-[10px] font-mono font-medium shadow pointer-events-none z-10">
                Cleaned Output
              </span>
            </div>
          </div>
        )}

        {/* Mode 3: Cleaned Only */}
        {viewMode === 'cleaned' && (
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            <div
              className="relative max-h-full max-w-full flex items-center justify-center transition-transform duration-150 ease-out"
              style={{
                ...videoAspectStyle,
                height: '100%',
                transform: zoomCorner ? 'scale(2.2)' : undefined,
                transformOrigin: zoomCorner ? `${wmOriginX}% ${wmOriginY}%` : 'center center',
              }}
            >
              <video
                ref={cleanedVideoRef}
                src={cleanedUrl}
                playsInline
                loop
                muted={cleanedMuted}
                aria-hidden="true"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                className="w-full h-full object-contain rounded pointer-events-none select-none"
              />
            </div>
            <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-white text-zinc-950 text-[10px] font-mono font-medium shadow pointer-events-none z-10">
              Cleaned Output
            </span>
          </div>
        )}

        {/* Mode 4: Original Only */}
        {viewMode === 'original' && (
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            <div
              className="relative max-h-full max-w-full flex items-center justify-center transition-transform duration-150 ease-out"
              style={{
                ...videoAspectStyle,
                height: '100%',
                transform: zoomCorner ? 'scale(2.2)' : undefined,
                transformOrigin: zoomCorner ? `${wmOriginX}% ${wmOriginY}%` : 'center center',
              }}
            >
              <video
                ref={originalVideoRef}
                src={originalUrl}
                playsInline
                loop
                muted={originalMuted}
                aria-hidden="true"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                className="w-full h-full object-contain rounded pointer-events-none select-none"
              />
            </div>
            <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-black/80 backdrop-blur text-[10px] font-mono text-zinc-400 border border-white/[0.08] pointer-events-none z-10">
              Original Reference
            </span>
          </div>
        )}
      </div>

      {/* Media Playback Controls & Frame Stepper */}
      <div className="flex flex-col gap-2 pt-1">
        {/* Timeline Scrubber */}
        <div className="flex items-center gap-3 h-6">
          <span className="text-[11px] font-mono text-zinc-600 dark:text-zinc-400 w-16 tabular-nums select-none">
            {formatTimecode(currentTime)}
          </span>
          <input
            type="range"
            min="0"
            max={duration || 100}
            step="0.01"
            value={currentTime}
            onChange={handleSeek}
            aria-label="Video timeline"
            style={{
              '--slider-pct': `${duration > 0 ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0}%`,
            } as React.CSSProperties}
            className="flex-1 custom-range-slider"
          />
          <span className="text-[11px] font-mono text-zinc-500 w-16 text-right tabular-nums select-none">
            {formatTimecode(duration)}
          </span>
        </div>

        {/* Control Buttons */}
        <div className="flex items-center justify-between gap-2 text-xs pt-1">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause video' : 'Play video'}
              className="w-8 h-8 rounded-md bg-zinc-950 hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-zinc-950 flex items-center justify-center transition active:scale-95 cursor-pointer shadow-xs"
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
            </button>

            <button
              type="button"
              onClick={() => stepFrame(-1)}
              aria-label="Step backward one frame"
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title="Step Backward 1 Frame"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => stepFrame(1)}
              aria-label="Step forward one frame"
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title="Step Forward 1 Frame"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={handleRestart}
              aria-label="Restart video"
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title="Restart from Beginning"
            >
              <RotateCcw className="w-3 h-3" />
            </button>

            <button
              type="button"
              onClick={toggleMute}
              aria-pressed={!isMuted}
              aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title={isMuted ? 'Unmute Audio' : 'Mute Audio'}
            >
              {isMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3 text-zinc-900 dark:text-white" />}
            </button>
          </div>

          <span className="text-[11px] font-mono text-zinc-500 truncate max-w-[200px]" title={item.name}>
            {item.name}
          </span>
        </div>
      </div>
    </div>
  );
};
