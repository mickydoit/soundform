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

import { buildTraceSVG } from '../js/trace.js';

// Minimal hand-built tracedata: 3 palette entries (0 = background, 1, 2).
// Layer 1 has one triangle path (L segments); layer 2 has one path with a Q.
const FIXTURE = {
  width: 100, height: 80,
  palette: [
    { r: 0, g: 0, b: 0, a: 255 },       // 0 background — must be skipped
    { r: 255, g: 0, b: 0, a: 255 },     // 1 red
    { r: 0, g: 128, b: 255, a: 255 },   // 2 blue
  ],
  layers: [
    [ /* layer 0: background paths — must not appear */
      { isholepath: false, segments: [
        { type: 'L', x1: 0, y1: 0, x2: 100, y2: 0 },
        { type: 'L', x1: 100, y1: 0, x2: 100, y2: 80 },
        { type: 'L', x1: 100, y1: 80, x2: 0, y2: 0 } ] } ],
    [ { isholepath: false, segments: [
        { type: 'L', x1: 10, y1: 10, x2: 40, y2: 10 },
        { type: 'L', x1: 40, y1: 10, x2: 25, y2: 40 },
        { type: 'L', x1: 25, y1: 40, x2: 10, y2: 10 } ] } ],
    [ { isholepath: false, segments: [
        { type: 'L', x1: 60, y1: 20, x2: 90, y2: 20 },
        { type: 'Q', x1: 90, y1: 20, x2: 90, y2: 20, x3: 60, y3: 60 },
        { type: 'L', x1: 60, y1: 60, x2: 60, y2: 20 } ] } ],
  ],
};

test('buildTraceSVG skips the background layer and groups by tone', () => {
  const svg = buildTraceSVG(FIXTURE, { background: '#0a0a0a' });
  assert.ok(svg.includes('width="100" height="80"'));
  assert.ok(svg.includes('<rect id="background"'));
  assert.ok(svg.includes('fill="#0a0a0a"'));
  assert.ok(svg.includes('<g id="tone-01"'));   // palette index 1
  assert.ok(svg.includes('<g id="tone-02"'));   // palette index 2
  assert.ok(!svg.includes('id="tone-00"'));      // background layer skipped
  assert.ok(svg.includes('fill="#ff0000"'));     // layer 1 colour
  assert.ok(svg.includes('fill="#0080ff"'));     // layer 2 colour
  assert.ok(svg.includes('Q 90 20 60 60'));      // quadratic emitted verbatim
});

test('buildTraceSVG with null background emits no rect', () => {
  const svg = buildTraceSVG(FIXTURE, { background: null });
  assert.ok(!svg.includes('id="background"'));
  assert.ok(svg.includes('<g id="tone-01"'));
});
