# Harmonic Mode, Design Animation & MP4 Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a spherical-harmonics wireframe generator mode, GPU-side seamless-loop design animation with play/pause + speed controls, and deterministic MP4 export.

**Architecture:** Feature 1 is a pure-addition generator (`js/generators/harmonic.js`) plugged into the existing registry, plus three muted palettes. Feature 2 adds a displacement term to the splat vertex shader in `js/density.js` (additive only — `uAmp` defaults to 0 so static rendering stays pixel-identical), mirrored by a pure-JS twin in `js/motion.js` used for SVG export. Feature 3 renders loop frames offscreen via the existing `renderHiRes` path and encodes with WebCodecs `VideoEncoder` + vendored mp4-muxer.

**Tech Stack:** Vanilla ES modules (no build step), THREE.js r134 (CDN), node:test, WebCodecs, mp4-muxer (vendored UMD).

**Spec:** `docs/superpowers/specs/2026-07-13-harmonic-animation-mp4-design.md`

## Global Constraints

- **NEVER modify** `js/generators/attractor.js` or `js/generators/cymatics.js` (user-locked).
- `js/density.js` changes must be **additive**: with motion never enabled (`uAmp == 0.0`), rendering must be pixel-identical to current output.
- No build step. External libraries are vendored single files (pattern: jsPDF via script tag).
- Determinism: same fingerprint → identical geometry and identical motion.
- Motion defaults **off**; existing designs/share links unchanged until user presses play.
- Muted palettes (soft/pastel, not neon — user preference): exact hex values in Task 2.
- Cache-bust: current version is `?v=22`. Bump at each feature boundary (Tasks 2, 5, 8) with the sed command given there.
- Tests: `npm test` (node:test). All 35 existing tests must keep passing.
- Repo: `~/Documents/Github/soundform`, work on `main` (solo project, existing convention).

---

### Task 1: Harmonic generator

**Files:**
- Create: `js/generators/harmonic.js`
- Modify: `js/generators/index.js` (registry, ~lines 1–8)
- Modify: `index.html:70` (mode button after Timbre)
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `mulberry32`, `finalize`, `resamplePolyline` from `./common.js`; fingerprint fields `seed, pitchMedian, volVar, attackSlope, noteSet, noteCount, chroma, velocity`; params `density, complexity, symmetry, twist, strandCount`.
- Produces: `generate(fp, params, onProgress)` → `{ positions: Float32Array, attr: Float32Array, strands: Float32Array[] }` (same contract as every generator); named export `sphericalY(l, m, theta, phi, phase)` for tests.

- [ ] **Step 1: Write the failing tests**

Append to `test/generators.test.js`:

```js
import { sphericalY } from '../js/generators/harmonic.js';

test('harmonic generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('harmonic');
});

test('harmonic: sphericalY known values', () => {
  // Y_0^0 = 1/(2√π) everywhere
  assert.ok(Math.abs(sphericalY(0, 0, 1.1, 2.2, 0) - 0.28209479) < 1e-6);
  // m > l clamps to l, stays finite
  assert.ok(Number.isFinite(sphericalY(3, 7, 0.5, 0.5, 0)));
});

test('harmonic: pitch changes dominant degree → different geometry', () => {
  const params = { ...baseParams, mode: 'harmonic' };
  const a = generate(testFingerprint({ pitchMedian: 0.1 }), params);
  const b = generate(testFingerprint({ pitchMedian: 0.9 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(a.positions[i] - b.positions[i]);
  assert.ok(diff > 1, 'pitch should change the form');
});

test('harmonic: registered in mode registry', () => {
  assert.ok(registeredModes().includes('harmonic'));
});
```

Also add `registeredModes` to the existing import from `../js/generators/index.js` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — cannot find module `harmonic.js`.

- [ ] **Step 3: Create `js/generators/harmonic.js`**

