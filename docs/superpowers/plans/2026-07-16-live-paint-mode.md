# Live Paint Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rejected growth modes with Paint: one coherent design painted into existence by sound-driven brush strokes — a true streaming orbit brush for Attractor, stroke-order reveal with remainder re-steering for the other modes.

**Architecture:** `js/paint.js` holds the pure `BrushPace` (sound → points/frame). `js/generators/attractor.js` gains `createOrbitBrush` (streams the orbit through a pre-calibrated normalization, glide-steered by fingerprints). `js/density.js` swaps the grow/draw-in APIs for a preallocated paint buffer (`beginPaint`/`writePaintPoints`/`setPaintCount`/`getPaintSlice`). `js/live.js` swaps the growth machinery for a paint branch. `js/grow.js` and the old growth UI/tests are deleted.

**Tech Stack:** Vanilla ES modules, THREE r134 (global, `DynamicDrawUsage` + `updateRange` partial uploads), node:test. Spec: `docs/superpowers/specs/2026-07-16-live-paint-mode-design.md`.

## Global Constraints

- Growth selector = `morph` (default, unchanged) and `paint` only. All non-paint behaviour pixel-identical.
- Constants (exact): `PAINT_MAX_POINTS = 600_000` / `PAINT_MAX_POINTS_MOBILE = 200_000`; BrushPace rate `400 + 22_000·rmsEnv + 6_000·kick` pts/s, envelope attack 0.1 s / release 0.6 s, silence threshold 0.008, clamp 40 000 pts/s; steer glide τ = 3 s; orbit calibration 3 000 warmup + 2 000 probe steps; stagnation batch 2 000 points, std < 0.05; coordinate clamp ±2.2.
- Delete: `js/grow.js`, `test/grow.test.js`, `NoteEventDetector` (+ its tests), `GrowComposite` usage, `setGrowCloud`, `drawInTo`, `setDrawProgress`, `_fading.manual`.
- Keep: the `aWeight` splat attribute and `_unitWeights` (unit default).
- Cache: bump every `?v=37` to `?v=38` in Task 5 only.
- Run `npm test` before every commit.

---

### Task 1: paint.js — BrushPace

**Files:**
- Create: `js/paint.js`
- Create: `test/paint.test.js`

**Interfaces (produced):**
- `PAINT_MAX_POINTS = 600_000`, `PAINT_MAX_POINTS_MOBILE = 200_000`
- `class BrushPace` — `pointsThisFrame(rms, kickValue, dt) -> int`

- [ ] **Step 1: Write the failing tests**

```js
// test/paint.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrushPace, PAINT_MAX_POINTS } from '../js/paint.js';

test('BrushPace: silence paints nothing', () => {
  const pace = new BrushPace();
  let total = 0;
  for (let i = 0; i < 120; i++) total += pace.pointsThisFrame(0.001, 0, 1 / 60);
  assert.equal(total, 0);
});

test('BrushPace: steady sound approaches the spec rate', () => {
  const pace = new BrushPace();
  let total = 0;
  for (let i = 0; i < 60; i++) pace.pointsThisFrame(0.15, 0, 1 / 60); // settle envelope
  for (let i = 0; i < 60; i++) total += pace.pointsThisFrame(0.15, 0, 1 / 60);
  // rate = 400 + 22000×0.15 = 3700 pts/s
  assert.ok(total > 3200 && total < 4200, `got ${total}/s`);
});

test('BrushPace: onsets burst, and the clamp holds', () => {
  const pace = new BrushPace();
  for (let i = 0; i < 60; i++) pace.pointsThisFrame(0.15, 0, 1 / 60);
  const calm = pace.pointsThisFrame(0.15, 0, 1 / 60);
  const burst = pace.pointsThisFrame(0.15, 1, 1 / 60);
  assert.ok(burst > calm);
  assert.ok(pace.pointsThisFrame(1, 1, 1 / 60) <= Math.round(40000 / 60));
});

test('BrushPace: brush rests after sound stops (release)', () => {
  const pace = new BrushPace();
  for (let i = 0; i < 120; i++) pace.pointsThisFrame(0.3, 0, 1 / 60);
  let silentTotal = 0;
  for (let i = 0; i < 240; i++) silentTotal += pace.pointsThisFrame(0.001, 0, 1 / 60); // 4s of silence
  const tail = pace.pointsThisFrame(0.001, 0, 1 / 60);
  assert.equal(tail, 0, 'envelope decays to rest');
  assert.ok(silentTotal < 7000, 'release tail is bounded (~2.5s of decay)');
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (`js/paint.js` missing).

- [ ] **Step 3: Implement** — create `js/paint.js`:

```js
// Paint mode pacing: the sound is the hand moving the brush. Loudness sets
// the stroke speed through an attack/release envelope; onsets add bursts;
// silence rests the brush. Pure and node-testable.

