import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, registeredModes } from '../js/generators/index.js';
import { pickSystem, pickSystemLive } from '../js/generators/attractor.js';
import { sphericalY, makeValueNoise3, recipe } from '../js/generators/harmonic.js';
import { mulberry32 } from '../js/generators/common.js';
import { padStrands } from '../js/generators/radial.js';
import { toneRuns } from '../js/generators/cymatics.js';
import { buildFingerprint, buildTrajectory } from '../js/features.js';

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

// halvorsen is the continuous flow system; clifford is the 2D discrete map.
const SYSTEM_IS_FLOW = new Set(['halvorsen']);
const ALL_SYSTEMS = ['halvorsen', 'clifford'];
// Fingerprints that route to each system. Routing is on vocal register:
// pitchMedian below REGISTER_SPLIT (0.257, ~160 Hz) gives halvorsen.
const LOW_PITCH = { pitchMedian: 0.15 };
const HIGH_PITCH = { pitchMedian: 0.60 };

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
  for (const s of out.strands) {
    const arr = s.pts ?? s;
    for (let i = 0; i < arr.length; i += 1) assert.ok(Number.isFinite(arr[i]), `${mode}: non-finite strand value`);
  }
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

test('attractor: pickSystem routing table', () => {
  // Two systems, split on vocal register at pitchMedian 0.257 (~160 Hz).
  assert.equal(pickSystem(testFingerprint({ pitchMedian: 0.10 })), 'halvorsen');
  assert.equal(pickSystem(testFingerprint({ pitchMedian: 0.25 })), 'halvorsen');
  assert.equal(pickSystem(testFingerprint({ pitchMedian: 0.30 })), 'clifford');
  assert.equal(pickSystem(testFingerprint({ pitchMedian: 0.90 })), 'clifford');
  // harmony no longer routes: the same notes at different registers differ
  const tonal = { consonance: 0.8, majorLeaning: true, noteCount: 3 };
  assert.notEqual(pickSystem(testFingerprint({ ...tonal, pitchMedian: 0.1 })),
                  pickSystem(testFingerprint({ ...tonal, pitchMedian: 0.9 })));
});


test('attractor: both systems bounded, non-degenerate, deterministic', () => {
  const routingFingerprints = {
    halvorsen: testFingerprint(LOW_PITCH),
    clifford: testFingerprint(HIGH_PITCH),
  };
  const seeds = [1, 123456789, 987654321];
  for (const [name, fp] of Object.entries(routingFingerprints)) {
    assert.equal(pickSystem(fp), name, `routing fixture mismatch for ${name}`);
    for (const seed of seeds) checkGenerator('attractor', { ...fp, seed });
  }
});


// Regression repros for the strand-finiteness fix: these coefficient/seed
// combinations continue past a clean cloud into a strand-phase escape for
// polynomial flow systems — the cloud passes validateFinalized, but the
// ~134k-Euler-step strand extension goes non-finite. Before the fix:
// halvorsen-routing seed 143 → 50/96 non-finite strands; the dissonant-routing
// seed-41 fixture originally hit this on the (since-replaced) dadras system and
// now exercises the same guard on lorenz. checkGenerator asserts every strand
// value is finite, so these must pass post-fix.
test('attractor: strand-phase escape repros stay finite after retry', () => {
  const halvorsenEscape = testFingerprint({ pitchMedian: 0.20, seed: 143 });
  assert.equal(pickSystem(halvorsenEscape), 'halvorsen');
  checkGenerator('attractor', halvorsenEscape);

  const cliffordEscape = testFingerprint({ pitchMedian: 1, centroid: 0, spread: 0.904, volMean: 0.03, seed: 41 });
  assert.equal(pickSystem(cliffordEscape), 'clifford');
  checkGenerator('attractor', cliffordEscape);
});

test('attractor: low-pitch thomas routing does not collapse to a limit cycle', () => {
  // pitchMedian 0 → max damping; pre-fix this yielded a single 1D loop
  const fp = testFingerprint({ pitchMedian: 0, contour: new Float32Array(8) });
  const out = generate(fp, { ...baseParams, density: 30000 });
  const cells = new Set();
  const n = out.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const gx = Math.floor((out.positions[i*3]     + 1.3) / 2.6 * 20);
    const gy = Math.floor((out.positions[i*3 + 1] + 1.3) / 2.6 * 20);
    const gz = Math.floor((out.positions[i*3 + 2] + 1.3) / 2.6 * 20);
    cells.add((gx * 20 + gy) * 20 + gz);
  }
  assert.ok(cells.size >= 400, `occupied cells ${cells.size} — looks like a limit cycle`);
});

