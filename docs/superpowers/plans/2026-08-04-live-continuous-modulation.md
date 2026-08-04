# Live Continuous Modulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live attractor mode lock onto one design and deform it continuously with the voice, instead of regenerating and dissolving between unrelated designs; and fix three measured glitches in cymatics Paint splicing.

**Architecture:** Two layers split by cost. An *instant* layer runs every frame and touches only GPU uniforms and draw range (visible point count, onset pulses) — free and frame-accurate. A *structural* layer regenerates the locked attractor at ≤5 Hz with smoothly glided parameters, each step small enough (≈0.02 fingerprint drift → 0.94 cell overlap) that the cloud deforms rather than swaps. A new pure `AutoParams` module turns audio features into slider values; `main.js` mirrors those onto the real sliders and hands a slider back to the user permanently when they touch it.

**Tech Stack:** Vanilla ES modules, no build step. THREE.js for rendering. `node --test` for tests (`npm test` runs `node --test test/*.test.js`).

## Global Constraints

- **No build step.** Plain ES modules loaded by the browser directly.
- **Capture path must stay byte-identical.** `test/snapshot.test.js` (52 tests) pins recorded output by checksum. Every change here is live-only, gated on `params.liveVariance` / conductor state. If a snapshot test fails, the change leaked into capture — fix the change, do not regenerate goldens.
- **Cache-bust convention:** every `?v=NN` occurrence moves together. Currently `v=46` across 35 occurrences in `index.html`, `js/*.js`, `js/generators/index.js`. Bump only when shipping, as one commit.
- **Generator files** live in `js/generators/` and are imported with `?v=46` from `js/generators/index.js`.
- **Existing invariants that must keep passing:** the attractor locality test (`steady sound keeps a stable design across morphs`), the churn test (`one speaker talking does not churn the design`, ≤8 morphs/15s), and `attractor live: speech spreads across the system space`.
- **Baseline:** 315 tests passing at commit `edf5818`.
- Node's test runner runs each file in a separate process, and `test/live.test.js`, `test/paint.test.js`, `test/snapshot.test.js` all import helpers from `test/generators.test.js` — so adding a test there inflates the reported total by 4× its count. This is expected.

---

## File Structure

**Create:**
- `js/autoparams.js` — pure audio-features → slider-values gliding. No DOM, no THREE, no imports from live.js. Node-testable in isolation.
- `test/autoparams.test.js` — tests for the above.

**Modify:**
- `js/density.js` — add `setVisibleFraction()` for the instant density layer.
- `js/generators/attractor.js` — honour `params.lockedSystem`; add the complexity lever to `liveCoeffs`.
- `js/live.js` — lock the system for the session; replace morph regen/dissolve with continuous modulation; emit auto-param values; fix the three Paint splice defects.
- `js/main.js` — auto-slider state, mirroring, and manual override.
- `test/live.test.js`, `test/generators.test.js` — new coverage.

---

### Task 1: AutoParams — pure feature-to-slider gliding

**Files:**
- Create: `js/autoparams.js`
- Create: `test/autoparams.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `AutoParams` class with `step(features, dt) -> {complexity, twist, scale, visibleFraction}`; constants `AUTO_RANGE`, `AUTO_TAU`; function `featuresFromFingerprint(fp, loudness) -> {brightness, roughness, energy, loudness}`. Tasks 6 and 7 consume all of these.

- [ ] **Step 1: Write the failing test**

Create `test/autoparams.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoParams, AUTO_RANGE, AUTO_TAU, featuresFromFingerprint } from '../js/autoparams.js';

const FX = { brightness: 0.5, roughness: 0.5, energy: 0.5, loudness: 0.5 };

test('AutoParams: values start mid-range and stay inside their range', () => {
  const ap = new AutoParams();
  for (const k of Object.keys(AUTO_RANGE)) {
    const [lo, hi] = AUTO_RANGE[k];
    assert.ok(ap.value[k] >= lo && ap.value[k] <= hi, `${k} started outside range`);
  }
  // drive hard to both extremes; must clamp, never overshoot
  for (let i = 0; i < 400; i++) ap.step({ brightness: 1, roughness: 1, energy: 1, loudness: 1 }, 1 / 60);
  for (const k of Object.keys(AUTO_RANGE)) {
    const [lo, hi] = AUTO_RANGE[k];
    assert.ok(ap.value[k] <= hi + 1e-9 && ap.value[k] >= lo - 1e-9, `${k} escaped range at max drive`);
  }
  for (let i = 0; i < 400; i++) ap.step({ brightness: 0, roughness: 0, energy: 0, loudness: 0 }, 1 / 60);
  for (const k of Object.keys(AUTO_RANGE)) {
    const [lo, hi] = AUTO_RANGE[k];
    assert.ok(ap.value[k] <= hi + 1e-9 && ap.value[k] >= lo - 1e-9, `${k} escaped range at min drive`);
  }
});

test('AutoParams: glides gradually, never jumps', () => {
  const ap = new AutoParams();
  const before = ap.step(FX, 1 / 60).complexity;
  const after = ap.step({ ...FX, brightness: 1 }, 1 / 60).complexity;
  const [lo, hi] = AUTO_RANGE.complexity;
  // one 60fps frame may move at most a few percent of the range
  assert.ok(Math.abs(after - before) < (hi - lo) * 0.05,
    `complexity jumped ${Math.abs(after - before).toFixed(3)} in one frame`);
});

test('AutoParams: reaches its target given enough time', () => {
  const ap = new AutoParams();
  for (let i = 0; i < 60 * 20; i++) ap.step({ ...FX, brightness: 1 }, 1 / 60);
  const [, hi] = AUTO_RANGE.complexity;
  assert.ok(ap.value.complexity > hi - 0.02, `complexity settled at ${ap.value.complexity}, expected ~${hi}`);
});

