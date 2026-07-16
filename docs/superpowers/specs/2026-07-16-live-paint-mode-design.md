# Live paint mode — design

**Date:** 2026-07-16 · **Cache:** bump to `?v=38`

## What

Replace the rejected growth modes (spiral-fragment composites + draw-in) with
**Paint**: the live design builds like a painting — brush strokes sweeping in,
driven by the sound — ending as ONE coherent artwork (user reference: an
attractor design whose veils are a single continuous trajectory).

User decisions: all five modes paint (Approach A hybrid); the three old growth
modes are **deleted**; a painting **finishes and holds** (one artwork per
session) rather than endlessly fading.

## UX

- The Growth select becomes `#sel-growth` with two options: `Growth: Morph`
  (default, unchanged behaviour) and `Growth: Paint`.
- In Paint, silence rests the brush; sound advances it (louder = faster,
  onsets = bursts). A painting takes ~2–4 minutes of steady sound.
- On completion: status "Painting complete — freeze or clear"; the finished
  piece keeps breathing (instant layer + live colour continue).
- Switching mode or growth option mid-paint starts a fresh canvas.
- Freeze captures the painted cloud as-is via the existing composite-capture
  path (`freeze().cloud` → captured state; regen sliders replace it; SVG
  export empty — same limitations as before).
- Clear wipes. Video recording works throughout.

## Shared machinery — `js/paint.js` (new module, pure/node-testable)

- Budgets: `PAINT_MAX_POINTS = 600_000` desktop / `PAINT_MAX_POINTS_MOBILE = 200_000`.
- `class BrushPace` — `pointsThisFrame(rms, kickValue, dt) -> int`:
  `dt × (400 + 22_000 × rmsEnv + 6_000 × kick)` with an rms attack/release
  envelope (attack 0.1 s, release 0.6 s), 0 when `rms ≤ SILENCE_RMS` persists
  (envelope floor), clamped to `dt × 40_000`. At rms ≈ 0.15 ⇒ ≈ 3.7 K pts/s ⇒
  600 K in ≈ 2.7 min.

## Attractor brush — true streaming (`createOrbitBrush` in `js/generators/attractor.js`)

- `createOrbitBrush(fp, params) -> brush` with:
  - `next(k) -> { positions: Float32Array(k×3), attr: Float32Array(k) }` —
    advances the orbit k Euler/map steps through a **fixed normalization
    transform** calibrated at creation (5 000 hidden warmup+probe steps compute
    centre + r95 scale, same math as `computeNormalization`); positions are
    emitted normalized. Per-point attr = dwell (1 − speed/speedMax with a
    running speedMax), as in batch generation.
  - `steer(fp)` — retargets coefficients from the new fingerprint (same
    `liveAxes`/base coefficient mapping as batch live); actual coefficients
    **glide** toward targets with τ = 3 s so the ribbons bend, never jump.
    The system (thomas/…/sinemap) is chosen from the FIRST fingerprint via
    `pickSystem` and stays fixed for the painting (coherent single form).
  - **Stagnation guard:** every 2 000 emitted points, if the std of the last
    2 000 points < 0.05 (collapse into a loop/point), jolt: re-randomise the
    orbit position and nudge coefficient targets by the retry rule
    (`pitchMedian + 0.618` wrap), like batch retries.
  - Emitted points may drift past the calibrated frame as steering moves the
    orbit; clamp check: any |coordinate| > 2.2 → re-centre that point's step
    into range by resetting the orbit position (rare).
- Applies to `pickSystem` results of any system — including sinemap (discrete
  map streams the same way).

## Stroke-order painting — other four modes

- On the first sound window: conductor requests a **full painting-resolution
  design** (`density: PAINT_MAX_POINTS`, `liveVariance: true`) via the live
  worker; on arrival it becomes the paint buffer (revealed from 0).
  Generators already emit points in structural order (radial: shell by shell;
  harmonic: rings/lons; oscillo: ring by ring; cymatics: acceptance order —
  approximately radial), so drawRange reveal reads as strokes.
- Reveal count advances by `BrushPace` each frame.
- **Re-steering:** the existing morph scheduler (fingerprintDelta ≥ 0.18,
  ≥ 1.5 s apart) triggers a **remainder re-plan** instead of a crossfade: a new
  full design generates from the new fingerprint; its points beyond the
  current painted count are **spliced** into the buffer tail. Painted strokes
  never change; the brush continues into the new form. Splices arriving after
  a canvas reset are discarded (generation id, as before).

