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

const VideoPlayerComparisonImpl: React.FC<VideoPlayerComparisonProps> = ({ item }) => {
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

  // Read video resolution from metadata
  const handleLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.videoWidth && v.videoHeight) {
      setVideoDims({ width: v.videoWidth, height: v.videoHeight });
    }
    if (v.duration) {
      setDuration(v.duration);
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

  // Exact watermark focal coordinates from detection telemetry
  const wmOriginX = item.result && videoDims.width > 0
    ? Math.round(((item.result.position.x + item.result.size / 2) / videoDims.width) * 100)
    : (isPortrait ? 84 : 90);
  const wmOriginY = item.result && videoDims.height > 0
    ? Math.round(((item.result.position.y + item.result.size / 2) / videoDims.height) * 100)
    : (isPortrait ? 91 : 86);

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
      if (orig.duration && !duration) setDuration(orig.duration);

      // Active drift correction: keep cleaned video aligned to master original video within 40ms
      if (clean && !clean.seeking && !orig.seeking) {
        const drift = Math.abs(orig.currentTime - clean.currentTime);
        if (drift > 0.04) {
          clean.currentTime = orig.currentTime;
        }
      }
    } else if (clean) {
      setCurrentTime(clean.currentTime);
      if (clean.duration && !duration) setDuration(clean.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (cleanedVideoRef.current) cleanedVideoRef.current.currentTime = time;
    if (originalVideoRef.current) originalVideoRef.current.currentTime = time;
  };

  const stepFrame = useCallback((frames: number) => {
    const frameDuration = 1 / (item.videoFps && item.videoFps > 0 ? item.videoFps : 30);
    const v = cleanedVideoRef.current || originalVideoRef.current;
    if (!v) return;
    const newTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + frames * frameDuration));
    if (cleanedVideoRef.current) cleanedVideoRef.current.currentTime = newTime;
    if (originalVideoRef.current) originalVideoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  }, [item.videoFps]);

  const handleRestart = useCallback(() => {
    if (cleanedVideoRef.current) cleanedVideoRef.current.currentTime = 0;
    if (originalVideoRef.current) originalVideoRef.current.currentTime = 0;
    setCurrentTime(0);
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (cleanedVideoRef.current) cleanedVideoRef.current.muted = next;
      if (originalVideoRef.current) originalVideoRef.current.muted = next;
      return next;
    });
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

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 0) {
      isDraggingSlider.current = true;
      const target = videoWrapperRef.current || containerRef.current;
      if (target) cachedRect.current = target.getBoundingClientRect();
      handleSliderMove(e.clientX);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDraggingSlider.current) {
      handleSliderMove(e.clientX);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDraggingSlider.current = false;
    cachedRect.current = null;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Global window listeners for uninterrupted drag tracking
  useEffect(() => {
    const onMove = (e: MouseEvent | PointerEvent) => {
      if (isDraggingSlider.current) {
        handleSliderMove(e.clientX);
      }
    };
    const onUp = () => {
      isDraggingSlider.current = false;
      cachedRect.current = null;
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('mouseup', onUp);
    const onTouchMove = (e: TouchEvent) => {
      if (isDraggingSlider.current && e.touches[0]) {
        handleSliderMove(e.touches[0].clientX);
      }
    };
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onUp);

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [handleSliderMove]);

  // Video keyboard ergonomics
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Never hijack browser/OS shortcuts (Ctrl+R, Cmd+Z, ...) or typing in form fields.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (viewMode === 'slider' && !isPlaying) {
          setSliderPos((p) => Math.max(0, p - (e.shiftKey ? 5 : 1)));
        } else {
          stepFrame(e.shiftKey ? -5 : -1);
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (viewMode === 'slider' && !isPlaying) {
          setSliderPos((p) => Math.min(100, p + (e.shiftKey ? 5 : 1)));
        } else {
          stepFrame(e.shiftKey ? 5 : 1);
        }
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleMute();
      } else if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleRestart();
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        toggleCornerLoupe();
      } else if (e.key === '1') {
        setViewMode('slider');
      } else if (e.key === '2') {
        setViewMode('split');
      } else if (e.key === '3') {
        setViewMode('cleaned');
      } else if (e.key === '4') {
        setViewMode('original');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, stepFrame, toggleMute, handleRestart, toggleCornerLoupe, viewMode, isPlaying]);

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

  return (
    <div className="flex flex-col gap-3 bg-white dark:bg-[#111316] border border-zinc-200/90 dark:border-white/[0.08] rounded-xl p-3 sm:p-4 select-none shadow-sm transition-colors">
      {/* Top View Mode Switcher and Dimension Telemetry */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs border-b border-zinc-200 dark:border-white/[0.06] pb-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-950 dark:text-white tracking-tight text-xs uppercase">Video Viewport</span>
          <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-700 dark:text-zinc-300 font-mono text-[11px] border border-zinc-200 dark:border-white/[0.06]">
            {aspectLabel}
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
            onClick={toggleCornerLoupe}
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
          <div className="flex items-center gap-0.5 bg-zinc-100 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06] rounded-md p-0.5">
            <button
              onClick={() => setViewMode('slider')}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition cursor-pointer ${
                viewMode === 'slider'
                  ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
                  : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <SlidersHorizontal className="w-3 h-3" />
              <span className="hidden sm:inline">Swipe</span>
            </button>
            <button
              onClick={() => setViewMode('split')}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono transition cursor-pointer ${
                viewMode === 'split'
                  ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
                  : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <Columns2 className="w-3 h-3" />
              <span className="hidden sm:inline">Split</span>
            </button>
            <button
              onClick={() => setViewMode('cleaned')}
              className={`px-2 py-1 rounded text-[11px] font-mono transition cursor-pointer ${
                viewMode === 'cleaned'
                  ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
                  : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              Cleaned
            </button>
            <button
              onClick={() => setViewMode('original')}
              className={`px-2 py-1 rounded text-[11px] font-mono transition cursor-pointer ${
                viewMode === 'original'
                  ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
                  : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              Original
            </button>
          </div>
        </div>
      </div>

      {/* Screen Canvas Container */}
      <div
        ref={containerRef}
        onPointerDown={viewMode === 'slider' ? handlePointerDown : undefined}
        onPointerMove={viewMode === 'slider' ? handlePointerMove : undefined}
        onPointerUp={viewMode === 'slider' ? handlePointerUp : undefined}
        className={`relative w-full rounded-lg overflow-hidden bg-[#07080a] border border-white/[0.06] flex items-center justify-center ${
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
                src={item.processedUrl}
                playsInline
                loop
                muted={isMuted}
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
                  src={item.originalUrl}
                  playsInline
                  loop
                  muted={isMuted}
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
                  className="absolute top-1/2 -translate-y-1/2 -left-3.5 w-7 h-7 rounded-full bg-white text-zinc-950 border border-black/20 shadow-lg flex items-center justify-center active:scale-105 transition-transform pointer-events-auto cursor-ew-resize"
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
                  src={item.originalUrl}
                  playsInline
                  loop
                  muted={isMuted}
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
                  src={item.processedUrl}
                  playsInline
                  loop
                  muted={isMuted}
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
                src={item.processedUrl}
                playsInline
                loop
                muted={isMuted}
                onLoadedMetadata={handleLoadedMetadata}
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
                src={item.originalUrl}
                playsInline
                loop
                muted={isMuted}
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
        <div className="flex items-center justify-between text-xs pt-1">
          <div className="flex items-center gap-1.5">
            <button
              onClick={togglePlay}
              className="w-8 h-8 rounded-md bg-zinc-950 hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-zinc-950 flex items-center justify-center transition active:scale-95 cursor-pointer shadow-xs"
              title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-0.5" />}
            </button>

            <button
              onClick={() => stepFrame(-1)}
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title="Step Backward 1 Frame"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => stepFrame(1)}
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title="Step Forward 1 Frame"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={handleRestart}
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title="Restart from Beginning"
            >
              <RotateCcw className="w-3 h-3" />
            </button>

            <button
              onClick={toggleMute}
              className="w-7 h-7 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] flex items-center justify-center transition cursor-pointer"
              title={isMuted ? 'Unmute Audio' : 'Mute Audio'}
            >
              {isMuted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3 text-zinc-900 dark:text-white" />}
            </button>
          </div>

          <span className="text-[11px] font-mono text-zinc-500 truncate max-w-[200px]">
            {item.name}
          </span>
        </div>
      </div>
    </div>
  );
};

export const VideoPlayerComparison = React.memo(VideoPlayerComparisonImpl);
