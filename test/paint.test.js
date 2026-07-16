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
