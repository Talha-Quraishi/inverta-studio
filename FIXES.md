# Audit Fixes — Inverta Studio v2.5.0

All issues from the code audit have been fixed. This document lists every fix,
the file(s) involved, and how each was verified. All changes are currently
uncommitted in the working tree.

---

## Critical

### Mask corruption & detection robustness
- **Files:** `src/engine/maskGeometry.ts` (new), `src/engine/alphaMasks.ts`, `src/engine/types.ts`, `src/engine/watermarkEngine.ts`
- Exact detected mask is now reused by `removeWatermark()`, so `maskScale` is applied exactly once (previously double-scaled → misaligned cleaning).
- Square-size validation, safe mask rescaling, and bounds guards prevent out-of-frame indexing.
- Zero-pixel / empty-candidate candidates are rejected instead of producing garbage scores.
- NCC moment computations are cached per mask (less per-frame CPU).
- **Corner priority & margin hierarchy restored:** Primary corner (`bottom-right`) now halts corner scanning immediately once correlation meets `nccAccept`, preventing false-positive corner drift (e.g. high-contrast top-right ornamental flowers or patterns overwriting a valid 0.54 bottom-right watermark). Standard Gemini margins (`32, 64, 48...`) are checked symmetrically before exotic/letterbox margins and ratio margins.
- Template candidates are sorted by proximity to expected physical size (`isLarge ? 96 : 48`), ensuring true watermark sizes are prioritized.

### Video memory & performance
- **Files:** `src/engine/videoWorker.ts` (new), `src/engine/videoProcessor.ts` (new), `src/engine/videoEngine.ts`
- WebCodecs video pipeline runs in a **module worker** with real cancellation; graceful main-thread fallback via `VideoWorkerUnavailableError`.
- Demuxed sample payloads are released after `EncodedVideoChunk` copies them (bounded memory).
- Decode/encode queues back-pressure-limited; detection sampled; processing deadline enforced; 6-frame decoder buffer instead of unbounded.

### Video behavior & job lifecycle
- **File:** `src/App.tsx`
- Per-item `Map<string, AbortController>` for video jobs; removing an item or starting a reprocess aborts its worker and terminates it.
- `commitProcessed` leak guard: results for items deleted mid-processing have their blob URLs revoked.
- Generation counters per item cancel stale debounced reprocesses.
- Cancelling a reprocess keeps the previous result instead of blanking the item.
- Stale-job cleanup never revokes `item.originalUrl` (was breaking no-detection items whose `processedUrl` reuses it).

---

## High

### Image / batch correctness
- **Files:** `src/utils/media.ts` (new), `src/App.tsx`
- File validation, per-batch limits, size caps, safe download filenames, format-preserving encoding (PNG stays PNG, etc.).
- Images are re-decoded from the blob URL on reprocess — no stored raw pixel data (large memory win on batches).

### Honest no-detection handling
- **Files:** `src/App.tsx`, `src/components/BatchQueue.tsx`, `src/components/ComparisonSlider.tsx`, `src/components/ControlsPanel.tsx`
- Media with no detected watermark now reports `No watermark detected`, preserves the source pixels/bytes exactly, labels the export `Export Original Image`, and hides the bounding box / confidence chrome. No fake "cleaned" output.

### Unseekable source MP4s (stss defect)
- **Files:** `src/engine/videoEngine.ts`, `src/engine/types.ts`, `src/App.tsx`, `src/components/VideoPlayerComparison.tsx`
- Some generated MP4s (e.g. `sample_gemini_video.mp4`) ship an empty video `stss` sync table, so Chromium refuses every seek.
- `buildSeekablePlaybackBuffer()` detects the empty table, scans AVC NAL units for real IDR samples, patches a **copy** of the source bytes, and returns it as `playbackBlob`.
- The app exposes it as `item.playbackUrl`; the comparison player uses it for the original stage. Export bytes are never replaced — the cleaned/original export remains byte-faithful.
- Verified in Edge: seeking to 6.13s on the original stage now succeeds (previously `MEDIA_ELEMENT_ERROR` / dead seek).

---

## Medium