test('AutoParams: each parameter follows its own feature', () => {
  const settle = (fx) => {
    const ap = new AutoParams();
    for (let i = 0; i < 60 * 20; i++) ap.step(fx, 1 / 60);
    return ap.value;
  };
  const dark = settle({ ...FX, brightness: 0 }), bright = settle({ ...FX, brightness: 1 });
  assert.ok(bright.complexity > dark.complexity, 'brightness must raise complexity');
  assert.equal(bright.scale.toFixed(4), dark.scale.toFixed(4), 'brightness must not move scale');

  const calm = settle({ ...FX, energy: 0 }), big = settle({ ...FX, energy: 1 });
  assert.ok(big.scale > calm.scale, 'energy must raise scale');

  const quiet = settle({ ...FX, loudness: 0 }), loud = settle({ ...FX, loudness: 1 });
  assert.ok(loud.visibleFraction > quiet.visibleFraction, 'loudness must raise visible fraction');

  const smooth = settle({ ...FX, roughness: 0 }), rough = settle({ ...FX, roughness: 1 });
  assert.notEqual(rough.twist.toFixed(4), smooth.twist.toFixed(4), 'roughness must move twist');
});

test('AutoParams: dt-independent — same elapsed time reaches the same place', () => {
  const drive = (dt, steps) => {
    const ap = new AutoParams();
    for (let i = 0; i < steps; i++) ap.step({ ...FX, brightness: 1 }, dt);
    return ap.value.complexity;
  };
  const at60 = drive(1 / 60, 300);     // 5s
  const at30 = drive(1 / 30, 150);     // 5s
  assert.ok(Math.abs(at60 - at30) < 0.01, `dt-dependent: ${at60} vs ${at30}`);
});

