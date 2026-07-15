# Live Mode — design

**Date:** 2026-07-15 · **Branch:** `live-mode` (off `cymascope-look`) · **Cache:** bump to `?v=32`

## What

A new **Live** mode: the site listens to the microphone and generates designs
continuously, in front of the user, reacting to pitch, volume, notes, chords,
velocity, brightness — the full feature set. All existing generator modes
(attractor, radial, cymatics, harmonic, oscillo) work live. Any moment can be
**frozen** into a full-quality captured design with the normal sliders and
exports.

Purpose (user decision): **both** a living visualizer/performance piece **and**
a way to audition-then-capture designs — equally.

## Reaction model — "living organism" (user decision)

Two speeds at once:

- **Instant layer (every frame, 60fps):** volume, beats, and brightness hit
  immediately via shader uniforms on the current point cloud. No geometry work.
- **Structural layer (~every 0.75s, morphs ≥1.5s apart):** notes, chords, and
  pitch register reshape the actual geometry; the old form crossfades into the
  new over ~1s.

## UX and state flow

- New **Live** button in the audio row (next to mic/upload). Tapping requests
  the mic and enters a new app state: `live`.
- VU meter visible; status bar: "Live — listening".
- **Mode buttons stay active** (user decision: user picks the mode, sound
  drives it). Switching mode mid-live triggers an immediate structural
  crossfade into the new mode, built from the same rolling sound window.
- Geometry sliders (complexity, symmetry, twist, density) apply on the next
  structural morph. **Palette controls and the exposure slider fade/suspend
  during live** — colour and exposure are sound-driven while live.
- **Capture** (existing check button, visible throughout live): stops the mic,
  fingerprints the last ~4s window (including the 4-channel trajectory, same
  construction as the record flow so Oscillo works), regenerates at **full
  density**, and lands in today's `captured` state unchanged — all sliders and
  exports (PNG/WebP/PDF/SVG/MP4) work as-is. The live colours at the moment of
  capture are written into the custom-palette params (`palette='custom'`), so
  the frozen design keeps the colours the user saw; palette controls reactivate.
- **Clear** returns to `blank` as today.
- Live runs indefinitely; the ring buffer bounds memory.
- Mobile: same behaviour, lower live density.

## Architecture

Three additions; generators, exporter, fingerprint builder, worker protocol,
and the captured-state code are reused untouched.

### 1. `js/live.js` — LiveConductor (new module)

Owns the live loop (rAF while state === 'live').

- Pulls `audio.getMusicalFrame()` each frame (pitch/conf, chroma, flux, rms,
  centroid, spread — already implemented) into a **ring buffer of ~4 seconds**
  (~240 frames cap).
- **Instant layer** — smoothed attack/release envelopes map features to cheap
  renderer knobs:
  - `rms` → breathing amplitude (existing motion `uAmp`)
  - pitch (log₂, 55–3520 Hz) → wave frequency (`uFreq`)
  - spectral centroid → grain/splat-size shimmer
  - spectral spread → drift (auto-rotate) speed, subtle
  - **onset kick:** flux spike above rolling mean+std fires a kick envelope —
    exposure boost + small scale pop (~1.03) decaying over ~300ms.
- **Structural layer** — every ~0.75s:
  - `buildFingerprint(windowFrames, windowSec)` (reused as-is).
  - Change metric vs the currently displayed fingerprint: note-set difference,
    pitchMedian delta, consonance/majorLeaning flip, velocity delta. Past a
    threshold — or on mode switch — request new geometry from the worker at
    **live density** (~250K points desktop / ~120K mobile).
  - At most **one regen in flight**; minimum **1.5s between morphs**.
  - Result → `renderer.crossfadeTo(positions, attr, ~1s)`.
- **Silence:** amplitude eases to 0, no regens fire; the last form idles
  (slow drift) rather than clearing.
- Tab hidden → conductor pauses cleanly; resumes on visibility.

### 2. `js/density.js` — crossfade (only shader change)

`crossfadeTo(positions, attr, durationSec)`:

- Two `Points` slots with **cloned splat materials**, each with a new
  `uWeight` uniform multiplying splat intensity in `SPLAT_FRAG`.
- Incoming cloud ramps 0→1 while outgoing ramps 1→0 (driven in the existing
  `_loop`), then the old geometry is disposed.
- Additive blending makes this a luminous dissolve; `uPeak` retargets to the
  incoming cloud's estimate over the same ramp.
- Existing single-cloud `setCloud` path unchanged (capture/record flows use it).

### 3. `js/main.js` — wiring

- `live` app state + Live button handling; suspend/fade palette & exposure
  controls during live; capture path (stop conductor → fingerprint + trajectory
  → `regenerate()` at full density); clear path.
- Mode-button and geometry-slider events forward to the conductor while live.

## Sound-driven colour — `js/livecolor.js` (new pure module)

Full synaesthesia (user decision), tuned pastel to stay on-brand:

- **12 pitch classes → 12 pastel hue anchors** around the wheel; C = lavender
  (~270°), each semitone ≈ +30°. A key change relocates the colour world.
- **Chord root** (existing triad match) → base/primary hue.
  **Second-strongest pitch class** → secondary hue.
- **Major leaning** → warmer + lighter; **minor** → cooler + deeper.
- **Consonance** → saturation (dissonance goes ashen/muted).
- **Centroid** → accent lightness (toward cream).
- Output: `{background(near-black), primary, secondary, accent}` hex → existing
  `customRamp` → `buildLUT` → `setPalette` (256×1 LUT upload; effectively free).
- **Hue glide ~500ms** (shortest-arc hue interpolation) so chord changes bloom
  rather than strobe; LUT rebuilt only when the glide is active (≤ ~20Hz).
- Pure function of (chroma, harmony fields, centroid) → deterministic, testable.

## Performance

- Ring buffer capped ~240 frames; per-frame feature extraction already exists
  and pitch already runs every 2nd frame.
- Fingerprint on a 4s window: sub-millisecond scale (already run per capture).
- Live-density worker generation: ~100–200ms; never blocks the main thread.
- Crossfade adds one extra draw call during the ~1s dissolve only.
- Target 60fps desktop, 30+ mobile.

## Error handling

- Mic denied/unavailable → status-bar message (existing pattern), stay in prior
  state.
- Worker error → inline `fallbackGenerate` (existing pattern).
- Float-buffer fallback renderer: live still works (uniform-driven pulse +
  colour still apply; crossfade degrades to a swap).

## Testing

Node tests (extend the existing suite):

- `livecolor`: chroma/harmony in → deterministic ramp out; pastel bounds
  (saturation/lightness ranges); hue glide shortest-arc behaviour.
- Fingerprint change metric: identical → no trigger; note-set/register/harmony
  changes → trigger; threshold edges.
- Kick envelope: fire, decay curve, re-trigger.
- Ring buffer: cap, ordering, window duration.

Live behaviour verified manually in-browser (mic, morphs, freeze, exports).

## Decisions log

| Question | Decision |
|---|---|
| Purpose | Visualizer **and** audition-then-capture, equally |
| Mode selection | User picks mode; sound drives it (auto-switching deferred) |
| Reaction feel | Living organism: instant volume/beat + ~1–2s structural morphs |
| Colour | Fully sound-driven (pitch-class hues, major/minor warmth), pastel-tuned |
| Architecture | Approach A: two-layer hybrid with live-density crossfaded regens |
