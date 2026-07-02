# Soundform Density Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Soundform's five modes on a GPU log-density renderer with deterministic musical-feature mapping, working controls, and strand-based editable SVG export.

**Architecture:** Pure DOM-free modules (features, generators, strands, palettes) feed two representations of the same geometry — a 0.5M–4M point cloud splatted into a float render target and tonemapped with log-density colour mapping, and 96 ordered strands fitted to beziers for SVG export. A worker generates geometry off-thread; main.js owns UI state.

**Tech Stack:** Vanilla ES modules, Three.js r134 (existing CDN global), WebGL float render targets, `node --test` for pure-module tests. No build step.

**Spec:** `docs/superpowers/specs/2026-07-03-density-redesign-design.md`

## Global Constraints

- No build tooling; site must keep working when served statically (GitHub Pages).
- Pure modules (`js/palettes.js`, `js/features.js`, `js/generators/*`, `js/strands.js`) must never reference `THREE`, `window`, or `document` — they must run under Node for tests.
- `THREE` is the r134 CDN global — never `import` it.
- Determinism: identical fingerprint + params → byte-identical generator output. All randomness via `mulberry32(fp.seed)`.
- Generator output positions normalized to roughly [-1.1, 1.1]; `scale` is applied render-side (no regeneration).
- SVG export < 1 MB (Figma rasterises above ~3 MB; 1 MB is our safety budget).
- Cache-bust: all module script/import URLs bumped `?v=17` → `?v=18`.
- Node ≥ 18 required for tests (`node --test`).
- Work happens on branch `density-redesign`. Never commit to `main`.
- Palette presets must include pastel options (user preference: lavender/rose/mint over neon).

**Fingerprint shape (produced Task 3, consumed by all generators):**

```js
{
  pitchMedian: 0..1,      // log2(hz/55)/5 clamped; 0.5 when unvoiced
  pitchRange: 0..1,       // octaves/3 clamped
  contour: Float32Array(8), // 0..1 pitch trajectory
  pitchConfidence: 0..1,
  chroma: Float32Array(12), // 0..1 per pitch class
  noteSet: number[],      // pitch classes ≥ 0.45, sorted
  noteCount: 1..12,
  consonance: 0..1,
  majorLeaning: boolean,
  velocity: 0..1,         // onset density/strength
  volMean: 0..1, volVar: 0..1, attackSlope: 0..1,
  centroid: 0..1, spread: 0..1,
  seed: uint32
}
```

**Generator signature (every mode):**
`generate(fp, params, onProgress?) → { positions: Float32Array(N*3), attr: Float32Array(N), strands: Float32Array[] }`
where `params = { mode, density, complexity, symmetry, twist, strandCount }`, `attr` ∈ [0,1] (palette modulation), strands are ordered xyz triplet arrays (~96 strands × ≤2000 pts).

---

### Task 1: Test scaffolding + palettes.js

**Files:**
- Create: `package.json`, `js/palettes.js`, `test/palettes.test.js`

**Interfaces:**
- Produces: `PALETTES` (object of named `{label, stops}`), `sampleRamp(stops, t) → [r,g,b]` floats 0–1, `buildLUT(stops) → Uint8Array(256*4)` RGBA, `hexToRgb(hex) → [r,g,b]`.

- [ ] **Step 1: Create `package.json`** (enables ESM under node; not used by the site)

```json
{
  "name": "soundform",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test test/" }
}
```

- [ ] **Step 2: Write the failing test** — `test/palettes.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, sampleRamp, buildLUT, hexToRgb } from '../js/palettes.js';

test('hexToRgb parses', () => {
  assert.deepEqual(hexToRgb('#ff0080'), [1, 0, 128 / 255]);
});

test('sampleRamp interpolates endpoints and midpoints', () => {
  const stops = [[0, '#000000'], [1, '#ffffff']];
  assert.deepEqual(sampleRamp(stops, 0), [0, 0, 0]);
  assert.deepEqual(sampleRamp(stops, 1), [1, 1, 1]);
  const mid = sampleRamp(stops, 0.5);
  assert.ok(Math.abs(mid[0] - 0.5) < 0.01);
});

test('buildLUT returns 256 RGBA entries', () => {
  const lut = buildLUT(PALETTES.nebula.stops);
  assert.equal(lut.length, 256 * 4);
  assert.equal(lut[3], 255); // alpha opaque
});

test('all presets have valid ordered stops', () => {
  for (const p of Object.values(PALETTES)) {
    assert.ok(p.stops.length >= 3);
    for (let i = 1; i < p.stops.length; i++) assert.ok(p.stops[i][0] > p.stops[i - 1][0]);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test` — Expected: FAIL, cannot find `../js/palettes.js`.

- [ ] **Step 4: Write `js/palettes.js`**

```js
// Colour ramps shared by the screen tonemap LUT and SVG export gradients.
// Stops: [t, '#hex'] with t ascending 0→1. t=0 is the near-background tone.

export const PALETTES = {
  nebula:  { label: 'Nebula',  stops: [[0, '#050614'], [0.25, '#3b2a6e'], [0.55, '#9d5bd2'], [0.8, '#f2a7d8'], [1, '#ffffff']] },
  ember:   { label: 'Ember',   stops: [[0, '#0a0505'], [0.3, '#6e1e2a'], [0.6, '#e2603a'], [0.85, '#ffc266'], [1, '#fff7e0']] },
  aurora:  { label: 'Aurora',  stops: [[0, '#071010'], [0.3, '#7fd8c4'], [0.6, '#c5b8f0'], [0.85, '#f4c6d7'], [1, '#ffffff']] },
  glacier: { label: 'Glacier', stops: [[0, '#040a14'], [0.3, '#1e4f8a'], [0.6, '#4fa8d8'], [0.85, '#bde8f5'], [1, '#ffffff']] },
  rosegold:{ label: 'Rosé',    stops: [[0, '#120a0e'], [0.3, '#8a4a5e'], [0.6, '#d891a0'], [0.85, '#f2d3b8'], [1, '#fff8f0']] },
};

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function sampleRamp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  let i = 1;
  while (i < stops.length - 1 && stops[i][0] < t) i++;
  const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const a = hexToRgb(c0), b = hexToRgb(c1);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function buildLUT(stops) {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const c = sampleRamp(stops, i / 255);
    out[i * 4] = Math.round(c[0] * 255);
    out[i * 4 + 1] = Math.round(c[1] * 255);
    out[i * 4 + 2] = Math.round(c[2] * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function rgbToHex([r, g, b]) {
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Custom ramp from user colour pickers: background-dark → c1 → c2 → c3
export function customRamp(bgHex, c1, c2, c3) {
  return [[0, bgHex], [0.35, c1], [0.7, c2], [1, c3]];
}
```

- [ ] **Step 5: Run tests** — `npm test` — Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json js/palettes.js test/palettes.test.js
git commit -m "feat: palette ramps + LUT shared by renderer and SVG export"
```

---

### Task 2: generators/common.js — deterministic math utilities

**Files:**
- Create: `js/generators/common.js`, `test/common.test.js`

**Interfaces:**
- Produces: `mulberry32(seed) → () => float`, `fnv1a(str) → uint32`, `computeNormalization(positions) → {cx,cy,cz,scale}`, `applyNormalization(arr, t)`, `applyTwistArr(arr, amount)`, `replicateSymmetry(arr, k) → Float32Array`, `finalize(positions, attr, strands, params) → {positions, attr, strands}`, `resamplePolyline(arr, m) → Float32Array(m*3)`.

- [ ] **Step 1: Write the failing test** — `test/common.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, fnv1a, computeNormalization, applyNormalization,
         replicateSymmetry, finalize, resamplePolyline } from '../js/generators/common.js';

test('mulberry32 is deterministic in [0,1)', () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1);
  }
});

test('fnv1a stable', () => {
  assert.equal(fnv1a('soundform'), fnv1a('soundform'));
  assert.notEqual(fnv1a('a'), fnv1a('b'));
});

test('normalization centres and scales', () => {
  const pos = new Float32Array([10, 10, 10, 12, 10, 10, 10, 12, 10, 10, 10, 12]);
  const t = computeNormalization(pos);
  applyNormalization(pos, t);
  let maxAbs = 0;
  for (const v of pos) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs <= 1.6 && maxAbs > 0.3);
});

test('replicateSymmetry triples point count', () => {
  const out = replicateSymmetry(new Float32Array([1, 0, 0]), 3);
  assert.equal(out.length, 9);
  assert.ok(Math.abs(out[3] + 0.5) < 1e-5); // rotated 120° about Y
});

test('finalize applies symmetry to cloud and strands', () => {
  const res = finalize(new Float32Array([1, 0, 0]), new Float32Array([0.5]),
    [new Float32Array([1, 0, 0, 0, 1, 0])], { symmetry: 2, twist: 0 });
  assert.equal(res.positions.length, 6);
  assert.equal(res.attr.length, 2);
  assert.equal(res.strands.length, 2);
});

test('resamplePolyline returns m points, keeps endpoints', () => {
  const line = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
  const out = resamplePolyline(line, 5);
  assert.equal(out.length, 15);
  assert.equal(out[0], 0);
  assert.ok(Math.abs(out[12] - 2) < 1e-5);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test` (module not found).

- [ ] **Step 3: Write `js/generators/common.js`**

```js
// Deterministic utilities shared by all generators. DOM/THREE-free.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Robust normalization: centre on mean, scale so the 95th-percentile radius = 1.
export function computeNormalization(pos) {
  const n = pos.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += pos[i * 3]; cy += pos[i * 3 + 1]; cz += pos[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  const radii = [];
  const step = Math.max(1, Math.floor(n / 4096));
  for (let i = 0; i < n; i += step) {
    const x = pos[i * 3] - cx, y = pos[i * 3 + 1] - cy, z = pos[i * 3 + 2] - cz;
    radii.push(Math.sqrt(x * x + y * y + z * z));
  }
  radii.sort((a, b) => a - b);
  const r95 = radii[Math.floor(radii.length * 0.95)] || 1;
  return { cx, cy, cz, scale: r95 > 1e-6 ? 1 / r95 : 1 };
}

export function applyNormalization(arr, t) {
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = (arr[i] - t.cx) * t.scale;
    arr[i + 1] = (arr[i + 1] - t.cy) * t.scale;
    arr[i + 2] = (arr[i + 2] - t.cz) * t.scale;
  }
}

// Twist: rotate around Y by amount·y radians (shear along height).
export function applyTwistArr(arr, amount) {
  if (!amount) return;
  for (let i = 0; i < arr.length; i += 3) {
    const a = amount * arr[i + 1];
    const c = Math.cos(a), s = Math.sin(a);
    const x = arr[i], z = arr[i + 2];
    arr[i] = x * c + z * s;
    arr[i + 2] = -x * s + z * c;
  }
}

// k-fold rotational replication around Y. Returns a new array k× as long.
export function replicateSymmetry(arr, k) {
  if (k <= 1) return arr;
  const n = arr.length / 3;
  const out = new Float32Array(arr.length * k);
  for (let j = 0; j < k; j++) {
    const ang = (j / k) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
    for (let i = 0; i < n; i++) {
      const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
      const o = (j * n + i) * 3;
      out[o] = x * c + z * s;
      out[o + 1] = y;
      out[o + 2] = -x * s + z * c;
    }
  }
  return out;
}

// Standard post-pass every generator calls last:
// normalize (using the CLOUD's transform for strands too, so they stay aligned),
// then symmetry replication, then twist.
export function finalize(positions, attr, strands, params) {
  const t = computeNormalization(positions);
  applyNormalization(positions, t);
  for (const s of strands) applyNormalization(s, t);

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
        const copy = new Float32Array(st.length);
        for (let i = 0; i < st.length; i += 3) {
          copy[i] = st[i] * c + st[i + 2] * s;
          copy[i + 1] = st[i + 1];
          copy[i + 2] = -st[i] * s + st[i + 2] * c;
        }
        outStrands.push(copy);
      }
    }
  }
  applyTwistArr(outPos, params.twist || 0);
  for (const s of outStrands) applyTwistArr(s, params.twist || 0);
  return { positions: outPos, attr: outAttr, strands: outStrands };
}

