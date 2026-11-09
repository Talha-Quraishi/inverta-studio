# Inverta Studio — Analytical AI Watermark Inversion

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Pipeline](https://img.shields.io/badge/Pipeline-100%25%20Client--Side-emerald.svg)](#privacy--zero-uploads)
[![Video Engine](https://img.shields.io/badge/Video-WebCodecs%20H.264-amber.svg)](#video-pipeline)
[![Theme](https://img.shields.io/badge/Studio%20Theme-Light%20%2F%20Dark-zinc.svg)](#studio-ui)

A precision client-side analytical watermark inversion tool for generative images and **Veo MP4 videos** (Google Gemini, Imagen, Veo, Flow, AI Studio).

Unlike generic AI inpainting or blurry diffusion brush models that hallucinate new pixels, **Inverta Studio** performs exact mathematical inversion of the Porter-Duff alpha compositing equation to recover the original underlying pixels with zero loss of sharpness.

---

## Key Features

- **Generative Images & Veo MP4 Videos**: Full support for still images (PNG, WebP, JPEG, BMP) and high-bitrate MP4 video files.
- **Aspect-Ratio Invariant Detection**: Automatically detects watermarks across 16:9 widescreen, 9:16 portrait/vertical videos (TikTok/Shorts/Reels), 1:1 square, and arbitrary custom aspect ratios.
- **100% Private & In-Browser**: Zero network uploads. All demuxing, decoding, mathematical inversion, and re-encoding runs locally in browser RAM via WebCodecs and Canvas 2D.
- **Hardware-Accelerated Video Pipeline**: MP4Box.js demuxer paired with the native WebCodecs API (`VideoDecoder` / `VideoEncoder`) for blazing fast frame-by-frame processing.
- **Studio-Grade UI**:
  - **Light & Dark Mode**: Handcrafted studio palettes with instant toggle and persistence.
  - **Buttery-Smooth Viewport**: 60–120fps comparison slider synchronized via `requestAnimationFrame` with zero cursor lag.
  - **2.2× Corner Loupe**: Precision magnification focused directly on the watermark quadrant with 1:1 zoom inspection.
  - **Synchronized Video Player**: Interactive Swipe slider, Side-by-Side split view, 24fps frame-by-frame stepper, and precision timecode scrubber.
  - **Pro Keyboard Ergonomics**: Spacebar to play/pause, left/right arrows for frame stepping and slider nudging, `Z` for corner loupe, `F` to fit view, and `1-4` for viewport modes.

---

## How It Works

### 1. Aspect-Ratio Invariant Detection
Watermark detection runs Normalized Cross-Correlation (NCC) against calibrated alpha templates (Classic Star 84px, 2026 Sparkle 96px, and White Sparkle 96px). The search tests standard margin coordinates first (`[64, 64]`, `[48, 48]`, `[32, 32]`, etc.) before dynamically scanning corner quadrants, ensuring instant detection regardless of video resolution or aspect ratio.

### 2. Analytical Alpha Inversion
Inverta Studio reverses the Porter-Duff source-over blending formula channel-by-channel:

$$\text{Original Pixel} = \frac{\text{Watermarked Pixel} - \alpha \cdot q \cdot 255}{1 - \alpha \cdot q}$$

Where:
- $\alpha$ is the calibrated alpha mask transparency value for the pixel.
- $q$ is the gain drift compensation factor addressing lossy video/image compression artifacts.
- $255$ represents the pure white watermark luminance.

### 3. Harmonic Laplace Diffusion Core Inpainting
For saturated core pixels where $\alpha \ge 0.98$ (where original pixel luminance is completely eclipsed by the watermark), an 8-neighbor harmonic diffusion fill smoothly propagates edge frequencies into the center, eliminating residual halos.

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm or pnpm
- A modern Chromium-based browser (Chrome, Edge, Brave, Opera) with WebCodecs support.

### Local Installation

```bash
# Clone the repository
git clone https://github.com/your-username/inverta-studio.git
cd inverta-studio

# Install dependencies
npm install

# Start local development server
npm run dev
```

Open your browser at `http://localhost:5173`.

### Production Build

```bash
npm run build
```

The production assets will be built in the `dist/` directory.

---

## Deployment

Because Inverta Studio is a 100% client-side web application with zero backend dependencies, it can be deployed for free to any static hosting provider:

### GitHub Pages (Automated via GitHub Actions)
A pre-configured GitHub Actions workflow (`.github/workflows/deploy.yml`) is included. Simply push your code to the `main` branch, go to **Settings > Pages**, and select **GitHub Actions** as the source.

### Vercel / Netlify / Cloudflare Pages
- **Vercel**: Deploy directly from the GitHub repository or run `npx vercel`.
- **Cloudflare Pages**: Connect your repository and set the build command to `npm run build` with output directory `dist`.

---

## Architecture

```
inverta-studio/
├── public/
│   └── masks/                 # Calibrated alpha mask templates (48px, 84px, 96px)
├── src/
│   ├── components/
│   │   ├── Header.tsx         # Brand identity, telemetry badges, and Light/Dark toggle
│   │   ├── DropZone.tsx       # Drag & drop, browse, and clipboard paste (Ctrl+V / ⌘V)
│   │   ├── ComparisonSlider.tsx # 60-120fps RAF slider, 2.2x loupe, pan/zoom
│   │   ├── VideoPlayerComparison.tsx # WebCodecs playback, split/swipe view, frame stepper
│   │   ├── ControlsPanel.tsx  # Diagnostics HUD, template selector, nudge micro-stepper
│   │   └── BatchQueue.tsx     # Asset filmstrip and bulk export
│   ├── engine/
│   │   ├── watermarkEngine.ts # Analytical alpha inversion & multi-template NCC search
│   │   ├── videoEngine.ts     # MP4Box demuxer + WebCodecs VideoDecoder/VideoEncoder
│   │   ├── nccMatcher.ts      # Fast normalized cross-correlation algorithm
│   │   ├── alphaMasks.ts      # Scaled mask cache & bilinear resampling
│   │   └── diffusionFill.ts   # Harmonic Laplace diffusion core inpainting
│   ├── App.tsx                # Studio layout, theme provider, and zero-hang pipeline
│   └── index.css              # Tailwind CSS v4 design tokens and studio typography
└── dist/                      # Static production bundle
```

---

## License

This project is licensed under the [MIT License](LICENSE).
