# Vector Export Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SVG and (new) PDF export show every stroke visible in the app, in the app's colors, for both classic strand designs and Paint-mode captures — without touching how Paint mode itself behaves.

**Architecture:** A shared, pure, DOM/THREE-free path-building layer in `js/strands.js` (`buildVectorPaths`, adaptive simplification, bezier/PDF-leg formatting) that both `exportStrandSVG` and a new `exportStrandPDF` in `js/exporter.js` format from. Separately, `js/live.js`'s Paint freeze path starts keeping strand/segment data it already computes but currently discards, so `design.strands` is populated for Paint captures instead of hardcoded `[]`.

**Tech Stack:** Vanilla JS/ES modules, Three.js (WebGL renderer, untouched by this plan), jsPDF 2.5.1 (loaded via CDN `<script>` in `index.html`, already used for the old raster PDF path), Node's built-in `node:test` runner (`npm test`).

## Global Constraints

- No strand is ever silently dropped from vector export (the bug being fixed) — worst case is coarser simplification.
- Paint mode's own pacing, steering, budgets, freeze/regen/clear behavior must not change — this plan only *reads* data Paint already produces.
- All new pure logic must be node-testable without a browser/DOM, matching the existing `js/strands.js` / `js/live.js` pattern.
- The existing 251-test suite (`npm test`) must stay green throughout.
- Cache-bust version query strings (`?v=41` in imports/`index.html`) bump to `?v=42` only once, in the final task, after all other work lands.

---

### Task 1: Adaptive simplification + shared path builder in `js/strands.js`

**Files:**
- Modify: `js/strands.js` (add `simplifyToBudget`, `buildVectorPaths`; add import of `sampleRamp`, `rgbToHex` from `./palettes.js`)
- Test: `test/strands.test.js`

**Interfaces:**
- Produces: `simplifyToBudget(pts, epsilon0 = 1.4, budget = 500) -> Array<[x,y]>` — never returns fewer than 2 points for an input of length >= 2.
- Produces: `buildVectorPaths({ strands, positions, mvp, width, height, stops, weight }) -> Array<{ si, depth, density, points, c1, c2, strokeWidth, opacity, x1, y1, x2, y2 }>`, sorted far-to-near by `depth` (descending). `points` is the simplified 2D point list; `c1`/`c2` are resolved hex colors; `strokeWidth`/`opacity` are the final numeric values (not yet formatted as strings).

- [ ] **Step 1: Write the failing tests**

Add to `test/strands.test.js` (after the existing `buildDensityGrid` test, keep existing imports and add `simplifyToBudget`, `buildVectorPaths` to the import line):

```js
import { projectStrand, rdp, toBezierPath, buildDensityGrid,
         simplifyToBudget, buildVectorPaths } from '../js/strands.js';

test('simplifyToBudget never drops a strand, even a very dense one', () => {
  // Amplitude-2 zigzag: at epsilon 1.4 nearly every point survives (>500).
  const pts = [];
  for (let i = 0; i < 5000; i++) pts.push([i * 0.1, (i % 2) * 2]);
  const out = simplifyToBudget(pts, 1.4, 500);
  assert.ok(out.length >= 2, 'strand must never vanish');
  assert.ok(out.length <= 500, `expected <=500, got ${out.length}`);
});

test('simplifyToBudget leaves an already-small strand under budget alone at eps0', () => {
  const pts = [[0, 0], [10, 0.01], [20, 0], [30, 5], [40, 0]];
  assert.deepEqual(simplifyToBudget(pts, 1.4, 500), rdp(pts, 1.4));
});

test('buildVectorPaths keeps a strand that used to exceed the old 300-point drop cap', () => {
  // A smooth curve whose eps=1.4 simplification lands between 300 and 500 points.
  const strand = new Float32Array(400 * 3);
  for (let i = 0; i < 400; i++) {
    const t = i / 399;
    strand[i * 3] = Math.cos(t * 40) * 0.6 + t * 0.001;
    strand[i * 3 + 1] = (t - 0.5) * 1.4;
    strand[i * 3 + 2] = Math.sin(t * 40) * 0.6;
  }
  const positions = strand;
  const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const items = buildVectorPaths({ strands: [strand], positions, mvp: IDENTITY,
    width: 1600, height: 1200, stops: [[0, '#000000'], [1, '#ffffff']], weight: 1 });
  assert.equal(items.length, 1, 'the strand must appear, not be dropped');
  assert.ok(items[0].points.length >= 2);
});

test('buildVectorPaths resolves colors and geometry per strand', () => {
  const strand = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    strand[i * 3] = Math.cos(t * 6) * 0.6;
    strand[i * 3 + 1] = (t - 0.5) * 1.4;
    strand[i * 3 + 2] = Math.sin(t * 6) * 0.6;
  }
  const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const items = buildVectorPaths({ strands: [strand], positions: strand, mvp: IDENTITY,
    width: 800, height: 600, stops: [[0, '#050614'], [1, '#ffffff']], weight: 2 });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.match(it.c1, /^#[0-9a-f]{6}$/);
  assert.match(it.c2, /^#[0-9a-f]{6}$/);
  assert.ok(it.strokeWidth > 0);
  assert.ok(it.opacity > 0 && it.opacity <= 1);
  assert.equal(it.x1, it.points[0][0]);
  assert.equal(it.y2, it.points[it.points.length - 1][1]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `simplifyToBudget` and `buildVectorPaths` are not exported from `js/strands.js`.

- [ ] **Step 3: Implement in `js/strands.js`**

Add this import at the top of `js/strands.js` (file currently has no imports):

```js
import { sampleRamp, rgbToHex } from './palettes.js';
```

Add after the existing `rdp` function (before `toBezierPath`):

```js
const SIMPLIFY_BUDGET = 500;
const SIMPLIFY_GROWTH = 1.3;
const SIMPLIFY_MAX_ATTEMPTS = 6;

