# Trace Vector Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a raster-trace vector export ("Trace SVG" / "Trace PDF") that posterizes the rendered design into palette-locked filled tone bands, alongside the existing strand SVG/PDF.

**Architecture:** Render the design to a canvas → ImageData; a Web Worker runs imagetracerjs's pipeline layer-by-layer (for progress) using a palette pre-built from the active ramp; the resulting tracedata is turned into a grouped SVG or a jsPDF filled-path document by pure builders in `js/trace.js`.

**Tech Stack:** Vanilla ES modules, no build step. Vendored `imagetracerjs` v1.2.6 (Unlicense, UMD) loaded into a **classic** worker via `importScripts`. jsPDF 2.5.1 (already loaded globally). Tests: `node --test`.

## Global Constraints

- No build step. Browser-native ES modules; `js/trace.js` must stay DOM-free and THREE-free so it runs under `node --test`.
- Cache-bust: every `?v=44` in `index.html` and `js/*.js` moves to `?v=45` **together** (25 occurrences across 8 files). Files under `js/generators/` carry no version string — leave them.
- The tracer library is Unlicense (public domain) — vendor it verbatim; do not GPL-license any port.
- imagetracer tracedata schema (verified against v1.2.6):
  - `tracedata = { width, height, layers, palette }`
  - `palette[k] = { r, g, b, a }` with values 0–255. `layers[k]` corresponds to `palette[k]`.
  - `layers[k]` is an array of path objects; each path has `.segments` and `.isholepath`.
  - `segments[i] = { type, x1, y1, x2, y2 }` where `type` is `'L'` (line to `x2,y2`) or `'Q'` (quadratic: control `x2,y2`, end `x3,y3`).
- imagetracer stage methods on the `self.ImageTracer` object (classic worker), exact signatures:
  - `colorquantization(imgd, options)` → `{ array, palette }`
  - `layeringstep(ii, cnum)` → 2D layer array
  - `pathscan(layerArray, pathomit)` → paths
  - `internodes(paths, options)` → internode paths
  - `batchtracepaths(internodePaths, ltres, qtres)` → array of `{ segments, isholepath }`
- `renderer.renderHiRes(scale, { transparent })` returns a **2D canvas** (already Y-flipped). Get pixels via `canvas.getContext('2d').getImageData(0, 0, w, h)`.
- Palette convention: `paletteFromRamp(stops, levels)` returns `levels` swatches with index `0` = background (ramp t=0). Quantization keeps it so background pixels snap to it; the SVG/PDF builders **skip layer index 0**. Background is instead emitted as one `<rect>` (or nothing, if transparent).

---

## File Structure

| File | Responsibility |
|---|---|
| `js/trace.js` (new) | Pure, DOM-free. `paletteFromRamp`, `qToCubic`, `segmentsToPdfLegs`, `buildTraceSVG`, `buildTracePdfOps`. Consumes hand-shaped tracedata; knows nothing about imagetracer. |
| `js/traceworker.js` (new) | Classic worker. `importScripts` the vendored lib, runs the pipeline layer-by-layer, posts `{progress, level, levels}` then `{done, tracedata}` (or `{error}`). |
| `js/vendor/imagetracer.js` (new) | Vendored imagetracerjs v1.2.6, verbatim. |
| `js/exporter.js` (modify) | `exportTraceSVG(tracedata, opts)` → SVG string; `exportTracePDF(tracedata, opts)` → builds jsPDF, saves. |
| `index.html` (modify) | Two buttons, four `<select>` rows, a progress panel. |
| `js/main.js` (modify) | Trace params, worker orchestration, progress/cancel wiring. |
| `test/trace.test.js` (new) | Unit tests for `js/trace.js`. |

---

## Task 1: Vendor imagetracerjs and add the cache-bust bump

**Files:**
- Create: `js/vendor/imagetracer.js`
- Modify: all files carrying `?v=44` → `?v=45`

**Interfaces:**
- Produces: a global `self.ImageTracer` / `window.ImageTracer` object (used only by the worker in Task 3).

- [ ] **Step 1: Vendor the library verbatim**

```bash
cd /Users/michaeldewet/Documents/Github/soundform
curl -fsSL https://raw.githubusercontent.com/jankovicsandras/imagetracerjs/master/imagetracer_v1.2.6.js -o js/vendor/imagetracer.js
```

- [ ] **Step 2: Verify it vendored and is the UMD build**

Run: `head -30 js/vendor/imagetracer.js && grep -c "self.ImageTracer = new ImageTracer" js/vendor/imagetracer.js`
Expected: license/version header printed; grep prints `1` (confirms the worker-global assignment exists).

- [ ] **Step 3: Bump every cache-bust token together**

```bash
cd /Users/michaeldewet/Documents/Github/soundform
grep -rl '?v=44' index.html js/*.js | xargs sed -i '' 's/?v=44/?v=45/g'
```

