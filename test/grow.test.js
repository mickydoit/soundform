import test from 'node:test';
import assert from 'node:assert/strict';
import { placeFragment, GrowComposite, HALF_LIFE, PRUNE_W, GOLDEN } from '../js/grow.js';

const fp = (o = {}) => ({ volMean: 0.5, pitchMedian: 0.5, ...o });

test('placeFragment: deterministic golden-spiral bloom, bounded', () => {
  const a = placeFragment(0, fp()), b = placeFragment(0, fp());
  assert.deepEqual(a, b);
  let prevR = 0;
  for (let i = 0; i < 200; i++) {
    const p = placeFragment(i, fp());
    assert.ok(p.radius >= prevR, 'radius monotonic');
    assert.ok(p.radius <= 1.07, 'radius bounded');
    assert.ok(Math.abs(p.angle - i * GOLDEN) < 1e-9);
    prevR = p.radius;
  }
  assert.ok(placeFragment(0, fp()).radius < 0.2, 'starts at the core');
  // loudness → size, pitch → tilt/lift
  assert.ok(placeFragment(3, fp({ volMean: 1 })).scale > placeFragment(3, fp({ volMean: 0 })).scale);
  assert.equal(placeFragment(3, fp(), true).y, 0, 'flat modes stay in the plate plane');
  assert.ok(placeFragment(3, fp({ pitchMedian: 1 }), false).y > 0, 'high pitch lifts');
});

test('GrowComposite: append transforms and accumulates', () => {
  const comp = new GrowComposite({ maxPoints: 100, fade: false });
  const frag = new Float32Array([1, 0, 0, 0, 1, 0]); // 2 points
  const attr = new Float32Array([0.2, 0.8]);
  assert.equal(comp.append(frag, attr, fp(), 10), true);
  assert.equal(comp.total, 2);
  assert.equal(comp.index, 1);
  const flat = comp.flatten(10);
  assert.equal(flat.count, 2);
  assert.equal(flat.weights[0], 1);
  // point moved off the origin toward the placement (core radius ~0.12)
  const r = Math.hypot(flat.positions[0], flat.positions[1], flat.positions[2]);
  assert.ok(r > 0.05 && r < 0.5);
  // fragment scaled down (scale ~0.21 at volMean 0.5)
  assert.ok(Math.abs(flat.positions[0]) < 0.5);
});

test('GrowComposite keep mode: stops at cap and reports full', () => {
  const comp = new GrowComposite({ maxPoints: 4, fade: false });
  const frag = new Float32Array(9); // 3 points
  const attr = new Float32Array(3);
  assert.equal(comp.append(frag, attr, fp(), 0), true);
  assert.equal(comp.append(frag, attr, fp(), 1), false); // 3+3 > 4
  assert.equal(comp.full, true);
  assert.equal(comp.total, 3);
});

test('GrowComposite fade mode: drops oldest past cap, ages and prunes', () => {
  const comp = new GrowComposite({ maxPoints: 4, fade: true });
  const frag = new Float32Array(9);
  const attr = new Float32Array(3);
  comp.append(frag, attr, fp(), 0);
  assert.equal(comp.append(frag, attr, fp(), 1), true); // drops the first
  assert.equal(comp.total, 3);
  assert.equal(comp.index, 2, 'placement index keeps advancing');
  // half-life weighting
  const w = comp.flatten(1 + HALF_LIFE).weights[0];
  assert.ok(Math.abs(w - 0.5) < 1e-6);
  // pruning
  assert.equal(comp.ageWeights(1 + HALF_LIFE * 10), true);
  assert.equal(comp.total, 0);
  assert.equal(comp.ageWeights(1), false);
});

test('GrowComposite clear resets everything', () => {
  const comp = new GrowComposite({ maxPoints: 100, fade: true });
  comp.append(new Float32Array(3), new Float32Array(1), fp(), 0);
  comp.clear();
  assert.equal(comp.total, 0);
  assert.equal(comp.index, 0);
  assert.equal(comp.full, false);
  assert.equal(comp.flatten(0).count, 0);
});
