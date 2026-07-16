# Live Growth Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three selectable live growth modes — grow-fade, grow-keep, draw-in — where designs build in real time with each note/word, alongside the default morph behaviour.

**Architecture:** New `js/grow.js` holds the pure growth engine (golden-spiral placement + composite bookkeeping). `js/live.js` gains a `NoteEventDetector` and a `growthMode` branch in the conductor. `js/density.js` gains a per-point `aWeight` splat attribute (defaults to 1 — existing paths pixel-identical), `setGrowCloud`, and a manually-paced `drawInTo`/`setDrawProgress` pair. `js/main.js` wires a Growth select and the freeze-composite path.

**Tech Stack:** Vanilla ES modules, THREE r134 (global), node:test. Spec: `docs/superpowers/specs/2026-07-16-live-growth-modes-design.md`.

## Global Constraints

- `morph` stays the default; all existing behaviour (capture, record, exports, video recording) pixel-identical when not in a growth mode.
- Constants (exact): `FRAGMENT_POINTS = 10000` (7000 mobile), `GROW_MAX_POINTS = 1_200_000` (400 000 mobile), `HALF_LIFE = 180` s, prune below weight `0.04`, golden angle `2.39996`, event throttle `0.25` s, sustain cadence `0.5` s, new-note hold `0.12` s.
- Fragment requests use the existing live worker path with `liveVariance: true`, `strandCount: 8`.
- Cache: bump every `?v=36` to `?v=37` in Task 5 only.
- Run `npm test` before every commit.

---

### Task 1: grow.js — placement + composite (pure core)

**Files:**
- Create: `js/grow.js`
- Create: `test/grow.test.js`

**Interfaces (produced):**
- `placeFragment(index, fp, flat) -> { angle, radius, scale, rotX, rotY, x, y, z }`
- `class GrowComposite({ maxPoints, fade })`:
  - `append(positions, attr, fp, nowSec, flat) -> bool` (false = full in keep mode; transforms a fragment by its placement and stores it)
  - `ageWeights(nowSec) -> bool` (fade mode: prune fragments below 0.04; returns whether anything was pruned)
  - `flatten(nowSec) -> { positions, attr, weights, count }`
  - `clear()`; fields `total`, `index`, `full`
- Constants: `FRAGMENT_POINTS`, `FRAGMENT_POINTS_MOBILE`, `GROW_MAX_POINTS`, `GROW_MAX_POINTS_MOBILE`, `HALF_LIFE`, `PRUNE_W`, `GOLDEN`

- [ ] **Step 1: Write the failing tests**

