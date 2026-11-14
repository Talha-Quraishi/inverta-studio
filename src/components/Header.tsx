import React from 'react';
import { ShieldCheck, Trash2, Sun, Moon, Star } from 'lucide-react';

interface HeaderProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  hasItems?: boolean;
  onClearAll?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  theme,
  onToggleTheme,
  hasItems = false,
  onClearAll,
}) => {
  return (
    <header className="border-b border-zinc-200 dark:border-white/[0.08] bg-white/95 dark:bg-[#0e1013]/95 backdrop-blur-md sticky top-0 z-40 transition-colors">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        {/* Brand identity */}
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="w-8 h-8 rounded-lg bg-zinc-900 dark:bg-white/[0.06] border border-zinc-700 dark:border-white/[0.12] flex items-center justify-center text-white"
          >
            <svg
              className="w-4 h-4 text-white"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M7 17L17 7" />
              <path d="M13 17h4v-4" />
            </svg>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-zinc-950 dark:text-white tracking-tight text-[15px]">Inverta</span>
            <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400">Studio</span>
            <span
              title={`Version ${__APP_VERSION__} · commit ${__APP_COMMIT__} · built ${__APP_BUILT__}`}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-white/[0.06] text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-white/[0.08]"
            >
              v{__APP_VERSION__}
              <span className="hidden sm:inline text-zinc-400 dark:text-zinc-500"> · {__APP_COMMIT__}</span>
            </span>
          </div>
        </div>

        {/* Center engine telemetry */}
        <div className="hidden md:flex items-center gap-3 text-[11px] font-mono text-zinc-600 dark:text-zinc-400">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-100 dark:bg-white/[0.03] border border-zinc-200 dark:border-white/[0.06]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
            <span className="text-zinc-800 dark:text-zinc-300">Hardware Accelerated</span>
          </div>
          <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
            <ShieldCheck className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
            <span>Zero Network Uploads</span>
          </div>
        </div>

        {/* Right utility controls */}
        <div className="flex items-center gap-2 text-xs">
          {/* GitHub Star Link */}
          <a
            href="https://github.com/Talha-Quraishi/inverta-studio"
            target="_blank"
            rel="noopener noreferrer"
            title="Star Inverta Studio on GitHub"
            aria-label="Star Inverta Studio on GitHub"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-100 hover:bg-amber-50 dark:bg-white/[0.04] dark:hover:bg-amber-500/10 text-zinc-700 hover:text-amber-700 dark:text-zinc-300 dark:hover:text-amber-300 border border-zinc-200 hover:border-amber-300 dark:border-white/[0.06] dark:hover:border-amber-500/30 transition text-[11px] font-mono cursor-pointer"
          >
            <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" aria-hidden="true" />
            <span className="font-medium hidden sm:inline">Star on GitHub</span>
          </a>

          {/* Theme Mode Toggle */}
          <button
            type="button"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            className="flex items-center justify-center w-8 h-8 rounded-md bg-zinc-100 hover:bg-zinc-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white border border-zinc-200 dark:border-white/[0.06] transition cursor-pointer"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? (
              <Sun className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
            ) : (
              <Moon className="w-3.5 h-3.5 text-zinc-700" aria-hidden="true" />
            )}
          </button>

          {hasItems && onClearAll && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Remove all files from this session? This cannot be undone.')) {
                  onClearAll();
                }
              }}
              title="Clear all workspace items"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-zinc-100 hover:bg-red-50 text-zinc-600 hover:text-red-600 dark:bg-white/[0.04] dark:hover:bg-red-500/10 dark:text-zinc-400 dark:hover:text-red-400 border border-zinc-200 hover:border-red-200 dark:border-white/[0.06] dark:hover:border-red-500/20 transition text-[11px] font-mono cursor-pointer"
            >
              <Trash2 className="w-3 h-3" aria-hidden="true" />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