- [ ] **Step 4: Verify the bump is complete and consistent**

Run: `grep -rc '?v=44' index.html js/*.js | grep -v ':0' ; echo "remaining-v44-above"; grep -rl '?v=45' js/*.js index.html | wc -l`
Expected: nothing printed before `remaining-v44-above` (zero `?v=44` left); the count of files with `?v=45` is `8`.

- [ ] **Step 5: Run the full suite (nothing should break from a version bump)**

Run: `npm test 2>&1 | tail -5`
Expected: `pass 292`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add js/vendor/imagetracer.js index.html js/*.js
git commit -m "chore: vendor imagetracerjs v1.2.6, bump cache-bust v=44→v=45"
```

---

## Task 2: `js/trace.js` — palette builder + Q→C conversion

**Files:**
- Create: `js/trace.js`
- Test: `test/trace.test.js`

**Interfaces:**
- Consumes: `sampleRamp`, `rgbToHex` from `./palettes.js`.
- Produces:
  - `paletteFromRamp(stops, levels) → [{r,g,b,a}, …]` length `levels`, index 0 = background (t=0), values 0–255, `a` always 255.
  - `qToCubic(sx, sy, qx, qy, ex, ey) → [c1x, c1y, c2x, c2y]` — exact quadratic→cubic control points.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/trace.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteFromRamp, qToCubic } from '../js/trace.js';

const STOPS = [[0, '#000000'], [0.5, '#808080'], [1, '#ffffff']];

test('paletteFromRamp returns exactly `levels` swatches, index 0 = background', () => {
  const pal = paletteFromRamp(STOPS, 4);
  assert.equal(pal.length, 4);
  assert.deepEqual(pal[0], { r: 0, g: 0, b: 0, a: 255 });      // t=0 background
  assert.deepEqual(pal[3], { r: 255, g: 255, b: 255, a: 255 }); // t=1
});

test('paletteFromRamp is deterministic and evenly spaced', () => {
  const a = paletteFromRamp(STOPS, 6);
  const b = paletteFromRamp(STOPS, 6);
  assert.deepEqual(a, b);
  assert.equal(a.length, 6);
  // middle swatch (t≈0.6) sits between the 0.5 and 1.0 stops → grey ramp, all channels equal
  assert.equal(a[3].r, a[3].g);
  assert.equal(a[3].g, a[3].b);
});

test('qToCubic matches the exact quadratic elevation formula', () => {
  // start (0,0), control (2,4), end (4,0)
  const [c1x, c1y, c2x, c2y] = qToCubic(0, 0, 2, 4, 4, 0);
  // C1 = P0 + 2/3(Q-P0) = (4/3, 8/3); C2 = P2 + 2/3(Q-P2) = (4 - 4/3, 8/3) = (8/3, 8/3)
  assert.ok(Math.abs(c1x - 4 / 3) < 1e-9);
  assert.ok(Math.abs(c1y - 8 / 3) < 1e-9);
  assert.ok(Math.abs(c2x - 8 / 3) < 1e-9);
  assert.ok(Math.abs(c2y - 8 / 3) < 1e-9);
});

test('qToCubic cubic evaluates identically to the source quadratic', () => {
  const sx = 1, sy = 2, qx = 5, qy = 9, ex = 7, ey = 3;
  const [c1x, c1y, c2x, c2y] = qToCubic(sx, sy, qx, qy, ex, ey);
  const quad = (t, p0, p1, p2) => (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
  const cube = (t, p0, p1, p2, p3) =>
    (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(quad(t, sx, qx, ex) - cube(t, sx, c1x, c2x, ex)) < 1e-9);
    assert.ok(Math.abs(quad(t, sy, qy, ey) - cube(t, sy, c1y, c2y, ey)) < 1e-9);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/trace.test.js 2>&1 | tail -8`
Expected: FAIL — `Cannot find module '../js/trace.js'` (or export not found).

- [ ] **Step 3: Implement `js/trace.js` (this task's portion)**

```javascript
// js/trace.js — Tracedata → editable SVG/PDF. DOM/THREE-free (runs under node).
// Consumes imagetracer's tracedata; knows nothing about imagetracer itself.

import { sampleRamp, rgbToHex } from './palettes.js?v=45';

// N palette swatches sampled evenly across the active ramp. Index 0 is the
// background tone (ramp t=0). Quantization snaps background pixels to it; the
// SVG/PDF builders skip layer 0 and draw the background as a single rect.
export function paletteFromRamp(stops, levels) {
  const pal = [];
  for (let i = 0; i < levels; i++) {
    const t = levels > 1 ? i / (levels - 1) : 0;
    const [r, g, b] = sampleRamp(stops, t);
    pal.push({ r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a: 255 });
  }
  return pal;
}

// Exact quadratic→cubic control-point elevation:
//   C1 = P0 + (2/3)(Q - P0),  C2 = P2 + (2/3)(Q - P2)
export function qToCubic(sx, sy, qx, qy, ex, ey) {
  return [
    sx + (2 / 3) * (qx - sx), sy + (2 / 3) * (qy - sy),
    ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey),
  ];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/trace.test.js 2>&1 | tail -6`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add js/trace.js test/trace.test.js
git commit -m "feat(trace): palette-from-ramp builder and exact quadratic→cubic conversion"
```

---

## Task 3: `js/trace.js` — SVG builder

**Files:**
- Modify: `js/trace.js`
- Test: `test/trace.test.js`

**Interfaces:**
- Produces: `buildTraceSVG(tracedata, { background }) → string`. Emits one `<g id="tone-NN">` per palette layer **except layer 0** (background). `background` is a hex string or `null` (transparent). Uses `tracedata.palette[k]` for each layer's fill.

- [ ] **Step 1: Write the failing test**

Append to `test/trace.test.js`:

```javascript
import { buildTraceSVG } from '../js/trace.js';

// Minimal hand-built tracedata: 3 palette entries (0 = background, 1, 2).
// Layer 1 has one triangle path (L segments); layer 2 has one path with a Q.
const FIXTURE = {
  width: 100, height: 80,
  palette: [
    { r: 0, g: 0, b: 0, a: 255 },       // 0 background — must be skipped
    { r: 255, g: 0, b: 0, a: 255 },     // 1 red
    { r: 0, g: 128, b: 255, a: 255 },   // 2 blue
  ],
  layers: [
    [ /* layer 0: background paths — must not appear */
      { isholepath: false, segments: [
        { type: 'L', x1: 0, y1: 0, x2: 100, y2: 0 },
        { type: 'L', x1: 100, y1: 0, x2: 100, y2: 80 },
        { type: 'L', x1: 100, y1: 80, x2: 0, y2: 0 } ] } ],
    [ { isholepath: false, segments: [
        { type: 'L', x1: 10, y1: 10, x2: 40, y2: 10 },
        { type: 'L', x1: 40, y1: 10, x2: 25, y2: 40 },
        { type: 'L', x1: 25, y1: 40, x2: 10, y2: 10 } ] } ],
    [ { isholepath: false, segments: [
        { type: 'L', x1: 60, y1: 20, x2: 90, y2: 20 },
        { type: 'Q', x1: 90, y1: 20, x2: 90, y2: 60, x3: 60, y3: 60 },
        { type: 'L', x1: 60, y1: 60, x2: 60, y2: 20 } ] } ],
  ],
};