```js
// test/grow.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeFragment, GrowComposite, HALF_LIFE, PRUNE_W, GOLDEN } from '../js/grow.js';

const fp = (o = {}) => ({ volMean: 0.5, pitchMedian: 0.5, ...o });

test('placeFragment: deterministic golden-spiral bloom, bounded', () => {
  const a = placeFragment(0, fp()), b = placeFragment(0, fp());
  assert.deepEqual(a, b);
  let prevR = 0;
  for (let i = 0; i < 200; i++) {
    const p = placeFragment(i, fp());
    assert.ok(p.radius >= prevR, 'radius monotonic');
    assert.ok(p.radius <= 1.07, 'radius bounded');
    assert.ok(Math.abs(p.angle - i * GOLDEN) < 1e-9);
    prevR = p.radius;
  }
  assert.ok(placeFragment(0, fp()).radius < 0.2, 'starts at the core');
  // loudness → size, pitch → tilt/lift
  assert.ok(placeFragment(3, fp({ volMean: 1 })).scale > placeFragment(3, fp({ volMean: 0 })).scale);
  assert.equal(placeFragment(3, fp(), true).y, 0, 'flat modes stay in the plate plane');
  assert.ok(placeFragment(3, fp({ pitchMedian: 1 }), false).y > 0, 'high pitch lifts');
});

test('GrowComposite: append transforms and accumulates', () => {
  const comp = new GrowComposite({ maxPoints: 100, fade: false });
  const frag = new Float32Array([1, 0, 0, 0, 1, 0]); // 2 points
  const attr = new Float32Array([0.2, 0.8]);
  assert.equal(comp.append(frag, attr, fp(), 10), true);
  assert.equal(comp.total, 2);
  assert.equal(comp.index, 1);
  const flat = comp.flatten(10);
  assert.equal(flat.count, 2);
  assert.equal(flat.weights[0], 1);
  // point moved off the origin toward the placement (core radius ~0.12)
  const r = Math.hypot(flat.positions[0], flat.positions[1], flat.positions[2]);
  assert.ok(r > 0.05 && r < 0.5);
  // fragment scaled down (scale ~0.21 at volMean 0.5)
  assert.ok(Math.abs(flat.positions[0]) < 0.5);
});

test('GrowComposite keep mode: stops at cap and reports full', () => {
  const comp = new GrowComposite({ maxPoints: 4, fade: false });
  const frag = new Float32Array(9); // 3 points
  const attr = new Float32Array(3);
  assert.equal(comp.append(frag, attr, fp(), 0), true);
  assert.equal(comp.append(frag, attr, fp(), 1), false); // 3+3 > 4
  assert.equal(comp.full, true);
  assert.equal(comp.total, 3);
});

test('GrowComposite fade mode: drops oldest past cap, ages and prunes', () => {
  const comp = new GrowComposite({ maxPoints: 4, fade: true });
  const frag = new Float32Array(9);
  const attr = new Float32Array(3);
  comp.append(frag, attr, fp(), 0);
  assert.equal(comp.append(frag, attr, fp(), 1), true); // drops the first
  assert.equal(comp.total, 3);
  assert.equal(comp.index, 2, 'placement index keeps advancing');
  // half-life weighting
  const w = comp.flatten(1 + HALF_LIFE).weights[0];
  assert.ok(Math.abs(w - 0.5) < 1e-6);
  // pruning
  assert.equal(comp.ageWeights(1 + HALF_LIFE * 10), true);
  assert.equal(comp.total, 0);
  assert.equal(comp.ageWeights(1), false);
});

test('GrowComposite clear resets everything', () => {
  const comp = new GrowComposite({ maxPoints: 100, fade: true });
  comp.append(new Float32Array(3), new Float32Array(1), fp(), 0);
  comp.clear();
  assert.equal(comp.total, 0);
  assert.equal(comp.index, 0);
  assert.equal(comp.full, false);
  assert.equal(comp.flatten(0).count, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `js/grow.js` does not exist.

- [ ] **Step 3: Implement** — create `js/grow.js`:

```js
// Live growth engine: each sound event becomes a small fragment placed on a
// golden-angle spiral that blooms outward from the centre — the session grows
// like tree rings. Pure math + typed-array bookkeeping; node-testable.

export const FRAGMENT_POINTS = 10000;
export const FRAGMENT_POINTS_MOBILE = 7000;
export const GROW_MAX_POINTS = 1_200_000;
export const GROW_MAX_POINTS_MOBILE = 400_000;
export const HALF_LIFE = 180;   // seconds to half brightness in grow-fade
export const PRUNE_W = 0.04;    // fragments dimmer than this are dropped
export const GOLDEN = 2.39996;  // golden angle, radians

// Where the index-th fragment lands: spiral angle, asymptotic bloom radius,
// loudness → size, pitch → tilt and (volumetric modes) lift.
export function placeFragment(index, fp, flat = false) {
  const angle = index * GOLDEN;
  const radius = 0.12 + 0.95 * (1 - Math.exp(-index / 22));
  const scale = 0.10 + 0.22 * (fp.volMean ?? 0.5);
  const rotY = angle;
  const rotX = ((fp.pitchMedian ?? 0.5) - 0.5) * 1.2;
  const y = flat ? 0 : ((fp.pitchMedian ?? 0.5) - 0.5) * 0.5;
  return { angle, radius, scale, rotX, rotY,
           x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius };
}

