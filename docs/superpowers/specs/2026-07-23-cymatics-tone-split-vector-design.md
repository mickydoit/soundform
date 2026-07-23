# Cymatics tone-split fine-fringe vector export — design

**Date:** 2026-07-23
**Status:** Approved by user (approach + design sections)

## Problem

Cymatics SVG/PDF exports don't look like the on-screen design. The raster is a
~600K-point rejection-sampled cloud: fine concentric fringes (`kFine ≈ 140–220`
radial oscillations), dark nodal voids between petals, and strong tonal
contrast (bright cream crests, deep blue mids, near-black voids). The current
vector export is at most 96 uniform rings broken into ~300 arc strokes with
gradient colouring — no fine fringes, no tonal variation along a ring, and far
too sparse to read as the same design. User comparison (real export
`soundform (3).svg` vs on-screen screenshot) confirms the export reads as loose
wavy contour lines, not the dense striated mandala.

## Requirements (from brainstorm)

- Cymatics only; both SVG and PDF.
- Export must be **editable and animatable** in Illustrator/Figma: layered
  groups, moderate element count, full path control, easy recolouring.
- **Transparent background** — no background rect; strokes alone carry the
  fringe/void/tonal look.
- Budget ≈ **2–5K paths** per typical design, tone-split (opacity/colour varies
  along each ring like the raster).
- No change to the point cloud, raster look, or golden snapshots.

## Approach (chosen: A)

Extend the cymatics generator's strand output to fine fringe rings that carry a
per-run **tone** value, and teach the shared vector-path builder to style
tone-carrying strands from the palette the way the raster tonemap does.
Rejected: export-time re-render (duplicates field math → drift risk) and
iso-contour extraction (different aesthetic, not screen fidelity).

## Design

### 1. Strand data model (`js/strands.js`)

A strand is either:

- a bare `Float32Array` of xyz triples — legacy form, all other generators,
  styling unchanged (density-grid gradient, per-strand `<linearGradient>`); or
- `{ pts: Float32Array, tone: number, band: number }` — `tone` = the run's
  mean normalized field amplitude (0–1), `band` = radial band index 0–7
  (`Math.floor(r0 * 8)`, clamped to 7).

`buildVectorPaths()` normalizes both forms (`const pts = strand.pts ?? strand`).
Tone-carrying strands skip the density grid and get:

- **Colour:** tone quantized to **5 discrete classes**; each class samples the
  design's palette ramp at a fixed position mirroring the raster tonemap
  (low tone → deep-blue end, high tone → bright-cream end). Flat stroke colour,
  no gradient — Illustrator "Select → Same → Stroke Color" selects a whole
  tonal class.
- **Opacity:** rises with tone (faint at petal edges, opaque at crests).
- **Width:** thin hairlines overall (fringe rings sit close together), rising
  slightly with tone, scaled by the existing export weight setting.

Items still sort painter's-order by depth alongside legacy strands.

### 2. Generator (`js/generators/cymatics.js`)

- Rings are placed **at bright-fringe radii** — the peaks of the same
  `cos(kFine · r)` term that draws the on-screen striations (~45–70 rings
  depending on pitch) — instead of 24–96 uniformly spaced radii.
- Each ring keeps the existing amplitude bulge (`RING_AMP_GAIN`) and the
  smoothed void-gap logic (`VOID_CUTOFF`, `VOID_SMOOTH_WINDOW`, `visibleRuns`).
- Runs are additionally **split at tone-band boundaries** (the 5 quantized
  levels of smoothed amplitude), with a minimum run length; sub-minimum
  fragments merge into their neighbour rather than emitting slivers.
- Each surviving run emits `{ pts, tone, band }` (tone = mean smoothed
  amplitude over the run; full-visibility unbroken rings still close their
  loop).
- **Strands slider** maps to the fraction of the fringe set emitted: minimum →
  sparse skeleton (roughly today's density), maximum → full fringe set.
- A total-path cap keeps worst-case output ≤ ~5K paths (drop alternate rings
  if the estimate exceeds the cap).
- Point-cloud sampling (`positions`/`attr`) is untouched; ring building uses
  no `rnd()` calls, so the RNG stream and golden snapshot checksums are
  unaffected.

### 3. Exporters (`js/exporter.js`)

- **SVG:** tone strands group into `<g id="band-01">` … `<g id="band-08">`
  (inner → outer); each path has a flat `stroke`, `stroke-width`, `opacity`,
  and a `data-tone="1..5"` attribute. No `<defs>` gradients for tone strands.
  Legacy strands keep the exact current markup.
- **PDF:** tone strands draw as a **single flat-colour run** per path (colour
  from the tone class) via the existing `lines()` machinery; legacy strands
  keep the 6-segment gradient-approximation runs.
- No background element in either format (transparent requirement); the
  existing `background` parameter keeps working for legacy callers.
- Cache-bust: v=43 → v=44 across all versioned files (project convention:
  every `?v=NN` moves together; `js/generators/*` files stay unversioned).

### 4. Testing & verification

- Unit tests: tone-band run splitting (boundaries, min-run merging,
  wraparound), `buildVectorPaths` styling for both strand forms, band
  grouping, path-cap behaviour.
- Updated cymatics strand test: strands carry `tone`/`band`, ring radii sit at
  fringe peaks (count in expected range), voids still break rings.
- Project-standard E2E before completion: headless Chromium, real audio
  through the UI, Cymatics mode, export SVG and PDF via the real UI buttons,
  rasterize both (screenshot / pdf.js), and visually compare against the
  on-screen render.

## Out of scope

- Other modes' exports (radial/harmonic/oscillo/attractor) — unchanged.
- Dot-grain stipple layer (declined in favour of stroke-only within budget).
- Background rect / dark-ground export option.
- Fine *radial* striation strands (deferred from the previous session remains
  deferred).
