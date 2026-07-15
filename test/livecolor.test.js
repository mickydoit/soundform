import test from 'node:test';
import assert from 'node:assert/strict';
import { pcHue, liveTarget, glideStops, stopsToHex, hslToHex, mixHue } from '../js/livecolor.js';

const chromaOf = (pcs) => {
  const c = new Float32Array(12);
  pcs.forEach(([pc, v]) => { c[pc] = v; });
  return c;
};

test('pcHue: C is lavender 270, each semitone +30 wrapping', () => {
  assert.equal(pcHue(0), 270);
  assert.equal(pcHue(1), 300);
  assert.equal(pcHue(3), 0);
  assert.equal(pcHue(11), 240);
});

test('mixHue blends along the shortest arc', () => {
  assert.equal(mixHue(350, 10, 0.5), 0);   // wraps through 360
  assert.equal(mixHue(0, 180, 0.5), 90);
});

test('hslToHex produces valid hex', () => {
  assert.match(hslToHex(270, 0.5, 0.6), /^#[0-9a-f]{6}$/);
  assert.equal(hslToHex(0, 0, 0), '#000000');
  assert.equal(hslToHex(0, 0, 1), '#ffffff');
});

test('liveTarget: root pitch class picks the primary hue family', () => {
  const t = liveTarget(chromaOf([[0, 1], [4, 0.8], [7, 0.9]]), 0.5); // C major
  // major leans warm: hue nudged −10° from pcHue(0)=270
  assert.ok(Math.abs(t.stops[0].h - 260) < 1);
  assert.equal(t.bg, '#04040a');
});

test('liveTarget: pastel bounds respected across extremes', () => {
  for (const [chroma, cent] of [
    [chromaOf([[0, 1], [4, 0.8], [7, 0.9]]), 0],
    [chromaOf([[9, 1], [0, 0.9], [4, 0.85]]), 1],
    [new Float32Array(12).fill(1), 0.5],       // maximally dissonant
    [chromaOf([[6, 1]]), 1],
  ]) {
    const t = liveTarget(chroma, cent);
    for (const s of t.stops) {
      assert.ok(s.s >= 0.15 && s.s <= 0.7, `sat ${s.s} out of pastel bounds`);
      assert.ok(s.l >= 0.45 && s.l <= 0.95, `light ${s.l} out of pastel bounds`);
    }
  }
});

test('liveTarget: minor is cooler and deeper than major, same root', () => {
  const maj = liveTarget(chromaOf([[0, 1], [4, 0.8], [7, 0.9]]), 0.5);  // C E G
  const min = liveTarget(chromaOf([[0, 1], [3, 0.8], [7, 0.9]]), 0.5);  // C Eb G
  assert.ok(min.stops[0].h > maj.stops[0].h);   // +10 vs −10 around 270
  assert.ok(min.stops[0].l < maj.stops[0].l);
});

test('liveTarget: dissonance mutes saturation', () => {
  const cons = liveTarget(chromaOf([[0, 1], [4, 0.9], [7, 0.9]]), 0.5);
  const diss = liveTarget(new Float32Array(12).fill(1), 0.5);
  assert.ok(diss.stops[0].s < cons.stops[0].s);
});

test('glideStops: null current snaps to target, then moves smoothly', () => {
  const target = liveTarget(chromaOf([[0, 1], [4, 0.8], [7, 0.9]]), 0.5);
  const s0 = glideStops(null, target, 0.016);
  assert.ok(Math.abs(s0.stops[0].h - target.stops[0].h) < 1e-9);
  const other = liveTarget(chromaOf([[6, 1], [10, 0.8], [1, 0.9]]), 0.5);
  const s1 = glideStops(s0, other, 0.016);
  const moved = Math.abs(s1.stops[0].h - s0.stops[0].h);
  assert.ok(moved > 0 && moved < Math.abs(other.stops[0].h - s0.stops[0].h));
});

test('stopsToHex emits a 4-stop ramp for buildLUT', () => {
  const t = liveTarget(chromaOf([[0, 1], [4, 0.8], [7, 0.9]]), 0.5);
  const stops = stopsToHex(glideStops(null, t, 0.016));
  assert.equal(stops.length, 4);
  assert.deepEqual(stops.map(s => s[0]), [0, 0.35, 0.7, 1]);
  assert.equal(stops[0][1], '#04040a');
  for (const [, hex] of stops) assert.match(hex, /^#[0-9a-f]{6}$/);
});