## Renderer — `js/density.js`

Replaces the grow/draw-in entry points with a paint buffer API:

- `beginPaint(maxPoints)` — allocates position/attr buffers of `maxPoints`
  (THREE.DynamicDrawUsage), drawRange 0, unit `aWeight`.
- `writePaintPoints(offset, positions, attr)` — copies into the buffers at
  `offset` and flags partial `updateRange` uploads (used by both the streaming
  brush appends and the remainder splices).
- `setPaintCount(n)` — `setDrawRange(0, n)`; retargets `uPeak` from n; dirty.
- Removed: `setGrowCloud`, `drawInTo`, `setDrawProgress`, the `_fading.manual`
  branch. Kept: the `aWeight` splat attribute (unit default — future stroke
  aging) and `_unitWeights`.

## Conductor — `js/live.js`

- `growthMode ∈ { 'morph', 'paint' }` (`setGrowthMode` as today; old values
  removed).
- Paint state: `painter` (`'orbit'` | `'reveal'`), `paintCount`, `paintBuf`
  (reveal target arrays), `paintDone`, generation id.
- Each tick in paint: `k = pace.pointsThisFrame(...)`;
  - orbit painter: `brush.next(k)` → `renderer.writePaintPoints(paintCount, …)`
    → `paintCount += k` → `setPaintCount`; `steer(fp)` whenever the morph
    scheduler’s delta fires (reusing its cadence, no crossfade).
  - reveal painter: `paintCount += k` (clamped to received points) →
    `setPaintCount`; morph-delta fires → remainder re-plan request → splice via
    `writePaintPoints(paintedCount, tail…)`.
  - `paintCount ≥ PAINT_MAX_POINTS` → `paintDone`, `onGrowStatus('Painting
    complete — freeze or clear')` once.
- Freeze: returns `cloud` built from the painted region (positions/attr
  subarrays, sliced copies) — same contract the capture path already consumes.
- Deleted: `NoteEventDetector`, `GrowComposite` usage, `_growTick`,
  `eventFingerprint`, draw-in progress; `js/grow.js` and `test/grow.test.js`
  removed entirely.

## main.js / index.html

- Growth select reduced to Morph/Paint (id and wiring unchanged otherwise).
- `getParams` gains `paintMaxPoints: isMobile ? 200_000 : 600_000` (replaces
  `fragPoints`/`growMaxPoints`).
- Freeze/composite capture path unchanged (already consumes `out.cloud`).

## Performance

- Orbit streaming: ≤ 40 K steps/s ≈ ≤ 0.7 ms/frame worst case — main thread OK.
- Partial buffer uploads: ~4 K points/frame × 16 B ≈ 64 KB/frame worst case.
- Reveal-mode full generations: PAINT_MAX_POINTS in the worker (~0.5 s), off
  the render thread; splice is a memcpy + partial upload.

## Error handling

- Worker failure on reveal generation → retry once, else status message and
  paint mode falls back to the orbit brush only for attractor-routed sounds /
  stays idle otherwise with a status hint.
- Stale generations discarded by id (mode/growth switch, Clear).
- Stagnation guard as above.

## Testing

Node (`test/paint.test.js` + live.test additions; grow tests deleted):
- `BrushPace`: silence ⇒ 0; steady rms rate ≈ spec; kick bursts; clamp.
- `createOrbitBrush`: emits k normalized bounded points; deterministic for a
  fixed fp; `steer` glides (coefficients move gradually, orbit continuous —
  consecutive chunks stay spatially adjacent); stagnation jolt fires on a
  degenerate fixture.
- Conductor paint: silence paints nothing; sound advances `setPaintCount`;
  completion fires status once; freeze returns painted cloud; morph scheduler
  triggers steer (orbit) / splice request (reveal) and never `crossfadeTo`;
  reveal splice writes at the painted offset; stale splice discarded.
- Removal: growth-mode tests replaced; suite green.

Browser acceptance: paint an attractor piece with music (ribbons bend with
melody); paint a radial/cymatics piece (strokes sweep in, redirect on sound
change); completion + freeze + export; Morph unchanged.

## Decisions log

| Question | Decision |
|---|---|
| Concept | One coherent form painted by sound-driven brush strokes (user reference: attractor trajectory) |
| Scope | All five modes (Approach A: streaming orbit brush for attractor; stroke-order reveal + remainder re-steer for the rest) |
| Old growth modes | Deleted (selector = Morph / Paint) |
| Completion | Finish → hold; one artwork per session |
