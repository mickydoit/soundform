import test from 'node:test';
import assert from 'node:assert/strict';
import { BrushPace, PAINT_MAX_POINTS } from '../js/paint.js';

test('BrushPace: silence paints nothing', () => {
  const pace = new BrushPace();
  let total = 0;
  for (let i = 0; i < 120; i++) total += pace.pointsThisFrame(0.001, 0, 1 / 60);
  assert.equal(total, 0);
});

test('BrushPace: steady sound approaches the spec rate', () => {
  const pace = new BrushPace();
  let total = 0;
  for (let i = 0; i < 60; i++) pace.pointsThisFrame(0.15, 0, 1 / 60); // settle envelope
  for (let i = 0; i < 60; i++) total += pace.pointsThisFrame(0.15, 0, 1 / 60);
  // rate = 400 + 22000×0.15 = 3700 pts/s
  assert.ok(total > 3200 && total < 4200, `got ${total}/s`);
});

test('BrushPace: onsets burst, and the clamp holds', () => {
  const pace = new BrushPace();
  for (let i = 0; i < 60; i++) pace.pointsThisFrame(0.15, 0, 1 / 60);
  const calm = pace.pointsThisFrame(0.15, 0, 1 / 60);
  const burst = pace.pointsThisFrame(0.15, 1, 1 / 60);
  assert.ok(burst > calm);
  assert.ok(pace.pointsThisFrame(1, 1, 1 / 60) <= Math.round(40000 / 60));
});

test('BrushPace: brush rests after sound stops (release)', () => {
  const pace = new BrushPace();
  for (let i = 0; i < 120; i++) pace.pointsThisFrame(0.3, 0, 1 / 60);
  let silentTotal = 0;
  for (let i = 0; i < 240; i++) silentTotal += pace.pointsThisFrame(0.001, 0, 1 / 60); // 4s of silence
  const tail = pace.pointsThisFrame(0.001, 0, 1 / 60);
  assert.equal(tail, 0, 'envelope decays to rest');
  assert.ok(silentTotal < 7000, 'release tail is bounded (~2.5s of decay)');
});

import { createOrbitBrush } from '../js/generators/attractor.js';
import { testFingerprint } from './generators.test.js';

test('orbit brush: emits k bounded normalized points, deterministic', () => {
  const a = createOrbitBrush(testFingerprint());
  const b = createOrbitBrush(testFingerprint());
  const ca = a.next(3000, 1 / 30), cb = b.next(3000, 1 / 30);
  assert.equal(ca.positions.length, 9000);
  assert.equal(ca.attr.length, 3000);
  assert.deepEqual([...ca.positions.slice(0, 300)], [...cb.positions.slice(0, 300)]);
  let maxAbs = 0, sum = 0;
  for (const v of ca.positions) { maxAbs = Math.max(maxAbs, Math.abs(v)); sum += Math.abs(v); }
  assert.ok(maxAbs <= 2.2, `bounded (${maxAbs})`);
  assert.ok(sum / ca.positions.length > 0.05, 'not collapsed at origin');
  for (const v of ca.attr) assert.ok(v >= 0 && v <= 1);
});

test('orbit brush: consecutive chunks continue the same path (flow system)', () => {
  // Meaningful only for the continuous-flow system: halvorsen integrates an
  // ODE, so successive points are neighbours and a chunk boundary must not
  // teleport. Low register routes there.
  const brush = createOrbitBrush(testFingerprint({ pitchMedian: 0.12 }));
  assert.equal(brush.system, 'halvorsen');
  brush.next(2000, 1 / 30);
  const c1 = brush.next(500, 1 / 30);
  const c2 = brush.next(500, 1 / 30);
  const gap = Math.hypot(
    c2.positions[0] - c1.positions[497 * 3],
    c2.positions[1] - c1.positions[497 * 3 + 1],
    c2.positions[2] - c1.positions[497 * 3 + 2]);
  assert.ok(gap < 0.5, `chunks continue the same path (gap ${gap})`);
});

test('orbit brush: a discrete map jumps no more at a chunk boundary than within one', () => {
  // clifford is a MAP, not a flow — consecutive points land all over the
  // attractor by construction, so "one continuous stroke" is not a property it
  // has. What must hold is that the chunk boundary is no worse than a typical
  // step: the brush must not reset or teleport between calls.
  const brush = createOrbitBrush(testFingerprint({ pitchMedian: 0.6 }));
  assert.equal(brush.system, 'clifford');
  brush.next(2000, 1 / 30);
  const c1 = brush.next(500, 1 / 30);
  const c2 = brush.next(500, 1 / 30);
  const stepAt = (arr, i) => Math.hypot(
    arr.positions[(i + 1) * 3] - arr.positions[i * 3],
    arr.positions[(i + 1) * 3 + 1] - arr.positions[i * 3 + 1],
    arr.positions[(i + 1) * 3 + 2] - arr.positions[i * 3 + 2]);
  let within = 0;
  for (let i = 100; i < 400; i++) within += stepAt(c1, i) / 300;
  const boundary = Math.hypot(
    c2.positions[0] - c1.positions[499 * 3],
    c2.positions[1] - c1.positions[499 * 3 + 1],
    c2.positions[2] - c1.positions[499 * 3 + 2]);
  assert.ok(boundary < within * 3,
    `chunk boundary jumped ${boundary.toFixed(3)} vs a typical step of ${within.toFixed(3)}`);
});


test('orbit brush: steer bends the path without teleporting', () => {
  const steered = createOrbitBrush(testFingerprint());
  const straight = createOrbitBrush(testFingerprint());
  steered.next(2000, 1 / 30); straight.next(2000, 1 / 30);
  steered.steer(testFingerprint({ pitchMedian: 0.9, centroid: 0.8, spread: 0.1 }));
  // immediately after steer the paths are still close — glide, not jump
  const s1 = steered.next(200, 1 / 30), t1 = straight.next(200, 1 / 30);
  let d0 = 0;
  for (let i = 0; i < 600; i++) d0 += Math.abs(s1.positions[i] - t1.positions[i]);
  // after ~6s of glide the steered path has genuinely departed
  let dLate = 0;
  let sL, tL;
  for (let i = 0; i < 60; i++) { sL = steered.next(200, 0.1); tL = straight.next(200, 0.1); }
  for (let i = 0; i < 600; i++) dLate += Math.abs(sL.positions[i] - tL.positions[i]);
  assert.ok(dLate > d0, `steering diverges over time (${d0.toFixed(1)} → ${dLate.toFixed(1)})`);
});

test('orbit brush: works for the discrete map too (high register -> clifford)', () => {
  const brush = createOrbitBrush(testFingerprint({ pitchMedian: 0.6 }));
  assert.equal(brush.system, 'clifford');
  const c = brush.next(2000, 1 / 30);
  let maxAbs = 0;
  for (const v of c.positions) maxAbs = Math.max(maxAbs, Math.abs(v));
  assert.ok(maxAbs <= 2.2 && maxAbs > 0.05);
});