test('buildTraceSVG skips the background layer and groups by tone', () => {
  const svg = buildTraceSVG(FIXTURE, { background: '#0a0a0a' });
  assert.ok(svg.includes('width="100" height="80"'));
  assert.ok(svg.includes('<rect id="background"'));
  assert.ok(svg.includes('fill="#0a0a0a"'));
  assert.ok(svg.includes('<g id="tone-01"'));   // palette index 1
  assert.ok(svg.includes('<g id="tone-02"'));   // palette index 2
  assert.ok(!svg.includes('id="tone-00"'));      // background layer skipped
  assert.ok(svg.includes('fill="#ff0000"'));     // layer 1 colour
  assert.ok(svg.includes('fill="#0080ff"'));     // layer 2 colour
  assert.ok(svg.includes('Q 90 20 60 60'));      // quadratic emitted verbatim
});

test('buildTraceSVG with null background emits no rect', () => {
  const svg = buildTraceSVG(FIXTURE, { background: null });
  assert.ok(!svg.includes('id="background"'));
  assert.ok(svg.includes('<g id="tone-01"'));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/trace.test.js 2>&1 | tail -8`
Expected: FAIL — `buildTraceSVG` is not exported.

- [ ] **Step 3: Implement the SVG builder**

Append to `js/trace.js`:

```javascript
function pathToD(segments) {
  if (!segments.length) return '';
  const s0 = segments[0];
  let d = `M ${round(s0.x1)} ${round(s0.y1)}`;
  for (const s of segments) {
    if (s.type === 'Q') d += ` Q ${round(s.x2)} ${round(s.y2)} ${round(s.x3)} ${round(s.y3)}`;
    else d += ` L ${round(s.x2)} ${round(s.y2)}`;
  }
  return d + ' Z';
}

function round(v) { return Math.round(v * 100) / 100; }

// Tracedata → grouped SVG. One <g id="tone-NN"> per palette layer, skipping
// layer 0 (background). Every path in a layer — hole or not — is filled in the
// layer colour, reproducing imagetracer's opaque layer-stack model; the
// excluded background lets true background show through holes.
export function buildTraceSVG(tracedata, { background }) {
  const { width, height, layers, palette } = tracedata;
  const groups = [];
  for (let k = 1; k < layers.length; k++) {           // skip background layer 0
    const paths = layers[k];
    if (!paths || !paths.length) continue;
    const color = rgbToHex([palette[k].r / 255, palette[k].g / 255, palette[k].b / 255]);
    const body = paths
      .filter((p) => p.segments && p.segments.length)
      .map((p) => `    <path d="${pathToD(p.segments)}" fill="${color}"/>`)
      .join('\n');
    if (!body) continue;
    groups.push(`  <g id="tone-${String(k).padStart(2, '0')}" fill-rule="evenodd">\n${body}\n  </g>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
    ...groups,
    '</svg>',
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/trace.test.js 2>&1 | tail -6`
Expected: PASS — all trace tests pass.

- [ ] **Step 5: Commit**

```bash
git add js/trace.js test/trace.test.js
git commit -m "feat(trace): grouped SVG builder with background layer excluded"
```

---

## Task 4: `js/trace.js` — PDF op builder

**Files:**
- Modify: `js/trace.js`
- Test: `test/trace.test.js`

**Interfaces:**
- Produces:
  - `segmentsToPdfLegs(segments) → { start: [x, y], legs: [...] }` — `legs` entries are length-2 `[dx, dy]` (line) or length-6 `[dc1x, dc1y, dc2x, dc2y, dex, dey]` (cubic). **Every delta in a leg is relative to that segment's own start point** (the running current point), matching jsPDF's `lines()` per-leg model — NOT chained control-to-control.
  - `buildTracePdfOps(tracedata, { background }) → { width, height, background, layers: [{ color: {r,g,b}, paths: [{ start, legs }] }] }`. Skips layer 0.

- [ ] **Step 1: Write the failing test**

Append to `test/trace.test.js`:

```javascript
import { segmentsToPdfLegs, buildTracePdfOps } from '../js/trace.js';

test('segmentsToPdfLegs: line legs are deltas from the running point', () => {
  const segs = [
    { type: 'L', x1: 10, y1: 10, x2: 40, y2: 10 },
    { type: 'L', x1: 40, y1: 10, x2: 25, y2: 40 },
  ];
  const { start, legs } = segmentsToPdfLegs(segs);
  assert.deepEqual(start, [10, 10]);
  assert.deepEqual(legs[0], [30, 0]);      // (40-10, 10-10)
  assert.deepEqual(legs[1], [-15, 30]);    // (25-40, 40-10) relative to running point (40,10)
});

test('segmentsToPdfLegs: Q leg is a cubic with all deltas from the segment start', () => {
  const segs = [{ type: 'Q', x1: 0, y1: 0, x2: 2, y2: 4, x3: 4, y3: 0 }];
  const { start, legs } = segmentsToPdfLegs(segs);
  assert.deepEqual(start, [0, 0]);
  assert.equal(legs[0].length, 6);
  // C1=(4/3,8/3) C2=(8/3,8/3) end=(4,0), all relative to segment start (0,0)
  assert.ok(Math.abs(legs[0][0] - 4 / 3) < 1e-9);
  assert.ok(Math.abs(legs[0][1] - 8 / 3) < 1e-9);
  assert.ok(Math.abs(legs[0][2] - 8 / 3) < 1e-9);
  assert.ok(Math.abs(legs[0][3] - 8 / 3) < 1e-9);
  assert.deepEqual([legs[0][4], legs[0][5]], [4, 0]);
});

test('segmentsToPdfLegs round-trips: reconstruct the way jsPDF lines() does', () => {
  // jsPDF: start at `start`; each leg is offset from the CURRENT point;
  // within a 6-value cubic leg all three pairs are offset from the point
  // BEFORE the leg (the segment start), not chained to each other.
  const segs = [
    { type: 'Q', x1: 1, y1: 2, x2: 5, y2: 9, x3: 7, y3: 3 },
    { type: 'L', x1: 7, y1: 3, x2: 2, y2: 8 },
  ];
  const { start, legs } = segmentsToPdfLegs(segs);
  let [cx, cy] = start;
  // leg 0 (cubic): endpoint = current + (dex, dey)
  const end0 = [cx + legs[0][4], cy + legs[0][5]];
  assert.deepEqual(end0, [7, 3]);            // matches original x3,y3
  [cx, cy] = end0;
  const end1 = [cx + legs[1][0], cy + legs[1][1]];
  assert.deepEqual(end1, [2, 8]);            // matches original L endpoint
});

test('buildTracePdfOps skips background layer and carries rgb per layer', () => {
  const ops = buildTracePdfOps(FIXTURE, { background: '#0a0a0a' });
  assert.equal(ops.width, 100);
  assert.equal(ops.height, 80);
  assert.equal(ops.layers.length, 2);        // layers 1 and 2, not 0
  assert.deepEqual(ops.layers[0].color, { r: 255, g: 0, b: 0 });
  assert.deepEqual(ops.layers[1].color, { r: 0, g: 128, b: 255 });
  assert.ok(ops.layers[0].paths[0].start);
  assert.ok(ops.layers[0].paths[0].legs.length >= 1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/trace.test.js 2>&1 | tail -8`
Expected: FAIL — `segmentsToPdfLegs` / `buildTracePdfOps` not exported.

- [ ] **Step 3: Implement the PDF op builder**

Append to `js/trace.js`:

```javascript
// One traced path → jsPDF lines() input. `start` is the first anchor; each leg
// holds deltas relative to that segment's OWN start (the running point), so a
// cubic leg's three pairs are all offset from the point before the curve — the
// encoding jsPDF's lines() actually uses (chaining them corrupts every segment
// past the first, the 2026-07-23 bezier bug).
export function segmentsToPdfLegs(segments) {
  const start = [segments[0].x1, segments[0].y1];
  let cx = start[0], cy = start[1];
  const legs = [];
  for (const s of segments) {
    if (s.type === 'Q') {
      const [c1x, c1y, c2x, c2y] = qToCubic(cx, cy, s.x2, s.y2, s.x3, s.y3);
      legs.push([c1x - cx, c1y - cy, c2x - cx, c2y - cy, s.x3 - cx, s.y3 - cy]);
      cx = s.x3; cy = s.y3;
    } else {
      legs.push([s.x2 - cx, s.y2 - cy]);
      cx = s.x2; cy = s.y2;
    }
  }
  return { start, legs };
}

// Tracedata → PDF draw ops. One entry per palette layer except background (0);
// each carries an integer 0–255 rgb fill and its paths as jsPDF leg arrays.
export function buildTracePdfOps(tracedata, { background }) {
  const { width, height, layers, palette } = tracedata;
  const out = [];
  for (let k = 1; k < layers.length; k++) {
    const paths = (layers[k] || []).filter((p) => p.segments && p.segments.length);
    if (!paths.length) continue;
    out.push({
      color: { r: palette[k].r, g: palette[k].g, b: palette[k].b },
      paths: paths.map((p) => segmentsToPdfLegs(p.segments)),
    });
  }
  return { width, height, background: background ?? null, layers: out };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/trace.test.js 2>&1 | tail -6`
Expected: PASS — all trace tests pass.

- [ ] **Step 5: Commit**

```bash
git add js/trace.js test/trace.test.js
git commit -m "feat(trace): PDF op builder with jsPDF-correct relative bezier legs"
```

---

## Task 5: `js/traceworker.js` — layer-by-layer trace worker

**Files:**
- Create: `js/traceworker.js`

**Interfaces:**
- Consumes: `self.ImageTracer` (from the vendored lib via `importScripts`).
- Message in: `{ imageData, options }` where `options` includes `pal`, `colorsampling: 0`, `ltres`, `qtres`, `pathomit`, `blurradius`.
- Messages out: `{ progress: 0..1, level, levels }` per layer; then `{ done: true, tracedata: { width, height, layers, palette } }`; or `{ error: string }`.
- Produces: nothing importable (worker). Its `tracedata` output shape is exactly what Task 3/4 builders consume.

This task has no unit test — worker + WebGL/DOM glue is verified by the Task 8 E2E. Keep it a thin, obviously-correct orchestrator over already-tested pieces.

- [ ] **Step 1: Write the worker**

```javascript
// js/traceworker.js — classic worker. Runs imagetracer's pipeline one palette
// layer at a time so the UI can show real per-level progress. imagetracer's
// imagedataToTracedata() is one synchronous call with no progress hook, so we
// drive its exposed stage functions ourselves.
importScripts('vendor/imagetracer.js?v=45');

self.onmessage = (e) => {
  const { imageData, options } = e.data;
  try {
    const IT = self.ImageTracer;
    const ii = IT.colorquantization(imageData, options); // { array, palette } — uses options.pal
    const levels = ii.palette.length;
    const layers = [];
    for (let k = 0; k < levels; k++) {
      const layer = IT.layeringstep(ii, k);
      const paths = IT.pathscan(layer, options.pathomit);
      const internodePaths = IT.internodes(paths, options);
      const traced = IT.batchtracepaths(internodePaths, options.ltres, options.qtres);
      layers.push(traced);
      self.postMessage({ progress: (k + 1) / levels, level: k + 1, levels });
    }
    self.postMessage({
      done: true,
      tracedata: { width: imageData.width, height: imageData.height, layers, palette: ii.palette },
    });
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
```

- [ ] **Step 2: Syntax-check the worker file**

Run: `node --check js/traceworker.js && echo OK`
Expected: `OK` (note: `node --check` parses; it won't run `importScripts`, which is fine — we only want a syntax gate here).

- [ ] **Step 3: Commit**

```bash
git add js/traceworker.js
git commit -m "feat(trace): classic worker tracing layer-by-layer with progress"
```

---

## Task 6: `js/exporter.js` — trace SVG/PDF export functions

**Files:**
- Modify: `js/exporter.js`

**Interfaces:**
- Consumes: `buildTraceSVG`, `buildTracePdfOps` from `./trace.js`.
- Produces:
  - `exportTraceSVG(tracedata, { background }) → string` (caller blobs + downloads, mirroring `exportStrandSVG`).
  - `exportTracePDF(tracedata, { background })` → builds a jsPDF filled-path document and calls `doc.save('soundform-trace.pdf')` (mirroring `exportStrandPDF`).

- [ ] **Step 1: Add the imports**

At the top of `js/exporter.js`, alongside the existing strands import, add:

```javascript
import { buildTraceSVG, buildTracePdfOps } from './trace.js?v=45';
```

- [ ] **Step 2: Add `exportTraceSVG`**

Append to `js/exporter.js`:

```javascript
// Trace export: grouped filled tone-band SVG (one <g id="tone-NN"> per level).
export function exportTraceSVG(tracedata, { background }) {
  return buildTraceSVG(tracedata, { background });
}
```

- [ ] **Step 3: Add `exportTracePDF`**

Append to `js/exporter.js`:

```javascript
// Trace export as native vector PDF: each tone layer drawn as filled paths.
// Page sizing mirrors exportStrandPDF (A4-ish, orientation by aspect).
export function exportTracePDF(tracedata, { background }) {
  const { jsPDF } = window.jspdf;
  const ops = buildTracePdfOps(tracedata, { background });
  const { width, height } = ops;
  const mmW = width > height ? 297 : 210;
  const mmH = mmW * (height / width);
  const doc = new jsPDF({
    orientation: width > height ? 'landscape' : 'portrait',
    unit: 'mm',
    format: [mmW, mmH],
  });
  const px2mm = mmW / width;

  if (ops.background != null) {
    const [r, g, b] = hexToRgb(ops.background).map((v) => Math.round(v * 255));
    doc.setFillColor(r, g, b);
    doc.rect(0, 0, mmW, mmH, 'F');
  }

  ops.layers.forEach(({ color, paths }) => {
    doc.setFillColor(color.r, color.g, color.b);
    paths.forEach(({ start, legs }) => {
      // 'F' fills, closed=true closes the subpath; scale px→mm.
      doc.lines(legs, start[0] * px2mm, start[1] * px2mm, [px2mm, px2mm], 'F', true);
    });
  });

  doc.save('soundform-trace.pdf');
}
```

- [ ] **Step 4: Verify the module still parses and imports resolve**

Run: `node -e "import('./js/exporter.js').then(()=>console.log('OK')).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `OK`. (`js/exporter.js` imports only pure modules at load time; `window` is touched lazily inside functions, so import succeeds under node.)

- [ ] **Step 5: Run the full suite**

Run: `npm test 2>&1 | tail -5`
Expected: `pass` count unchanged-or-higher, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add js/exporter.js
git commit -m "feat(trace): exportTraceSVG and exportTracePDF wiring"
```

---

## Task 7: `index.html` + `js/main.js` — UI, params, orchestration

**Files:**
- Modify: `index.html` (Export panel + progress panel)
- Modify: `js/main.js` (params, imports, button binding, worker orchestration)

**Interfaces:**
- Consumes: `exportTraceSVG`, `exportTracePDF` from `./exporter.js`; `paletteFromRamp` from `./trace.js`; `renderer.renderHiRes`, `activeStops()`, `params`.
- Produces: user-facing Trace export. No importable surface.

- [ ] **Step 1: Add the two trace buttons**

In `index.html`, in the `.btn-export` row (currently the SVG and PDF buttons), add after the PDF button:

```html
        <button class="btn-export" data-fmt="trace-svg">Trace SVG</button>
        <button class="btn-export" data-fmt="trace-pdf">Trace PDF</button>
```

- [ ] **Step 2: Add the four trace setting rows and a progress panel**

In `index.html`, inside the Export `panel-section` (after the transparent-background label), add:

```html
      <div class="sl-row">
        <select id="sel-trace-levels">
          <option value="4">Trace levels: 4</option>
          <option value="6">Trace levels: 6</option>
          <option value="8" selected>Trace levels: 8</option>
          <option value="12">Trace levels: 12</option>
        </select>
      </div>
      <div class="sl-row">
        <select id="sel-trace-detail">
          <option value="draft">Trace detail: Draft</option>
          <option value="balanced" selected>Trace detail: Balanced</option>
          <option value="fine">Trace detail: Fine</option>
        </select>
      </div>
      <div class="sl-row">
        <select id="sel-trace-res">
          <option value="1200">Trace res: 1200px</option>
          <option value="2000" selected>Trace res: 2000px</option>
          <option value="3000">Trace res: 3000px</option>
        </select>
      </div>
      <div class="sl-row">
        <select id="sel-trace-smooth">
          <option value="low">Trace smoothing: Low</option>
          <option value="medium" selected>Trace smoothing: Medium</option>
          <option value="high">Trace smoothing: High</option>
        </select>
      </div>
      <div class="sl-row" id="trace-progress" style="display:none">
        <span id="trace-progress-label">Tracing…</span>
        <button id="trace-cancel" class="vr-btn vr-discard">Cancel</button>
      </div>
```

- [ ] **Step 3: Add trace params and default state in `js/main.js`**

Find the `params` object (where `exportRes`, `transparentBg`, `strokeWeight` live) and add:

```javascript
  traceLevels: 8,
  traceDetail: 'balanced',
  traceRes: 2000,
  traceSmooth: 'medium',
```

Add the `paletteFromRamp` import to the existing `./trace.js`-less import block — extend the exporter import line and add a trace import:

```javascript
import { exportCanvas, exportStrandSVG, exportStrandPDF, exportTraceSVG, exportTracePDF, framePlan, exportMP4, loopsForDuration } from './exporter.js?v=45';
import { paletteFromRamp } from './trace.js?v=45';
```

- [ ] **Step 4: Bind the four trace selects**

In `js/main.js`, near where `sel-export-res` / `sel-video-dur` are bound, add:

```javascript
  document.getElementById('sel-trace-levels').addEventListener('change', (e) => { params.traceLevels = +e.target.value; });
  document.getElementById('sel-trace-detail').addEventListener('change', (e) => { params.traceDetail = e.target.value; });
  document.getElementById('sel-trace-res').addEventListener('change', (e) => { params.traceRes = +e.target.value; });
  document.getElementById('sel-trace-smooth').addEventListener('change', (e) => { params.traceSmooth = e.target.value; });
```

- [ ] **Step 5: Add the trace orchestration helper**

In `js/main.js`, add module-level trace state near the other export state (e.g. by `mp4Busy`):

```javascript
let traceWorker = null, traceBusy = false;
```

Add this function (near `bindExport`):

```javascript
const TRACE_DETAIL = {
  draft:    { ltres: 3,   qtres: 3 },
  balanced: { ltres: 1,   qtres: 1 },
  fine:     { ltres: 0.3, qtres: 0.3 },
};
const TRACE_SMOOTH = {
  low:    { pathomit: 2,  blurradius: 0 },
  medium: { pathomit: 8,  blurradius: 2 },
  high:   { pathomit: 16, blurradius: 5 },
};

async function runTrace(kind) { // kind: 'svg' | 'pdf'
  if (traceBusy) return;
  if (!design && appState !== 'live') { setStatus('Create a design first'); return; }
  traceBusy = true;
  const panel = document.getElementById('trace-progress');
  const label = document.getElementById('trace-progress-label');
  panel.style.display = '';
  label.textContent = 'Tracing…';

  const container = document.getElementById('renderer-container');
  const scale = params.traceRes / Math.max(container.clientWidth || 800, container.clientHeight || 600);
  const transparent = params.transparentBg;
  const canvas = renderer.renderHiRes(scale, { transparent });
  if (renderer.exportNote) setStatus(renderer.exportNote);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const detail = TRACE_DETAIL[params.traceDetail];
  const smooth = TRACE_SMOOTH[params.traceSmooth];
  const options = {
    pal: paletteFromRamp(activeStops(), params.traceLevels),
    colorsampling: 0,
    numberofcolors: params.traceLevels,
    ltres: detail.ltres, qtres: detail.qtres,
    pathomit: smooth.pathomit, blurradius: smooth.blurradius,
    rightangleenhance: false, roundcoords: 1, linefilter: true,
  };
  const background = params.transparentBg ? null : params.background;

  traceWorker = new Worker('js/traceworker.js?v=45'); // classic worker
  traceWorker.onmessage = (e) => {
    const m = e.data;
    if (m.progress != null) { label.textContent = `Tracing… level ${m.level} / ${m.levels}`; return; }
    if (m.error) { endTrace(); setStatus(`Trace error: ${m.error}`); return; }
    if (m.done) {
      try {
        if (kind === 'svg') {
          const svg = exportTraceSVG(m.tracedata, { background });
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          const a = Object.assign(document.createElement('a'), { href: url, download: 'soundform-trace.svg' });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        } else {
          exportTracePDF(m.tracedata, { background });
        }
        setStatus('Trace saved');
      } catch (err) { setStatus(`Trace error: ${err.message}`); }
      endTrace();
    }
  };
  traceWorker.onerror = (err) => { setStatus(`Trace error: ${err.message}`); endTrace(); };
  traceWorker.postMessage({ imageData, options });
}

function endTrace() {
  if (traceWorker) { traceWorker.terminate(); traceWorker = null; }
  traceBusy = false;
  document.getElementById('trace-progress').style.display = 'none';
}
```

- [ ] **Step 6: Route the trace buttons and wire cancel**

In `bindExport`, at the top of the click handler (before the existing `if (fmt === 'svg' || fmt === 'pdf')`), add:

```javascript
        if (fmt === 'trace-svg' || fmt === 'trace-pdf') {
          await runTrace(fmt === 'trace-svg' ? 'svg' : 'pdf');
          return;
        }
```

And once, where other one-time listeners are set up (e.g. end of `bindExport`), add:

```javascript
  document.getElementById('trace-cancel').addEventListener('click', () => { endTrace(); setStatus('Trace cancelled'); });
```

- [ ] **Step 7: Run the full suite (no regressions in node-testable code)**

Run: `npm test 2>&1 | tail -5`
Expected: `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add index.html js/main.js
git commit -m "feat(trace): Export-panel UI, params, and worker orchestration"
```

---

## Task 8: Real-app E2E verification

**Files:**
- Create (throwaway, not committed): `scratch/trace-e2e.mjs` under the scratchpad dir.

**Interfaces:** none — this is the acceptance gate the unit tests can't cover (worker + WebGL + jsPDF + real audio).

- [ ] **Step 1: Confirm Playwright/Chromium is available**

Run: `ls test/ ; npx playwright --version 2>&1 | head -1`
Expected: a Playwright version prints. If not installed, install with `npx playwright install chromium` (this project has done headless-Chromium E2E before for prior export work).

- [ ] **Step 2: Serve the app and drive it headless**

Write a script to the scratchpad that: starts a static server on the repo root, opens the app, uploads a synthetic WAV through the real file-input → record → submit flow (reuse the approach from prior export E2E sessions), selects Cymatics mode, clicks **Trace SVG** then **Trace PDF**, and captures both downloads.

Run the script. Expected: both files download with no console errors; the progress label advanced through `level N / M`.

- [ ] **Step 3: Inspect the SVG**

Verify the downloaded SVG contains multiple `<g id="tone-NN">` groups, real `<path d="M … Z">` data with non-degenerate coordinates, and fill colours drawn from the active palette. Expected: PASS.

- [ ] **Step 4: Rasterize the PDF and eyeball against the render**

Rasterize `soundform-trace.pdf` via pdf.js (as in prior sessions) and compare to a screenshot of the on-screen design. Expected: filled tone-bands that read like a posterized version of the design — not fragmented/spiky paths (the bezier-delta failure mode), not a solid blob (background-layer leak).

- [ ] **Step 5: Try the extremes**

Repeat Step 2 with Trace levels = 12 / res = 3000 / detail = Fine, and separately levels = 4 / res = 1200 / detail = Draft. Expected: both complete; high setting is denser and slower but still valid; low setting is a bold poster. No unresponsive-page warning (worker keeps the canvas rotatable throughout).

- [ ] **Step 6: Record the result**

No commit (throwaway script). Report pass/fail with the rasterized comparison to the user before any deploy.

---

## Self-Review

**Spec coverage:**
- Third "Trace" export path alongside strands → Tasks 6–7 (buttons `trace-svg`/`trace-pdf`; strand path untouched). ✓
- Posterize + contour-trace via imagetracerjs, vendored, Unlicense → Task 1. ✓
- Palette-locked colour (`pal` + `colorsampling: 0`, background as index 0, skipped in output, emitted as rect) → Tasks 2, 3, 4, 7. ✓
- Four settings (levels/detail/resolution/smoothing) with the exact defaults from the spec → Task 7. ✓
- SVG one `<g>` per tone level → Task 3. ✓
- PDF filled paths, quadratic→cubic exact, deltas relative to segment start → Task 4 (+ round-trip test reconstructing the jsPDF way). ✓
- Web Worker with per-level progress + cancel → Tasks 5, 7. ✓
- Node tests on the pure module + real-app E2E → Tasks 2–4, 8. ✓
- Cache-bust v=44→v=45 across all versioned files → Task 1. ✓
- `js/trace.js` DOM/THREE-free → Tasks 2–4 (tested under node). ✓

**Deviation from spec (noted):** the spec described a *module* worker; the plan uses a **classic** worker with `importScripts`. Rationale: the vendored lib is UMD and assigns `self.ImageTracer` under `importScripts`, so a classic worker loads it verbatim with no ESM shim — simpler and less fragile than rewriting the UMD wrapper. Functionally identical (still off-main-thread, still progress + cancel). Recorded here so a reviewer isn't surprised.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; the two non-unit-testable tasks (5, 8) state why and give concrete verification commands.

**Type consistency:** `paletteFromRamp(stops, levels)` → `{r,g,b,a}` used identically in Task 2 (def), Task 5 (worker `options.pal`), Task 7 (call). `tracedata {width,height,layers,palette}` produced in Task 5, consumed in Tasks 3/4. `segmentsToPdfLegs` → `{start, legs}` produced in Task 4, consumed by `buildTracePdfOps` (Task 4) and `exportTracePDF` (Task 6). `buildTracePdfOps` → `{width,height,background,layers:[{color:{r,g,b},paths}]}` consumed in Task 6. Names consistent throughout.