```js
import { mulberry32, finalize, resamplePolyline } from './common.js';

// Analogue wireframe sphere deformed by real spherical harmonics: fine
// lat/long rings whose radius is displaced by a stack of Y_l^m terms, so the
// form reads as a resonating physical body drawn by a plotter. Points are
// sampled ALONG the rings (tight jitter) so the density renderer draws crisp
// lines instead of volumetric clouds; the rings themselves are the strands.

function factorialRatio(l, m) {
  // (l-m)!/(l+m)! as a running product — avoids overflow for l ≤ 10
  let r = 1;
  for (let i = l - m + 1; i <= l + m; i++) r /= i;
  return r;
}

function legendreP(l, m, x) {
  let pmm = 1;
  if (m > 0) {
    const s = Math.sqrt(Math.max(0, (1 - x) * (1 + x)));
    let fact = 1;
    for (let i = 1; i <= m; i++) { pmm *= -fact * s; fact += 2; }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = (x * (2 * ll - 1) * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1; pmmp1 = pll;
  }
  return pll;
}

export function sphericalY(l, m, theta, phi, phase = 0) {
  const am = Math.min(Math.abs(m), l);
  const norm = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * factorialRatio(l, am));
  return norm * legendreP(l, am, Math.cos(theta)) * Math.cos(am * phi + phase);
}

export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const N = Math.max(1000, Math.floor(params.density));

  // Pitch → dominant degree l (low = few large lobes, high = fine ripples);
  // notes → orders m; chroma → phases; dynamics → component count.
  const lMain = 3 + Math.round(fp.pitchMedian * 6); // 3..9
  const nComp = Math.max(1, Math.min(4, 1 + Math.round(fp.volVar * 2 + fp.attackSlope)));
  const comps = [];
  for (let c = 0; c < nComp; c++) {
    const l = Math.max(2, Math.min(10, lMain + (c === 0 ? 0 : Math.round((rnd() - 0.5) * 4))));
    const m = fp.noteSet[c % fp.noteCount] % (l + 1);
    const phase = fp.chroma[(c * 5) % 12] * Math.PI * 2 + rnd() * 0.5;
    const amp = (0.32 / (c + 1)) * (0.7 + fp.velocity * 0.6);
    comps.push({ l, m, phase, amp });
  }

  const disp = (theta, phi) => {
    let d = 0;
    for (const c of comps) d += c.amp * sphericalY(c.l, c.m, theta, phi, c.phase);
    return d;
  };

  const rings = 44 + Math.round((params.complexity || 0.5) * 36); // 44..80
  const lons = 16;
  const perRing = Math.max(40, Math.floor(N / (rings + lons)));
  const total = perRing * (rings + lons);
  const positions = new Float32Array(total * 3);
  const attr = new Float32Array(total);
  const strands = [];
  const jit = 0.0035; // tight jitter keeps line-work crisp
  let w = 0;

  const push = (theta, phi) => {
    const d = disp(theta, phi);
    const r = 1 + d;
    const st = Math.sin(theta);
    positions[w * 3]     = r * st * Math.cos(phi) + (rnd() - 0.5) * jit;
    positions[w * 3 + 1] = r * Math.cos(theta)    + (rnd() - 0.5) * jit;
    positions[w * 3 + 2] = r * st * Math.sin(phi) + (rnd() - 0.5) * jit;
    attr[w] = Math.max(0, Math.min(1, 0.5 + d * 1.6)); // lobes brighten
    w++;
  };

  const ringStrand = (fixed, isLat) => {
    const raw = new Float32Array(256 * 3);
    for (let s = 0; s < 256; s++) {
      const t = s / 255;
      const theta = isLat ? fixed : t * Math.PI;
      const phi = isLat ? t * Math.PI * 2 : fixed;
      const d = disp(theta, phi), r = 1 + d, st = Math.sin(theta);
      raw[s * 3] = r * st * Math.cos(phi);
      raw[s * 3 + 1] = r * Math.cos(theta);
      raw[s * 3 + 2] = r * st * Math.sin(phi);
    }
    return resamplePolyline(raw, 200);
  };

  for (let i = 0; i < rings; i++) {
    const theta = ((i + 0.5) / rings) * Math.PI;
    for (let p = 0; p < perRing; p++) push(theta, rnd() * Math.PI * 2);
    strands.push(ringStrand(theta, true));
    if (onProgress && i % 8 === 0) onProgress(i / (rings + lons));
  }
  for (let j = 0; j < lons; j++) {
    const phi = (j / lons) * Math.PI * 2;
    for (let p = 0; p < perRing; p++) push(rnd() * Math.PI, phi);
    strands.push(ringStrand(phi, false));
  }

  return finalize(positions, attr, strands, params);
}
```

- [ ] **Step 4: Register the mode**

In `js/generators/index.js`, add the import and registry entry:

```js
import * as harmonic from './harmonic.js';
```

and change the REGISTRY line to:

```js
const REGISTRY = { attractor: attractor.generate, chladni: chladni.generate, radial: radial.generate, cymatics: cymatics.generate, timbre: timbre.generate, harmonic: harmonic.generate };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: all tests pass (35 existing + 4 new = 39).

- [ ] **Step 6: Add the mode button**

In `index.html`, after line 70 (`data-mode="timbre"` button), add:

```html
        <button class="btn-mode" data-mode="harmonic">Harmonic</button>
