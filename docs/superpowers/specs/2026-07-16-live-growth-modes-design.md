# Live growth modes — design

**Date:** 2026-07-16 · **Cache:** bump to `?v=37`

## What

Live designs currently appear fully formed and morph/crossfade between states.
This adds three experimental **growth modes** where the design builds in real
time with the sound — each note and word adds to it — selectable next to Mode
so the user can test all three locally and compare (user decision: build all
three).

## UX

A **Growth** select (`#sel-growth`) in the panel's Mode section, enabled
during live (suspended otherwise, like the palette controls):

| Option | Behaviour |
|---|---|
| `morph` (default) | Today's behaviour: structural morphs crossfade between fully formed designs. |
| `grow-fade` | Each sound event adds a fragment to a growing composite; fragment weights age with a ~3-minute half-life so the design grows at the edge of a slowly dimming history. |
| `grow-keep` | Same engine, no fading; grows until the point cap, then stops adding with a one-time status hint ("design full — freeze or clear"). |
| `draw-in` | Today's morph cycle, but each new design reveals itself progressively (draw range sweeps 0→N), paced by loudness; the outgoing design dims while the new one draws. |

Switching growth option mid-live takes effect immediately (grow modes start a
fresh composite; morph/draw-in resume the normal cycle).

## Sound events (grow modes) — `NoteEventDetector` in `js/live.js`

Fires a growth event when any of:
- **Onset:** the existing `KickDetector` fires (flux spike);
- **New note:** the dominant chroma pitch class changes while voiced
  (`pitchConf > 0.5`) and holds for ≥120 ms;
- **Sustain:** ≥500 ms of continuous sound (`rms > SILENCE_RMS`) since the
  last event (so held notes keep adding slowly).

Throttle: events ≥250 ms apart; none while the mean window rms is silent.
Each event snapshots a short fingerprint from the last ~0.9 s of frames
(`buildFingerprint` on that slice) for the fragment.

## Fragments and placement — `js/grow.js` (new module)

- **Fragment:** the current mode's generator at `FRAGMENT_POINTS = 10_000`
  (7 000 mobile), `liveVariance: true`, `strandCount: 8`, requested through the
  existing live worker path (`liveGenerate`). Async: a fragment lands ~100 ms
  after its event.
- **Placement — golden-angle spiral bloom** (pure, node-tested):
  `placeFragment(index, fp)` returns `{ scale, position, rotY, rotX }`:
  - angle = `index × 2.39996` (golden angle);
  - radius = `0.12 + 0.95 × (1 − exp(−index / 22))` — core first, blooming
    outward, asymptotically interleaving near the rim;
  - scale = `0.10 + 0.22 × volMean` (loudness = size);
  - rotY = angle; rotX = `(pitchMedian − 0.5) × 1.2` (pitch tilts the form);
  - flat modes (cymatics/oscillo) place in the plate plane (y ≈ 0);
    volumetric modes may also lift y by `(pitchMedian − 0.5) × 0.5`.
- **Composite** (`GrowComposite`, pure bookkeeping + typed arrays):
  - CPU arrays `positions`, `attr`, `birth[]` per fragment; append transforms
    the fragment by its placement and re-uploads via a new renderer entry
    point (below).
  - **Cap:** `GROW_MAX_POINTS = 1_200_000` desktop / 400 000 mobile. In
    `grow-fade`, appending past the cap drops the oldest fragments; in
    `grow-keep` it stops adding and sets a status hint once.
  - **Fade:** in `grow-fade` a once-per-second pass recomputes per-point
    weights `w = 0.5^(age / HALF_LIFE)` (`HALF_LIFE = 180 s`); fragments with
    `w < 0.04` are dropped.

## Renderer — `js/density.js`

- **Per-point weight attribute** `aWeight` on the splat geometry, multiplying
  splat intensity in `SPLAT_VERT`/`SPLAT_FRAG` alongside the existing cloud
  `uWeight`. Defaults to 1 (a shared unit buffer when absent), so capture,
  record, morph and export paths render pixel-identically.
- `setGrowCloud(positions, attr, weights)` — like `setCloud` but with the
  weight buffer; safe to call ~1×/s with growing arrays.
- `setDrawProgress(t)` — sets `drawRange(0, t × count)` on the active cloud
  (draw-in mode); `t = 1` restores full range. Generators already emit points
  in structural order (shell by shell, ring by ring), so the sweep reads as
  the design drawing itself.

## Conductor — `js/live.js`

- `growthMode` field (`'morph' | 'grow-fade' | 'grow-keep' | 'draw-in'`), set
  from the UI via `setGrowthMode()`.
- `morph`: unchanged path.
- `grow-*`: the structural morph scheduler is **disabled**; instead the
  `NoteEventDetector` drives fragment requests → `GrowComposite.append` →
  `renderer.setGrowCloud`. Instant layer (breathing, kick, colour) unchanged.
- `draw-in`: morph scheduler unchanged, but instead of `crossfadeTo`, the new
  cloud enters with `setDrawProgress` ramped from 0 at a rate
  `dt × (0.15 + 2.5 × rms)` (loudness draws faster) while the old cloud's
  `uWeight` ramps down over the same period.
- **Freeze:** in grow modes, freeze captures the composite as-is — the
  captured state receives the on-screen arrays (no full-density regen; the
  design is the session's history). Palette/exposure and exports work on it;
  geometry sliders that trigger `regenerate()` will replace the composite
  (accepted limitation, status hint mentions it once).
- **Clear:** wipes the composite (existing clear path).

## Performance

- Fragment generation: 10K points ≈ ≤30 ms in the live worker — off-thread.
- Append re-upload at ≤1.2 M × 3 floats ≈ 14 MB ≈ few ms, ~1×/s — fine.
- Fade pass: one Float32Array rewrite + upload per second.
- Draw-range animation: free.

## Error handling

- Worker failure → fragment silently skipped (conductor logs to status only
  on repeated failure).
- Fragment arriving after mode/growth switch or Clear → discarded (generation
  id check).
- Cap reached in `grow-keep` → one-time status hint.

## Testing

Node (`test/grow.test.js` + additions to `test/live.test.js`):
- `NoteEventDetector`: onset fires; new held pitch class fires; sustain fires
  at ~500 ms cadence; 250 ms throttle; silence fires nothing.
- `placeFragment`: deterministic; radius monotonic → asymptote ≤ 1.07; scale
  bounded; golden-angle spacing.
- `GrowComposite`: append transforms and grows arrays; cap behaviour per mode
  (drop-oldest vs stop); fade weights halve at HALF_LIFE and prune below 0.04.
- Conductor: grow mode disables structural morphs; events request fragments
  with `liveVariance: true`; stale fragments discarded after clear.
- Draw-in pacing: progress integrates with rms; reaches 1; old-cloud weight
  reaches 0.

Browser acceptance (the point of this build): user tests all three modes
locally against morph, picks direction.

## Decisions log

| Question | Decision |
|---|---|
| Growth model | Build all three (accumulate+fade, accumulate-keep, draw-in) behind a Growth selector; morph stays default |
| Placement | Golden-angle spiral bloom from the centre; loudness = size, pitch = tilt |
| Freeze in grow modes | Captures the composite as-is (no full-density regen) |
| Events | Onset ∪ new-note ∪ sustain, ≥250 ms apart |
