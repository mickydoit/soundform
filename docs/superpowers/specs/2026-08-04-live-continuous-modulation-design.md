# Live continuous modulation — design

**Date:** 2026-08-04
**Status:** approved, ready for planning

## Problem

Two complaints, one theme.

**Attractor morph mode "chops and changes".** When the sound moves far enough,
`LiveConductor.tick()` generates an entirely new cloud and dissolves into it:

```js
this.renderer.crossfadeTo(out.positions, out.attr, MORPH_CROSSFADE_SEC);
```

The two clouds are unrelated — a different attractor system, or at minimum a
coefficient set derived from a different fingerprint. The dissolve *is* the
chopping. It reads as swapping between designs rather than one design
responding to a voice.

**Cymatics Paint "jumps or skips".** Measured over 30s of one voice talking
steadily, with a realistic 350 ms worker latency:

| defect | measurement |
|---|---|
| design splices | 15 in 30s — a whole new design every ~2s |
| single-frame GPU upload per splice | 7.2 MB positions + 2.4 MB attr |
| already-visible points overwritten | up to 2,176 per splice |

The third is a genuine bug: `_requestReveal(fp, p, max, st.count)` captures
`spliceFrom` at *request* time, but generation is async and `st.count` keeps
advancing. On completion it writes from the stale offset, overwriting points
that are already on screen.

The 0.75s → 0.15s check-interval change shipped in `ef84298` moved splices from
13 to 15 per 30s. A contributing factor, not the root cause: the debounce added
in that commit guards the morph path only, so `_paintTick` still fires on a
single threshold crossing.

## Feasibility evidence

Attractors are chaotic, so "modulate one design by regenerating it with nudged
parameters" is not obviously possible — small parameter deltas could produce
wholly different clouds. Measured by cell-occupancy overlap against an
unmodulated baseline, locked system, 22³ grid:

| lever | overlap | verdict |
|---|---|---|
| Complexity slider 0.5 → 1.0 | 0.996–1.000 | **no effect at all** |
| fingerprint drift 0.02 | 0.936 | smooth |
| fingerprint drift 0.05 | 0.770 | usable |
| fingerprint drift 0.10 | 0.643 | visible step |
| fingerprint drift 0.20 | 0.178 | reads as a jump |
| twist 0 → 0.5 | 0.867 | smooth, geometric, not chaotic |
| density 30k/120k vs 60k | 0.841 / 0.953 | smooth |

Two conclusions:

1. **Continuous modulation is viable.** Gliding sound-derived coefficients in
   small steps keeps the cloud recognisably itself. Budget ≈ 0.02 fingerprint
   drift per regeneration to stay near 0.94 overlap.
2. **The Complexity slider has no live effect.** `generate()`'s live flow branch
   drives coefficients from the character axes and never reads
   `params.complexity`; it survives only as a small `jitter` term. "Complexity
   increases with the sound" needs a lever built, not merely wired up.

Generation cost, 250k points: **151 ms** with 96 strands, **109 ms** with 8.
This caps the structural cadence at ~5 Hz. Live morph currently requests 96
strands and never uses them — freeze in morph mode returns only a fingerprint
and `main.js` calls `regenerate()`, so live strands are discarded. Dropping to
8 during live is free.

## Design

### Two layers, split by cost

**Instant layer** — every frame, no regeneration. Extends what `tick()` already
does with GPU uniforms and draw range, so it costs nothing and reacts within a
frame:

- visible point count ← loudness (draw range)
- onset pulse ← existing `uAmp`/`uFreq` wave and the `kick` multiplier

Size is driven in **one place only**, to avoid two layers fighting over it: the
Scale auto-slider carries the slow energy envelope (§ auto-driven sliders), and
the existing `scale: base.scale * (1 + 0.035 * kick)` multiplier stays as a fast
transient on top of whatever Scale currently reads. The instant layer never
writes Scale itself.

