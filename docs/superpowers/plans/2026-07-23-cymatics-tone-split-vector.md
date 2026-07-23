# Cymatics Tone-Split Fine-Fringe Vector Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cymatics SVG/PDF exports read like the on-screen render: fine fringe rings at the on-screen striation radii, broken at nodal voids, tone-split so colour/opacity/width vary along each ring like the raster tonemap.

**Architecture:** The cymatics generator emits strand objects `{ pts, tone, band, ring }` instead of bare Float32Arrays (one ring per bright fringe of `cos(kFine·r)`, runs split at void gaps and quantized tone boundaries). The shared vector builder (`buildVectorPaths`) styles tone strands with flat palette colours per 5-level tone class; SVG groups them into 8 radial-band `<g>` layers, PDF draws them as single flat-colour runs. All other modes keep bare-array strands and current styling untouched.

**Tech Stack:** Vanilla ES modules, no build step. `node --test` for unit tests. Playwright headless Chromium for E2E (dev-only install).

**Spec:** `docs/superpowers/specs/2026-07-23-cymatics-tone-split-vector-design.md`

## Global Constraints

- No change to point-cloud output (`positions`/`attr`) — golden snapshot checksums in `test/snapshot.test.js` must pass unmodified. Ring building must use no `rnd()` calls.
- Path budget: ≤ 4800 exported arcs after symmetry replication (`PATH_CAP`).
- Transparent export: no background element added for tone strands (existing `background` param behaviour for legacy callers unchanged).
- Cache-bust convention: every `?v=NN` occurrence moves together, v=43 → v=44, in exactly these 8 files: `index.html`, `js/audio.js`, `js/exporter.js`, `js/live.js`, `js/livecolor.js`, `js/main.js`, `js/strands.js`, `js/worker.js`. Files under `js/generators/` and `js/vendor/` are never versioned.
- Tone quantization is 5 levels everywhere: `TONE_CLASSES = 5` in `js/strands.js`, `TONE_LEVELS = 5` in `js/generators/cymatics.js` — these must stay equal (generators can't import versioned modules, so the constant is duplicated with a comment).
- Run the full suite (`npm test`) at the end of every task; all tests green before each commit.

---

### Task 1: `finalize()` accepts object strands

**Files:**
- Modify: `js/generators/common.js:80-108` (the `finalize` function)
- Test: `test/common.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `finalize(positions, attr, strands, params)` where each element of `strands` is either a bare `Float32Array` (unchanged behaviour) or `{ pts: Float32Array, tone: number, band: number, ring: number }`. Object strands are normalized/replicated/twisted via their `.pts`; `tone`/`band`/`ring` are preserved on every symmetry copy. Later tasks rely on exactly this object shape.

- [ ] **Step 1: Write the failing test**

Append to `test/common.test.js` (extend the existing import from `../js/generators/common.js` to include `finalize` and `mulberry32` if not already imported):

```js
test('finalize: object strands ({pts,tone,band,ring}) normalize, replicate, keep metadata', () => {
  const rnd = mulberry32(42);
  const positions = new Float32Array(60);
  for (let i = 0; i < 60; i++) positions[i] = (rnd() - 0.5) * 4;
  const attr = new Float32Array(20).fill(0.5);
  const pts = new Float32Array([1, 0, 0, 0, 1, 0, -1, 0, 0]);
  const out = finalize(positions, attr, [{ pts, tone: 0.7, band: 3, ring: 5 }],
    { symmetry: 2, twist: 0.3 });
  assert.equal(out.strands.length, 2, 'symmetry 2 replicates the strand');
  for (const s of out.strands) {
    assert.equal(s.tone, 0.7);
    assert.equal(s.band, 3);
    assert.equal(s.ring, 5);
    assert.ok(s.pts instanceof Float32Array);
    for (const v of s.pts) assert.ok(Number.isFinite(v));
  }
  assert.notDeepEqual([...out.strands[0].pts], [...out.strands[1].pts],
    'the two symmetry copies must be rotated apart');
});

test('finalize: bare-array strands still work unchanged', () => {
  const rnd = mulberry32(7);
  const positions = new Float32Array(60);
  for (let i = 0; i < 60; i++) positions[i] = (rnd() - 0.5) * 4;
  const attr = new Float32Array(20).fill(0.5);
  const bare = new Float32Array([1, 0, 0, 0, 1, 0]);
  const out = finalize(positions, attr, [bare], { symmetry: 2, twist: 0 });
  assert.equal(out.strands.length, 2);
  for (const s of out.strands) assert.ok(s instanceof Float32Array);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/common.test.js`
Expected: FAIL — object strand crashes (`applyNormalization` iterates `s.length` which is `undefined` on an object) or metadata assertions fail.

- [ ] **Step 3: Implement**

Replace the `finalize` function in `js/generators/common.js` with:

```js
// Standard post-pass every generator calls last:
// normalize (using the CLOUD's transform for strands too, so they stay aligned),
// then symmetry replication, then twist. A strand is either a bare
// Float32Array or { pts, tone, band, ring } — object strands transform via
// .pts and keep their metadata on every symmetry copy.
export function finalize(positions, attr, strands, params) {
  const t = computeNormalization(positions);
  applyNormalization(positions, t);
  for (const s of strands) applyNormalization(s.pts ?? s, t);

  const k = Math.max(1, Math.round(params.symmetry || 1));
  let outPos = positions, outAttr = attr, outStrands = strands;
  if (k > 1) {
    outPos = replicateSymmetry(positions, k);
    outAttr = new Float32Array(attr.length * k);
    for (let j = 0; j < k; j++) outAttr.set(attr, j * attr.length);
    outStrands = [];
    for (let j = 0; j < k; j++) {
      const ang = (j / k) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
      for (const st of strands) {
        const src = st.pts ?? st;
        const copy = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
          copy[i] = src[i] * c + src[i + 2] * s;
          copy[i + 1] = src[i + 1];
          copy[i + 2] = -src[i] * s + src[i + 2] * c;
        }
        outStrands.push(st.pts ? { ...st, pts: copy } : copy);
      }
    }
  }
  applyTwistArr(outPos, params.twist || 0);
  for (const s of outStrands) applyTwistArr(s.pts ?? s, params.twist || 0);
  return { positions: outPos, attr: outAttr, strands: outStrands };
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/common.test.js` → PASS. Then `npm test` → all green (no other behaviour changed).

- [ ] **Step 5: Commit**

```bash
git add js/generators/common.js test/common.test.js
git commit -m "feat(strands): finalize() accepts {pts,tone,band,ring} object strands"
```

---

### Task 2: Tone styling in `buildVectorPaths`/`buildPdfOps` + `selectRingSubset`

**Files:**
- Modify: `js/strands.js:142-197` (`buildVectorPaths`, `buildPdfOps`; add tone constants and `selectRingSubset`)
- Test: `test/strands.test.js`

**Interfaces:**
- Consumes: object strand shape from Task 1.
- Produces:
  - `export const TONE_CLASSES = 5` and `export function toneClass(tone: number): number` (0-based class index 0–4).
  - `buildVectorPaths(...)` items for tone strands: `{ si, depth, points, tone, toneClass /* 1-based 1..5 */, band, ring, color /* '#rrggbb' flat */, strokeWidth, opacity, x1, y1, x2, y2 }` — **no `c1`/`c2`**. Legacy items unchanged.
  - `buildPdfOps(...)`: tone items produce exactly one run (whole path, flat colour).
  - `export function selectRingSubset(strands, frac): strands` — evenly spaced whole-ring subset, floor of 8 rings.

- [ ] **Step 1: Write the failing tests**

Append to `test/strands.test.js` (extend the import from `../js/strands.js` with `selectRingSubset`):

```js
const TONE_STOPS = [[0, '#050614'], [0.5, '#6c99ba'], [1, '#f2e6c0']];

function toneStrand(tone, band = 0, ring = 0) {
  const pts = new Float32Array(64 * 3);
  for (let i = 0; i < 64; i++) {
    const th = (i / 63) * Math.PI; // open half-circle arc
    pts[i * 3] = Math.cos(th) * 0.6;
    pts[i * 3 + 1] = 0;
    pts[i * 3 + 2] = Math.sin(th) * 0.6;
  }
  return { pts, tone, band, ring };
}

test('buildVectorPaths: tone strands get flat palette color, tone-driven width/opacity', () => {
  const items = buildVectorPaths({ strands: [toneStrand(0.05, 0, 0), toneStrand(0.95, 3, 7)],
    positions: new Float32Array(300), mvp: IDENTITY, width: 800, height: 600,
    stops: TONE_STOPS, weight: 1 });
  assert.equal(items.length, 2);
  const faint = items.find((i) => i.toneClass === 1);
  const bright = items.find((i) => i.toneClass === 5);
  assert.ok(faint && bright, 'tone 0.05 → class 1, tone 0.95 → class 5');
  assert.match(faint.color, /^#[0-9a-f]{6}$/);
  assert.ok(!('c1' in faint), 'tone strands carry a flat color, not a gradient pair');
  assert.ok(bright.opacity > faint.opacity, 'brighter tone → more opaque');
  assert.ok(bright.strokeWidth > faint.strokeWidth, 'brighter tone → wider stroke');
  assert.equal(bright.band, 3);
  assert.equal(bright.ring, 7);
});

test('buildVectorPaths: mixed tone + legacy strands both style correctly', () => {
  const legacy = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    legacy[i * 3] = Math.cos(t * 6) * 0.6;
    legacy[i * 3 + 1] = (t - 0.5) * 1.4;
    legacy[i * 3 + 2] = Math.sin(t * 6) * 0.6;
  }
  const items = buildVectorPaths({ strands: [legacy, toneStrand(0.5, 2, 4)],
    positions: legacy, mvp: IDENTITY, width: 800, height: 600, stops: TONE_STOPS, weight: 1 });
  assert.equal(items.length, 2);
  assert.ok(items.find((i) => i.color), 'tone item present');
  assert.ok(items.find((i) => i.c1), 'legacy gradient item present');
});

test('buildPdfOps: tone strand draws as a single flat-color run', () => {
  const ops = buildPdfOps({ strands: [toneStrand(0.8, 1, 2)], positions: new Float32Array(30),
    mvp: IDENTITY, width: 800, height: 600, stops: TONE_STOPS, weight: 1, background: null });
  assert.equal(ops.strokes.length, 1);
  assert.equal(ops.strokes[0].runs.length, 1, 'flat color needs no gradient-approximation runs');
  assert.match(ops.strokes[0].runs[0].color, /^#[0-9a-f]{6}$/);
});

test('selectRingSubset: keeps whole rings, scales with fraction, floor of 8', () => {
  const strands = [];
  for (let ring = 0; ring < 40; ring++) {
    for (let a = 0; a < 3; a++) strands.push(toneStrand(0.5, 0, ring));
  }
  const half = selectRingSubset(strands, 0.5);
  const rings = new Set(half.map((s) => s.ring));
  assert.equal(rings.size, 20);
  for (const r of rings) {
    assert.equal(half.filter((s) => s.ring === r).length, 3, 'all arcs of a kept ring survive');
  }
  assert.equal(selectRingSubset(strands, 1).length, strands.length);
  assert.equal(new Set(selectRingSubset(strands, 0.05).map((s) => s.ring)).size, 8);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/strands.test.js`
Expected: FAIL — `selectRingSubset` not exported; tone strands crash `projectStrand` (object has no `.length`).

- [ ] **Step 3: Implement**

In `js/strands.js`, add above `buildVectorPaths`:

```js
// Tone-carrying strands (cymatics fine-fringe arcs): flat palette colour per
// quantized tone class instead of a density-grid gradient — the raster
// tonemap analogue, and Illustrator "Select → Same → Stroke Color" friendly.
// TONE_CLASSES must equal TONE_LEVELS in js/generators/cymatics.js.
export const TONE_CLASSES = 5;
const TONE_RAMP_POS = [0.25, 0.425, 0.6, 0.775, 0.95];
const TONE_OPACITY  = [0.28, 0.435, 0.59, 0.745, 0.9];
const TONE_WIDTH    = [0.5, 0.725, 0.95, 1.175, 1.4];

export function toneClass(tone) {
  return Math.max(0, Math.min(TONE_CLASSES - 1, Math.floor(tone * TONE_CLASSES)));
}

// Strands-slider mapping for tone strands: keep an evenly spaced subset of
// whole rings — a ring's tone runs only read together, so individual arcs
// are never stride-dropped the way legacy strands are.
export function selectRingSubset(strands, frac) {
  const ringIds = [...new Set(strands.map((s) => s.ring))].sort((a, b) => a - b);
  const wantRings = Math.max(8, Math.min(ringIds.length, Math.round(ringIds.length * frac)));
  const stride = ringIds.length / wantRings;
  const keep = new Set();
  for (let i = 0; i < wantRings; i++) keep.add(ringIds[Math.floor(i * stride)]);
  return strands.filter((s) => keep.has(s.ring));
}
```

Replace `buildVectorPaths` with:

```js
// Strand → simplified 2D path + resolved color/weight, ready for any
// vector format (SVG gradient stops, PDF flat-color runs) to draw from.
// Tone strands ({pts,tone,band,ring}) style from their tone class; bare
// arrays keep the density-grid gradient styling.
export function buildVectorPaths({ strands, positions, mvp, width, height, stops, weight }) {
  let grid = null; // built lazily — tone strands never sample it
  const items = [];

  strands.forEach((strand, si) => {
    const raw = strand.pts ?? strand;
    const { pts, depth } = projectStrand(raw, mvp, width, height);
    if (pts.length < 2) return;
    const simplified = simplifyToBudget(pts, 1.4, SIMPLIFY_BUDGET);
    if (simplified.length < 2) return;
    const ends = {
      x1: simplified[0][0], y1: simplified[0][1],
      x2: simplified[simplified.length - 1][0], y2: simplified[simplified.length - 1][1],
    };
    if (strand.pts) {
      const q = toneClass(strand.tone);
      items.push({
        si, depth, points: simplified,
        tone: strand.tone, toneClass: q + 1, band: strand.band, ring: strand.ring,
        color: rgbToHex(sampleRamp(stops, TONE_RAMP_POS[q])),
        strokeWidth: TONE_WIDTH[q] * weight,
        opacity: TONE_OPACITY[q],
        ...ends,
      });
      return;
    }
    grid ??= buildDensityGrid(positions);
    let dSum = 0, dN = 0;
    for (let i = 0; i < raw.length; i += 30) {
      dSum += grid.sample(raw[i], raw[i + 1], raw[i + 2]); dN++;
    }
    const density = dN ? dSum / dN : 0.3;
    items.push({
      si, depth, density, points: simplified,
      c1: rgbToHex(sampleRamp(stops, 0.35 + density * 0.3)),
      c2: rgbToHex(sampleRamp(stops, 0.6 + density * 0.4)),
      strokeWidth: (0.6 + density * 3.4) * weight,
      opacity: 0.35 + density * 0.55,
      ...ends,
    });
  });

  items.sort((a, b) => b.depth - a.depth); // far strands first (painter's order)
  return items;
}
```

In `buildPdfOps`, replace the `strokeStrokes` mapping body with:

```js
  const strokeStrokes = items.map((it) => {
    const segs = catmullRomToBezier(it.points);
    if (it.color) {
      // Tone strand: one flat-color run covers the whole path.
      return {
        runs: [{ start: it.points[0], legs: toRelativeBezierLegs(it.points[0], segs), color: it.color }],
        strokeWidth: it.strokeWidth, opacity: it.opacity,
      };
    }
    const runs = [];
    for (let i = 0; i < segs.length; i += PDF_RUN_SEGMENTS) {
      const chunk = segs.slice(i, i + PDF_RUN_SEGMENTS);
      const start = i === 0 ? it.points[0] : segs[i - 1].end;
      const t = (i + chunk.length / 2) / Math.max(1, segs.length);
      runs.push({ start, legs: toRelativeBezierLegs(start, chunk), color: lerpHex(it.c1, it.c2, t) });
    }
    return { runs, strokeWidth: it.strokeWidth, opacity: it.opacity };
  });
```

- [ ] **Step 4: Run tests**

Run: `node --test test/strands.test.js` → PASS. Then `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add js/strands.js test/strands.test.js
git commit -m "feat(strands): tone-class flat styling + ring-subset selection for tone strands"
```

---

### Task 3: Cymatics generator — fringe rings with tone-split runs

**Files:**
- Modify: `js/generators/cymatics.js:115-168` (strand section of `generate`; add `toneRuns` helper; keep `boxcarMean`, `visibleRuns`, `closeLoop`)
- Test: `test/generators.test.js` (update `checkGenerator` strand-finiteness loop; replace the `cymatics strands:` test; add `toneRuns` tests)

**Interfaces:**
- Consumes: `finalize` object-strand support (Task 1); `resamplePolyline` from `./common.js`.
- Produces: `generate()` for cymatics returns `strands` as `{ pts: Float32Array, tone: number /* 0..1 mean smoothed amplitude */, band: number /* 0..7 */, ring: number /* index into fringe radii */ }[]`. Also `export function toneRuns(smoothed: Float32Array, cutoff: number, levels: number, minRun: number): { indices: number[], tone: number }[]`.

- [ ] **Step 1: Update `checkGenerator` for both strand forms**

In `test/generators.test.js`, replace the strand-finiteness line inside `checkGenerator`:

```js
  for (const s of out.strands) {
    const arr = s.pts ?? s;
    for (let i = 0; i < arr.length; i += 1) assert.ok(Number.isFinite(arr[i]), `${mode}: non-finite strand value`);
  }
```

- [ ] **Step 2: Write the failing tests**

In `test/generators.test.js`, add to the imports:

```js
import { toneRuns } from '../js/generators/cymatics.js';
```

Add the `toneRuns` unit tests:

```js
test('toneRuns: splits at tone boundaries, gaps below cutoff', () => {
  const smoothed = new Float32Array(30);
  for (let i = 0; i < 10; i++) smoothed[i] = 0.25;  // level 1
  for (let i = 10; i < 20; i++) smoothed[i] = 0.85; // level 4
  for (let i = 20; i < 30; i++) smoothed[i] = 0.02; // void
  const runs = toneRuns(smoothed, 0.12, 5, 4);
  assert.equal(runs.length, 2, 'one low-tone run, one high-tone run, void emits nothing');
  const tones = runs.map((r) => r.tone).sort((a, b) => a - b);
  assert.ok(Math.abs(tones[0] - 0.25) < 0.01);
  assert.ok(Math.abs(tones[1] - 0.85) < 0.01);
  const all = runs.flatMap((r) => r.indices);
  assert.equal(new Set(all).size, 20, 'every visible sample lands in exactly one run');
});

test('toneRuns: a sliver segment merges into a neighbor, adjacent same-level runs coalesce', () => {
  const smoothed = new Float32Array(20);
  for (let i = 0; i < 9; i++) smoothed[i] = 0.3;
  for (let i = 9; i < 11; i++) smoothed[i] = 0.9; // 2-sample sliver
  for (let i = 11; i < 20; i++) smoothed[i] = 0.3;
  const runs = toneRuns(smoothed, 0.12, 5, 4);
  assert.equal(runs.length, 1, 'sliver absorbed and same-level halves coalesced');
  assert.equal(runs[0].indices.length, 20);
});
```

Replace the entire `test('cymatics strands: field-following arcs, gaps in nodal voids, no straight radial spokes', ...)` block with:

```js
test('cymatics strands: tone-split fringe arcs with band/ring metadata', () => {
  const out = generate(testFingerprint(), { ...baseParams, mode: 'cymatics' });
  assert.ok(out.strands.length >= 24, 'fringe set must be substantial');
  assert.ok(out.strands.length <= 4800, 'path cap');

  const rings = new Set(), toneClasses = new Set();
  for (const s of out.strands) {
    assert.ok(s.pts instanceof Float32Array, 'tone strands carry pts');
    assert.ok(s.tone >= 0 && s.tone <= 1, `tone out of range: ${s.tone}`);
    assert.ok(Number.isInteger(s.band) && s.band >= 0 && s.band <= 7, `bad band: ${s.band}`);
    assert.ok(Number.isInteger(s.ring) && s.ring >= 0, `bad ring: ${s.ring}`);
    rings.add(s.ring);
    toneClasses.add(Math.min(4, Math.floor(s.tone * 5)));
    // A real arc sweeps a real angular range — a radial spoke or point does not.
    const angles = [];
    for (let i = 0; i < s.pts.length; i += 3) angles.push(Math.atan2(s.pts[i + 2], s.pts[i]));
    let spread = 0;
    for (let i = 1; i < angles.length; i++) {
      let d = angles[i] - angles[i - 1];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      spread += Math.abs(d);
    }
    assert.ok(spread > 0.02, 'arc must sweep a real angular range');
  }
  assert.ok(rings.size >= 20, `ring count should reflect the fine fringe set, got ${rings.size}`);
  assert.ok(toneClasses.size >= 2, 'arcs must span multiple tone classes, not one flat tone');
  assert.ok(out.strands.length > rings.size,
    'rings must split into multiple arcs at voids and tone boundaries');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/generators.test.js`
Expected: FAIL — `toneRuns` not exported; cymatics strands are still bare arrays.

- [ ] **Step 4: Implement**

In `js/generators/cymatics.js`, replace the whole strand section (from the `// Strands:` comment through the `strands.push(...)`/`return finalize(...)` lines, i.e. current lines 115-168) with:

```js
  // Strands: one ring per bright fringe — the peaks of the same cos(kFine·r)
  // term that draws the on-screen striations — instead of uniformly spaced
  // rings. Each ring keeps the amplitude bulge and the smoothed void-gap
  // logic, and is additionally split wherever the smoothed amplitude crosses
  // a quantized tone boundary, so every exported arc carries the field
  // amplitude (tone) the raster renders as brightness, plus its radial band.
  // No rnd() calls here: the RNG stream feeding the point cloud stays intact.
  const RING_AMP_GAIN = 0.25;
  const RING_SAMPLES = 220;
  const VOID_CUTOFF = 0.12;
  const VOID_SMOOTH_WINDOW = 15; // angular samples; smooths out single-ripple
                                  // gaps so only sustained nodal regions break a ring
  const MIN_RUN = 6;              // samples; shorter tone segments merge into a neighbor
  const PATH_CAP = 4800;          // max exported arcs after symmetry replication

  const ringRadii = [];
  for (let n = 1; ; n++) {
    const r = (n * Math.PI) / kFine; // |cos(kFine·r)| peaks where kFine·r = nπ
    if (r > 0.995) break;
    ringRadii.push(r);
  }

  const ringArcs = ringRadii.map((r0) => {
    const ringPts = new Float32Array(RING_SAMPLES * 3);
    const af0 = new Float32Array(RING_SAMPLES);
    for (let i = 0; i < RING_SAMPLES; i++) {
      const th = (i / RING_SAMPLES) * Math.PI * 2;
      const f = field(r0, th) / fMax;
      const r = r0 * (1 + RING_AMP_GAIN * f);
      ringPts[i * 3] = Math.cos(th) * r;
      ringPts[i * 3 + 1] = f * relief;
      ringPts[i * 3 + 2] = Math.sin(th) * r;
      af0[i] = Math.abs(f);
    }
    const smoothed = boxcarMean(af0, VOID_SMOOTH_WINDOW);
    const arcs = [];
    for (const run of toneRuns(smoothed, VOID_CUTOFF, TONE_LEVELS, MIN_RUN)) {
      if (run.indices.length < 4) continue; // sliver, not worth a stroke
      const arcPts = new Float32Array(run.indices.length * 3);
      run.indices.forEach((i, j) => {
        arcPts[j * 3] = ringPts[i * 3];
        arcPts[j * 3 + 1] = ringPts[i * 3 + 1];
        arcPts[j * 3 + 2] = ringPts[i * 3 + 2];
      });
      const closed = run.indices.length === RING_SAMPLES;
      const src = closed ? closeLoop(arcPts) : arcPts;
      const m = closed ? 200 : Math.max(6, Math.round(200 * run.indices.length / RING_SAMPLES));
      arcs.push({ pts: resamplePolyline(src, m), tone: run.tone });
    }
    return arcs;
  });

  // Path budget: k-fold symmetry replicates every arc k times — thin whole
  // rings (never individual arcs) until the estimate fits the cap.
  const totalArcs = ringArcs.reduce((a, r) => a + r.length, 0) * k;
  const ringStride = Math.max(1, Math.ceil(totalArcs / PATH_CAP));
  const strands = [];
  ringArcs.forEach((arcs, ri) => {
    if (ri % ringStride) return;
    const band = Math.min(7, Math.floor(ringRadii[ri] * 8));
    for (const a of arcs) strands.push({ pts: a.pts, tone: a.tone, band, ring: ri });
  });
  return finalize(positions.subarray(0, count * 3).slice(), attr.subarray(0, count).slice(), strands, params);
```

Note: `k` (symmetry) is already defined at the top of `generate`. The old `want`/`strandCount` line is deleted — the Strands slider now applies at export time (Task 5).

Add near the bottom of the file (above `boxcarMean` is fine), plus a module-level constant at the top of the file after the imports:

```js
// Tone quantization levels — must equal TONE_CLASSES in js/strands.js
// (generators never import versioned modules, so the constant is duplicated).
const TONE_LEVELS = 5;
```

```js
function levelOf(a, levels) {
  return Math.max(0, Math.min(levels - 1, Math.floor(a * levels)));
}

// Splits a circular per-sample amplitude array into contiguous runs that are
// (a) above the void cutoff and (b) within a single quantized tone level.
// Segments shorter than minRun merge into their larger neighbor, and adjacent
// same-level segments coalesce, so tone boundaries never fragment an arc into
// slivers. Returns [{ indices, tone }], tone = the run's mean amplitude.
export function toneRuns(smoothed, cutoff, levels, minRun) {
  const n = smoothed.length;
  const visible = new Uint8Array(n);
  for (let i = 0; i < n; i++) visible[i] = smoothed[i] >= cutoff ? 1 : 0;
  const out = [];
  for (const vis of visibleRuns(visible)) {
    const sub = [];
    for (const idx of vis) {
      const lv = levelOf(smoothed[idx], levels);
      const last = sub[sub.length - 1];
      if (last && last.level === lv) last.indices.push(idx);
      else sub.push({ level: lv, indices: [idx] });
    }
    for (let i = 0; i < sub.length; ) {
      if (sub.length === 1 || sub[i].indices.length >= minRun) { i++; continue; }
      const prev = sub[i - 1], next = sub[i + 1];
      if (prev && (!next || prev.indices.length >= next.indices.length)) {
        prev.indices.push(...sub[i].indices);
      } else {
        next.indices.unshift(...sub[i].indices);
      }
      sub.splice(i, 1);
    }
    for (let i = 1; i < sub.length; ) {
      if (sub[i].level === sub[i - 1].level) {
        sub[i - 1].indices.push(...sub[i].indices);
        sub.splice(i, 1);
      } else i++;
    }
    for (const seg of sub) {
      let sum = 0;
      for (const idx of seg.indices) sum += smoothed[idx];
      out.push({ indices: seg.indices, tone: sum / seg.indices.length });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests**

Run: `node --test test/generators.test.js` → PASS (including the untouched `cymatics generator`, prosody, and atonal tests). Then `npm test` — **`test/snapshot.test.js` GOLDEN checksums must pass unchanged**; if they fail, the point-cloud path was disturbed — stop and fix, do not regenerate goldens.

- [ ] **Step 6: Commit**

```bash
git add js/generators/cymatics.js test/generators.test.js
git commit -m "feat(cymatics): fringe-peak rings with tone-split runs replace uniform export rings"
```

---

### Task 4: SVG band groups for tone strands

**Files:**
- Modify: `js/exporter.js:39-66` (`exportStrandSVG`)
- Test: `test/exporter.test.js`

**Interfaces:**
- Consumes: `buildVectorPaths` tone items (Task 2: `color`, `toneClass`, `band` fields).
- Produces: SVG markup — tone strands inside `<g id="band-01">`…`<g id="band-08">` (band index + 1, inner→outer), each path `fill="none" stroke="#rrggbb" stroke-width stroke-linecap="round" opacity data-tone="1..5"`. Legacy strands keep `strand-NN` groups + gradients. `<defs>` emitted only when non-empty.

- [ ] **Step 1: Write the failing tests**

Append to `test/exporter.test.js`:

```js
function toneFixture() {
  const strands = [];
  for (let ring = 0; ring < 12; ring++) {
    for (let a = 0; a < 4; a++) {
      const pts = new Float32Array(40 * 3);
      for (let i = 0; i < 40; i++) {
        const th = (a / 4 + (i / 39) * 0.2) * Math.PI * 2;
        const r = 0.1 + ring * 0.07;
        pts[i * 3] = Math.cos(th) * r;
        pts[i * 3 + 1] = 0;
        pts[i * 3 + 2] = Math.sin(th) * r;
      }
      strands.push({ pts, tone: (a + 1) / 4 - 0.01, band: Math.min(7, Math.floor((0.1 + ring * 0.07) * 8)), ring });
    }
  }
  return { strands, positions: new Float32Array(300), mvp: IDENTITY, width: 1600, height: 1200,
           stops: [[0, '#050614'], [0.5, '#6c99ba'], [1, '#f2e6c0']], background: null, weight: 1 };
}

test('exportStrandSVG: tone strands emit band groups with flat strokes and data-tone', () => {
  const svg = exportStrandSVG(toneFixture());
  assert.ok(svg.includes('id="band-01"'), 'inner band group present');
  assert.ok(svg.includes('data-tone='), 'tone class attribute present');
  assert.ok(!svg.includes('linearGradient'), 'tone strands use flat colors, no gradients');
  assert.ok(!svg.includes('id="strand-'), 'no legacy strand groups for tone strands');
  assert.match(svg, /stroke="#[0-9a-f]{6}"/);
});

test('exportStrandSVG: mixed tone + legacy designs keep both structures', () => {
  const tf = toneFixture();
  const legacy = new Float32Array(200 * 3);
  for (let i = 0; i < 200; i++) {
    const t = i / 199;
    legacy[i * 3] = Math.cos(t * 6) * 0.6;
    legacy[i * 3 + 1] = (t - 0.5) * 1.4;
    legacy[i * 3 + 2] = Math.sin(t * 6) * 0.6;
  }
  const svg = exportStrandSVG({ ...tf, strands: [...tf.strands, legacy], positions: legacy });
  assert.ok(svg.includes('id="band-01"'));
  assert.ok(svg.includes('id="strand-'), 'legacy strand keeps its group');
  assert.ok(svg.includes('linearGradient'), 'legacy strand keeps its gradient');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/exporter.test.js`
Expected: FAIL — no `band-01` groups (tone items fall into the legacy markup path or crash).

- [ ] **Step 3: Implement**

Replace `exportStrandSVG` in `js/exporter.js` with:

```js
// Structured vector export. Legacy strands: one named group per strand, real
// bezier paths, density-driven weight/opacity, palette gradient along each
// path. Tone strands (cymatics fringe arcs): grouped by radial band
// (band-01 inner … band-08 outer), flat tone-class stroke colors — no
// gradient defs — with data-tone for tooling.
export function exportStrandSVG({ strands, positions, mvp, width, height, stops, background, weight }) {
  const items = buildVectorPaths({ strands, positions, mvp, width, height, stops, weight });

  const defs = [], groups = [];
  const bands = new Map();
  items.forEach((it, order) => {
    if (it.color) {
      const path =
        `    <path d="${toBezierPath(it.points)}" fill="none" stroke="${it.color}"` +
        ` stroke-width="${it.strokeWidth.toFixed(2)}" stroke-linecap="round"` +
        ` opacity="${it.opacity.toFixed(2)}" data-tone="${it.toneClass}"/>`;
      if (!bands.has(it.band)) bands.set(it.band, []);
      bands.get(it.band).push(path);
      return;
    }
    const id = String(order + 1).padStart(2, '0');
    defs.push(
      `    <linearGradient id="grad-${id}" gradientUnits="userSpaceOnUse" x1="${it.x1.toFixed(1)}" y1="${it.y1.toFixed(1)}" x2="${it.x2.toFixed(1)}" y2="${it.y2.toFixed(1)}">` +
      `<stop offset="0" stop-color="${it.c1}"/><stop offset="1" stop-color="${it.c2}"/></linearGradient>`);
    groups.push(
      `  <g id="strand-${id}">\n` +
      `    <path d="${toBezierPath(it.points)}" fill="none" stroke="url(#grad-${id})" stroke-width="${it.strokeWidth.toFixed(2)}" stroke-linecap="round" opacity="${it.opacity.toFixed(2)}"/>\n` +
      `  </g>`);
  });
  const bandGroups = [...bands.keys()].sort((a, b) => a - b).map((b) =>
    `  <g id="band-${String(b + 1).padStart(2, '0')}">\n${bands.get(b).join('\n')}\n  </g>`);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    ...(background != null ? [`  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`] : []),
    ...(defs.length ? ['  <defs>', ...defs, '  </defs>'] : []),
    ...bandGroups,
    ...groups,
    '</svg>',
  ].join('\n');
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/exporter.test.js` → PASS (new tests and all pre-existing SVG tests). Then `npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add js/exporter.js test/exporter.test.js
git commit -m "feat(export): radial band groups + flat tone strokes for cymatics SVG"
```

---

### Task 5: main.js wiring — ring-subset slider + motion displacement

**Files:**
- Modify: `js/main.js:1-12` (imports), `js/main.js:534-538` (stride sampling), `js/main.js:553` (`expStrands` displacement)

**Interfaces:**
- Consumes: `selectRingSubset` from `js/strands.js` (Task 2); object strand shape.
- Produces: export button flow handles tone-strand designs end-to-end.

- [ ] **Step 1: Add the import**

At the top of `js/main.js`, alongside the existing imports:

```js
import { selectRingSubset } from './strands.js?v=43';
```

(The version suffix moves to v=44 in Task 6 with all the others.)

- [ ] **Step 2: Replace the stride-sampling block**

Replace (currently at `js/main.js:534-538`):

```js
          const all = design.strands;
          const want = Math.min(params.strandCount * Math.max(1, Math.round(all.length / 96)), all.length);
          const step = all.length / want;
          const picked = [];
          for (let i = 0; i < want; i++) picked.push(all[Math.floor(i * step)]);
```

with:

```js
          const all = design.strands;
          let picked;
          if (all[0]?.pts) {
            // Tone strands (cymatics fringe arcs): the slider keeps a fraction
            // of whole rings — a ring's tone runs only read together, so
            // individual arcs are never stride-dropped.
            picked = selectRingSubset(all, params.strandCount / 96);
          } else {
            const want = Math.min(params.strandCount * Math.max(1, Math.round(all.length / 96)), all.length);
            const step = all.length / want;
            picked = [];
            for (let i = 0; i < want; i++) picked.push(all[Math.floor(i * step)]);
          }
```

- [ ] **Step 3: Fix motion displacement for object strands**

Replace (currently at `js/main.js:553`):

```js
            expStrands = picked.map(displaceArr);
```

with:

```js
            expStrands = picked.map((s) => s.pts ? { ...s, pts: displaceArr(s.pts) } : displaceArr(s));
```

- [ ] **Step 4: Run the full suite**

Run: `npm test` → all green (main.js has no unit tests; the pure logic lives in `selectRingSubset`, tested in Task 2 — the E2E in Task 7 exercises this wiring for real).

- [ ] **Step 5: Commit**

```bash
git add js/main.js
git commit -m "feat(export): wire ring-subset slider + motion displacement for tone strands"
```

---

### Task 6: Cache-bust v=43 → v=44

**Files:**
- Modify: `index.html`, `js/audio.js`, `js/exporter.js`, `js/live.js`, `js/livecolor.js`, `js/main.js`, `js/strands.js`, `js/worker.js`

- [ ] **Step 1: Bump every occurrence together**

```bash
cd ~/Documents/Github/soundform
sed -i '' 's/v=43/v=44/g' index.html js/audio.js js/exporter.js js/live.js js/livecolor.js js/main.js js/strands.js js/worker.js
```

- [ ] **Step 2: Verify no stragglers and no accidental extras**

```bash
grep -rn 'v=43' index.html js/ ; echo "exit=$? (want 1 = no matches)"
grep -rn 'v=44' index.html js/ | wc -l
```

Expected: zero `v=43` matches; `v=44` count equals the old `v=43` count plus the one new import added in Task 5 (was 24 total across 8 files before Task 5).

- [ ] **Step 3: Run the full suite, then commit**

```bash
npm test
git add index.html js/audio.js js/exporter.js js/live.js js/livecolor.js js/main.js js/strands.js js/worker.js
git commit -m "chore: bump cache-bust to v=44 for cymatics tone-split vector export"
```

---

### Task 7: Real-app E2E verification (project standard)

**Files:**
- Create: scratchpad only (no repo files) — e2e script + synthetic WAV under the session scratchpad directory.

**Interfaces:**
- Consumes: the live app served locally at head; the real export buttons (`.btn-export[data-fmt="svg"]`, `.btn-export[data-fmt="pdf"]`), file input `#file-input`, mode button `.btn-mode[data-mode="cymatics"]`.

- [ ] **Step 1: Set up tooling (scratchpad, not the repo)**

```bash
cd <scratchpad>
npm init -y && npm i playwright pdfjs-dist && npx playwright install chromium
```

- [ ] **Step 2: Generate a synthetic WAV**

Node script writing a 3-second 44.1kHz WAV of a sung-chord-like signal (e.g. sum of 220/277/330 Hz sines with a slow amplitude envelope) to `<scratchpad>/test.wav` — same approach as the previous session's E2E.

- [ ] **Step 3: Drive the real UI headless**

Serve the repo (`python3 -m http.server 8321` from the repo root). Playwright script:
1. Open `http://localhost:8321`, accept downloads.
2. `setInputFiles('#file-input', 'test.wav')`; wait for the design to appear (status/render settle).
3. Click `.btn-mode[data-mode="cymatics"]`; wait for regeneration.
4. Screenshot the canvas → `screen.png`.
5. Click `.btn-export[data-fmt="svg"]` and save the download → `out.svg`; click `.btn-export[data-fmt="pdf"]` → `out.pdf`. Zero console errors required.

- [ ] **Step 4: Rasterize both exports**

- `out.svg`: load in a Chromium page sized to the SVG dimensions, screenshot → `svg.png`.
- `out.pdf`: render page 1 via `pdfjs-dist` to a canvas, write PNG → `pdf.png`.

- [ ] **Step 5: Visual acceptance (Read the images)**

Compare `screen.png` vs `svg.png` vs `pdf.png`. Required before claiming success:
- Fine concentric fringe rings at near-screen density (not ~90 coarse contours).
- Dark voids between petals — rings visibly break where the screen shows voids.
- Tonal variation along rings: bright cream arcs at crests, faint blue at edges, matching the screen's petal layout.
- SVG structure spot-check: `grep -c '<g id="band-' out.svg` → between 1 and 8; `grep -c 'data-tone' out.svg` → total path count between ~500 and 4800; no `linearGradient`.
- PDF spot-check: file contains vector operators (`m`/`c`/`S`), no `/Subtype/Image` XObject.

- [ ] **Step 6: Slider check**

In the same session, set the Strands slider to its minimum, re-export SVG, confirm ring count drops (whole rings, arcs of kept rings intact) and nothing crashes.

- [ ] **Step 7: Final full suite + report**

```bash
cd ~/Documents/Github/soundform && npm test
```

All green. Present the three rasters to the user for acceptance before any push — **do not push to origin/main without the user's explicit request** (project convention).

---

## Self-Review Notes

- Spec coverage: data model (Task 1+2), fringe rings + tone splits + budget (Task 3), SVG bands / PDF flat runs (Task 2+4), slider mapping (Task 2+5), transparent background (no background emitted for tone paths — background param untouched, Task 4 keeps existing rect logic for legacy callers), cache-bust (Task 6), E2E (Task 7). Golden-snapshot safety asserted in Task 3 Step 5.
- Type consistency: strand object `{ pts, tone, band, ring }` used identically in Tasks 1, 2, 3, 4, 5; `toneClass` 1-based only in the exported item field (`it.toneClass`), 0-based internally via `toneClass()`.
