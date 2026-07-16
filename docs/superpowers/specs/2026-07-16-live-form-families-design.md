# Live form families — design

**Date:** 2026-07-16 · **Cache:** bump to `?v=33`

## What

Live Mode designs currently feel samey: every morph regenerates in the selected
mode, and each mode has a strong fixed silhouette that the fingerprint only
bends slightly. This project makes each mode a **family of radically different
forms** — selected and shaped by the character of the incoming sound — while
leaving the capture/record/upload flows **bit-identical to today**.

User decisions:

- **Within-mode variance only** — no auto mode-switching; the user's mode
  choice stands.
- **Live Mode only** — a `liveVariance` flag; non-live generation is untouched.
- **Radical departure allowed** — a mode may stray far from its signature
  silhouette (radial need not always read as a mandala).

## Architecture

### 1. Flag threading

- `LiveConductor.generate(...)` (js/live.js) adds `liveVariance: true` to the
  params object it already sends.
- The worker protocol passes `params` opaquely (js/worker.js) — **no protocol
  change**. Generators check `params.liveVariance`.
- Capture, record, and upload paths never set the flag; their output is
  unchanged (pinned by a snapshot test).

### 2. Archetype selector — `formArchetype(fp)` in `js/generators/common.js`

Returns `{ index, wildness }`. (Every mode has exactly three archetypes, so
the selector is a fixed 3-way bucket — no `n` parameter.)

- **`index` (0 tonal-smooth · 1 bright-piercing · 2 rough-noisy):** picks the
  strongest of three character scores blended from **timbre + harmony**
  — centroid, spread, consonance, velocity, pitchMedian. Each generator maps
  the three characters onto its three forms. Driven by sound character,
  **not** `fp.seed`: a steady
  sound keeps its archetype across successive morphs; speech vs whistle vs
  music land in different archetypes.
- **`wildness` (0–1):** continuous range-widener from dissonance
  (`1 − consonance`), `volVar`, and `attackSlope`. Scales how far parameters
  swing inside the chosen archetype.
- Pure function of the fingerprint → node-testable.

### 3. Form families per generator (additive, gated on `params.liveVariance`)

| Mode | Archetypes |
|---|---|
| **Radial** | *tight mandala* (today's look) · *asymmetric bloom* — broken golden-angle symmetry, off-centre shells, large wobble · *scattered ring field* — shells detach into separated rings with wide tube scatter |
| **Harmonic** | *smooth shell* (low crumple) · *spiky crumple* — crumple amplitude + burst rays pushed beyond current caps · *open petal net* — sparse coarse net, petal interference dominant, holes allowed |
| **Oscillo** | *ring mandala* (today) · *unravelled ribbon* — rings unwrapped into stacked travelling waveform bands · *shattered orbit* — rings broken into scattered arcs |
| **Cymatics** | when `cymStyle === 'auto'`, the three existing styles (scope/sand/relief) become the sound-selected archetypes; `wildness` scales the existing kr/amp variance |
| **Attractor** | already a 5-system family (`pickSystem`); `wildness` widens system-parameter jitter; the ≥400-cell occupancy check still rejects limit-cycle collapse |

Without the flag every generator takes exactly its current code path.

### 4. Morph trigger hears timbre

`fingerprintDelta(a, b)` (js/live.js) gains timbre terms:

```
+ 0.35 · |a.centroid − b.centroid|
+ 0.25 · |a.spread   − b.spread|
```

so a change in sound *character* (speech → whistle) triggers a structural morph
— and hence an archetype flip — even when the note set barely moves.
`MORPH_THRESHOLD` stays 0.18 unless tests show thrash; the 1.5 s
`MORPH_MIN_INTERVAL` already bounds regen rate, and tests pin that steady
speech does not oscillate archetypes.

### 5. UI fix — Cymatics style dropdown visibility

The `#sel-cym-style` row currently shows in every mode (bug: it reads
"Cymatics style: Relief" under Harmonic). Hide the row unless the selected
mode is `cymatics`, in and out of live, updating on mode switch.

## Error handling

- Archetype code paths run inside the worker like today; live worker errors
  already fall back to an inline `generate(fp, p)` call in `liveGenerate`
  (js/main.js) with the same live params, so the flag and archetype behaviour
  survive the fallback.
- Attractor occupancy-retry loop caps attempts as today; on exhaustion it falls
  back to the least-wild parameter set rather than failing the morph.

## Testing (node suite)

1. `formArchetype`: deterministic; same-character fingerprints → same index;
   distinct timbre profiles (speech/whistle/tonal-music fixtures) → distinct
   indices; wildness bounds ∈ [0, 1].
2. Per generator: with `liveVariance`, different archetype indices produce
   measurably different geometry (position-distribution stats differ beyond a
   floor; bounds stay sane); strand output remains valid.
3. Snapshot: without the flag, generator output for a fixed fingerprint is
   byte-identical to current behaviour.
4. `fingerprintDelta`: timbre-only change crosses threshold; steady-speech
   fixtures stay under it (no archetype thrash).

Manual browser acceptance: live session where whistling, speech, and music
visibly land in different forms per mode; capture still lands in the normal
captured state; Cymatics style row hidden outside Cymatics mode.

## Decisions log

| Question | Decision |
|---|---|
| Variety type | Deeper within-mode variance (no auto mode-switching) |
| Scope | Live Mode only — `liveVariance` flag; capture/record identical |
| Departure | Radical — archetypes may break the mode's signature silhouette |
| Approach | A: form families inside each generator + shared `formArchetype` selector |
| Extras | Timbre terms in `fingerprintDelta`; hide Cymatics style row outside Cymatics |