```

- [ ] **Step 7: Commit**

```bash
git add js/generators/harmonic.js js/generators/index.js index.html test/generators.test.js
git commit -m "feat: harmonic mode — spherical-harmonics wireframe sphere

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Muted palettes + ship feature 1

**Files:**
- Modify: `js/palettes.js` (PALETTES object, lines 4–10)
- Modify: `index.html:101-106` (palette select options)
- Test: `test/palettes.test.js` (append)

**Interfaces:**
- Produces: PALETTES keys `ink`, `graphite`, `scope` — consumed automatically by `buildLUT`/`sampleRamp` and the existing UI/SVG paths.

- [ ] **Step 1: Write the failing test**

Append to `test/palettes.test.js` (match its existing import style):

```js
test('muted palettes: ink/graphite/scope present and well-formed', () => {
  for (const key of ['ink', 'graphite', 'scope']) {
    const p = PALETTES[key];
    assert.ok(p, `${key} missing`);
    assert.equal(p.stops[0][0], 0);
    assert.equal(p.stops[p.stops.length - 1][0], 1);
    for (const [t, hex] of p.stops) {
      assert.ok(t >= 0 && t <= 1);
      assert.match(hex, /^#[0-9a-f]{6}$/i);
    }
  }
});
```

If `PALETTES` isn't already imported in that file, add it to the existing import from `../js/palettes.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — `ink missing`.

- [ ] **Step 3: Add the palettes**

In `js/palettes.js`, add inside the `PALETTES` object after `rosegold`:

```js
  ink:     { label: 'Ink',      stops: [[0, '#0b0b0a'], [0.35, '#4a463f'], [0.7, '#b3ada0'], [1, '#f2ede2']] },
  graphite:{ label: 'Graphite', stops: [[0, '#0a0a0c'], [0.35, '#3d3f45'], [0.7, '#9a9da6'], [1, '#e8eaee']] },
  scope:   { label: 'Scope',    stops: [[0, '#020604'], [0.35, '#14452b'], [0.7, '#5cb87e'], [1, '#d8f5e0']] },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | tail -5`
Expected: PASS (40 tests).

- [ ] **Step 5: Add select options**

In `index.html`, inside `<select id="sel-palette">` (line 101), after the last non-custom option add:

```html
          <option value="ink">Ink</option>
          <option value="graphite">Graphite</option>
          <option value="scope">Scope</option>
```

(Keep the existing `custom` option last if present.)

- [ ] **Step 6: Bump cache version (ship feature 1)**

```bash
cd ~/Documents/Github/soundform
grep -rl 'v=22' index.html css js | xargs sed -i '' 's/v=22/v=23/g'
grep -rn 'v=22' index.html css js
```
Expected: second grep returns nothing.

- [ ] **Step 7: Manual browser check**

Run: `npx serve .` (or `python3 -m http.server`), open the page, record/upload a sound, click **Harmonic** — expect a fine-lined deformed wireframe sphere; switch palette to **Ink** — expect warm monochrome. Check SVG export produces ring paths.

- [ ] **Step 8: Commit**

```bash
git add js/palettes.js index.html test/palettes.test.js css js
git commit -m "feat: ink/graphite/scope muted palettes; bump cache to v=23

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Motion math module

**Files:**
- Create: `js/motion.js`
- Test: `test/motion.test.js` (create)

**Interfaces:**
- Consumes: `mulberry32` from `./generators/common.js`.
- Produces: `motionParams(seed)` → `{ dir: [x,y,z] (unit), freq: number, amp: number }`; `displacePoint(x, y, z, mp, t)` → `[x, y, z]`. `displacePoint` must match the Task 4 GLSL exactly: radial offset `amp · sin(freq · dot(p, dir) + 2π·t)`.

- [ ] **Step 1: Write the failing tests**

Create `test/motion.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { motionParams, displacePoint } from '../js/motion.js';

test('motionParams: deterministic, unit direction, bounded amp', () => {
  const a = motionParams(123456789);
  const b = motionParams(123456789);
  assert.deepEqual(a, b);
  const len = Math.hypot(...a.dir);
  assert.ok(Math.abs(len - 1) < 1e-9, 'dir must be unit length');
  assert.ok(a.amp >= 0.02 && a.amp <= 0.045, `amp subtle (${a.amp})`);
  assert.ok(a.freq >= 4 && a.freq <= 9);
  const c = motionParams(987);
  assert.notDeepEqual(a.dir, c.dir, 'different seeds → different motion');
});

test('displacePoint: seamless loop — t=0 equals t=1', () => {
  const mp = motionParams(42);
  const p0 = displacePoint(0.3, -0.5, 0.8, mp, 0);
  const p1 = displacePoint(0.3, -0.5, 0.8, mp, 1);
  for (let d = 0; d < 3; d++) assert.ok(Math.abs(p0[d] - p1[d]) < 1e-6);
});

