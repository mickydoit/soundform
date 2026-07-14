# Oscillo Mode (Timbre Replacement) — Design

**Date:** 2026-07-14
**Status:** Approved by user (conversation), pending spec review

## Goal

Replace Timbre mode with **Oscillo** — a waveform mandala that draws the recording's actual timeline instead of synthesising from fingerprint statistics. Time spirals outward from the centre as concentric rings; each ring is one time-slice whose wave pattern encodes that moment's pitch, loudness, and texture. The whole recording is legible centre → rim like tree rings.

## Constraints

- New file `js/generators/oscillo.js`; delete `js/generators/timbre.js` (registry entry, mode button, tests). Attractor/Cymatics/Harmonic/Radial and `js/density.js` untouched.
- Standard generator contract: `generate(fp, params, onProgress)` → `{ positions, attr, strands }`; ≥ density/2 points; attr ∈ [0,1]; ≥24 strands; bounded; deterministic from `fp`.
- Ships on branch `oscillo` AFTER export-settings ships; gated on user look-check; cache bump at ship (v=29 if exports took v=28).

## Data

- `fp.trajectory` becomes 4 channels per frame (was 3): `[centroid, rms, spread, pitchNorm]` — capture loop in `js/main.js` adds normalised pitch (`log2(pitchHz/55)/6`, 0 when unvoiced) per frame. Trajectory already flows to the worker via the fingerprint payload; no worker changes.
- Trajectory is resampled to the ring count; missing/empty/3-channel trajectory (old shape) degrades to smooth concentric circles — no crash (backward-compatible guard).

## Geometry

- **Rings:** `rings = 90 + round(complexity · 90)` (90–180), resampled from trajectory. Ring i (t = i/rings): time position.
- **Dome:** rings sit on a shallow watch-glass dome — `y = domeH · (1 − t²)` with `domeH ≈ 0.35`; base ring radius grows `0.15 → 1.0` with t.
- **Per-ring wave:** radius wiggle `amp · sin(k·φ + phase)` where:
  - `k` (integer cycles) from that frame's pitch: 4 (low) → ~48 (high); unvoiced → k from centroid instead
  - `amp` from frame rms (0 → ~0.12 of base radius); loudness also lifts the ring off the dome (`y += rms · 0.15` bas-relief)
  - texture jitter: per-point radial noise scaled by frame spread (fray on noisy moments, same spirit as harmonic dash-fray)
  - `phase` seeded via `mulberry32(fp.seed)` per ring
- **attr:** frame rms (loud rings glow through the palette).
- **Strands:** one per ring (200-pt resample) → SVG is a stack of editable circles; plotter-friendly.
- **Points:** density budget spread evenly across rings, sampled at random φ along each ring with the standard 0.0035 jitter.
- Symmetry/twist params apply via the shared `finalize` (unchanged).

## Tests

- `checkGenerator('oscillo')` contract (with a test trajectory in the fixture).
- Loud vs quiet trajectory → different geometry (positions differ).
- Different pitch channel → different ring wave counts (geometry differs).
- Missing / empty / 3-channel trajectory → finite output, smooth circles, no crash.
- `registeredModes()` excludes `timbre`, includes `oscillo`.

## Ship order

1. `export-settings` branch (spec: 2026-07-14-export-settings-design.md) — user export checklist gate.
2. `oscillo` branch — user look-check gate (hum / beat / whistle / speech recordings read differently centre→rim).
