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
  StopCircle,
} from 'lucide-react';
import type { LogoVersion, RemovalResult, WatermarkCorner, WatermarkSettings } from '../engine/types';

interface ControlsPanelProps {
  settings: WatermarkSettings;
  result?: RemovalResult;
  warning?: string;
  onUpdateSettings: (newSettings: Partial<WatermarkSettings>) => void;
  onResetSettings: () => void;
  onDownload: () => void;
  onNudge: (dx: number, dy: number) => void;
  onCancel?: () => void;
  isProcessing: boolean;
  fileName: string;
  mediaType?: 'image' | 'video';
  hasOutput?: boolean;
}

export const ControlsPanel: React.FC<ControlsPanelProps> = ({
  settings,
  result,
  warning,
  onUpdateSettings,
  onResetSettings,
  onDownload,
  onNudge,
  onCancel,
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
  // Separate timers: a shared timer would drop a pending mask-scale update as
  // soon as the user adjusted the fill radius (and vice versa).
  const maskTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (maskTimer.current) clearTimeout(maskTimer.current);
      if (fillTimer.current) clearTimeout(fillTimer.current);
    };
  }, []);

  const handleMaskScaleChange = (val: number) => {
    setLocalMaskScale(val);
    if (maskTimer.current) clearTimeout(maskTimer.current);
    maskTimer.current = setTimeout(() => {
      onUpdateSettings({ maskScale: val });
    }, 120);
  };

  const handleFillRadiusChange = (val: number) => {
    setLocalFillRadius(val);
    if (fillTimer.current) clearTimeout(fillTimer.current);
    fillTimer.current = setTimeout(() => {
      onUpdateSettings({
        fillRadius: val,
        fillMode: val > 0 ? 'on' : 'off',
      });
    }, 120);
  };

  const handleResetDefaults = () => {
    // Cancel pending debounced updates so a stale slider value cannot be
    // applied after the reset.
    if (maskTimer.current) clearTimeout(maskTimer.current);
    if (fillTimer.current) clearTimeout(fillTimer.current);
    onResetSettings();
  };

  const canDownload = hasOutput;
  const hasDetection = result?.success === true;
  const exportLabel = !hasDetection
    ? mediaType === 'video'
      ? 'Export Original Video (MP4)'
      : 'Export Original Image'
    : mediaType === 'video'
      ? 'Export Cleaned Video (MP4)'
      : 'Export Cleaned Image';

  const formatVersionLabel = (v?: 'sparkle' | 'classic' | 'new' | 'white' | 'old', size?: number) => {
    const sizeStr = size ? ` (${size}px)` : '';
    if (v === 'sparkle' || (v === 'old' && size !== 84)) return `Gemini Sparkle${sizeStr}`;
    if (v === 'classic' || (v === 'old' && size === 84)) return `Classic Dual-Star${sizeStr}`;
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
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDownload}
          disabled={!canDownload || isProcessing}
          className="flex-1 py-2.5 px-3 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-zinc-950 disabled:bg-zinc-200 disabled:text-zinc-400 dark:disabled:bg-white/[0.05] dark:disabled:text-zinc-600 disabled:cursor-not-allowed font-semibold text-xs tracking-tight transition-all active:scale-[0.99] flex items-center justify-center gap-2 cursor-pointer shadow-sm"
        >
          <Download className="w-3.5 h-3.5" />
          <span>{exportLabel}</span>
        </button>
        {isProcessing && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            title="Cancel processing"
            aria-label="Cancel processing"
            className="p-2.5 rounded-lg border border-zinc-200 dark:border-white/10 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-white/5 transition cursor-pointer"
          >
            <StopCircle className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {warning && (
        <div
          role="status"
          className="rounded-lg border border-amber-300/80 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
        >
          {warning}
        </div>
      )}

      {/* Diagnostics HUD */}
      {result && (
        <div className="rounded-lg bg-zinc-50 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06] p-3 flex flex-col gap-2.5">
          {!hasDetection && (
            <div
              role="status"
              className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-800 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-300"
            >
              {result.message} Source pixels were preserved; use Position Alignment to force a
              region if needed.
            </div>
          )}

          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">{hasDetection ? 'WATERMARK' : 'DETECTION'}</span>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-zinc-950 dark:text-white text-xs font-medium">
                {hasDetection ? formatVersionLabel(result.detectedVersion, result.size) : 'None'}
              </span>
              {hasDetection && settings.logoVersion === 'auto' && (
                <span className="text-[9px] font-mono uppercase px-1 py-0.2 rounded bg-zinc-200 dark:bg-white/[0.08] text-zinc-800 dark:text-zinc-300 border border-zinc-300 dark:border-white/[0.08]">
                  Auto
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">{hasDetection ? 'CONFIDENCE' : 'BEST NCC'}</span>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1 bg-zinc-200 dark:bg-white/[0.08] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-200 ${hasDetection ? 'bg-zinc-900 dark:bg-white' : 'bg-amber-500'}`}
                  style={{ width: `${Math.round(result.confidence * 100)}%` }}
                />
              </div>
              <span className="font-mono text-zinc-950 dark:text-white text-xs font-medium">
                {Math.round(result.confidence * 100)}%
              </span>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="text-zinc-500 font-mono">{hasDetection ? 'POSITION' : 'BEST CANDIDATE'}</span>
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
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${hasDetection ? 'bg-blue-500 animate-pulse' : 'bg-zinc-400 dark:bg-zinc-500'}`} />
              <span className="text-zinc-500 font-mono">{hasDetection ? 'SYNTHID' : 'PIXELS'}</span>
            </div>
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                hasDetection
                  ? 'bg-blue-50 dark:bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-200/60 dark:border-blue-500/20'
                  : 'bg-zinc-100 dark:bg-white/[0.04] text-zinc-600 dark:text-zinc-400 border-zinc-200 dark:border-white/[0.06]'
              }`}
              title={
                hasDetection
                  ? 'Visible 4-point overlay mathematically inverted. Imperceptible frequency-domain latent steganography remains intact.'
                  : 'No watermark was found, so the output is a preserve of the source pixels.'
              }
            >
              {hasDetection ? 'Overlay Clean · Latent Intact' : 'Source Preserved · No Edits'}
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
        <div
          role="group"
          aria-label="Watermark search quadrant"
          className="grid grid-cols-5 gap-1 p-0.5 rounded-lg bg-zinc-100 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06]"
        >
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
                type="button"
                aria-pressed={isActive}
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
          {hasDetection && result.detectedVersion && settings.logoVersion === 'auto' && (
            <span className="text-[10px] font-mono text-zinc-500">
              Matched: {
                result.detectedVersion === 'classic' || (result.detectedVersion === 'old' && result.size === 84)
                  ? 'classic'
                  : result.detectedVersion === 'new'
                    ? '2026'
                    : result.detectedVersion === 'white'
                      ? 'white'
                      : 'sparkle'
              }
            </span>
          )}
        </div>
        <div
          role="group"
          aria-label="Watermark template version"
          className="grid grid-cols-4 gap-1 p-0.5 rounded-lg bg-zinc-100 dark:bg-[#0c0d10] border border-zinc-200 dark:border-white/[0.06]"
        >
          {(
            [
              { id: 'auto', label: 'Auto' },
              { id: 'sparkle', label: 'Sparkle' },
              { id: 'classic', label: 'Classic' },
              { id: 'white', label: 'White' },
            ] as const
          ).map(({ id, label }) => {
            const isActive =
              settings.logoVersion === id ||
              (id === 'sparkle' && (settings.logoVersion === 'new' || settings.logoVersion === 'old'));
            return (
              <button
                key={id}
                type="button"
                aria-pressed={isActive}
                onClick={() => onUpdateSettings({ logoVersion: id as LogoVersion })}
                className={`py-1.5 px-1 rounded-md text-[11px] font-mono text-center transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-white text-zinc-950 font-semibold shadow-xs border border-zinc-300 dark:bg-white/[0.12] dark:text-white dark:border-white/[0.12]'
                    : 'text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                {label}
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
          {(() => {
            const nudgeDisabled = !result || isProcessing;
            const nudgeClass =
              'p-1.5 rounded bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white transition active:scale-95 cursor-pointer border border-zinc-200 dark:border-transparent disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-zinc-100 dark:disabled:hover:bg-white/[0.04]';
            return (
              <>
                <button
                  type="button"
                  onClick={() => onNudge(-1, 0)}
                  disabled={nudgeDisabled}
                  aria-label="Nudge watermark left by 1 pixel"
                  title="Nudge Left 1px"
                  className={nudgeClass}
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => onNudge(0, -1)}
                    disabled={nudgeDisabled}
                    aria-label="Nudge watermark up by 1 pixel"
                    title="Nudge Up 1px"
                    className={nudgeClass}
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onNudge(0, 1)}
                    disabled={nudgeDisabled}
                    aria-label="Nudge watermark down by 1 pixel"
                    title="Nudge Down 1px"
                    className={nudgeClass}
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onNudge(1, 0)}
                  disabled={nudgeDisabled}
                  aria-label="Nudge watermark right by 1 pixel"
                  title="Nudge Right 1px"
                  className={nudgeClass}
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </>
            );
          })()}
        </div>
      </div>

      {/* Advanced Inpainting Parameters Accordion */}
      <div className="pt-2 border-t border-zinc-200 dark:border-white/[0.06]">
        <button
          type="button"
          onClick={() => setShowAdvanced((prev) => !prev)}
          aria-expanded={showAdvanced}
          aria-controls="advanced-parameters"
          className="w-full flex items-center justify-between text-[11px] font-medium text-zinc-600 hover:text-zinc-950 dark:text-zinc-400 dark:hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Sliders className="w-3 h-3 text-zinc-500" />
            <span>Mathematical Parameters</span>
          </span>
          <span className="font-mono text-[10px] text-zinc-500">{showAdvanced ? 'Hide' : 'Configure'}</span>
        </button>

        {showAdvanced && (
          <div id="advanced-parameters" className="mt-3 flex flex-col gap-3 text-xs pt-1">
            {/* Mask Scale Slider */}
            <div className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-[11px]">
                <label htmlFor="mask-scale" className="text-zinc-600 dark:text-zinc-400">Mask Scale Multiplier</label>
                <span className="font-mono text-zinc-950 dark:text-zinc-200">{localMaskScale.toFixed(2)}×</span>
              </div>
              <input
                id="mask-scale"
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
                <label htmlFor="fill-radius" className="text-zinc-600 dark:text-zinc-400">Core Diffusion Radius</label>
                <span className="font-mono text-zinc-950 dark:text-zinc-200">{localFillRadius} px</span>
              </div>
              <input
                id="fill-radius"
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
              type="button"
              onClick={handleResetDefaults}
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