// Adaptive RDP: loosen epsilon until the strand fits the budget instead of
// ever dropping it outright. Dense strands get coarser, never invisible.
export function simplifyToBudget(pts, epsilon0 = 1.4, budget = SIMPLIFY_BUDGET) {
  let epsilon = epsilon0;
  let out = rdp(pts, epsilon);
  for (let i = 1; i < SIMPLIFY_MAX_ATTEMPTS && out.length > budget; i++) {
    epsilon *= SIMPLIFY_GROWTH;
    out = rdp(pts, epsilon);
  }
  return out;
}
```

Add after `buildDensityGrid` (end of file):

```js
// Strand -> simplified 2D path + resolved color/weight, ready for any
// vector format (SVG gradient stops, PDF flat-color runs) to draw from.
export function buildVectorPaths({ strands, positions, mvp, width, height, stops, weight }) {
  const grid = buildDensityGrid(positions);
  const items = [];

  strands.forEach((strand, si) => {
    const { pts, depth } = projectStrand(strand, mvp, width, height);
    if (pts.length < 2) return;
    const simplified = simplifyToBudget(pts, 1.4, SIMPLIFY_BUDGET);
    if (simplified.length < 2) return;
    let dSum = 0, dN = 0;
    for (let i = 0; i < strand.length; i += 30) {
      dSum += grid.sample(strand[i], strand[i + 1], strand[i + 2]); dN++;
    }
    const density = dN ? dSum / dN : 0.3;
    items.push({
      si, depth, density, points: simplified,
      c1: rgbToHex(sampleRamp(stops, 0.35 + density * 0.3)),
      c2: rgbToHex(sampleRamp(stops, 0.6 + density * 0.4)),
      strokeWidth: (0.6 + density * 3.4) * weight,
      opacity: 0.35 + density * 0.55,
      x1: simplified[0][0], y1: simplified[0][1],
      x2: simplified[simplified.length - 1][0], y2: simplified[simplified.length - 1][1],
    });
  });

  items.sort((a, b) => b.depth - a.depth); // far strands first (painter's order)
  return items;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `test/strands.test.js` tests green, full suite still green.

- [ ] **Step 5: Commit**

```bash
git add js/strands.js test/strands.test.js
git commit -m "feat(export): add adaptive strand simplification and shared vector path builder"
```

---

### Task 2: Structured bezier control points + PDF-ready relative legs

**Files:**
- Modify: `js/strands.js` (add `catmullRomToBezier`, `toRelativeBezierLegs`; refactor `toBezierPath` to use `catmullRomToBezier`)
- Test: `test/strands.test.js`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `catmullRomToBezier(pts) -> Array<{ c1: [x,y], c2: [x,y], end: [x,y] }>` (absolute coordinates).
- Produces: `toRelativeBezierLegs(start, segments) -> Array<[dx1,dy1,dx2,dy2,dx3,dy3]>` — each leg's deltas chain from the previous accumulated point (matches jsPDF's `lines()` convention), for feeding directly into jsPDF.
- `toBezierPath(pts)` keeps its existing signature/output (string), now implemented via `catmullRomToBezier`.

- [ ] **Step 1: Write the failing tests**

Add to `test/strands.test.js`:

```js
import { catmullRomToBezier, toRelativeBezierLegs } from '../js/strands.js';

test('toBezierPath output is unchanged after the catmullRomToBezier refactor', () => {
  const pts = [[0, 0], [10, 10], [20, 0], [30, 10], [40, -5]];
  assert.equal(
    toBezierPath(pts),
    'M0 0C1.7 1.7 6.7 10 10 10C13.3 10 16.7 3.3 20 0C23.3 -3.3 26.8 8.2 30 10C33.3 11.8 40 -5 40 -5'
  );
});

test('catmullRomToBezier + toRelativeBezierLegs round-trips to the same absolute points', () => {
  const pts = [[5, 5], [12, -3], [20, 8], [31, 2], [40, 15]];
  const segs = catmullRomToBezier(pts);
  const legs = toRelativeBezierLegs(pts[0], segs);
  let cx = pts[0][0], cy = pts[0][1];
  const reconstructedEnds = [];
  for (const [dx1, dy1, dx2, dy2, dx3, dy3] of legs) {
    const x1 = cx + dx1, y1 = cy + dy1;
    const x2 = x1 + dx2, y2 = y1 + dy2;
    const x3 = x2 + dx3, y3 = y2 + dy3;
    reconstructedEnds.push([x3, y3]);
    cx = x3; cy = y3;
  }
  segs.forEach((seg, i) => {
    assert.ok(Math.abs(reconstructedEnds[i][0] - seg.end[0]) < 1e-9);
    assert.ok(Math.abs(reconstructedEnds[i][1] - seg.end[1]) < 1e-9);
  });
});
```

Run `node -e` locally first to get the exact expected string for the first test if unsure — but since this is a pure refactor (identical math, just restructured), the existing `toBezierPath` test (`toBezierPath emits M + C commands`) plus this exact-string test both must pass with the SAME formula as today; do not change the numeric formula while adding this test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `catmullRomToBezier` and `toRelativeBezierLegs` are not exported yet (the exact-string test may also fail to even run, since the import fails).