export const PAINT_MAX_POINTS = 600_000;
export const PAINT_MAX_POINTS_MOBILE = 200_000;

export class BrushPace {
  constructor() { this.env = 0; }
  // rms: current frame loudness; kickValue: onset envelope 0..1; dt: seconds.
  pointsThisFrame(rms, kickValue, dt) {
    const target = rms > 0.008 ? rms : 0;      // matches live SILENCE_RMS
    const tau = target > this.env ? 0.1 : 0.6; // fast attack, slower release
    this.env += (target - this.env) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
    if (this.env < 0.004) return 0;            // resting
    const rate = 400 + 22_000 * this.env + 6_000 * kickValue;
    return Math.min(Math.round(dt * rate), Math.round(dt * 40_000));
  }
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add js/paint.js test/paint.test.js
git commit -m "feat(paint): brush pace — sound-driven points per frame"
```

---

### Task 2: createOrbitBrush in attractor.js

**Files:**
- Modify: `js/generators/attractor.js` (new export + private coeff helper; `generate` untouched)
- Test: `test/paint.test.js` (append)

**Interfaces:**
- Consumes: module internals (`SYSTEMS`, `pickSystem`, `liveAxes`, `formArchetype`, `mulberry32`, `lerp`).
- Produces: `createOrbitBrush(fp, params?) -> { next(k, dt) -> { positions: Float32Array(k*3), attr: Float32Array(k) }, steer(fp), system }`. Positions normalized (calibrated centre + r95), bounded ±2.2; `steer` glides coefficients (τ = 3 s); stagnation jolt built in.

- [ ] **Step 1: Write the failing tests** (append to `test/paint.test.js`)

```js
import { createOrbitBrush } from '../js/generators/attractor.js';
import { testFingerprint } from './generators.test.js';

test('orbit brush: emits k bounded normalized points, deterministic', () => {
  const a = createOrbitBrush(testFingerprint());
  const b = createOrbitBrush(testFingerprint());
  const ca = a.next(3000, 1 / 30), cb = b.next(3000, 1 / 30);
  assert.equal(ca.positions.length, 9000);
  assert.equal(ca.attr.length, 3000);
  assert.deepEqual([...ca.positions.slice(0, 300)], [...cb.positions.slice(0, 300)]);
  let maxAbs = 0, sum = 0;
  for (const v of ca.positions) { maxAbs = Math.max(maxAbs, Math.abs(v)); sum += Math.abs(v); }
  assert.ok(maxAbs <= 2.2, `bounded (${maxAbs})`);
  assert.ok(sum / ca.positions.length > 0.05, 'not collapsed at origin');
  for (const v of ca.attr) assert.ok(v >= 0 && v <= 1);
});

test('orbit brush: consecutive chunks are continuous (a single stroke)', () => {
  const brush = createOrbitBrush(testFingerprint());
  brush.next(2000, 1 / 30);
  const c1 = brush.next(500, 1 / 30);
  const c2 = brush.next(500, 1 / 30);
  const gap = Math.hypot(
    c2.positions[0] - c1.positions[497 * 3],
    c2.positions[1] - c1.positions[497 * 3 + 1],
    c2.positions[2] - c1.positions[497 * 3 + 2]);
  assert.ok(gap < 0.5, `chunks continue the same path (gap ${gap})`);
});

test('orbit brush: steer bends the path without teleporting', () => {
  const steered = createOrbitBrush(testFingerprint());
  const straight = createOrbitBrush(testFingerprint());
  steered.next(2000, 1 / 30); straight.next(2000, 1 / 30);
  steered.steer(testFingerprint({ pitchMedian: 0.9, centroid: 0.8, spread: 0.1 }));
  // immediately after steer the paths are still close — glide, not jump
  const s1 = steered.next(200, 1 / 30), t1 = straight.next(200, 1 / 30);
  let d0 = 0;
  for (let i = 0; i < 600; i++) d0 += Math.abs(s1.positions[i] - t1.positions[i]);
  // after ~6s of glide the steered path has genuinely departed
  let dLate = 0;
  let sL, tL;
  for (let i = 0; i < 60; i++) { sL = steered.next(200, 0.1); tL = straight.next(200, 0.1); }
  for (let i = 0; i < 600; i++) dLate += Math.abs(sL.positions[i] - tL.positions[i]);
  assert.ok(dLate > d0, `steering diverges over time (${d0.toFixed(1)} → ${dLate.toFixed(1)})`);
});

test('orbit brush: works for the discrete map too (speech routing)', () => {
  const brush = createOrbitBrush(testFingerprint({ pitchConfidence: 0.2 }));
  assert.equal(brush.system, 'sinemap');
  const c = brush.next(2000, 1 / 30);
  let maxAbs = 0;
  for (const v of c.positions) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs <= 2.2 && maxAbs > 0.05);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (`createOrbitBrush` not exported).

- [ ] **Step 3: Implement** — append to `js/generators/attractor.js`:

```js
// Paint mode's streaming brush: the attractor orbit IS the brush stroke.
// Points are emitted through a normalization transform calibrated up front
// (the batch path normalizes after the fact; a stream can't), coefficients
// glide toward each steer() target so the ribbons bend rather than jump,
// and a stagnation guard jolts the orbit out of collapsed loops.
export function createOrbitBrush(fp, params = {}) {
  const name = pickSystem(fp);
  const sys = SYSTEMS[name];
  const rnd = mulberry32(fp.seed);
  const complexity = params.complexity ?? 0.5;

  const coeffsFor = (f) => {
    const c = sys.coeffs(f, rnd);
    const axes = liveAxes(f);
    if (sys.flow) {
      const excursion = 0.5 + complexity;
      for (const key of Object.keys(c)) {
        if (typeof c[key] === 'number' && key !== 'e') {
          c[key] = c[key] * lerp(0.92, 1.08, (excursion * 7) % 1);
        }
      }
    } else {
      const arch = formArchetype(f);
      c.a = lerp(1.2, 4.2, 0.5 * f.contour[1] + 0.5 * axes[0]);
      c.b = lerp(1.2, 4.2, 0.5 * f.contour[3] + 0.5 * axes[1]);
      c.c = lerp(1.2, 4.2, 0.5 * f.contour[5] + 0.5 * axes[3]);
      c.g = axes[0] * Math.PI * 2;
      c.h = axes[1] * Math.PI * 2;
      c.i = axes[3] * Math.PI * 2;
      const hi = 0.9 + 0.4 * arch.wildness;
      c.d = lerp(0.4, hi, axes[0]);
      c.e = lerp(0.4, hi, axes[1]);
      c.f = lerp(0.4, hi, axes[3]);
    }
    return c;
  };

  let c = coeffsFor(fp);
  let cTarget = { ...c };
  let p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  const stepOnce = () => {
    const d = sys.step(p, c);
    p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
  };

  // Calibrate: 3000 warmup steps onto the attractor, then 2000 probe steps
  // to fix centre + r95 scale for the whole painting.
  for (let i = 0; i < 3000; i++) stepOnce();
  const probe = [];
  for (let i = 0; i < 2000; i++) { stepOnce(); probe.push(p[0], p[1], p[2]); }
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < 2000; i++) { cx += probe[i * 3] / 2000; cy += probe[i * 3 + 1] / 2000; cz += probe[i * 3 + 2] / 2000; }
  const radii = [];
  for (let i = 0; i < 2000; i++) {
    radii.push(Math.hypot(probe[i * 3] - cx, probe[i * 3 + 1] - cy, probe[i * 3 + 2] - cz));
  }
  radii.sort((a, b) => a - b);
  const r95 = radii[Math.floor(radii.length * 0.95)] || 1;
  const scale = r95 > 1e-6 ? 1 / r95 : 1;

  let speedMax = 1e-6;
  let batchN = 0, bx = 0, by = 0, bz = 0, bxx = 0, byy = 0, bzz = 0; // stagnation stats
  const jolt = (n) => {
    p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
    const nudged = { ...fp, pitchMedian: (fp.pitchMedian + 0.618 * n) % 1,
                     contour: fp.contour.map(v => (v + 0.618 * n) % 1) };
    cTarget = coeffsFor(nudged);
    for (let i = 0; i < 500; i++) stepOnce(); // settle back onto an attractor
  };
  let joltCount = 0;

  return {
    system: name,

    steer(newFp) { cTarget = coeffsFor(newFp); },

    next(k, dt) {
      // coefficient glide toward the steer target (τ = 3s)
      const g = 1 - Math.exp(-(dt || 1 / 60) / 3);
      for (const key of Object.keys(c)) {
        if (typeof c[key] === 'number' && typeof cTarget[key] === 'number') {
          c[key] += (cTarget[key] - c[key]) * g;
        }
      }
      const positions = new Float32Array(k * 3);
      const attr = new Float32Array(k);
      for (let i = 0; i < k; i++) {
        const prev = p;
        stepOnce();
        const sp = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
        if (sp > speedMax) speedMax = sp;
        let x = (p[0] - cx) * scale, y = (p[1] - cy) * scale, z = (p[2] - cz) * scale;
        if (Math.abs(x) > 2.2 || Math.abs(y) > 2.2 || Math.abs(z) > 2.2) {
          // steering pushed the orbit out of the calibrated frame — re-enter
          x = Math.max(-2.2, Math.min(2.2, x));
          y = Math.max(-2.2, Math.min(2.2, y));
          z = Math.max(-2.2, Math.min(2.2, z));
          p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        }
        positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
        attr[i] = Math.max(0, Math.min(1, 1 - sp / speedMax));
        // stagnation stats over 2000-point batches
        bx += x; by += y; bz += z; bxx += x * x; byy += y * y; bzz += z * z; batchN++;
        if (batchN >= 2000) {
          const vx = bxx / batchN - (bx / batchN) ** 2;
          const vy = byy / batchN - (by / batchN) ** 2;
          const vz = bzz / batchN - (bz / batchN) ** 2;
          if (Math.sqrt(Math.max(0, vx + vy + vz)) < 0.05) jolt(++joltCount);
          batchN = 0; bx = by = bz = bxx = byy = bzz = 0;
        }
      }
      return { positions, attr };
    },
  };
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS (existing attractor suite must stay green: `generate` untouched).

- [ ] **Step 5: Commit**

```bash
git add js/generators/attractor.js test/paint.test.js
git commit -m "feat(paint): streaming orbit brush with calibrated frame and glide steering"
```

---

### Task 3: Renderer — paint buffer API, growth API removal

**Files:**
- Modify: `js/density.js`

*(DOM/WebGL — manual browser pass; node suite guards the rest.)*

**Interfaces:**
- Consumes: nothing new.
- Produces: `beginPaint(maxPoints)`; `writePaintPoints(offset, positions, attr)`; `setPaintCount(n)`; `getPaintSlice(n) -> { positions, attr }` (copies). Removes `setGrowCloud`, `drawInTo`, `setDrawProgress`; `_loop`'s fading guard reverts to `if (this._fading) {`.

- [ ] **Step 1: Delete** the whole `setGrowCloud(...)` method, the whole `drawInTo(...)` method, and the whole `setDrawProgress(...)` method. In `_loop`, revert the guard `if (this._fading && !this._fading.manual) {` back to `if (this._fading) {`.

- [ ] **Step 2: Add the paint API** (where `setGrowCloud` was, after `setCloud`):

```js
  // ── Paint mode: one preallocated buffer painted incrementally ──
  // beginPaint allocates; writePaintPoints copies chunks in (streaming brush
  // appends AND remainder splices); setPaintCount reveals via drawRange.
  beginPaint(maxPoints) {
    this._disposeFading();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    this._paintPos = new Float32Array(maxPoints * 3);
    this._paintAttr = new Float32Array(maxPoints);
    const geo = new THREE.BufferGeometry();
    const posA = new THREE.BufferAttribute(this._paintPos, 3);
    const attrA = new THREE.BufferAttribute(this._paintAttr, 1);
    posA.setUsage(THREE.DynamicDrawUsage);
    attrA.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posA);
    geo.setAttribute('attrv', attrA);
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(maxPoints), 1));
    geo.setDrawRange(0, 0);
    if (this.fallback) {
      const mat = new THREE.PointsMaterial({ size: 0.008, color: 0xbbaaff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
    } else {
      this.points = new THREE.Points(geo, this.splatMat);
    }
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this._paintDirty = null;
    this._dirty = true;
    this.splatMat.uniforms.uWeight.value = 1;
  }

  writePaintPoints(offset, positions, attr) {
    if (!this._paintPos) return;
    this._paintPos.set(positions, offset * 3);
    this._paintAttr.set(attr, offset);
    const end = offset + attr.length;
    this._paintDirty = this._paintDirty
      ? { min: Math.min(this._paintDirty.min, offset), max: Math.max(this._paintDirty.max, end) }
      : { min: offset, max: end };
    const geo = this.points.geometry;
    const posA = geo.getAttribute('position');
    const attrA = geo.getAttribute('attrv');
    posA.updateRange = { offset: this._paintDirty.min * 3, count: (this._paintDirty.max - this._paintDirty.min) * 3 };
    attrA.updateRange = { offset: this._paintDirty.min, count: this._paintDirty.max - this._paintDirty.min };
    posA.needsUpdate = true;
    attrA.needsUpdate = true;
    this._dirty = true;
  }

  setPaintCount(n) {
    if (!this.points) return;
    this.points.geometry.setDrawRange(0, n);
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._paintDirty = null; // consumed by the upcoming render
    this._dirty = true;
  }

  // Painted region as standalone copies (freeze/capture).
  getPaintSlice(n) {
    return {
      positions: this._paintPos ? this._paintPos.slice(0, n * 3) : new Float32Array(0),
      attr: this._paintAttr ? this._paintAttr.slice(0, n) : new Float32Array(0),
    };
  }
```

Also: in `setCloud` and `clear`, add `this._paintPos = null; this._paintAttr = null;` after the existing points disposal, so leaving paint mode releases the buffers.

- [ ] **Step 3: Verify + commit**

Run: `node --check js/density.js && npm test` → PASS.

```bash
git add js/density.js
git commit -m "feat(paint): renderer paint buffer; remove grow/draw-in APIs"
```

---

### Task 4: Conductor — paint branch, growth machinery removal

**Files:**
- Modify: `js/live.js`
- Test: `test/live.test.js` (replace growth tests)

**Interfaces:**
- Consumes: `BrushPace`, `PAINT_MAX_POINTS` from `./paint.js`; `createOrbitBrush` from `./generators/attractor.js`; renderer paint API (Task 3).
- Produces: `setGrowthMode('morph' | 'paint')`; paint tick behaviour; `freeze()` returns `{ …, cloud }` when painted points exist; `getParams()` may supply `paintMaxPoints`; `onGrowStatus` kept for the completion message.

- [ ] **Step 1: Remove the old machinery from `js/live.js`:**
  - the `NoteEventDetector` class (whole export);
  - the `import { GrowComposite, FRAGMENT_POINTS, GROW_MAX_POINTS } from './grow.js?v=37';` line;
  - constructor fields `noteEvents`, `composite`, `growInFlight`, `lastFadePass`, `drawProgress`, `_saidFull` (keep `growthMode`, `growGen`, `onGrowStatus`);
  - methods `eventFingerprint`, `_growTick`;
  - the grow/draw-in branches in `tick()` and the draw-in arm of the morph completion handler (restore plain `this.renderer.crossfadeTo(out.positions, out.attr, 1.0);`);
  - the composite branch in `freeze()`.

- [ ] **Step 2: Remove the old tests from `test/live.test.js`:** the four `NoteEventDetector` tests, `grow mode: events request fragments…`, `grow mode: freeze returns the composite cloud`, `draw-in mode…`, `switching back to morph…`, and the `import { NoteEventDetector } …` line. In the `harness` renderer stub replace the grow methods with:

```js
      beginPaint: (m) => { log.paintBegun = m; },
      writePaintPoints: (o, p) => { log.paintWrites.push([o, p.length / 3]); },
      setPaintCount: (n) => { log.paintCounts.push(n); },
      getPaintSlice: (n) => ({ positions: new Float32Array(n * 3), attr: new Float32Array(n) }),
```
and extend the log initialiser with `paintBegun: 0, paintWrites: [], paintCounts: []`.

- [ ] **Step 3: Write the new failing tests** (append to `test/live.test.js`)

```js
test('paint (attractor): sound advances the brush, silence rests it', async () => {
  const frame = { current: mkFrame() };
  const { conductor, log } = harness({ frame });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);   // 3s of sound
  await settle();
  assert.equal(log.xfades, 0, 'no crossfades in paint mode');
  assert.ok(log.paintBegun > 0, 'paint buffer allocated');
  assert.ok(log.paintWrites.length > 0, 'brush wrote points');
  const painted = log.paintCounts[log.paintCounts.length - 1];
  assert.ok(painted > 1000, `painted ${painted} points in 3s of sound`);
  // silence: the brush rests
  frame.current = mkFrame({ rms: 0.001, pitchConf: 0, flux: 0 });
  const before = log.paintCounts.length ? painted : 0;
  for (let i = 90; i < 210; i++) conductor.tick(i / 30); // 4s of silence
  const after = log.paintCounts.length ? log.paintCounts[log.paintCounts.length - 1] : before;
  assert.ok(after - before < 3500, 'brush rests in silence (bounded release tail)');
});

test('paint: completion fires the status once and stops', async () => {
  const { conductor, log } = harness();
  const statuses = [];
  conductor.onGrowStatus = (m) => statuses.push(m);
  conductor.setGrowthMode('paint');
  conductor.paintMax = 3000;                       // small canvas for the test
  for (let i = 0; i < 240; i++) conductor.tick(i / 30);
  await settle();
  const painted = log.paintCounts[log.paintCounts.length - 1];
  assert.ok(painted <= 3000);
  assert.equal(statuses.filter(s => /complete/i.test(s)).length, 1);
});

test('paint: freeze returns the painted cloud', async () => {
  const { conductor } = harness();
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud);
  assert.ok(out.cloud.positions.length > 0);
});

test('paint (non-attractor): reveal requests a full design then advances', async () => {
  let genCount = 0, genParams = null;
  const { conductor, log } = harness({
    generate: async (fp, p) => {
      genCount++; genParams = p;
      const n = p.density;
      return { positions: new Float32Array(n * 3), attr: new Float32Array(n), strands: [] };
    },
    getParams: () => ({ mode: 'radial', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, paintMaxPoints: 5000,
                        exposure: 30, scale: 1, grain: 1 }),
  });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  assert.equal(genCount, 1, 'one full design requested');
  assert.equal(genParams.density, 5000);
  assert.equal(genParams.liveVariance, true);
  assert.ok(log.paintWrites.some(([o]) => o === 0), 'design written at offset 0');
  assert.ok(log.paintCounts[log.paintCounts.length - 1] > 500, 'reveal advanced');
  assert.equal(log.xfades, 0);
});
```

The reveal test needs `harness` to accept a `getParams` override — change its signature and the conductor construction:

```js
function harness({ frame = mkFrame(), genDelay = 0, generate = null, getParams = null } = {}) {
  ...
    getParams: getParams ?? (() => ({ mode: 'attractor', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, exposure: 30, scale: 1, grain: 1 })),
```

- [ ] **Step 4: Run to verify failure** — `npm test` → FAIL (`setGrowthMode('paint')` path missing).

- [ ] **Step 5: Implement** — in `js/live.js`:

Imports:

```js
import { BrushPace, PAINT_MAX_POINTS } from './paint.js?v=37';
import { createOrbitBrush } from './generators/attractor.js?v=37';
```

Constructor paint state (replacing the removed grow fields; keep `growthMode`, `growGen`, `onGrowStatus`):

```js
    this.growthMode = 'morph';
    this.growGen = 0;
    this.onGrowStatus = null;
    this.paint = null;          // { pace, brush, count, revealTotal, pendingGen, retried }
    this.paintMax = null;       // test override; otherwise getParams/paint default
```

`forceMorph` (mode switches call it): in paint mode it must restart the canvas
instead of forcing a morph:

```js
  forceMorph() {
    if (this.growthMode === 'paint') { this.setGrowthMode('paint'); return; }
    this.forceNext = true;
  }
```

`setGrowthMode`:

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

Tick branch (where the grow branch was, after the colour block):

```js
    if (this.growthMode === 'paint') {
      this._paintTick(nowSec, f, kick, dt);
      return;
    }
```

The paint tick:

```js
  _paintTick(nowSec, f, kick, dt) {
    const p = this.getParams();
    const max = this.paintMax ?? p.paintMaxPoints ?? PAINT_MAX_POINTS;
    const st = this.paint;

    // Start the canvas once we have enough sound to fingerprint.
    if (!st.begun) {
      if (this.frames.length < LIVE_MIN_FRAMES) return;
      const meanRms = this.frames.reduce((a, x) => a + x.f.rms, 0) / this.frames.length;
      if (meanRms < SILENCE_RMS) return;
      const fp = this.windowFingerprint();
      st.begun = true;
      this.renderer.beginPaint(max);
      this.shownFp = fp;
      if (p.mode === 'attractor') {
        st.brush = createOrbitBrush(fp, { complexity: p.complexity });
      } else {
        this._requestReveal(fp, p, max, 0);
      }
      return;
    }

    // Advance the brush.
    const k = st.pace.pointsThisFrame(f.rms, kick, dt);
    if (k > 0 && !st.done) {
      if (st.brush) {
        const take = Math.min(k, max - st.count);
        if (take > 0) {
          const chunk = st.brush.next(take, dt);
          this.renderer.writePaintPoints(st.count, chunk.positions, chunk.attr);
          st.count += take;
          this.renderer.setPaintCount(st.count);
        }
      } else if (st.revealTotal > 0) {
        st.count = Math.min(st.count + k, st.revealTotal);
        this.renderer.setPaintCount(st.count);
      }
      const target = st.brush ? max : (st.revealTotal || max);
      if (st.count >= target && !st.done) {
        st.done = true;
        if (this.onGrowStatus) this.onGrowStatus('Painting complete — freeze or clear');
      }
    }

    // Steering: reuse the morph scheduler's cadence and threshold.
    const due = nowSec - this.lastCheck >= MORPH_CHECK_INTERVAL;
    const allowed = nowSec - this.lastMorph >= MORPH_MIN_INTERVAL
                 && this.frames.length >= LIVE_MIN_FRAMES && !st.done;
    if (!due || !allowed) return;
    this.lastCheck = nowSec;
    const meanRms = this.frames.reduce((a, x) => a + x.f.rms, 0) / this.frames.length;
    if (meanRms < SILENCE_RMS) return;
    const fp = this.windowFingerprint();
    if (fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) return;
    this.lastMorph = nowSec;
    this.shownFp = fp;
    if (st.brush) {
      st.brush.steer(fp);                       // ribbons bend from here on
    } else if (!st.pendingGen) {
      this._requestReveal(fp, p, max, st.count); // repaint the unpainted remainder
    }
  }

  // Full-resolution design for reveal painting; spliceFrom = painted count
  // whose strokes must be preserved (0 = fresh canvas).
  _requestReveal(fp, p, max, spliceFrom) {
    const st = this.paint;
    st.pendingGen = true;
    const gen = this.growGen;
    this.generate(fp, { mode: p.mode, density: max, complexity: p.complexity,
                        symmetry: p.symmetry, twist: p.twist, strandCount: 8,
                        cymStyle: p.cymStyle, liveVariance: true })
      .then((out) => {
        st.pendingGen = false;
        if (!this.running || gen !== this.growGen) return;
        if (!out) {
          if (!st.retried) { st.retried = true; this._requestReveal(fp, p, max, spliceFrom); }
          else if (this.onGrowStatus) this.onGrowStatus('Paint: generation failed — keep making sound to retry');
          return;
        }
        st.retried = false;
        const total = out.attr.length;
        const from = Math.min(spliceFrom, total);
        this.renderer.writePaintPoints(from,
          out.positions.subarray(from * 3), out.attr.subarray(from));
        st.revealTotal = total;
      })
      .catch(() => { st.pendingGen = false; });
  }
```

`freeze()` paint branch (replacing the removed composite branch):

```js
    if (this.growthMode === 'paint' && this.paint && this.paint.count > 0) {
      out.cloud = this.renderer.getPaintSlice(this.paint.count);
    }
```

- [ ] **Step 6: Run tests** — `npm test` → PASS (208-ish: grow/detector tests gone, paint tests in).

- [ ] **Step 7: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(paint): conductor paint branch; remove growth machinery"
```

---

### Task 5: UI, deletions, cache bump

**Files:**
- Modify: `index.html` (Growth select options)
- Modify: `js/main.js` (`getParams`, default guard)
- Delete: `js/grow.js`, `test/grow.test.js`
- Modify: all `?v=37` refs → `?v=38`

- [ ] **Step 1: index.html** — replace the `#sel-growth` options:

```html
        <select id="sel-growth" class="live-suspended">
          <option value="morph" selected>Growth: Morph</option>
          <option value="paint">Growth: Paint</option>
        </select>
```

- [ ] **Step 2: main.js** — in `makeConductor`'s `getParams`, replace
`fragPoints: isMobile ? 7000 : 10000, growMaxPoints: isMobile ? 400000 : 1200000,` with:

```js
                        paintMaxPoints: isMobile ? 200000 : 600000,
```

Also guard stale stored values: where `params.growth` is defined, nothing changes (`'morph'` default), but in `bindControls`'s `sel-growth` listener nothing changes either — old values can't be selected any more.

- [ ] **Step 3: Delete the dead module and tests**

```bash
git rm js/grow.js test/grow.test.js
```

- [ ] **Step 4: Cache bump**

```bash
cd ~/Documents/Github/soundform && grep -rl 'v=37' index.html js/ | xargs sed -i '' 's/v=37/v=38/g' && grep -rn 'v=37' index.html js/ | wc -l
```
Expected: `0`.

- [ ] **Step 5: Verify + commit**

Run: `node --check js/main.js js/live.js js/paint.js && npm test` → PASS; also `grep -rn "grow.js\|GrowComposite\|NoteEventDetector\|setGrowCloud\|drawInTo\|setDrawProgress" js/ index.html` → no hits.

```bash
git add -A
git commit -m "feat(paint): Morph/Paint selector, delete growth modes; bump cache to v=38"
```

---

## Manual browser acceptance

1. Live + **Growth: Paint**, Attractor mode: hum steadily — ribbons stream in like a brush stroke; play melody — the path visibly bends; go silent — the brush rests mid-stroke; resume — it continues.
2. Radial (or Cymatics): strokes sweep in shell by shell; change your sound character sharply — the not-yet-painted region grows into the new form.
3. Let a painting complete (~2–4 min steady sound) → "Painting complete" status once; canvas holds, breathing.
4. Freeze mid- or post-painting → captured as-is; PNG/PDF export fine.
5. Clear → fresh canvas; Morph mode unchanged; video recording works while painting.
