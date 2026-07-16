# Live Form Families Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live Mode designs pick one of three radically different form archetypes per mode, selected by the sound's character, while non-live generation stays byte-identical.

**Architecture:** A pure `formArchetype(fp)` selector in `js/generators/common.js` buckets timbre+harmony into 3 archetypes (0 tonal-smooth, 1 bright-piercing, 2 rough-noisy) plus a continuous `wildness` widener. Each generator gains additive variant branches gated on `params.liveVariance`, which only `LiveConductor` sets. `fingerprintDelta` gains timbre terms so character changes trigger morphs.

**Tech Stack:** Vanilla ES modules, no build step. Tests: `node --test` (`npm test`). Spec: `docs/superpowers/specs/2026-07-16-live-form-families-design.md`.

## Global Constraints

- Without `params.liveVariance`, every generator's output must be **byte-identical to today** (pinned by the golden snapshot test in Task 1 — it must pass after every task).
- `formArchetype` must NOT read `fp.seed` and must NOT consume the generator's `rnd()` stream.
- Variant branches may consume extra `rnd()` calls only inside `if (arch...)` blocks.
- Cache version: bump every `?v=32` to `?v=33` (Task 10 only — earlier tasks leave `v=32` alone).
- All test fingerprints come from `testFingerprint(overrides)` in `test/generators.test.js`.
- Commit after every task; run `npm test` before every commit.

---

### Task 1: Golden snapshot test pinning current generator output

**Files:**
- Create: `test/snapshot.test.js`

**Interfaces:**
- Consumes: `generate(fp, params)` from `js/generators/index.js`, `testFingerprint`/`baseParams` from `test/generators.test.js`.
- Produces: a test every later task must keep green. No runtime code.

- [ ] **Step 1: Write the checksum harness (without expected values yet)**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../js/generators/index.js';
import { testFingerprint, baseParams } from './generators.test.js';

// Order-sensitive rolling hash over strided samples of a Float32Array.
// Floats are IEEE-deterministic across runs, so this pins exact output.
function checksum(arr) {
  let h = 0;
  const step = Math.max(1, Math.floor(arr.length / 20000));
  for (let i = 0; i < arr.length; i += step) {
    h = (Math.imul(h, 31) + Math.round(arr[i] * 1e5)) | 0;
  }
  return h;
}

export function modeChecksum(mode) {
  const out = generate(testFingerprint(), { ...baseParams, mode, density: 20000 });
  return [checksum(out.positions), checksum(out.attr)].join(':');
}

// GOLDEN values captured from the pre-form-families code. If a change to a
// generator breaks one of these, non-live output has drifted — that is a bug.
const GOLDEN = {
  attractor: 'FILL_ME',
  radial: 'FILL_ME',
  cymatics: 'FILL_ME',
  oscillo: 'FILL_ME',
  harmonic: 'FILL_ME',
};

for (const mode of Object.keys(GOLDEN)) {
  test(`snapshot: ${mode} output unchanged without liveVariance`, () => {
    assert.equal(modeChecksum(mode), GOLDEN[mode]);
  });
}
```

- [ ] **Step 2: Capture the real golden values**

Run:
```bash
cd ~/Documents/Github/soundform && node -e "import('./test/snapshot.test.js').then(m => { for (const mode of ['attractor','radial','cymatics','oscillo','harmonic']) console.log(mode, m.modeChecksum(mode)); })"
```
Expected: five lines like `radial -123456789:987654321` (the import also registers the tests, so the five FILL_ME failures print too — ignore them here). Paste each printed value into `GOLDEN` replacing its `FILL_ME`.

- [ ] **Step 3: Run the suite to verify it passes**

Run: `npm test`
Expected: all tests PASS, including 5 new snapshot tests.

- [ ] **Step 4: Commit**

```bash
git add test/snapshot.test.js
git commit -m "test: golden snapshots pin non-live generator output"
```

---

### Task 2: `formArchetype` selector in common.js

**Files:**
- Modify: `js/generators/common.js` (append at end)
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `formArchetype(fp) -> { index: 0|1|2, wildness: number in [0,1] }`, exported from `js/generators/common.js`. Index meaning: 0 tonal-smooth, 1 bright-piercing, 2 rough-noisy. All generator tasks (4–8) import this.

- [ ] **Step 1: Write the failing tests** (append to `test/generators.test.js`)

```js
import { formArchetype } from '../js/generators/common.js';