// Cell-occupancy Jaccard overlap between a low-complexity and a
// high-complexity render of the SAME locked system/voice. Low overlap means
// complexity visibly reshaped the design; overlap near 1 means the lever did
// nothing (a no-op complexify()/spread formula reads this way, ~0.987-1.000
// measured across systems — see the per-system tests below).
function complexityJaccard(fp, system, params = {}) {
  const p = { ...baseParams, density: 30000, liveVariance: true, lockedSystem: system, ...params };
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
  return inter / (lo.size + hi.size - inter);
}

// One discriminating test per flow system, each parameterized over all six
// SPEAKERS voices — not just 'male calm' locked to aizawa, which is all the
// previous version of this test covered. A single-fixture test let a defect
// (a lever that's a no-op for every voice but one) hide behind a lucky pick.
//
// The ceiling is per-system. thomas/halvorsen/lorenz all measure comfortably
// under the project's usual 0.85 "barely changed the form" bar across all six
// voices. aizawa does not: its only lever is the `d` coefficient, and its
// sensitivity to `d` is nonuniform across the coefficient's own range — measured
// across cap values 0.30-0.50 (relative-to-endpoint push) and again with an
// alternative additive-displacement push (0.10-0.25), no single cap gets every
// one of the six voices under 0.85 without pushing another voice's `d` across
// a bifurcation (male calm's cell occupancy collapses toward a limit-cycle-
// adjacent regime past roughly a 35% push). 0.90 for aizawa is still far
// short of the no-op baseline (0.987-0.993, see the verification note below)
// and still requires the design to visibly change for every voice — it is a
// deliberately honest bound, not the project's usual 0.85, because 0.85 is
// not achievable here without trading this defect for the aizawa fallback
// regression this whole lever was tuned to avoid.
//
// Verified (then reverted) that every test below fails under a no-op lever:
// stubbing complexify() to `(v) => v` drove thomas/aizawa/lorenz to
// 0.993-0.996 / 0.987-0.993 / 0.996-1.000 across all six voices (all well
// over their ceilings here); halvorsen doesn't call complexify() at all — it
// has its own `spread` formula — so it was neutralized separately by pinning
// `spread` to its cx=0.5 midpoint, which drove it to 0.898-0.978 (also over
// its ceiling). All four tests failed as expected in both cases.
for (const [system, ceiling] of [['halvorsen', 0.85], ['clifford', 0.85]]) {
  test(`attractor live: complexity changes the form — ${system}, all voices`, () => {
    for (const [voice, cfg] of Object.entries(SPEAKERS)) {
      const fp = speechFingerprint(cfg);
      const jac = complexityJaccard(fp, system);
      assert.ok(jac < ceiling,
        `${system}/${voice}: complexity barely changed the form (overlap ${jac.toFixed(3)}, want < ${ceiling})`);
      // but it must remain the SAME attractor, not a different one
      assert.ok(jac > 0.15,
        `${system}/${voice}: complexity changed the form beyond recognition (overlap ${jac.toFixed(3)})`);
    }
  });
}

// This task's complexity lever (liveCoeffs' `cx` param / complexify()) is
// structurally unreachable from the capture path: `sys.liveCoeffs` is only
// ever called inside the `if (sys.flow && arch)` branch, and `arch` is null
// whenever `liveVariance` isn't requested. So there is no complexity value
// that can make THIS task's mechanism leak into a capture.
//
// It is tempting to prove that by varying complexity between two capture
// calls and asserting byte-identical output — but on this codebase that
// assertion is false for most fingerprints, and always has been, for TWO
// reasons unrelated to this task (both confirmed with `git log -S` and by
// checking they're outside every diff this task touches):
//  1. Flow systems (thomas/halvorsen/aizawa/lorenz) run their capture-path
//     coefficients through `excursion = 0.5 + params.complexity` jitter
//     (the `else if (sys.flow)` branch), present since the very first
//     attractor commit (22c015e), applied unconditionally on every attempt.
//  2. EVERY system, flow or discrete, adds `jitter = fp.velocity * 0.012 *
//     (0.5 + params.complexity) * (...)` to every position — also from
//     22c015e, also unconditional.
// Neither was ever caught because every other test in this suite uses
// baseParams' fixed complexity: 0.5 throughout, so varying it was never
// exercised before this task's tests.
//
// The provable invariant is narrower: with fp.velocity = 0 (zeroing #2) and
// routing to sinemap (sidestepping #1, since sinemap never takes the
// sys.flow branch), capture output is untouched by complexity either way —
// that is what this test proves.
test('attractor: complexity lever does not leak into capture', () => {
  // clifford is the discrete map: the capture path applies no excursion
  // multiplier to it, and velocity 0 zeroes jitter, so capture output is
  // genuinely complexity-invariant for this fixture.
  const fp = testFingerprint({ ...HIGH_PITCH, velocity: 0 });
  assert.equal(pickSystem(fp), 'clifford');
  const a = generate(fp, { ...baseParams, density: 30000, complexity: 0.1 });
  const b = generate(fp, { ...baseParams, density: 30000, complexity: 0.9 });
  assert.deepEqual([...a.positions.slice(0, 300)], [...b.positions.slice(0, 300)]);
});

