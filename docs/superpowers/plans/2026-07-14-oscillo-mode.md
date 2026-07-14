# Oscillo Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Timbre with Oscillo — a waveform mandala drawing the recording's timeline as concentric wave-rings on a shallow dome.

**Architecture:** New generator `js/generators/oscillo.js` reads `fp.trajectory` (extended to 4 channels: centroid, rms, spread, pitchNorm) and emits one ring strand per time-slice. Timbre is deleted exactly as Chladni was. Capture-side change: `js/main.js` trajectory build gains a pitch channel + `trajectoryChannels: 4` marker.

**Tech Stack:** Vanilla ES modules, node:test.

**Spec:** `docs/superpowers/specs/2026-07-14-oscillo-mode-design.md`

## Global Constraints

- Branch `oscillo`, created after export-settings merges. Attractor/Cymatics/Harmonic/Radial and `js/density.js` untouched.
- Standard generator contract (bounded, ≥ density/2 points, attr ∈ [0,1], ≥24 strands, deterministic, finite).
- Missing / empty / 3-channel trajectory → smooth concentric circles, no crash.
- Cache bump v=28 → v=29 at ship. User waived manual gates (2026-07-14): ship after automated verification.

---

### Task 1: Oscillo generator (TDD)

**Files:**
- Create: `js/generators/oscillo.js`
- Modify: `js/generators/index.js` (add oscillo import + registry entry; keep timbre until Task 2)
- Test: `test/generators.test.js` (append)

**Interfaces:**
- Consumes: `mulberry32`, `finalize`, `resamplePolyline` from `./common.js`; `fp.trajectory` (Float32Array, 4 ch/frame when `fp.trajectoryChannels === 4`, else 3), `fp.seed`; params `density`, `complexity`, `symmetry`, `twist`.
- Produces: `generate(fp, params, onProgress)` — standard contract.

- [ ] **Step 1: Failing tests** — append to `test/generators.test.js`:

```js
function testTrajectory({ rms = 0.2, pitch = 0.5, n = 120 } = {}) {
  const t = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { t[i * 4] = 0.4; t[i * 4 + 1] = rms; t[i * 4 + 2] = 0.15; t[i * 4 + 3] = pitch; }
  return t;
}

test('oscillo generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('oscillo', testFingerprint({ trajectory: testTrajectory(), trajectoryChannels: 4 }));
});

test('oscillo: loud vs quiet trajectory → different geometry', () => {
  const params = { ...baseParams, mode: 'oscillo' };
  const loud = generate(testFingerprint({ trajectory: testTrajectory({ rms: 0.35 }), trajectoryChannels: 4 }), params);
  const quiet = generate(testFingerprint({ trajectory: testTrajectory({ rms: 0.02 }), trajectoryChannels: 4 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(loud.positions[i] - quiet.positions[i]);
  assert.ok(diff > 0.5, `loudness must shape the rings (diff=${diff})`);
});

test('oscillo: pitch changes ring wave count → different geometry', () => {
  const params = { ...baseParams, mode: 'oscillo' };
  const lo = generate(testFingerprint({ trajectory: testTrajectory({ pitch: 0.1 }), trajectoryChannels: 4 }), params);
  const hi = generate(testFingerprint({ trajectory: testTrajectory({ pitch: 0.9 }), trajectoryChannels: 4 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(lo.positions[i] - hi.positions[i]);
  assert.ok(diff > 0.5, 'pitch must change the wave pattern');
});

test('oscillo: missing trajectory → finite smooth circles, no crash', () => {
  const out = generate(testFingerprint(), { ...baseParams, mode: 'oscillo' });
  for (let i = 0; i < 300; i++) assert.ok(Number.isFinite(out.positions[i]));
  assert.ok(out.strands.length >= 24);
});
```

- [ ] **Step 2:** `npm test` → FAIL (unknown mode: oscillo).

- [ ] **Step 3: Create `js/generators/oscillo.js`:**

