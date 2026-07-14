# Harmonic Organic Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the harmonic generator so designs are organic petal wireframes with audio-driven variance (mesh net / burst rays / dash fray) instead of smooth symmetric vases.

**Architecture:** All changes live in `js/generators/harmonic.js` + its tests. Three additions: a seeded 3D value-noise factory, a pure `recipe(fp, params)` function that computes treatment allocation (testable without generating), and a rewritten `generate()` whose displacement stacks Yₗᵐ backbone + interference waves + noise crumple, and whose point budget splits mesh/bursts/dashes per the recipe.

**Tech Stack:** Vanilla ES modules, node:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-14-harmonic-organic-redesign-design.md`

## Global Constraints

- Only `js/generators/harmonic.js` and `test/generators.test.js` change. NEVER touch `js/generators/attractor.js`, `js/generators/cymatics.js`, or `js/density.js`.
- Deterministic: all randomness from `mulberry32(fp.seed)`; same fingerprint → identical output.
- Generator contract: `generate(fp, params, onProgress)` → `{ positions, attr, strands }`; point count ≥ `params.density * 0.5`; `attr` values in [0,1]; ≥24 strands; bounded (`maxAbs ≤ 2.5` post-normalization); finite.
- Mesh always ≥ 55% of the point budget (weight caps: bursts ≤ 0.20, dashes ≤ 0.25).
- Dash strands in the strand list capped at 150 (SVG ≤ ~1MB).
- Current cache version is `?v=26`; bump to `?v=27` at ship (Task 3).
- Work on branch `harmonic-organic`; merge to `main` only after the user approves the look (Pages serves main live).
- Tests: `npm test` — all 46 existing tests must keep passing except the ones this plan explicitly replaces.

---

### Task 0: Branch

- [ ] **Step 1:** `cd ~/Documents/Github/soundform && git checkout -b harmonic-organic`

---

### Task 1: Seeded value noise + treatment recipe (pure functions)

**Files:**
- Modify: `js/generators/harmonic.js` (append two exported factories; existing code untouched in this task)
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `mulberry32` (already imported in harmonic.js).
- Produces:
  - `makeValueNoise3(rnd)` → `{ noise(x,y,z) → [0,1], fractal(x,y,z) → [0,1] }` — seeded, deterministic, finite everywhere (incl. negative coords).
  - `recipe(fp, params)` → `{ rings, lons, nRays, nDashes, meshPts, rayPts, dashPts }` — pure allocation used by Task 2's `generate()` and asserted directly by tests.

- [ ] **Step 1: Write the failing tests**

Append to `test/generators.test.js` (extend the existing harmonic import):

```js
// change the existing import line:
import { sphericalY, makeValueNoise3, recipe } from '../js/generators/harmonic.js';
import { mulberry32 } from '../js/generators/common.js';
```

```js
test('harmonic value noise: deterministic, bounded, finite at negatives', () => {
  const a = makeValueNoise3(mulberry32(7));
  const b = makeValueNoise3(mulberry32(7));
  for (const [x, y, z] of [[0.3, 1.7, -2.4], [-9.1, 0.01, 4.4], [100.5, -50.2, 0]]) {
    const v = a.fractal(x, y, z);
    assert.equal(v, b.fractal(x, y, z), 'seeded noise must be deterministic');
    assert.ok(v >= 0 && v <= 1 && Number.isFinite(v), `out of range: ${v}`);
  }
  const c = makeValueNoise3(mulberry32(8));
  assert.notEqual(a.fractal(0.3, 1.7, -2.4), c.fractal(0.3, 1.7, -2.4), 'different seeds differ');
});

test('harmonic recipe: percussive audio gets rays, sustained gets none', () => {
  const perc = recipe(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), baseParams);
  assert.ok(perc.nRays > 20, `expected rays, got ${perc.nRays}`);
  const hum = recipe(testFingerprint({ velocity: 0.05, attackSlope: 0.1 }), baseParams);
  assert.equal(hum.nRays, 0, 'sustained hum must have no rays');
});

