# Export Settings — Design

**Date:** 2026-07-14
**Status:** Approved by user (conversation), pending spec review
**Reference:** harmonic-sphere.pages.dev export modal (resolution/duration/transparency), adapted to Soundform's panel UI and WebCodecs pipeline.

## Goal

User-facing export settings matching harmonic-sphere's capabilities: image resolution picker (up to 8K print), video duration picker, and transparent-background export — layered on Soundform's existing (better) export pipeline. Defaults reproduce today's outputs exactly.

Out of scope: GIF export (rejected — MP4 covers it); export modal UI (panel section chosen instead); square-forced exports (canvas aspect preserved).

## Constraints

- All work on branch `export-settings`; merge to `main` (live) only after the user runs the local test checklist.
- Default settings must produce byte-equivalent behaviour to today (Standard res, 1 loop, transparency off).
- `js/density.js` changes additive only (user granted permission for `uTransparent`): with the uniform at its default 0, shader output is pixel-identical to today; the live canvas never renders transparent.
- Attractor/Cymatics generators untouched (locked); no generator changes at all.
- Cache bump v=27 → v=28 at ship.

## Design

### UI (new "Export" panel section below Motion)

| Control | Options | Applies to |
|---|---|---|
| Resolution | Standard (default, ≈3600px long edge — today's ×3) / 2K (2400) / 4K (3840) / 8K Print (7680) | PNG, JPG, WebP; MP4 follows but caps at 4K; PDF unchanged; SVG n/a (vector) |
| Video length | 1 loop (default) / ≈5s / ≈10s / ≈30s / ≈60s — rounded to whole seamless loops at current Loop(s) speed | MP4 |
| Transparent background | checkbox, default off | PNG, WebP, SVG; JPG/PDF/MP4 ignore silently |

Params: `exportRes: 'std' | '2k' | '4k' | '8k'`, `videoDur: 0 | 5 | 10 | 30 | 60` (0 = one loop), `transparentBg: boolean`.

### Renderer (`js/density.js`, additive)

- TONE_FRAG gains `uniform float uTransparent` (default 0.0). At 0: identical maths to today. At 1: output design colour with alpha = existing coverage term instead of mixing over `uBackground`.
- `renderHiRes(scaleFactor, { transparent = false } = {})`: sets `uTransparent` to 1 for the offscreen render only, restores 0 after. Readback already RGBA; alpha flows through to the 2D canvas via putImageData.
- 8K safety: check `gl.MAX_TEXTURE_SIZE` and wrap allocation in try/catch; on failure retry at 4K and surface "8K unavailable on this GPU — exported at 4K" via the status pill.

### Exporter (`js/exporter.js`)

- `loopsForDuration(targetSec, periodSec)` → whole loop count, min 1 (pure, node-tested). MP4 frames = loops × one-loop frames; existing `phase(i)` wraps per loop → seamless by construction.
- MP4 bitrate scales with resolution (12 Mbps at 1080 → proportional up to 4K).
- `exportStrandSVG`: `background: null` omits the background rect (transparent SVG).

### Wiring (`js/main.js`, `index.html`)

- Export buttons read the three params at click time; resolution → `scale = targetPx / max(canvasW, canvasH)`; transparency passed only for PNG/WebP/SVG.
- MP4 branch multiplies frames by `loopsForDuration(params.videoDur || period, period)` (0 → exactly one loop).

## Testing

**Node:** `loopsForDuration` rounding/min-1; SVG with null background omits rect, keeps paths; existing 52 tests keep passing.

**Manual gate (user, localhost, before merge)** — for each of the five modes, Attractor first:
1. Default-settings PNG ≡ pre-change output for the same design
2. 4K transparent PNG → real alpha, clean edges
3. Transparent SVG → no background rect
4. ≈10s MP4 → whole-loop length, seamless
5. Screen rendering unchanged before/after exports
Plus one 8K attempt (succeeds or visible 4K fallback).

## Error handling

- 8K allocation failure → automatic 4K retry + status message (no silent black export).
- Transparency on formats without alpha → silently ignored (JPG/PDF/MP4 export as today).
- WebCodecs 4K config unsupported → existing codec fallback chain, then status message.