test('displacePoint: displacement is radial and bounded by amp', () => {
  const mp = motionParams(42);
  const [x, y, z] = displacePoint(0.6, 0.0, 0.0, mp, 0.37);
  const moved = Math.hypot(x - 0.6, y, z);
  assert.ok(moved <= mp.amp + 1e-9);
  assert.ok(Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9, 'point on x-axis moves along x only');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — cannot find `../js/motion.js`.

- [ ] **Step 3: Create `js/motion.js`**

```js
import { mulberry32 } from './generators/common.js';

// Deterministic per-design motion: a plane wave travelling through the form,
// displacing each point along its radial direction. Every time term is a
// whole multiple of 2π·t, so phase t=0 and t=1 render identically — the loop
// is seamless by construction. displacePoint mirrors the GLSL in
// density.js SPLAT_VERT exactly; keep the two in lockstep.

export function motionParams(seed) {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const az = rnd() * Math.PI * 2;
  const el = Math.acos(2 * rnd() - 1);
  return {
    dir: [Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az)],
    freq: 4 + rnd() * 5,          // spatial frequency of the travelling wave
    amp: 0.025 + rnd() * 0.015,   // 2.5–4% of form radius: breathes, not explodes
  };
}

export function displacePoint(x, y, z, mp, t) {
  const len = Math.sqrt(x * x + y * y + z * z) || 1e-6;
  const s = mp.amp * Math.sin(mp.freq * (x * mp.dir[0] + y * mp.dir[1] + z * mp.dir[2]) + Math.PI * 2 * t);
  return [x + (x / len) * s, y + (y / len) * s, z + (z / len) * s];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS (43 tests).

- [ ] **Step 5: Commit**

```bash
git add js/motion.js test/motion.test.js
git commit -m "feat: deterministic seamless-loop motion math module

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Density renderer motion (additive)

**Files:**
- Modify: `js/density.js` — SPLAT_VERT shader (~line 60s), splatMat uniforms (~line 97), constructor state (~line 51), `_loop()` (~line 251), new public methods after `setParams` (~line 201)

**Interfaces:**
- Consumes: motion param object `{ dir, freq, amp }` from Task 3.
- Produces (used by Tasks 5 & 8): `setMotion(mp)`, `setPlaying(on)`, `activateMotion()`, `setLoopPeriod(seconds)`, `setLoopPhase(t)`, `getLoopPhase() → number`, `getActiveMotion() → mp | null`. Paused = frozen frame (uniforms persist, `renderHiRes` captures them).

**Reminder:** additive only — with `uAmp` at 0, output must be pixel-identical to today.

- [ ] **Step 1: Extend SPLAT_VERT**

Replace the SPLAT_VERT `main()` body so the full shader reads:

```js
const SPLAT_VERT = `
attribute float attrv;
varying float vAttr;
uniform float uSize;
uniform float uTime, uFreq, uAmp;
uniform vec3 uDir;
void main() {
  vec3 p = position;
  float s = uAmp * sin(uFreq * dot(p, uDir) + 6.28318530718 * uTime);
  p += (p / max(length(p), 1e-6)) * s;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize / max(0.1, -mv.z);
  vAttr = attrv;
}`;
```

- [ ] **Step 2: Add uniforms and state**

In the `splatMat` construction (~line 97), change uniforms to:

```js
      uniforms: {
        uSize: { value: 3.0 },
        uTime: { value: 0 }, uFreq: { value: 5 }, uAmp: { value: 0 },
        uDir: { value: new THREE.Vector3(0, 1, 0) },
      },
```

Next to the `this._params = {...}` line (~line 51), add:

```js
    this._playing = false;
    this._loopPeriod = 8;
    this._motion = null;
    this._lastTick = 0;
```

- [ ] **Step 3: Add public motion methods**

After `setParams` (~line 201), add:

```js
  // ── Motion (seamless loop) — displacement mirrors js/motion.js ──
  setMotion(mp) {
    this._motion = mp;
    this.splatMat.uniforms.uDir.value.set(mp.dir[0], mp.dir[1], mp.dir[2]);
    this.splatMat.uniforms.uFreq.value = mp.freq;
    if (this.splatMat.uniforms.uAmp.value > 0) this.splatMat.uniforms.uAmp.value = mp.amp;
    this._dirty = true;
  }
  activateMotion() {
    if (this._motion) this.splatMat.uniforms.uAmp.value = this._motion.amp;
    this._dirty = true;
  }
  setPlaying(on) {
    this._playing = !!on;
    if (on) this.activateMotion();
    this._dirty = true;
  }
  setLoopPeriod(sec) { this._loopPeriod = Math.max(1, sec); }
  setLoopPhase(t) { this.splatMat.uniforms.uTime.value = t - Math.floor(t); this._dirty = true; }
  getLoopPhase() { return this.splatMat.uniforms.uTime.value; }
  getActiveMotion() { return this.splatMat.uniforms.uAmp.value > 0 ? this._motion : null; }
```

- [ ] **Step 4: Advance phase in `_loop()`**

In `_loop()` (~line 251), after the autoRotate block and before the `if (!this._dirty) return;` line, add:

```js
    if (this._playing) {
      const now = performance.now() / 1000;
      const dt = Math.min(0.1, this._lastTick ? now - this._lastTick : 0);
      this._lastTick = now;
      this.setLoopPhase(this.splatMat.uniforms.uTime.value + dt / this._loopPeriod);
    } else {
      this._lastTick = 0;
    }
```

- [ ] **Step 5: Verify no regression**

Run: `npm test 2>&1 | tail -5`
Expected: PASS (density.js has no node tests, but nothing else may break).

Manual: serve the page, create a design — confirm it renders identically to before (motion never enabled → `uAmp` stays 0). Then smoke-test the new API from the browser console (UI lands in Task 5): find the renderer via the module scope is not exposed, so temporarily run `window.__r = renderer` added in main.js OR simply verify visually after Task 5. Minimum bar for this task: page loads with no shader compile errors in the console and the design looks unchanged.

- [ ] **Step 6: Commit**

```bash
git add js/density.js
git commit -m "feat(density): additive seamless-loop motion uniforms and playback API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Motion UI + SVG frame-accurate export + ship feature 2

**Files:**
- Modify: `index.html` — Motion section (lines 123–126)
- Modify: `js/main.js` — imports (~line 5), params (~line 27), `onResult` (~line 86–90), control bindings (~line 238–266), SVG export branch (~line 272–291)
- Modify: `css/styles-new.css` — one small rule

**Interfaces:**
- Consumes: `motionParams`, `displacePoint` (Task 3); renderer motion API (Task 4).
- Produces: params `motionOn: boolean`, `motionPeriod: number (4–20 s)`; UI ids `btn-motion`, `sl-motion-period`, `val-motion-period`.

- [ ] **Step 1: Add UI markup**

In `index.html`, inside the Motion section after the Auto-rotate row (line 125), add:

```html
      <div class="sl-row"><div class="sl-label"><span>Animate</span></div>
        <button id="btn-motion" type="button">&#9654; Play</button></div>
      <div class="sl-row"><div class="sl-label"><span>Loop (s)</span><span id="val-motion-period">8</span></div>
        <input type="range" id="sl-motion-period" min="4" max="20" step="1" value="8"></div>
```

In `css/styles-new.css`, append (match the file's existing button variables/idiom if one exists):

```css
#btn-motion { width: 100%; cursor: pointer; }
```

- [ ] **Step 2: Wire it in `js/main.js`**

Add import (next to the other `./` imports, ~line 5 — use the current cache version, `?v=23`):

```js
import { motionParams, displacePoint } from './motion.js?v=23';
```

Add to the `params` object (~line 27): `motionOn: false, motionPeriod: 8,`

In `onResult` (~line 87), directly after `design = out;`:

```js
    renderer.setMotion(motionParams(fingerprint.seed));
```

With the other control bindings (~line 252 area):

```js
  document.getElementById('btn-motion').addEventListener('click', () => {
    params.motionOn = !params.motionOn;
    renderer.setPlaying(params.motionOn);
    document.getElementById('btn-motion').innerHTML = params.motionOn ? '&#10074;&#10074; Pause' : '&#9654; Play';
  });
  document.getElementById('sl-motion-period').addEventListener('input', (e) => {
    params.motionPeriod = parseFloat(e.target.value);
    document.getElementById('val-motion-period').textContent = params.motionPeriod;
    renderer.setLoopPeriod(params.motionPeriod);
  });
```

- [ ] **Step 3: Frame-accurate SVG export**

In the SVG branch of the export handler (~line 273), after `const picked = [];` loop completes and before `const svg = exportStrandSVG({...})`, add:

```js
          let expStrands = picked, expPositions = design.positions;
          const mp = renderer.getActiveMotion();
          if (mp) {
            const t = renderer.getLoopPhase();
            const displaceArr = (src) => {
              const c = new Float32Array(src.length);
              for (let i = 0; i < src.length; i += 3) {
                const [x, y, z] = displacePoint(src[i], src[i + 1], src[i + 2], mp, t);
                c[i] = x; c[i + 1] = y; c[i + 2] = z;
              }
              return c;
            };
            expStrands = picked.map(displaceArr);
            expPositions = displaceArr(design.positions);
          }
```

Then change the `exportStrandSVG` call to use `strands: expStrands, positions: expPositions,`.

- [ ] **Step 4: Tests + manual verification**

Run: `npm test 2>&1 | tail -5` — expected: PASS (43).

Manual: serve, create a design, press **Play** — the form ripples subtly; watch one full loop (8 s) — no jump at the wrap point. Change Loop(s) — speed changes smoothly without a phase jump. Pause — frame freezes; PNG export matches the frozen frame; SVG export matches it too (compare a lobe position by eye). Confirm motion is OFF by default on reload.

- [ ] **Step 5: Bump cache version (ship feature 2)**

```bash
grep -rl 'v=23' index.html css js | xargs sed -i '' 's/v=23/v=24/g'
grep -rn 'v=23' index.html css js
```
Expected: second grep returns nothing.

- [ ] **Step 6: Commit**

```bash
git add index.html css/styles-new.css js/main.js
git commit -m "feat: motion play/pause + loop-speed UI, frame-accurate SVG export; bump to v=24

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Vendor mp4-muxer

**Files:**
- Create: `js/vendor/mp4-muxer.min.js` (vendored UMD build)
- Modify: `index.html` script tags (~line 132–134)

**Interfaces:**
- Produces: global `window.Mp4Muxer` with `{ Muxer, ArrayBufferTarget }` (UMD build), used by Task 7.

- [ ] **Step 1: Download the UMD build**

```bash
mkdir -p js/vendor
curl -sL https://cdn.jsdelivr.net/npm/mp4-muxer@5/build/mp4-muxer.min.js -o js/vendor/mp4-muxer.min.js
head -c 300 js/vendor/mp4-muxer.min.js
```
Expected: minified JS starting with a banner/IIFE mentioning `Mp4Muxer` (MIT license header). If the file is an HTML error page, retry with an explicit version: `https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.1/build/mp4-muxer.min.js`.

- [ ] **Step 2: Verify the global loads**

```bash
node -e "const fs=require('fs');const src=fs.readFileSync('js/vendor/mp4-muxer.min.js','utf8');const w={};new Function('window','self','globalThis',src)(w,w,w);console.log(typeof w.Mp4Muxer.Muxer, typeof w.Mp4Muxer.ArrayBufferTarget)"
```
Expected: `function function`. (If the build attaches differently, check `Object.keys(w)` and adjust — the global name must be confirmed before Task 7 uses it.)

- [ ] **Step 3: Add the script tag**

In `index.html`, after the jsPDF script (line 133) and before the main.js module tag, add:

```html
<script src="js/vendor/mp4-muxer.min.js"></script>
```

- [ ] **Step 4: Commit**

```bash
git add js/vendor/mp4-muxer.min.js index.html
git commit -m "chore: vendor mp4-muxer UMD build for MP4 export

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: framePlan + exportMP4 in exporter.js

**Files:**
- Modify: `js/exporter.js` (append)
- Test: `test/exporter.test.js` (append)

**Interfaces:**
- Consumes: `window.Mp4Muxer` (Task 6), module-private `_dl` helper (already in exporter.js).
- Produces: `framePlan(periodSeconds, fps = 30)` → `{ frames, fps, phase(i) }`; `exportMP4({ renderFrame, fps, frames, onProgress, shouldCancel })` → `Promise<boolean>` (false = cancelled). `renderFrame(i)` must return a canvas; all frames must be the same size.

- [ ] **Step 1: Write the failing tests**

Append to `test/exporter.test.js` (match its import style; add `framePlan` to the import from `../js/exporter.js`):

```js
test('framePlan: whole loop, phase wraps to zero, never reaches 1', () => {
  const p = framePlan(8, 30);
  assert.equal(p.frames, 240);
  assert.equal(p.fps, 30);
  assert.equal(p.phase(0), 0);
  assert.equal(p.phase(p.frames), 0, 'frame N wraps to frame 0 — seamless');
  assert.ok(p.phase(p.frames - 1) < 1);
  // phases are strictly increasing across the loop
  for (let i = 1; i < p.frames; i++) assert.ok(p.phase(i) > p.phase(i - 1));
});

test('framePlan: minimum two frames', () => {
  assert.ok(framePlan(0.01, 30).frames >= 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — `framePlan` is not exported.

- [ ] **Step 3: Implement in `js/exporter.js`**

Append:

```js
// ── MP4 export ─────────────────────────────────────────────────────
// One seamless loop: frame i renders at phase i/frames, so frame `frames`
// would equal frame 0 — the file loops perfectly by construction.
export function framePlan(periodSeconds, fps = 30) {
  const frames = Math.max(2, Math.round(periodSeconds * fps));
  return { frames, fps, phase: (i) => (i % frames) / frames };
}

// Deterministic offline encode: caller renders each frame (offscreen, fixed
// phase), we push it through WebCodecs H.264 into an mp4-muxer container.
export async function exportMP4({ renderFrame, fps, frames, onProgress, shouldCancel }) {
  const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;
  const first = renderFrame(0);
  const W = first.width & ~1, H = first.height & ~1; // H.264 needs even dims
  const stage = document.createElement('canvas');
  stage.width = W; stage.height = H;
  const ctx = stage.getContext('2d');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory',
  });
  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encError = e; },
  });
  let cfg = { codec: 'avc1.640028', width: W, height: H, bitrate: 12_000_000, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) cfg = { ...cfg, codec: 'avc1.42001f' };
  encoder.configure(cfg);

  for (let i = 0; i < frames; i++) {
    if (shouldCancel && shouldCancel()) { encoder.close(); return false; }
    if (encError) throw encError;
    ctx.drawImage(i === 0 ? first : renderFrame(i), 0, 0, W, H);
    const frame = new VideoFrame(stage, {
      timestamp: Math.round((i * 1e6) / fps),
      duration: Math.round(1e6 / fps),
    });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    if (onProgress) onProgress((i + 1) / frames);
    while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 10));
  }
  await encoder.flush();
  muxer.finalize();
  const url = URL.createObjectURL(new Blob([muxer.target.buffer], { type: 'video/mp4' }));
  _dl(url, 'soundform.mp4');
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS (45 tests; `exportMP4` itself is browser-only, exercised manually in Task 8).

- [ ] **Step 5: Commit**

```bash
git add js/exporter.js test/exporter.test.js
git commit -m "feat(export): framePlan + WebCodecs MP4 encoder pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: MP4 UI wiring + ship feature 3

**Files:**
- Modify: `index.html:42` (export button)
- Modify: `js/main.js` — exporter import (~line 5), export handler (~line 268–298)

**Interfaces:**
- Consumes: `framePlan`, `exportMP4` (Task 7); renderer motion API (Task 4); `params.motionPeriod`, `params.motionOn` (Task 5).

- [ ] **Step 1: Add the export button**

In `index.html` after the PDF button (line 42):

```html
        <button class="btn-export" data-fmt="mp4">MP4</button>
```

- [ ] **Step 2: Wire the export branch**

In `js/main.js`, extend the exporter import to include the new functions:

```js
import { exportCanvas, exportStrandSVG, framePlan, exportMP4 } from './exporter.js?v=24';
```

Add module-scope state near `let design = null;` (~line 15):

```js
let mp4Busy = false, mp4Cancel = false;
```

In the `.btn-export` click handler, add a branch after the `if (fmt === 'svg') {...}` block and before the final `else`:

```js
        } else if (fmt === 'mp4') {
          if (!('VideoEncoder' in window)) { setStatus('MP4 export not supported in this browser'); return; }
          if (!design) { setStatus('Create a design first'); return; }
          if (mp4Busy) { mp4Cancel = true; setStatus('Cancelling…'); return; }
          mp4Busy = true; mp4Cancel = false;
          const wasPlaying = params.motionOn;
          renderer.setPlaying(false);
          renderer.activateMotion();
          const savedPhase = renderer.getLoopPhase();
          try {
            const probe = renderer.renderHiRes(1);
            const scale = 1080 / Math.max(probe.width, probe.height);
            const plan = framePlan(params.motionPeriod, 30);
            const ok = await exportMP4({
              renderFrame: (i) => { renderer.setLoopPhase(plan.phase(i)); return renderer.renderHiRes(scale); },
              fps: plan.fps, frames: plan.frames,
              onProgress: (p) => setStatus(`MP4 ${Math.round(p * 100)}% — click MP4 again to cancel`),
              shouldCancel: () => mp4Cancel,
            });
            setStatus(ok ? 'MP4 saved' : 'MP4 export cancelled');
          } finally {
            mp4Busy = false;
            renderer.setLoopPhase(savedPhase);
            renderer.setPlaying(wasPlaying);
          }
        }
```

- [ ] **Step 3: Tests + manual verification**

Run: `npm test 2>&1 | tail -5` — expected: PASS (45).

Manual (Chrome): create a design, set Loop(s)=6, click **MP4**. Expect progress % in the status pill (a 6 s / 180-frame export takes roughly 15–60 s of offline rendering), then a `soundform.mp4` download. Open it: plays, ~6 s, 1080 px long edge, loops seamlessly when set to repeat (check the wrap point). Click MP4 mid-export → second click cancels, no download, canvas returns to the pre-export frame. Verify PNG export still works after an MP4 export (state restored).

- [ ] **Step 4: Bump cache version (ship feature 3)**

```bash
grep -rl 'v=24' index.html css js | xargs sed -i '' 's/v=24/v=25/g'
grep -rn 'v=24' index.html css js
```
Expected: second grep returns nothing.

- [ ] **Step 5: Commit**

```bash
git add index.html js/main.js
git commit -m "feat: seamless-loop MP4 export via WebCodecs; bump to v=25

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Remove Chladni mode

**Files:**
- Delete: `js/generators/chladni.js`
- Modify: `js/generators/index.js` (import + registry entry)
- Modify: `index.html:67` (mode button)
- Test: `test/generators.test.js` (remove chladni tests)

**Interfaces:**
- Produces: registry without `chladni`; `registeredModes()` no longer includes it. Attractor/Cymatics untouched (locked).

- [ ] **Step 1: Update the tests first**

In `test/generators.test.js`: delete every `test('chladni...)` block (search for `chladni`), and add to an existing registry test or as a new one:

```js
test('chladni mode is removed', () => {
  assert.ok(!registeredModes().includes('chladni'));
});
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — `chladni` still registered.

- [ ] **Step 3: Remove the mode**

- In `js/generators/index.js`: delete `import * as chladni from './chladni.js';` and the `chladni: chladni.generate,` registry entry.
- Delete the file: `git rm js/generators/chladni.js`
- In `index.html`, delete the line `<button class="btn-mode" data-mode="chladni">Chladni</button>` (line 67).
- Search for stragglers: `grep -rn chladni js test index.html css` — expected: no matches.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test 2>&1 | tail -5`
Expected: PASS (count drops by however many chladni tests were removed, +1 new).

- [ ] **Step 5: Commit**

```bash
git add -A js/generators index.html test/generators.test.js
git commit -m "feat: remove chladni mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Soften Radial mode

**Files:**
- Modify: `js/generators/radial.js` (tuning constants only — no RNG call-order changes, so determinism is preserved)

**Interfaces:**
- No interface changes; same `generate` contract.

- [ ] **Step 1: Adjust the constants**

In `js/generators/radial.js` change exactly these lines (current → new):

```js
// lobe count: fewer, gentler lobes
const lobes = 2 + (fp.noteSet[s % fp.noteCount] % 5) + Math.round(params.complexity * 3);
// →
const lobes = 2 + (fp.noteSet[s % fp.noteCount] % 3) + Math.round(params.complexity * 2);

// wobble: roughly half the deformation
const wobble = 0.08 + fp.pitchRange * 0.3;
// →
const wobble = 0.04 + fp.pitchRange * 0.12;

// scatter tube: tighter, calmer ribbons
const tube = 0.007 + fp.velocity * 0.014 + tS * 0.005;
// →
const tube = 0.005 + fp.velocity * 0.008 + tS * 0.003;

// duplicated-strand offset: subtler echo lines
for (let i = 0; i < copy.length; i++) copy[i] += (rnd() - 0.5) * 0.02;
// →
for (let i = 0; i < copy.length; i++) copy[i] += (rnd() - 0.5) * 0.012;
```

- [ ] **Step 2: Run tests**

Run: `npm test 2>&1 | tail -5`
Expected: PASS — `checkGenerator('radial')` bounds still hold (only amplitudes shrank).

- [ ] **Step 3: Manual look-check (required — aesthetic change)**

Serve the page, create designs from 2–3 different sounds in Radial mode. Expect: calmer orbital ribbons, gentler lobes, tighter cores — still clearly radial, not collapsed to circles. **Show the user / ask the user to confirm the look before committing.** If still too chaotic, halve `wobble` terms again; if too flat, split the difference.

- [ ] **Step 4: Commit (after user confirms)**

```bash
git add js/generators/radial.js
git commit -m "tune(radial): softer wobble, fewer lobes, tighter tube — calmer designs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — full suite passes.
- [ ] Serve locally; full pass: record sound → Harmonic mode → Ink palette → Play motion → export PNG, SVG, MP4 → all three match the on-screen frame/loop.
- [ ] Remaining modes (Attractor, Cymatics, Radial, Timbre) render correctly with motion off — Attractor/Cymatics pixel-identical to production; Radial calmer per Task 10; Chladni button gone.
- [ ] `git log --oneline` shows one commit per task; push to `origin main` only when the user says to ship.