- [ ] **Step 3: Implement in `js/strands.js`**

Replace the existing `toBezierPath` function with:

```js
// Catmull-Rom through pts -> absolute cubic bezier control points.
export function catmullRomToBezier(pts) {
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    segs.push({ c1, c2, end: p2 });
  }
  return segs;
}

export function toBezierPath(pts) {
  if (pts.length < 2) return '';
  const f = v => +v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (const { c1, c2, end } of catmullRomToBezier(pts)) {
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(end[0])} ${f(end[1])}`;
  }
  return d;
}

// Relative bezier-curve deltas for jsPDF's lines() API: each leg's three
// pairs chain from the previous accumulated point (not all relative to the
// segment start), matching how jsPDF walks a lines() array.
export function toRelativeBezierLegs(start, segments) {
  const legs = [];
  let cx = start[0], cy = start[1];
  for (const { c1, c2, end } of segments) {
    legs.push([c1[0] - cx, c1[1] - cy, c2[0] - c1[0], c2[1] - c1[1], end[0] - c2[0], end[1] - c2[1]]);
    cx = end[0]; cy = end[1];
  }
  return legs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — if the exact-string test fails because the formula produced a different string than guessed above, update the test's expected string to whatever `toBezierPath` actually outputs for that fixture (the point is that it's unchanged from the pre-refactor formula, not the literal string) — do NOT change the implementation formula to match a guessed string.

- [ ] **Step 5: Commit**

```bash
git add js/strands.js test/strands.test.js
git commit -m "refactor(export): expose bezier control points and PDF-ready relative legs"
```

---

### Task 3: Refactor `exportStrandSVG` onto the shared builder

**Files:**
- Modify: `js/exporter.js:1-2, 54-104` (imports and `exportStrandSVG`)
- Test: `test/exporter.test.js`

**Interfaces:**
- Consumes: `buildVectorPaths`, `toBezierPath` from `js/strands.js` (Task 1 & 2).
- Produces: `exportStrandSVG` keeps its existing signature and output shape — this is a pure refactor, verified by the existing test suite staying green.

- [ ] **Step 1: Write the failing test**

Add to `test/exporter.test.js` (uses the `fixture()` helper already in the file):

```js
test('exportStrandSVG: a strand that used to exceed the 300-point drop cap still appears', () => {
  const strands = [];
  const st = new Float32Array(400 * 3);
  for (let i = 0; i < 400; i++) {
    const t = i / 399;
    st[i * 3] = Math.cos(t * 40) * 0.6 + t * 0.001;
    st[i * 3 + 1] = (t - 0.5) * 1.4;
    st[i * 3 + 2] = Math.sin(t * 40) * 0.6;
  }
  strands.push(st);
  const svg = exportStrandSVG({ strands, positions: st, mvp: IDENTITY, width: 1600, height: 1200,
    stops: [[0, '#050614'], [1, '#ffffff']], background: '#03040a', weight: 1 });
  assert.ok(svg.includes('id="strand-01"'), 'the dense strand must not be dropped');
  assert.ok(svg.includes('<path'));
});
```

- [ ] **Step 2: Run tests to verify the new test fails and the rest still pass**

