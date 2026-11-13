import React from 'react';
import { Check, Loader2, AlertCircle, X, Download } from 'lucide-react';
import type { ProcessedItem } from '../engine/types';

interface BatchQueueProps {
  items: ProcessedItem[];
  activeId: string;
  onSelectItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
  onDownloadAll: () => void;
}

interface ThumbProps {
  item: ProcessedItem;
  isActive: boolean;
  onSelectItem: (id: string) => void;
  onRemoveItem: (id: string) => void;
}

// Memoized so a progress tick on one video doesn't re-render (and reload) every other thumbnail.
const Thumb = React.memo(function Thumb({ item, isActive, onSelectItem, onRemoveItem }: ThumbProps) {
  return (
    <div
      onClick={() => onSelectItem(item.id)}
      className={`group relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden cursor-pointer border transition-all ${
        isActive
          ? 'border-zinc-950 ring-2 ring-zinc-950/20 dark:border-white dark:ring-1 dark:ring-white/50'
          : 'border-zinc-200 hover:border-zinc-400 dark:border-white/[0.08] dark:hover:border-white/[0.2] opacity-75 hover:opacity-100'
      }`}
    >
      {item.mediaType === 'video' ? (
        <video
          src={item.processedUrl || item.originalUrl}
          muted
          playsInline
          preload="metadata"
          className="w-full h-full object-cover pointer-events-none"
        />
      ) : (
        <img
          src={item.processedUrl || item.originalUrl}
          alt={item.name}
          className="w-full h-full object-cover"
        />
      )}

      {/* Media type tag */}
      <div className="absolute top-1 left-1 pointer-events-none">
        <span className="px-1 py-0.2 rounded bg-black/80 text-[9px] font-mono uppercase text-white border border-white/[0.1]">
          {item.mediaType === 'video' ? 'MP4' : 'IMG'}
        </span>
      </div>

      {/* Status Badge */}
      <div className="absolute top-1 right-1 pointer-events-none">
        {item.status === 'processing' && (
          <div className="p-0.5 rounded-full bg-black/80">
            <Loader2 className="w-3 h-3 text-white animate-spin" />
          </div>
        )}
        {item.status === 'done' && (
          <div className="p-0.5 rounded-full bg-black/80">
            <Check className="w-3 h-3 text-emerald-400" />
          </div>
        )}
        {item.status === 'error' && (
          <div className="p-0.5 rounded-full bg-black/80">
            <AlertCircle className="w-3 h-3 text-red-400" />
          </div>
        )}
      </div>

      {/* Delete Button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemoveItem(item.id);
        }}
        title="Remove item"
        aria-label={`Remove ${item.name}`}
        className="absolute top-1 right-1 p-0.5 rounded bg-black/90 text-zinc-300 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-10"
      >
        <X className="w-3 h-3" />
      </button>

      {/* File name footer */}
      <div className="absolute bottom-0 inset-x-0 bg-black/75 px-1 py-0.5 text-[9px] font-mono text-zinc-200 truncate pointer-events-none">
        {item.name}
      </div>
    </div>
  );
});

const BatchQueueImpl: React.FC<BatchQueueProps> = ({
  items,
  activeId,
  onSelectItem,
  onRemoveItem,
  onDownloadAll,
}) => {
  if (items.length === 0) return null;

  const doneCount = items.filter((i) => i.status === 'done').length;

  return (
    <div className="bg-white dark:bg-[#111316] border border-zinc-200 dark:border-white/[0.08] rounded-xl p-3 flex flex-col gap-2.5 select-none shadow-sm transition-colors">
      <div className="flex items-center justify-between text-xs border-b border-zinc-200 dark:border-white/[0.06] pb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-950 dark:text-white tracking-tight uppercase text-xs">Asset Reel</span>
          <span className="text-[11px] px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-white/[0.04] text-zinc-600 dark:text-zinc-400 font-mono border border-zinc-200 dark:border-white/[0.06]">
            {doneCount} of {items.length} Ready
          </span>
        </div>

        {doneCount > 1 && (
          <button
            onClick={onDownloadAll}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-950 hover:bg-zinc-800 text-white dark:bg-white dark:hover:bg-zinc-200 dark:text-zinc-950 text-[11px] font-mono font-medium transition cursor-pointer shadow-xs"
          >
            <Download className="w-3 h-3" />
            <span>Export All ({doneCount})</span>
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
        {items.map((item) => (
          <Thumb
            key={item.id}
            item={item}
            isActive={item.id === activeId}
            onSelectItem={onSelectItem}
            onRemoveItem={onRemoveItem}
          />
        ))}
      </div>
    </div>
  );
};

export const BatchQueue = React.memo(BatchQueueImpl);
