# Trace vector export — design

**Date:** 2026-07-24
**Status:** approved, ready for planning

## Problem

Vector exports don't resemble the design on screen. Strokes in the exported
SVG/PDF all read at roughly the same width, while the rendered design has
clearly varying definition — some strokes bold and bright, others faint.

The immediate cause is in `buildVectorPaths()` (`js/strands.js`): each strand
samples the density grid every 10th point and then **averages** those samples
into a single number, which sets one width for the strand's entire length.

```js
const density = dN ? dSum / dN : 0.3;   // averaged over the WHOLE strand
strokeWidth: (0.6 + density * 3.4) * weight,
```

Variation *along* a strand is discarded entirely, and strand-to-strand
variation is flattened. (Cymatics tone strands are the exception — they
already split into runs with five quantised width classes.)

The deeper issue is that strands are a sparse skeleton, while the on-screen
look comes from a dense log-density point cloud rendered as a glow field.
Tracing strands more carefully narrows the gap but never closes it.

The user's framing: the export should be "an editable tracing of the design",
comparable to Illustrator's Image Trace.

### How Illustrator's Image Trace works

Researched to inform the approach. Image Trace posterizes the image into
regions of near-uniform colour, detects region boundaries by contrast
threshold, then least-squares-fits bezier curves to those boundaries. The
UI parameters map onto that: *Paths* is the curve-fit tolerance, *Corners*
the corner-detection threshold, *Noise* the minimum surviving region size.

It then has two output modes:

- **Outline / fill tracing** (default) — boundaries become *filled* paths.
  This is why traced art shows convincing thick-and-thin lines: the varying
  thickness is a filled shape, not a stroke.
- **Centerline tracing** (the "Strokes" checkbox) — skeletonises regions and
  emits stroked open paths, at essentially one stroke width.

Sources:
- <https://patents.google.com/patent/US7515745> (planar map from raster image)
- <https://patents.google.com/patent/US7876932> (representing a raster area by a centerline)
- <https://www.scan2cad.com/blog/cad/vectorize-using-illustrator/>

## Decision

Implement a genuine raster trace — posterize + contour-trace — rather than
improving strand styling.

An alternative was considered and rejected: sampling density *per point* along
each strand to build a true width profile, then emitting either stepped stroke
runs or variable-width filled ribbons. That is cheaper and keeps small,
stroke-editable files, but it remains line-art derived from the sparse
skeleton and would not reproduce the glow, grain, or tonal mass of the render.

The tracer works purely from pixels, so it also works for designs that have
**no strand geometry at all** — notably attractor Paint captures, which
currently cannot be vector-exported.

## Scope

A third vector export path, **Trace**, sitting alongside the existing strand
SVG/PDF export with its own buttons and its own settings. The existing strand
exporter and all its per-mode tuning are untouched.

Concretely, two new buttons join the existing `.btn-export[data-fmt]` row,
following that established pattern:

```html
<button class="btn-export" data-fmt="trace-svg">Trace SVG</button>
<button class="btn-export" data-fmt="trace-pdf">Trace PDF</button>
```

Both share the same four trace settings and the same worker run; they differ
only in which builder consumes the resulting tracedata. The existing `svg` and
`pdf` buttons keep their current strand behaviour unchanged.

Out of scope: EPS output; changing the strand exporter; any change to Paint
mode behaviour.

## Architecture

```
renderer.renderHiRes(scale, { transparent })
   → canvas → ImageData
   → paletteFromRamp(stops, levels)                  ← palette-locked
   → ImageTracer.imagedataToTracedata(imgd, opts)    ← in a worker
   → tracedata { layers[], palette[] }
   ├→ buildTraceSVG(tracedata)     → one <g id="tone-NN"> per level
   └→ buildTracePdfOps(tracedata)  → jsPDF filled paths
```

This mirrors the existing separation between `js/strands.js` (pure, DOM-free,
node-testable path building) and `js/exporter.js` (format wiring).

### New files

| File | Purpose |
|---|---|
| `js/trace.js` | Pure, DOM-free: `paletteFromRamp`, `buildTraceSVG`, `buildTracePdfOps`, `qToCubic`. Node-testable. |
| `js/traceworker.js` | Module worker. Receives ImageData, traces level by level, posts `{ progress, level }`, returns tracedata. |
| `js/vendor/imagetracer.js` | Vendored imagetracerjs + a one-line ESM export shim (the library is UMD). |

### Modified files

- `index.html` — Trace button, four settings rows, progress panel.
- `js/main.js` — button binding, trace params, progress/cancel wiring.
- `js/exporter.js` — `exportTraceSVG`, `exportTracePDF`.

### Library choice

**imagetracerjs**, vendored. Public domain (the Unlicense), browser-native,
performs its own colour quantization, exposes `imagedataToTracedata()` for the
pre-SVG intermediate, and accepts a custom palette via the `pal` option.