export class GrowComposite {
  constructor({ maxPoints = GROW_MAX_POINTS, fade = true } = {}) {
    this.maxPoints = maxPoints;
    this.fade = fade;
    this.clear();
  }

  clear() { this.frags = []; this.total = 0; this.index = 0; this.full = false; }

  // Transform a fragment by its placement (scale → rotX → rotY → translate)
  // and store it. Returns false when a keep-mode composite is full.
  append(positions, attr, fp, nowSec, flat = false) {
    const n = positions.length / 3;
    if (this.total + n > this.maxPoints) {
      if (!this.fade) { this.full = true; return false; }
      while (this.frags.length && this.total + n > this.maxPoints) {
        this.total -= this.frags.shift().n;   // fade mode: oldest gives way
      }
    }
    const pl = placeFragment(this.index, fp, flat);
    const cy = Math.cos(pl.rotY), sy = Math.sin(pl.rotY);
    const cx = Math.cos(pl.rotX), sx = Math.sin(pl.rotX);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let x = positions[i * 3] * pl.scale;
      let y = positions[i * 3 + 1] * pl.scale;
      let z = positions[i * 3 + 2] * pl.scale;
      let y1 = y * cx - z * sx, z1 = y * sx + z * cx;      // tilt (X axis)
      let x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;   // spin (Y axis)
      out[i * 3] = x2 + pl.x;
      out[i * 3 + 1] = y1 + pl.y;
      out[i * 3 + 2] = z2 + pl.z;
    }
    this.frags.push({ positions: out, attr: attr.slice(), birth: nowSec, n });
    this.total += n;
    this.index++;
    return true;
  }

  // Fade mode housekeeping: drop fragments dimmer than PRUNE_W.
  ageWeights(nowSec) {
    if (!this.fade) return false;
    const before = this.frags.length;
    this.frags = this.frags.filter((f) => {
      const w = Math.pow(0.5, (nowSec - f.birth) / HALF_LIFE);
      if (w < PRUNE_W) { this.total -= f.n; return false; }
      return true;
    });
    return this.frags.length !== before;
  }

  flatten(nowSec) {
    const positions = new Float32Array(this.total * 3);
    const attr = new Float32Array(this.total);
    const weights = new Float32Array(this.total);
    let o = 0;
    for (const f of this.frags) {
      positions.set(f.positions, o * 3);
      attr.set(f.attr, o);
      const w = this.fade ? Math.pow(0.5, (nowSec - f.birth) / HALF_LIFE) : 1;
      weights.fill(w, o, o + f.n);
      o += f.n;
    }
    return { positions, attr, weights, count: this.total };
  }
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add js/grow.js test/grow.test.js
git commit -m "feat(grow): golden-spiral placement + growth composite"
```

---

### Task 2: NoteEventDetector

**Files:**
- Modify: `js/live.js` (new export, after `KickDetector`)
- Test: `test/live.test.js` (append)

**Interfaces:**
- Consumes: nothing new (kick value is passed in).
- Produces: `class NoteEventDetector` with `step(frame, kickValue, nowSec) -> bool`. Fires on onset (`kickValue === 1`), a new dominant pitch class held ≥ 0.12 s, or 0.5 s of continuous sound since the last event; ≥ 0.25 s apart; silent frames never fire and reset the sustain clock.

- [ ] **Step 1: Write the failing tests** (append to `test/live.test.js`; `mkFrame` exists)

```js
import { NoteEventDetector } from '../js/live.js';

test('NoteEventDetector: silence never fires', () => {
  const d = new NoteEventDetector();
  const quiet = mkFrame({ rms: 0.001 });
  for (let i = 0; i < 120; i++) assert.equal(d.step(quiet, 0, i / 60), false);
});

test('NoteEventDetector: onset fires, then throttles 250ms', () => {
  const d = new NoteEventDetector();
  const f = mkFrame();
  assert.equal(d.step(f, 1, 1.0), true);    // kick
  assert.equal(d.step(f, 1, 1.1), false);   // inside throttle
  assert.equal(d.step(f, 1, 1.3), true);    // past throttle
});