// Character fixtures: a sung major chord, a whistle, and plain speech.
const FP_MUSIC = () => testFingerprint(); // defaults: consonant, mid centroid
const FP_WHISTLE = () => testFingerprint({
  pitchMedian: 0.85, centroid: 0.75, spread: 0.1, consonance: 0.8,
  velocity: 0.2, noteSet: [9], noteCount: 1,
});
const FP_SPEECH = () => testFingerprint({
  pitchMedian: 0.3, centroid: 0.5, spread: 0.45, consonance: 0.3,
  velocity: 0.5, pitchConfidence: 0.3,
});

test('formArchetype: deterministic and seed-independent', () => {
  const a = formArchetype(FP_MUSIC());
  const b = formArchetype(testFingerprint({ seed: 42 })); // only seed differs
  assert.deepEqual(a, b);
});

test('formArchetype: music, whistle, speech land in distinct archetypes', () => {
  assert.equal(formArchetype(FP_MUSIC()).index, 0);   // tonal-smooth
  assert.equal(formArchetype(FP_WHISTLE()).index, 1); // bright-piercing
  assert.equal(formArchetype(FP_SPEECH()).index, 2);  // rough-noisy
});

test('formArchetype: wildness bounded and rises with dissonance', () => {
  const calm = formArchetype(FP_MUSIC()).wildness;
  const wild = formArchetype(FP_SPEECH()).wildness;
  assert.ok(calm >= 0 && calm <= 1 && wild >= 0 && wild <= 1);
  assert.ok(wild > calm);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `formArchetype` is not exported.

- [ ] **Step 3: Implement** (append to `js/generators/common.js`)

```js
// Live form-family selector: buckets the sound's CHARACTER into one of three
// archetypes (0 tonal-smooth, 1 bright-piercing, 2 rough-noisy) and derives a
// continuous wildness range-widener. Pure function of the fingerprint and
// deliberately seed-free: a steady sound keeps its archetype across morphs;
// speech vs whistle vs music land in different ones.
export function formArchetype(fp) {
  const cons = fp.consonance ?? 0.5;
  const tonal  = cons * (1 - fp.spread) * (1 - fp.centroid * 0.5);
  const bright = fp.centroid * (0.4 + 0.6 * fp.pitchMedian);
  const rough  = (1 - cons) * (0.5 + fp.spread) + fp.velocity * 0.3;
  const scores = [tonal, bright, rough];
  let index = 0;
  for (let i = 1; i < 3; i++) if (scores[i] > scores[index]) index = i;
  const wildness = Math.max(0, Math.min(1,
    0.45 * (1 - cons) + 0.3 * (fp.volVar ?? 0) + 0.25 * (fp.attackSlope ?? 0)));
  return { index, wildness };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (including snapshots — nothing calls `formArchetype` yet).

- [ ] **Step 5: Commit**

```bash
git add js/generators/common.js test/generators.test.js
git commit -m "feat(live): formArchetype character selector"
```

---

### Task 3: Timbre terms in fingerprintDelta

**Files:**
- Modify: `js/live.js:59-64` (`fingerprintDelta`)
- Test: `test/live.test.js` (append)

**Interfaces:**
- Consumes: existing `fingerprintDelta(a, b)` export in `js/live.js`.
- Produces: same signature; the returned delta now includes `0.35·|Δcentroid| + 0.25·|Δspread|`.

- [ ] **Step 1: Write the failing tests** (append to `test/live.test.js`; it already imports `fingerprintDelta` and `MORPH_THRESHOLD` — if not, add to its existing import from `../js/live.js`; fingerprint fixtures come from `testFingerprint` — add `import { testFingerprint } from './generators.test.js';` if absent)

```js
test('fingerprintDelta: timbre-only change crosses the morph threshold', () => {
  const a = testFingerprint({ centroid: 0.2, spread: 0.1 });
  const b = testFingerprint({ centroid: 0.6, spread: 0.4 }); // same notes/register
  assert.ok(fingerprintDelta(a, b) >= MORPH_THRESHOLD);
});

test('fingerprintDelta: steady speech jitter stays under threshold', () => {
  const a = testFingerprint({ consonance: 0.3, centroid: 0.5, spread: 0.45 });
  const b = testFingerprint({ consonance: 0.35, centroid: 0.55, spread: 0.4,
                              pitchMedian: 0.47, velocity: 0.45 });
  assert.ok(fingerprintDelta(a, b) < MORPH_THRESHOLD);
});
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npm test`
Expected: FAIL — timbre-only delta is 0 today (identical noteSet/pitch/consonance/velocity), so it is under the threshold.

- [ ] **Step 3: Implement** — in `js/live.js`, extend the return of `fingerprintDelta`:

```js
  return 0.45 * jaccard
       + 0.9 * Math.abs(a.pitchMedian - b.pitchMedian)
       + 0.35 * Math.abs(a.consonance - b.consonance)
       + (a.majorLeaning !== b.majorLeaning ? 0.15 : 0)
       + 0.3 * Math.abs(a.velocity - b.velocity)
       + 0.35 * Math.abs((a.centroid ?? 0) - (b.centroid ?? 0))
       + 0.25 * Math.abs((a.spread ?? 0) - (b.spread ?? 0));
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS, including all pre-existing delta threshold tests (they use fixtures with equal centroid/spread, so their values are unchanged — if any fail, the fixtures differ in timbre and their expected values need the new terms added, not weakened).

- [ ] **Step 5: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(live): fingerprintDelta hears timbre (centroid+spread)"
```

---

### Task 4: Radial form family

**Files:**
- Modify: `js/generators/radial.js`
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `formArchetype` from `./common.js`.
- Produces: `generate(fp, params)` honours `params.liveVariance`. Archetype 0 = today's tight mandala; 1 = asymmetric bloom; 2 = scattered ring field.

- [ ] **Step 1: Write the failing test** (append to `test/generators.test.js`)

```js
// Shared helper for Tasks 4-6: mean |xyz| distance between two clouds'
// sampled radial distributions — a cheap "different shape" metric.
export function shapeDistance(mode, fpA, fpB) {
  const params = { ...baseParams, mode, density: 15000, liveVariance: true };
  const a = generate(fpA, params), b = generate(fpB, params);
  const hist = (out) => {
    const h = new Float64Array(16); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(out.positions[i*3], out.positions[i*3+1], out.positions[i*3+2]);
      h[Math.min(15, Math.floor(r / 1.5 * 16))] += 1 / n;
    }
    return h;
  };
  const ha = hist(a), hb = hist(b);
  let d = 0; for (let i = 0; i < 16; i++) d += Math.abs(ha[i] - hb[i]);
  return d;
}

test('radial: live archetypes produce measurably different geometry', () => {
  assert.ok(shapeDistance('radial', FP_MUSIC(), FP_SPEECH()) > 0.15);
  assert.ok(shapeDistance('radial', FP_MUSIC(), FP_WHISTLE()) > 0.15);
  checkGenerator('radial', testFingerprint()); // sanity: no flag still valid
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test`
Expected: FAIL — without variant branches, same-seed fingerprints with different timbre produce nearly identical radial histograms (distance ≪ 0.15).

*(If it passes trivially because the fixtures differ in noteCount/volMean, tighten the fixtures: pass `noteSet/noteCount/volMean` overrides equal across FP_MUSIC/FP_SPEECH in this test only.)*

- [ ] **Step 3: Implement** — rewrite the per-shell setup block in `js/generators/radial.js`. Change the import line and the loop body's constant declarations:

```js
import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';
```

Inside `generate`, after `const rnd = mulberry32(fp.seed);` add:

```js
  const arch = params.liveVariance ? formArchetype(fp) : null;
```

Replace the shell-constant block (`const lobes ... const phase`) with `let` declarations plus the variant branch (keep the existing formulas verbatim for the base path):

```js
    const lobes = 2 + (fp.noteSet[s % fp.noteCount] % 3) + Math.round(params.complexity * 2);
    let baseR = 0.35 + tS * 0.75;
    let wobble = 0.04 + fp.pitchRange * 0.12;
    let tiltA = fp.consonance > 0.5 ? s * golden : rnd() * Math.PI * 2;
    let tiltB = fp.consonance > 0.5 ? tS * Math.PI * 0.8 : rnd() * Math.PI;
    let tubeMul = 1;
    let ox = 0, oy = 0, oz = 0;               // shell centre offset (live variants)
    if (arch && arch.index === 1) {
      // Asymmetric bloom: golden-angle order broken, shells flung off-centre,
      // wobble large — a loose organic flower instead of a tight mandala.
      tiltA = rnd() * Math.PI * 2;
      tiltB = rnd() * Math.PI;
      wobble = 0.15 + fp.pitchRange * 0.2 + arch.wildness * 0.25;
      const off = 0.12 + 0.3 * arch.wildness;
      ox = (rnd() - 0.5) * 2 * off; oy = (rnd() - 0.5) * off; oz = (rnd() - 0.5) * 2 * off;
    } else if (arch && arch.index === 2) {
      // Scattered ring field: thin detached rings drifting through the volume.
      wobble = 0.02;
      tiltA = rnd() * Math.PI * 2;
      tiltB = rnd() * Math.PI;
      baseR = 0.18 + rnd() * 0.55;
      const off = 0.25 + 0.45 * arch.wildness;
      ox = (rnd() - 0.5) * 2 * off; oy = (rnd() - 0.5) * 2 * off; oz = (rnd() - 0.5) * 2 * off;
      tubeMul = 3 + 4 * arch.wildness;
    }
    const ca = Math.cos(tiltA), sa = Math.sin(tiltA), cb = Math.cos(tiltB), sb = Math.sin(tiltB);
    const tube = (0.005 + fp.velocity * 0.008 + tS * 0.003) * tubeMul;
    const phase = fp.contour[s % 8] * Math.PI * 2;
```

And make `orbit` add the offset (strands then inherit it automatically):

```js
    const orbit = (t) => {
      const th = t * Math.PI * 2;
      const r = baseR * (1 + wobble * Math.sin(lobes * th + phase));
      const x0 = Math.cos(th) * r, y0 = Math.sin(lobes * th * 0.5 + phase) * wobble * 1.6, z0 = Math.sin(th) * r;
      const x1 = x0 * ca + z0 * sa, z1 = -x0 * sa + z0 * ca;
      return [ox + x1, oy + (y0 * cb - z1 * sb), oz + (y0 * sb + z1 * cb)];
    };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — including the radial snapshot (flag off ⇒ `arch === null`, identical rnd stream and math).

- [ ] **Step 5: Commit**

```bash
git add js/generators/radial.js test/generators.test.js
git commit -m "feat(live): radial form family — bloom + scattered rings"
```

---

### Task 5: Harmonic form family

**Files:**
- Modify: `js/generators/harmonic.js` (`generate` displacement constants + `recipe`)
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `formArchetype` from `./common.js`; `shapeDistance` helper from Task 4.
- Produces: `generate`/`recipe` honour `params.liveVariance`. Archetype 0 = smooth shell, 1 = spiky crumple (forced burst rays), 2 = open petal net (sparse mesh, waves dominant).

- [ ] **Step 1: Write the failing tests** (append to `test/generators.test.js`)

```js
test('harmonic recipe: live archetypes reshape the treatment mix', () => {
  const params = { ...baseParams, mode: 'harmonic', density: 20000, liveVariance: true };
  const spiky = recipe(FP_WHISTLE(), params);
  assert.ok(spiky.nRays >= 80, 'bright archetype forces burst rays');
  const net = recipe(FP_SPEECH(), params);
  const base = recipe(FP_SPEECH(), { ...params, liveVariance: false });
  assert.ok(net.rings < base.rings && net.lons < base.lons, 'rough archetype sparsifies the net');
});

test('harmonic: live archetypes produce measurably different geometry', () => {
  assert.ok(shapeDistance('harmonic', FP_MUSIC(), FP_WHISTLE()) > 0.12);
  checkGenerator('harmonic', testFingerprint());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `recipe` ignores `liveVariance` today (`nRays` for the whistle fixture is `Math.min(160, round(0.2*220)) = 44`... actually `velocity 0.2 > 0.12` gives 44 rays, `< 80`).

- [ ] **Step 3: Implement** — in `js/generators/harmonic.js`:

Import: `import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';`

In `recipe`, convert the returned object to a mutable and add the gate before returning:

```js
export function recipe(fp, params) {
  const N = Math.max(1000, Math.floor(params.density));
  const burstW = fp.velocity > 0.12 ? Math.min(0.20, fp.velocity * 0.22 + fp.attackSlope * 0.06) : 0;
  const dashW  = fp.spread > 0.1 ? Math.min(0.25, (fp.spread - 0.1) * 0.6) : 0;
  let rings = 24 + Math.round((params.complexity || 0.5) * 24); // 24..48
  let lons  = 16 + Math.round((params.complexity || 0.5) * 16); // 16..32
  let nRays = burstW > 0 ? Math.min(160, Math.round(fp.velocity * 220)) : 0;
  let rayPts  = nRays > 0 ? Math.floor(N * burstW) : 0;
  let dashPts = dashW > 0 ? Math.floor(N * dashW) : 0;
  if (params.liveVariance) {
    const arch = formArchetype(fp);
    if (arch.index === 1) {
      // Spiky crumple: burst rays always on, and plentiful.
      nRays = Math.max(nRays, 80 + Math.round(80 * arch.wildness));
      rayPts = Math.max(rayPts, Math.floor(N * 0.18));
    } else if (arch.index === 2) {
      // Open petal net: sparse coarse mesh so interference holes show.
      rings = Math.max(8, Math.round(rings * 0.45));
      lons = Math.max(6, Math.round(lons * 0.45));
    }
  }
  const nDashes = Math.floor(dashPts / 12); // ~12 points per stroke
  const meshPts = N - rayPts - dashPts;
  return { rings, lons, nRays, nDashes, meshPts, rayPts, dashPts };
}
```

In `generate`, after `const plan = recipe(fp, params);` add the archetype and make the displacement constants variant-aware (replace the `crumple`/`A` lines and the wave `amp`):

```js
  const arch = params.liveVariance ? formArchetype(fp) : null;
```

```js
  let waveAmpMul = 1;
  let crumple = 0.1 + fp.spread * 0.35;
  let A = 0.35 + Math.min(1, fp.volMean + fp.velocity * 0.5) * 0.4; // 0.35..0.75
  if (arch) {
    if (arch.index === 0) {        // smooth shell: near-pure Y_l^m body
      crumple *= 0.2; waveAmpMul = 0.5; A = Math.min(A, 0.45);
    } else if (arch.index === 1) { // spiky crumple: pushed far beyond caps
      crumple = (0.5 + fp.spread * 0.5) * (1.6 + 1.4 * arch.wildness);
      A = 0.75 + 0.2 * arch.wildness;
    } else {                       // open petal net: interference dominates
      crumple *= 0.6; waveAmpMul = 2.2 + 1.5 * arch.wildness;
    }
  }
```

Wave construction becomes:

```js
    waves.push({ f: (w + 1) * 0.5 + (rnd() - 0.5) * 0.8, phase: rnd() * Math.PI * 2,
                 amp: (0.9 / (w + 2)) * waveAmpMul });
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — harmonic snapshot still green (flag off ⇒ identical values; `waveAmpMul` is 1 and the `let` conversions don't change math or the rnd stream).

- [ ] **Step 5: Commit**

```bash
git add js/generators/harmonic.js test/generators.test.js
git commit -m "feat(live): harmonic form family — shell / spikes / petal net"
```

---

### Task 6: Oscillo form family

**Files:**
- Modify: `js/generators/oscillo.js`
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `formArchetype` from `./common.js`; `shapeDistance` from Task 4.
- Produces: `generate` honours `params.liveVariance`. Archetype 0 = ring mandala (today), 1 = unravelled ribbon (stacked waveform bands), 2 = shattered orbit (rings broken into scattered arcs).

- [ ] **Step 1: Write the failing test** (append to `test/generators.test.js`)

```js
test('oscillo: live archetypes produce measurably different geometry', () => {
  // Ribbon (whistle/bright) vs mandala (music/tonal) vs arcs (speech/rough).
  assert.ok(shapeDistance('oscillo', FP_MUSIC(), FP_WHISTLE()) > 0.15);
  assert.ok(shapeDistance('oscillo', FP_MUSIC(), FP_SPEECH()) > 0.12);
  checkGenerator('oscillo', testFingerprint());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — oscillo geometry today depends only on the trajectory (absent in fixtures) and seed, so the histograms nearly coincide.

- [ ] **Step 3: Implement** — in `js/generators/oscillo.js`:

Import: `import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';`

After `const rnd = mulberry32(fp.seed);` add `const arch = params.liveVariance ? formArchetype(fp) : null;`

Replace the body of the per-ring loop (keeping the existing feature reads) with a three-way branch. The base branch is today's code verbatim; the two variants replace ring placement:

```js
  for (let i = 0; i < rings; i++) {
    const t = rings === 1 ? 0 : i / (rings - 1);
    const [centroid, rms, spread, pitch] = traj ? frameAt(traj, ch, t) : [0.4, 0, 0.15, 0];
    const baseR = 0.15 + t * 0.85;
    const drive = pitch > 0 ? pitch : centroid;
    const k = Math.max(2, Math.round(4 + drive * 44)); // wave cycles per ring
    const amp = rms * 0.35 * baseR;
    const phase = rnd() * Math.PI * 2;
    const y0 = domeH * (1 - t * t) + rms * 0.15; // dome + loudness bas-relief
    const fray = spread * 0.02;

    if (arch && arch.index === 1) {
      // Unravelled ribbon: the moment becomes a straight band stacked in y —
      // the mandala unwrapped into an oscilloscope strip chart.
      const bandY = (t - 0.5) * 1.4;
      const waveAmp = 0.06 + (amp * 3 + drive * 0.15) * (1 + arch.wildness);
      const wave = (x) => waveAmp * Math.sin(k * (x + 1) * Math.PI + phase);
      for (let p = 0; p < perRing; p++) {
        const x = rnd() * 2 - 1;
        positions[w * 3]     = x * 1.1 + (rnd() - 0.5) * jit;
        positions[w * 3 + 1] = bandY + (rnd() - 0.5) * (jit + fray);
        positions[w * 3 + 2] = wave(x) + (rnd() - 0.5) * (jit + fray * 2);
        attr[w] = Math.max(0, Math.min(1, 0.25 + rms * 2.2));
        w++;
      }
      const raw = new Float32Array(256 * 3);
      for (let s = 0; s < 256; s++) {
        const x = (s / 255) * 2 - 1;
        raw[s * 3] = x * 1.1; raw[s * 3 + 1] = bandY; raw[s * 3 + 2] = wave(x);
      }
      strands.push(resamplePolyline(raw, 200));
    } else if (arch && arch.index === 2) {
      // Shattered orbit: the ring survives only as 2-5 scattered arcs,
      // each tilted and radially displaced.
      const nArcs = 2 + Math.floor(rnd() * 4);
      const arcs = [];
      for (let aI = 0; aI < nArcs; aI++) {
        arcs.push({ a0: rnd() * Math.PI * 2, len: (0.15 + rnd() * 0.35) * Math.PI });
      }
      const rOff = (rnd() - 0.5) * (0.15 + 0.35 * arch.wildness);
      const tilt = (rnd() - 0.5) * (0.6 + 0.8 * arch.wildness);
      const ringR = (ang) => baseR + rOff + amp * Math.sin(k * ang + phase);
      for (let p = 0; p < perRing; p++) {
        const arc = arcs[Math.floor(rnd() * nArcs)];
        const ang = arc.a0 + rnd() * arc.len;
        const r = ringR(ang) + (rnd() - 0.5) * fray;
        positions[w * 3]     = r * Math.cos(ang) + (rnd() - 0.5) * jit;
        positions[w * 3 + 1] = y0 + Math.sin(ang) * tilt * 0.3 + (rnd() - 0.5) * (jit + fray * 0.5);
        positions[w * 3 + 2] = r * Math.sin(ang) + (rnd() - 0.5) * jit;
        attr[w] = Math.max(0, Math.min(1, 0.25 + rms * 2.2));
        w++;
      }
      const arc0 = arcs[0];
      const raw = new Float32Array(128 * 3);
      for (let s = 0; s < 128; s++) {
        const ang = arc0.a0 + (s / 127) * arc0.len;
        const r = ringR(ang);
        raw[s * 3] = r * Math.cos(ang);
        raw[s * 3 + 1] = y0 + Math.sin(ang) * tilt * 0.3;
        raw[s * 3 + 2] = r * Math.sin(ang);
      }
      strands.push(resamplePolyline(raw, 200));
    } else {
      // Ring mandala — today's code, verbatim.
      const ringR = (ang) => baseR + amp * Math.sin(k * ang + phase);
      for (let p = 0; p < perRing; p++) {
        const ang = rnd() * Math.PI * 2;
        const r = ringR(ang) + (rnd() - 0.5) * fray;
        positions[w * 3]     = r * Math.cos(ang) + (rnd() - 0.5) * jit;
        positions[w * 3 + 1] = y0 + (rnd() - 0.5) * (jit + fray * 0.5);
        positions[w * 3 + 2] = r * Math.sin(ang) + (rnd() - 0.5) * jit;
        attr[w] = Math.max(0, Math.min(1, 0.25 + rms * 2.2));
        w++;
      }
      const raw = new Float32Array(256 * 3);
      for (let s = 0; s < 256; s++) {
        const ang = (s / 255) * Math.PI * 2;
        const r = ringR(ang);
        raw[s * 3] = r * Math.cos(ang); raw[s * 3 + 1] = y0; raw[s * 3 + 2] = r * Math.sin(ang);
      }
      strands.push(resamplePolyline(raw, 200));
    }
    if (onProgress && i % 16 === 0) onProgress(i / rings);
  }
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — oscillo snapshot green (base branch verbatim, same rnd order).

- [ ] **Step 5: Commit**

```bash
git add js/generators/oscillo.js test/generators.test.js
git commit -m "feat(live): oscillo form family — ribbon + shattered orbit"
```

---

### Task 7: Cymatics — sound-selected style + wildness

**Files:**
- Modify: `js/generators/cymatics.js`
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `formArchetype` from `./common.js`.
- Produces: with `liveVariance` and `cymStyle === 'auto'` (or unset), style is archetype-mapped: tonal→`relief`, bright→`scope`, rough→`sand`; `wild` scales with `1 + wildness`. Explicit `cymStyle` still wins.

- [ ] **Step 1: Write the failing test** (append to `test/generators.test.js`) — style is internal, so assert via geometry: `sand` output is flat (tiny y-extent) while `relief` has visible relief. Speech (rough → sand) vs music (tonal → relief) with identical seeds:

```js
test('cymatics: live auto style follows the sound character', () => {
  const params = { ...baseParams, mode: 'cymatics', density: 15000,
                   liveVariance: true, cymStyle: 'auto' };
  const ySpan = (out) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 1; i < out.positions.length; i += 3) {
      lo = Math.min(lo, out.positions[i]); hi = Math.max(hi, out.positions[i]);
    }
    return hi - lo;
  };
  const sandy = generate(FP_SPEECH(), params);   // rough → sand: flat plate
  const relief = generate(FP_MUSIC(), params);   // tonal → relief: raised
  assert.ok(ySpan(sandy) < ySpan(relief) * 0.6, 'sand is flat, relief is raised');
  // Explicit style still wins over the archetype.
  const forced = generate(FP_SPEECH(), { ...params, cymStyle: 'relief' });
  assert.ok(ySpan(forced) > ySpan(sandy), 'explicit cymStyle overrides archetype');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — today auto style comes from `fp.seed % 3` (seed 123456789 % 3 = 0 → 'scope' for both fixtures), so the spans don't separate as asserted. *(If it passes by luck, force it: assert the exact pairing by also checking `ySpan(sandy) < 0.15` — sand y is ±0.012 pre-normalization.)*

- [ ] **Step 3: Implement** — in `js/generators/cymatics.js`:

Import: `import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';`

After `const rnd = mulberry32(fp.seed);` add `const arch = params.liveVariance ? formArchetype(fp) : null;`

Replace the `wild` line:

```js
  const wild = (0.5 + (1 - (fp.consonance ?? 0.5))) * (arch ? 1 + arch.wildness : 1);
```

Replace the style pick:

```js
  const STYLES = ['scope', 'sand', 'relief'];
  const ARCH_STYLE = ['relief', 'scope', 'sand']; // tonal, bright, rough
  const style = STYLES.includes(params.cymStyle) ? params.cymStyle
              : arch ? ARCH_STYLE[arch.index]
              : STYLES[fp.seed % 3];
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — cymatics snapshot green (no flag ⇒ `arch === null` ⇒ both lines reduce to today's expressions).

- [ ] **Step 5: Commit**

```bash
git add js/generators/cymatics.js test/generators.test.js
git commit -m "feat(live): cymatics auto style follows sound character"
```

---

### Task 8: Attractor wildness + graceful exhaustion fallback

**Files:**
- Modify: `js/generators/attractor.js` (`generate`)
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `formArchetype` from `./common.js`.
- Produces: with `liveVariance`, coefficient excursion range and turbulence jitter widen with wildness; if all 8 retries degenerate, it retries once without the flag instead of throwing.

- [ ] **Step 1: Write the failing test** (append to `test/generators.test.js`)

```js
test('attractor: liveVariance output valid and differs from non-live', () => {
  const fp = FP_SPEECH(); // high wildness
  const live = generate(fp, { ...baseParams, density: 15000, liveVariance: true });
  const base = generate(fp, { ...baseParams, density: 15000 });
  const { maxAbs, std } = (() => {
    let m = 0; const n = live.positions.length / 3; let s = 0;
    for (let i = 0; i < live.positions.length; i++) m = Math.max(m, Math.abs(live.positions[i]));
    for (let i = 0; i < n; i++) s += live.positions[i * 3] ** 2 / n;
    return { maxAbs: m, std: Math.sqrt(s) };
  })();
  assert.ok(maxAbs <= 2.5 && std > 0.05, 'live attractor stays valid');
  let diff = 0;
  const n = Math.min(live.positions.length, base.positions.length);
  for (let i = 0; i < n; i += 300) diff += Math.abs(live.positions[i] - base.positions[i]);
  assert.ok(diff > 0.5, 'live coefficients actually shift the trajectory');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL on the `diff` assertion — without the flag branch, both calls produce identical positions (diff = 0).

- [ ] **Step 3: Implement** — in `js/generators/attractor.js`:

Import: `import { mulberry32, finalize, resamplePolyline, formArchetype } from './common.js';`

In `generate`, after `const sys = SYSTEMS[name];` add and adjust:

```js
  const arch = params.liveVariance ? formArchetype(fp) : null;
  const rnd = mulberry32(fp.seed);
  const jitter = fp.velocity * 0.012 * (0.5 + params.complexity) * (arch ? 1 + arch.wildness : 1);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const excursion = 0.5 + params.complexity; // complexity widens coefficient excursion
  const exSpread = arch ? 0.06 * arch.wildness : 0; // live widens the range itself
```

Inside the retry loop, replace the coefficient excursion line:

```js
    if (sys.flow) for (const key of Object.keys(c)) {
      if (typeof c[key] === 'number' && key !== 'e') {
        c[key] = c[key] * lerp(0.92 - exSpread, 1.08 + exSpread, ((excursion * 7 + attempt) % 1));
      }
    }
```

Replace the final `throw` with a graceful live fallback:

```js
  if (arch) return generate(fp, { ...params, liveVariance: false }, onProgress);
  throw new Error('attractor: all retries degenerate');
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — attractor snapshot green (`arch === null` ⇒ jitter/excursion identical, `exSpread` 0).

- [ ] **Step 5: Commit**

```bash
git add js/generators/attractor.js test/generators.test.js
git commit -m "feat(live): attractor wildness widening + graceful fallback"
```

---

### Task 9: LiveConductor sends the flag

**Files:**
- Modify: `js/live.js:152-155` (the `generate` call in `tick`)
- Test: `test/live.test.js` (append)

**Interfaces:**
- Consumes: nothing new (the flag rides the existing opaque params object through `liveGenerate` → worker/inline `generate`).
- Produces: every live structural morph carries `liveVariance: true`.

- [ ] **Step 1: Write the failing test** — `test/live.test.js` already has a `harness({ frame, genDelay })` factory (line ~65) whose conductor uses a stub `generate`. First make the stub overridable — change the `harness` signature and its `generate:` line:

```js
function harness({ frame = mkFrame(), genDelay = 0, generate = null } = {}) {
  ...
    generate: generate ?? (async () => ({ positions: new Float32Array(3), attr: new Float32Array(1), strands: [] })),
  ...
```

(Keep the rest of `harness` untouched; if `genDelay` is used inside the default stub, wrap the override the same way.) Then append:

```js
test('conductor: structural regen requests carry liveVariance', async () => {
  let seenParams = null;
  const { conductor } = harness({
    generate: async (fp, p) => {
      seenParams = p;
      return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] };
    },
  });
  for (let i = 0; i < 70; i++) conductor.tick(i / 30); // ~2.3s steady sound → 1 morph
  await new Promise(r => setImmediate(r));
  assert.ok(seenParams, 'a regen fired');
  assert.equal(seenParams.liveVariance, true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test`
Expected: FAIL — `seenParams.liveVariance` is `undefined`.

- [ ] **Step 3: Implement** — in `js/live.js` `tick()`:

```js
    this.generate(fp, { mode: p.mode, density: p.liveDensity, complexity: p.complexity,
                        symmetry: p.symmetry, twist: p.twist, strandCount: 96,
                        cymStyle: p.cymStyle, liveVariance: true })
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/live.js test/live.test.js
git commit -m "feat(live): conductor requests form-family variance"
```

---

### Task 10: Cymatics-style row visibility + cache bump v=33

**Files:**
- Modify: `index.html` (cym-style row id; all `?v=32` refs)
- Modify: `js/main.js` (visibility helper + mode handler; worker URLs + imports `?v=32`)
- Modify: `js/live.js`, `js/worker.js`, any other `?v=32` imports

**Interfaces:**
- Consumes: `.btn-mode` click handler in `js/main.js` (`bindControls`), `params.mode`.
- Produces: `#row-cym-style` visible only when `params.mode === 'cymatics'`; all module/asset URLs at `?v=33`.

*(No node test — this is DOM code exercised by the manual browser acceptance pass.)*

- [ ] **Step 1: Add the row id** — in `index.html`, change the wrapper of the style select:

```html
      <div class="sl-row" id="row-cym-style" style="display:none">
        <select id="sel-cym-style">
```

(`display:none` initial state matches the default `attractor` mode.)

- [ ] **Step 2: Toggle on mode switch** — in `js/main.js` `bindControls()`, extend the `.btn-mode` click handler:

```js
      params.mode = btn.dataset.mode;
      document.querySelectorAll('.btn-mode').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('row-cym-style').style.display =
        params.mode === 'cymatics' ? '' : 'none';
      if (appState === 'captured') regenerate();
      else if (appState === 'live' && conductor) conductor.forceMorph();
```

- [ ] **Step 3: Bump the cache version everywhere**

Run:
```bash
cd ~/Documents/Github/soundform && grep -rl 'v=32' index.html js/ | xargs sed -i '' 's/v=32/v=33/g' && grep -rn 'v=32' index.html js/ | wc -l
```
Expected: final count `0`.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add index.html js/
git commit -m "fix(ui): cymatics style row only in cymatics mode; bump cache to v=33"
```

---

## Manual browser acceptance (after all tasks)

Serve locally (`python3 -m http.server` in the repo root, open `localhost:8000`) and verify:

1. Live session: whistling vs speaking vs playing music produce **visibly different forms** in each mode (radial: mandala/bloom/scattered rings; harmonic: shell/spikes/net; oscillo: mandala/ribbon/arcs; cymatics: relief/scope/sand).
2. Capture (✓) still lands in the normal captured state; a captured design looks like today's captures (no live variance).
3. "Cymatics style" row appears only in Cymatics mode, in and out of live.
4. No `v=32` requests in DevTools Network.