The `potrace` JavaScript ports were rejected: they are GPL-licensed, which is
awkward for a GitHub Pages–hosted app.

`js/worker.js` is already instantiated with `{ type: 'module' }`, so a module
worker is the established pattern in this codebase.

## Palette locking

`paletteFromRamp(stops, levels)` builds N swatches from the active ramp using
the existing `sampleRamp()`. Those are handed to imagetracer as `pal`, with
`colorsampling: 0` so the library uses the supplied palette verbatim instead
of deriving its own by k-means. Pixel-to-swatch assignment is imagetracer's
own nearest-colour step; `js/trace.js` owns only palette construction.

The result is that a given design plus palette traces to the same colours
every time, and every colour in the output is one that exists in the app.

Each level becomes its own `<g>`, so Illustrator's *Select → Same → Fill
Colour* selects a whole tonal band.

**Background handling.** The background swatch is excluded from tracing and
emitted as a single `<rect id="background">`; when Transparent background is
ticked it is omitted entirely. Without this the backdrop traces into one
enormous blob underneath everything.

## Settings

All four are exposed in the Export panel.

| Control | Values | Maps to |
|---|---|---|
| Trace levels | 4 / 6 / **8** / 12 | palette swatch count |
| Trace detail | Draft / **Balanced** / Fine | `ltres`, `qtres` |
| Trace resolution | 1200 / **2000** / 3000 px long edge | `renderHiRes` scale |
| Trace smoothing | Low / **Medium** / High | `pathomit`, `blurradius` |

Defaults in bold.

Smoothing matters more than it appears: the density renderer applies grain,
and untreated grain traces into thousands of speckle paths. `blurradius`
removes it before quantization.

These are independent of the existing raster Export resolution picker. The
existing Transparent background checkbox applies to the trace.

## PDF specifics

imagetracer emits **quadratic** segments; jsPDF's `lines()` takes cubics.
The conversion is exact:

```
C1 = P0 + (2/3)(Q - P0)
C2 = P2 + (2/3)(Q - P2)
```

Each of the three delta pairs is computed **relative to the segment start**,
matching jsPDF's actual `lines()` behaviour — not chained to one another.
This is the same encoding that caused the 2026-07-23 bezier-delta bug
(`cf8500b`); the test must reconstruct the way jsPDF actually does, or it will
self-validate a wrong assumption exactly as the previous one did.

Paths are filled (`'F'`), not stroked, with one `setFillColor` per level.
Page sizing reuses the existing mm logic from `exportStrandPDF`.

## Concurrency

The trace runs in a Web Worker with a progress readout and a cancel button,
following the pattern the MP4 export already uses. A high-resolution,
many-level trace can take from several seconds to over a minute; blocking the
main thread that long freezes the canvas and can trigger the browser's
unresponsive-page warning.

The worker posts `{ progress, level }` after each level. Cancel terminates the
worker.

## Testing

**Node tests** on `js/trace.js`:

- `paletteFromRamp` is deterministic and returns exactly `levels` swatches,
  evenly sampled, for every supported level count.
- The background swatch is excluded from traced output.
- `buildTraceSVG` produces one group per level with stable `tone-NN` ids.
- `qToCubic` round-trips: reconstruct absolute points the way jsPDF's
  `lines()` actually does, and confirm every segment matches — not only the
  first of each run.

**Real-app E2E** in headless Chromium: real audio through the actual UI, real
Trace export via the real buttons, PDF rasterized back via pdf.js and compared
against the on-screen render. Unit tests did not catch either ship-blocker in
the tone-split work; E2E is required before this is considered done.

## Trade-offs and limitations

Accepted, and stated to the user before approval:

- Output is stacked filled tone-bands, not strokes. A global "make all lines
  thinner" edit is no longer possible; downstream editing means editing shapes.
- File sizes are substantially larger than strand exports. Twelve levels at
  3000px could reach several MB.
- The trace reflects the current on-screen camera framing, as the raster
  exports do.

## Conventions

- Cache-bust bumps `v=44` → `v=45` across **all** versioned files together, per
  project convention. Files under `js/generators/` carry no version query
  string and are excluded.
- `js/trace.js` must stay DOM-free and THREE-free so it runs under node.

## Prerequisite (done)

Local `main` was two superseded doc commits behind origin and carried an
uncommitted vector-export aspect-ratio fix. Both doc commits were verified
byte-identical to content already on origin before resetting.

The aspect fix landed separately as `727348d` on `fix/vector-export-aspect`:
`getMVP()` builds its projection at the container's aspect ratio, but the
export path projected into a hardcoded 1600×1200, so on any non-4:3 window the
design exported stretched. This branch is based on that fix.
