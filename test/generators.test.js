import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../js/generators/index.js';
import { pickSystem } from '../js/generators/attractor.js';

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
  assert.equal(pickSystem(testFingerprint({ consonance: 0.1 })), 'dadras');
  assert.equal(pickSystem(testFingerprint({ pitchConfidence: 0.2 })), 'sinemap');
  assert.equal(pickSystem(testFingerprint({ velocity: 0.8 })), 'sinemap');
});

test('attractor: all five systems bounded, non-degenerate, deterministic', () => {
  const routingFingerprints = {
    thomas: testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 3 }),
    aizawa: testFingerprint({ consonance: 0.8, majorLeaning: true, noteCount: 5, noteSet: [0, 2, 4, 7, 9] }),
    halvorsen: testFingerprint({ consonance: 0.8, majorLeaning: false }),
    dadras: testFingerprint({ consonance: 0.1 }),
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
// polynomial flow systems (halvorsen, dadras) — the cloud passes
// validateFinalized, but the ~134k-Euler-step strand extension goes
// non-finite. Before the fix: halvorsen-routing seed 143 → 50/96 non-finite
// strands; dadras-routing seed 41 → 76/96 non-finite strands. checkGenerator
// now asserts every strand value is finite, so these must pass post-fix.
test('attractor: strand-phase escape repros stay finite after retry', () => {
  const halvorsenEscape = testFingerprint({ consonance: 0.8, majorLeaning: false, pitchMedian: 0.431, seed: 143 });
  assert.equal(pickSystem(halvorsenEscape), 'halvorsen');
  checkGenerator('attractor', halvorsenEscape);

  const dadrasEscape = testFingerprint({ consonance: 0.1, pitchMedian: 1, centroid: 0, spread: 0.904, volMean: 0.03, seed: 41 });
  assert.equal(pickSystem(dadrasEscape), 'dadras');
  checkGenerator('attractor', dadrasEscape);
});

test('chladni generator: bounded, dense, deterministic, strands', () => {
  checkGenerator('chladni');
});

test('radial generator', () => {
  checkGenerator('radial');
});

test('spectral generator', () => {
  checkGenerator('spectral');
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
