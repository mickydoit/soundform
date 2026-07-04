# Cymatics Mode (replaces Spectral) — Design Spec

**Date:** 2026-07-04 · **Status:** approved in conversation (water-mandala direction)

## Goal

Replace the Spectral mode with a Cymatics mode: standing waves on a circular membrane rendered as a luminous water-mandala relief. Same generator interface `generate(fp, params, onProgress) → {positions, attr, strands}`.

## Sound → figure mapping

- Each detected note (pitch class) = one membrane mode: pitch class → petal count `m = 2 + (pc % 7) + round(complexity·3)`; chord position → ring wavenumber (fraction of `kBase`); chroma weight → mode amplitude.
- `pitchMedian` → `kBase` ring fineness (6–16 + complexity·8).
- `volMean` → relief depth (0.22–0.47).
- `consonance` → petal phase alignment; dissonance detunes mode phases from the seed (asymmetric mandala).
- `velocity` → *subtle* droplet spray above crests (≤0.015 world units — restraint per the fuzz feedback).
- Radial profile: damped cosine `cos(k·r − m/2)/√(1 + k·r/2)` — a visually faithful Bessel-mode stand-in.

## Sampling & rendering

- Monte Carlo over the unit disc (`r = √u` uniform); acceptance `max(|f|^1.4, 0.08)` — crests dense and glowing, troughs sparse dust; the 0.08 floor guarantees ≥50% fill for the test invariant. Height `y = f·relief` (+ spray·|f|).
- `attr = clamp(|f|)` — palette follows wave amplitude (troughs dark end, crests bright end).
- Deterministic: all randomness via `mulberry32(fp.seed)`.

## Strands

Crest rings: 12–20 closed curves at evenly spaced radii, each tracing the local wave height (petal-modulated circles), plus radial spokes to fill the strand budget (24–96). Both follow the same field, so SVG exports are true mandala line-art.

## Integration surface

- Create `js/generators/cymatics.js`; delete `js/generators/spectral.js`.
- `js/generators/index.js`: registry key `spectral` → `cymatics`.
- `index.html`: mode button `data-mode="spectral"`/label Spectral → `data-mode="cymatics"`/label Cymatics.
- `test/generators.test.js`: spectral test → cymatics via existing `checkGenerator` (bounded, ≥ density·0.5 points, deterministic, ≥24 finite strands).
- Untouched: attractor (locked), chladni, radial, timbre, renderer, main.js, worker.js, audio, exporter.

## Verification

`npm test` all green; browser check: mandala reads clearly top-down, gentle relief when tilted, crisp at default Grain 1.0; SVG export opens as ring/spoke line-art.