test('radial generator', () => {
  checkGenerator('radial');
});

// SVG export picks strands at a fixed stride (main.js: all[Math.floor(i*step)])
// from design.strands. radial.js only ever generates `shells` unique orbit
// centrelines and fills the rest of the strand budget with duplicates — if
// that padding repeats them in strict round-robin order, its period equals
// `shells`, and a stride sharing a factor with `shells` samples the same
// subset of shells forever, silently dropping the others from the export
// while the on-screen point cloud still renders all of them.
test('radial: padded strand budget survives fixed-stride export sampling', () => {
  // Sweep shell counts (even/odd/prime-sharing) and UI strandCount choices
  // (mirroring main.js's `want`), across several seeds, to prove coverage
  // holds generally rather than for one lucky case.
  for (const shells of [6, 12, 22, 30]) {
    for (const want of [24, 48, 72, 96]) {
      if (want < shells) continue; // fewer picks than shells: full coverage is impossible by definition
      const target = 96;
      const base = Array.from({ length: shells }, (_, k) => Float32Array.of(k, k, k));
      for (const seed of [1, 2, 3]) {
        const strands = padStrands(base, target, mulberry32(seed));
        assert.equal(strands.length, target);
        const step = target / want;
        const picked = [];
        for (let i = 0; i < want; i++) picked.push(strands[Math.floor(i * step)]);
        const identities = new Set(picked.map((s) => Math.round(s[0])));
        assert.equal(identities.size, shells,
          `shells=${shells} want=${want} seed=${seed}: export sample only covered ${identities.size}/${shells} shells`);
      }
    }
  }
});

test('cymatics generator', () => {
  checkGenerator('cymatics');
});

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

test('harmonic generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('harmonic');
});