test('featuresFromFingerprint maps into 0..1', () => {
  const fp = { pitchMedian: 0.3, centroid: 0.4, spread: 0.35, consonance: 0.6,
               velocity: 0.4, volMean: 0.5, volVar: 0.2, attackSlope: 0.3 };
  const fx = featuresFromFingerprint(fp, 0.2);
  for (const k of ['brightness', 'roughness', 'energy', 'loudness']) {
    assert.ok(fx[k] >= 0 && fx[k] <= 1, `${k} = ${fx[k]} out of range`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/autoparams.test.js`
Expected: FAIL — `Cannot find module '../js/autoparams.js'`

- [ ] **Step 3: Write the implementation**

Create `js/autoparams.js`:

```js
// Voice → slider values. The live conductor feeds audio features in; this
// glides the real UI parameters toward them so the design is modulated through
// the same controls a user would reach for. Pure: no DOM, no THREE, no imports.

// Range each auto-driven parameter sweeps. Deliberately narrower than the
// slider's full span — the extremes of twist and scale are compositional
// choices, not something a voice should be able to slam into.
export const AUTO_RANGE = {
  complexity:     [0.15, 1.0],
  twist:          [-0.9, 0.9],
  scale:          [0.75, 1.5],
  visibleFraction:[0.35, 1.0],
};

// Glide time constants, seconds. visibleFraction is fastest because it costs
// nothing (draw range only) and carries the immediate loudness response;
// twist is slowest because rotating geometry reads as motion, and fast motion
// looks like a glitch rather than a response.
export const AUTO_TAU = {
  complexity: 1.2,
  twist: 2.0,
  scale: 0.8,
  visibleFraction: 0.25,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;

// Which feature drives which parameter. One feature per parameter, so a change
// in the sound is attributable to a change in the design.
const DRIVER = {
  complexity: 'brightness',
  twist: 'roughness',
  scale: 'energy',
  visibleFraction: 'loudness',
};

// Same character axes the attractor uses, plus instantaneous loudness. Kept
// here rather than imported so this module stays a leaf.
export function featuresFromFingerprint(fp, loudness = 0) {
  const cons = fp.consonance ?? 0.5;
  return {
    brightness: clamp01(0.6 * fp.pitchMedian + 0.4 * (fp.centroid ?? 0.5)),
    roughness:  clamp01(0.5 * (1 - cons) + 0.3 * (fp.spread ?? 0) + 0.2 * (fp.velocity ?? 0)),
    energy:     clamp01(0.5 * (fp.volMean ?? 0.5) + 0.3 * (fp.volVar ?? 0) + 0.2 * (fp.attackSlope ?? 0)),
    loudness:   clamp01(loudness),
  };
}

export class AutoParams {
  constructor(initial = {}) {
    this.value = {};
    for (const k of Object.keys(AUTO_RANGE)) {
      const [lo, hi] = AUTO_RANGE[k];
      this.value[k] = initial[k] ?? (lo + hi) / 2;
    }
  }

  // Where each parameter wants to be for the current sound.
  targets(fx) {
    const out = {};
    for (const k of Object.keys(AUTO_RANGE)) {
      const [lo, hi] = AUTO_RANGE[k];
      out[k] = lerp(lo, hi, clamp01(fx[DRIVER[k]] ?? 0.5));
    }
    return out;
  }

  // Exponential glide, framerate-independent.
  step(fx, dt) {
    const t = this.targets(fx);
    for (const k of Object.keys(AUTO_RANGE)) {
      const a = 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-4, AUTO_TAU[k]));
      const [lo, hi] = AUTO_RANGE[k];
      this.value[k] = Math.max(lo, Math.min(hi, this.value[k] + (t[k] - this.value[k]) * a));
    }
    return { ...this.value };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/autoparams.test.js`
Expected: PASS, 6 tests

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 321 passing (315 baseline + 6 new; this file is imported by nothing else, so no multiplier)

- [ ] **Step 6: Commit**

```bash
git add js/autoparams.js test/autoparams.test.js
git commit -m "feat(live): AutoParams - pure voice-to-slider gliding"
```

---

### Task 2: Renderer visible-fraction (instant density layer)

**Files:**
- Modify: `js/density.js` (add method after `setCloud`, around line 260)

**Interfaces:**
- Consumes: nothing.
- Produces: `DensityRenderer.setVisibleFraction(frac)` — clamps to 0..1, sets `drawRange` on the current non-paint cloud and rescales `uPeak` so brightness stays stable as the count changes. Task 6 calls it every frame.

- [ ] **Step 1: Read the surrounding code**

Read `js/density.js` lines 236–320. Note that `setCloud` builds `this.points` with the full buffer, `setPaintCount` already does the equivalent job for Paint mode (`setDrawRange` + `uPeak` rescale), and `_size()` returns `[w, h]`.

- [ ] **Step 2: Write the implementation**

Add immediately after `setCloud`'s closing brace in `js/density.js`:

```js
  // Reveal only the first `frac` of the current cloud. The generator emits
  // points in trajectory order, so a fraction is a representative sample of
  // the whole attractor rather than a lopped-off region. Costs nothing — it is
  // a draw-range change, no upload — which is why loudness drives this instead
  // of the Density slider (that one sets GENERATION density and would force a
  // ~150ms regeneration per volume change).
  setVisibleFraction(frac) {
    if (!this.points || this._paintPos) return;   // paint mode owns its own range
    const total = this.points.geometry.getAttribute('position').count;
    const n = Math.max(1, Math.min(total, Math.round(total * Math.max(0, Math.min(1, frac)))));
    this.points.geometry.setDrawRange(0, n);
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._visibleFraction = frac;
    this._dirty = true;
  }
```

- [ ] **Step 3: Verify nothing regressed**

Run: `npm test`
Expected: 321 passing. (`density.js` needs a browser, so it has no direct unit tests — this step is confirming no import-time breakage.)

- [ ] **Step 4: Commit**

```bash
git add js/density.js
git commit -m "feat(render): setVisibleFraction for draw-range density modulation"
```

---

### Task 3: Lock the attractor system via params

**Files:**
- Modify: `js/generators/attractor.js:296`
- Test: `test/generators.test.js`

**Interfaces:**
- Consumes: `pickSystemLive(fp)` (exists, line 198).
- Produces: `generate()` honours `params.lockedSystem` — a string naming one of `thomas|halvorsen|aizawa|lorenz|sinemap`. When absent, behaviour is exactly as today. Task 5 sets it.

- [ ] **Step 1: Write the failing test**

Add to `test/generators.test.js`, after the `speech spreads across the system space` test:

```js
test('attractor live: params.lockedSystem overrides routing', () => {
  const p = { ...baseParams, density: 30000, liveVariance: true };
  // A fingerprint that routes somewhere specific on its own...
  const fp = speechFingerprint(SPEAKERS['male calm']);
  const natural = pickSystemLive(fp);
  const other = natural === 'aizawa' ? 'lorenz' : 'aizawa';

  // ...must produce the locked system's geometry when locked to something else.
  const lockedOut = generate(fp, { ...p, lockedSystem: other });
  const nativeOther = generate(fp, { ...p, lockedSystem: other });
  assert.deepEqual([...lockedOut.positions.slice(0, 60)], [...nativeOther.positions.slice(0, 60)],
    'locking must be deterministic');

  const unlocked = generate(fp, p);
  let same = true;
  for (let i = 0; i < 60; i++) if (unlocked.positions[i] !== lockedOut.positions[i]) { same = false; break; }
  assert.ok(!same, 'lockedSystem had no effect');
});

test('attractor: lockedSystem does not affect the capture path', () => {
  const fp = testFingerprint();
  const a = generate(fp, { ...baseParams, density: 30000 });
  const b = generate(fp, { ...baseParams, density: 30000, lockedSystem: 'lorenz' });
  assert.deepEqual([...a.positions.slice(0, 300)], [...b.positions.slice(0, 300)],
    'capture output must ignore lockedSystem');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/generators.test.js`
Expected: FAIL on `lockedSystem had no effect`

- [ ] **Step 3: Write the implementation**

In `js/generators/attractor.js`, replace line 296:

```js
  const name = arch ? pickSystemLive(fp) : pickSystem(fp);
```

with:

```js
  // Live locks the system for a whole session (params.lockedSystem) so the
  // design is modulated rather than swapped. Capture ignores it entirely —
  // recorded output is pinned by snapshot checksums.
  const name = arch ? (params.lockedSystem ?? pickSystemLive(fp)) : pickSystem(fp);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/generators.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 329 passing (321 + 2 new × 4 processes)

- [ ] **Step 6: Commit**

```bash
git add js/generators/attractor.js test/generators.test.js
git commit -m "feat(attractor): honour params.lockedSystem on the live path"
```

---

### Task 4: Complexity lever

**Files:**
- Modify: `js/generators/attractor.js` — the four `liveCoeffs` functions (lines 22, 47, 67, 86) and the call site (line 315)
- Test: `test/generators.test.js`

**Interfaces:**
- Consumes: `expandAxes(axes, fp)` (line 158).
- Produces: `liveCoeffs(c, ax, complexity)` — third argument, `0..1`, biases coefficients toward each system's more-elaborate end. `generate()` passes `params.complexity ?? 0.5`.

- [ ] **Step 1: Write the failing test**

Add to `test/generators.test.js`:

```js
test('attractor live: complexity changes the form', () => {
  // Before this lever existed, the complexity slider moved a live flow
  // attractor by 0.000-0.004 cell overlap — i.e. not at all.
  const fp = speechFingerprint(SPEAKERS['male calm']);
  const p = { ...baseParams, density: 30000, liveVariance: true, lockedSystem: 'aizawa' };
  const cells = (cx) => {
    const out = generate(fp, { ...p, complexity: cx });
    const s = new Set();
    for (let i = 0; i < out.positions.length / 3; i++) {
      const q = (d) => Math.min(21, Math.max(0, Math.floor((out.positions[i * 3 + d] + 1.6) / 3.2 * 22)));
      s.add((q(0) * 22 + q(1)) * 22 + q(2));
    }
    return s;
  };
  const lo = cells(0.15), hi = cells(1.0);
  let inter = 0; for (const v of lo) if (hi.has(v)) inter++;
  const jac = inter / (lo.size + hi.size - inter);
  assert.ok(jac < 0.85, `complexity barely changed the form (overlap ${jac.toFixed(3)})`);
  // but it must remain the SAME attractor, not a different one
  assert.ok(jac > 0.15, `complexity changed the form beyond recognition (overlap ${jac.toFixed(3)})`);
});

test('attractor: complexity lever does not leak into capture', () => {
  const fp = testFingerprint();
  const a = generate(fp, { ...baseParams, density: 30000, complexity: 0.2 });
  const b = generate(fp, { ...baseParams, density: 30000, complexity: 0.2 });
  assert.deepEqual([...a.positions.slice(0, 300)], [...b.positions.slice(0, 300)]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/generators.test.js`
Expected: FAIL — `complexity barely changed the form (overlap 1.000)`

- [ ] **Step 3: Add the lever to each system**

In `js/generators/attractor.js`, add this helper immediately above the `SYSTEMS` object (after the `lerp` definition on line 5):

```js
// Complexity biases a coefficient toward the end of its range that reads as
// more elaborate. cx = 0.5 is neutral (the axis-derived value, unchanged);
// cx = 1 pushes fully toward `toward`; cx = 0 fully away. The push is capped
// at 60% of the remaining distance so coefficients never reach the validated
// range's edge, where validateOccupancy starts rejecting and generate() falls
// back to the capture path — a fallback discards live variance entirely.
const complexify = (v, lo, hi, cx, toward) => {
  const t = Math.max(-1, Math.min(1, (cx - 0.5) * 2)) * 0.6;
  const end = toward === 'hi' ? hi : lo;
  const away = toward === 'hi' ? lo : hi;
  return t >= 0 ? lerp(v, end, t) : lerp(v, away, -t);
};
```

Replace the four `liveCoeffs` bodies. **thomas** (line 22) — lower damping reads as more elaborate:

```js
    liveCoeffs: (c, ax, cx = 0.5) => {
      const b = complexify(lerp(0.168, 0.098, ax[4]), 0.168, 0.098, cx, 'hi');
      c.b = b;
      c.bx = b * lerp(0.93, 1.07, ax[1]);
      c.by = b * lerp(0.93, 1.07, ax[2]);
      c.bz = b * lerp(0.93, 1.07, ax[3]);
    },
```

**halvorsen** (line 47) — a wider asymmetry split reads as more elaborate:

```js
    liveCoeffs: (c, ax, cx = 0.5) => {
      c.a = lerp(1.36, 1.92, ax[4]);
      const k = lerp(3.88, 4.12, ax[1]);
      const spread = 0.04 * (0.5 + cx);            // 0.02 .. 0.06
      c.kx = k * (1 + spread * (ax[1] * 2 - 1));
      c.ky = k * (1 + spread * (ax[2] * 2 - 1));
      c.kz = k * (1 + spread * (ax[3] * 2 - 1));
    },
```

**aizawa** (line 67) — higher `d` gives tighter folds and a denser interior:

```js
    liveCoeffs: (c, ax, cx = 0.5) => {
      c.d = complexify(lerp(3.00, 3.95, ax[4]), 3.00, 3.95, cx, 'hi');
      c.b = lerp(0.60, 0.80, ax[0]);
      c.e = lerp(0.19, 0.31, ax[1]);
      c.a = lerp(0.88, 1.00, ax[2]);   // a > 1 grows the z term until it diverges
      c.c = lerp(0.50, 0.70, ax[3]);
      c.f = lerp(0.07, 0.12, ax[2]);
    },
```

**lorenz** (line 86) — higher `r` sits deeper in the chaotic band:

```js
    liveCoeffs: (c, ax, cx = 0.5) => {
      c.r = complexify(lerp(28.0, 46.0, ax[4]), 28.0, 46.0, cx, 'hi');
      c.s = lerp(8.5, 12.5, ax[2]);
      c.b = lerp(2.35, 3.25, ax[1]);
    },
```

- [ ] **Step 4: Pass complexity at both call sites**

In `generate()`, line 315, change:

```js
      sys.liveCoeffs(c, expandAxes(axes, fp));
```

to:

```js
      sys.liveCoeffs(c, expandAxes(axes, fp), params.complexity ?? 0.5);
```

In `createOrbitBrush()`, line 438, change:

```js
      sys.liveCoeffs(c, expandAxes(axes, f));
```

to:

```js
      sys.liveCoeffs(c, expandAxes(axes, f), complexity);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/generators.test.js`
Expected: PASS

- [ ] **Step 6: Check the fallback rate did not regress**

The complexity push must not drive coefficients into rejecting territory. Run:

```bash
node /private/tmp/claude-501/-Users-michaeldewet/e4e7c304-63a9-4b06-9979-0f52cf2f2278/scratchpad/pv2.mjs 2>&1 | tail -2
```

Expected: `3/108` or fewer fell back. If higher, narrow the `0.6` cap in `complexify`.
(If the scratchpad file is gone, re-create it: it generates each system across a grid of fingerprints with `liveVariance: true` and counts how many produce output byte-identical to the `liveVariance: false` call — that equality means all 8 retries were rejected and `generate()` fell back.)

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: 337 passing, including all 52 snapshot tests

- [ ] **Step 8: Commit**

```bash
git add js/generators/attractor.js test/generators.test.js
git commit -m "feat(attractor): complexity biases coefficients toward each system's elaborate end"
```

---

### Task 5: Lock the system for the live session

**Files:**
- Modify: `js/live.js` — `LiveConductor` constructor (~line 128), `tick()` structural block (~line 323), `setGrowthMode` (line 164)
- Test: `test/live.test.js`

**Interfaces:**
- Consumes: `pickSystemLive` from `js/generators/attractor.js?v=46`, `params.lockedSystem` from Task 3.
- Produces: `conductor.lockedSystem` (string or null); every `generate()` call from the conductor carries `lockedSystem`. Task 6 relies on the lock existing before it starts modulating.

- [ ] **Step 1: Write the failing test**

Add to `test/live.test.js`:

```js
test('conductor locks the attractor system for the whole session', async () => {
  const seen = [];
  const frame = { current: mkFrame() };
  const { conductor } = harness({
    frame,
    generate: async (fp, p) => { seen.push(p.lockedSystem); return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] }; },
  });
  // wildly different sounds across the session
  const variants = [
    mkFrame({ pitchHz: 110, centroid: 0.1, rms: 0.1 }),
    mkFrame({ pitchHz: 880, centroid: 0.8, rms: 0.3, flux: 0.02 }),
    mkFrame({ pitchHz: 220, centroid: 0.3, rms: 0.05 }),
    mkFrame({ pitchHz: 1400, centroid: 0.9, rms: 0.35, flux: 0.03 }),
  ];
  for (let i = 0; i < 60 * 20; i++) {
    frame.current = variants[Math.floor(i / (60 * 5)) % variants.length];
    conductor.tick(i / 60);
    await settle();
  }
  assert.ok(seen.length >= 2, `expected several generations, got ${seen.length}`);
  assert.ok(seen.every((s) => typeof s === 'string' && s.length > 0), 'every call must carry lockedSystem');
  assert.equal(new Set(seen).size, 1, `system changed mid-session: ${[...new Set(seen)].join(', ')}`);
});

test('conductor releases the lock on clear / growth-mode switch', () => {
  const { conductor } = harness();
  for (let i = 0; i < 40; i++) conductor.tick(i / 60);
  conductor.setGrowthMode('paint');
  assert.equal(conductor.lockedSystem, null, 'switching mode must release the lock');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/live.test.js`
Expected: FAIL — `every call must carry lockedSystem` (it is `undefined`)

- [ ] **Step 3: Write the implementation**

In `js/live.js`, add the import at the top (beside the existing `createOrbitBrush` import on line 7):

```js
import { createOrbitBrush, pickSystemLive } from './generators/attractor.js?v=46';
```

In the constructor, beside `this.shownFp = null;` (line 140), add:

```js
    this.lockedSystem = null;         // attractor system, fixed for the session
```

In `setGrowthMode` (line 164), inside the method body, add:

```js
    this.lockedSystem = null;         // a fresh canvas re-picks the form
```

Add this method to `LiveConductor`, immediately before `windowFingerprint()`:

```js
  // The form is chosen once, from the first sound that is worth fingerprinting,
  // and held for the rest of the session. Everything after that is modulation
  // of that one design — which is the whole point: system identity dominates
  // appearance (same-system designs overlap 0.60-0.88 by cell occupancy,
  // cross-system only 0.10-0.39), so re-picking mid-session reads as swapping
  // designs, not as responding to a voice.
  _lockSystem(fp) {
    if (!this.lockedSystem) this.lockedSystem = pickSystemLive(fp);
    return this.lockedSystem;
  }
```

In `tick()`, in the structural block, change the `generate` call (~line 337) to pass the lock. Replace:

```js
    this.generate(fp, { mode: p.mode, density: p.liveDensity, complexity: p.complexity,
                        symmetry: p.symmetry, twist: p.twist, strandCount: 96,
                        cymStyle: p.cymStyle, liveVariance: true })
```

with:

```js
    this.generate(fp, { mode: p.mode, density: p.liveDensity, complexity: p.complexity,
                        symmetry: p.symmetry, twist: p.twist, strandCount: 8,
                        cymStyle: p.cymStyle, liveVariance: true,
                        lockedSystem: this._lockSystem(fp) })
```

(`strandCount` drops 96 → 8: freeze in morph mode returns only a fingerprint and `main.js` calls `regenerate()`, so live strands are discarded. Saves ~40ms per generation.)

In `_requestReveal` (line 245), add the same field to its `generate` call:

```js
                        cymStyle: p.cymStyle, liveVariance: true,
                        lockedSystem: this._lockSystem(fp) })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/live.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 339 passing

- [ ] **Step 6: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(live): lock the attractor system for the whole session"
```

---

### Task 6: Continuous structural modulation

**Files:**
- Modify: `js/live.js` — constants block (lines 9–35), constructor, `tick()`
- Test: `test/live.test.js`

**Interfaces:**
- Consumes: `AutoParams`, `featuresFromFingerprint` (Task 1); `conductor.lockedSystem` (Task 5); `renderer.setVisibleFraction` (Task 2).
- Produces: `MODULATE_INTERVAL`, `MODULATE_CROSSFADE_SEC` exports; `conductor.auto` (an `AutoParams`); `onAutoParams` callback invoked with the current auto values. Task 7 consumes `onAutoParams`.

- [ ] **Step 1: Write the failing test**

Add to `test/live.test.js`:

```js
test('live modulation deforms continuously instead of swapping designs', async () => {
  const gens = [];
  const frame = { current: mkFrame() };
  const { conductor, log } = harness({
    frame,
    generate: async (fp, p) => { gens.push({ complexity: p.complexity, twist: p.twist }); return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] }; },
  });
  for (let i = 0; i < 60 * 12; i++) {
    const t = i / 60;
    frame.current = mkFrame({ centroid: 0.2 + 0.5 * Math.min(1, t / 10), rms: 0.12 + 0.1 * Math.min(1, t / 10) });
    conductor.tick(t);
    await settle();
  }
  assert.ok(gens.length >= 6, `expected continuous regeneration, got ${gens.length}`);
  // consecutive regenerations must differ only slightly - that is what makes it
  // a deformation rather than a swap
  for (let i = 1; i < gens.length; i++) {
    const d = Math.abs(gens[i].complexity - gens[i - 1].complexity);
    assert.ok(d < 0.2, `complexity jumped ${d.toFixed(3)} between consecutive generations`);
  }
  assert.ok(log.xfades >= 6, 'modulation must reach the renderer');
});

test('modulation crossfade is short enough to read as deformation', () => {
  assert.ok(MODULATE_CROSSFADE_SEC <= 0.2,
    `${MODULATE_CROSSFADE_SEC}s reads as a dissolve between designs, not a deformation`);
});

test('conductor reports auto parameters for the sliders', async () => {
  const seen = [];
  const { conductor } = harness();
  conductor.onAutoParams = (v) => seen.push(v);
  for (let i = 0; i < 120; i++) { conductor.tick(i / 60); await settle(); }
  assert.ok(seen.length > 0, 'onAutoParams never fired');
  const last = seen[seen.length - 1];
  for (const k of ['complexity', 'twist', 'scale', 'visibleFraction']) {
    assert.ok(typeof last[k] === 'number' && Number.isFinite(last[k]), `${k} missing from auto params`);
  }
});
```

Add `MODULATE_CROSSFADE_SEC` to the import at line 3–5 of `test/live.test.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/live.test.js`
Expected: FAIL — `MODULATE_CROSSFADE_SEC` is undefined

- [ ] **Step 3: Add the constants**

In `js/live.js`, after `MORPH_CROSSFADE_SEC` (line 24), add:

```js
// Continuous modulation of a LOCKED design, as distinct from morphing between
// designs. Cadence is bounded by generation cost (~110ms for 250k points with
// 8 strands), and the crossfade only has to hide point-identity shuffle: a
// chaotic regeneration reshuffles which point is where even when the attractor
// SET barely moves, and additive density rendering makes an identically
// distributed cloud look identical, so a brief blend is enough.
export const MODULATE_INTERVAL = 0.25;
export const MODULATE_CROSSFADE_SEC = 0.15;
```

Add the import at the top:

```js
import { AutoParams, featuresFromFingerprint } from './autoparams.js?v=46';
```

- [ ] **Step 4: Wire it into the conductor**

In the constructor, beside `this.lockedSystem = null;`, add:

```js
    this.auto = new AutoParams();     // voice-driven slider values
    this.onAutoParams = null;         // (values) => void, for the UI sliders
    this.lastModulate = -Infinity;
```

In `tick()`, immediately after the colour block (`this.applyStops(stopsToHex(this.colour));`) and **before** the paint-mode early return, add:

```js
    // ── auto parameters: the voice moves the sliders ──
    if (this.shownFp) {
      const vals = this.auto.step(featuresFromFingerprint(this.shownFp, f.rms * 4), dt);
      this.renderer.setVisibleFraction(vals.visibleFraction);
      if (this.onAutoParams) this.onAutoParams(vals);
    }
```

Then in the structural block, replace the whole gate. Change:

```js
    const due = nowSec - this.lastCheck >= MORPH_CHECK_INTERVAL || this.forceNext;
    const allowed = !this.inFlight && nowSec - this.lastMorph >= MORPH_MIN_INTERVAL
                 && this.frames.length >= LIVE_MIN_FRAMES;
```

to:

```js
    // Once a system is locked, the design is modulated on a fast fixed cadence
    // rather than morphed on a delta threshold — there is no longer anything to
    // switch TO, so waiting for a big change would just make it unresponsive.
    const modulating = !!this.lockedSystem;
    const interval = modulating ? MODULATE_INTERVAL : MORPH_CHECK_INTERVAL;
    const minGap = modulating ? MODULATE_INTERVAL : MORPH_MIN_INTERVAL;
    const due = nowSec - this.lastCheck >= interval || this.forceNext;
    const allowed = !this.inFlight && nowSec - this.lastMorph >= minGap
                 && this.frames.length >= LIVE_MIN_FRAMES;
```

Replace the debounce block:

```js
    const fp = this.windowFingerprint();
    if (!this.forceNext) {
      if (fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) { this.overChecks = 0; return; }
      this.overChecks = (this.overChecks || 0) + 1;
      if (this.shownFp && this.overChecks < MORPH_CONFIRM_CHECKS) return;
    }
    this.overChecks = 0;
```

with:

```js
    const fp = this.windowFingerprint();
    // While modulating, every tick regenerates: the auto parameters have moved
    // even when the fingerprint has not, and the whole point is a design that
    // breathes with the voice rather than one that waits for a threshold.
    if (!this.forceNext && !modulating) {
      if (fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) { this.overChecks = 0; return; }
      this.overChecks = (this.overChecks || 0) + 1;
      if (this.shownFp && this.overChecks < MORPH_CONFIRM_CHECKS) return;
    }
    this.overChecks = 0;
```

In the same block, use the auto values for the generation params and the short crossfade. Change the `generate` call's `complexity` and `twist`:

```js
    const a = this.auto.value;
    this.generate(fp, { mode: p.mode, density: p.liveDensity, complexity: a.complexity,
                        symmetry: p.symmetry, twist: a.twist, strandCount: 8,
                        cymStyle: p.cymStyle, liveVariance: true,
                        lockedSystem: this._lockSystem(fp) })
```

and the crossfade line:

```js
        this.renderer.crossfadeTo(out.positions, out.attr,
          this.lockedSystem ? MODULATE_CROSSFADE_SEC : MORPH_CROSSFADE_SEC);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/live.test.js`
Expected: PASS

- [ ] **Step 6: Verify the harness renderer stub has the new method**

`test/live.test.js`'s `harness()` renderer must gain `setVisibleFraction: () => {}` or every conductor test throws. Add it beside `crossfadeTo` in the stub (line ~72).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: 345 passing. The churn test (`one speaker talking does not churn the design`) now measures modulation, not morphing — if it fails, the assertion needs rewriting to count *system changes* (which must be 0) rather than crossfades. Do that rather than loosening the number.

- [ ] **Step 8: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(live): continuous modulation of the locked design"
```

---

### Task 7: Auto-driven sliders with manual override

**Files:**
- Modify: `js/main.js` — slider table (line 462), listener loop (line 505), live start (~line 392), clear handler (~line 361)
- Test: manual (DOM-dependent)

**Interfaces:**
- Consumes: `conductor.onAutoParams` (Task 6).
- Produces: nothing downstream.

- [ ] **Step 1: Add the auto-state map**

In `js/main.js`, immediately after the `params` object (line 48), add:

```js
// Sliders the voice drives while live. Touching one hands it back to the user
// for the rest of the session; the rest keep tracking. Clear resets all.
const AUTO_SLIDERS = { complexity: 'sl-complexity', twist: 'sl-twist', scale: 'sl-scale' };
const autoOwned = { complexity: true, twist: true, scale: true };
let lastAutoPaint = 0;
```

- [ ] **Step 2: Mirror values onto the sliders**

Add this function beside `applyRenderParams` in `js/main.js`:

```js
// 10 Hz, not 60: writing slider values every frame thrashes layout for a
// change no one can perceive at that rate.
function paintAutoSliders(vals, nowMs) {
  if (nowMs - lastAutoPaint < 100) return;
  lastAutoPaint = nowMs;
  for (const [key, id] of Object.entries(AUTO_SLIDERS)) {
    if (!autoOwned[key]) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    params[key] = vals[key];
    el.value = String(vals[key]);
    const valEl = document.getElementById(id.replace('sl-', 'val-'));
    if (valEl) valEl.textContent = (+vals[key]).toFixed(2);
  }
  applyRenderParams();
}
```

- [ ] **Step 3: Release a slider when the user touches it**

In the slider listener loop (line 508), inside the `input` handler, add as the first line:

```js
      if (key in autoOwned) autoOwned[key] = false;   // manual takes over for the session
```

- [ ] **Step 4: Reset on clear and wire the callback**

At the point where the conductor is created (~line 392, `conductor = makeConductor();`), add after `conductor.onGrowStatus = ...`:

```js
  for (const k of Object.keys(autoOwned)) autoOwned[k] = true;
  conductor.onAutoParams = (vals) => paintAutoSliders(vals, performance.now());
```

In the `clearBtn` click handler (line 361), after `stopLive();`, add:

```js
    for (const k of Object.keys(autoOwned)) autoOwned[k] = true;
```

- [ ] **Step 5: Verify nothing regressed**

Run: `npm test`
Expected: 345 passing (`main.js` is DOM-bound and has no unit tests; this confirms no import-time breakage).

- [ ] **Step 6: Commit**

```bash
git add js/main.js
git commit -m "feat(ui): voice-driven sliders with manual override"
```

---

### Task 8: Cymatics Paint splice fixes

**Files:**
- Modify: `js/live.js` — `_paintTick` (line 173), `_requestReveal` (line 241)
- Test: `test/live.test.js`

**Interfaces:**
- Consumes: `MORPH_CONFIRM_CHECKS` (exists).
- Produces: `PAINT_SPLICE_CHUNK` export.

- [ ] **Step 1: Write the failing test**

Add to `test/live.test.js`:

```js
test('paint splice never overwrites points already on screen', async () => {
  // _requestReveal captured spliceFrom at REQUEST time, but generation is
  // async and st.count keeps advancing - so completion wrote over up to ~2000
  // points the user could already see. That is the visible "jump".
  const violations = [];
  let visible = 0;
  const frame = { current: mkFrame({ rms: 0.3 }) };
  let resolveGen = null;
  const { conductor } = harness({
    frame,
    generate: () => new Promise((res) => { resolveGen = () => res({
      positions: new Float32Array(60000 * 3), attr: new Float32Array(60000), strands: [] }); }),
    getParams: () => ({ mode: 'cymatics', cymStyle: 'auto', complexity: 0.5, symmetry: 1, twist: 0,
                        liveDensity: 1000, exposure: 30, scale: 1, grain: 1, paintMaxPoints: 60000 }),
  });
  conductor.setGrowthMode('paint');
  conductor.paintMax = 60000;
  const r = conductor.renderer;
  r.setPaintCount = (n) => { visible = n; };
  r.writePaintPoints = (offset, pos) => {
    if (offset < visible) violations.push({ offset, visible, n: pos.length / 3 });
  };
  for (let i = 0; i < 60 * 8; i++) {
    conductor.tick(i / 60);
    if (i === 120 && resolveGen) { resolveGen(); resolveGen = null; }
    await settle();
  }
  assert.equal(violations.length, 0,
    `splice overwrote visible points: ${JSON.stringify(violations[0])}`);
});

test('paint splice writes in bounded chunks', async () => {
  const sizes = [];
  const frame = { current: mkFrame({ rms: 0.3 }) };
  const { conductor } = harness({
    frame,
    generate: async () => ({ positions: new Float32Array(600000 * 3), attr: new Float32Array(600000), strands: [] }),
    getParams: () => ({ mode: 'cymatics', cymStyle: 'auto', complexity: 0.5, symmetry: 1, twist: 0,
                        liveDensity: 1000, exposure: 30, scale: 1, grain: 1, paintMaxPoints: 600000 }),
  });
  conductor.setGrowthMode('paint');
  conductor.paintMax = 600000;
  conductor.renderer.writePaintPoints = (o, pos) => sizes.push(pos.length / 3);
  for (let i = 0; i < 60 * 6; i++) { conductor.tick(i / 60); await settle(); }
  const biggest = Math.max(0, ...sizes);
  assert.ok(biggest <= PAINT_SPLICE_CHUNK,
    `single write of ${biggest} points (~${(biggest * 16 / 1e6).toFixed(1)} MB) will hitch the frame`);
});
```

Add `PAINT_SPLICE_CHUNK` to the `../js/live.js` import in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/live.test.js`
Expected: FAIL — `PAINT_SPLICE_CHUNK` undefined, and the overwrite test reports violations

- [ ] **Step 3: Add the chunk constant**

In `js/live.js`, beside `MODULATE_INTERVAL`, add:

```js
// A reveal splice replaces the whole unpainted remainder — up to 600k points,
// which is 7.2 MB of positions plus 2.4 MB of attributes uploaded in a single
// frame. That is a guaranteed hitch. Write it across frames instead.
export const PAINT_SPLICE_CHUNK = 40_000;
```

- [ ] **Step 4: Fix the stale splice offset and chunk the write**

Replace `_requestReveal`'s `.then()` body (lines 248–263). The current version writes from the offset captured at request time; it must recompute from the live count and queue the rest:

```js
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
        // Recompute from the CURRENT count, not the one captured when this
        // generation was requested — the brush kept moving while the worker ran,
        // and writing from the stale offset repaints points already on screen.
        const from = Math.min(Math.max(spliceFrom, st.count), total);
        st.revealTotal = total;
        st.strands = out.strands;
        st.pending = { positions: out.positions, attr: out.attr, next: from, total };
      })
```

- [ ] **Step 5: Drain the queue a chunk per frame**

In `_paintTick`, immediately after the `const st = this.paint;` line, add:

```js
    // Drain a queued splice a chunk at a time so no single frame uploads
    // megabytes. Always stays ahead of the reveal: `next` only ever moves
    // forward, and the reveal cannot pass it because it is capped by revealTotal.
    if (st.pending) {
      const q = st.pending;
      const end = Math.min(q.total, q.next + PAINT_SPLICE_CHUNK);
      if (end > q.next) {
        this.renderer.writePaintPoints(q.next,
          q.positions.subarray(q.next * 3, end * 3), q.attr.subarray(q.next, end));
        q.next = end;
      }
      if (q.next >= q.total) st.pending = null;
    }
```

Also add `pending: null` to the `paint` object literal in `setGrowthMode` (line 167).

- [ ] **Step 6: Give Paint the same debounce as the morph path**

In `_paintTick`'s steering block, replace:

```js
    if (!st.forceSteer && fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) return;
    st.forceSteer = false;
```

with:

```js
    // Same debounce as the morph path. Without it Paint fired on a single
    // threshold crossing, and after the check interval dropped 0.75s -> 0.15s
    // that meant 15 design splices per 30s of one person talking.
    if (!st.forceSteer) {
      if (fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) { st.overChecks = 0; return; }
      st.overChecks = (st.overChecks || 0) + 1;
      if (st.overChecks < MORPH_CONFIRM_CHECKS) return;
    }
    st.overChecks = 0;
    st.forceSteer = false;
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/live.test.js`
Expected: PASS

- [ ] **Step 8: Confirm the splice rate dropped**

```bash
node /private/tmp/claude-501/-Users-michaeldewet/e4e7c304-63a9-4b06-9979-0f52cf2f2278/scratchpad/probe-paint-splices.mjs
```

Expected: fewer than 15 splices per 30s, largest single upload ≤ 40,000 points, zero overwritten visible points.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: 349 passing

- [ ] **Step 10: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "fix(paint): chunk splices, drop stale splice offset, debounce steering"
```

---

### Task 9: Ship

**Files:**
- Modify: every file containing `?v=46`

- [ ] **Step 1: Bump the cache-bust**

```bash
grep -rl "?v=46" index.html js/*.js js/generators/*.js | xargs sed -i '' 's/?v=46/?v=47/g'
grep -rn "?v=46" index.html js/ | wc -l   # expect 0
grep -rno "?v=47" index.html js/*.js js/generators/*.js | wc -l   # expect 36 (35 + autoparams.js import)
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: 349 passing, 0 failing

- [ ] **Step 3: Commit and merge**

```bash
git add -A
git commit -m "chore: bump cache-bust to v=47"
git checkout main && git merge --ff-only <branch>
```

- [ ] **Step 4: Do NOT push without asking**

Pushing deploys to the live site. Ask the user first, exactly as with the previous two fixes.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Two layers, split by cost | 2 (instant), 6 (structural) |
| System lock | 3 (generator), 5 (conductor) |
| Complexity lever | 4 |
| Auto-driven sliders | 1 (values), 6 (emission), 7 (UI) |
| Density deviation — draw range | 2, 6 |
| Cymatics: chunked splice | 8 |
| Cymatics: recompute spliceFrom | 8 |
| Cymatics: debounce parity | 8 |
| Testing section | tests in 1, 3, 4, 5, 6, 8 |
| Risk: worker load | Task 6 Step 7 notes the churn-test rewrite; live density fallback stays available |

**Type consistency:** `liveCoeffs(c, ax, cx)` — three args at all four definitions (Task 4) and both call sites (Task 4 Step 4). `AutoParams.step()` returns the same four keys used by `paintAutoSliders` (Task 7) and `setVisibleFraction` (Task 6). `params.lockedSystem` is set in Task 5 and read in Task 3. `st.pending` is created in Task 8 Step 4, drained in Step 5, initialised in Step 5.

**Known follow-ups, deliberately out of scope:** Paint pause/resume; the slider-discards-painted-cloud bug; browser acceptance of all of the above.
