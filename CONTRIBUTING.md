# Contributing to Inverta Studio

Thank you for your interest in contributing to **Inverta Studio**! We welcome bug reports, feature requests, template calibration fixes, and code contributions from the open-source community.

---

## 🛠️ Development Setup

Inverta Studio is built with modern, zero-backend web standards:
- **Framework**: React 19 + TypeScript + Vite
- **Styling**: Tailwind CSS v4
- **Engine**: Canvas 2D + WebCodecs API + mp4-muxer / mp4box.js
- **Linter**: Oxlint
- **Testing**: Node.js built-in test runner (`node --test`)

### Prerequisites
- Node.js 20+ (LTS recommended)
- npm or pnpm

### Getting Started

1. **Fork and Clone**:
   ```bash
   git clone https://github.com/<your-username>/inverta-studio.git
   cd inverta-studio
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```

3. **Start Development Server**:
   ```bash
   npm run dev
   ```
   Open [http://localhost:5173/](http://localhost:5173/) in Chrome, Edge, or any modern Chromium-based browser (WebCodecs requires hardware-accelerated Chromium).

4. **Run Test Suite**:
   ```bash
   npm test
   ```

5. **Typecheck & Build**:
   ```bash
   npm run typecheck
   npm run build
   ```

---

## 🧩 Architectural Overview

Inverta Studio performs analytical inverse alpha blending rather than AI inpainting:

```
Observed Pixel (C) = α · Watermark (W) + (1 - α) · Original Pixel (C₀)
Original Pixel (C₀) = (C - α · W) / (1 - α)
```

### Core Engine Files:
- [`src/engine/watermarkEngine.ts`](file:///d:/Coding/Erasio/src/engine/watermarkEngine.ts): Multi-scale Normalized Cross-Correlation (NCC) template matching, sub-pixel alignment, and alpha inversion.
- [`src/engine/alphaMasks.ts`](file:///d:/Coding/Erasio/src/engine/alphaMasks.ts): Mathematical masks for Google Gemini Sparkle (96px/48px), Veo (38px/2026), and classic dual-star (84px).
- [`src/engine/videoEngine.ts`](file:///d:/Coding/Erasio/src/engine/videoEngine.ts): WebCodecs `VideoDecoder` and `VideoEncoder` pipeline for 60fps MP4 processing.
- [`src/engine/types.ts`](file:///d:/Coding/Erasio/src/engine/types.ts): Data contracts for detection results, candidate scores, and rendering options.

---

## 📋 Pull Request Guidelines

1. **Branch Naming**: Use descriptive branch names:
   - `fix/sparkle-detection-alignment`
   - `feat/webp-export-support`
   - `docs/add-usage-examples`
2. **Deterministic & Private**:
   - All processing **must remain 100% client-side**. No telemetry, no external API calls, and zero external network dependencies.
3. **Pass Tests**:
   - Ensure all automated unit tests pass before submitting (`npm test`).
   - If adding support for a new watermark template, include unit tests covering matching confidence and coordinate bounds.
4. **Clean Commits**:
   - Follow Conventional Commits: `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`.

---

## 💬 Community & Questions

- Have questions or ideas? Start a discussion in [GitHub Discussions](https://github.com/Talha-Quraishi/inverta-studio/discussions).
- Found a bug or regression? Open a [Bug Report](https://github.com/Talha-Quraishi/inverta-studio/issues/new?template=bug_report.yml).
