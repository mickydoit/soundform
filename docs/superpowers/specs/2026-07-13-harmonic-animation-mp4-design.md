# Harmonic Mode, Design Animation & MP4 Export — Design

**Date:** 2026-07-13
**Status:** Approved by user (conversation), pending spec review
**Inspiration:** https://harmonic-sphere.pages.dev/ (p5.js spherical-harmonics tool; source reviewed)

## Goal

Three features, shipped independently in this order:

1. **Harmonic mode** — a new generator producing analogue, instrument-drawing-style designs: a fine lat/long wireframe sphere deformed by real spherical harmonics. Gives the user a grounded, less "spacey" option.
2. **Design animation** — the form itself breathes/ripples over time (not just camera rotation), with seamless looping, play/pause, and a speed control. Defaults to off.
3. **MP4 export** — deterministic offline frame rendering encoded to H.264 MP4, one perfect loop.

Out of scope (considered, rejected for now): GIF export, baking source audio into the video, paper-grain texture overlay, keyframe-morph animation (possible v2 if displacement feels too subtle).

## Constraints

- **Locked files:** `js/generators/attractor.js` and `js/generators/cymatics.js` are not modified. `js/density.js` is normally locked; the user granted explicit permission (2026-07-13) for **additive** animation changes that leave paused/static rendering pixel-identical to today.
- No build step; vendored single-file libraries only (pattern: jsPDF).
- Determinism: same audio fingerprint → identical design and identical motion.
- All existing designs, presets, and share links must look exactly as they do today until the user presses play.

## Feature 1 — Harmonic mode

**New file** `js/generators/harmonic.js`, registered as `harmonic` in `js/generators/index.js` REGISTRY.

**Form:** a sphere sampled as latitude/longitude rings. Each ring is a strand (polyline, resampled like existing generators). Radius at (θ, φ) is displaced by a sum of real spherical harmonics Yₗᵐ (associated Legendre recursion — same maths as harmonic-sphere, reimplemented cleanly; their code is unlicensed so no copying, only the standard formulas).

**Audio → design mapping** (via existing fingerprint + `fnv1a`/`mulberry32` seeding):

| Audio feature | Drives |
|---|---|
| Pitch | Dominant degree *l* (low pitch → few large lobes, high → fine ripples), range ≈ 3–9 |
| Harmony | Order *m*, plus blend weight of a second harmonic (l', m') for asymmetry |
| Chroma | Phase rotations of each harmonic term |
| Onsets | Number of stacked wave components |

**Rendering strategy:** points are sampled densely *along the ring strands* (not scattered volumetrically), so the GPU log-density renderer draws crisp fine lines — the analogue line-work look. Strand list feeds the existing SVG export unchanged.

**Palettes:** three muted ramps added to `js/palettes.js`, selectable in all modes; existing palettes untouched:
- **Ink** — near-monochrome, plotter-on-paper
- **Graphite** — soft warm greys
- **Scope** — phosphor green on black

**Tests:** node tests matching existing conventions — determinism (same fingerprint → byte-identical positions/strands), shape sanity (point count, strand count, normalization bounds), registry integration.

## Feature 2 — Design animation

**Where:** additive changes to `js/density.js` only.

**Shader:** the splat vertex shader gains a `uTime` uniform (loop phase `t ∈ [0,1)`) and `uMotion` params (direction, spatial frequency, amplitude — derived deterministically from the design seed and passed as uniforms). Displacement per point, along the radial direction:

```
displaced = position + normalize(position) * amp * sin(k · dot(position, dir) + 2π·t)
```

All animated terms use whole multiples of 2π·t → frame at t=0 is mathematically identical to t=1 → **seamless loop**. Amplitude defaults to a few percent of form radius (resonating body, not explosion).

**Loop:** `_loop()` gains a play flag. While playing: advance t from wall-clock ÷ loop period, mark `_dirty` each frame. While paused: identical behaviour to today (render-on-demand, zero draw calls idle). `uTime` = 0 and `uMotion.amp` = 0 when motion has never been enabled, so static rendering is pixel-identical to current output.

**Controls:** play/pause button + speed slider (loop period ≈ 4–20 s) in the existing glass chrome. Default: off.

**Exports while paused:**
- PNG/JPG/WebP/PDF: the hi-res pass renders with the current `uTime`, capturing the exact frozen frame.
- SVG: the displacement formula is mirrored in plain JS (small pure function, unit-tested against expected values) and applied to strand positions before projection in `js/exporter.js`, so the vector export matches the visible frame.

**Tests:** node tests for the JS displacement function (loop closure: f(0) == f(1); determinism; amplitude bounds).

## Feature 3 — MP4 export

**Frames:** deterministic offline rendering — for frame i of N, set loop phase to i/N, render offscreen via the same path as the existing `renderHiRes`, read pixels. Not screen capture: no dropped frames, no realtime constraint. Frame N wraps to frame 0 → the file is a perfect loop by construction.

**Encoding:** WebCodecs `VideoEncoder` (H.264/avc1, hardware-accelerated) + **mp4-muxer** (MIT, dependency-free) vendored as a single file in `js/vendor/mp4-muxer.js`. No audio track.

**Defaults:** one loop at the current speed setting, 30 fps, 1080 px on the long edge at canvas aspect. "MP4" entry in the existing export menu. Progress in the existing status pill; cancellable. If `VideoEncoder` is unavailable (older Safari/Firefox), the menu item shows "not supported in this browser" rather than failing silently.

**Code placement:** new `exportMP4()` in `js/exporter.js`; frame-stepping/loop-phase math extracted as a pure function and node-tested.

## Build order & shipping

Each feature merges and ships independently:

1. Harmonic mode (pure addition, zero risk to locked files)
2. Animation (density.js additive changes + controls)
3. MP4 export (depends on animation's loop phase)

Cache-bust version bumped on each merge (currently ?v=22).

## Error handling

- Unknown/unsupported WebCodecs codec config → try `avc1.42001f` baseline fallback, then surface a clear status-pill message.
- MP4 export cancellation → encoder flushed and discarded, no partial download.
- Harmonic generator degenerate cases (e.g., silent audio → near-zero onsets) → clamp to minimum 1 wave component; normalization already guards zero-scale.
