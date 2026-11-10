import React, { useState } from 'react';
import {
  Download,
  RotateCcw,
  Sliders,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Crosshair,
  Compass,
} from 'lucide-react';
import type { LogoVersion, RemovalResult, WatermarkCorner, WatermarkSettings } from '../engine/types';

interface ControlsPanelProps {
  settings: WatermarkSettings;
  result?: RemovalResult;
  onUpdateSettings: (newSettings: Partial<WatermarkSettings>) => void;
  onResetSettings: () => void;
  onDownload: () => void;
  onNudge: (dx: number, dy: number) => void;
  isProcessing: boolean;
  fileName: string;
  mediaType?: 'image' | 'video';
  hasOutput?: boolean;
}

export const ControlsPanel: React.FC<ControlsPanelProps> = ({
  settings,
  result,
  onUpdateSettings,
  onResetSettings,
  onDownload,
  onNudge,
  isProcessing,
  fileName,
  mediaType = 'image',
  hasOutput = false,
}) => {
  const [showAdvanced, setShowAdvanced] = useState(true);
  const [localMaskScale, setLocalMaskScale] = useState(settings.maskScale);
  const [localFillRadius, setLocalFillRadius] = useState(settings.fillRadius);
  const [prevSettings, setPrevSettings] = useState({
    maskScale: settings.maskScale,
    fillRadius: settings.fillRadius,
  });
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Synchronize local slider values if external settings reset/update
  if (prevSettings.maskScale !== settings.maskScale || prevSettings.fillRadius !== settings.fillRadius) {
    setPrevSettings({
      maskScale: settings.maskScale,
      fillRadius: settings.fillRadius,
    });
    setLocalMaskScale(settings.maskScale);
    setLocalFillRadius(settings.fillRadius);
  }

  React.useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const handleMaskScaleChange = (val: number) => {
    setLocalMaskScale(val);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      onUpdateSettings({ maskScale: val });
    }, 120);
  };

  const handleFillRadiusChange = (val: number) => {
    setLocalFillRadius(val);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      onUpdateSettings({
        fillRadius: val,
        fillMode: val > 0 ? 'on' : 'off',
      });
    }, 120);
  };

  const canDownload = mediaType === 'video' ? hasOutput : (result?.success ?? false);

  const formatVersionLabel = (v?: 'old' | 'new' | 'white', size?: number) => {
    const sizeStr = size ? ` (${size}px)` : '';
    if (v === 'old') return `Classic Star${sizeStr}`;
    if (v === 'new') return `2026 Sparkle${sizeStr}`;
    if (v === 'white') return `White Sparkle${sizeStr}`;
    return 'Unknown';
  };

  return (
    <div className="flex flex-col gap-4 bg-white dark:bg-[#111316] border border-zinc-200/90 dark:border-white/[0.08] rounded-xl p-4 text-zinc-800 dark:text-zinc-300 select-none shadow-sm transition-colors">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 dark:border-white/[0.06] pb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-950 dark:text-white">Inspector</span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-white/[0.06]">
            {mediaType.toUpperCase()}
          </span>
        </div>
        <span className="text-[11px] font-mono text-zinc-500 truncate max-w-[150px]">{fileName}</span>
      </div>

      {/* Primary Action Button */}
      <div>
        <button
          onClick={onDownload}
          disabled={!canDownload || isProcessing}
          className="w-full py-2.5 px-3 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-zinc-950 disabled:bg-zinc-200 disabled:text-zinc-400 dark:disabled:bg-white/[0.05] dark:disabled:text-zinc-600 disabled:cursor-not-allowed font-semibold text-xs tracking-tight transition-all active:scale-[0.99] flex items-center justify-center gap-2 cursor-pointer shadow-sm"
        >
          <Download className="w-3.5 h-3.5" />
          <span>{mediaType === 'video' ? 'Export Cleaned Video (MP4)' : 'Export Cleaned Image'}</span>
        </button>
      </div>

      {/* Diagnostics HUD */}
      {result && (
        <div className="rounded-lg bg-zinc-50 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06] p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">WATERMARK</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-zinc-950 dark:text-white text-xs font-medium">
                {formatVersionLabel(result.detectedVersion, result.size)}
              </span>
              {settings.logoVersion === 'auto' && (
                <span className="text-[9px] font-mono uppercase px-1 py-0.2 rounded bg-zinc-200 dark:bg-white/[0.08] text-zinc-800 dark:text-zinc-300 border border-zinc-300 dark:border-white/[0.08]">
                  Auto
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">CONFIDENCE</span>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1 bg-zinc-200 dark:bg-white/[0.08] rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-900 dark:bg-white rounded-full transition-all duration-200"
                  style={{ width: `${Math.round(result.confidence * 100)}%` }}
                />
              </div>
              <span className="font-mono text-zinc-950 dark:text-white text-xs font-medium">
                {Math.round(result.confidence * 100)}%
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">POSITION</span>
            <span className="font-mono text-zinc-700 dark:text-zinc-300 text-xs">
              {result.position.x}, {result.position.y} ({result.size}×{result.size})
            </span>
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">METHOD</span>
            <span className="font-mono text-zinc-700 dark:text-zinc-300 text-xs capitalize truncate max-w-[170px]">
              {result.method} {result.drifted ? '· Drift Compensated' : ''}
            </span>
          </div>

          <div className="flex items-center justify-between text-[11px] pt-1.5 border-t border-zinc-200/80 dark:border-white/[0.04]">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block animate-pulse" />
              <span className="text-zinc-500 font-mono">SYNTHID</span>
            </div>
            <span
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-200/60 dark:border-blue-500/20"
              title="Visible 4-point overlay mathematically inverted. Imperceptible frequency-domain latent steganography remains intact."
            >
              Overlay Clean · Latent Intact
            </span>
          </div>
        </div>
      )}

      {/* Quadrant / Corner Selector */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-700 dark:text-zinc-400 font-medium flex items-center gap-1">
            <Compass className="w-3 h-3 text-zinc-500" />
            <span>Search Quadrant</span>
          </span>
          {result?.detectedCorner && settings.corner === 'auto' && (
            <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
              Found: {result.detectedCorner === 'bottom-right' ? '↘ BR' : result.detectedCorner === 'bottom-left' ? '↙ BL' : result.detectedCorner === 'top-right' ? '↗ TR' : '↖ TL'}
            </span>
          )}
        </div>
        <div className="grid grid-cols-5 gap-1 p-0.5 rounded-lg bg-zinc-100 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06]">
          {[
            { id: 'auto', label: 'Auto' },
            { id: 'bottom-right', label: '↘ BR' },
            { id: 'bottom-left', label: '↙ BL' },
            { id: 'top-right', label: '↗ TR' },
            { id: 'top-left', label: '↖ TL' },
          ].map((c) => {
            const isActive = (settings.corner || 'auto') === c.id;
            return (
              <button
                key={c.id}
                onClick={() => onUpdateSettings({ corner: c.id as WatermarkCorner })}
                title={c.id === 'auto' ? 'Auto 4-Corner Search' : c.label}
                className={`py-1.5 px-0.5 rounded-md text-[11px] font-mono text-center transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
                    : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Watermark Version Selector */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-700 dark:text-zinc-400 font-medium">Watermark Template</span>
          {result?.detectedVersion && settings.logoVersion === 'auto' && (
            <span className="text-[10px] font-mono text-zinc-500">
              Matched: {result.detectedVersion}
            </span>
          )}
        </div>
        <div className="grid grid-cols-4 gap-1 p-0.5 rounded-lg bg-zinc-100 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06]">
          {(['auto', 'old', 'new', 'white'] as LogoVersion[]).map((v) => {
            const isActive = settings.logoVersion === v;
            return (
              <button
                key={v}
                onClick={() => onUpdateSettings({ logoVersion: v })}
                className={`py-1.5 px-1 rounded-md text-[11px] font-mono text-center transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
                    : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                {v === 'auto' ? 'Auto' : v === 'old' ? 'Classic' : v === 'new' ? 'Sparkle' : 'White'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Spatial Position Nudge */}
      <div className="flex flex-col gap-2 pt-2 border-t border-zinc-200 dark:border-white/[0.06]">
        <div className="flex items-center justify-between text-[11px]">
          <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-400">
            <Crosshair className="w-3.5 h-3.5 text-zinc-500" />
            <span className="font-medium">Position Alignment</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-500">1px Micro-Step</span>
        </div>
        <div className="flex items-center justify-center gap-1 bg-zinc-50 dark:bg-[#0c0d10] p-1.5 rounded-lg border border-zinc-200 dark:border-white/[0.06]">
          <button
            onClick={() => onNudge(-1, 0)}
            title="Nudge Left 1px"
            className="p-1.5 rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white transition active:scale-95 cursor-pointer border border-zinc-200 dark:border-transparent"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => onNudge(0, -1)}
              title="Nudge Up 1px"
              className="p-1.5 rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white transition active:scale-95 cursor-pointer border border-zinc-200 dark:border-transparent"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onNudge(0, 1)}
              title="Nudge Down 1px"
              className="p-1.5 rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white transition active:scale-95 cursor-pointer border border-zinc-200 dark:border-transparent"
            >
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            onClick={() => onNudge(1, 0)}
            title="Nudge Right 1px"
            className="p-1.5 rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white transition active:scale-95 cursor-pointer border border-zinc-200 dark:border-transparent"
          >
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Advanced Inpainting Parameters Accordion */}
      <div className="pt-2 border-t border-zinc-200 dark:border-white/[0.06]">
        <button
          onClick={() => setShowAdvanced((prev) => !prev)}
          className="w-full flex items-center justify-between text-[11px] font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Sliders className="w-3 h-3 text-zinc-500" />
            <span>Mathematical Parameters</span>
          </span>
          <span className="font-mono text-[10px] text-zinc-500">{showAdvanced ? 'Hide' : 'Configure'}</span>
        </button>

        {showAdvanced && (
          <div className="mt-3 flex flex-col gap-3 text-xs pt-1">
            {/* Mask Scale Slider */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-zinc-600 dark:text-zinc-400">Mask Scale Multiplier</span>
                <span className="font-mono text-zinc-950 dark:text-zinc-200">{localMaskScale.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.05"
                value={localMaskScale}
                onChange={(e) => handleMaskScaleChange(parseFloat(e.target.value))}
                style={{
                  '--slider-pct': `${Math.max(0, Math.min(100, ((localMaskScale - 0.5) / 1.5) * 100))}%`,
                } as React.CSSProperties}
                className="w-full custom-range-slider"
              />
            </div>

            {/* Core Inpainting Radius */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-zinc-600 dark:text-zinc-400">Core Diffusion Radius</span>
                <span className="font-mono text-zinc-950 dark:text-zinc-200">{localFillRadius} px</span>
              </div>
              <input
                type="range"
                min="0"
                max="5"
                step="1"
                value={localFillRadius}
                onChange={(e) => handleFillRadiusChange(parseInt(e.target.value, 10))}
                style={{
                  '--slider-pct': `${Math.max(0, Math.min(100, (localFillRadius / 5) * 100))}%`,
                } as React.CSSProperties}
                className="w-full custom-range-slider"
              />
              <span className="text-[10px] text-zinc-500">
                Diffuses saturated white centers where original alpha exceeds 98%.
              </span>
            </div>

            {/* Reset Defaults */}
            <button
              onClick={onResetSettings}
              className="mt-1 w-full py-1.5 px-2.5 rounded-md border border-zinc-200 dark:border-white/[0.08] bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-zinc-700 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200 text-[11px] font-mono flex items-center justify-center gap-1.5 transition cursor-pointer"
            >
              <RotateCcw className="w-3 h-3 text-zinc-500" />
              <span>Reset Parameters</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