test('NoteEventDetector: a new held pitch class fires once', () => {
  const d = new NoteEventDetector();
  const c = mkFrame();                       // chroma peak at C (index 0)
  d.step(c, 1, 0);                           // initial onset event at t=0
  for (let t = 0.05; t < 0.45; t += 0.05) d.step(c, 0, t); // same note: sustain not yet due
  const eChroma = new Float32Array(12); eChroma[4] = 1;
  const e = mkFrame({ chroma: eChroma });
  d.step(e, 0, 0.30);                        // new note appears
  assert.equal(d.step(e, 0, 0.35), false);   // held 0.05s — not yet
  assert.equal(d.step(e, 0, 0.43), true);    // held ≥0.12s → fires
});

test('NoteEventDetector: sustained sound fires every ~0.5s', () => {
  const d = new NoteEventDetector();
  const hum = mkFrame({ pitchConf: 0.3 });   // unvoiced hum: no note events
  const fires = [];
  for (let t = 0; t < 2.0; t += 1 / 60) if (d.step(hum, 0, t)) fires.push(t);
  assert.ok(fires.length >= 3 && fires.length <= 5, `got ${fires.length}`);
  for (let i = 1; i < fires.length; i++) assert.ok(fires[i] - fires[i - 1] >= 0.45);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (`NoteEventDetector` not exported).

- [ ] **Step 3: Implement** — in `js/live.js`, after the `KickDetector` class:

```js
// Growth events: one per note/word-ish sound moment. Fires on an onset (the
// kick detector), on a NEW dominant pitch class held ≥120ms (a fresh note or
// vowel), and every 500ms of continuous sound (held notes keep adding).
// Events are ≥250ms apart; silence resets the sustain clock.
export class NoteEventDetector {
  constructor() {
    this.lastEvent = -Infinity;
    this.lastPc = -1;
    this.pcSince = -Infinity;
    this.soundSince = null;
  }
  step(f, kickValue, nowSec) {
    if (f.rms <= SILENCE_RMS) { this.soundSince = null; return false; }
    if (this.soundSince === null) this.soundSince = nowSec;
    let fire = kickValue === 1;
    if (f.pitchConf > 0.5) {
      let pc = 0;
      for (let i = 1; i < 12; i++) if (f.chroma[i] > f.chroma[pc]) pc = i;
      if (pc !== this.lastPc) { this.lastPc = pc; this.pcSince = nowSec; }
      else if (nowSec - this.pcSince >= 0.12 && this.pcSince > this.lastEvent) fire = true;
    }
    if (nowSec - Math.max(this.lastEvent, this.soundSince) >= 0.5) fire = true;
    if (fire && nowSec - this.lastEvent >= 0.25) { this.lastEvent = nowSec; return true; }
    return false;
  }
}
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(grow): note/word event detector"
```

---

### Task 3: Renderer — aWeight attribute, setGrowCloud, drawInTo

**Files:**
- Modify: `js/density.js` (SPLAT shaders, `setCloud`, `crossfadeTo`, new methods, `_loop`)

*(DOM/WebGL — covered by the manual browser pass; the shader default keeps every existing path pixel-identical.)*

**Interfaces:**
- Consumes: nothing new.
- Produces: `setGrowCloud(positions, attr, weights)`; `drawInTo(positions, attr)`; `setDrawProgress(t)` (t ∈ [0,1]; 1 completes and disposes the outgoing cloud). Existing `setCloud`/`crossfadeTo` unchanged externally.

- [ ] **Step 1: Shaders.** In `SPLAT_VERT` add the attribute and varying:

```glsl
attribute float attrv;
attribute float aWeight;
varying float vAttr;
varying float vW;
```
and before the closing brace: `vW = aWeight;`

In `SPLAT_FRAG`, declare `varying float vW;` and change the weight line to:

```glsl
  float w = exp(-r2 * 10.0) * uWeight * vW;
```

- [ ] **Step 2: Unit-weight buffer for existing paths.** Add a helper method (near `_splatMats`):

```js
  // Shared all-ones aWeight buffer (grown lazily) so non-grow clouds render
  // exactly as before the attribute existed.
  _unitWeights(n) {
    if (!this._unit || this._unit.length < n) this._unit = new Float32Array(n).fill(1);
    return this._unit.subarray(0, n);
  }
```

In `setCloud` after the `attrv` attribute line, add:

```js
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(positions.length / 3), 1));
```

Do the same in `crossfadeTo` after its `attrv` line.

- [ ] **Step 3: setGrowCloud.** After `setCloud`:

```js
  // Growth composite upload: like setCloud but with per-point weights.
  // Called ~1×/s with growing arrays; rebuilding the geometry is fine.
  setGrowCloud(positions, attr, weights) {
    this._disposeFading();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
    geo.setAttribute('aWeight', new THREE.BufferAttribute(weights, 1));
    if (this.fallback) {
      const mat = new THREE.PointsMaterial({ size: 0.008, color: 0xbbaaff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
    } else {
      this.points = new THREE.Points(geo, this.splatMat);
    }
    this.points.frustumCulled = false;
    this.group.add(this.points);
    const n = positions.length / 3;
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._dirty = true;
    this.splatMat.uniforms.uWeight.value = 1;
  }
```

- [ ] **Step 4: drawInTo / setDrawProgress.** After `crossfadeTo`:

```js
  // Draw-in: the incoming cloud reveals point by point (drawRange) while the
  // outgoing cloud dims — paced manually via setDrawProgress (the conductor
  // integrates loudness), unlike crossfadeTo's clock-driven fade.
  drawInTo(positions, attr) {
    if (!this.points || this.fallback) { this.setCloud(positions, attr); return; }
    this._disposeFading();
    this._fading = { points: this.points, mat: this.points.material, t: 0, dur: Infinity, manual: true };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
    geo.setAttribute('aWeight', new THREE.BufferAttribute(this._unitWeights(positions.length / 3), 1));
    const mat = this._makeSplatMat();
    mat.uniforms.uWeight.value = 1;
    geo.setDrawRange(0, 0);
    this.splatMat = mat;
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this._peakFrom = this.toneMat.uniforms.uPeak.value;
    const n = positions.length / 3;
    const [w, h] = this._size();
    this._peakTo = Math.max(8, (n / (w * h)) * 550);
    this._dirty = true;
  }

  setDrawProgress(t) {
    if (!this.points) return;
    const k = Math.max(0, Math.min(1, t));
    const count = this.points.geometry.getAttribute('position').count;
    this.points.geometry.setDrawRange(0, Math.floor(k * count));
    if (this._fading && this._fading.manual) {
      this._fading.mat.uniforms.uWeight.value = 1 - k;
      this.toneMat.uniforms.uPeak.value = this._peakFrom + (this._peakTo - this._peakFrom) * k;
      if (k >= 1) { this._disposeFading(); this.points.geometry.setDrawRange(0, count); }
    }
    this._dirty = true;
  }
```

- [ ] **Step 5: `_loop` must not auto-advance manual fades.** In `_loop`, change the fading branch guard:

```js
    if (this._fading && !this._fading.manual) {
```
(the rest of that block is unchanged).

- [ ] **Step 6: Run tests and commit**

Run: `npm test` → PASS (node tests untouched).

```bash
git add js/density.js
git commit -m "feat(grow): renderer weight attribute, grow cloud upload, manual draw-in"
```

---

### Task 4: Conductor growth modes

**Files:**
- Modify: `js/live.js` (`LiveConductor`)
- Test: `test/live.test.js` (append)

**Interfaces:**
- Consumes: `NoteEventDetector` (Task 2), `GrowComposite`/`FRAGMENT_POINTS`/`GROW_MAX_POINTS` from `./grow.js` (Task 1), renderer methods (Task 3).
- Produces: `conductor.setGrowthMode(mode)`; conductor honours `'morph' | 'grow-fade' | 'grow-keep' | 'draw-in'`; `getParams()` may supply `fragPoints` and `growMaxPoints` (defaults used otherwise); `freeze()` in grow modes returns `{ fingerprint, stops, cloud: { positions, attr } }` (morph modes: `cloud` absent); optional `onGrowStatus(msg)` callback.

- [ ] **Step 1: Write the failing tests** (append to `test/live.test.js`; extend `harness` to expose more of the renderer log)

First extend the harness renderer stub (add the three methods and log slots to the existing `renderer:` object inside `harness`):

```js
      setGrowCloud: (p, a, w) => { log.growUploads.push(p.length / 3); },
      drawInTo: () => { log.drawIns++; },
      setDrawProgress: (t) => { log.drawProgress.push(t); },
```
and extend the log initialiser: `const log = { xfades: 0, waves: [], stops: [], growUploads: [], drawIns: 0, drawProgress: [] };`

Then append:

```js
test('grow mode: events request fragments, morph scheduler is off', async () => {
  let genParams = null;
  const { conductor, log } = harness({
    generate: async (fp, p) => {
      genParams = p;
      return { positions: new Float32Array(30), attr: new Float32Array(10), strands: [] };
    },
  });
  conductor.setGrowthMode('grow-keep');
  // settle between tick batches so successive async fragments can land
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  assert.equal(log.xfades, 0, 'no crossfade morphs in grow mode');
  assert.ok(log.growUploads.length >= 2, 'composite uploaded as it grows');
  assert.ok(genParams.liveVariance === true && genParams.strandCount === 8);
  assert.ok(genParams.density > 0);
  // composite accumulates: uploads grow monotonically
  for (let i = 1; i < log.growUploads.length; i++) {
    assert.ok(log.growUploads[i] >= log.growUploads[i - 1]);
  }
});

test('grow mode: freeze returns the composite cloud', async () => {
  const { conductor } = harness({
    generate: async () => ({ positions: new Float32Array(30), attr: new Float32Array(10), strands: [] }),
  });
  conductor.setGrowthMode('grow-fade');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud, 'freeze exposes the composite');
  assert.ok(out.cloud.positions.length > 0);
  assert.equal(out.cloud.positions.length / 3, out.cloud.attr.length);
});

test('draw-in mode: new design reveals with progress instead of crossfade', async () => {
  const { conductor, log } = harness();
  conductor.setGrowthMode('draw-in');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);
  await settle();
  for (let i = 90; i < 150; i++) conductor.tick(i / 30); // progress advances
  assert.equal(log.xfades, 0);
  assert.equal(log.drawIns, 1);
  assert.ok(log.drawProgress.length > 0);
  assert.ok(log.drawProgress[log.drawProgress.length - 1] > log.drawProgress[0]);
});

test('switching back to morph restores crossfades', async () => {
  const { conductor, log } = harness();
  conductor.setGrowthMode('grow-keep');
  conductor.setGrowthMode('morph');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);
  await settle();
  assert.equal(log.xfades, 1);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test` → FAIL (`setGrowthMode` undefined).

- [ ] **Step 3: Implement** — in `js/live.js`:

Imports:

```js
import { GrowComposite, FRAGMENT_POINTS, GROW_MAX_POINTS } from './grow.js?v=36';
```

Constructor additions (after `this._lastNow = 0;`):

```js
    this.growthMode = 'morph';
    this.noteEvents = new NoteEventDetector();
    this.composite = null;
    this.growGen = 0;            // stale-fragment guard across mode switches/clears
    this.growInFlight = false;
    this.lastFadePass = 0;
    this.drawProgress = 1;
    this.onGrowStatus = null;
    this._saidFull = false;
```

New methods:

```js
  setGrowthMode(mode) {
    this.growthMode = mode;
    this.growGen++;
    this.growInFlight = false;
    this._saidFull = false;
    this.drawProgress = 1;
    if (mode === 'grow-fade' || mode === 'grow-keep') {
      const p = this.getParams();
      this.composite = new GrowComposite({
        maxPoints: p.growMaxPoints ?? GROW_MAX_POINTS,
        fade: mode === 'grow-fade',
      });
    } else {
      this.composite = null;
    }
  }

  // Fingerprint of roughly the last 0.9s — the note/word that just happened.
  eventFingerprint(nowSec) {
    const recent = this.frames.filter(x => nowSec - x.t <= 0.9).map(x => x.f);
    const frames = recent.length >= 4 ? recent : this.frames.map(x => x.f);
    const fp = buildFingerprint(frames, Math.max(0.25, Math.min(0.9, WINDOW_SEC)));
    fp.trajectory = buildTrajectory(frames);
    fp.trajectoryChannels = 4;
    return fp;
  }

  _growTick(nowSec, f, kick, dt) {
    const p = this.getParams();
    // fade housekeeping + weight refresh, ~1×/s
    if (this.composite.fade && nowSec - this.lastFadePass >= 1 && this.composite.total > 0) {
      this.lastFadePass = nowSec;
      this.composite.ageWeights(nowSec);
      const flat = this.composite.flatten(nowSec);
      this.renderer.setGrowCloud(flat.positions, flat.attr, flat.weights);
    }
    if (!this.noteEvents.step(f, kick, nowSec)) return;
    if (this.growInFlight) return;
    if (this.composite.full) {
      if (!this._saidFull && this.onGrowStatus) { this._saidFull = true; this.onGrowStatus('Design full — freeze or clear'); }
      return;
    }
    this.growInFlight = true;
    const gen = this.growGen;
    const fp = this.eventFingerprint(nowSec);
    this.generate(fp, { mode: p.mode, density: p.fragPoints ?? FRAGMENT_POINTS,
                        complexity: p.complexity, symmetry: 1, twist: 0,
                        strandCount: 8, cymStyle: p.cymStyle, liveVariance: true })
      .then((out) => {
        this.growInFlight = false;
        if (!this.running || !out || gen !== this.growGen) return;
        const flatMode = p.mode === 'cymatics' || p.mode === 'oscillo';
        if (!this.composite.append(out.positions, out.attr, fp, this._lastNow, flatMode)) return;
        const flat = this.composite.flatten(this._lastNow);
        this.renderer.setGrowCloud(flat.positions, flat.attr, flat.weights);
      })
      .catch(() => { this.growInFlight = false; });
  }
```

In `tick()`, after the colour block, replace the structural-layer section with a mode branch. The existing scheduler code stays for `morph`/`draw-in`; grow modes divert:

```js
    if (this.growthMode === 'grow-fade' || this.growthMode === 'grow-keep') {
      this._growTick(nowSec, f, kick, dt);
      return;
    }
    if (this.growthMode === 'draw-in' && this.drawProgress < 1) {
      this.drawProgress = Math.min(1, this.drawProgress + dt * (0.15 + 2.5 * f.rms));
      this.renderer.setDrawProgress(this.drawProgress);
    }
```

And in the morph completion handler (`.then((out) => { ... })`), route draw-in:

```js
        this.lastMorph = this._lastNow;
        this.shownFp = fp;
        if (this.growthMode === 'draw-in') {
          this.renderer.drawInTo(out.positions, out.attr);
          this.drawProgress = 0;
        } else {
          this.renderer.crossfadeTo(out.positions, out.attr, 1.0);
        }
```

`freeze()` gains the composite branch:

```js
  freeze() {
    if (this.frames.length < LIVE_MIN_FRAMES) return null;
    this.stop();
    const out = { fingerprint: this.windowFingerprint(), stops: stopsToHex(this.colour) };
    if (this.composite && this.composite.total > 0) {
      const flat = this.composite.flatten(this._lastNow);
      out.cloud = { positions: flat.positions, attr: flat.attr };
    }
    return out;
  }
```

- [ ] **Step 4: Run tests** — `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(grow): conductor growth modes — grow-fade/grow-keep/draw-in"
```

---

### Task 5: UI wiring + cache bump

**Files:**
- Modify: `index.html` (Growth select in the Mode section)
- Modify: `js/main.js` (param, listener, freeze path, suspension)
- Modify: all `?v=36` refs → `?v=37`

**Interfaces:**
- Consumes: `conductor.setGrowthMode`, `conductor.onGrowStatus`, `freeze().cloud`, `renderer.setCloud`.
- Produces: complete feature.

- [ ] **Step 1: index.html** — in the Mode panel section, after the `#row-cym-style` div:

```html
      <div class="sl-row" id="row-growth">
        <select id="sel-growth" class="live-suspended">
          <option value="morph" selected>Growth: Morph</option>
          <option value="grow-fade">Growth: Grow · fading</option>
          <option value="grow-keep">Growth: Grow · keep</option>
          <option value="draw-in">Growth: Draw-in</option>
        </select>
      </div>
```

- [ ] **Step 2: main.js** — add `growth: 'morph',` to the `params` object (after `cymStyle: 'auto',`).

In `bindControls()` (next to the `sel-cym-style` listener):

```js
  document.getElementById('sel-growth').addEventListener('change', (e) => {
    params.growth = e.target.value;
    if (appState === 'live' && conductor) conductor.setGrowthMode(params.growth);
  });
```

In `setLiveSuspended(on)`, add after the loop (growth is the inverse — it only means something during live):

```js
  document.getElementById('sel-growth').classList.toggle('live-suspended', !on);
```

In `makeConductor()`, extend `getParams` with `fragPoints: isMobile ? 7000 : 10000, growMaxPoints: isMobile ? 400000 : 1200000,` and after construction (in `enterLive`, right after `conductor = makeConductor();`):

```js
  conductor.setGrowthMode(params.growth);
  conductor.onGrowStatus = (msg) => setStatus(msg);
```

Freeze path — in the `submitBtn` live branch, after `stopLive();` and the palette assignments, replace the tail:

```js
      appState = 'captured';
      submitBtn.classList.add('hidden');
      vuWrap.classList.add('hidden');
      applyColorParams();
      if (out.cloud) {
        // Grown session: the design IS the history — show it as captured
        // geometry directly (regen sliders would replace it).
        design = { positions: out.cloud.positions, attr: out.cloud.attr, strands: [] };
        renderer.setMotion(motionParams(fingerprint.seed));
        if (params.flatView) renderer.setOrientation(-Math.PI / 2, 0);
        renderer.setCloud(out.cloud.positions, out.cloud.attr);
        applyRenderParams();
        setStatus('Grown design captured — sliders that regenerate will replace it');
      } else {
        regenerate();
      }
      return;
```

- [ ] **Step 3: Cache bump**

Run:
```bash
cd ~/Documents/Github/soundform && grep -rl 'v=36' index.html js/ | xargs sed -i '' 's/v=36/v=37/g' && grep -rn 'v=36' index.html js/ | wc -l
```
Expected: `0`.

- [ ] **Step 4: Run tests and commit**

Run: `npm test` → PASS. Also `node --check js/main.js js/live.js js/grow.js`.

```bash
git add index.html js/
git commit -m "feat(grow): growth selector UI, freeze-composite capture; bump cache to v=37"
```

---

## Manual browser acceptance (the point of this build)

Serve locally (`python3 -m http.server` in the repo root, open `localhost:8000`):

1. Live + **Growth: Grow · fading** — speak/play: forms appear one per note/word, spiralling out from the centre; after a few minutes the oldest dim away.
2. **Grow · keep** — same, nothing fades; long session eventually reports "Design full".
3. **Draw-in** — designs sweep into existence, faster when you're louder; old design dims out as the new draws.
4. **Morph** — unchanged from today.
5. Freeze during a grow session → the composite becomes the captured design; PNG/JPG/WebP/PDF export it (SVG will be empty — known, composites keep no strands).
6. Clear wipes; video recording works in all growth modes.