**Structural layer** — regenerates the locked system with glided parameters at
≤5 Hz, each step small enough to be a deformation. Point identity shuffles on
every regeneration, but an identically-distributed cloud renders near-identically
under additive density rendering, so a short **0.15s** crossfade covers the
sampling noise. This replaces the 0.45s dissolve between unrelated designs.

### System lock

`pickSystemLive(fp)` runs **once**, at first sound. The result is stored on the
conductor and passed to `generate()` as `params.lockedSystem`, which
`attractor.js` uses instead of re-picking. Cleared on Clear and on mode switch.
Register/delivery routing still chooses the form — once, at the start.

### Complexity lever

Each system declares which end of its coefficient range reads as "more
elaborate". Complexity biases the axis-derived coefficients toward that end,
bounded inside the validated range so `validateOccupancy` / `validateFinalized`
don't start rejecting and falling back to the capture path (a fallback discards
live variance entirely — that regression cost real time during the attractor
work).

- aizawa: `d` toward 3.95 (tighter folds, denser interior)
- thomas: damping `b` toward the low end
- halvorsen: the `kx/ky/kz` asymmetry split widens
- lorenz: `r` toward the top of its chaotic band

### Auto-driven sliders

Per-parameter `{ auto: true }` state in `main.js`. While live, the conductor
emits target values; sliders animate at **~10 Hz** (60 Hz DOM writes thrash
layout). Manual input on a slider sets `auto = false` for that parameter for the
rest of the session; others keep tracking. Clear resets all to auto.

Auto-driven: **Complexity, Twist, Scale.**

### Density — deliberate deviation

The Density slider (200k–4M) sets *generation* density, so driving it from
loudness forces a full regeneration per volume change — at 151 ms each, exactly
the stutter being removed. Loudness instead drives the **visible fraction via
draw range**: free, frame-accurate, and a faster response than a slider could
give. The Density slider stays manual and keeps governing capture/export
density.

Flagged to the user as a substitution for what was literally asked for, and
accepted.

### Cymatics — bug fixes only

Explicitly scoped to fixing the glitches, not restructuring Paint:

1. **Chunked splice.** Write the remainder across frames instead of one
   `writePaintPoints` call spanning up to 600k points.
2. **Recompute `spliceFrom` at completion**, from the current `st.count`, so a
   splice never overwrites points already on screen.
3. **Debounce parity.** `_paintTick` requires `MORPH_CONFIRM_CHECKS` consecutive
   over-threshold checks, as the morph path already does.

## Testing

Node-testable, no browser required:

- `AutoParams` gliding is pure — targets, time constants, clamping.
- **System lock invariance:** across a session of varied sound, the system never
  changes.
- **Per-step continuity:** consecutive regenerations stay above ~0.85 cell
  overlap. This is the direct regression test for "morphs rather than chops".
- **Slider hand-off:** manual input clears `auto` for that parameter only;
  Clear restores it.
- **Cymatics splice:** no write overlaps the visible range; every write is
  under the chunk cap; splice rate under load stays at or below the morph path's.

The existing invariants must hold: 52 snapshot checksum tests (capture path
byte-identical), the locality test, and the churn test from `ef84298`.

## Risks

- 5 Hz regeneration keeps a worker core busy and pushes ~4 MB/update to the GPU.
  Mitigation if too heavy: drop live density 250k → 120k while modulating,
  restore on settling.
- Live and capture diverge further — live becomes continuous modulation, capture
  stays one-shot. Snapshot tests still pin capture.
- Locking the system means a live session can no longer reach a different form
  without clearing. That is the explicit intent, but it makes the *first* few
  seconds of sound decide the whole session.

## Out of scope

- Paint pause/resume and the slider-discards-painted-cloud bug (still open,
  needs its own design).
- Any change to capture, recording, or export.
- Restructuring cymatics Paint beyond the three fixes above.
