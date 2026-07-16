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

function harness({ frame = mkFrame(), genDelay = 0, generate = null } = {}) {
  const log = { xfades: 0, waves: [], stops: [], growUploads: [], drawIns: 0, drawProgress: [] };
  const conductor = new LiveConductor({
    audio: { getMusicalFrame: () => frame.current ?? frame },
    renderer: {
      setWave: (a, f) => log.waves.push([a, f]),
      setParams: () => {}, setPlaying: () => {}, setLoopPeriod: () => {},
      crossfadeTo: () => { log.xfades++; },
      setGrowCloud: (p) => { log.growUploads.push(p.length / 3); },
      drawInTo: () => { log.drawIns++; },
      setDrawProgress: (t) => { log.drawProgress.push(t); },
    },
    generate: generate ?? (async () => ({ positions: new Float32Array(3), attr: new Float32Array(1), strands: [] })),
    applyStops: (s) => log.stops.push(s),
    getParams: () => ({ mode: 'attractor', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, exposure: 30, scale: 1, grain: 1 }),
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

import { NoteEventDetector } from '../js/live.js';

test('NoteEventDetector: silence never fires', () => {
  const d = new NoteEventDetector();
  const quiet = mkFrame({ rms: 0.001 });
  for (let i = 0; i < 120; i++) assert.equal(d.step(quiet, 0, i / 60), false);
});

test('NoteEventDetector: onset fires, then throttles 250ms', () => {
  const d = new NoteEventDetector();
  const f = mkFrame();
  assert.equal(d.step(f, 1, 1.0), true);    // kick
  assert.equal(d.step(f, 1, 1.1), false);   // inside throttle
  assert.equal(d.step(f, 1, 1.3), true);    // past throttle
});

test('NoteEventDetector: a new held pitch class fires once', () => {
  const d = new NoteEventDetector();
  const c = mkFrame();                       // chroma peak at C (index 0)
  d.step(c, 1, 0);                           // initial onset event at t=0
  for (let t = 0.05; t < 0.3; t += 0.05) d.step(c, 0, t); // same note held
  const eChroma = new Float32Array(12); eChroma[4] = 1;
  const e = mkFrame({ chroma: eChroma });
  d.step(e, 0, 0.30);                        // new note appears
  assert.equal(d.step(e, 0, 0.35), false);   // held 0.05s — not yet
  assert.equal(d.step(e, 0, 0.43), true);    // held ≥0.12s → fires
});

test('NoteEventDetector: sustained sound fires every ~0.5s', () => {
  const d = new NoteEventDetector();
  const hum = mkFrame({ pitchConf: 0.3 });   // unvoiced hum: no note events
  const fires = [];
  for (let t = 0; t < 2.0; t += 1 / 60) if (d.step(hum, 0, t)) fires.push(t);
  assert.ok(fires.length >= 3 && fires.length <= 5, `got ${fires.length}`);
  for (let i = 1; i < fires.length; i++) assert.ok(fires[i] - fires[i - 1] >= 0.45);
});

test('grow mode: events request fragments, morph scheduler is off', async () => {
  let genParams = null;
  const { conductor, log } = harness({
    generate: async (fp, p) => {
      genParams = p;
      return { positions: new Float32Array(30), attr: new Float32Array(10), strands: [] };
    },
  });
  conductor.setGrowthMode('grow-keep');
  // settle between tick batches so successive async fragments can land
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  assert.equal(log.xfades, 0, 'no crossfade morphs in grow mode');
  assert.ok(log.growUploads.length >= 2, 'composite uploaded as it grows');
  assert.ok(genParams.liveVariance === true && genParams.strandCount === 8);
  assert.ok(genParams.density > 0);
  for (let i = 1; i < log.growUploads.length; i++) {
    assert.ok(log.growUploads[i] >= log.growUploads[i - 1]);
  }
});

test('grow mode: freeze returns the composite cloud', async () => {
  const { conductor } = harness({
    generate: async () => ({ positions: new Float32Array(30), attr: new Float32Array(10), strands: [] }),
  });
  conductor.setGrowthMode('grow-fade');
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud, 'freeze exposes the composite');
  assert.ok(out.cloud.positions.length > 0);
  assert.equal(out.cloud.positions.length / 3, out.cloud.attr.length);
});

test('draw-in mode: new design reveals with progress instead of crossfade', async () => {
  const { conductor, log } = harness();
  conductor.setGrowthMode('draw-in');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);
  await settle();
  for (let i = 90; i < 150; i++) conductor.tick(i / 30); // progress advances
  assert.equal(log.xfades, 0);
  assert.equal(log.drawIns, 1);
  assert.ok(log.drawProgress.length > 0);
  assert.ok(log.drawProgress[log.drawProgress.length - 1] > log.drawProgress[0]);
});

test('switching back to morph restores crossfades', async () => {
  const { conductor, log } = harness();
  conductor.setGrowthMode('grow-keep');
  conductor.setGrowthMode('morph');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30);
  await settle();
  assert.equal(log.xfades, 1);
});
