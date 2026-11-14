import React, { useRef, useState, useEffect } from 'react';
import { Plus, UploadCloud } from 'lucide-react';
import { isSupportedMediaFile } from '../utils/media';

interface DropZoneProps {
  onFilesSelected: (files: File[]) => void;
  isCompact?: boolean;
  disabled?: boolean;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  // Range/checkbox/button inputs do not accept typed text. Pasting an image
  // while one of them is focused should still import the clipboard file.
  const type = (target as HTMLInputElement).type;
  return ![
    'range',
    'checkbox',
    'radio',
    'button',
    'submit',
    'reset',
    'color',
    'file',
    'image',
    'hidden',
  ].includes(type);
}

export const DropZone: React.FC<DropZoneProps> = ({
  onFilesSelected,
  isCompact = false,
  disabled = false,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Global paste handler (Ctrl+V / Cmd+V)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (disabled) return;
      if (isTextEntryTarget(e.target)) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      const matchedFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind !== 'file') continue;
        const file = items[i].getAsFile();
        if (file && isSupportedMediaFile(file)) matchedFiles.push(file);
      }

      if (matchedFiles.length > 0) {
        onFilesSelected(matchedFiles);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [onFilesSelected, disabled]);

  const openBrowser = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openBrowser();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files).filter(isSupportedMediaFile);
      if (files.length > 0) onFilesSelected(files);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files).filter(isSupportedMediaFile);
      if (files.length > 0) onFilesSelected(files);
      e.target.value = '';
    }
  };

  const input = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      disabled={disabled}
      accept="image/png,image/jpeg,image/webp,image/bmp,video/mp4"
      aria-label="Select image or MP4 video files"
      className="hidden"
      onChange={handleFileInputChange}
    />
  );

  const interactionProps = {
    onClick: openBrowser,
    onKeyDown: handleKeyDown,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
    role: 'button' as const,
    tabIndex: disabled ? -1 : 0,
    'aria-disabled': disabled,
    'aria-label': 'Add media files: drop files here, browse, or paste from the clipboard',
  };

  if (isCompact) {
    return (
      <div
        {...interactionProps}
        className={`rounded-lg border px-3 py-2 flex items-center justify-center gap-2 transition text-xs font-mono select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#111316] ${
          disabled
            ? 'border-zinc-200 bg-zinc-50 text-zinc-400 cursor-not-allowed opacity-60 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-zinc-600'
            : isDragOver
            ? 'border-zinc-950 bg-zinc-100 text-zinc-950 dark:border-white dark:bg-white/10 dark:text-white cursor-pointer'
            : 'border-zinc-200 hover:border-zinc-300 bg-white hover:bg-zinc-50 text-zinc-700 hover:text-zinc-950 dark:border-white/[0.1] dark:bg-white/[0.03] dark:hover:bg-white/[0.06] dark:text-zinc-300 dark:hover:text-white shadow-xs cursor-pointer'
        }`}
      >
        {input}
        <Plus className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
        <span>{disabled ? 'Processing in progress…' : 'Add Media (or Ctrl+V)'}</span>
      </div>
    );
  }

  return (
    <div
      {...interactionProps}
      className={`relative w-full max-w-2xl mx-auto rounded-xl border transition-all duration-150 p-8 sm:p-12 text-center select-none shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#0b0c0e] ${
        disabled
          ? 'border-zinc-200 bg-zinc-50/70 cursor-not-allowed opacity-60 dark:border-white/[0.06] dark:bg-[#101215]/60'
          : isDragOver
          ? 'border-zinc-900 bg-zinc-50 dark:border-white dark:bg-white/[0.04] cursor-pointer'
          : 'border-zinc-200/90 hover:border-zinc-400/80 bg-white hover:bg-zinc-50/70 dark:border-white/[0.1] dark:bg-[#101215]/80 dark:hover:border-white/[0.2] dark:hover:bg-[#131519] cursor-pointer'
      }`}
    >
      {input}

      {/* Architectural corner crosshair glyphs */}
      <div className="absolute top-2.5 left-2.5 text-zinc-400 dark:text-zinc-600 font-mono text-[10px] select-none">+</div>
      <div className="absolute top-2.5 right-2.5 text-zinc-400 dark:text-zinc-600 font-mono text-[10px] select-none">+</div>
      <div className="absolute bottom-2.5 left-2.5 text-zinc-400 dark:text-zinc-600 font-mono text-[10px] select-none">+</div>
      <div className="absolute bottom-2.5 right-2.5 text-zinc-400 dark:text-zinc-600 font-mono text-[10px] select-none">+</div>

      {/* Center drop icon */}
      <div className="w-12 h-12 mx-auto mb-4 rounded-lg bg-zinc-100 border border-zinc-200 dark:bg-white/[0.04] dark:border-white/[0.08] flex items-center justify-center text-zinc-700 dark:text-zinc-300">
        <UploadCloud className="w-5 h-5 text-zinc-700 dark:text-zinc-300" />
      </div>

      <div className="flex flex-col gap-1 mb-4">
        <p className="text-sm font-semibold text-zinc-950 dark:text-white tracking-tight">
          {disabled ? (
            'Please wait for the current job to finish'
          ) : (
            <>
              Drop image or MP4 video here, or{' '}
              <span className="underline underline-offset-4 decoration-zinc-400 dark:decoration-zinc-500">browse</span>
            </>
          )}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Supports PNG, WebP, JPEG images & H.264 MP4 videos
        </p>
      </div>

      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-zinc-100 border border-zinc-200 text-[11px] font-mono text-zinc-600 dark:bg-white/[0.03] dark:border-white/[0.06] dark:text-zinc-400">
        <span>Clipboard ready: Press</span>
        <kbd className="px-1.5 py-0.5 rounded bg-white text-zinc-900 border border-zinc-300 dark:bg-white/[0.08] dark:text-white dark:border-white/[0.1] text-[10px] shadow-xs">
          Ctrl+V
        </kbd>
        <span>or</span>
        <kbd className="px-1.5 py-0.5 rounded bg-white text-zinc-900 border border-zinc-300 dark:bg-white/[0.08] dark:text-white dark:border-white/[0.1] text-[10px] shadow-xs">
          ⌘V
        </kbd>
      </div>
    </div>
  );
};