### Video visual quality
- **File:** `src/engine/videoEngine.ts`
- **Color-mask rim softening:** the 84px classic-star mask's antialiased rim was inverted at full strength on codec-softened footage, carving a dark star outline. A cached separable 3×3 binomial blur of the mask alpha (cleaning only — detection still uses the raw mask) reduces it.
- **Adaptive rim correction (root fix):** per-frame local background estimate (`buildLocalBackgroundEstimate`) from the nearest non-watermark pixels around each mask position; each rim pixel cleans with `min(template alpha, observed alpha)` where observed alpha is derived from the frame (`a = (P − bg) / (255 − bg)`, median of channels). A rim pixel can therefore never be driven darker than its local background — the black outline is eliminated. Deep-interior pixels keep the closed-form inversion (texture preserved).
- Verified on the Gemini sample at 6.13s: dark-rim residual p25 −7.7 → −1.9, p10 −17.0 → −11.6, worst pixel −75 → −48; only the watermark's own soft drop shadow (outside the mask) remains, which no mask-based method should blur away.
- **AAC audio preservation** guards: every sample is validated before the first is added, so a malformed sample can't truncate the audio track midway.
- **Rotation handling** and no duplicate mask candidates during detection.
- **B-frame muxing crash (fixed):** hardware H.264 encoders can emit B-frames, whose decode order walks presentation timestamps backwards (e.g. DTS 83334µs → 41667µs at 24fps), which mp4-muxer rejects with `Timestamps must be monotonically increasing` and failed the whole job. The encoder output callback now assigns the decode timestamp from the decode order itself and passes the PTS−DTS delta as the composition offset, so the muxer writes a correct `ctts` table. For B-frame-free encoders every offset is 0 and muxing is byte-for-byte the previous behavior.

### Accessibility & components
- **Files:** `src/components/ControlsPanel.tsx`, `ComparisonSlider.tsx`, `VideoPlayerComparison.tsx`, `DropZone.tsx`, `BatchQueue.tsx`, `Header.tsx`
- Keyboard operability, ARIA labels/roles, slider/loupe/pan interactions, synchronized dual-video playback with drift compensation and mode-switch position restoration, responsive control layout.

---

## Low / Polish

### Deployment & assets
- **Files:** `index.html`, `vite.config.ts`, `public/404.html`, `public/robots.txt`, `public/sitemap.xml`, `public/og-preview.png`, `src/index.css`, `public/fonts/`
- Google Fonts removed; Inter + JetBrains Mono **self-hosted** (CSP-friendly, no third-party requests).
- Production-only **hashed CSP** injected for the inline JSON-LD script; `worker-src 'self'` allowed.
- Canonical URL, OG image (1200×630), Twitter cards, robots + sitemap all use absolute production URLs via build-time token substitution.
- Deprecated `apple-mobile-web-app-capable` replaced with the standard `mobile-web-app-capable` (console warning eliminated).
- Unused assets removed (`hero.png`, `react.svg`, `vite.svg`, `icons.svg`).

### Tooling & CI
- **Files:** `package.json`, `tsconfig*.json`, `.oxlintrc.json`, `.github/workflows/deploy.yml`, `tests/`, `tsconfig.test.json`
- `strict` TypeScript enabled across app configs.
- Stronger oxlint ruleset.
- 15 Node built-in test-runner tests (browser-free helpers) covering file validation, MIME normalization, filename sanitization, download naming.
- CI workflow runs typecheck + lint + tests + build before deploy.
- Version bumped to 2.5.0 with Node engines + metadata; README updated.

---

## Verification Matrix

| Check | Result |
| --- | --- |
| `npm run typecheck` | ✅ pass |
| `npm run lint` (oxlint) | ✅ pass |
| `npm test` | ✅ 19/19 |
| `npm run build` | ✅ built |
| `check-dist.cjs` (CSP hash, tokens, fonts, canonical/OG, worker-src, sitemap) | ✅ 12/12 |
| Image smoke (`watermark-test.png`) | ✅ 84px @ (932,932), 100% confidence, export works |
| Image Diwali test (`Gemini_Generated_Image_e9qbloe9qbloe9qb.png`) | ✅ 96px @ (2592,1376) bottom-right, 54.4% NCC, no top-right false positive |
| False-positive test (plain gradient/noise) | ✅ "No watermark detected", source preserved |
| Video smoke (`sample_gemini_video.mp4`) | ✅ ~22.5s, star 858,1698 @ 94%, all view modes, zero console errors |
| Video regression fix (`884748845_1794032309338142.mp4`) | ✅ 48px @ (576,1136), 90.9% confidence, seekable playback untouched |
| Video pixel verification @ 6.13s | ✅ original/cleaned crops compared; rim metrics improved; no media errors |
| Seek test (malformed stss source) | ✅ seeks in Edge; playback proxy used; export bytes untouched |
| MP4 track export check | ✅ video + copied AAC audio intact |

---

