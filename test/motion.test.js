import test from 'node:test';
import assert from 'node:assert/strict';
import { motionParams, displacePoint } from '../js/motion.js';

test('motionParams: deterministic, unit direction, bounded amp', () => {
  const a = motionParams(123456789);
  const b = motionParams(123456789);
  assert.deepEqual(a, b);
  const len = Math.hypot(...a.dir);
  assert.ok(Math.abs(len - 1) < 1e-9, 'dir must be unit length');
  assert.ok(a.amp >= 0.02 && a.amp <= 0.045, `amp subtle (${a.amp})`);
  assert.ok(a.freq >= 4 && a.freq <= 9);
  const c = motionParams(987);
  assert.notDeepEqual(a.dir, c.dir, 'different seeds → different motion');
});

test('displacePoint: seamless loop — t=0 equals t=1', () => {
  const mp = motionParams(42);
  const p0 = displacePoint(0.3, -0.5, 0.8, mp, 0);
  const p1 = displacePoint(0.3, -0.5, 0.8, mp, 1);
  for (let d = 0; d < 3; d++) assert.ok(Math.abs(p0[d] - p1[d]) < 1e-6);
});

test('displacePoint: displacement is radial and bounded by amp', () => {
  const mp = motionParams(42);
  const [x, y, z] = displacePoint(0.6, 0.0, 0.0, mp, 0.37);
  const moved = Math.hypot(x - 0.6, y, z);
  assert.ok(moved <= mp.amp + 1e-9);
  assert.ok(Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9, 'point on x-axis moves along x only');
});
