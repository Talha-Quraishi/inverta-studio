import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Crosshair, Eye } from 'lucide-react';
import type { RemovalResult } from '../engine/types';

interface ComparisonSliderProps {
  originalUrl: string;
  cleanedUrl: string;
  result?: RemovalResult;
  width: number;
  height: number;
}

const ComparisonSliderImpl: React.FC<ComparisonSliderProps> = ({
  originalUrl,
  cleanedUrl,
  result,
  width,
  height,
}) => {
  const [sliderPos, setSliderPos] = useState<number>(50); // percentage 0-100
  const [zoom, setZoom] = useState<number>(1);
  const [isLoupe, setIsLoupe] = useState<boolean>(false);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [showHighlight, setShowHighlight] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const isDraggingSlider = useRef(false);
  const cachedRect = useRef<DOMRect | null>(null);
  const rafId = useRef<number | null>(null);
  const nextPos = useRef<number>(50);

  // Watermark focal center for magnification
  const wmOriginX = result && width > 0
    ? Math.round(((result.position.x + result.size / 2) / width) * 100)
    : 85;
  const wmOriginY = result && height > 0
    ? Math.round(((result.position.y + result.size / 2) / height) * 100)
    : 85;

  // Toggle corner loupe (2.2x magnification centered directly on watermark)
  const toggleCornerLoupe = useCallback(() => {
    if (isLoupe) {
      setIsLoupe(false);
      setZoom(1);
      setPan({ x: 0, y: 0 });
    } else {
      setIsLoupe(true);
      setZoom(2.2);
      setPan({ x: 0, y: 0 });
      setSliderPos(wmOriginX);
    }
  }, [isLoupe, wmOriginX]);

  const resetZoom = () => {
    setIsLoupe(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // 60-120fps buttery smooth slider movement coordinated via requestAnimationFrame
  const handleSliderMove = useCallback((clientX: number) => {
    let rect = cachedRect.current;
    if (!rect) {
      const targetEl = stageRef.current || containerRef.current;
      if (!targetEl) return;
      rect = targetEl.getBoundingClientRect();
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
    // If middle click or shift-click when zoomed: pan
    if (e.button === 1 || (e.button === 0 && e.shiftKey && (zoom > 1 || isLoupe))) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      return;
    }

    // Left click immediately snaps slider to mouse position and starts dragging
    if (e.button === 0) {
      isDraggingSlider.current = true;
      const targetEl = stageRef.current || containerRef.current;
      if (targetEl) cachedRect.current = targetEl.getBoundingClientRect();
      handleSliderMove(e.clientX);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDraggingSlider.current) {
      handleSliderMove(e.clientX);
    } else if (isPanning && (zoom > 1 || isLoupe)) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDraggingSlider.current = false;
    setIsPanning(false);
    cachedRect.current = null;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  // Window-level listeners guarantee uninterrupted slider tracking across all input devices
  useEffect(() => {
    const onMove = (e: MouseEvent | PointerEvent) => {
      if (isDraggingSlider.current) {
        handleSliderMove(e.clientX);
      }
    };
    const onUp = () => {
      isDraggingSlider.current = false;
      setIsPanning(false);
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
    window.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (isDraggingSlider.current && e.touches[0]) {
          handleSliderMove(e.touches[0].clientX);
        }
      },
      { passive: true }
    );
    window.addEventListener('touchend', onUp);

    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [handleSliderMove]);

  // Keyboard shortcuts for studio-grade ergonomics
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSliderPos((p) => Math.max(0, p - (e.shiftKey ? 5 : 1)));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSliderPos((p) => Math.min(100, p + (e.shiftKey ? 5 : 1)));
      } else if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        toggleCornerLoupe();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        resetZoom();
      } else if (e.key.toLowerCase() === 'h') {
        e.preventDefault();
        setShowHighlight((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleCornerLoupe]);

  return (
    <div className="flex flex-col gap-3 bg-white dark:bg-[#111316] border border-zinc-200/90 dark:border-white/[0.08] rounded-xl p-3 sm:p-4 select-none shadow-sm transition-colors">
      {/* Viewport Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs border-b border-zinc-200 dark:border-white/[0.06] pb-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-950 dark:text-white tracking-tight text-xs uppercase">Image Viewport</span>
          <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-700 dark:text-zinc-300 font-mono text-[11px] border border-zinc-200 dark:border-white/[0.06]">
            {width} × {height} px
          </span>
          {result && (
            <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-700 dark:text-zinc-300 font-mono text-[11px] border border-zinc-200 dark:border-white/[0.06]">
              {result.size}×{result.size} at ({result.position.x}, {result.position.y})
            </span>
          )}
          {result?.detectedVersion && (
            <span className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-700 dark:text-zinc-300 font-mono text-[11px] border border-zinc-200 dark:border-white/[0.06]">
              Template: {result.detectedVersion === 'old' ? 'Classic Star' : result.detectedVersion === 'new' ? '2026 Sparkle' : 'White Sparkle'}
            </span>
          )}
        </div>

        {/* Viewport Tools */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowHighlight((prev) => !prev)}
            title="Toggle Bounding Box (H)"
            className={`p-1.5 rounded transition-colors cursor-pointer border ${
              showHighlight
                ? 'bg-zinc-200 text-zinc-950 border-zinc-300 dark:bg-white/[0.08] dark:text-white dark:border-white/[0.12]'
                : 'bg-zinc-100 text-zinc-400 border-zinc-200 dark:bg-white/[0.02] dark:text-zinc-500 dark:border-white/[0.04] hover:text-zinc-800 dark:hover:text-zinc-300'
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={toggleCornerLoupe}
            title={isLoupe ? 'Reset Corner Loupe (Z)' : 'Inspect Watermark Corner 2.2x (Z)'}
            className={`flex items-center gap-1 px-2 py-1 rounded border transition text-[11px] font-mono cursor-pointer ${
              isLoupe
                ? 'bg-zinc-950 text-white font-semibold border-zinc-950 dark:bg-white dark:text-zinc-950 dark:border-white shadow-xs'
                : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700 hover:text-zinc-950 border-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] dark:text-zinc-300 dark:hover:text-white dark:border-white/[0.06]'
            }`}
          >
            <Crosshair className="w-3 h-3" />
            <span>{isLoupe ? '1:1 Fit View' : 'Corner Loupe (2.2×)'}</span>
          </button>

          <div className="flex items-center gap-0.5 bg-zinc-100 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06] rounded-md p-0.5">
            <button
              onClick={() => {
                setIsLoupe(false);
                setZoom((z) => Math.min(4, z + 0.5));
              }}
              title="Zoom In (+)"
              className="p-1 rounded text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => {
                setIsLoupe(false);
                setZoom((z) => Math.max(1, z - 0.5));
              }}
              title="Zoom Out (-)"
              className="p-1 rounded text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={resetZoom}
              title="Fit to Screen (F)"
              className="p-1 rounded text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-white cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-mono px-1.5 text-zinc-500 dark:text-zinc-400">
              {Math.round((isLoupe ? 2.2 : zoom) * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Main Interactive Stage */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className="relative w-full aspect-auto max-h-[72vh] min-h-[420px] rounded-lg overflow-hidden bg-[#07080a] border border-zinc-200/50 dark:border-white/[0.06] flex items-center justify-center select-none shadow-sm cursor-ew-resize touch-none"
      >
        <div
          ref={stageRef}
          className={`relative max-w-full max-h-full inline-block select-none ${
            isPanning ? '' : 'transition-transform duration-150 ease-out'
          }`}
          style={{
            transform: zoom > 1 || isLoupe ? `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${isLoupe ? 2.2 : zoom})` : undefined,
            transformOrigin: isLoupe ? `${wmOriginX}% ${wmOriginY}%` : 'center center',
            willChange: isPanning ? 'transform' : 'auto',
          }}
        >
          {/* Base: Cleaned Image */}
          <img
            src={cleanedUrl}
            draggable={false}
            alt="Cleaned output"
            className="max-w-full max-h-[70vh] w-auto h-auto object-contain block pointer-events-none rounded select-none"
          />

          {/* Overlay: Original Image clipped to sliderPos */}
          <div
            className="absolute inset-0 overflow-hidden pointer-events-none rounded select-none will-change-[clip-path]"
            style={{
              clipPath: `polygon(0 0, ${sliderPos}% 0, ${sliderPos}% 100%, 0 100%)`,
            }}
          >
            <img
              src={originalUrl}
              draggable={false}
              alt="Original watermarked"
              className="max-w-full max-h-[70vh] w-auto h-auto object-contain block pointer-events-none select-none"
            />
          </div>

          {/* Watermark detection bounding box indicator */}
          {result && showHighlight && (
            <div
              className="absolute pointer-events-none border border-white/70 bg-white/[0.08] rounded transition-opacity"
              style={{
                left: `${(result.position.x / width) * 100}%`,
                top: `${(result.position.y / height) * 100}%`,
                width: `${(result.size / width) * 100}%`,
                height: `${(result.size / height) * 100}%`,
              }}
            >
              <span className="absolute -top-4 right-0 text-[9px] font-mono font-medium px-1 py-0.2 rounded bg-white text-zinc-950 shadow-xs">
                Watermark
              </span>
            </div>
          )}

          {/* Vertical Hairline Split Divider */}
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-white shadow-[0_0_10px_rgba(0,0,0,0.9)] z-20 pointer-events-none will-change-[left]"
            style={{ left: `${sliderPos}%` }}
          >
            {/* Center Drag Grip */}
            <div className="absolute top-1/2 -translate-y-1/2 -left-3.5 w-7 h-7 rounded-full bg-white text-zinc-950 border border-black/20 shadow-lg flex items-center justify-center active:scale-105 transition-transform pointer-events-auto">
              <div className="flex gap-0.5">
                <span className="w-0.5 h-2.5 bg-zinc-800 rounded-full" />
                <span className="w-0.5 h-2.5 bg-zinc-800 rounded-full" />
              </div>
            </div>
          </div>
        </div>

        {/* Corner labels */}
        <span className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-black/80 backdrop-blur text-[10px] font-mono text-zinc-400 border border-white/[0.08] pointer-events-none z-10">
          Original Reference
        </span>
        <span className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-white text-zinc-950 text-[10px] font-mono font-medium shadow pointer-events-none z-10">
          Cleaned Output
        </span>
      </div>
    </div>
  );
};

export const ComparisonSlider = React.memo(ComparisonSliderImpl);