// Arc-length resample a polyline (xyz triplets) to exactly m points.
export function resamplePolyline(arr, m) {
  const n = arr.length / 3;
  if (n < 2) return new Float32Array(m * 3);
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const dx = arr[i * 3] - arr[(i - 1) * 3];
    const dy = arr[i * 3 + 1] - arr[(i - 1) * 3 + 1];
    const dz = arr[i * 3 + 2] - arr[(i - 1) * 3 + 2];
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const total = cum[n - 1] || 1;
  const out = new Float32Array(m * 3);
  let j = 1;
  for (let i = 0; i < m; i++) {
    const target = (i / (m - 1)) * total;
    while (j < n - 1 && cum[j] < target) j++;
    const t0 = cum[j - 1], t1 = cum[j];
    const f = t1 > t0 ? (target - t0) / (t1 - t0) : 0;
    for (let d = 0; d < 3; d++) {
      out[i * 3 + d] = arr[(j - 1) * 3 + d] + (arr[j * 3 + d] - arr[(j - 1) * 3 + d]) * f;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/generators/common.js test/common.test.js
git commit -m "feat: deterministic generator utilities (PRNG, normalize, symmetry, twist)"
```

---

### Task 3: features.js — the sound fingerprint

**Files:**
- Create: `js/features.js`, `test/features.test.js`

**Interfaces:**
- Consumes: `fnv1a` from `./generators/common.js`.
- Produces: `detectPitch(buf: Float32Array, sampleRate) → {freq, confidence}`, `chromaFromFFT(mag: Float32Array, sampleRate, fftSize) → Float32Array(12)`, `spectralFlux(mag, prevMag) → number`, `buildFingerprint(frames, durationSec) → fingerprint` (shape in Global Constraints). `frames[i] = { pitchHz, pitchConf, chroma: Float32Array(12), flux, rms, centroid, spread }`.

- [ ] **Step 1: Write the failing test** — `test/features.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, chromaFromFFT, spectralFlux, buildFingerprint } from '../js/features.js';

const SR = 44100;

function sine(freq, n = 2048) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin(2 * Math.PI * freq * i / SR) * 0.5;
  return b;
}

test('detectPitch finds 440 Hz', () => {
  const { freq, confidence } = detectPitch(sine(440), SR);
  assert.ok(Math.abs(freq - 440) < 6, `got ${freq}`);
  assert.ok(confidence > 0.8);
});

test('detectPitch reports low confidence on noise', () => {
  const b = new Float32Array(2048);
  let s = 1; // deterministic LCG noise
  for (let i = 0; i < 2048; i++) { s = (s * 48271) % 2147483647; b[i] = (s / 2147483647 - 0.5) * 0.5; }
  assert.ok(detectPitch(b, SR).confidence < 0.6);
});

test('chromaFromFFT peaks at pitch class A for 440 Hz', () => {
  const mag = new Float32Array(1024);
  mag[Math.round(440 / (SR / 2048))] = 1;
  const c = chromaFromFFT(mag, SR, 2048);
  assert.equal(c.indexOf(Math.max(...c)), 9); // A = 9
});

test('spectralFlux positive on rising energy', () => {
  const a = new Float32Array(8).fill(0), b = new Float32Array(8).fill(1);
  assert.ok(spectralFlux(b, a) > 0);
  assert.equal(spectralFlux(a, b), 0);
});

function fakeFrames() {
  const frames = [];
  for (let i = 0; i < 120; i++) {
    const chroma = new Float32Array(12);
    chroma[0] = 1; chroma[4] = 0.8; chroma[7] = 0.7; // C major triad
    frames.push({ pitchHz: 261.6, pitchConf: 0.9, chroma, flux: i % 30 === 0 ? 0.5 : 0.02,
                  rms: 0.3 + 0.1 * Math.sin(i / 10), centroid: 0.4, spread: 0.3 });
  }
  return frames;
}

test('buildFingerprint: C major triad → consonant, major, 3 notes, deterministic', () => {
  const fp = buildFingerprint(fakeFrames(), 2.0);
  assert.deepEqual(fp.noteSet, [0, 4, 7]);
  assert.equal(fp.noteCount, 3);
  assert.ok(fp.consonance > 0.5);
  assert.equal(fp.majorLeaning, true);
  assert.ok(fp.pitchMedian > 0 && fp.pitchMedian < 1);
  const fp2 = buildFingerprint(fakeFrames(), 2.0);
  assert.equal(fp.seed, fp2.seed);
  assert.deepEqual([...fp.contour], [...fp2.contour]);
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.

- [ ] **Step 3: Write `js/features.js`**

```js
import { fnv1a } from './generators/common.js';

// Autocorrelation pitch detector (NAC). buf = time-domain Float32Array.
export function detectPitch(buf, sampleRate) {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.01) return { freq: 0, confidence: 0 };

  const minLag = Math.floor(sampleRate / 1000);   // 1000 Hz ceiling
  const maxLag = Math.min(Math.floor(sampleRate / 60), n - 1); // 60 Hz floor
  let bestLag = -1, bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0, norm = 0;
    for (let i = 0; i < n - lag; i++) {
      corr += buf[i] * buf[i + lag];
      norm += buf[i] * buf[i] + buf[i + lag] * buf[i + lag];
    }
    corr = norm > 0 ? (2 * corr) / norm : 0;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  if (bestLag < 0 || bestCorr < 0.3) return { freq: 0, confidence: bestCorr };
  return { freq: sampleRate / bestLag, confidence: bestCorr };
}

// Fold FFT magnitudes into 12 pitch classes (55 Hz – 4 kHz), max-normalised.
export function chromaFromFFT(mag, sampleRate, fftSize) {
  const chroma = new Float32Array(12);
  const binHz = sampleRate / fftSize;
  for (let i = 1; i < mag.length; i++) {
    const f = i * binHz;
    if (f < 55 || f > 4000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    chroma[((Math.round(midi) % 12) + 12) % 12] += mag[i];
  }
  let max = 0;
  for (const v of chroma) max = Math.max(max, v);
  if (max > 0) for (let i = 0; i < 12; i++) chroma[i] /= max;
  return chroma;
}

// Positive spectral difference (onset strength).
export function spectralFlux(mag, prevMag) {
  let s = 0;
  for (let i = 0; i < mag.length; i++) {
    const d = mag[i] - prevMag[i];
    if (d > 0) s += d;
  }
  return s / mag.length;
}

const TRIADS = (() => {
  const t = [];
  for (let r = 0; r < 12; r++) {
    t.push({ root: r, major: true,  pcs: [r, (r + 4) % 12, (r + 7) % 12] });
    t.push({ root: r, major: false, pcs: [r, (r + 3) % 12, (r + 7) % 12] });
  }
  return t;
})();

const clamp01 = v => Math.max(0, Math.min(1, v));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };

export function buildFingerprint(frames, durationSec) {
  const voiced = frames.filter(f => f.pitchConf > 0.5 && f.pitchHz > 0);
  const pitchConfidence = clamp01(voiced.length / Math.max(1, frames.length));

  const logs = voiced.map(f => Math.log2(f.pitchHz / 55) / 5); // 55 Hz–1760 Hz → 0..1
  const pitchMedian = voiced.length ? clamp01(median(logs)) : 0.5;
  const pitchRange = voiced.length
    ? clamp01((Math.max(...logs) - Math.min(...logs)) * 5 / 3)
    : 0;

  // Contour: 8 samples resampled over voiced frames (0.5 when unvoiced)
  const contour = new Float32Array(8).fill(0.5);
  if (logs.length >= 2) {
    for (let i = 0; i < 8; i++) {
      contour[i] = clamp01(logs[Math.min(logs.length - 1, Math.round((i / 7) * (logs.length - 1)))]);
    }
  }

  // RMS-weighted chroma histogram
  const chroma = new Float32Array(12);
  let wSum = 0;
  for (const f of frames) {
    for (let i = 0; i < 12; i++) chroma[i] += f.chroma[i] * f.rms;
    wSum += f.rms;
  }
  let cMax = 0;
  for (const v of chroma) cMax = Math.max(cMax, v);
  if (cMax > 0) for (let i = 0; i < 12; i++) chroma[i] /= cMax;

  const noteSet = [];
  for (let i = 0; i < 12; i++) if (chroma[i] >= 0.45) noteSet.push(i);
  if (noteSet.length === 0) noteSet.push(chroma.indexOf(Math.max(...chroma)));
  const noteCount = noteSet.length;

  // Harmony: best triad-template match
  let best = { score: -1, major: true };
  for (const t of TRIADS) {
    let inSum = 0, outSum = 0;
    for (let i = 0; i < 12; i++) {
      if (t.pcs.includes(i)) inSum += chroma[i]; else outSum += chroma[i];
    }
    const score = inSum / 3 - (outSum / 9) * 0.5;
    if (score > best.score) best = { score, major: t.major };
  }
  const consonance = clamp01(best.score * 1.4);
  const majorLeaning = best.major;

  // Velocity: onset peaks per second blended with mean onset strength
  const fluxes = frames.map(f => f.flux);
  const fMean = fluxes.reduce((a, b) => a + b, 0) / Math.max(1, fluxes.length);
  const fStd = Math.sqrt(fluxes.reduce((a, b) => a + (b - fMean) ** 2, 0) / Math.max(1, fluxes.length));
  let onsets = 0;
  for (let i = 1; i < fluxes.length - 1; i++) {
    if (fluxes[i] > fMean + fStd && fluxes[i] >= fluxes[i - 1] && fluxes[i] >= fluxes[i + 1]) onsets++;
  }
  const onsetsPerSec = onsets / Math.max(0.25, durationSec);
  const velocity = clamp01(0.6 * (onsetsPerSec / 8) + 0.4 * clamp01(fMean * 4));

  // Dynamics
  const rmses = frames.map(f => f.rms);
  const volMean = clamp01(rmses.reduce((a, b) => a + b, 0) / Math.max(1, rmses.length) * 2.5);
  const vVar = rmses.reduce((a, b) => a + (b - volMean / 2.5) ** 2, 0) / Math.max(1, rmses.length);
  const volVar = clamp01(Math.sqrt(vVar) * 5);
  let rise = 0;
  for (let i = 1; i < rmses.length; i++) rise = Math.max(rise, rmses[i] - rmses[i - 1]);
  const attackSlope = clamp01(rise * 8);

  const centroid = clamp01(frames.reduce((a, f) => a + f.centroid, 0) / Math.max(1, frames.length));
  const spread = clamp01(frames.reduce((a, f) => a + f.spread, 0) / Math.max(1, frames.length));

  // Deterministic seed from the quantised fingerprint
  const q = v => Math.round(v * 255);
  const seedStr = [pitchMedian, pitchRange, velocity, volMean, centroid, spread, consonance]
    .map(q).join(',') + '|' + noteSet.join(',') + '|' + [...contour].map(q).join(',');
  const seed = fnv1a(seedStr);

  return { pitchMedian, pitchRange, contour, pitchConfidence, chroma, noteSet, noteCount,
           consonance, majorLeaning, velocity, volMean, volVar, attackSlope,
           centroid, spread, seed };
}
```

- [ ] **Step 4: Run tests** — `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add js/features.js test/features.test.js
git commit -m "feat: musical fingerprint (pitch, chroma, harmony, onsets, dynamics)"
```

---

### Task 4: audio.js — per-frame musical analysis

**Files:**
- Modify: `js/audio.js`
- (No node test — Web Audio; verified in Task 7's browser check.)

**Interfaces:**
- Consumes: `detectPitch`, `chromaFromFFT`, `spectralFlux` from `./features.js`.
- Produces: `AudioEngine.getMusicalFrame() → { pitchHz, pitchConf, chroma, flux, rms, centroid, spread } | null`. Existing `startMic/loadFile/stop/getAnalysis` unchanged.

- [ ] **Step 1: Add imports and analyser config.** At the top of `js/audio.js`:

```js
import { detectPitch, chromaFromFFT, spectralFlux } from './features.js?v=18';
```

In `_init()`, after `this.analyser.fftSize = 1024;` change to:

```js
    this.analyser.fftSize               = 2048;
    this.timeData                       = new Float32Array(2048);
    this.magData                        = new Float32Array(this.analyser.frequencyBinCount);
    this._prevMag                       = new Float32Array(this.analyser.frequencyBinCount);
    this._frameNo                       = 0;
    this._lastPitch                     = { freq: 0, confidence: 0 };
```

(`fftData` sizing already uses `frequencyBinCount`, so `getAnalysis` keeps working; its band-average bin indices double in resolution — multiply every bin constant in `getAnalysis` by 2: `avg(0,6)`, `avg(6,24)`, `avg(24,94)`, `avg(94,280)`, `avg(280,600)`, `avg(0,400)`, peak/centroid loops to 600, `fftSnapshot` uses `d[i*8..i*8+7]/ (8*255)`.)

- [ ] **Step 2: Add `getMusicalFrame()` method to `AudioEngine`:**

```js
  // One musical-feature frame. Pitch runs every 2nd call (it's the heavy one).
  getMusicalFrame() {
    if (!this.analyser || !this.active) return null;
    this.analyser.getFloatTimeDomainData(this.timeData);
    this.analyser.getFloatFrequencyData(this.magData);

    // dB → linear magnitude
    const mag = new Float32Array(this.magData.length);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.pow(10, this.magData[i] / 20);

    let rms = 0;
    for (let i = 0; i < this.timeData.length; i++) rms += this.timeData[i] ** 2;
    rms = Math.sqrt(rms / this.timeData.length);

    if (this._frameNo++ % 2 === 0) {
      this._lastPitch = detectPitch(this.timeData, this.ctx.sampleRate);
    }
    const chroma = chromaFromFFT(mag, this.ctx.sampleRate, this.analyser.fftSize);
    const flux = spectralFlux(mag, this._prevMag);
    this._prevMag.set(mag);

    let wSum = 0, total = 0, spreadSq = 0;
    for (let i = 0; i < 600 && i < mag.length; i++) { wSum += i * mag[i]; total += mag[i]; }
    const cBin = total > 0 ? wSum / total : 180;
    for (let i = 0; i < 600 && i < mag.length; i++) spreadSq += (i - cBin) ** 2 * mag[i];

    return {
      pitchHz: this._lastPitch.freq,
      pitchConf: this._lastPitch.confidence,
      chroma, flux, rms,
      centroid: Math.min(1, cBin / 600),
      spread: total > 0 ? Math.min(1, Math.sqrt(spreadSq / total) / 240) : 0.2,
    };
  }
```

- [ ] **Step 3: Manual smoke check** — from repo root: `python3 -m http.server 8000`, open `http://localhost:8000`, open devtools console, record a few seconds of humming, confirm no console errors (full behavior verified in Task 7).

- [ ] **Step 4: Commit**

```bash
git add js/audio.js
git commit -m "feat: per-frame musical analysis (pitch, chroma, flux) in AudioEngine"
```

---

### Task 5: generators/attractor.js + generators/index.js

**Files:**
- Create: `js/generators/attractor.js`, `js/generators/index.js`, `test/generators.test.js`

**Interfaces:**
- Consumes: `mulberry32`, `finalize`, `resamplePolyline` from `./common.js`.
- Produces: `attractor.generate(fp, params, onProgress) → {positions, attr, strands}` and `generators/index.js: generate(fp, params, onProgress)` dispatching on `params.mode`. Registry starts with `attractor` only; Tasks 8–11 add the rest.

- [ ] **Step 1: Write the failing test** — `test/generators.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../js/generators/index.js';

export function testFingerprint(overrides = {}) {
  const chroma = new Float32Array(12); chroma[0] = 1; chroma[4] = 0.8; chroma[7] = 0.7;
  return Object.assign({
    pitchMedian: 0.45, pitchRange: 0.3, contour: new Float32Array(8).fill(0.45),
    pitchConfidence: 0.9, chroma, noteSet: [0, 4, 7], noteCount: 3,
    consonance: 0.8, majorLeaning: true, velocity: 0.4,
    volMean: 0.5, volVar: 0.3, attackSlope: 0.4, centroid: 0.4, spread: 0.3,
    seed: 123456789,
  }, overrides);
}

export const baseParams = { mode: 'attractor', density: 30000, complexity: 0.5, symmetry: 1, twist: 0, strandCount: 96 };

function stats(positions) {
  const n = positions.length / 3;
  let maxAbs = 0; const mean = [0, 0, 0], sq = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) {
    const v = positions[i * 3 + d];
    maxAbs = Math.max(maxAbs, Math.abs(v)); mean[d] += v / n; sq[d] += v * v / n;
  }
  return { maxAbs, std: sq.map((s, d) => Math.sqrt(Math.max(0, s - mean[d] ** 2))) };
}

export function checkGenerator(mode, fp = testFingerprint()) {
  const params = { ...baseParams, mode };
  const out = generate(fp, params);
  assert.equal(out.positions.length % 3, 0);
  assert.ok(out.positions.length / 3 >= params.density * 0.5, `${mode}: too few points`);
  assert.equal(out.attr.length, out.positions.length / 3);
  for (const v of out.attr) assert.ok(v >= 0 && v <= 1);
  const { maxAbs, std } = stats(out.positions);
  assert.ok(maxAbs <= 2.5, `${mode}: unbounded (${maxAbs})`);
  assert.ok(std[0] + std[1] + std[2] > 0.15, `${mode}: degenerate`);
  assert.ok(out.strands.length >= 24, `${mode}: needs strands`);
  const out2 = generate(fp, params);
  assert.deepEqual([...out.positions.slice(0, 300)], [...out2.positions.slice(0, 300)], `${mode}: not deterministic`);
  return out;
}

test('attractor generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('attractor');
});

test('attractor: different fingerprints → different geometry', () => {
  const a = generate(testFingerprint(), baseParams);
  const b = generate(testFingerprint({ pitchMedian: 0.8, noteSet: [1, 2], noteCount: 2, consonance: 0.1, seed: 987 }), baseParams);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(a.positions[i] - b.positions[i]);
  assert.ok(diff > 1, 'geometry should differ');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test`.

- [ ] **Step 3: Write `js/generators/attractor.js`**

```js
import { mulberry32, finalize, resamplePolyline } from './common.js';

// Five systems. Harmony class + noteCount pick the system; pitch sets
// coefficients inside pre-validated chaotic ranges; velocity adds turbulence.
const lerp = (a, b, t) => a + (b - a) * t;

const SYSTEMS = {
  thomas: {
    dt: 0.06, flow: true,
    coeffs: fp => ({ b: lerp(0.10, 0.19, 1 - fp.pitchMedian) }),
    step: (p, c) => [Math.sin(p[1]) - c.b * p[0], Math.sin(p[2]) - c.b * p[1], Math.sin(p[0]) - c.b * p[2]],
  },
  halvorsen: {
    dt: 0.012, flow: true,
    coeffs: fp => ({ a: lerp(1.4, 2.2, fp.pitchMedian) }),
    step: (p, c) => [
      -c.a * p[0] - 4 * p[1] - 4 * p[2] - p[1] * p[1],
      -c.a * p[1] - 4 * p[2] - 4 * p[0] - p[2] * p[2],
      -c.a * p[2] - 4 * p[0] - 4 * p[1] - p[0] * p[0]],
  },
  aizawa: {
    dt: 0.015, flow: true,
    coeffs: fp => ({ a: 0.95, b: 0.7, c: 0.6, d: lerp(3.0, 3.9, fp.pitchMedian), e: lerp(0.2, 0.3, fp.centroid), f: 0.1 }),
    step: (p, c) => [
      (p[2] - c.b) * p[0] - c.d * p[1],
      c.d * p[0] + (p[2] - c.b) * p[1],
      c.c + c.a * p[2] - (p[2] ** 3) / 3 - (p[0] ** 2 + p[1] ** 2) * (1 + c.e * p[2]) + c.f * p[2] * p[0] ** 3],
  },
  dadras: {
    dt: 0.01, flow: true,
    coeffs: fp => ({ a: lerp(2.0, 3.0, fp.pitchMedian), b: lerp(1.9, 2.7, fp.centroid), c: lerp(1.3, 1.7, fp.spread), d: lerp(1.2, 2.0, fp.volMean), e: 9 }),
    step: (p, c) => [
      p[1] - c.a * p[0] + c.b * p[1] * p[2],
      c.c * p[1] - p[0] * p[2] + p[2],
      c.d * p[0] * p[1] - c.e * p[2]],
  },
  sinemap: {
    flow: false, // discrete map, like the reference sine-map images
    coeffs: (fp, rnd) => ({
      a: lerp(1.2, 4.2, fp.contour[1]), b: lerp(1.2, 4.2, fp.contour[3]), c: lerp(1.2, 4.2, fp.contour[5]),
      d: lerp(-1.3, 1.3, fp.centroid), e: lerp(-1.3, 1.3, fp.spread), f: lerp(-1.3, 1.3, fp.volMean),
      g: rnd() * Math.PI * 2, h: rnd() * Math.PI * 2, i: rnd() * Math.PI * 2,
    }),
    step: (p, c) => [
      Math.sin(c.a * p[1]) + c.d * Math.sin(c.b * p[2] + c.g),
      Math.sin(c.b * p[2]) + c.e * Math.sin(c.c * p[0] + c.h),
      Math.sin(c.c * p[0]) + c.f * Math.sin(c.a * p[1] + c.i)],
  },
};

export function pickSystem(fp) {
  if (fp.pitchConfidence < 0.35 || fp.velocity > 0.75) return 'sinemap'; // percussive/noisy
  if (fp.consonance > 0.55 && fp.majorLeaning) return fp.noteCount <= 3 ? 'thomas' : 'aizawa';
  if (fp.consonance > 0.55) return 'halvorsen'; // minor
  return 'dadras'; // dissonant
}

function cloudStdDev(pos, n) {
  const m = [0, 0, 0], s = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) m[d] += pos[i * 3 + d] / n;
  for (let i = 0; i < n; i++) for (let d = 0; d < 3; d++) s[d] += (pos[i * 3 + d] - m[d]) ** 2 / n;
  return Math.sqrt(s[0] + s[1] + s[2]);
}

export function generate(fp, params, onProgress) {
  const name = pickSystem(fp);
  const sys = SYSTEMS[name];
  const rnd = mulberry32(fp.seed);
  const jitter = fp.velocity * 0.012 * (0.5 + params.complexity); // turbulence
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const excursion = 0.5 + params.complexity; // complexity widens coefficient excursion

  // Deterministic retry: if the system collapses, nudge fingerprint-projection
  for (let attempt = 0; attempt < 8; attempt++) {
    const fpAdj = attempt === 0 ? fp : { ...fp, pitchMedian: (fp.pitchMedian + attempt * 0.618) % 1, contour: fp.contour.map(v => (v + attempt * 0.618) % 1) };
    const c = sys.coeffs(fpAdj, rnd);
    if (sys.flow) for (const key of Object.keys(c)) {
      if (typeof c[key] === 'number' && key !== 'e') c[key] = c[key] * lerp(0.92, 1.08, ((excursion * 7 + attempt) % 1));
    }

    const positions = new Float32Array(N * 3);
    const attr = new Float32Array(N);
    let p = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];

    for (let i = 0; i < 3000; i++) { // warmup onto the attractor
      const d = sys.step(p, c);
      p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
    }

    let speedMax = 1e-6;
    const speeds = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const d = sys.step(p, c);
      const next = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
      const sp = Math.hypot(next[0] - p[0], next[1] - p[1], next[2] - p[2]);
      p = next;
      positions[i * 3] = p[0] + (rnd() - 0.5) * jitter;
      positions[i * 3 + 1] = p[1] + (rnd() - 0.5) * jitter;
      positions[i * 3 + 2] = p[2] + (rnd() - 0.5) * jitter;
      speeds[i] = sp;
      if (sp > speedMax) speedMax = sp;
      if (onProgress && i % 200000 === 0) onProgress(i / N);
    }
    // attr: dwell (slow = dense manifold = high palette position)
    for (let i = 0; i < N; i++) attr[i] = Math.max(0, Math.min(1, 1 - speeds[i] / speedMax));

    if (cloudStdDev(positions, Math.min(N, 5000)) < 0.02) continue; // collapsed → retry

    // Strands: continue the SAME trajectory, chopped into consecutive pieces
    const strandCount = Math.max(24, Math.min(96, params.strandCount || 96));
    const strands = [];
    const stepsPer = sys.flow ? 1400 : 500;
    for (let s = 0; s < strandCount; s++) {
      const raw = new Float32Array(stepsPer * 3);
      for (let i = 0; i < stepsPer; i++) {
        const d = sys.step(p, c);
        p = sys.flow ? [p[0] + d[0] * sys.dt, p[1] + d[1] * sys.dt, p[2] + d[2] * sys.dt] : d;
        raw[i * 3] = p[0]; raw[i * 3 + 1] = p[1]; raw[i * 3 + 2] = p[2];
      }
      strands.push(resamplePolyline(raw, sys.flow ? 400 : 240));
    }
    return finalize(positions, attr, strands, params);
  }
  throw new Error('attractor: all retries degenerate');
}
```

Note: discrete-map strands (`sinemap`) hop rather than flow — `resamplePolyline` still yields usable polygonal strands; the RDP/bezier pass in Task 12 smooths them.

- [ ] **Step 4: Write `js/generators/index.js`**

```js
import * as attractor from './attractor.js';

const REGISTRY = { attractor: attractor.generate };
// Tasks 8–11 add: chladni, radial, spectral, timbre

export function generate(fp, params, onProgress) {
  const gen = REGISTRY[params.mode];
  if (!gen) throw new Error(`unknown mode: ${params.mode}`);
  return gen(fp, params, onProgress);
}

export function registeredModes() { return Object.keys(REGISTRY); }
export { REGISTRY };
```

- [ ] **Step 5: Run tests** — `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add js/generators/attractor.js js/generators/index.js test/generators.test.js
git commit -m "feat: attractor generator family with fingerprint-driven system selection"
```

---

### Task 6: density.js — GPU log-density renderer

**Files:**
- Create: `js/density.js`
- (Browser-verified in Task 7; no node test — THREE/WebGL.)

**Interfaces:**
- Consumes: global `THREE` (r134), `buildLUT` output (Uint8Array) via `setPalette`.
- Produces: `class DensityRenderer { constructor(container); setCloud(positions, attr); setPalette(lutBytes); setParams({exposure, contrast, grain, background, scale, autoRotate}); requestRender(); clear(); getMVP() → THREE.Matrix4; renderHiRes(scaleFactor) → HTMLCanvasElement; dispose(); fallback: boolean }`. Drag-rotate + wheel-zoom built in; renders only when dirty or autoRotate > 0.

- [ ] **Step 1: Write `js/density.js`**

```js
// GPU density pipeline: additive gaussian splats into a float target,
// then log-density tonemap through a palette LUT. Global THREE (r134).

const SPLAT_VERT = `
attribute float attrv;
varying float vAttr;
uniform float uSize;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize / max(0.1, -mv.z);
  vAttr = attrv;
}`;

const SPLAT_FRAG = `
precision highp float;
varying float vAttr;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float r2 = dot(uv, uv);
  if (r2 > 0.25) discard;
  float w = exp(-r2 * 10.0);
  gl_FragColor = vec4(w, w * vAttr, 0.0, 1.0);
}`;

const TONE_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDensity;
uniform sampler2D tLUT;
uniform float uExposure, uContrast, uPeak;
uniform vec3 uBackground;
void main() {
  vec4 s = texture2D(tDensity, vUv);
  float d = s.r;
  float t = log(1.0 + d * uExposure) / log(1.0 + max(uPeak, 1.0) * uExposure);
  t = pow(clamp(t, 0.0, 1.0), uContrast);
  float attr = s.g / max(s.r, 1e-5);
  vec3 col = texture2D(tLUT, vec2(clamp(t * 0.88 + attr * 0.12, 0.0, 1.0), 0.5)).rgb;
  gl_FragColor = vec4(mix(uBackground, col, smoothstep(0.0, 0.08, t) * min(t * 1.4 + 0.25, 1.0)), 1.0);
}`;

const TONE_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class DensityRenderer {
  constructor(container) {
    this.container = container;
    this.fallback = false;
    this._dirty = true;
    this._rotY = 0; this._rotX = -0.2; this._zoom = 1;
    this._params = { exposure: 30, contrast: 1.0, grain: 1.0, background: [0.012, 0.016, 0.04], scale: 1, autoRotate: 0.3 };
    this._initGL();
    this._initDrag();
    this._loop();
  }

  _size() {
    return [this.container.clientWidth || 800, this.container.clientHeight || 600];
  }

  _initGL() {
    const [w, h] = this._size();
    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 50);
    this.camera.position.z = 3.2;
    this.scene = new THREE.Scene();
    this.group = new THREE.Group();
    this.scene.add(this.group);

    try {
      this.target = this._makeTarget(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio(), THREE.HalfFloatType);
      this.renderer.setRenderTarget(this.target);
      this.renderer.setRenderTarget(null);
    } catch (e) {
      this.fallback = true;
    }

    this.splatMat = new THREE.ShaderMaterial({
      vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG,
      uniforms: { uSize: { value: 3.0 } },
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });

    this.lutTex = new THREE.DataTexture(new Uint8Array(256 * 4).fill(255), 256, 1, THREE.RGBAFormat);
    this.lutTex.needsUpdate = true;

    this.toneScene = new THREE.Scene();
    this.toneCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.toneMat = new THREE.ShaderMaterial({
      vertexShader: TONE_VERT, fragmentShader: TONE_FRAG,
      uniforms: {
        tDensity: { value: this.target ? this.target.texture : null },
        tLUT: { value: this.lutTex },
        uExposure: { value: 30 }, uContrast: { value: 1.0 }, uPeak: { value: 60 },
        uBackground: { value: new THREE.Vector3(0.012, 0.016, 0.04) },
      },
    });
    this.toneScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.toneMat));

    window.addEventListener('resize', () => this._onResize());
  }

  _makeTarget(w, h, type) {
    return new THREE.WebGLRenderTarget(Math.floor(w), Math.floor(h), {
      type, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  _onResize() {
    const [w, h] = this._size();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    if (this.target) this.target.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this._dirty = true;
  }

  setCloud(positions, attr) {
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('attrv', new THREE.BufferAttribute(attr, 1));
    if (this.fallback) {
      const mat = new THREE.PointsMaterial({ size: 0.008, color: 0xbbaaff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
      this.points = new THREE.Points(geo, mat);
    } else {
      this.points = new THREE.Points(geo, this.splatMat);
    }
    this.points.frustumCulled = false;
    this.group.add(this.points);
    // Peak estimate: average points per pixel in the covered region, ×concentration
    const n = positions.length / 3;
    const [w, h] = this._size();
    this.toneMat.uniforms.uPeak.value = Math.max(8, (n / (w * h)) * 550);
    this._dirty = true;
  }

  setPalette(lutBytes) {
    this.lutTex.image.data.set(lutBytes);
    this.lutTex.needsUpdate = true;
    this._dirty = true;
  }

  setParams(p) {
    Object.assign(this._params, p);
    this.toneMat.uniforms.uExposure.value = this._params.exposure;
    this.toneMat.uniforms.uContrast.value = this._params.contrast;
    const bg = this._params.background;
    this.toneMat.uniforms.uBackground.value.set(bg[0], bg[1], bg[2]);
    this.splatMat.uniforms.uSize.value = 3.0 * this._params.grain;
    this.group.scale.setScalar(this._params.scale);
    this._dirty = true;
  }

  clear() {
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); this.points = null; }
    this._dirty = true;
  }

  requestRender() { this._dirty = true; }

  getMVP() {
    this.group.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    return new THREE.Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(this.group.matrixWorld);
  }

  _renderFrame(target = null) {
    this.camera.position.z = 3.2 / this._zoom;
    this.group.rotation.set(this._rotX, this._rotY, 0);
    if (this.fallback || !this.points) {
      this.renderer.setClearColor(new THREE.Color(...this._params.background), 1);
      this.renderer.setRenderTarget(target);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      return;
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.toneScene, this.toneCam);
    this.renderer.setRenderTarget(null);
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    if (this._params.autoRotate > 0 && this.points) {
      this._rotY += this._params.autoRotate * 0.004;
      this._dirty = true;
    }
    if (!this._dirty) return; // render-on-demand: idle = zero draw calls
    this._dirty = false;
    this._renderFrame();
  }

  // Hi-res export: render both passes into an offscreen RGBA8 target and read back.
  renderHiRes(scaleFactor = 3) {
    const [w, h] = this._size();
    const W = Math.floor(w * scaleFactor), H = Math.floor(h * scaleFactor);
    const bigDensity = this.fallback ? null : this._makeTarget(W, H, THREE.HalfFloatType);
    const bigOut = this._makeTarget(W, H, THREE.UnsignedByteType);
    const savedTarget = this.target;
    if (bigDensity) {
      this.target = bigDensity;
      this.toneMat.uniforms.tDensity.value = bigDensity.texture;
      // splat count per pixel drops with area → compensate peak
      const savedPeak = this.toneMat.uniforms.uPeak.value;
      this.toneMat.uniforms.uPeak.value = savedPeak / (scaleFactor * scaleFactor);
      const savedSize = this.splatMat.uniforms.uSize.value;
      this.splatMat.uniforms.uSize.value = savedSize * scaleFactor;
      this._renderFrame(bigOut);
      this.toneMat.uniforms.uPeak.value = savedPeak;
      this.splatMat.uniforms.uSize.value = savedSize;
    } else {
      this._renderFrame(bigOut);
    }
    const pixels = new Uint8Array(W * H * 4);
    this.renderer.readRenderTargetPixels(bigOut, 0, 0, W, H, pixels);
    this.target = savedTarget;
    if (this.target) this.toneMat.uniforms.tDensity.value = this.target.texture;
    if (bigDensity) bigDensity.dispose();
    bigOut.dispose();
    // Flip Y into a 2D canvas
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      img.data.set(pixels.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    this._dirty = true;
    return canvas;
  }

  _initDrag() {
    const el = this.renderer.domElement;
    let down = false, ox = 0, oy = 0, pinch0 = 0;
    const start = (x, y) => { down = true; ox = x; oy = y; };
    const move = (x, y) => {
      if (!down) return;
      this._rotY += (x - ox) * 0.007;
      this._rotX += (y - oy) * 0.005;
      ox = x; oy = y;
      this._dirty = true;
    };
    el.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', () => { down = false; });
    el.addEventListener('touchstart', e => {
      if (e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
      if (e.touches.length === 2) {
        down = false;
        pinch0 = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      }
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('touchmove', e => {
      if (e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this._zoom = Math.max(0.3, Math.min(4, this._zoom * (d / (pinch0 || d))));
        pinch0 = d;
        this._dirty = true;
      }
    });
    window.addEventListener('touchend', () => { down = false; });
    el.addEventListener('wheel', e => {
      this._zoom = Math.max(0.3, Math.min(4, this._zoom * (1 - e.deltaY * 0.001)));
      this._dirty = true;
      e.preventDefault();
    }, { passive: false });
  }

  dispose() { this.renderer.dispose(); }
}
```

- [ ] **Step 2: Commit** (browser verification happens with Task 7's integration)

```bash
git add js/density.js
git commit -m "feat: GPU log-density renderer with render-on-demand and hi-res readback"
```

---

### Task 7: worker + new main.js + new control panel (VISUAL MILESTONE)

**Files:**
- Create: `js/worker.js`
- Rewrite: `js/main.js`, controls section of `index.html`
- Delete: `js/renderer.js`
- Modify: `style.css` (only if a new class needs a rule; reuse existing classes)

**Interfaces:**
- Consumes: `AudioEngine` (Task 4), `buildFingerprint` (Task 3), `DensityRenderer` (Task 6), `generate` via worker, `PALETTES/buildLUT/customRamp/hexToRgb` (Task 1).
- Produces: working app — record → ✓ → density-rendered attractor. `window.__soundform = { params, getState() }` exposed for debugging. Mode buttons for not-yet-built generators rendered `disabled` (Tasks 8–11 enable them).

- [ ] **Step 1: Write `js/worker.js`**

```js
import { generate } from './generators/index.js?v=18';

self.onmessage = (e) => {
  const { fingerprint, params } = e.data;
  try {
    const out = generate(fingerprint, params, p => self.postMessage({ progress: p }));
    self.postMessage(
      { done: true, positions: out.positions, attr: out.attr, strands: out.strands },
      [out.positions.buffer, out.attr.buffer, ...out.strands.map(s => s.buffer)]
    );
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
```

- [ ] **Step 2: Replace the `#controls-panel` contents in `index.html`** (between `<div id="controls-panel">` and `<div class="panel-footer">`):

```html
    <div class="panel-section">
      <div class="section-title">Mode</div>
      <div id="mode-btns">
        <button class="btn-mode active" data-mode="attractor">Attractor</button>
        <button class="btn-mode" data-mode="chladni" disabled>Chladni</button>
        <button class="btn-mode" data-mode="radial" disabled>Radial</button>
        <button class="btn-mode" data-mode="spectral" disabled>Spectral</button>
        <button class="btn-mode" data-mode="timbre" disabled>Timbre</button>
      </div>
    </div>

    <div class="panel-section">
      <div class="section-title">Form</div>
      <div class="sl-row"><div class="sl-label"><span>Complexity</span><span id="val-complexity">0.5</span></div>
        <input type="range" id="sl-complexity" min="0" max="1" step="0.05" value="0.5" data-regen></div>
      <div class="sl-row"><div class="sl-label"><span>Symmetry</span><span id="val-symmetry">1</span></div>
        <input type="range" id="sl-symmetry" min="1" max="8" step="1" value="1" data-regen></div>
      <div class="sl-row"><div class="sl-label"><span>Twist</span><span id="val-twist">0</span></div>
        <input type="range" id="sl-twist" min="-2" max="2" step="0.1" value="0" data-regen></div>
      <div class="sl-row"><div class="sl-label"><span>Scale</span><span id="val-scale">1.0</span></div>
        <input type="range" id="sl-scale" min="0.3" max="2.5" step="0.05" value="1.0"></div>
    </div>

    <div class="panel-section">
      <div class="section-title">Texture</div>
      <div class="sl-row"><div class="sl-label"><span>Density</span><span id="val-density">1500000</span></div>
        <input type="range" id="sl-density" min="200000" max="4000000" step="100000" value="1500000" data-regen></div>
      <div class="sl-row"><div class="sl-label"><span>Grain</span><span id="val-grain">1.0</span></div>
        <input type="range" id="sl-grain" min="0.4" max="3" step="0.1" value="1.0"></div>
      <div class="sl-row"><div class="sl-label"><span>Strands</span><span id="val-strands">48</span></div>
        <input type="range" id="sl-strands" min="24" max="96" step="4" value="48"></div>
      <div class="sl-row"><div class="sl-label"><span>Stroke Weight</span><span id="val-weight">1.0</span></div>
        <input type="range" id="sl-weight" min="0.3" max="3" step="0.1" value="1.0"></div>
    </div>

    <div class="panel-section">
      <div class="section-title">Colour</div>
      <div class="sl-row">
        <select id="sel-palette">
          <option value="nebula" selected>Nebula</option>
          <option value="ember">Ember</option>
          <option value="aurora">Aurora</option>
          <option value="glacier">Glacier</option>
          <option value="rosegold">Rosé</option>
          <option value="custom">Custom…</option>
        </select>
      </div>
      <div id="manual-colors" class="color-pickers faded">
        <label class="color-pick-label">Low<input type="color" id="col-primary" value="#b8a7e0"></label>
        <label class="color-pick-label">Mid<input type="color" id="col-secondary" value="#e8b4c8"></label>
        <label class="color-pick-label">High<input type="color" id="col-accent" value="#fff2e0"></label>
      </div>
      <label class="color-pick-label">Background<input type="color" id="col-background" value="#03040a"></label>
      <div class="sl-row"><div class="sl-label"><span>Exposure</span><span id="val-exposure">30</span></div>
        <input type="range" id="sl-exposure" min="2" max="200" step="1" value="30"></div>
      <div class="sl-row"><div class="sl-label"><span>Contrast</span><span id="val-contrast">1.0</span></div>
        <input type="range" id="sl-contrast" min="0.4" max="2.5" step="0.05" value="1.0"></div>
    </div>

    <div class="panel-section">
      <div class="section-title">Motion</div>
      <div class="sl-row"><div class="sl-label"><span>Auto-rotate</span><span id="val-rot-speed">0.3</span></div>
        <input type="range" id="sl-rot-speed" min="0" max="2" step="0.05" value="0.3"></div>
    </div>
```

Also in `index.html`: bump `js/main.js?v=17` → `?v=18` and add a minimal `<select>` rule to `style.css` if selects are unstyled: `#controls-panel select { width: 100%; background: #10131f; color: #dde; border: 1px solid #2a2f45; border-radius: 6px; padding: 6px; }`.

- [ ] **Step 3: Rewrite `js/main.js`:**

```js
import { AudioEngine } from './audio.js?v=18';
import { buildFingerprint } from './features.js?v=18';
import { DensityRenderer } from './density.js?v=18';
import { PALETTES, buildLUT, customRamp, hexToRgb } from './palettes.js?v=18';
import { exportCanvas, exportStrandSVG } from './exporter.js?v=18';

const audio = new AudioEngine();
let renderer = null;
let worker = null;

let appState = 'blank'; // 'blank' | 'recording' | 'recorded' | 'captured'
let frames = [];
let recordStart = 0;
let fingerprint = null;
let design = null; // { positions, attr, strands }

const isMobile = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent);

const params = {
  mode: 'attractor',
  complexity: 0.5, symmetry: 1, twist: 0, scale: 1.0,
  density: isMobile ? 500000 : 1500000,
  grain: 1.0, strandCount: 48, strokeWeight: 1.0,
  palette: 'nebula',
  colorPrimary: '#b8a7e0', colorSecondary: '#e8b4c8', colorAccent: '#fff2e0',
  background: '#03040a',
  exposure: 30, contrast: 1.0, autoRotate: 0.3,
};

let statusEl, vuFill, vuWrap, clearBtn, submitBtn;

window.addEventListener('DOMContentLoaded', () => {
  renderer = new DensityRenderer(document.getElementById('renderer-container'));
  statusEl = document.getElementById('status-bar');
  vuFill = document.getElementById('vu-fill');
  vuWrap = document.getElementById('vu-wrap');
  clearBtn = document.getElementById('btn-clear');
  submitBtn = document.getElementById('btn-submit');
  applyColorParams();
  bindAudio();
  bindControls();
  bindExport();
  if (renderer.fallback) setStatus('Note: reduced quality mode (float buffers unsupported)');
  captureLoop();
  window.__soundform = { params, getState: () => ({ appState, fingerprint, design }) };
});

function captureLoop() {
  requestAnimationFrame(captureLoop);
  if (audio.active && appState === 'recording') {
    const f = audio.getMusicalFrame();
    if (f) {
      if (vuFill) vuFill.style.height = Math.min(100, f.rms * 300) + '%';
      if (f.rms > 0.005) frames.push(f);
    }
  }
}

// ── Generation ────────────────────────────────────────────────────
function regenerate() {
  if (!fingerprint) return;
  setStatus('Generating…');
  const payload = { fingerprint: { ...fingerprint, chroma: fingerprint.chroma, contour: fingerprint.contour },
                    params: { mode: params.mode, density: params.density, complexity: params.complexity,
                              symmetry: params.symmetry, twist: params.twist, strandCount: 96 } };
  const onResult = (out) => {
    design = out;
    renderer.setCloud(out.positions, out.attr);
    applyRenderParams();
    setStatus('Design created — drag to rotate · adjust sliders · 🗑️ to reset');
  };
  try {
    if (!worker) worker = new Worker('js/worker.js?v=18', { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.progress !== undefined) setStatus(`Generating… ${Math.round(e.data.progress * 100)}%`);
      else if (e.data.error) setStatus(`Generation error: ${e.data.error}`);
      else if (e.data.done) onResult(e.data);
    };
    worker.onerror = () => { worker = null; fallbackGenerate(onResult); };
    worker.postMessage(payload);
  } catch {
    fallbackGenerate(onResult);
  }
}

async function fallbackGenerate(onResult) {
  const { generate } = await import('./generators/index.js?v=18');
  onResult(generate(fingerprint, { ...params, strandCount: 96 }));
}

// ── Params → renderer ─────────────────────────────────────────────
function activeStops() {
  return params.palette === 'custom'
    ? customRamp(params.background, params.colorPrimary, params.colorSecondary, params.colorAccent)
    : PALETTES[params.palette].stops;
}

function applyColorParams() {
  renderer.setPalette(buildLUT(activeStops()));
  applyRenderParams();
}

function applyRenderParams() {
  renderer.setParams({
    exposure: params.exposure, contrast: params.contrast, grain: params.grain,
    background: hexToRgb(params.background), scale: params.scale, autoRotate: params.autoRotate,
  });
}

// ── Audio flow (same UX as before) ────────────────────────────────
function bindAudio() {
  const btnMic = document.getElementById('btn-mic');
  const lblFile = document.getElementById('lbl-file');
  const fileInput = document.getElementById('file-input');
  const btnStop = document.getElementById('btn-stop');

  btnMic.addEventListener('click', async () => {
    if (appState === 'recorded') audio.stop();
    try {
      setStatus('Requesting microphone…');
      await audio.startMic();
      enterRecording(btnStop);
    } catch (e) { setStatus(`Microphone error: ${e.message}`); }
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      setStatus(`Loading ${file.name}…`);
      await audio.loadFile(file);
      enterRecording(btnStop);
      setStatus(`Recording from "${file.name}" — press ⏹ when done`);
    } catch (e) { setStatus(`File error: ${e.message}`); }
    fileInput.value = '';
  });

  btnStop.addEventListener('click', () => {
    if (appState !== 'recording') return;
    audio.stop();
    appState = 'recorded';
    btnMic.classList.remove('hidden');
    lblFile.classList.add('hidden');
    btnStop.classList.add('hidden');
    submitBtn.classList.remove('hidden');
    vuWrap.classList.add('hidden');
    setStatus('Done — press ✓ to create design, or 🎤 to re-record');
  });

  submitBtn.addEventListener('click', () => {
    if (frames.length === 0) { setStatus('No audio captured — try recording again'); return; }
    fingerprint = buildFingerprint(frames, (performance.now() - recordStart) / 1000);
    appState = 'captured';
    submitBtn.classList.add('hidden');
    document.getElementById('btn-mic').classList.add('hidden');
    document.getElementById('lbl-file').classList.add('hidden');
    clearBtn.classList.remove('hidden');
    regenerate();
  });

  clearBtn.addEventListener('click', () => {
    fingerprint = null; design = null; frames = [];
    appState = 'blank';
    audio.stop();
    renderer.clear();
    document.getElementById('btn-mic').classList.remove('hidden');
    document.getElementById('lbl-file').classList.remove('hidden');
    document.getElementById('btn-stop').classList.add('hidden');
    submitBtn.classList.add('hidden');
    clearBtn.classList.add('hidden');
    vuWrap.classList.add('hidden');
    setStatus('Ready — press 🎤 to record or 📁 to upload');
  });
}

function enterRecording(btnStop) {
  appState = 'recording';
  frames = [];
  recordStart = performance.now();
  document.getElementById('btn-mic').classList.add('hidden');
  document.getElementById('lbl-file').classList.add('hidden');
  btnStop.classList.remove('hidden');
  submitBtn.classList.add('hidden');
  clearBtn.classList.add('hidden');
  vuWrap.classList.remove('hidden');
  setStatus('Recording… press ⏹ when done');
}

// ── Controls ──────────────────────────────────────────────────────
function bindControls() {
  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      params.mode = btn.dataset.mode;
      document.querySelectorAll('.btn-mode').forEach(b => b.classList.toggle('active', b === btn));
      if (appState === 'captured') regenerate();
    });
  });

  // [id, param key, parse, needsRegen]
  const sliders = [
    ['sl-complexity', 'complexity', parseFloat, true],
    ['sl-symmetry', 'symmetry', parseInt, true],
    ['sl-twist', 'twist', parseFloat, true],
    ['sl-scale', 'scale', parseFloat, false],
    ['sl-density', 'density', parseInt, true],
    ['sl-grain', 'grain', parseFloat, false],
    ['sl-strands', 'strandCount', parseInt, false],
    ['sl-weight', 'strokeWeight', parseFloat, false],
    ['sl-exposure', 'exposure', parseFloat, false],
    ['sl-contrast', 'contrast', parseFloat, false],
    ['sl-rot-speed', 'autoRotate', parseFloat, false],
  ];
  sliders.forEach(([id, key, parse, regen]) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id.replace('sl-', 'val-'));
    el.addEventListener('input', () => {
      params[key] = parse(el.value);
      if (valEl) valEl.textContent = el.value;
      if (!regen) applyRenderParams();
    });
    // regen sliders rebuild geometry only on release (change), not on drag
    if (regen) el.addEventListener('change', () => { if (appState === 'captured') regenerate(); });
  });

  document.getElementById('sel-palette').addEventListener('change', (e) => {
    params.palette = e.target.value;
    document.getElementById('manual-colors').classList.toggle('faded', params.palette !== 'custom');
    applyColorParams();
  });
  [['col-primary', 'colorPrimary'], ['col-secondary', 'colorSecondary'],
   ['col-accent', 'colorAccent'], ['col-background', 'background']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('input', (e) => {
      params[key] = e.target.value;
      applyColorParams();
    });
  });
}

// ── Export ────────────────────────────────────────────────────────
function bindExport() {
  document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const fmt = btn.dataset.fmt;
        if (fmt === 'svg') {
          if (!design) { setStatus('Create a design first'); return; }
          const svg = exportStrandSVG({
            strands: design.strands.slice(0, params.strandCount),
            positions: design.positions,
            mvp: renderer.getMVP().elements,
            width: 1600, height: 1200,
            stops: activeStops(), background: params.background,
            weight: params.strokeWeight,
          });
          const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          const a = Object.assign(document.createElement('a'), { href: url, download: 'soundform.svg' });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        } else {
          const canvas = renderer.renderHiRes(fmt === 'pdf' ? 2 : 3);
          await exportCanvas(canvas, fmt);
        }
      } catch (e) { setStatus(`Export error: ${e.message}`); }
    });
  });
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
```

Note: `exportStrandSVG` doesn't exist until Task 13 — add a temporary export in `js/exporter.js` NOW so the module resolves:

```js
export function exportStrandSVG() { throw new Error('SVG export arrives in a later task'); }
```

- [ ] **Step 4: Delete `js/renderer.js`** — `git rm js/renderer.js`.

- [ ] **Step 5: Browser verification (the visual milestone).**
Run `python3 -m http.server 8000`, open `http://localhost:8000`. Record 3–5 s of humming or play music near the mic → ⏹ → ✓. Expected: a glowing, silky attractor in Nebula purples on near-navy — layered translucent structure, not discrete dots. Verify: drag rotates; Exposure/Contrast/Grain sliders respond instantly; Complexity/Symmetry/Twist/Density regenerate on slider release with progress %; PNG export downloads a 3× image matching the screen; recording the same hum twice gives the same form. Verify with two different sounds (a hum vs a clap rhythm) → clearly different designs.

- [ ] **Step 6: Commit**

```bash
git add index.html style.css js/main.js js/worker.js js/exporter.js
git rm --cached js/renderer.js 2>/dev/null; git add -A
git commit -m "feat: density pipeline live — worker generation, new controls, attractor mode"
```

---

### Task 8: generators/chladni.js

**Files:**
- Create: `js/generators/chladni.js`
- Modify: `js/generators/index.js` (register), `index.html` (remove `disabled` from Chladni button), `test/generators.test.js` (add case)

**Interfaces:**
- Consumes: `mulberry32`, `finalize` from `./common.js`.
- Produces: `generate(fp, params, onProgress)` — registered as `chladni`.

- [ ] **Step 1: Add failing test** to `test/generators.test.js`:

```js
test('chladni generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('chladni');
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test` (unknown mode: chladni).

- [ ] **Step 3: Write `js/generators/chladni.js`**

```js
import { mulberry32, finalize } from './common.js';

// 3D standing-wave interference on a sphere, sampled with soft acceptance
// around nodal surfaces (exp falloff) → silky bands instead of hard dots.
// Each active note maps directly to a (m, n) wave-mode pair.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));

  const modes = fp.noteSet.map((pc, idx) => ({
    m: 1 + (pc % 6) + Math.round(params.complexity * 4),
    n: 2 + Math.floor(pc / 2) + idx + Math.round(fp.centroid * 3),
    amp: fp.chroma[pc],
    idx,
  }));
  const field = (theta, phi) => {
    let f = 0, domIdx = 0, domAmp = 0;
    for (const md of modes) {
      const v = (Math.sin(md.m * theta) * Math.cos(md.n * phi)
               + Math.sin(md.n * theta) * Math.cos(md.m * phi)) * md.amp;
      f += v;
      if (Math.abs(v) > domAmp) { domAmp = Math.abs(v); domIdx = md.idx; }
    }
    return { f, domIdx };
  };

  const sigma = 0.04 + fp.spread * 0.05; // band softness
  const positions = new Float32Array(N * 3);
  const attr = new Float32Array(N);
  let count = 0, guard = 0;
  while (count < N && guard < N * 40) {
    guard++;
    const theta = Math.acos(2 * rnd() - 1);
    const phi = rnd() * Math.PI * 2;
    const { f, domIdx } = field(theta, phi);
    if (rnd() > Math.exp(-((f / sigma) ** 2))) continue; // accept near nodes
    const R = 1 + (rnd() - 0.5) * 0.02 * (1 + fp.velocity * 3); // shell thickness ← velocity
    const st = Math.sin(theta);
    positions[count * 3] = st * Math.cos(phi) * R;
    positions[count * 3 + 1] = Math.cos(theta) * R;
    positions[count * 3 + 2] = st * Math.sin(phi) * R;
    attr[count] = (domIdx / Math.max(1, modes.length - 1)) * 0.7 + Math.min(0.3, Math.abs(f) * 3);
    count++;
    if (onProgress && count % 200000 === 0) onProgress(count / N);
  }

  // Strands: nodal contours via marching squares on a (theta, phi) grid
  const strands = marchNodalContours(field, Math.max(24, Math.min(96, params.strandCount || 96)));
  return finalize(positions.subarray(0, count * 3).slice(), attr.subarray(0, count).slice(), strands, params);
}

function marchNodalContours(field, want) {
  const T = 128, P = 256;
  const grid = new Float32Array(T * P);
  for (let i = 0; i < T; i++) for (let j = 0; j < P; j++) {
    grid[i * P + j] = field((i / (T - 1)) * Math.PI, (j / (P - 1)) * Math.PI * 2).f;
  }
  const segs = [];
  for (let i = 0; i < T - 1; i++) for (let j = 0; j < P - 1; j++) {
    const a = grid[i * P + j], b = grid[i * P + j + 1], c = grid[(i + 1) * P + j];
    const pts = [];
    if (a * b < 0) pts.push([i, j + Math.abs(a) / (Math.abs(a) + Math.abs(b))]);
    if (a * c < 0) pts.push([i + Math.abs(a) / (Math.abs(a) + Math.abs(c)), j]);
    if (pts.length === 2) segs.push(pts);
  }
  // Greedy chaining of segments into polylines
  const chains = [];
  const used = new Set();
  for (let s = 0; s < segs.length && chains.length < want * 2; s++) {
    if (used.has(s)) continue;
    used.add(s);
    const chain = [segs[s][0], segs[s][1]];
    let grew = true;
    while (grew && chain.length < 400) {
      grew = false;
      const tail = chain[chain.length - 1];
      for (let t = 0; t < segs.length; t++) {
        if (used.has(t)) continue;
        for (const end of [0, 1]) {
          const d = Math.hypot(segs[t][end][0] - tail[0], segs[t][end][1] - tail[1]);
          if (d < 2.5) { used.add(t); chain.push(segs[t][1 - end]); grew = true; break; }
        }
        if (grew) break;
      }
    }
    if (chain.length >= 12) chains.push(chain);
  }
  chains.sort((x, y) => y.length - x.length);
  return chains.slice(0, want).map(chain => {
    const out = new Float32Array(chain.length * 3);
    chain.forEach(([gi, gj], idx) => {
      const theta = (gi / 127) * Math.PI, phi = (gj / 255) * Math.PI * 2;
      const st = Math.sin(theta);
      out[idx * 3] = st * Math.cos(phi);
      out[idx * 3 + 1] = Math.cos(theta);
      out[idx * 3 + 2] = st * Math.sin(phi);
    });
    return out;
  });
}
```

- [ ] **Step 4: Register in `js/generators/index.js`:** add `import * as chladni from './chladni.js';` and `chladni: chladni.generate` to `REGISTRY`.

- [ ] **Step 5: Run tests** — `npm test` — Expected: PASS. If the strand count assertion fails (fewer than 24 contours for simple note sets), pad in `marchNodalContours` by also emitting every chain ≥ 6 points before the length sort.

- [ ] **Step 6: Enable the mode button** — remove `disabled` from the Chladni button in `index.html`. Browser-check: record a hum → switch to Chladni → silky spherical bands.

- [ ] **Step 7: Commit**

```bash
git add js/generators/chladni.js js/generators/index.js index.html test/generators.test.js
git commit -m "feat: chladni generator — nodal-surface density with contour strands"
```

---

### Task 9: generators/radial.js

**Files:**
- Create: `js/generators/radial.js`
- Modify: `js/generators/index.js`, `index.html` (enable button), `test/generators.test.js`

**Interfaces:** same generator signature; registered as `radial`.

- [ ] **Step 1: Add failing test:** `test('radial generator', () => { checkGenerator('radial'); });` — run, verify FAIL.

- [ ] **Step 2: Write `js/generators/radial.js`**

```js
import { mulberry32, finalize, resamplePolyline } from './common.js';

// Orbital ribbon shells. Each shell is a tilted, harmonically deformed orbit;
// points scatter in a gaussian tube around it so overlaps build luminous cores.
// Consonant sound → golden-angle even interleaving; dissonant → seed-clustered tilts.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const shells = Math.max(6, Math.round(6 + fp.noteCount * 2 + fp.volMean * 10 + params.complexity * 12));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const perShell = Math.floor(N / shells);

  const positions = new Float32Array(perShell * shells * 3);
  const attr = new Float32Array(perShell * shells);
  const strands = [];
  let w = 0;

  for (let s = 0; s < shells; s++) {
    const tS = s / Math.max(1, shells - 1);
    const lobes = 2 + (fp.noteSet[s % fp.noteCount] % 5) + Math.round(params.complexity * 3);
    const baseR = 0.35 + tS * 0.75;
    const wobble = 0.08 + fp.pitchRange * 0.3;
    const tiltA = fp.consonance > 0.5 ? s * golden : rnd() * Math.PI * 2;
    const tiltB = fp.consonance > 0.5 ? tS * Math.PI * 0.8 : rnd() * Math.PI;
    const ca = Math.cos(tiltA), sa = Math.sin(tiltA), cb = Math.cos(tiltB), sb = Math.sin(tiltB);
    const tube = 0.015 + fp.velocity * 0.05 + tS * 0.01;
    const phase = fp.contour[s % 8] * Math.PI * 2;

    const orbit = (t) => {
      const th = t * Math.PI * 2;
      const r = baseR * (1 + wobble * Math.sin(lobes * th + phase));
      const x0 = Math.cos(th) * r, y0 = Math.sin(lobes * th * 0.5 + phase) * wobble * 1.6, z0 = Math.sin(th) * r;
      // rotate around Y by tiltA then around X by tiltB
      const x1 = x0 * ca + z0 * sa, z1 = -x0 * sa + z0 * ca;
      return [x1, y0 * cb - z1 * sb, y0 * sb + z1 * cb];
    };

    for (let i = 0; i < perShell; i++) {
      const [x, y, z] = orbit(rnd());
      positions[w * 3] = x + (rnd() - 0.5) * tube * 2;
      positions[w * 3 + 1] = y + (rnd() - 0.5) * tube * 2;
      positions[w * 3 + 2] = z + (rnd() - 0.5) * tube * 2;
      attr[w] = tS;
      w++;
    }
    if (onProgress && s % 8 === 0) onProgress(s / shells);

    const raw = new Float32Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const [x, y, z] = orbit(i / 255);
      raw[i * 3] = x; raw[i * 3 + 1] = y; raw[i * 3 + 2] = z;
    }
    strands.push(resamplePolyline(raw, 200));
  }
  // Duplicate shells' centrelines with slight offsets until strand budget met
  while (strands.length < Math.min(96, params.strandCount || 96)) {
    const src = strands[strands.length % shells];
    const copy = src.slice();
    for (let i = 0; i < copy.length; i++) copy[i] += (rnd() - 0.5) * 0.02;
    strands.push(copy);
  }
  return finalize(positions, attr, strands, params);
}
```

- [ ] **Step 3: Register** in `index.js`, run `npm test` → PASS, enable Radial button in `index.html`, browser-check (luminous interleaved shells).

- [ ] **Step 4: Commit**

```bash
git add js/generators/radial.js js/generators/index.js index.html test/generators.test.js
git commit -m "feat: radial generator — orbital ribbon shells with harmony-driven interleave"
```

---

### Task 10: generators/spectral.js

**Files:**
- Create: `js/generators/spectral.js`
- Modify: `js/generators/index.js`, `index.html`, `test/generators.test.js`

**Interfaces:** same signature; registered as `spectral`.

- [ ] **Step 1: Add failing test:** `test('spectral generator', () => { checkGenerator('spectral'); });` — verify FAIL.

- [ ] **Step 2: Write `js/generators/spectral.js`**

```js
import { mulberry32, finalize, resamplePolyline } from './common.js';

// Harmonic helix: each active note spirals a glowing filament at its
// pitch-class angle; chords braid into columns. Filament brightness ← chroma.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const turns = 1.5 + params.complexity * 2.5 + fp.pitchRange * 1.5;
  const H = 2.2;
  const filaments = [];
  for (const pc of fp.noteSet) {
    // 3 octave copies of each note for depth
    for (let oct = 0; oct < 3; oct++) filaments.push({ pc, oct, amp: fp.chroma[pc] * (1 - oct * 0.25) });
  }
  const perFil = Math.floor(N / filaments.length);
  const positions = new Float32Array(perFil * filaments.length * 3);
  const attr = new Float32Array(perFil * filaments.length);
  const strands = [];
  let w = 0;

  filaments.forEach((fil, fi) => {
    const angle0 = (fil.pc / 12) * Math.PI * 2;
    const braid = fp.consonance * 0.25; // consonant chords braid toward each other
    const jitter = 0.02 + fp.velocity * 0.06;
    const path = (t) => {
      const y = (t - 0.5) * H + fil.oct * 0.12;
      const ang = angle0 + t * Math.PI * 2 * turns;
      const r = 0.55 + 0.18 * Math.sin(t * Math.PI * (2 + fil.oct)) - braid * Math.sin(t * Math.PI);
      return [Math.cos(ang) * r, y, Math.sin(ang) * r];
    };
    for (let i = 0; i < perFil; i++) {
      const t = rnd();
      const [x, y, z] = path(t);
      positions[w * 3] = x + (rnd() - 0.5) * jitter;
      positions[w * 3 + 1] = y + (rnd() - 0.5) * jitter;
      positions[w * 3 + 2] = z + (rnd() - 0.5) * jitter;
      attr[w] = Math.min(1, fil.amp);
      w++;
    }
    const raw = new Float32Array(300 * 3);
    for (let i = 0; i < 300; i++) {
      const [x, y, z] = path(i / 299);
      raw[i * 3] = x; raw[i * 3 + 1] = y; raw[i * 3 + 2] = z;
    }
    strands.push(resamplePolyline(raw, 260));
    if (onProgress) onProgress(fi / filaments.length);
  });

  while (strands.length < Math.min(96, params.strandCount || 96)) {
    const src = strands[strands.length % filaments.length].slice();
    for (let i = 0; i < src.length; i++) src[i] += (rnd() - 0.5) * 0.03;
    strands.push(src);
  }
  return finalize(positions, attr, strands, params);
}
```

- [ ] **Step 3: Register, test PASS, enable button, browser-check** (braided glowing columns; a chord shows multiple braided filaments).

- [ ] **Step 4: Commit**

```bash
git add js/generators/spectral.js js/generators/index.js index.html test/generators.test.js
git commit -m "feat: spectral generator — note filaments braided into harmonic helix"
```

---

### Task 11: generators/timbre.js

**Files:**
- Create: `js/generators/timbre.js`
- Modify: `js/generators/index.js`, `index.html`, `test/generators.test.js`, `js/main.js`, `js/worker.js`

**Interfaces:** same signature; registered as `timbre`. **Needs the frame trajectory:** fingerprint alone isn't enough — main.js must pass `fp.trajectory` (built below) through to the worker.

- [ ] **Step 1: Add trajectory to the fingerprint.** In `js/main.js` `submitBtn` handler, after `fingerprint = buildFingerprint(...)`:

```js
    fingerprint.trajectory = new Float32Array(frames.length * 3);
    frames.forEach((f, i) => {
      fingerprint.trajectory[i * 3] = f.centroid;
      fingerprint.trajectory[i * 3 + 1] = f.rms;
      fingerprint.trajectory[i * 3 + 2] = f.spread;
    });
```

(Float32Array survives structured clone to the worker.)

- [ ] **Step 2: Add failing test** — in `test/generators.test.js`:

```js
test('timbre generator', () => {
  const fp = testFingerprint();
  fp.trajectory = new Float32Array(300);
  for (let i = 0; i < 100; i++) {
    fp.trajectory[i * 3] = 0.3 + 0.2 * Math.sin(i / 9);
    fp.trajectory[i * 3 + 1] = 0.2 + 0.15 * Math.sin(i / 5);
    fp.trajectory[i * 3 + 2] = 0.3 + 0.1 * Math.cos(i / 7);
  }
  checkGenerator('timbre', fp);
});
```

Run → FAIL.

- [ ] **Step 3: Write `js/generators/timbre.js`**

```js
import { mulberry32, finalize, resamplePolyline } from './common.js';

// The recording's journey through (centroid, rms, spread) space as a ribbon
// bundle: tube radius & density grow where the sound dwelt (slow trajectory).
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));
  const traj = fp.trajectory && fp.trajectory.length >= 12
    ? fp.trajectory
    : new Float32Array([...Array(60)].flatMap((_, i) => [0.3 + 0.2 * Math.sin(i / 6), 0.25 + 0.1 * Math.sin(i / 4), 0.3]));

  const M = 512;
  const center = resamplePolyline(smooth(traj, 5), M);
  // expand around mean to fill space
  for (let i = 0; i < center.length; i += 3) {
    center[i] = (center[i] - 0.4) * 3.2;
    center[i + 1] = (center[i + 1] - 0.25) * 3.2;
    center[i + 2] = (center[i + 2] - 0.3) * 3.2;
  }

  // dwell = inverse local speed
  const dwell = new Float32Array(M);
  let dMax = 1e-6;
  for (let i = 1; i < M; i++) {
    const sp = Math.hypot(center[i * 3] - center[(i - 1) * 3], center[i * 3 + 1] - center[(i - 1) * 3 + 1], center[i * 3 + 2] - center[(i - 1) * 3 + 2]);
    dwell[i] = 1 / (sp + 0.002);
    dMax = Math.max(dMax, dwell[i]);
  }
  dwell[0] = dwell[1];
  for (let i = 0; i < M; i++) dwell[i] /= dMax;

  const positions = new Float32Array(N * 3);
  const attr = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = Math.floor(rnd() * (M - 1));
    const rad = (0.02 + dwell[t] * 0.14) * (0.6 + params.complexity);
    positions[i * 3] = center[t * 3] + (rnd() - 0.5) * rad * 2;
    positions[i * 3 + 1] = center[t * 3 + 1] + (rnd() - 0.5) * rad * 2;
    positions[i * 3 + 2] = center[t * 3 + 2] + (rnd() - 0.5) * rad * 2;
    attr[i] = t / (M - 1); // palette follows time
    if (onProgress && i % 300000 === 0) onProgress(i / N);
  }

  // Strands: the centreline plus offset tube lines
  const want = Math.max(24, Math.min(96, params.strandCount || 96));
  const strands = [resamplePolyline(center, 300)];
  for (let s = 1; s < want; s++) {
    const phase = rnd() * Math.PI * 2, freq = 1 + Math.floor(rnd() * 3);
    const copy = new Float32Array(300 * 3);
    const rs = resamplePolyline(center, 300);
    for (let i = 0; i < 300; i++) {
      const dw = dwell[Math.floor((i / 299) * (M - 1))];
      const rad = (0.02 + dw * 0.14) * (0.6 + params.complexity);
      copy[i * 3] = rs[i * 3] + Math.cos(phase + i * 0.05 * freq) * rad;
      copy[i * 3 + 1] = rs[i * 3 + 1] + Math.sin(phase + i * 0.05 * freq) * rad;
      copy[i * 3 + 2] = rs[i * 3 + 2] + Math.cos(phase * 1.7 + i * 0.04 * freq) * rad;
    }
    strands.push(copy);
  }
  return finalize(positions, attr, strands, params);
}

function smooth(arr, win) {
  const n = arr.length / 3;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < 3; d++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) { s += arr[j * 3 + d]; c++; }
      out[i * 3 + d] = s / c;
    }
  }
  return out;
}
```

- [ ] **Step 4: Register, `npm test` → PASS, enable Timbre button.** Browser-check: hum with a swell → thick glowing knot where you held the note.

- [ ] **Step 5: Commit**

```bash
git add js/generators/timbre.js js/generators/index.js index.html js/main.js test/generators.test.js
git commit -m "feat: timbre generator — dwell-weighted ribbon bundle through sound-space"
```

---

### Task 12: strands.js — projection, simplification, bezier fitting

**Files:**
- Create: `js/strands.js`, `test/strands.test.js`

**Interfaces:**
- Produces: `projectStrand(strand, mvpElements, w, h) → {pts: number[][2], depth}` (clip-space filtered), `rdp(pts, epsilon) → number[][2]`, `toBezierPath(pts) → string` (SVG `d`), `buildDensityGrid(positions, res=24) → {sample(x,y,z) → 0..1}`.
- Consumes (Task 13): all of the above.

- [ ] **Step 1: Write the failing test** — `test/strands.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStrand, rdp, toBezierPath, buildDensityGrid } from '../js/strands.js';

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

test('projectStrand maps clip space to pixels', () => {
  const strand = new Float32Array([0, 0, 0, 0.5, 0.5, 0]);
  const { pts } = projectStrand(strand, IDENTITY, 100, 100);
  assert.deepEqual(pts[0], [50, 50]);
  assert.deepEqual(pts[1], [75, 25]); // y flips
});

test('rdp keeps endpoints, drops collinear points', () => {
  const line = [[0, 0], [1, 0.001], [2, 0], [3, 5], [4, 0]];
  const out = rdp(line, 0.5);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[out.length - 1], [4, 0]);
  assert.ok(out.length < line.length);
  assert.ok(out.some(p => p[1] === 5)); // keeps the spike
});

test('toBezierPath emits M + C commands', () => {
  const d = toBezierPath([[0, 0], [10, 10], [20, 0], [30, 10]]);
  assert.ok(d.startsWith('M'));
  assert.ok(d.includes('C'));
});

test('density grid: dense region samples higher than empty', () => {
  const pos = new Float32Array(3000);
  for (let i = 0; i < 1000; i++) { // cluster at origin
    pos[i * 3] = (i % 10) * 0.01; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0;
  }
  const g = buildDensityGrid(pos, 16);
  assert.ok(g.sample(0.05, 0, 0) > g.sample(0.9, 0.9, 0.9));
});
```

- [ ] **Step 2: Run to verify FAIL.**

- [ ] **Step 3: Write `js/strands.js`**

```js
// Strand → editable SVG path machinery. DOM/THREE-free (works under node).

export function projectStrand(strand, m, w, h) {
  const pts = [];
  let depthSum = 0, count = 0;
  for (let i = 0; i < strand.length; i += 3) {
    const x = strand[i], y = strand[i + 1], z = strand[i + 2];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 1e-6) continue;
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
    const cz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / cw;
    if (cz < -1 || cz > 1) continue;
    pts.push([(cx + 1) * 0.5 * w, (1 - cy) * 0.5 * h]);
    depthSum += cz; count++;
  }
  return { pts, depth: count ? depthSum / count : 1 };
}

// Ramer–Douglas–Peucker, iterative (stack), epsilon in pixels.
export function rdp(pts, epsilon) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Catmull-Rom → cubic bezier SVG path.
export function toBezierPath(pts) {
  if (pts.length < 2) return '';
  const f = v => +v.toFixed(1);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d;
}

// Coarse 3D occupancy grid over [-1.3, 1.3]³, max-normalised.
export function buildDensityGrid(positions, res = 24) {
  const grid = new Float32Array(res * res * res);
  const idx = v => Math.max(0, Math.min(res - 1, Math.floor((v + 1.3) / 2.6 * res)));
  const step = Math.max(1, Math.floor(positions.length / 3 / 300000)); // sample big clouds
  let max = 1e-9;
  for (let i = 0; i < positions.length; i += 3 * step) {
    const g = (idx(positions[i]) * res + idx(positions[i + 1])) * res + idx(positions[i + 2]);
    grid[g]++;
    if (grid[g] > max) max = grid[g];
  }
  return {
    sample(x, y, z) {
      return grid[(idx(x) * res + idx(y)) * res + idx(z)] / max;
    },
  };
}
```

- [ ] **Step 4: Run tests** — `npm test` — PASS.

- [ ] **Step 5: Commit**

```bash
git add js/strands.js test/strands.test.js
git commit -m "feat: strand projection, RDP simplification, bezier fitting, density grid"
```

---

### Task 13: exporter.js — structured SVG + raster export fix

**Files:**
- Modify: `js/exporter.js` (replace the Task 7 stub with the real `exportStrandSVG`; keep `exportCanvas`)
- Create: `test/exporter.test.js`

**Interfaces:**
- Consumes: `projectStrand`, `rdp`, `toBezierPath`, `buildDensityGrid` from `./strands.js`; `sampleRamp`, `rgbToHex` from `./palettes.js`.
- Produces: `exportStrandSVG({strands, positions, mvp, width, height, stops, background, weight}) → string` — the signature main.js (Task 7) already calls.

- [ ] **Step 1: Write the failing test** — `test/exporter.test.js`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportStrandSVG } from '../js/exporter.js';

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

function fixture() {
  const strands = [];
  for (let s = 0; s < 48; s++) {
    const st = new Float32Array(200 * 3);
    for (let i = 0; i < 200; i++) {
      const t = i / 199;
      st[i * 3] = Math.cos(t * 6 + s) * 0.6;
      st[i * 3 + 1] = (t - 0.5) * 1.4;
      st[i * 3 + 2] = Math.sin(t * 6 + s) * 0.6;
    }
    strands.push(st);
  }
  const positions = new Float32Array(30000);
  for (let i = 0; i < 10000; i++) {
    positions[i * 3] = Math.cos(i) * 0.6; positions[i * 3 + 1] = (i / 10000 - 0.5); positions[i * 3 + 2] = Math.sin(i) * 0.6;
  }
  return { strands, positions, mvp: IDENTITY, width: 1600, height: 1200,
           stops: [[0, '#050614'], [0.5, '#9d5bd2'], [1, '#ffffff']], background: '#03040a', weight: 1 };
}

test('exportStrandSVG: valid structure, named editable groups', () => {
  const svg = exportStrandSVG(fixture());
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('id="strand-01"'));
  assert.ok(svg.includes('id="strand-48"'));
  assert.ok(svg.includes('<path'));
  assert.ok(svg.includes('linearGradient'));
  assert.ok(!svg.includes('<circle')); // no dot spam
});

test('exportStrandSVG: under 1MB budget', () => {
  const svg = exportStrandSVG(fixture());
  assert.ok(svg.length < 1_000_000, `size ${svg.length}`);
});

test('exportStrandSVG: deterministic', () => {
  assert.equal(exportStrandSVG(fixture()), exportStrandSVG(fixture()));
});
```

- [ ] **Step 2: Run to verify FAIL** (stub throws).

- [ ] **Step 3: Replace the stub in `js/exporter.js`** (keep `exportCanvas`, `_onBlack`, `_dl` as-is):

```js
import { projectStrand, rdp, toBezierPath, buildDensityGrid } from './strands.js?v=18';
import { sampleRamp, rgbToHex } from './palettes.js?v=18';

// Structured vector export: one named group per strand, real bezier paths,
// density-driven stroke weight/opacity, palette gradient along each path.
export function exportStrandSVG({ strands, positions, mvp, width, height, stops, background, weight }) {
  const grid = buildDensityGrid(positions);
  const items = [];

  strands.forEach((strand, si) => {
    const { pts, depth } = projectStrand(strand, mvp, width, height);
    if (pts.length < 4) return;
    const simplified = rdp(pts, 1.4);
    if (simplified.length < 4 || simplified.length > 300) return;
    // mean local 3D density along the strand
    let dSum = 0, dN = 0;
    for (let i = 0; i < strand.length; i += 30) {
      dSum += grid.sample(strand[i], strand[i + 1], strand[i + 2]); dN++;
    }
    const density = dN ? dSum / dN : 0.3;
    items.push({ si, depth, density, d: toBezierPath(simplified),
                 x1: simplified[0][0], y1: simplified[0][1],
                 x2: simplified[simplified.length - 1][0], y2: simplified[simplified.length - 1][1] });
  });

  items.sort((a, b) => b.depth - a.depth); // far strands first (painter's order)

  const defs = [], groups = [];
  items.forEach((it, order) => {
    const id = String(order + 1).padStart(2, '0');
    const c1 = rgbToHex(sampleRamp(stops, 0.35 + it.density * 0.3));
    const c2 = rgbToHex(sampleRamp(stops, 0.6 + it.density * 0.4));
    defs.push(
      `    <linearGradient id="grad-${id}" gradientUnits="userSpaceOnUse" x1="${it.x1.toFixed(1)}" y1="${it.y1.toFixed(1)}" x2="${it.x2.toFixed(1)}" y2="${it.y2.toFixed(1)}">` +
      `<stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`);
    const sw = ((0.6 + it.density * 3.4) * weight).toFixed(2);
    const op = (0.35 + it.density * 0.55).toFixed(2);
    groups.push(
      `  <g id="strand-${id}">\n` +
      `    <path d="${it.d}" fill="none" stroke="url(#grad-${id})" stroke-width="${sw}" stroke-linecap="round" opacity="${op}"/>\n` +
      `  </g>`);
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect id="background" width="${width}" height="${height}" fill="${background}"/>`,
    '  <defs>',
    ...defs,
    '  </defs>',
    ...groups,
    '</svg>',
  ].join('\n');
}
```

- [ ] **Step 4: Run tests** — `npm test` — PASS.

- [ ] **Step 5: Browser verification of ALL export buttons.** Serve, create a design, then: PNG → 4800×3600 image matching screen; JPG/WebP same; PDF downloads; SVG downloads → open the file in a browser tab (crisp flowing strands echoing the design's structure, gradient colours), and if available drop it into Figma: it must import as editable vector layers named `strand-01`…, not a flattened image.

- [ ] **Step 6: Commit**

```bash
git add js/exporter.js test/exporter.test.js
git commit -m "feat: structured strand SVG export with gradients and named layers"
```

---

### Task 14: polish, cross-device pass, final verification

**Files:**
- Modify: `js/density.js` (fallback verification), `index.html` (footer text), `docs/superpowers/specs/…` (no change — checklist only)

- [ ] **Step 1: Full test suite** — `npm test` — Expected: all tests PASS (palettes, common, features, 5 generators, strands, exporter).

- [ ] **Step 2: Determinism end-to-end check.** In the browser console after creating a design: `__soundform.getState().fingerprint.seed` — clear, re-submit the same recording is impossible via mic, so instead: upload the same audio file twice, create designs, compare seeds — they must be equal and the design visually identical.

- [ ] **Step 3: Reference comparison.** Load the three reference images side-by-side with the app. Check: layered translucent silk structure ✓ log-density brightness (bright cores, wispy passes) ✓ near-black navy background ✓ Nebula palette in the purple/pink family ✓. Tune `SPLAT_FRAG` gaussian width (10.0) and default exposure only if clearly off.

- [ ] **Step 4: Performance check.** Desktop: default 1.5M density, drag-rotate must feel smooth (~60fps). Check devtools Performance tab for main-thread stalls during generation (should be none — worker). Set density 4M → still interactive. Mobile check (or devtools device emulation + throttle): defaults drop to 500k.

- [ ] **Step 5: Fallback check.** In devtools console run with `webgl` forced… simplest: temporarily set `this.fallback = true` in the DensityRenderer constructor, reload, confirm the app still shows a legible additive-points design and the status note appears. Revert.

- [ ] **Step 6: Update footer** in `index.html`: `🎤 Record → ⏹ Stop → ✓ Create · Drag to rotate · Same sound, same design`.

- [ ] **Step 7: Commit + push**

```bash
git add -A
git commit -m "polish: cross-device defaults, fallback verification, footer"
git push -u origin density-redesign
```

- [ ] **Step 8: User acceptance.** Ask the user to try it (serve locally or via GitHub Pages preview on the branch) with their own voice/music and the reference images at hand, and to drop an exported SVG into Figma/Illustrator. Only after their sign-off: merge to `main` (which deploys to GitHub Pages).

---

## Self-review notes

- **Spec coverage:** §4 fingerprint → Task 3; §5 renderer/fallback/on-demand/hi-res → Task 6; §6 five modes → Tasks 5, 8–11; §7 strands/SVG → Tasks 12–13; §8 controls (incl. removals) → Task 7; §9 tests → per-task + Task 14; §10 risks (retry loop Task 5, fallback Task 6/14, <1MB Task 13, branch isolation throughout). Old `renderer.js` deleted in Task 7. Raster export fix (`renderHiRes`) Task 6 + wired Task 7.
- **Type consistency:** generator signature `{positions, attr, strands}` uniform; `exportStrandSVG` signature identical in Task 7 (call) and Task 13 (definition); `attrv` attribute name matches splat shader; fingerprint fields consumed by generators all exist in Task 3's return.
- **Known judgment calls:** `uPeak` is estimated analytically rather than by GPU readback (simpler, adjustable via Exposure); discrete-map strands are polygonal before bezier smoothing; Timbre needs `fp.trajectory` which only main.js can supply (documented in Task 11).
