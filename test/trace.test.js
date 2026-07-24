// test/trace.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { paletteFromRamp, qToCubic } from '../js/trace.js';

const STOPS = [[0, '#000000'], [0.5, '#808080'], [1, '#ffffff']];

test('paletteFromRamp returns exactly `levels` swatches, index 0 = background', () => {
  const pal = paletteFromRamp(STOPS, 4);
  assert.equal(pal.length, 4);
  assert.deepEqual(pal[0], { r: 0, g: 0, b: 0, a: 255 });      // t=0 background
  assert.deepEqual(pal[3], { r: 255, g: 255, b: 255, a: 255 }); // t=1
});

test('paletteFromRamp is deterministic and evenly spaced', () => {
  const a = paletteFromRamp(STOPS, 6);
  const b = paletteFromRamp(STOPS, 6);
  assert.deepEqual(a, b);
  assert.equal(a.length, 6);
  // middle swatch (t≈0.6) sits between the 0.5 and 1.0 stops → grey ramp, all channels equal
  assert.equal(a[3].r, a[3].g);
  assert.equal(a[3].g, a[3].b);
});

test('qToCubic matches the exact quadratic elevation formula', () => {
  // start (0,0), control (2,4), end (4,0)
  const [c1x, c1y, c2x, c2y] = qToCubic(0, 0, 2, 4, 4, 0);
  // C1 = P0 + 2/3(Q-P0) = (4/3, 8/3); C2 = P2 + 2/3(Q-P2) = (4 - 4/3, 8/3) = (8/3, 8/3)
  assert.ok(Math.abs(c1x - 4 / 3) < 1e-9);
  assert.ok(Math.abs(c1y - 8 / 3) < 1e-9);
  assert.ok(Math.abs(c2x - 8 / 3) < 1e-9);
  assert.ok(Math.abs(c2y - 8 / 3) < 1e-9);
});

test('qToCubic cubic evaluates identically to the source quadratic', () => {
  const sx = 1, sy = 2, qx = 5, qy = 9, ex = 7, ey = 3;
  const [c1x, c1y, c2x, c2y] = qToCubic(sx, sy, qx, qy, ex, ey);
  const quad = (t, p0, p1, p2) => (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t * t * p2;
  const cube = (t, p0, p1, p2, p3) =>
    (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    assert.ok(Math.abs(quad(t, sx, qx, ex) - cube(t, sx, c1x, c2x, ex)) < 1e-9);
    assert.ok(Math.abs(quad(t, sy, qy, ey) - cube(t, sy, c1y, c2y, ey)) < 1e-9);
  }
});