test('harmonic: sphericalY known values', () => {
  // Y_0^0 = 1/(2√pI) everywhere
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

test('chladni mode is removed', () => {
  assert.ok(!registeredModes().includes('chladni'));
});

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

test('harmonic recipe: mesh always keeps >=55% of the point budget', () => {
  const worst = recipe(testFingerprint({ velocity: 1, attackSlope: 1, spread: 1 }), baseParams);
  assert.ok(worst.meshPts >= baseParams.density * 0.55, `mesh starved: ${worst.meshPts}`);
  assert.ok(worst.rings >= 24 && worst.rings <= 48);
  assert.ok(worst.lons >= 16 && worst.lons <= 32);
});

test('harmonic generate: percussive fp emits ray strands beyond the mesh', () => {
  const params = { ...baseParams, mode: 'harmonic' };
  const perc = generate(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), params);
  const hum = generate(testFingerprint({ velocity: 0.05, attackSlope: 0.1 }), params);
  const plan = recipe(testFingerprint({ velocity: 0.7, attackSlope: 0.8 }), params);
  assert.equal(perc.strands.length - hum.strands.length >= plan.nRays - 5, true,
    `ray strands missing: perc=${perc.strands.length} hum=${hum.strands.length} rays=${plan.nRays}`);
});

test('harmonic generate: organic — no rotational symmetry', () => {
  // The old vase was near-symmetric under phi -> phi + pi. Interference + noise
  // must break that: sample the displacement via strand radii at opposite phi.
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

test('timbre removed, oscillo registered', () => {
  assert.ok(!registeredModes().includes('timbre'));
  assert.ok(registeredModes().includes('oscillo'));
});

test('cymatics: speech prosody (contour) shapes the membrane radially', () => {
  const params = { ...baseParams, mode: 'cymatics' };
  const speech = generate(testFingerprint({ contour: Float32Array.from([0.1, 0.9, 0.2, 0.8, 0.1, 0.9, 0.2, 0.8]) }), params);
  const flat = generate(testFingerprint({ contour: new Float32Array(8).fill(0.45) }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(speech.positions[i] - flat.positions[i]);
  assert.ok(diff > 1, `contour must shape the field (diff=${diff})`);
});

test('cymatics: atonal input (low consonance) → different mode character', () => {
  const params = { ...baseParams, mode: 'cymatics' };
  const atonal = generate(testFingerprint({ consonance: 0.05 }), params);
  const tonal = generate(testFingerprint({ consonance: 0.95 }), params);
  let diff = 0;
  for (let i = 0; i < 300; i++) diff += Math.abs(atonal.positions[i] - tonal.positions[i]);
  assert.ok(diff > 1, `consonance must change mode character (diff=${diff})`);
});

test('cymatics styles: scope/sand/relief are completely different, all valid', () => {
  const fp = testFingerprint();
  const outs = {};
  for (const style of ['scope', 'sand', 'relief']) {
    const out = generate(fp, { ...baseParams, mode: 'cymatics', cymStyle: style });
    assert.ok(out.positions.length / 3 >= baseParams.density * 0.5, `${style}: too few points`);
    for (let i = 0; i < 300; i++) assert.ok(Number.isFinite(out.positions[i]), `${style}: non-finite`);
    for (const v of out.attr.slice(0, 300)) assert.ok(v >= 0 && v <= 1, `${style}: attr out of range`);
    outs[style] = out;
  }
  const pairs = [['scope', 'sand'], ['sand', 'relief'], ['scope', 'relief']];
  for (const [a, b] of pairs) {
    let diff = 0;
    for (let i = 0; i < 300; i++) diff += Math.abs(outs[a].positions[i] - outs[b].positions[i]);
    assert.ok(diff > 1, `${a} vs ${b} must differ (diff=${diff})`);
  }
});

test('cymatics style auto: deterministic seed-based pick', () => {
  const fp = testFingerprint();
  const a = generate(fp, { ...baseParams, mode: 'cymatics', cymStyle: 'auto' });
  const b = generate(fp, { ...baseParams, mode: 'cymatics', cymStyle: 'auto' });
  assert.deepEqual([...a.positions.slice(0, 300)], [...b.positions.slice(0, 300)]);
});

// ── Live form families ────────────────────────────────────────────
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

// Shared helper: mean L1 distance between two clouds' radial histograms —
// a cheap "different shape" metric for the live-variance tests.
export function shapeDistance(mode, fpA, fpB) {
  const params = { ...baseParams, mode, density: 30000, liveVariance: true };
  const a = generate(fpA, params), b = generate(fpB, params);
  const hist = (out) => {
    const h = new Float64Array(16); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]);
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

test('oscillo: live archetypes produce measurably different geometry', () => {
  // Ribbon (whistle/bright) vs mandala (music/tonal) vs arcs (speech/rough).
  assert.ok(shapeDistance('oscillo', FP_MUSIC(), FP_WHISTLE()) > 0.15);
  assert.ok(shapeDistance('oscillo', FP_MUSIC(), FP_SPEECH()) > 0.12);
  checkGenerator('oscillo', testFingerprint());
});

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

test('attractor: liveVariance output valid and differs from non-live', () => {
  const fp = FP_SPEECH(); // high wildness
  const live = generate(fp, { ...baseParams, density: 30000, liveVariance: true });
  const base = generate(fp, { ...baseParams, density: 30000 });
  let maxAbs = 0, s = 0;
  const n = live.positions.length / 3;
  for (let i = 0; i < live.positions.length; i++) maxAbs = Math.max(maxAbs, Math.abs(live.positions[i]));
  for (let i = 0; i < n; i++) s += live.positions[i * 3] ** 2 / n;
  assert.ok(maxAbs <= 2.5 && Math.sqrt(s) > 0.05, 'live attractor stays valid');
  let diff = 0;
  const m = Math.min(live.positions.length, base.positions.length);
  for (let i = 0; i < m; i += 300) diff += Math.abs(live.positions[i] - base.positions[i]);
  assert.ok(diff > 0.5, 'live coefficients actually shift the trajectory');
});

// Live attractor variety: speech-like and percussive windows must not
// collapse into the same sinemap web (root cause of "two designs swapping").
test('attractor live: percussive vs speech windows differ in shape', () => {
  // Same system (sinemap), so radial histograms are blind to the difference —
  // compare 3D cell occupancy instead. Steady-sound pairs overlap ~0.95;
  // genuinely different characters must fall well below that.
  const cellsOf = (fp) => {
    const out = generate(fp, { ...baseParams, density: 30000, liveVariance: true });
    const s = new Set(); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const gx = Math.min(19, Math.max(0, Math.floor((out.positions[i * 3] + 1.3) / 2.6 * 20)));
      const gy = Math.min(19, Math.max(0, Math.floor((out.positions[i * 3 + 1] + 1.3) / 2.6 * 20)));
      const gz = Math.min(19, Math.max(0, Math.floor((out.positions[i * 3 + 2] + 1.3) / 2.6 * 20)));
      s.add((gx * 20 + gy) * 20 + gz);
    }
    return s;
  };
  // Both route to clifford now (register, not harmony, picks the system), so
  // this is a within-clifford character check: talking and clapping differ in
  // energy, roughness and brightness, which are exactly the raw axes clifford
  // reads. Widened from the old cross-system bar accordingly.
  const talk = testFingerprint({ pitchMedian: 0.32, consonance: 0.3, centroid: 0.30,
                                 spread: 0.25, velocity: 0.25, volMean: 0.3, seed: 111 });
  const claps = testFingerprint({ pitchMedian: 0.32, consonance: 0.4, velocity: 0.9,
                                  centroid: 0.75, spread: 0.7, volMean: 0.85, seed: 666 });
  assert.equal(pickSystemLive(talk), pickSystemLive(claps), 'fixture holds the system fixed');
  const a = cellsOf(talk), b = cellsOf(claps);
  let inter = 0; for (const v of a) if (b.has(v)) inter++;
  const jaccard = inter / (a.size + b.size - inter);
  assert.ok(jaccard < 0.85, `talk and claps webs overlap too much (jaccard ${jaccard.toFixed(3)})`);
});

test('attractor live: register picks the system, and each system responds to the sound', () => {
  // Two systems now, so "five characters, five shapes" is neither achievable
  // nor wanted. What must hold: register decides the system, and within each
  // system the sound still moves the form — but via the lever that system
  // actually has. They are deliberately different:
  //   clifford  reads the RAW character axes, so timbre/energy move it.
  //   halvorsen reads the EXPANDED axes over narrow spans (narrowed to fix a
  //             continuity regression), so its character response is subtle by
  //             design and PITCH within its register band is the real lever.
  const low = testFingerprint({ ...LOW_PITCH, centroid: 0.2, spread: 0.15, seed: 3 });
  const high = testFingerprint({ ...HIGH_PITCH, centroid: 0.7, spread: 0.5, seed: 2 });
  assert.equal(pickSystemLive(low), 'halvorsen');
  assert.equal(pickSystemLive(high), 'clifford');
  assert.ok(shapeDistance('attractor', low, high) > 0.12, 'the two systems must look different');

  // clifford: character at fixed register
  const calm = testFingerprint({ ...HIGH_PITCH, velocity: 0.15, volMean: 0.25, spread: 0.15, centroid: 0.25, seed: 11 });
  const busy = testFingerprint({ ...HIGH_PITCH, velocity: 0.7, volMean: 0.8, spread: 0.7, centroid: 0.75, seed: 12 });
  assert.equal(pickSystemLive(calm), 'clifford');
  assert.equal(pickSystemLive(busy), 'clifford');
  assert.ok(shapeDistance('attractor', calm, busy) > 0.05, 'character had no effect within clifford');

  // halvorsen: pitch within its register band
  const deep = testFingerprint({ pitchMedian: 0.04, seed: 21 });
  const upper = testFingerprint({ pitchMedian: 0.24, seed: 22 });
  assert.equal(pickSystemLive(deep), 'halvorsen');
  assert.equal(pickSystemLive(upper), 'halvorsen');
  assert.ok(shapeDistance('attractor', deep, upper) > 0.05, 'pitch had no effect within halvorsen');
});



// REAL speech, not a hand-written fixture. The fixtures above label
// `pitchConfidence: 0.3, consonance: 0.3` as "speech", but a genuine 4s window
// of talking measures pitchConfidence 0.45–0.57 and consonance 0.61–0.77 — it
// clears both pickSystem gates and lands on aizawa/halvorsen, NOT the sinemap
// "web" the comments assume. That mismatch is why every speaker collapsed onto
// the same two designs in the live app while these tests stayed green.
// Frames go through the real buildFingerprint so the compression of the pitch
// axis (speech F0 occupies only ~0.13–0.40 of the 6-octave scale) is preserved.
export function speechFingerprint({ f0, jitter, voicedFrac, rate, loud, bright, seed }) {
  const FPS = 60, WIN = 4;
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const frames = [];
  for (let i = 0; i < FPS * WIN; i++) {
    const t = i / FPS;
    const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * rate * t);   // syllable envelope
    const voiced = syl > (1 - voicedFrac) && rnd() > 0.12;      // consonants/pauses
    const hz = f0 * (1 + 0.25 * Math.sin(2 * Math.PI * 0.35 * t + seed)) * (1 + jitter * (rnd() - 0.5));
    const chroma = new Float32Array(12);
    for (let k = 0; k < 12; k++) chroma[k] = 0.25 * rnd();
    chroma[((Math.round(12 * Math.log2(hz / 55)) % 12) + 12) % 12] = 1;
    frames.push({
      pitchHz: voiced ? hz : 0,
      pitchConf: voiced ? 0.6 + 0.3 * rnd() : 0.1 * rnd(),
      chroma, rms: loud * (0.25 + 0.75 * syl) * (voiced ? 1 : 0.35),
      flux: 0.002 * syl * (voiced ? 1 : 2.2) * loud,
      centroid: bright * (voiced ? 0.75 : 1.6) * (0.85 + 0.3 * rnd()),
      spread: 0.35 + 0.3 * (voiced ? 0.2 : 0.9) + 0.1 * rnd(),
    });
  }
  const fp = buildFingerprint(frames, WIN);
  fp.trajectory = buildTrajectory(frames);
  fp.trajectoryChannels = 4;
  return fp;
}

export const SPEAKERS = {
  'male calm':       { f0: 110, jitter: .05, voicedFrac: .55, rate: 3.5, loud: .10, bright: .10, seed: 1 },
  'male animated':   { f0: 130, jitter: .12, voicedFrac: .65, rate: 5.0, loud: .18, bright: .14, seed: 2 },
  'female calm':     { f0: 200, jitter: .05, voicedFrac: .58, rate: 3.8, loud: .11, bright: .16, seed: 3 },
  'female animated': { f0: 240, jitter: .13, voicedFrac: .68, rate: 5.5, loud: .20, bright: .21, seed: 4 },
  'child excited':   { f0: 300, jitter: .15, voicedFrac: .60, rate: 6.0, loud: .22, bright: .26, seed: 5 },
  'deep slow drawl': { f0:  85, jitter: .04, voicedFrac: .70, rate: 2.2, loud: .13, bright: .08, seed: 7 },
};

test('attractor live: speech reaches both systems, and they look different', () => {
  // Was ">= 4 systems" when there were five. With two, the bar is that speech
  // actually reaches both rather than piling onto one, and that when two
  // speakers land on different systems the designs are unmistakably different.
  const fps = Object.fromEntries(
    Object.entries(SPEAKERS).map(([n, cfg]) => [n, speechFingerprint(cfg)]));
  const systems = new Set(Object.values(fps).map(pickSystemLive));
  assert.equal(systems.size, 2,
    `speech reached only: ${[...systems].join(', ')}`);

  const cellsOf = (fp) => {
    const out = generate(fp, { ...baseParams, density: 30000, liveVariance: true });
    const s = new Set(); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const q = (d) => Math.min(19, Math.max(0, Math.floor((out.positions[i * 3 + d] + 1.3) / 2.6 * 20)));
      s.add((q(0) * 20 + q(1)) * 20 + q(2));
    }
    return s;
  };
  const names = Object.keys(SPEAKERS);
  const sets = Object.fromEntries(names.map(n => [n, cellsOf(fps[n])]));
  let worst = 0, pair = '';
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (pickSystemLive(fps[a]) === pickSystemLive(fps[b])) continue;
      let inter = 0; for (const v of sets[a]) if (sets[b].has(v)) inter++;
      const jac = inter / (sets[a].size + sets[b].size - inter);
      if (jac > worst) { worst = jac; pair = `${a} vs ${b}`; }
    }
  }
  assert.ok(worst < 0.5,
    `speakers on different systems still look alike (worst ${pair} overlap ${worst.toFixed(3)})`);
});


