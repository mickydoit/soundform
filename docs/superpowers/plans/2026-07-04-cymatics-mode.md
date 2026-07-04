# Cymatics Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Spectral with the water-mandala Cymatics generator per `docs/superpowers/specs/2026-07-04-cymatics-mode-design.md`.

**Architecture:** One new pure generator module implementing superposed membrane standing waves with amplitude-proportional Monte Carlo sampling; registry/button/test swap. Single task — the pieces are inseparable (registry swap without the module breaks the app).

**Tech Stack:** Vanilla ES module; existing `common.js` utilities; `node --test`.

## Global Constraints

- Attractor (js/generators/attractor.js) and density renderer are LOCKED — do not touch.
- Generator contract: `generate(fp, params, onProgress) → {positions: Float32Array, attr∈[0,1], strands: Float32Array[]}`, deterministic via `mulberry32(fp.seed)`, bounded ~[-1.1,1.1] via `finalize`, ≥ density·0.5 points, ≥24 finite strands.
- Branch `cymatics`.

### Task 1: cymatics.js + swap + test

**Files:** Create `js/generators/cymatics.js` · Delete `js/generators/spectral.js` · Modify `js/generators/index.js`, `index.html`, `test/generators.test.js`

- [ ] **Step 1 (failing test):** in `test/generators.test.js`, replace `test('spectral generator', …)` with `test('cymatics generator', () => { checkGenerator('cymatics'); });` — run `npm test`, expect FAIL (`unknown mode: cymatics`).

- [ ] **Step 2:** create `js/generators/cymatics.js`:

```js
import { mulberry32, finalize, resamplePolyline } from './common.js';

// Water-mandala cymatics: standing waves on a circular membrane.
// Each detected note = one (m petals, ring wavenumber) mode; modes superpose
// into an interference field. Points survive where |amplitude| is high, so
// crests glow under the log-density tonemap. Radial profile is a damped
// cosine — a visually faithful stand-in for Bessel J_m modes.
export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const k = Math.max(1, Math.round(params.symmetry || 1));
  const N = Math.max(1000, Math.floor(params.density / k));

  const kBase = 6 + fp.pitchMedian * 10 + params.complexity * 8;
  const detune = (1 - fp.consonance) * 0.9;
  const modes = fp.noteSet.map((pc, idx) => ({
    m: 2 + (pc % 7) + Math.round(params.complexity * 3),
    kr: kBase * (0.55 + 0.45 * ((idx + 1) / fp.noteCount)),
    amp: Math.max(0.15, fp.chroma[pc]),
    phase: detune * rnd() * Math.PI * 2,
  }));

  const field = (r, th) => {
    let f = 0;
    for (const md of modes) {
      f += md.amp * (Math.cos(md.kr * r - md.m * 0.5) / Math.sqrt(1 + md.kr * r * 0.5))
                  * Math.cos(md.m * th + md.phase);
    }
    return f;
  };

  let fMax = 1e-6;
  for (let i = 0; i < 4000; i++) {
    const a = Math.abs(field(Math.sqrt(rnd()), rnd() * Math.PI * 2));
    if (a > fMax) fMax = a;
  }

  const relief = 0.22 + fp.volMean * 0.25;
  const spray = fp.velocity * 0.015;
  const positions = new Float32Array(N * 3);
  const attr = new Float32Array(N);
  let count = 0, guard = 0;
  while (count < N && guard < N * 30) {
    guard++;
    const r = Math.sqrt(rnd());
    const th = rnd() * Math.PI * 2;
    const f = field(r, th) / fMax;
    const af = Math.min(1, Math.abs(f));
    if (rnd() > Math.max(Math.pow(af, 1.4), 0.08)) continue;
    positions[count * 3] = Math.cos(th) * r;
    positions[count * 3 + 1] = f * relief + (rnd() + rnd() - 1) * spray * af;
    positions[count * 3 + 2] = Math.sin(th) * r;
    attr[count] = af;
    count++;
    if (onProgress && count % 250000 === 0) onProgress(count / N);
  }

  // Strands: crest rings (petal-modulated circles) + radial spokes.
  const want = Math.max(24, Math.min(96, params.strandCount || 96));
  const rings = Math.min(want, 12 + Math.round(params.complexity * 8));
  const strands = [];
  for (let ri = 0; ri < rings; ri++) {
    const r0 = (ri + 0.5) / rings;
    const pts = new Float32Array(220 * 3);
    for (let i = 0; i < 220; i++) {
      const th = (i / 219) * Math.PI * 2;
      const f = field(r0, th) / fMax;
      pts[i * 3] = Math.cos(th) * r0;
      pts[i * 3 + 1] = f * relief;
      pts[i * 3 + 2] = Math.sin(th) * r0;
    }
    strands.push(resamplePolyline(pts, 200));
  }
  for (let si = 0; strands.length < want; si++) {
    const th0 = (si / Math.max(1, want - rings)) * Math.PI * 2;
    const pts = new Float32Array(160 * 3);
    for (let i = 0; i < 160; i++) {
      const r = i / 159;
      const f = field(r, th0) / fMax;
      pts[i * 3] = Math.cos(th0) * r;
      pts[i * 3 + 1] = f * relief;
      pts[i * 3 + 2] = Math.sin(th0) * r;
    }
    strands.push(resamplePolyline(pts, 140));
  }
  return finalize(positions.subarray(0, count * 3).slice(), attr.subarray(0, count).slice(), strands, params);
}
```

- [ ] **Step 3:** `js/generators/index.js`: replace the spectral import/registry entry with `import * as cymatics from './cymatics.js';` / `cymatics: cymatics.generate`. Delete `js/generators/spectral.js` (`git rm`).

- [ ] **Step 4:** `index.html`: `<button class="btn-mode" data-mode="spectral">Spectral</button>` → `<button class="btn-mode" data-mode="cymatics">Cymatics</button>`.

- [ ] **Step 5:** `npm test` → all green (35 tests: spectral test replaced 1:1). Fill-ratio note: acceptance floor 0.08 with 30× guard keeps count ≥ density·0.5.

- [ ] **Step 6:** Serve + browser check (mandala top-down, relief on tilt, crisp), then commit:
`git add -A && git commit -m "feat: cymatics mode — membrane standing-wave mandala (replaces spectral)"`

**Self-review:** spec mapping table → modes/kBase/relief/detune/spray lines; sampling & floor → Step 2 acceptance; strands rings+spokes → Step 2; integration list → Steps 3–4; locked files untouched.
