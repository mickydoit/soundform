import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, registeredModes } from '../js/generators/index.js';
import { pickSystem } from '../js/generators/attractor.js';
import { sphericalY, makeValueNoise3, recipe } from '../js/generators/harmonic.js';
import { mulberry32 } from '../js/generators/common.js';

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
  for (const s of out.strands) for (let i = 0; i < s.length; i += 1) assert.ok(Number.isFinite(s[i]), `${mode}: non-finite strand value`);
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
  assert.equal(pickSystem(testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 3 })), 'thomas');
  assert.equal(pickSystem(testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 5, noteSet: [0, 2, 4, 7, 9] })), 'aizawa');
  assert.equal(pickSystem(testFingerprint({ consonance: 0.8, majorLeaning: false })), 'halvorsen');
  assert.equal(pickSystem(testFingerprint({ consonance: 0.1 })), 'lorenz');
  assert.equal(pickSystem(testFingerprint({ pitchConfidence: 0.2 })), 'sinemap');
  assert.equal(pickSystem(testFingerprint({ velocity: 0.8 })), 'sinemap');
});

test('attractor: all five systems bounded, non-degenerate, deterministic', () => {
  const routingFingerprints = {
    thomas: testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 3 }),
    aizawa: testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 5, noteSet: [0, 2, 4, 7, 9] }),
    halvorsen: testFingerprint({ consonance: 0.8, majorLeaning: false }),
    lorenz: testFingerprint({ consonance: 0.1 }),
    sinemap: testFingerprint({ pitchConfidence: 0.2 }),
  };
  const seeds = [1, 123456789, 987654321];
  for (const [name, fp] of Object.entries(routingFingerprints)) {
    assert.equal(pickSystem(fp), name, `routing fixture mismatch for ${name}`);
    for (const seed of seeds) {
      checkGenerator('attractor', { ...fp, seed });
    }
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
  const halvorsenEscape = testFingerprint({ consonance: 0.8, majorLeaning: false, pitchMedian: 0.431, seed: 143 });
  assert.equal(pickSystem(halvorsenEscape), 'halvorsen');
  checkGenerator('attractor', halvorsenEscape);

  const dissonantEscape = testFingerprint({ consonance: 0.1, pitchMedian: 1, centroid: 0, spread: 0.904, volMean: 0.03, seed: 41 });
  assert.equal(pickSystem(dissonantEscape), 'lorenz');
  checkGenerator('attractor', dissonantEscape);
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

test('radial generator', () => {
  checkGenerator('radial');
});

test('cymatics generator', () => {
  checkGenerator('cymatics');
});

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

test('timbre: points concentrate toward the centreline (gaussian core)', () => {
  const fp = testFingerprint();
  fp.trajectory = new Float32Array(300);
  for (let i = 0; i < 100; i++) {
    fp.trajectory[i * 3] = 0.3 + 0.2 * Math.sin(i / 9);
    fp.trajectory[i * 3 + 1] = 0.2 + 0.15 * Math.sin(i / 5);
    fp.trajectory[i * 3 + 2] = 0.3 + 0.1 * Math.cos(i / 7);
  }
  const out = generate(fp, { ...baseParams, mode: 'timbre', density: 30000 });
  // Distance of each (subsampled) point to the nearest of a subsampled set of
  // centreline stations (out.strands[0], 300 pts, same normalization as
  // positions). A gaussian core clusters points near the centreline, so the
  // median distance should be well under half the p95 distance; uniform cube
  // scatter spreads points out flatly, keeping median close to p95.
  const cl = out.strands[0];
  const n = out.positions.length / 3;
  const dists = [];
  for (let i = 0; i < n; i += 7) {
    const x = out.positions[i * 3], y = out.positions[i * 3 + 1], z = out.positions[i * 3 + 2];
    let best = Infinity;
    for (let j = 0; j < cl.length; j += 9) { // every 3rd station
      const dx = x - cl[j], dy = y - cl[j + 1], dz = z - cl[j + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    dists.push(Math.sqrt(best));
  }
  dists.sort((a, b) => a - b);
  const median = dists[Math.floor(dists.length * 0.5)];
  const p95 = dists[Math.floor(dists.length * 0.95)];
  assert.ok(median < 0.45 * p95, `median ${median.toFixed(4)} vs p95 ${p95.toFixed(4)}`);
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