```js
import { mulberry32, finalize, resamplePolyline } from './common.js';

// Waveform mandala: the recording's timeline as concentric rings on a shallow
// watch-glass dome — time spirals outward, each ring one moment. Wave cycles
// come from that moment's pitch, amplitude from loudness, fray from spectral
// spread. The sound is legible centre → rim like tree rings.

// Linear-interpolated read of the trajectory at normalized time t.
// Returns [centroid, rms, spread, pitch]; 3-channel legacy shapes get pitch 0.
function frameAt(traj, ch, t) {
  const n = Math.floor(traj.length / ch);
  if (n === 0) return [0.4, 0, 0.15, 0];
  const x = Math.min(n - 1, Math.max(0, t * (n - 1)));
  const i = Math.floor(x), f = x - i, j = Math.min(n - 1, i + 1);
  const read = (idx, c) => (c < ch ? traj[idx * ch + c] : 0);
  const out = [];
  for (let c = 0; c < 4; c++) out.push(read(i, c) + (read(j, c) - read(i, c)) * f);
  return out;
}

export function generate(fp, params, onProgress) {
  const rnd = mulberry32(fp.seed);
  const N = Math.max(1000, Math.floor(params.density));
  const traj = fp.trajectory && fp.trajectory.length >= 3 ? fp.trajectory : null;
  const ch = fp.trajectoryChannels === 4 ? 4 : 3;

  const rings = 90 + Math.round((params.complexity || 0.5) * 90); // 90..180
  const perRing = Math.max(30, Math.floor(N / rings));
  const total = perRing * rings;
  const positions = new Float32Array(total * 3);
  const attr = new Float32Array(total);
  const strands = [];
  const domeH = 0.35;
  const jit = 0.0035;
  let w = 0;

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
    if (onProgress && i % 16 === 0) onProgress(i / rings);
  }
  return finalize(positions, attr, strands, params);
}
```

Register in `js/generators/index.js`: `import * as oscillo from './oscillo.js';` and add `oscillo: oscillo.generate` to REGISTRY.

- [ ] **Step 4:** `npm test` → PASS. If the flat-disc `std` check in `checkGenerator` fails (degenerate y-axis), that's expected to pass since x+z std dominate; if bounded fails, reduce `amp` factor 0.35 → 0.3.
- [ ] **Step 5:** Commit: `feat: oscillo mode — waveform mandala from the recording timeline`

---

### Task 2: Remove Timbre + capture pitch channel + ship

**Files:**
- Delete: `js/generators/timbre.js`
- Modify: `js/generators/index.js`, `index.html` (mode button timbre → oscillo), `js/main.js` (trajectory build, ~line 176)
- Test: `test/generators.test.js` (remove timbre tests, add removal test)

- [ ] **Step 1: Tests first** — delete any `test('timbre...` blocks; add:

```js
test('timbre removed, oscillo registered', () => {
  assert.ok(!registeredModes().includes('timbre'));
  assert.ok(registeredModes().includes('oscillo'));
});
```

`npm test` → FAIL (timbre still registered).

- [ ] **Step 2: Remove** — delete the timbre import + registry entry in `js/generators/index.js`; `git rm js/generators/timbre.js`; in `index.html` replace the timbre button with `<button class="btn-mode" data-mode="oscillo">Oscillo</button>`; `grep -rn timbre js test index.html` → only the removal test remains.

- [ ] **Step 3: Capture pitch channel** — in `js/main.js` (submitBtn handler, ~line 176) replace the trajectory build with:

```js
    fingerprint.trajectory = new Float32Array(frames.length * 4);
    fingerprint.trajectoryChannels = 4;
    frames.forEach((f, i) => {
      fingerprint.trajectory[i * 4] = f.centroid;
      fingerprint.trajectory[i * 4 + 1] = f.rms;
      fingerprint.trajectory[i * 4 + 2] = f.spread;
      fingerprint.trajectory[i * 4 + 3] = f.pitchHz > 0 && f.pitchConf > 0.5
        ? Math.min(1, Math.max(0, Math.log2(f.pitchHz / 55) / 6)) : 0;
    });
```

- [ ] **Step 4:** `npm test` + `node --check js/main.js` → PASS.
- [ ] **Step 5: Ship** — bump v=28 → v=29, commit, merge to main, `npm test` on merge, push, verify live serves v=29, delete branch.

---

## Final verification

- [ ] Full suite green on merged main; live serves v=29; mode row = Attractor / Radial / Cymatics / Harmonic / Oscillo.
