import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTES, sampleRamp, buildLUT, hexToRgb } from '../js/palettes.js';

test('hexToRgb parses', () => {
  assert.deepEqual(hexToRgb('#ff0080'), [1, 0, 128 / 255]);
});

test('sampleRamp interpolates endpoints and midpoints', () => {
  const stops = [[0, '#000000'], [1, '#ffffff']];
  assert.deepEqual(sampleRamp(stops, 0), [0, 0, 0]);
  assert.deepEqual(sampleRamp(stops, 1), [1, 1, 1]);
  const mid = sampleRamp(stops, 0.5);
  assert.ok(Math.abs(mid[0] - 0.5) < 0.01);
});

test('buildLUT returns 256 RGBA entries', () => {
  const lut = buildLUT(PALETTES.nebula.stops);
  assert.equal(lut.length, 256 * 4);
  assert.equal(lut[3], 255); // alpha opaque
});

test('all presets have valid ordered stops', () => {
  for (const p of Object.values(PALETTES)) {
    assert.ok(p.stops.length >= 3);
    for (let i = 1; i < p.stops.length; i++) assert.ok(p.stops[i][0] > p.stops[i - 1][0]);
  }
});

test('muted palettes: ink/graphite/scope present and well-formed', () => {
  for (const key of ['ink', 'graphite', 'scope']) {
    const p = PALETTES[key];
    assert.ok(p, `${key} missing`);
    assert.equal(p.stops[0][0], 0);
    assert.equal(p.stops[p.stops.length - 1][0], 1);
    for (const [t, hex] of p.stops) {
      assert.ok(t >= 0 && t <= 1);
      assert.match(hex, /^#[0-9a-f]{6}$/i);
    }
  }
});