test('harmonic recipe: noisy timbre gets dashes, pure tone stays mesh', () => {
  const noisy = recipe(testFingerprint({ spread: 0.8 }), baseParams);
  assert.ok(noisy.nDashes > 50, `expected dashes, got ${noisy.nDashes}`);
  const pure = recipe(testFingerprint({ spread: 0.05 }), baseParams);
  assert.equal(pure.nDashes, 0, 'pure tone must have no dashes');
});

test('harmonic recipe: mesh always keeps ≥55% of the point budget', () => {
  const worst = recipe(testFingerprint({ velocity: 1, attackSlope: 1, spread: 1 }), baseParams);
  assert.ok(worst.meshPts >= baseParams.density * 0.55, `mesh starved: ${worst.meshPts}`);
  assert.ok(worst.rings >= 24 && worst.rings <= 48);
  assert.ok(worst.lons >= 16 && worst.lons <= 32);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "✖|^ℹ fail"`
Expected: FAIL — `makeValueNoise3`/`recipe` not exported.

- [ ] **Step 3: Implement the two factories**

Append to `js/generators/harmonic.js`:

```js
// Seeded 3D value noise: 256-permutation lattice + trilinear interpolation,
// 3 fractal octaves. DOM-free and deterministic per rnd stream — this is the
// "crumple" that roughens the displacement into a hand-drawn edge.
export function makeValueNoise3(rnd) {
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rnd();
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const latt = (X, Y, Z) => vals[perm[(perm[(perm[X & 255] + (Y & 255)) & 255] + (Z & 255)) & 255]];
  const smooth = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const noise = (x, y, z) => {
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    const fx = smooth(x - X), fy = smooth(y - Y), fz = smooth(z - Z);
    return lerp(
      lerp(lerp(latt(X, Y, Z),     latt(X + 1, Y, Z),     fx),
           lerp(latt(X, Y + 1, Z), latt(X + 1, Y + 1, Z), fx), fy),
      lerp(lerp(latt(X, Y, Z + 1),     latt(X + 1, Y, Z + 1),     fx),
           lerp(latt(X, Y + 1, Z + 1), latt(X + 1, Y + 1, Z + 1), fx), fy),
      fz);
  };
  const fractal = (x, y, z) =>
    (noise(x, y, z) + 0.5 * noise(x * 2 + 17.3, y * 2 + 17.3, z * 2 + 17.3)
                    + 0.25 * noise(x * 4 + 43.7, y * 4 + 43.7, z * 4 + 43.7)) / 1.75;
  return { noise, fractal };
}

// Treatment allocation: how the density budget splits between the mesh
// backbone (always ≥55%), percussion-driven burst rays, and noise-driven
// dash fray. Pure so tests can assert the mix without generating geometry.
export function recipe(fp, params) {
  const N = Math.max(1000, Math.floor(params.density));
  const burstW = fp.velocity > 0.12 ? Math.min(0.20, fp.velocity * 0.22 + fp.attackSlope * 0.06) : 0;
  const dashW  = fp.spread > 0.15 ? Math.min(0.25, (fp.spread - 0.15) * 0.45) : 0;
  const rings = 24 + Math.round((params.complexity || 0.5) * 24); // 24..48
  const lons  = 16 + Math.round((params.complexity || 0.5) * 16); // 16..32
  const nRays = burstW > 0 ? Math.min(120, Math.round(fp.velocity * 150)) : 0;
  const rayPts  = nRays > 0 ? Math.floor(N * burstW) : 0;
  const dashPts = dashW > 0 ? Math.floor(N * dashW) : 0;
  const nDashes = Math.floor(dashPts / 12); // ~12 points per stroke
  const meshPts = N - rayPts - dashPts;
  return { rings, lons, nRays, nDashes, meshPts, rayPts, dashPts };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: PASS, 50 tests (46 + 4 new).

- [ ] **Step 5: Commit**

```bash
git add js/generators/harmonic.js test/generators.test.js
git commit -m "feat(harmonic): seeded value noise + treatment recipe

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rewrite generate() — organic deformation + treatment geometry

**Files:**
- Modify: `js/generators/harmonic.js` (replace `generate()`; keep `sphericalY`, `legendreP`, `factorialRatio`, `makeValueNoise3`, `recipe`)
- Test: `test/generators.test.js` (append 2 tests; existing harmonic tests must keep passing)

**Interfaces:**
- Consumes: `recipe(fp, params)`, `makeValueNoise3(rnd)`, `sphericalY(l, m, theta, phi, phase)` from Task 1; `mulberry32`, `finalize`, `resamplePolyline` from `./common.js`.
- Produces: `generate(fp, params, onProgress)` — same contract as every generator.

- [ ] **Step 1: Write the failing tests**

Append to `test/generators.test.js`:

```js
test('harmonic generate: percussive fp emits ray strands beyond the mesh', () => {
  const params = { ...baseParams, mode: 'harmonic' };
  const perc = generate(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), params);
  const hum = generate(testFingerprint({ velocity: 0.05, attackSlope: 0.1 }), params);
  const plan = recipe(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), params);
  assert.equal(perc.strands.length - hum.strands.length >= plan.nRays - 5, true,
    `ray strands missing: perc=${perc.strands.length} hum=${hum.strands.length} rays=${plan.nRays}`);
});

test('harmonic generate: organic — no rotational symmetry', () => {
  // The old vase was near-symmetric under φ → φ + π. Interference + noise
  // must break that: sample the displacement via strand radii at opposite φ.
  const out = generate(testFingerprint(), { ...baseParams, mode: 'harmonic' });
  const s = out.strands[Math.floor(out.strands.length / 4)]; // a mid-latitude ring
  const n = s.length / 3;
  let asym = 0;
  for (let i = 0; i < n / 2; i++) {
    const j = i + Math.floor(n / 2);
    const ri = Math.hypot(s[i * 3], s[i * 3 + 1], s[i * 3 + 2]);
    const rj = Math.hypot(s[j * 3], s[j * 3 + 1], s[j * 3 + 2]);
    asym += Math.abs(ri - rj);
  }
  assert.ok(asym / (n / 2) > 0.02, `form too symmetric (asym=${(asym / (n / 2)).toFixed(4)})`);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -E "✖|^ℹ fail"`
Expected: FAIL — old generate has no rays (first test) and is φ-symmetric apart from jitter (second may fail or scrape by; if it passes pre-rewrite, tighten the threshold to 0.03 and re-verify it fails).

- [ ] **Step 3: Replace `generate()` in `js/generators/harmonic.js`**

Replace the entire existing `export function generate(...)` with:

```js
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const plan = recipe(fp, params);

  // ── Displacement field: Y_l^m backbone + interference waves + crumple ──
  const lMain = 3 + Math.round(fp.pitchMedian * 6); // pitch → dominant degree
  const nComp = Math.max(1, Math.min(4, 1 + Math.round(fp.volVar * 2 + fp.attackSlope)));
  const comps = [];
  for (let c = 0; c < nComp; c++) {
    const l = Math.max(2, Math.min(10, lMain + (c === 0 ? 0 : Math.round((rnd() - 0.5) * 4))));
    const m = fp.noteSet[c % fp.noteCount] % (l + 1);
    const phase = fp.chroma[(c * 5) % 12] * Math.PI * 2 + rnd() * 0.5;
    comps.push({ l, m, phase, amp: 0.5 / (c + 1) });
  }
  const nWaves = 3 + Math.round(Math.min(1, fp.volVar + fp.velocity) * 3); // 3..6
  const waves = [];
  for (let w = 0; w < nWaves; w++) {
    waves.push({ f: (w + 1) * 0.5 + (rnd() - 0.5) * 0.4, phase: rnd() * Math.PI * 2, amp: 0.6 / (w + 2) });
  }
  const vnoise = makeValueNoise3(rnd);
  const crumple = 0.05 + fp.spread * 0.25;
  const A = 0.25 + Math.min(1, fp.volMean + fp.velocity * 0.5) * 0.3; // 0.25..0.55

  const disp = (theta, phi) => {
    let d = 0;
    for (const c of comps) d += c.amp * sphericalY(c.l, c.m, theta, phi, c.phase);
    for (const w of waves) d += w.amp * Math.sin(w.f * phi * 3 + w.f * theta * 2 + w.phase);
    const st = Math.sin(theta);
    d += (vnoise.fractal(st * Math.cos(phi) * 2.5, Math.cos(theta) * 2.5, st * Math.sin(phi) * 2.5) - 0.5) * crumple * 6;
    return d * A;
  };
  const surf = (theta, phi) => {
    const r = Math.max(0.05, 1 + disp(theta, phi));
    const st = Math.sin(theta);
    return [r * st * Math.cos(phi), r * Math.cos(theta), r * st * Math.sin(phi)];
  };

  const total = plan.meshPts + plan.rayPts + plan.dashPts;
  const positions = new Float32Array(total * 3);
  const attr = new Float32Array(total);
  const strands = [];
  const jit = 0.0035;
  let w = 0;
  const push = (x, y, z, a) => {
    positions[w * 3]     = x + (rnd() - 0.5) * jit;
    positions[w * 3 + 1] = y + (rnd() - 0.5) * jit;
    positions[w * 3 + 2] = z + (rnd() - 0.5) * jit;
    attr[w] = a;
    w++;
  };
  const meshAttr = (theta, phi) =>
    Math.max(0, Math.min(1, 0.45 + disp(theta, phi) * 1.2));

  // ── Mesh net: coarse lat rings + lon lines, points along the lines ──
  const lines = plan.rings + plan.lons;
  const perLine = Math.floor(plan.meshPts / lines);
  const ringStrand = (fixed, isLat) => {
    const raw = new Float32Array(200 * 3);
    for (let s = 0; s < 200; s++) {
      const t = s / 199;
      const theta = isLat ? fixed : t * Math.PI;
      const phi = isLat ? t * Math.PI * 2 : fixed;
      const [x, y, z] = surf(theta, phi);
      raw[s * 3] = x; raw[s * 3 + 1] = y; raw[s * 3 + 2] = z;
    }
    return raw;
  };
  for (let i = 0; i < plan.rings; i++) {
    const theta = ((i + 0.5) / plan.rings) * Math.PI;
    for (let k = 0; k < perLine; k++) {
      const phi = rnd() * Math.PI * 2;
      const [x, y, z] = surf(theta, phi);
      push(x, y, z, meshAttr(theta, phi));
    }
    strands.push(ringStrand(theta, true));
    if (onProgress && i % 8 === 0) onProgress(i / lines);
  }
  for (let j = 0; j < plan.lons; j++) {
    const phi = (j / plan.lons) * Math.PI * 2;
    for (let k = 0; k < perLine; k++) {
      const theta = rnd() * Math.PI;
      const [x, y, z] = surf(theta, phi);
      push(x, y, z, meshAttr(theta, phi));
    }
    strands.push(ringStrand(phi, false));
  }
  // Spend any floor() remainder on extra mesh points along random rings
  while (w < plan.meshPts) {
    const theta = rnd() * Math.PI, phi = rnd() * Math.PI * 2;
    const [x, y, z] = surf(theta, phi);
    push(x, y, z, meshAttr(theta, phi));
  }

  // ── Burst rays: faint straight spikes from the centre through the form ──
  if (plan.nRays > 0) {
    const perRay = Math.max(4, Math.floor(plan.rayPts / plan.nRays));
    for (let r = 0; r < plan.nRays && w + perRay <= total; r++) {
      const u = rnd() * 2 - 1, az = rnd() * Math.PI * 2;
      const s2 = Math.sqrt(Math.max(0, 1 - u * u));
      const dir = [s2 * Math.cos(az), u, s2 * Math.sin(az)];
      const theta = Math.acos(u), phi = Math.atan2(dir[2], dir[0]);
      const end = Math.min(2.2, Math.max(0.4, 1 + disp(theta, phi)) * (1.2 + rnd() * 0.4));
      for (let k = 0; k < perRay; k++) {
        const t = 0.08 + (k / (perRay - 1)) * (end - 0.08);
        push(dir[0] * t, dir[1] * t, dir[2] * t, 0.15);
      }
      const ray = new Float32Array(8 * 3);
      for (let s = 0; s < 8; s++) {
        const t = 0.08 + (s / 7) * (end - 0.08);
        ray[s * 3] = dir[0] * t; ray[s * 3 + 1] = dir[1] * t; ray[s * 3 + 2] = dir[2] * t;
      }
      strands.push(ray);
    }
  }

  // ── Dash field: short surface-following strokes (noisy-timbre fray) ──
  if (plan.nDashes > 0) {
    let dashStrandsAdded = 0;
    for (let dIdx = 0; dIdx < plan.nDashes && w + 12 <= total; dIdx++) {
      const theta = Math.acos(rnd() * 2 - 1), phi = rnd() * Math.PI * 2;
      const [px, py, pz] = surf(theta, phi);
      const pr = Math.hypot(px, py, pz) || 1;
      const nx = px / pr, ny = py / pr, nz = pz / pr;
      const rv = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
      const dot = rv[0] * nx + rv[1] * ny + rv[2] * nz;
      let tx = rv[0] - dot * nx, ty = rv[1] - dot * ny, tz = rv[2] - dot * nz;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const L = 0.05 + rnd() * 0.07;
      for (let k = 0; k < 12; k++) {
        const t = (k / 11 - 0.5) * L;
        push(px + tx * t, py + ty * t, pz + tz * t, 0.45);
      }
      if (dashStrandsAdded < 150) {
        const dash = new Float32Array(2 * 3);
        dash[0] = px - tx * L / 2; dash[1] = py - ty * L / 2; dash[2] = pz - tz * L / 2;
        dash[3] = px + tx * L / 2; dash[4] = py + ty * L / 2; dash[5] = pz + tz * L / 2;
        strands.push(dash);
        dashStrandsAdded++;
      }
    }
  }

  // Trim to points actually written (ray/dash loops guard the budget)
  const outPos = w === total ? positions : positions.slice(0, w * 3);
  const outAttr = w === total ? attr : attr.slice(0, w);
  const resampled = strands.map(s => s.length === 6 ? s : resamplePolyline(s, 200));
  return finalize(outPos, outAttr, resampled, params);
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test 2>&1 | grep -E "✖|^ℹ (tests|pass|fail)"`
Expected: PASS, 52 tests. If `harmonic generator: bounded…` fails on maxAbs: reduce the ray `end` cap from 2.2 to 2.0. If it fails on point count: check the `while (w < plan.meshPts)` top-up ran.

- [ ] **Step 5: Commit**

```bash
git add js/generators/harmonic.js test/generators.test.js
git commit -m "feat(harmonic): organic interference deformation + mesh/burst/dash treatments

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Look-check + ship

**Files:**
- Modify: cache-bust references (`index.html`, `style.css`, `js/*`) v=26 → v=27

- [ ] **Step 1: Serve locally and get user approval (REQUIRED — aesthetic change)**

```bash
cd ~/Documents/Github/soundform && python3 -m http.server 8765 &
```
Ask the user to create designs from at least: a sung/hummed note (expect near-pure clean mesh, organic petal outline), a percussive sound (expect mesh + ray fan), a breathy/hissy sound (expect frayed mesh with dashes). **Do not merge until the user approves.** Tune amplitude/weights on their feedback (constants: `A` range, `crumple`, `burstW`/`dashW` caps in `recipe`).

- [ ] **Step 2: Bump cache version**

```bash
grep -rl 'v=26' index.html style.css js | xargs sed -i '' 's/v=26/v=27/g'
grep -rn 'v=26' index.html style.css js | wc -l   # expect 0
npm test 2>&1 | tail -3
```

- [ ] **Step 3: Commit, merge, push (after user approval)**

```bash
git add -A && git commit -m "chore: bump cache to v=27

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git checkout main && git merge harmonic-organic
npm test 2>&1 | tail -3   # verify on merged result
git push && git branch -d harmonic-organic
```

- [ ] **Step 4: Verify live**

```bash
curl -s "https://mickydoit.github.io/soundform/?nocache=$(date +%s)" | grep -o 'v=27' | head -1
```
Expected: `v=27`.

---

## Final verification

- [ ] `npm test` — 52 tests pass.
- [ ] User confirms: harmonic designs are organic/petal-like with visible variance across sound types; other modes unchanged.
- [ ] SVG export of a bursty design opens with mesh rings + ray lines as separate paths.
