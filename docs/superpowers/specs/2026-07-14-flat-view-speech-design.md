# Flat View Default + Speech-Unique Harmonics — Design

**Date:** 2026-07-14
**Status:** Approved by user (conversation). User granted autonomous ship (per 2026-07-14 standing instruction, reaffirmed in design approval).
**Reference:** Chladni plate photographs (user screenshots) — flat, straight-on, top-down presentation.

## Goal

1. Designs open **flat and straight-on by default** — orthographic projection (no foreshortening), top-down orientation — poster/Instagram/branding-ready out of the box, with a toggle to restore 3D depth. Applies to canvas, PNG and SVG export alike.
2. **Spoken word produces visibly unique designs** — prosody (pitch contour) and atonality (low consonance) feed the harmonic deformation, so different utterances give clearly different forms.

## Constraints

- `js/density.js` additive only (standing permission): perspective mode must stay pixel-identical to today; new code paths only run in flat mode. Attractor/Cymatics generators untouched. Harmonic generator is fair game (not locked).
- Deterministic per fingerprint, as always. Cache bump v=29 → v=30 at ship. Branch `flat-view-speech`.

## Design

### Flat view (renderer + UI)

- `setProjection('flat' | 'depth')` — additive method. `'flat'` = `THREE.OrthographicCamera` with half-height **1.325** (matches perspective framing: 3.2·tan(22.5°)) × aspect; `'depth'` = today's PerspectiveCamera 45°, z 3.2.
- New `_setAspect(aspect)` helper replaces the three perspective-specific `camera.aspect = …` sites (`_onResize`, `renderHiRes`, `getMVP`): sets `left/right/top/bottom` for ortho, `aspect` for perspective. Behaviour identical for perspective.
- Zoom in flat mode: `_renderFrame` sets `camera.zoom = _zoom / (_insetZoomOut || 1)` + updateProjectionMatrix for ortho (position.z has no effect on ortho scale); perspective branch unchanged.
- `setOrientation(rx, ry)` — additive setter for `_rotX/_rotY`.
- Defaults (in `js/main.js`, after renderer construction): `setProjection('flat')`, `setOrientation(-Math.PI / 2, 0)` (top-down). Drag/auto-rotate unchanged; auto-rotate spins in-plane when top-down.
- UI: checkbox `chk-flat` "Flat view (2D)", **checked by default**, in the Motion section. Param `flatView: true`. Toggling calls `setProjection`.
- View-inset centring and hi-res/SVG export paths work in both projections via `_setAspect` (`setViewOffset` exists on both camera types).

### Speech-unique harmonics (`js/generators/harmonic.js`)

- **Prosody banding:** displacement scaled by a contour envelope over latitude: interpolate `fp.contour` (8 bands) at `theta/π·7` → factor `0.7 + contour·0.6`. Flat contours (pure tones) ≈ no change; speech intonation shapes the form pole-to-pole.
- **Atonal wildness:** `wild = 0.5 + (1 − fp.consonance)`. Interference-wave frequency jitter scales by `wild`; each wave's amplitude gains seeded variance `×(1 + (rnd()−0.5)·0.6·wild)`. Sung/consonant input (wild ≈ 0.5–0.7) stays cleaner than today’s baseline only marginally; speech (wild ≈ 1.3–1.5) gets visibly irregular collisions.
- RNG call order unchanged → determinism preserved.

## Tests

- Harmonic: contrasting contour vs flat contour → positions differ (>1 summed over 300 floats); consonance 0.05 vs 0.95 → differ; existing harmonic contract/asymmetry tests keep passing.
- Renderer is GPU-only (no node tests); `node --check` + all existing tests green.

## Error handling / edge cases

- Missing `fp.contour` → envelope factor 1 (guard).
- Ortho + mobile view-inset → same `_applyViewOffset` path (setViewOffset supported); if the offset maths misbehaves on ortho it degrades to un-inset centring, never a crash.
