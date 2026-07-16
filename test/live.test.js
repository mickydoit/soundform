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

import { LiveConductor, LIVE_MIN_FRAMES } from '../js/live.js';

const mkFrame = (o = {}) => ({
  pitchHz: 220, pitchConf: 0.9, rms: 0.15, flux: 0.002,
  centroid: 0.4, spread: 0.3,
  chroma: (() => { const c = new Float32Array(12); c[0] = 1; c[4] = 0.8; c[7] = 0.9; return c; })(),
  ...o,
});

function harness({ frame = mkFrame(), genDelay = 0, generate = null, getParams = null } = {}) {
  const log = { xfades: 0, waves: [], stops: [], paintBegun: 0, paintWrites: [], paintCounts: [] };
  const conductor = new LiveConductor({
    audio: { getMusicalFrame: () => frame.current ?? frame },
    renderer: {
      setWave: (a, f) => log.waves.push([a, f]),
      setParams: () => {}, setPlaying: () => {}, setLoopPeriod: () => {},
      crossfadeTo: () => { log.xfades++; },
      beginPaint: (m) => { log.paintBegun = m; },
      writePaintPoints: (o, p) => { log.paintWrites.push([o, p.length / 3]); },
      setPaintCount: (n) => { log.paintCounts.push(n); },
      getPaintSlice: (n) => ({ positions: new Float32Array(n * 3), attr: new Float32Array(n) }),
    },
    generate: generate ?? (async () => ({ positions: new Float32Array(3), attr: new Float32Array(1), strands: [] })),
    applyStops: (s) => log.stops.push(s),
    getParams: getParams ?? (() => ({ mode: 'attractor', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, exposure: 30, scale: 1, grain: 1 })),
  });
  return { conductor, log };
}

const settle = () => new Promise(r => setImmediate(r));

test('conductor morphs once on first sound, then respects min interval', async () => {
  const { conductor, log } = harness();
  for (let i = 0; i < 70; i++) conductor.tick(i / 30);   // ~2.3s of steady C major
  await settle();
  assert.equal(log.xfades, 1);                            // first morph only —
  await settle();                                         // same sound → no second
  assert.equal(log.xfades, 1);
  assert.ok(log.waves.length > 0);
  assert.ok(log.stops.length > 0);
});

test('conductor morphs again when the sound really changes', async () => {
  const frame = { current: mkFrame() };
  const { conductor, log } = harness({ frame });
  for (let i = 0; i < 70; i++) conductor.tick(i / 30);
  await settle();
  assert.equal(log.xfades, 1);
  const c2 = new Float32Array(12); c2[2] = 1; c2[6] = 0.85; c2[9] = 0.9; // D major, up an octave
  frame.current = mkFrame({ pitchHz: 880, chroma: c2 });
  for (let i = 70; i < 220; i++) conductor.tick(i / 30);  // 5 more seconds
  await settle();
  assert.ok(log.xfades >= 2);
});

test('silence: no morphs fire, wave amp decays toward 0', async () => {
  const { conductor, log } = harness({ frame: mkFrame({ rms: 0.001, pitchConf: 0, flux: 0 }) });
  for (let i = 0; i < 150; i++) conductor.tick(i / 30);
  await settle();
  assert.equal(log.xfades, 0);
  const [lastAmp] = log.waves[log.waves.length - 1];
  assert.ok(lastAmp < 0.005);
});

test('forceMorph regenerates without threshold', async () => {
  const { conductor, log } = harness();
  for (let i = 0; i < 70; i++) conductor.tick(i / 30);
  await settle();
  conductor.forceMorph();
  for (let i = 70; i < 160; i++) conductor.tick(i / 30);
  await settle();
  assert.equal(log.xfades, 2);
});

test('freeze returns a full fingerprint with 4-channel trajectory and hex stops', () => {
  const { conductor } = harness();
  for (let i = 0; i < 70; i++) conductor.tick(i / 30);
  const out = conductor.freeze();
  assert.ok(out);
  assert.equal(out.fingerprint.trajectoryChannels, 4);
  assert.ok(out.fingerprint.trajectory.length >= LIVE_MIN_FRAMES * 4);
  assert.ok(typeof out.fingerprint.seed === 'number');
  assert.equal(out.stops.length, 4);
  assert.match(out.stops[1][1], /^#[0-9a-f]{6}$/);
});

test('freeze with too little sound returns null', () => {
  const { conductor } = harness();
  for (let i = 0; i < 5; i++) conductor.tick(i / 30);
  assert.equal(conductor.freeze(), null);
});

import { testFingerprint } from './generators.test.js';

test('fingerprintDelta: timbre-only change crosses the morph threshold', () => {
  const a = testFingerprint({ centroid: 0.2, spread: 0.1 });
  const b = testFingerprint({ centroid: 0.6, spread: 0.4 }); // same notes/register
  assert.ok(fingerprintDelta(a, b) >= MORPH_THRESHOLD);
});

test('fingerprintDelta: steady speech jitter stays under threshold', () => {
  const a = testFingerprint({ consonance: 0.3, centroid: 0.5, spread: 0.45 });
  const b = testFingerprint({ consonance: 0.35, centroid: 0.55, spread: 0.4,
                              pitchMedian: 0.47, velocity: 0.45 });
  assert.ok(fingerprintDelta(a, b) < MORPH_THRESHOLD);
});

test('conductor: structural regen requests carry liveVariance', async () => {
  let seenParams = null;
  const { conductor } = harness({
    generate: async (fp, p) => {
      seenParams = p;
      return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] };
    },
  });
  for (let i = 0; i < 70; i++) conductor.tick(i / 30); // ~2.3s steady sound → 1 morph
  await new Promise(r => setImmediate(r));
  assert.ok(seenParams, 'a regen fired');
  assert.equal(seenParams.liveVariance, true);
});


