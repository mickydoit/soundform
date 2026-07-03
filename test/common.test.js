import test from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, fnv1a, computeNormalization, applyNormalization,
         replicateSymmetry, finalize, resamplePolyline, applyTwistArr } from '../js/generators/common.js';

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

test('applyTwistArr rotates around Y proportionally to height', () => {
  const arr = new Float32Array([1, 0, 0,   1, Math.PI / 2, 0]);
  applyTwistArr(arr, 1); // y=0 → no rotation; y=π/2 → 90° rotation
  assert.ok(Math.abs(arr[0] - 1) < 1e-6 && Math.abs(arr[2]) < 1e-6);
  assert.ok(Math.abs(arr[3]) < 1e-6);       // x' = cos(π/2) = 0
  assert.ok(Math.abs(arr[5] + 1) < 1e-6);   // z' = -sin(π/2) = -1
});
