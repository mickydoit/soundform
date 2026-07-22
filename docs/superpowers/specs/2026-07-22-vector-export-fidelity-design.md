# Vector export fidelity (SVG + PDF) — design

**Date:** 2026-07-22

## What

Two problems with vector export today:

1. **PDF is a raster embed, not a vector.** `exportCanvas`'s `'pdf'` case
   (`js/exporter.js:18-31`) rasterizes the WebGL canvas to JPEG via `_onBlack`
   and drops it into a jsPDF page with `addImage`. It doesn't stay crisp at
   zoom and can't be edited as paths.
2. **SVG/PDF don't faithfully match the design**, for two separate reasons:
   - Classic strand designs: `main.js:534-538` silently **drops any strand**
     whose RDP-simplified path exceeds 300 points, so complex/detailed
     strands can vanish from the export entirely.
   - Paint-mode captures (the current default Live growth mode) can't export
     as vector **at all** — `design.strands` is hardcoded to `[]` on freeze
     (`main.js:330`), and `main.js:530-532` blocks SVG/PDF with a "create a
     shape design" message whenever `design.strands.length === 0`.

Goal: SVG and (new) vector PDF export should show every stroke visible in
the app, in the app's colors, for both classic designs and Paint captures —
without attempting to reproduce the WebGL glow/grain post-processing (not
required; strokes + color only).

## Non-goals

- Matching the shader's glow/bloom/grain look in vector output.
- Changing raster (PNG/JPG/WebP) or MP4 export — those already re-render the
  real WebGL pipeline via `renderHiRes` and are out of scope.
- Any change to how Paint mode paints, steers, or is capped (`js/paint.js`,
  `js/live.js` live-painting behavior stays behavior-identical — see
  "Constraints" below).

## Constraints

The user has an open, separate concern about Paint mode (pause/resume +
post-freeze slider fidelity) and does not want this export work to touch how
Paint behaves. This design only **reads** data Paint already produces
(`out.strands` from reveal generation, the time-ordered point buffer from
`getPaintSlice`) — it does not change pacing, steering, budgets, or the
freeze/regen/clear behavior of Paint mode itself.

## Architecture

New pure, DOM/THREE-free functions added to `js/strands.js` (same module the
existing `projectStrand`/`rdp`/`toBezierPath`/`buildDensityGrid` live in, and
which is already node-tested without a browser):

```
buildVectorPaths({ strands, positions, mvp, width, height, stops, weight })
  -> [{ order, depth, density, points, c1, c2, x1, y1, x2, y2 }]
```

`points` is the simplified 2D point list (absolute, screen space) for one
stroke; `c1`/`c2` are its resolved start/end hex colors from the palette
ramp (same `sampleRamp`/density mapping used today). This is the single
source of truth both exporters format from.

- `exportStrandSVG` (`js/exporter.js`) becomes a thin formatter: call
  `buildVectorPaths`, turn `points` into a bezier `d` string via
  `toBezierPath`, wrap in `<path>` + `<linearGradient>` per stroke — same
  markup shape as today, just fed from the shared builder instead of doing
  projection/simplification inline.
- New `exportStrandPDF({ ...same args..., docFactory })` in `js/exporter.js`
  consumes the same `buildVectorPaths` output and draws with jsPDF's core
  `doc.lines()` API, which accepts bezier-curve segments as relative deltas
  natively — no image embed, no new dependency (jsPDF is already loaded via
  the existing `<script>` tag). Background becomes a filled vector rect
  (`doc.rect(...,'F')`) instead of `_onBlack`'s raster composite.
  - jsPDF strokes are flat-color, not gradients. Each stroke is split into
    short runs (~6 points) with solid color interpolated between `c1`/`c2`
    along the run's position — reads as a gradient without a plugin.
  - Page sizing (mm, orientation from aspect ratio) unchanged from the
    current PDF case in `exporter.js`.
