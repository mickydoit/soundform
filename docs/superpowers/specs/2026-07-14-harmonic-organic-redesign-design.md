# Harmonic Mode Organic Redesign — Design

**Date:** 2026-07-14
**Status:** Approved by user (conversation), pending spec review
**Reference:** harmonic-sphere.pages.dev (source previously analysed; maths and layer concepts reimplemented, no code copied)

## Goal

Harmonic mode currently produces smooth, symmetric "lathed vase" forms (dense latitude banding, pure Yₗᵐ displacement). Redesign it to produce organic, petal-like wireframes with real variance between designs — coarse mesh nets, radial burst fans, and dash-field fray — matching the retro/analogue/clean look of the user's reference screenshots, while staying fully audio-deterministic.

Out of scope: dot-bead treatment (considered, rejected); new UI; renderer changes; background changes (default stays near-black with the existing picker).

## Constraints

- Only `js/generators/harmonic.js` (and its tests) change. Attractor/Cymatics generators locked; `js/density.js` untouched this time.
- Deterministic: same fingerprint → identical output. All randomness via `mulberry32(fp.seed)` derivatives.
- Existing generator contract preserved: `generate(fp, params, onProgress)` → `{ positions, attr, strands }`, bounded, ≥24 strands, point count ≥ density/2.
- Strand SVG export stays real geometry, files ≤ ~1MB (cap dash strand count).
- Cache-bust bump on ship.

## Design

### 1. Deformation — vase → organic petals

Displacement `d(θ, φ)` = sum of three seeded ingredients:

1. **Yₗᵐ backbone (kept):** pitch → dominant degree l (3–9), noteSet → orders m, chroma → phases. Unchanged mapping, keeps the mode tonally meaningful.
2. **Interference waves (new):** 3–6 waves (count from dynamics), frequency `fᵢ = (i+1)·0.5 + seeded jitter(±0.2)`, each contributing `sin(fᵢ·φ·3 + fᵢ·θ·2 + phaseᵢ)·ampᵢ`. Wrapping both axes at different rates makes lobes collide asymmetrically → petals/pinches.
3. **Noise crumple (new):** deterministic 3D value noise (small hash-grid lattice + trilinear interpolation, 2–3 fractal octaves, seeded, DOM-free, implemented inside harmonic.js). Added as `(noise−0.5) · crumple`, where `crumple = 0.05 + fp.spread · 0.25` — pure tones smooth, breathy sounds ragged.

Total amplitude scaled to **0.25–0.55** of sphere radius by `volMean`/`velocity` (roughly double today's), so forms read as petals, not a bumpy ball.

### 2. Treatment recipe — audio-mixed variance

The density budget splits across three treatments; weights are the variance engine:

| Treatment | Role | Audio driver | Notes |
|---|---|---|---|
| **Mesh net** | Backbone, always ≥ ~55% of budget | complexity slider nudges resolution | 24–48 lat rings × 16–32 lon lines drawn as connected polylines — visible cells, not banding. Points sampled along the lines (tight jitter as today). |
| **Burst rays** | Percussive spikes | onsets/velocity → 0–~120 rays | Straight rays from centre to 1.2–1.6× form radius, seeded directions. Rendered faint (low attr). Sustained hum → none. |
| **Dash field** | Noisy fray | spectral spread → proportion | Short strokes (0.05–0.12 long) scattered on the deformed surface, oriented along it. Clean tone → ~none; hiss/breath → heavy fray. |

Outcomes: sung note → pure clean mesh · beatbox → mesh + ray fan · breathy sound → frayed mesh · rich mix → all three.

### 3. Rendering, export, tests

- **attr:** mesh brightness follows |displacement| (petal tips glow) as today; bursts low on the ramp (faint); dashes mid.
- **Strands (SVG):** mesh polylines + rays (2-point strands) + capped dash sample (file ≤ ~1MB). Motion/MP4 need no changes — they operate on generator output.
- **Tests:** existing contract tests still pass (`checkGenerator('harmonic')`, pitch-variance, registry). New: high-onset fp → burst strands present, low-onset → none; high-spread fp → dash allocation, pure tone → ~pure mesh; value-noise determinism + range.

## Error handling / degenerate cases

- Zero-onset, zero-spread audio → pure mesh (valid, minimum treatment weights clamp to mesh-only).
- Value noise at lattice boundaries: hash wraps, no NaN; contract test asserts finite output.
- Dash/burst budgets floor at 0 and never starve the mesh below its minimum share.