## Post-Audit Regression Fix: `884748845_1794032309338142.mp4`

- **Issue:** Video `884748845_1794032309338142.mp4` failed detection and playback was corrupted after initial audit fixes.
- **Root Causes Fixed:**
  1. **Corrupted `stss` FullBox rewriting:** `buildSeekablePlaybackBuffer` treated `stss.payload` as `entry_count` (which was actually `version + flags == 0`), mistakenly overwriting `version + flags` and `entry_count` on valid MP4s that already had sync samples (`entry_count == 1`).
     - **Fix:** Moved MP4 box utilities to [`src/engine/mp4Utils.ts`](file:///d:/Coding/Erasio/src/engine/mp4Utils.ts). Guarded with `entryCount !== 0` check so valid files are never rewritten. Ensured `count` is written at `stss.payload + 4` and sample numbers start at `stss.payload + 8`, preserving `version + flags` (0).
  2. **Premature detection buffer limit:** `BUFFER_LIMIT = 6` triggered detection after only 6 frames (~0.25s), causing false-negative aborts on dark or fading introductions.
     - **Fix:** Restored `BUFFER_LIMIT = 24` with early illumination triggering (`initialBuffer.length >= 12 && brLum > 30`).
  3. **Near-white background rim handling:** `observedAlphaForColorMask` returned `null` for bright/near-white backgrounds (`denom <= 8`), and `cleanFrame` mistakenly `continue`d, bypassing cleaning.
     - **Fix:** Pixel cleaning falls back to template `effAlpha` when `observed === null`, ensuring full cleaning without skipped pixels.
  4. **Sub-grid margin refinement:** Refinement radius expanded from 4 to 8 pixels (`dy in [-8, 8], dx in [-8, 8]`) for the primary candidate, ensuring accurate localization across all aspect ratios.
  5. **Display rotation:** Matrix typing expanded to `ArrayLike<number>` so `Int32Array` track matrices from MP4Box are correctly parsed.

## Post-Audit Regression Fix: Image Corner Drift (`Gemini_Generated_Image_e9qbloe9qbloe9qb.png`)

- **Issue:** On complex, textured images (e.g. Diwali rangoli image `2752×1536`), the watermark in the bottom-right corner (`96×96 at 2592, 1376`) was missed, and a false-positive flower ornament in the top-right corner (`72×72 at 2644, 54`) was detected and wiped instead.
- **Root Causes Fixed:**
  1. **Strict 0.8 correlation threshold on corner early-exit:** The margin search early-exit checks used `Math.max(s.nccAccept, 0.8)`. Real-world watermarks against textured or colorful backgrounds typically score 0.50–0.70 NCC. Because `0.54 < 0.8`, the engine refused to accept the bottom-right match and proceeded to scan secondary corners (`bottom-left`, `top-right`, `top-left`). In `top-right`, a high-contrast geometric mandala scored 0.71, overwriting the genuine bottom-right watermark.
     - **Fix:** Restored `if (bestCandidate && bestCandidate.ncc >= s.nccAccept) break;` for corner termination. When `s.corner === 'auto'`, once `bottom-right` meets `nccAccept` (0.30–0.35), secondary corners are never evaluated.
  2. **Margin hierarchy & symmetric separation:** `baseMargins` had letterbox offsets (`222, 186, 144...`) listed in descending order ahead of standard Gemini margins (`64, 32...`), and mixed non-symmetric ratio pairs directly into the search. Non-symmetric ratios like 1.33× on letterbox margins drifted up to 420px deep into the image, risking false positives.
     - **Fix:** Prioritized standard Gemini symmetric margins (`[64, 32, 48, 96, 72...]`) first. Non-symmetric ratio margins and exotic letterbox margins are evaluated only if standard symmetric margins fail to find an acceptable watermark (`ncc < Math.max(0.4, s.nccAccept)`), exactly mirroring the battle-tested logic in `videoEngine.ts`.
  3. **Candidate template ordering:** Sorted candidate mask sizes by proximity to the expected physical size (`isLarge ? 96 : 48`), ensuring native template resolutions are prioritized.
  4. **Regression test added:** Added `tests/realImageDetection.test.ts` verifying accurate detection (`96×96 at 2592, 1376`) and clean removal on the full 2752×1536 Diwali image.

## Known residual (documented, not a defect)
- A faint soft trace of the watermark's **own drop shadow** remains just outside the mask after video cleaning. It is part of the source compositing, sits outside the detected watermark region, and removing it would require blurring real content. Left intact deliberately.
