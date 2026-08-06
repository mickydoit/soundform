import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoParams, AUTO_RANGE, AUTO_TAU, featuresFromFingerprint } from '../js/autoparams.js';

const FX = { brightness: 0.5, roughness: 0.5, energy: 0.5, loudness: 0.5 };

test('AutoParams: values start mid-range and stay inside their range', () => {
  const ap = new AutoParams();
  for (const k of Object.keys(AUTO_RANGE)) {
    const [lo, hi] = AUTO_RANGE[k];
    assert.ok(ap.value[k] >= lo && ap.value[k] <= hi, `${k} started outside range`);
  }
  // drive hard to both extremes; must clamp, never overshoot
  for (let i = 0; i < 400; i++) ap.step({ brightness: 1, roughness: 1, energy: 1, loudness: 1 }, 1 / 60);
  for (const k of Object.keys(AUTO_RANGE)) {
    const [lo, hi] = AUTO_RANGE[k];
    assert.ok(ap.value[k] <= hi + 1e-9 && ap.value[k] >= lo - 1e-9, `${k} escaped range at max drive`);
  }
  for (let i = 0; i < 400; i++) ap.step({ brightness: 0, roughness: 0, energy: 0, loudness: 0 }, 1 / 60);
  for (const k of Object.keys(AUTO_RANGE)) {
    const [lo, hi] = AUTO_RANGE[k];
    assert.ok(ap.value[k] <= hi + 1e-9 && ap.value[k] >= lo - 1e-9, `${k} escaped range at min drive`);
  }
});

test('AutoParams: glides gradually, never jumps', () => {
  const ap = new AutoParams();
  const before = ap.step(FX, 1 / 60).complexity;
  const after = ap.step({ ...FX, brightness: 1 }, 1 / 60).complexity;
  const [lo, hi] = AUTO_RANGE.complexity;
  // one 60fps frame may move at most a few percent of the range
  assert.ok(Math.abs(after - before) < (hi - lo) * 0.05,
    `complexity jumped ${Math.abs(after - before).toFixed(3)} in one frame`);
});

test('AutoParams: reaches its target given enough time', () => {
  const ap = new AutoParams();
  for (let i = 0; i < 60 * 20; i++) ap.step({ ...FX, brightness: 1 }, 1 / 60);
  const [, hi] = AUTO_RANGE.complexity;
  assert.ok(ap.value.complexity > hi - 0.02, `complexity settled at ${ap.value.complexity}, expected ~${hi}`);
});

test('AutoParams: each parameter follows its own feature', () => {
  const settle = (fx) => {
    const ap = new AutoParams();
    for (let i = 0; i < 60 * 20; i++) ap.step(fx, 1 / 60);
    return ap.value;
  };
  const dark = settle({ ...FX, brightness: 0 }), bright = settle({ ...FX, brightness: 1 });
  assert.ok(bright.complexity > dark.complexity, 'brightness must raise complexity');
  assert.equal(bright.twist.toFixed(4), dark.twist.toFixed(4), 'brightness must not move twist');

  // `scale` is deliberately absent: voice-driven resizing was removed.
  assert.ok(!('scale' in bright), 'scale must not be voice-driven');

  const quiet = settle({ ...FX, loudness: 0 }), loud = settle({ ...FX, loudness: 1 });
  assert.ok(loud.visibleFraction > quiet.visibleFraction, 'loudness must raise visible fraction');

  const smooth = settle({ ...FX, roughness: 0 }), rough = settle({ ...FX, roughness: 1 });
  assert.notEqual(rough.twist.toFixed(4), smooth.twist.toFixed(4), 'roughness must move twist');
});

test('AutoParams: dt-independent — same elapsed time reaches the same place', () => {
  const drive = (dt, steps) => {
    const ap = new AutoParams();
    for (let i = 0; i < steps; i++) ap.step({ ...FX, brightness: 1 }, dt);
    return ap.value.complexity;
  };
  const at60 = drive(1 / 60, 300);     // 5s
  const at30 = drive(1 / 30, 150);     // 5s
  assert.ok(Math.abs(at60 - at30) < 0.01, `dt-dependent: ${at60} vs ${at30}`);
});

test('featuresFromFingerprint maps into 0..1', () => {
  const fp = { pitchMedian: 0.3, centroid: 0.4, spread: 0.35, consonance: 0.6,
               velocity: 0.4, volMean: 0.5, volVar: 0.2, attackSlope: 0.3 };
  const fx = featuresFromFingerprint(fp, 0.2);
  for (const k of ['brightness', 'roughness', 'energy', 'loudness']) {
    assert.ok(fx[k] >= 0 && fx[k] <= 1, `${k} = ${fx[k]} out of range`);
  }
});
