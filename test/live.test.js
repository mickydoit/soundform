import test from 'node:test';
import assert from 'node:assert/strict';
import { Envelope, KickDetector, trimWindow, fingerprintDelta,
         MORPH_THRESHOLD } from '../js/live.js';

test('Envelope rises fast (attack) and falls slow (release)', () => {
  const e = new Envelope(0.05, 0.5);
  const up = e.step(1, 0.05);          // one attack tau → ~63%
  assert.ok(up > 0.55 && up < 0.75);
  e.value = 1;
  const down = e.step(0, 0.05);        // 0.1 release tau → small drop
  assert.ok(down > 0.85);
});

test('KickDetector fires on a flux spike then decays', () => {
  const k = new KickDetector();
  for (let i = 0; i < 30; i++) k.step(0.002, 1 / 60);   // steady noise floor
  const fired = k.step(0.05, 1 / 60);                    // spike
  assert.equal(fired, 1);
  let v = fired;
  for (let i = 0; i < 30; i++) v = k.step(0.002, 1 / 60); // ~0.5s later
  assert.ok(v < 0.05);
});

test('KickDetector refractory: no double-fire within 150ms', () => {
  const k = new KickDetector();
  for (let i = 0; i < 30; i++) k.step(0.002, 1 / 60);
  k.step(0.05, 1 / 60);
  const v1 = k.step(0.05, 1 / 60);      // 16ms later — inside refractory
  assert.ok(v1 < 1);
});

test('trimWindow drops frames older than the window', () => {
  const frames = [{ t: 0, f: {} }, { t: 2, f: {} }, { t: 5, f: {} }];
  trimWindow(frames, 6.5, 4);
  assert.deepEqual(frames.map(x => x.t), [5]);
});

test('fingerprintDelta: identical → 0, null → Infinity', () => {
  const fp = { noteSet: [0, 4, 7], pitchMedian: 0.5, consonance: 0.8,
               majorLeaning: true, velocity: 0.3 };
  assert.equal(fingerprintDelta(fp, { ...fp }), 0);
  assert.equal(fingerprintDelta(fp, null), Infinity);
});

test('fingerprintDelta crosses the morph threshold on a real change', () => {
  const a = { noteSet: [0, 4, 7], pitchMedian: 0.3, consonance: 0.8,
              majorLeaning: true, velocity: 0.3 };
  const b = { noteSet: [2, 6, 9], pitchMedian: 0.7, consonance: 0.4,
              majorLeaning: false, velocity: 0.6 };
  assert.ok(fingerprintDelta(a, b) >= MORPH_THRESHOLD);
  const near = { ...a, pitchMedian: 0.32 };
  assert.ok(fingerprintDelta(a, near) < MORPH_THRESHOLD);
});