// Cell-occupancy Jaccard overlap, same construction as the 'speech spreads
// across the system space' test above: system identity dominates geometry
// (two designs from the same system overlap 0.60-0.88 by cell, two from
// different systems only 0.10-0.39), so overlap is a reliable proxy for
// "landed on the same system" without requiring byte-identical output from
// two different fingerprints.
export function cellsOf(out) {
  const s = new Set(); const n = out.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const q = (d) => Math.min(19, Math.max(0, Math.floor((out.positions[i * 3 + d] + 1.3) / 2.6 * 20)));
    s.add((q(0) * 20 + q(1)) * 20 + q(2));
  }
  return s;
}
export function jaccard(a, b) {
  let inter = 0; for (const v of a) if (b.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

test('attractor live: params.lockedSystem produces the locked system\'s geometry', () => {
  const p = { ...baseParams, density: 30000, liveVariance: true };
  // A fingerprint that routes somewhere specific on its own...
  const fp = speechFingerprint(SPEAKERS['male calm']);
  const natural = pickSystemLive(fp);
  const other = natural === 'halvorsen' ? 'clifford' : 'halvorsen';

  // Find a speaker profile that lands on `other` UNFORCED, so we have a real
  // reference for what `other`'s geometry actually looks like — not just
  // another call locked to the same thing (which would prove nothing beyond
  // determinism, already guaranteed for the whole module).
  const nativeName = Object.keys(SPEAKERS).find(
    n => pickSystemLive(speechFingerprint(SPEAKERS[n])) === other);
  assert.ok(nativeName, `no SPEAKERS profile naturally routes to ${other}`);
  const nativeFp = speechFingerprint(SPEAKERS[nativeName]);
  assert.equal(pickSystemLive(nativeFp), other, 'fixture must naturally route to the target system');

  const lockedOut = generate(fp, { ...p, lockedSystem: other });     // fp forced onto `other`
  const nativeOther = generate(nativeFp, p);                         // different fp, naturally on `other`
  const unlocked = generate(fp, p);                                  // fp, naturally on `natural`

  // `fp` and `nativeFp` are different fingerprints, so their coefficients
  // differ even on the same system — exact position equality would not hold
  // and would be the wrong bar. What must hold is that locking makes `fp`
  // read as `other`'s geometry, not `natural`'s: overlap with a native
  // `other` design must swamp overlap with `fp`'s own unlocked (natural)
  // design.
  const overlapWithTarget = jaccard(cellsOf(lockedOut), cellsOf(nativeOther));
  const overlapWithNatural = jaccard(cellsOf(lockedOut), cellsOf(unlocked));
  assert.ok(overlapWithTarget > overlapWithNatural,
    `locked output should resemble a native ${other} design (overlap ${overlapWithTarget.toFixed(3)}) ` +
    `far more than fp's own natively-routed ${natural} design (overlap ${overlapWithNatural.toFixed(3)})`);
});

test('attractor: lockedSystem does not affect the capture path', () => {
  const fp = testFingerprint();
  const a = generate(fp, { ...baseParams, density: 30000 });
  const b = generate(fp, { ...baseParams, density: 30000, lockedSystem: 'clifford' });
  assert.deepEqual([...a.positions.slice(0, 300)], [...b.positions.slice(0, 300)],
    'capture output must ignore lockedSystem');
  // Capture must ignore lockedSystem entirely, including an invalid value —
  // the live-path-only validation added below must not reach this branch.
  assert.doesNotThrow(() => generate(fp, { ...baseParams, density: 30000, lockedSystem: 'not-a-system' }),
    'capture path must not validate a field it never reads');
});

test('attractor live: unknown lockedSystem throws, naming the bad value and the valid names', () => {
  const fp = testFingerprint();
  const p = { ...baseParams, density: 30000, liveVariance: true };
  assert.throws(() => generate(fp, { ...p, lockedSystem: 'not-a-system' }), (err) => {
    assert.match(err.message, /not-a-system/);
    for (const name of ALL_SYSTEMS) {
      assert.match(err.message, new RegExp(name));
    }
    return true;
  });
  // '' is falsy but non-nullish, so `??` alone would not catch it.
  assert.throws(() => generate(fp, { ...p, lockedSystem: '' }), /unknown params\.lockedSystem/);
});

test('attractor live: flow systems respond to timbre, not just pitch', () => {
  // Isolates the exact defect: liveAxes was computed on line 163 and then never
  // read by the sys.flow branch, so the ONLY sound→shape channel for a flow
  // system was whatever sys.coeffs(fp) happened to read — pitchMedian, and for
  // aizawa also centroid. Everything else about the sound was discarded.
  //
  // `spread` is the clean probe: it feeds liveAxes[1] (roughness) but touches
  // nothing else on a flow path — wildness reads consonance/volVar/attackSlope,
  // jitter reads velocity, and thomas's coefficient reads only pitchMedian.
  // Before the fix these two fingerprints generate byte-identical clouds.
  const smooth = testFingerprint({ ...LOW_PITCH, spread: 0.10, seed: 4242 });
  const rough = testFingerprint({ ...LOW_PITCH, spread: 0.85, seed: 4242 });
  // Live routing must agree, so this measures the coefficients and not the
  // routing — spread feeds roughness, which live routing does NOT read.
  assert.equal(pickSystemLive(smooth), pickSystemLive(rough), 'fixture must hold the system fixed');
  assert.ok(SYSTEM_IS_FLOW.has(pickSystemLive(smooth)), 'fixture must exercise a flow system');

  const p = { ...baseParams, density: 30000, liveVariance: true };
  const a = generate(smooth, p).positions, b = generate(rough, p).positions;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.ok(diff / a.length > 0.5,
    `timbre change left the flow attractor untouched (${((diff / a.length) * 100).toFixed(1)}% of coordinates moved)`);
});

test('attractor live: loudness does NOT change the design size', () => {
  // Removed at the user's request: the form used to grow and shrink as they
  // got louder (a post-validation s = 0.7 + 0.55 * volMean stretched the
  // r95 = 1 that finalize pins). Size is manual again. Loudness still reads —
  // through visible point count and clifford's relief — just not through size.
  const r95 = (fp) => {
    const out = generate(fp, { ...baseParams, density: 30000, liveVariance: true });
    const radii = [];
    for (let i = 0; i < out.positions.length; i += 3) {
      radii.push(Math.hypot(out.positions[i], out.positions[i + 1], out.positions[i + 2]));
    }
    radii.sort((a, b) => a - b);
    return radii[Math.floor(radii.length * 0.95)];
  };
  for (const base of [LOW_PITCH, HIGH_PITCH]) {
    const quiet = r95(testFingerprint({ ...base, volMean: 0.1 }));
    const loud = r95(testFingerprint({ ...base, volMean: 0.95 }));
    assert.ok(Math.abs(loud - quiet) < 0.08 * quiet,
      `loudness resized the design (quiet r95 ${quiet.toFixed(3)}, loud ${loud.toFixed(3)})`);
  }
});


// Regression: the sound→design map must be LOCAL — consecutive windows of a
// steady sound (tiny feature drift) may not jump to a different design.
// (The v=34 liveMix hash broke this: ±2% drift teleported across systems.)
test('attractor live: steady sound keeps a stable design across morphs', () => {
  const drift = (i, amp = 0.02) => amp * Math.sin(i * 2.399);
  const params = { ...baseParams, density: 30000, liveVariance: true };
  const hist = (out) => {
    const h = new Float64Array(16); const n = out.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(out.positions[i * 3], out.positions[i * 3 + 1], out.positions[i * 3 + 2]);
      h[Math.min(15, Math.floor(r / 1.5 * 16))] += 1 / n;
    }
    return h;
  };
  let prev = null, maxD = 0;
  for (let i = 0; i < 6; i++) {
    const fp = testFingerprint({
      pitchConfidence: 0.3, consonance: 0.32 + drift(i), pitchMedian: 0.3 + drift(i + 1),
      centroid: 0.5 + drift(i + 2), spread: 0.45 + drift(i + 3), velocity: 0.5 + drift(i + 4),
      seed: 1000 + i,
    });
    const h = hist(generate(fp, params));
    if (prev) {
      let d = 0; for (let k = 0; k < 16; k++) d += Math.abs(prev[k] - h[k]);
      maxD = Math.max(maxD, d);
    }
    prev = h;
  }
  assert.ok(maxD < 0.15, `steady sound jumped designs (max consecutive distance ${maxD.toFixed(3)})`);
});