Run: `npm test`
Expected: the new test FAILS (current code drops the strand since its eps=1.4 simplification exceeds 300 points); all pre-existing `exportStrandSVG` tests still PASS (implementation hasn't changed yet).

- [ ] **Step 3: Implement — refactor `exportStrandSVG` in `js/exporter.js`**

Change the import line at the top of `js/exporter.js` from:

```js
import { projectStrand, rdp, toBezierPath, buildDensityGrid } from './strands.js?v=41';
```

to:

```js
import { buildVectorPaths, toBezierPath } from './strands.js?v=41';
```

Replace the `exportStrandSVG` function body with:

```js
export function exportStrandSVG({ strands, positions, mvp, width, height, stops, background, weight }) {
  const items = buildVectorPaths({ strands, positions, mvp, width, height, stops, weight });

  const defs = [], groups = [];
  items.forEach((it, order) => {
    const id = String(order + 1).padStart(2, '0');
    defs.push(
      `    <linearGradient id="grad-${id}" gradientUnits="userSpaceOnUse" x1="${it.x1.toFixed(1)}" y1="${it.y1.toFixed(1)}" x2="${it.x2.toFixed(1)}" y2="${it.y2.toFixed(1)}">` +
      `<stop offset="0" stop-color="${it.c1}"/><stop offset="1" stop-color="${it.c2}"/></linearGradient>`);
    groups.push(
      `  <g id="strand-${id}">\n` +
      `    <path d="${toBezierPath(it.points)}" fill="none" stroke="url(#grad-${id})" stroke-width="${it.strokeWidth.toFixed(2)}" stroke-linecap="round" opacity="${it.opacity.toFixed(2)}"/>\n` +
      `  </g>`);
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
    '  <defs>',
    ...defs,
    '  </defs>',
    ...groups,
    '</svg>',
  ].join('\n');
}
```

(The 300-point drop check, `buildDensityGrid` call, and per-strand density/color math are gone from this function — they now live in `buildVectorPaths`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — including the new dense-strand test and every pre-existing `exportStrandSVG` test (structure, 1MB budget, determinism, null-background).

- [ ] **Step 5: Commit**

```bash
git add js/exporter.js test/exporter.test.js
git commit -m "fix(export): SVG export no longer silently drops strands over 300 simplified points"
```

---

### Task 4: PDF drawing ops (pure, testable)

**Files:**
- Modify: `js/strands.js` (add `lerpHex`, `buildPdfOps`; add `hexToRgb` to the `./palettes.js` import)
- Test: `test/strands.test.js`

**Interfaces:**
- Consumes: `buildVectorPaths`, `catmullRomToBezier`, `toRelativeBezierLegs` (Tasks 1 & 2).
- Produces: `buildPdfOps({ strands, positions, mvp, width, height, stops, weight, background }) -> { width, height, background, strokes: Array<{ strokeWidth, opacity, runs: Array<{ start: [x,y], legs: Array<[6 numbers]>, color: '#hex' }> }> }`. Pure data — no jsPDF/DOM dependency. This is what Task 5's `exportStrandPDF` will feed into real jsPDF calls.

- [ ] **Step 1: Write the failing tests**

Add to `test/strands.test.js`:

```js
import { buildPdfOps } from '../js/strands.js';

test('buildPdfOps produces jsPDF-ready ops with no DOM/jsPDF dependency', () => {
  const strand = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    strand[i * 3] = Math.cos(t * 6) * 0.6;
    strand[i * 3 + 1] = (t - 0.5) * 1.4;
    strand[i * 3 + 2] = Math.sin(t * 6) * 0.6;
  }
  const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const ops = buildPdfOps({ strands: [strand], positions: strand, mvp: IDENTITY,
    width: 800, height: 600, stops: [[0, '#050614'], [1, '#ffffff']], weight: 2, background: '#03040a' });
  assert.equal(ops.width, 800);
  assert.equal(ops.background, '#03040a');
  assert.equal(ops.strokes.length, 1);
  const stroke = ops.strokes[0];
  assert.ok(stroke.strokeWidth > 0);
  assert.ok(stroke.runs.length > 0);
  stroke.runs.forEach((run) => {
    assert.equal(run.start.length, 2);
    assert.match(run.color, /^#[0-9a-f]{6}$/);
    run.legs.forEach((leg) => assert.equal(leg.length, 6));
  });
});

test('buildPdfOps run colors interpolate from c1 toward c2 along the stroke', () => {
  const strand = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) {
    const t = i / 599;
    strand[i * 3] = t * 1.2 - 0.6;
    strand[i * 3 + 1] = Math.sin(t * 3) * 0.4;
    strand[i * 3 + 2] = 0;
  }
  const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const ops = buildPdfOps({ strands: [strand], positions: strand, mvp: IDENTITY,
    width: 800, height: 600, stops: [[0, '#000000'], [1, '#ffffff']], weight: 1, background: null });
  const runs = ops.strokes[0].runs;
  assert.ok(runs.length > 1, 'fixture must produce multiple runs to test interpolation');
  assert.equal(ops.background, null);
  const firstGray = parseInt(runs[0].color.slice(1, 3), 16);
  const lastGray = parseInt(runs[runs.length - 1].color.slice(1, 3), 16);
  assert.ok(lastGray >= firstGray, 'color should trend from c1 toward c2 along the stroke');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildPdfOps` is not exported yet.

- [ ] **Step 3: Implement in `js/strands.js`**

Change the palettes import at the top of `js/strands.js` from:

```js
import { sampleRamp, rgbToHex } from './palettes.js';
```

to:

```js
import { sampleRamp, rgbToHex, hexToRgb } from './palettes.js';
```

Add at the end of the file:

```js
const PDF_RUN_SEGMENTS = 6; // bezier segments per solid-color run

// jsPDF's core API has no per-stroke gradient — approximate the SVG
// gradient by splitting each stroke into short flat-color runs.
export function lerpHex(c1, c2, t) {
  const a = hexToRgb(c1), b = hexToRgb(c2);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

// Pure PDF draw-op builder: same path data as SVG, pre-split into
// jsPDF-lines()-ready runs. No jsPDF/DOM dependency — js/exporter.js wires
// this into an actual document.
export function buildPdfOps({ strands, positions, mvp, width, height, stops, weight, background }) {
  const items = buildVectorPaths({ strands, positions, mvp, width, height, stops, weight });
  const strokeStrokes = items.map((it) => {
    const segs = catmullRomToBezier(it.points);
    const runs = [];
    for (let i = 0; i < segs.length; i += PDF_RUN_SEGMENTS) {
      const chunk = segs.slice(i, i + PDF_RUN_SEGMENTS);
      const start = i === 0 ? it.points[0] : segs[i - 1].end;
      const t = (i + chunk.length / 2) / Math.max(1, segs.length);
      runs.push({ start, legs: toRelativeBezierLegs(start, chunk), color: lerpHex(it.c1, it.c2, t) });
    }
    return { runs, strokeWidth: it.strokeWidth, opacity: it.opacity };
  });
  return { width, height, background: background ?? null, strokes: strokeStrokes };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/strands.js test/strands.test.js
git commit -m "feat(export): add pure PDF draw-ops builder with per-run gradient approximation"
```

---

### Task 5: `exportStrandPDF` — native vector PDF via jsPDF

**Files:**
- Modify: `js/exporter.js:1-2` (imports), and the file's `'pdf'` handling (see Step 3)

**Interfaces:**
- Consumes: `buildPdfOps` (Task 4), `hexToRgb` from `./palettes.js`, global `window.jspdf.jsPDF` (already loaded via `<script>` in `index.html:192`, same as the code being replaced).
- Produces: `exportStrandPDF({ strands, positions, mvp, width, height, stops, background, weight })` — draws and downloads `soundform.pdf` as true vector paths (no `Promise`/return value needed; matches the existing `exportStrandSVG` call-and-forget shape used by `main.js`).

- [ ] **Step 1: Implement `exportStrandPDF`**

Change the import line at the top of `js/exporter.js` from:

```js
import { buildVectorPaths, toBezierPath } from './strands.js?v=41';
import { sampleRamp, rgbToHex } from './palettes.js?v=41';
```

to:

```js
import { buildVectorPaths, toBezierPath, buildPdfOps } from './strands.js?v=41';
import { sampleRamp, rgbToHex, hexToRgb } from './palettes.js?v=41';
```

Add after `exportStrandSVG`:

```js
// Native vector PDF: same path data as exportStrandSVG, drawn with jsPDF's
// core lines() API (accepts bezier-curve segments as relative deltas) —
// no raster image embed, stays crisp at any zoom.
export function exportStrandPDF({ strands, positions, mvp, width, height, stops, background, weight }) {
  const { jsPDF } = window.jspdf;
  const ops = buildPdfOps({ strands, positions, mvp, width, height, stops, weight, background });
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

  const hasAlpha = typeof doc.setGState === 'function' && typeof doc.GState === 'function';
  doc.setLineCap('round');
  ops.strokes.forEach(({ runs, strokeWidth, opacity }) => {
    doc.setLineWidth(strokeWidth * px2mm);
    if (hasAlpha) doc.setGState(new doc.GState({ opacity }));
    runs.forEach(({ start, legs, color }) => {
      const [r, g, b] = hexToRgb(color).map((v) => Math.round(v * 255));
      doc.setDrawColor(r, g, b);
      doc.lines(legs, start[0] * px2mm, start[1] * px2mm, [px2mm, px2mm], 'S', false);
    });
  });
  if (hasAlpha) doc.setGState(new doc.GState({ opacity: 1 }));

  doc.save('soundform.pdf');
}
```

- [ ] **Step 2: Run the full test suite to confirm nothing broke**

Run: `npm test`
Expected: PASS — `exportStrandPDF` itself isn't unit-tested here (it's a thin jsPDF/DOM wiring function with no meaningful pure logic of its own — everything testable about it is already covered by `buildPdfOps` in Task 4), but the suite must stay green.

Note: `exportStrandPDF` is not wired into the UI yet (`main.js` still routes the PDF button to the old raster path until Task 6) — manual browser verification of the actual PDF output happens in Task 6, once clicking PDF in the app really calls this function.

- [ ] **Step 3: Commit**

```bash
git add js/exporter.js
git commit -m "feat(export): native vector PDF export via jsPDF, replacing the raster image embed"
```

---

### Task 6: Wire PDF into `main.js`'s export button, make the guard format-agnostic

**Files:**
- Modify: `js/main.js:5, 523-611`
- Modify: `js/exporter.js:18-31` (remove the now-dead raster PDF case)

**Interfaces:**
- Consumes: `exportStrandPDF` (Task 5), existing `exportStrandSVG`.

- [ ] **Step 1: Remove the now-dead raster PDF case from `exportCanvas`**

In `js/exporter.js`, delete the entire `case 'pdf': { ... }` block from `exportCanvas` (currently lines 18-31 — the block that builds a jsPDF doc via `doc.addImage(_onBlack(...))`). `_onBlack` itself must stay — it's still used by the `'jpg'` case. This is safe to remove now because the steps below stop `main.js` from ever calling `exportCanvas(canvas, 'pdf')`.

- [ ] **Step 2: Update the import**

Change line 5 of `js/main.js` from:

```js
import { exportCanvas, exportStrandSVG, framePlan, exportMP4, loopsForDuration } from './exporter.js?v=41';
```

to:

```js
import { exportCanvas, exportStrandSVG, exportStrandPDF, framePlan, exportMP4, loopsForDuration } from './exporter.js?v=41';
```

- [ ] **Step 3: Route `'pdf'` through the strand-gathering branch instead of the raster branch**

In the `bindExport` click handler (`js/main.js:523-611`), change the condition and body currently starting at:

```js
        if (fmt === 'svg') {
          if (!design) { setStatus('Create a design first'); return; }
          if (!design.strands.length) {
            setStatus('SVG needs a shape design — painted captures have no paths. Try PNG/JPG/WebP, or nudge a Form slider to regenerate a shape.');
            return;
          }
```

to:

```js
        if (fmt === 'svg' || fmt === 'pdf') {
          if (!design) { setStatus('Create a design first'); return; }
          if (!design.strands.length) {
            setStatus('Vector export needs a shape design — painted captures with no revealed strokes have no paths yet. Try PNG/JPG/WebP, or nudge a Form slider to regenerate a shape.');
            return;
          }
```

Leave the strand-picking and motion-displacement block right after (`const all = design.strands; ... expStrands = ...; expPositions = ...;`) unchanged — it's format-agnostic already.

Then change the tail of that same branch, currently:

```js
          const svg = exportStrandSVG({
            strands: expStrands,
            positions: expPositions,
            mvp: renderer.getMVP().elements,
            width: 1600, height: 1200,
            stops: activeStops(), background: params.transparentBg ? null : params.background,
            weight: params.strokeWeight,
          });
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          const a = Object.assign(document.createElement('a'), { href: url, download: 'soundform.svg' });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        } else if (fmt === 'mp4') {
```

to:

```js
          const vecArgs = {
            strands: expStrands,
            positions: expPositions,
            mvp: renderer.getMVP().elements,
            width: 1600, height: 1200,
            stops: activeStops(), background: params.transparentBg ? null : params.background,
            weight: params.strokeWeight,
          };
          if (fmt === 'svg') {
            const svg = exportStrandSVG(vecArgs);
            const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            const a = Object.assign(document.createElement('a'), { href: url, download: 'soundform.svg' });
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 3000);
          } else {
            exportStrandPDF(vecArgs);
          }
        } else if (fmt === 'mp4') {
```

- [ ] **Step 4: Remove `'pdf'` from the raster branch**

Later in the same handler, the raster (else) branch currently reads:

```js
        } else {
          const RES_PX = { std: null, '2k': 2400, '4k': 3840, '8k': 7680 };
          const container = document.getElementById('renderer-container');
          const target = RES_PX[params.exportRes];
          const scale = fmt === 'pdf' ? 2
            : (target ? target / Math.max(container.clientWidth || 800, container.clientHeight || 600) : 3);
          const transparent = params.transparentBg && (fmt === 'png' || fmt === 'webp');
          const canvas = renderer.renderHiRes(scale, { transparent });
          if (renderer.exportNote) setStatus(renderer.exportNote);
          await exportCanvas(canvas, fmt);
        }
```

Change to (this branch now only ever receives `png`/`jpg`/`webp`, since `svg`/`pdf`/`mp4` are all handled above):

```js
        } else {
          const RES_PX = { std: null, '2k': 2400, '4k': 3840, '8k': 7680 };
          const container = document.getElementById('renderer-container');
          const target = RES_PX[params.exportRes];
          const scale = target ? target / Math.max(container.clientWidth || 800, container.clientHeight || 600) : 3;
          const transparent = params.transparentBg && (fmt === 'png' || fmt === 'webp');
          const canvas = renderer.renderHiRes(scale, { transparent });
          if (renderer.exportNote) setStatus(renderer.exportNote);
          await exportCanvas(canvas, fmt);
        }
```

- [ ] **Step 5: Manual browser verification**

There is no `main.js` test file in this project (it's DOM-wiring glue, verified manually like the rest of the export UI). Run the app locally (e.g. `python3 -m http.server` from the repo root, or any static server), create a classic (non-Paint) design, and click each export button in turn:
- PNG, JPG, WebP still work exactly as before (raster branch unaffected).
- SVG still downloads as before.
- PDF now downloads immediately as a vector file (no `addImage`/JPEG step) — open it and confirm: strokes stay sharp when zoomed in far (they're vector, not pixelated); stroke colors visually approximate the app's gradient (banded, not flat, unless this jsPDF build lacks the GState/alpha plugin, in which case fully-opaque solid-banded strokes are expected graceful degradation, not a bug); the background fill matches the app's background color.

Then freeze a Paint capture and click PDF/SVG — confirm the "Vector export needs a shape design" message still appears if you freeze before any points painted (this is expected until Task 9 lands later in this plan; a normal Paint capture won't have real strokes to export until then).

- [ ] **Step 6: Commit**

```bash
git add js/main.js js/exporter.js
git commit -m "feat(export): wire PDF button to native vector export, make the shape-design guard format-agnostic"
```

---

### Task 7: Reveal-based Paint keeps its strand data through freeze

**Files:**
- Modify: `js/live.js:92, 106-113, 182-205, 301-309`
- Test: `test/live.test.js`

**Interfaces:**
- Produces: `clipStrandsToCount(strands, revealTotal, count) -> Array<Float32Array>` — a pure, exported helper. If `count >= revealTotal`, returns `strands` unchanged (full fidelity, the common freeze-after-completion case). Otherwise returns each strand truncated to the fraction `count / revealTotal` of its own point count (rounded down to whole 3-float triples), independently per strand.
- Modifies `LiveConductor`: `this.paint` gains a `strands` field (default `[]`); `freeze()`'s `out.cloud` gains a `strands` field for the non-attractor (`st.brush` falsy) case.

- [ ] **Step 1: Write the failing tests**

Add to `test/live.test.js` (add `clipStrandsToCount` to the existing `import { LiveConductor, LIVE_MIN_FRAMES } from '../js/live.js';` line):

```js
import { LiveConductor, LIVE_MIN_FRAMES, clipStrandsToCount } from '../js/live.js';

test('clipStrandsToCount returns strands unchanged when the reveal completed', () => {
  const strands = [new Float32Array(30), new Float32Array(60)]; // 10 and 20 points
  const out = clipStrandsToCount(strands, 1000, 1000);
  assert.equal(out, strands);
});

test('clipStrandsToCount truncates every strand to the same revealed fraction', () => {
  const a = new Float32Array(40 * 3); // 40 points
  const b = new Float32Array(10 * 3); // 10 points
  const out = clipStrandsToCount([a, b], 1000, 500); // 50% revealed
  assert.equal(out[0].length, 20 * 3, 'strand a truncated to 50% of its own points');
  assert.equal(out[1].length, 5 * 3, 'strand b truncated to 50% of its own points');
});

test('paint (non-attractor): freeze attaches the revealed strands', async () => {
  const strandA = new Float32Array(200 * 3);
  const { conductor } = harness({
    generate: async (fp, p) => ({
      positions: new Float32Array(p.density * 3), attr: new Float32Array(p.density),
      strands: [strandA],
    }),
    getParams: () => ({ mode: 'radial', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, paintMaxPoints: 5000,
                        exposure: 30, scale: 1, grain: 1 }),
  });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud.strands, 'strands must be attached to the frozen cloud');
  assert.equal(out.cloud.strands.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `clipStrandsToCount` is not exported; the freeze test fails because `out.cloud.strands` is `undefined`.

- [ ] **Step 3: Implement in `js/live.js`**

Add this exported pure function near the top-level exports (alongside `trimWindow`/`fingerprintDelta`, before the `LiveConductor` class):

```js
// Reveal-based Paint: `strands` (sparse backbone curves, for export) and
// `positions`/`attr` (the dense rendered cloud `count` indexes into) come
// from the same generator call but are NOT index-aligned with each other.
// If the reveal reached completion, use strands as-is (full fidelity, the
// common case). If frozen mid-reveal, truncate each strand independently to
// the same fraction as an honest approximation — not a claim of exact
// per-point alignment between the two arrays.
export function clipStrandsToCount(strands, revealTotal, count) {
  if (!revealTotal || count >= revealTotal) return strands;
  const frac = count / revealTotal;
  return strands.map((s) => {
    const keep = Math.max(0, Math.floor((s.length / 3) * frac)) * 3;
    return s.subarray(0, keep);
  });
}
```

Change line 92 (`this.paint = null;` comment) from:

```js
    this.paint = null;           // { pace, brush, count, revealTotal, pendingGen, retried, done, begun }
```

to:

```js
    this.paint = null;           // { pace, brush, count, revealTotal, strands, segments, pendingGen, retried, done, begun }
```

Change `setGrowthMode` (currently lines 106-113):

```js
  setGrowthMode(mode) {
    this.growthMode = mode;
    this.growGen++;
    this.paint = mode === 'paint'
      ? { pace: new BrushPace(), brush: null, count: 0, revealTotal: 0,
          pendingGen: false, retried: false, done: false, begun: false }
      : null;
  }
```

to:

```js
  setGrowthMode(mode) {
    this.growthMode = mode;
    this.growGen++;
    this.paint = mode === 'paint'
      ? { pace: new BrushPace(), brush: null, count: 0, revealTotal: 0, strands: [], segments: [0],
          pendingGen: false, retried: false, done: false, begun: false }
      : null;
  }
```

In `_requestReveal` (currently lines 182-205), change:

```js
        st.retried = false;
        const total = out.attr.length;
        const from = Math.min(spliceFrom, total);
        this.renderer.writePaintPoints(from,
          out.positions.subarray(from * 3), out.attr.subarray(from));
        st.revealTotal = total;
```

to:

```js
        st.retried = false;
        const total = out.attr.length;
        const from = Math.min(spliceFrom, total);
        this.renderer.writePaintPoints(from,
          out.positions.subarray(from * 3), out.attr.subarray(from));
        st.revealTotal = total;
        st.strands = out.strands;
```

In `freeze()` (currently lines 301-309), change:

```js
  freeze() {
    if (this.frames.length < LIVE_MIN_FRAMES) return null;
    this.stop();
    const out = { fingerprint: this.windowFingerprint(), stops: stopsToHex(this.colour) };
    if (this.growthMode === 'paint' && this.paint && this.paint.count > 0) {
      out.cloud = this.renderer.getPaintSlice(this.paint.count);
    }
    return out;
  }
```

to:

```js
  freeze() {
    if (this.frames.length < LIVE_MIN_FRAMES) return null;
    this.stop();
    const out = { fingerprint: this.windowFingerprint(), stops: stopsToHex(this.colour) };
    if (this.growthMode === 'paint' && this.paint && this.paint.count > 0) {
      const st = this.paint;
      out.cloud = this.renderer.getPaintSlice(st.count);
      out.cloud.strands = st.brush
        ? [] // attractor-brush segments are attached in Task 8
        : clipStrandsToCount(st.strands, st.revealTotal, st.count);
    }
    return out;
  }
```

(Task 8 replaces the `st.brush ? [] : ...` branch's `[]` with real segment slicing — this task only handles the non-attractor path, so the placeholder `[]` here is intentionally the correct *final* behavior for attractor captures until Task 8 lands, not a stub left behind.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(paint): keep revealed strand data through freeze for reveal-based Paint captures"
```

---

### Task 8: Attractor-brush Paint gets stroke segments through freeze

**Files:**
- Modify: `js/live.js:159-178, 301-309` (the `freeze()` change here supersedes the placeholder from Task 7)
- Test: `test/live.test.js`

**Interfaces:**
- Produces: `sliceSegments(positions, boundaries, count) -> Array<Float32Array>` — a pure, exported helper. Slices an ordered position buffer into consecutive segments at the given point-index boundaries, up to `count`.
- Modifies `LiveConductor`: `_paintTick` records a segment boundary (`st.segments.push(st.count)`) each time the orbit brush is steered; `freeze()`'s attractor branch (`st.brush` truthy) now attaches real segments instead of `[]`.

- [ ] **Step 1: Write the failing tests**

Add to `test/live.test.js` (add `sliceSegments` to the existing import line from Task 7):

```js
import { LiveConductor, LIVE_MIN_FRAMES, clipStrandsToCount, sliceSegments } from '../js/live.js';

test('sliceSegments with no steer boundaries returns one segment covering everything', () => {
  const positions = new Float32Array(300); // 100 points
  const out = sliceSegments(positions, [0], 100);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 300);
});

test('sliceSegments splits at each recorded boundary', () => {
  const positions = new Float32Array(1500); // 500 points
  const out = sliceSegments(positions, [0, 200, 350], 500);
  assert.equal(out.length, 3);
  assert.equal(out[0].length, 200 * 3);
  assert.equal(out[1].length, 150 * 3);
  assert.equal(out[2].length, 150 * 3);
});

test('paint (attractor): steering records a segment boundary, freeze attaches segments', async () => {
  const frame = { current: mkFrame() };
  const { conductor } = harness({ frame });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30); // 3s — paints, no steer yet
  await settle();
  const c2 = new Float32Array(12); c2[2] = 1; c2[6] = 0.85; c2[9] = 0.9; // different chord
  frame.current = mkFrame({ pitchHz: 880, chroma: c2 });
  for (let i = 90; i < 300; i++) conductor.tick(i / 30); // steer should fire on the change
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud.strands.length >= 1, 'at least one segment attached');
  const totalPoints = out.cloud.strands.reduce((n, s) => n + s.length / 3, 0);
  assert.equal(totalPoints, out.cloud.positions.length / 3, 'segments cover exactly the painted points');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `sliceSegments` is not exported; the attractor freeze test fails because `out.cloud.strands` is `[]` (the Task 7 placeholder).

- [ ] **Step 3: Implement in `js/live.js`**

Add this exported pure function next to `clipStrandsToCount`:

```js
// Attractor-brush Paint has no discrete strands — writePaintPoints appends
// at strictly increasing offsets, so the point buffer is already one
// continuous stroke in time order. Slice it into segments at each recorded
// steer() boundary so downstream RDP simplification runs per-segment
// instead of over one enormous strand.
export function sliceSegments(positions, boundaries, count) {
  const bounds = boundaries.filter((b) => b < count).concat(count);
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b > a) out.push(positions.subarray(a * 3, b * 3));
  }
  return out;
}
```

In `_paintTick` (currently lines 159-178), change:

```js
    if (st.brush) {
      st.brush.steer(fp);                       // ribbons bend from here on
    } else if (!st.pendingGen) {
```

to:

```js
    if (st.brush) {
      st.segments.push(st.count);                // mark the bend as a segment boundary
      st.brush.steer(fp);                        // ribbons bend from here on
    } else if (!st.pendingGen) {
```

In `freeze()` (as left by Task 7), change:

```js
      out.cloud.strands = st.brush
        ? [] // attractor-brush segments are attached in Task 8
        : clipStrandsToCount(st.strands, st.revealTotal, st.count);
```

to:

```js
      out.cloud.strands = st.brush
        ? sliceSegments(out.cloud.positions, st.segments, st.count)
        : clipStrandsToCount(st.strands, st.revealTotal, st.count);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(paint): slice attractor-brush strokes into export segments at steer boundaries"
```

---

### Task 9: `main.js` freeze handler stops hardcoding empty strands

**Files:**
- Modify: `js/main.js:330`

**Interfaces:**
- Consumes: `out.cloud.strands` (Tasks 7 & 8).

- [ ] **Step 1: Update the freeze handler**

In `js/main.js`, change (currently line 330):

```js
        design = { positions: out.cloud.positions, attr: out.cloud.attr, strands: [] };
```

to:

```js
        design = { positions: out.cloud.positions, attr: out.cloud.attr, strands: out.cloud.strands || [] };
```

- [ ] **Step 2: Manual browser verification**

No automated test covers this line (DOM-wiring glue, same as the rest of `main.js`). Run the app locally:
- Radial (or Harmonic/Oscillo/Cymatics) mode, Growth: Paint, make sound until "Painting complete", freeze, click SVG — confirm it now exports paths instead of the "needs a shape design" message.
- Attractor mode, Growth: Paint, make varied sound so it steers at least once, freeze before "complete" (freeze mid-painting), click SVG — confirm it exports the painted-so-far strokes.
- Confirm the exported SVG's shape visually resembles the frozen on-screen design (per this plan's goal — strokes/colors, not glow/grain).

- [ ] **Step 3: Commit**

```bash
git add js/main.js
git commit -m "feat(paint): Paint captures now export as vector SVG/PDF using their recovered strand data"
```

---

### Task 10: Cache-bust bump and final verification

**Files:**
- Modify: `index.html:10, 194`, `js/audio.js`, `js/exporter.js`, `js/live.js`, `js/livecolor.js`, `js/main.js`, `js/worker.js` (every `?v=41` occurrence)

- [ ] **Step 1: Bump the version**

Run a repo-wide replace of the cache-bust query string (23 occurrences across the 7 files listed above — verify the count matches before and after):

```bash
grep -rl '?v=41' --include='*.js' --include='*.html' . | grep -v node_modules \
  | xargs sed -i '' 's/?v=41/?v=42/g'
```

- [ ] **Step 2: Verify the bump landed everywhere and nothing else changed**

Run:

```bash
grep -rn '?v=41' --include='*.js' --include='*.html' . | grep -v node_modules
```

Expected: no output (zero remaining `?v=41` references).

```bash
git diff --stat
```

Expected: only `?v=41` → `?v=42` line changes across the 7 files — no other diffs.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all tests green, including every test added in Tasks 1–9.

- [ ] **Step 4: Final manual smoke test**

Run the app locally and, in one pass: export PNG/JPG/WebP/MP4 (unaffected by this plan — confirm they still work), export SVG and PDF for a classic design, and export SVG and PDF for both a reveal-based Paint capture and an attractor-brush Paint capture. Confirm no console errors on any export.

- [ ] **Step 5: Commit**

```bash
git add index.html js/audio.js js/exporter.js js/live.js js/livecolor.js js/main.js js/worker.js
git commit -m "chore: bump cache-bust to v=42 for vector export fidelity work"
```