- `main.js`'s `'pdf'` export handler moves from the raster branch (currently
  shares code with png/jpg/webp at `main.js:597-607`) to the same
  strand-gathering branch as `'svg'` (`main.js:528-567`), calling
  `exportStrandPDF` instead of `exportStrandSVG`. Both formats now go through
  identical strand-gathering/motion-displacement logic — no divergence
  between what SVG and PDF export.

## Fixing the strand-drop bug

Replace the hard drop in `main.js:534-538` (`if (simplified.length > 300)
return`) with adaptive simplification inside `buildVectorPaths`: start RDP at
`epsilon = 1.4` as today; if the simplified point count is still over a
budget (500), multiply epsilon by 1.3 and re-simplify, up to 6 attempts, then
accept whatever epsilon gets to (never drop the stroke). Dense/detailed
strands get coarser at the vertex level but stay visible.

## Paint-capture path recovery

Two Paint sub-modes need different treatment, both **read-only** against
existing Paint internals:

**Reveal-based Paint** (Radial/Harmonic/Oscillo/Cymatics under Growth:
Paint) — `LiveConductor._requestReveal` (`js/live.js:182-205`) already calls
the real design generator and gets back `out.strands`; today only
`out.positions`/`out.attr` are kept (written to the canvas) and `out.strands`
is discarded. Change: store the latest `out.strands` on `this.paint.strands`
alongside the existing `st.revealTotal`. On `freeze()`
(`js/live.js:301-309`), when `st.brush` is null (reveal-based, not the
attractor orbit brush), clip `st.strands` to `st.count`: walk strands in
order accumulating point counts, keep whole strands under the boundary,
truncate the strand straddling `st.count` to its first N points, drop any
strand entirely beyond it. Attach as `out.cloud.strands`.

**Attractor-brush Paint** — `createOrbitBrush` (`js/generators/attractor.js`)
has no discrete strands; it's one continuously-steered orbit. But
`LiveConductor._paintTick` (`js/live.js:140-146`) writes each chunk via
`renderer.writePaintPoints(st.count, ...)` at strictly increasing offsets,
so the point buffer returned by `getPaintSlice` is already in stroke-time
order — it IS a path, just not chunked. Change: record the point index at
each `steer()` call (`js/live.js:174`) into `st.segments` (starts at `[0]`).
On freeze, slice the ordered position buffer into segments at those
boundaries and treat each segment as one strand for `buildVectorPaths`
(bounds a single segment's RDP/adaptive-simplify cost instead of running it
over one 200-600K-point strand).

**`main.js` freeze handler** (`main.js:327-335`): `design.strands` is set
from `out.cloud.strands || []` instead of always `[]`. Everything downstream
(SVG/PDF gathering at `main.js:528-567`) already operates on
`design.strands` generically — no further changes needed there beyond
swapping which exporter function gets called for `'pdf'`.

## Error handling

- No strand is ever silently dropped from vector export — worst case is
  coarser simplification.
- The "create a design first" / "SVG needs a shape design" guard
  (`main.js:529-532`) still fires for a genuinely empty design (e.g. frozen
  before any points were painted), but no longer fires just because the
  capture came from Paint mode. Wording updates from "SVG needs a shape
  design" to something format-agnostic since it now also gates PDF.

## Testing

All new logic lives in the existing node-testable, DOM-free layer
(`js/strands.js`, plus pure helpers in `js/live.js`'s freeze path):

- Adaptive simplify: a synthetic high-frequency strand that RDP can't get
  under 300 pts at epsilon 1.4 → assert the stroke is present in output and
  under the 500-pt budget.
- Strand clipping: known per-strand lengths + a `st.count` boundary
  mid-strand → assert earlier strands intact, the boundary strand truncated
  to the right length, later strands excluded.
- Attractor segment slicing: synthetic `st.segments` + position buffer →
  assert correct per-segment slices.
- PDF bezier formatting: round-trip check that cumulative sums of the
  relative deltas passed to `doc.lines()` reconstruct the same absolute
  points `toBezierPath` uses for SVG, for a shared fixture path.
- Existing 251-test suite must stay green; extend the SVG export test(s)
  with a >300-point strand case that previously vanished.