test('paint (attractor): sound advances the brush, silence rests it', async () => {
  const frame = { current: mkFrame() };
  const { conductor, log } = harness({ frame });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);   // 3s of sound
  await settle();
  assert.equal(log.xfades, 0, 'no crossfades in paint mode');
  assert.ok(log.paintBegun > 0, 'paint buffer allocated');
  assert.ok(log.paintWrites.length > 0, 'brush wrote points');
  const painted = log.paintCounts[log.paintCounts.length - 1];
  assert.ok(painted > 1000, `painted ${painted} points in 3s of sound`);
  // silence: the brush rests
  frame.current = mkFrame({ rms: 0.001, pitchConf: 0, flux: 0 });
  const before = painted;
  for (let i = 90; i < 210; i++) conductor.tick(i / 30); // 4s of silence
  const after = log.paintCounts[log.paintCounts.length - 1];
  assert.ok(after - before < 3500, 'brush rests in silence (bounded release tail)');
});

test('paint: completion fires the status once and stops', async () => {
  const { conductor, log } = harness();
  const statuses = [];
  conductor.onGrowStatus = (m) => statuses.push(m);
  conductor.setGrowthMode('paint');
  conductor.paintMax = 3000;                       // small canvas for the test
  for (let i = 0; i < 240; i++) conductor.tick(i / 30);
  await settle();
  const painted = log.paintCounts[log.paintCounts.length - 1];
  assert.ok(painted <= 3000);
  assert.equal(statuses.filter(s => /complete/i.test(s)).length, 1);
});

test('paint: freeze returns the painted cloud', async () => {
  const { conductor } = harness();
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud);
  assert.ok(out.cloud.positions.length > 0);
});

test('paint (non-attractor): reveal requests a full design then advances', async () => {
  let genCount = 0, genParams = null;
  const { conductor, log } = harness({
    generate: async (fp, p) => {
      genCount++; genParams = p;
      const n = p.density;
      return { positions: new Float32Array(n * 3), attr: new Float32Array(n), strands: [] };
    },
    getParams: () => ({ mode: 'radial', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, paintMaxPoints: 5000,
                        exposure: 30, scale: 1, grain: 1 }),
  });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  assert.equal(genCount, 1, 'one full design requested');
  assert.equal(genParams.density, 5000);
  assert.equal(genParams.liveVariance, true);
  assert.ok(log.paintWrites.some(([o]) => o === 0), 'design written at offset 0');
  assert.ok(log.paintCounts[log.paintCounts.length - 1] > 500, 'reveal advanced');
  assert.equal(log.xfades, 0);
});

test('paint: geometry sliders steer the painting, never wipe it', async () => {
  let genCount = 0;
  const { conductor, log } = harness({
    generate: async (fp, p) => {
      genCount++;
      const n = p.density;
      return { positions: new Float32Array(n * 3), attr: new Float32Array(n), strands: [] };
    },
    getParams: () => ({ mode: 'radial', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, paintMaxPoints: 50000,
                        exposure: 30, scale: 1, grain: 1 }),
  });
  conductor.setGrowthMode('paint');
  let begins = 0;
  const origBegin = conductor.renderer.beginPaint;
  conductor.renderer.beginPaint = (m) => { begins++; origBegin(m); };
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  const paintedBefore = log.paintCounts[log.paintCounts.length - 1];
  conductor.forceMorph();                       // slider release during paint
  for (let i = 90; i < 150; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  assert.equal(begins, 1, 'canvas allocated once — slider must not wipe the painting');
  assert.equal(genCount, 2, 'slider triggers a remainder re-plan');
  const paintedAfter = log.paintCounts[log.paintCounts.length - 1];
  assert.ok(paintedAfter >= paintedBefore, 'painting kept advancing');
});

test('stale morph generation never lands after switching to paint', async () => {
  let resolveGen = null;
  const { conductor, log } = harness({
    generate: (fp, p) => new Promise((res) => {
      // paint-mode requests resolve instantly; the morph one is held open
      if (p.liveVariance && p.density > 900 && p.strandCount === 8) {
        res({ positions: new Float32Array(p.density * 3), attr: new Float32Array(p.density), strands: [] });
      } else {
        resolveGen = () => res({ positions: new Float32Array(30), attr: new Float32Array(10), strands: [] });
      }
    }),
  });
  for (let i = 0; i < 70; i++) conductor.tick(i / 30);   // morph fires, held in flight
  assert.ok(resolveGen, 'a morph generation is in flight');
  conductor.setGrowthMode('paint');                       // user flips Growth mid-flight
  for (let i = 70; i < 100; i++) conductor.tick(i / 30);
  resolveGen();                                           // stale morph resolves late
  await settle();
  assert.equal(log.xfades, 0, 'stale morph must not crossfade over the painting');
});
