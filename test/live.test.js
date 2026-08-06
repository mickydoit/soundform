import test from 'node:test';
import assert from 'node:assert/strict';
import { Envelope, KickDetector, trimWindow, fingerprintDelta,
         MORPH_THRESHOLD, MORPH_CHECK_INTERVAL, MORPH_CROSSFADE_SEC,
         MODULATE_CROSSFADE_SEC, MODULATE_INTERVAL,
         recencyWeights } from '../js/live.js';
import { generate as attractorGenerate } from '../js/generators/attractor.js';

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

import { LiveConductor, LIVE_MIN_FRAMES, clipStrandsToCount, sliceSegments, PAINT_SPLICE_CHUNK } from '../js/live.js';

const mkFrame = (o = {}) => ({
  pitchHz: 220, pitchConf: 0.9, rms: 0.15, flux: 0.002,
  centroid: 0.4, spread: 0.3,
  chroma: (() => { const c = new Float32Array(12); c[0] = 1; c[4] = 0.8; c[7] = 0.9; return c; })(),
  ...o,
});

function harness({ frame = mkFrame(), genDelay = 0, generate = null, getParams = null } = {}) {
  const log = { xfades: 0, xfadeDurations: [], waves: [], stops: [], paintBegun: 0, paintWrites: [], paintCounts: [], visibleFractions: [] };
  const conductor = new LiveConductor({
    audio: { getMusicalFrame: () => frame.current ?? frame },
    renderer: {
      setWave: (a, f) => log.waves.push([a, f]),
      setParams: () => {}, setPlaying: () => {}, setLoopPeriod: () => {},
      crossfadeTo: (positions, attr, dur) => { log.xfades++; log.xfadeDurations.push(dur); },
      setVisibleFraction: (v) => log.visibleFractions.push(v),
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

// Geometry lagged the sound by ~2s end-to-end. Four costs stacked in series:
// the flat 4s window diluted new audio (a change only reached full weight after
// 4s), MORPH_CHECK_INTERVAL added up to 0.75s, then worker generation, then a
// hardcoded 1.0s crossfade. Measured on a maximal hard switch with generation
// stubbed to zero: 1.00s to dispatch, 2.00s to finish.
test('conductor reacts to a changed sound quickly', async () => {
  const low = mkFrame({ pitchHz: 110, rms: 0.10, centroid: 0.12, spread: 0.30, flux: 0.0015 });
  const high = mkFrame({
    pitchHz: 900, rms: 0.30, centroid: 0.70, spread: 0.70, flux: 0.0090,
    chroma: (() => { const c = new Float32Array(12); c[6] = 1; c[10] = 0.9; c[1] = 0.85; return c; })(),
  });
  const frame = { current: low };
  const { conductor, log } = harness({ frame });

  const FPS = 60, SWITCH = 5;
  let dispatchedAt = null;
  for (let i = 0; i < FPS * 11; i++) {
    const t = i / FPS;
    if (t >= SWITCH) frame.current = high;
    const before = log.xfades;
    conductor.tick(t);
    await settle();
    if (t >= SWITCH && log.xfades > before && dispatchedAt === null) dispatchedAt = t - SWITCH;
  }
  assert.ok(dispatchedAt !== null, 'never reacted to the changed sound');
  assert.ok(dispatchedAt < 0.6,
    `geometry took ${dispatchedAt.toFixed(2)}s to start changing after the sound did`);
});

// Once a system is locked, continuous modulation means the design regenerates
// on every fast tick rather than waiting for a debounced threshold — frequent
// crossfading is now correct, it IS the deformation the voice drives. What
// still must never happen is the *system* changing mid-session: that is the
// difference between "the design breathes" and "the design got swapped out
// from under the listener". So this test no longer caps crossfade count; it
// asserts the invariant that actually matters — one speaker, talking
// continuously, must see the locked attractor system stay exactly one value
// for the whole session, no matter how much the geometry itself deforms.
test('one speaker talking does not churn the design', async () => {
  let s = 12345;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const speech = (t) => {                       // one voice, natural variation
    const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4.2 * t);
    const voiced = syl > 0.42 && rnd() > 0.12;
    const hz = 130 * (1 + 0.25 * Math.sin(2 * Math.PI * 0.35 * t)) * (1 + 0.1 * (rnd() - 0.5));
    const chroma = new Float32Array(12);
    for (let k = 0; k < 12; k++) chroma[k] = 0.25 * rnd();
    chroma[((Math.round(12 * Math.log2(hz / 55)) % 12) + 12) % 12] = 1;
    return { pitchHz: voiced ? hz : 0, pitchConf: voiced ? 0.6 + 0.3 * rnd() : 0.1 * rnd(),
             chroma, rms: 0.15 * (0.25 + 0.75 * syl) * (voiced ? 1 : 0.35),
             flux: 0.002 * syl * (voiced ? 1 : 2.2),
             centroid: 0.14 * (voiced ? 0.75 : 1.6) * (0.85 + 0.3 * rnd()),
             spread: 0.35 + 0.3 * (voiced ? 0.2 : 0.9) + 0.1 * rnd() };
  };
  const frame = { current: speech(0) };
  const seenSystems = [];
  const { conductor } = harness({
    frame,
    generate: async (fp, p) => {
      seenSystems.push(p.lockedSystem);
      return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] };
    },
  });
  const FPS = 60, DUR = 15;
  for (let i = 0; i < FPS * DUR; i++) {
    const t = i / FPS;
    frame.current = speech(t);
    conductor.tick(t);
    await settle();
  }
  // Floor of 1 would pass vacuously on a regression that collapsed modulation
  // to a single generation; DUR / MODULATE_INTERVAL is ~40-50 under correct
  // behaviour, so 10 is a real floor without being brittle to exact timing.
  assert.ok(seenSystems.length >= 10, `expected sustained modulation, got ${seenSystems.length}`);
  assert.equal(new Set(seenSystems).size, 1,
    `system changed mid-session under one speaker: ${[...new Set(seenSystems)].join(', ')}`);
  assert.equal(conductor.lockedSystem, seenSystems[0], 'conductor.lockedSystem must match what generate saw');
});

test('morph crossfade is short enough to feel responsive', () => {
  assert.ok(MORPH_CROSSFADE_SEC <= 0.5, `crossfade ${MORPH_CROSSFADE_SEC}s reads as sluggish`);
  assert.ok(MORPH_CHECK_INTERVAL <= 0.35, `check interval ${MORPH_CHECK_INTERVAL}s adds needless lag`);
});

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

test('sliceSegments with no steer boundaries returns one segment covering everything', () => {
  const positions = new Float32Array(300); // 100 points
  const out = sliceSegments(positions, [0], 100);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, 300);
});

test('sliceSegments splits at each recorded boundary', () => {
  const positions = new Float32Array(1500); // 500 points
  const out = sliceSegments(positions, [0, 200, 350], 500);
  assert.equal(out.length, 3);
  assert.equal(out[0].length, 200 * 3);
  assert.equal(out[1].length, 150 * 3);
  assert.equal(out[2].length, 150 * 3);
});

test('paint (attractor): steering records a segment boundary, freeze attaches segments', async () => {
  const frame = { current: mkFrame() };
  const { conductor } = harness({ frame });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30); // 3s — paints, no steer yet
  await settle();
  const c2 = new Float32Array(12); c2[2] = 1; c2[6] = 0.85; c2[9] = 0.9; // different chord
  frame.current = mkFrame({ pitchHz: 880, chroma: c2 });
  for (let i = 90; i < 300; i++) conductor.tick(i / 30); // steer should fire on the change
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud.strands.length >= 1, 'at least one segment attached');
  const totalPoints = out.cloud.strands.reduce((n, s) => n + s.length / 3, 0);
  assert.equal(totalPoints, out.cloud.positions.length / 3, 'segments cover exactly the painted points');
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

test('clipStrandsToCount returns strands unchanged when the reveal completed', () => {
  const strands = [new Float32Array(30), new Float32Array(60)]; // 10 and 20 points
  const out = clipStrandsToCount(strands, 1000, 1000);
  assert.equal(out, strands);
});

test('clipStrandsToCount truncates every strand to the same revealed fraction', () => {
  const a = new Float32Array(40 * 3); // 40 points
  const b = new Float32Array(10 * 3); // 10 points
  const out = clipStrandsToCount([a, b], 1000, 500); // 50% revealed
  assert.equal(out[0].length, 20 * 3, 'strand a truncated to 50% of its own points');
  assert.equal(out[1].length, 5 * 3, 'strand b truncated to 50% of its own points');
});

test('clipStrandsToCount truncates object-strand pts and preserves tone metadata', () => {
  const obj = { pts: new Float32Array(40 * 3), tone: 0.7, band: 3, ring: 5 };
  const bare = new Float32Array(10 * 3);
  const out = clipStrandsToCount([obj, bare], 1000, 500); // 50% revealed
  assert.equal(out[0].pts.length, 20 * 3, 'object strand pts truncated to 50%');
  assert.equal(out[0].tone, 0.7);
  assert.equal(out[0].band, 3);
  assert.equal(out[0].ring, 5);
  assert.ok(out[1] instanceof Float32Array, 'bare strand stays a bare array');
  assert.equal(out[1].length, 5 * 3, 'bare strand truncated to 50%');
});

test('paint (non-attractor): freeze attaches the revealed strands', async () => {
  const strandA = new Float32Array(200 * 3);
  const { conductor } = harness({
    generate: async (fp, p) => ({
      positions: new Float32Array(p.density * 3), attr: new Float32Array(p.density),
      strands: [strandA],
    }),
    getParams: () => ({ mode: 'radial', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, paintMaxPoints: 5000,
                        exposure: 30, scale: 1, grain: 1 }),
  });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) { conductor.tick(i / 30); if (i % 15 === 14) await settle(); }
  await settle();
  const out = conductor.freeze();
  assert.ok(out.cloud.strands, 'strands must be attached to the frozen cloud');
  assert.equal(out.cloud.strands.length, 1);
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

test('paint splice never overwrites points already on screen', async () => {
  // _requestReveal captured spliceFrom at REQUEST time, but generation is
  // async and st.count keeps advancing - so completion wrote over up to ~2000
  // points the user could already see. That is the visible "jump".
  //
  // A single reveal with a constant fingerprint (the earlier version of this
  // test) only ever exercises spliceFrom = 0 — st.count can't have advanced
  // before the FIRST generation resolves, because revealTotal is still 0 and
  // the brush-advance branch is gated on revealTotal > 0. That can't tell the
  // fixed `Math.max(spliceFrom, st.count)` apart from the old, buggy
  // `spliceFrom` alone; both give 0. To actually exercise the staleness bug
  // this drives a SECOND, steering-triggered reveal (via forceMorph, the same
  // lever a settings tweak uses) while the brush keeps advancing on the
  // first-revealed design, and only resolves that second generation once
  // st.count has genuinely moved past the spliceFrom it captured — the exact
  // interleaving the brief describes.
  const violations = [];
  let visible = 0;
  const frame = { current: mkFrame({ rms: 0.3 }) };
  let genCall = 0;
  let resolveFirst = null, resolveSecond = null;
  let capturedSpliceFrom = null;
  const { conductor } = harness({
    frame,
    generate: () => {
      genCall++;
      if (genCall === 1) {
        return new Promise((res) => { resolveFirst = () => res({
          positions: new Float32Array(60000 * 3), attr: new Float32Array(60000), strands: [] }); });
      }
      capturedSpliceFrom = conductor.paint.count;   // the spliceFrom this call will use
      return new Promise((res) => { resolveSecond = () => res({
        positions: new Float32Array(60000 * 3), attr: new Float32Array(60000), strands: [] }); });
    },
    getParams: () => ({ mode: 'cymatics', cymStyle: 'auto', complexity: 0.5, symmetry: 1, twist: 0,
                        liveDensity: 1000, exposure: 30, scale: 1, grain: 1, paintMaxPoints: 60000 }),
  });
  conductor.setGrowthMode('paint');
  conductor.paintMax = 60000;
  const r = conductor.renderer;
  r.setPaintCount = (n) => { visible = n; };
  r.writePaintPoints = (offset, pos) => {
    if (offset < visible) violations.push({ offset, visible, n: pos.length / 3 });
  };

  let secondRequested = false, countAtResolution = null;
  for (let i = 0; i < 60 * 30; i++) {
    conductor.tick(i / 60);
    if (resolveFirst) { resolveFirst(); resolveFirst = null; }   // let revealTotal populate ASAP
    if (!secondRequested && conductor.paint.count > 20000) {
      conductor.forceMorph();       // real steering reveal, spliceFrom = st.count now
      secondRequested = true;
    }
    if (secondRequested && resolveSecond && conductor.paint.count > 40000) {
      countAtResolution = conductor.paint.count;   // st.count has moved well past capturedSpliceFrom
      resolveSecond(); resolveSecond = null;
    }
    await settle();
  }

  assert.equal(genCall, 2,
    'test setup sanity: expected one initial reveal and one steering-triggered reveal');
  assert.ok(countAtResolution !== null && capturedSpliceFrom !== null
    && countAtResolution > capturedSpliceFrom,
    'test setup sanity: st.count must advance past the captured spliceFrom before the second ' +
    `generation resolves (spliceFrom=${capturedSpliceFrom}, count at resolution=${countAtResolution}) ` +
    '- otherwise this test cannot distinguish the fix from the pre-fix code');
  assert.equal(violations.length, 0,
    `splice overwrote visible points: ${JSON.stringify(violations[0])}`);
});

test('paint splice writes in bounded chunks', async () => {
  const sizes = [];
  const frame = { current: mkFrame({ rms: 0.3 }) };
  const { conductor } = harness({
    frame,
    generate: async () => ({ positions: new Float32Array(600000 * 3), attr: new Float32Array(600000), strands: [] }),
    getParams: () => ({ mode: 'cymatics', cymStyle: 'auto', complexity: 0.5, symmetry: 1, twist: 0,
                        liveDensity: 1000, exposure: 30, scale: 1, grain: 1, paintMaxPoints: 600000 }),
  });
  conductor.setGrowthMode('paint');
  conductor.paintMax = 600000;
  conductor.renderer.writePaintPoints = (o, pos) => sizes.push(pos.length / 3);
  for (let i = 0; i < 60 * 6; i++) { conductor.tick(i / 60); await settle(); }
  const biggest = Math.max(0, ...sizes);
  assert.ok(biggest <= PAINT_SPLICE_CHUNK,
    `single write of ${biggest} points (~${(biggest * 16 / 1e6).toFixed(1)} MB) will hitch the frame`);
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
      // paint-mode requests resolve instantly; the morph one is held open.
      // Both calls now carry strandCount: 8 (Task 5 lowered the structural
      // call to match), so discriminate on density instead: paint reveals
      // request up to PAINT_MAX_POINTS (600k), structural morphs request
      // liveDensity (1000 here).
      if (p.liveVariance && p.density > 50000) {
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

test('conductor locks the attractor system for the whole session', async () => {
  const seen = [];
  const frame = { current: mkFrame() };
  const { conductor } = harness({
    frame,
    generate: async (fp, p) => { seen.push(p.lockedSystem); return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] }; },
  });
  // wildly different sounds across the session
  const variants = [
    mkFrame({ pitchHz: 110, centroid: 0.1, rms: 0.1 }),
    mkFrame({ pitchHz: 880, centroid: 0.8, rms: 0.3, flux: 0.02 }),
    mkFrame({ pitchHz: 220, centroid: 0.3, rms: 0.05 }),
    mkFrame({ pitchHz: 1400, centroid: 0.9, rms: 0.35, flux: 0.03 }),
  ];
  for (let i = 0; i < 60 * 20; i++) {
    frame.current = variants[Math.floor(i / (60 * 5)) % variants.length];
    conductor.tick(i / 60);
    await settle();
  }
  assert.ok(seen.length >= 2, `expected several generations, got ${seen.length}`);
  assert.ok(seen.every((s) => typeof s === 'string' && s.length > 0), 'every call must carry lockedSystem');
  assert.equal(new Set(seen).size, 1, `system changed mid-session: ${[...new Set(seen)].join(', ')}`);
});

test('conductor releases the lock on clear / growth-mode switch', () => {
  const { conductor } = harness();
  for (let i = 0; i < 40; i++) conductor.tick(i / 60);
  conductor.setGrowthMode('paint');
  assert.equal(conductor.lockedSystem, null, 'switching mode must release the lock');
});

// I4: spec says the system lock is "cleared on Clear and on mode switch", but
// a generator-mode change (attractor/cymatics/…) only ever called
// forceMorph() — same as a settings tweak — so the lock survived a mode
// switch and a listener who disliked their locked form had no escape short
// of Clear. main.js's mode-button handler now also calls resetLock(); this
// covers the conductor-side half of that fix (main.js's DOM wiring can't be
// unit-tested here — it has no non-browser entry point).
test('conductor.resetLock releases the system lock without touching growth mode', async () => {
  const { conductor } = harness();
  for (let i = 0; i < 40; i++) conductor.tick(i / 60);
  await settle();
  assert.ok(conductor.lockedSystem, 'session should have locked a system by now');
  const modeBefore = conductor.growthMode;
  conductor.resetLock();
  assert.equal(conductor.lockedSystem, null, 'resetLock must clear the lock');
  assert.equal(conductor.growthMode, modeBefore,
    'resetLock must not itself touch growth mode — a mode-button click sets params.mode separately');
  // The next generation must pick a fresh system from the CURRENT sound, not
  // silently re-adopt the old one from stale state. Mirrors main.js's actual
  // mode-button handler, which pairs resetLock() with forceMorph() — the
  // sound hasn't changed here, so without forceMorph the debounce would
  // never fire and this would hang forever waiting for a "real" change.
  // forceMorph() only affects the `due` check, not MORPH_MIN_INTERVAL's
  // (1.5s) own gate on `allowed`, so tick well past that gap too.
  conductor.forceMorph();
  for (let i = 40; i < 300; i++) conductor.tick(i / 60);
  await settle();
  assert.ok(conductor.lockedSystem, 'a system must be re-picked after the lock is released');
});

// I3: the morph-generate call read complexity/twist straight off the
// voice-driven AutoParams glide (this.auto.value), bypassing params
// entirely — so dragging Twist or Complexity in live morph mode changed the
// slider and visibly did nothing, forever (main.js's autoOwned only stopped
// the SLIDER being overwritten; the conductor never read the user's value).
// main.js now exposes autoOwned via getParams(), and the conductor must use
// p.complexity/p.twist — not a.complexity/a.twist — for any key the user has
// taken manual ownership of.
test('conductor honours manual ownership of complexity/twist, ignoring the auto glide', async () => {
  const gens = [];
  // A bright, rough voice pulls AutoParams' complexity/twist targets well
  // away from the manual values below, so this only passes for the right
  // reason (see the sanity check at the end).
  const frame = { current: mkFrame({ pitchHz: 900, centroid: 0.8, spread: 0.7, flux: 0.02 }) };
  const { conductor } = harness({
    frame,
    generate: async (fp, p) => { gens.push({ complexity: p.complexity, twist: p.twist }); return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] }; },
    getParams: () => ({ mode: 'attractor', complexity: 0.2, symmetry: 1, twist: -0.6,
                        cymStyle: 'auto', liveDensity: 1000, exposure: 30, scale: 1, grain: 1,
                        autoOwned: { complexity: false, twist: false } }),
  });
  for (let i = 0; i < 60 * 8; i++) { conductor.tick(i / 60); await settle(); }
  assert.ok(gens.length >= 2, `expected several generations, got ${gens.length}`);
  for (const g of gens) {
    assert.equal(g.complexity, 0.2, 'manual complexity must reach generate(), not the auto-glided value');
    assert.equal(g.twist, -0.6, 'manual twist must reach generate(), not the auto-glided value');
  }
  // If auto and manual coincidentally matched, the assertions above would
  // pass vacuously on the very regression this test targets. Confirm the
  // internal glide actually moved away from the manual values.
  assert.notEqual(conductor.auto.value.complexity, 0.2,
    'fixture must exercise a real glide away from the manual complexity value');
  assert.notEqual(conductor.auto.value.twist, -0.6,
    'fixture must exercise a real glide away from the manual twist value');
});

// Ownership can be per-key: complexity released back to auto while twist
// stays manual (or vice versa) must not fall back to all-or-nothing.
test('conductor honours per-key ownership: one released, one still manual', async () => {
  const gens = [];
  const frame = { current: mkFrame({ pitchHz: 900, centroid: 0.8, spread: 0.7, flux: 0.02 }) };
  const { conductor } = harness({
    frame,
    generate: async (fp, p) => { gens.push({ complexity: p.complexity, twist: p.twist }); return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] }; },
    getParams: () => ({ mode: 'attractor', complexity: 0.2, symmetry: 1, twist: -0.6,
                        cymStyle: 'auto', liveDensity: 1000, exposure: 30, scale: 1, grain: 1,
                        autoOwned: { complexity: true, twist: false } }),
  });
  for (let i = 0; i < 60 * 8; i++) { conductor.tick(i / 60); await settle(); }
  assert.ok(gens.length >= 2, `expected several generations, got ${gens.length}`);
  for (const g of gens) assert.equal(g.twist, -0.6, 'manual twist must reach generate() while complexity stays auto-owned');
  const cs = gens.map(g => g.complexity);
  assert.ok(Math.max(...cs) - Math.min(...cs) > 0.01 || cs[0] !== 0.2,
    'complexity should track the auto glide, not the (unrelated) manual value, once released');
});

// Paint mode with the default mode: 'attractor' never calls conductor.generate
// at all — createOrbitBrush picks its own system independently. The lock must
// still be recorded (Task 6 depends on it existing), and it must agree with
// the brush's own choice since both are derived from the same fingerprint.
test('conductor locks the system in attractor-mode paint, matching the brush', async () => {
  const frame = { current: mkFrame() };
  const { conductor } = harness({ frame });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 90; i++) conductor.tick(i / 30); // enough sound to begin the brush
  await settle();
  assert.ok(conductor.paint.brush, 'brush should have been created');
  assert.ok(typeof conductor.lockedSystem === 'string' && conductor.lockedSystem.length > 0,
    'lockedSystem must be recorded, not left null');
  assert.equal(conductor.lockedSystem, conductor.paint.brush.system,
    'recorded lock must match the system the brush actually chose');
});

test('live modulation deforms continuously instead of swapping designs', async () => {
  const gens = [];
  const frame = { current: mkFrame() };
  const { conductor, log } = harness({
    frame,
    generate: async (fp, p) => { gens.push({ complexity: p.complexity, twist: p.twist }); return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] }; },
  });
  for (let i = 0; i < 60 * 12; i++) {
    const t = i / 60;
    frame.current = mkFrame({ centroid: 0.2 + 0.5 * Math.min(1, t / 10), rms: 0.12 + 0.1 * Math.min(1, t / 10) });
    conductor.tick(t);
    await settle();
  }
  assert.ok(gens.length >= 6, `expected continuous regeneration, got ${gens.length}`);
  // consecutive regenerations must differ only slightly - that is what makes it
  // a deformation rather than a swap
  for (let i = 1; i < gens.length; i++) {
    const d = Math.abs(gens[i].complexity - gens[i - 1].complexity);
    assert.ok(d < 0.2, `complexity jumped ${d.toFixed(3)} between consecutive generations`);
  }
  assert.ok(log.xfades >= 6, 'modulation must reach the renderer');
  // The harness's getParams supplies a constant p.complexity (0.5). If the
  // generate call were wired to p.complexity instead of the glided auto
  // value, every consecutive delta above would trivially be 0 < 0.2 and this
  // test would pass on a regression that disconnected the voice entirely.
  const cs = gens.map(g => g.complexity);
  assert.ok(Math.max(...cs) - Math.min(...cs) > 0.05, 'complexity never moved — auto params not reaching generate');
});

// M7 — the spec's headline regression test: "Per-step continuity: consecutive
// regenerations stay above ~0.85 cell overlap. This is the direct regression
// test for 'morphs rather than chops'." The test above shares this test's
// name-ish territory but only ever checks that p.complexity moves by < 0.2 —
// it never generates a real cloud, so it stayed green through the C1
// regression (halvorsen's widened `spread` term multiplying fingerprint
// drift 3.5-8.5x). This test simulates a live session end-to-end (rolling
// window → fingerprint every MODULATE_INTERVAL → glided AutoParams →
// generate() with lockedSystem) through the REAL LiveConductor and the REAL
// attractor generator, and measures the same cell-occupancy Jaccard metric
// test/generators.test.js uses elsewhere in this suite, at PRODUCTION
// density (250k) — 30k is dominated by sampling noise (median 0.73-0.82;
// minima as low as 0.04) while 250k is the density that actually separates a
// real regression from noise (median 0.83-0.91).
//
// Thresholds are set from what the fixed code measures today (see the
// halvorsen/aizawa liveCoeffs comments in js/generators/attractor.js for the
// full numbers), with margin, but tight enough to fail on a regression:
// verified by temporarily reintroducing C1's halvorsen
// `spread = 0.14 + 0.20 * cx` (drops that system's min to 0.380, <0.50 count
// to 2) and separately I2's un-narrowed aizawa coefficient ranges (drops
// that system's min to 0.420, <0.50 count to 2) — both fail min >= 0.55 and
// below50 === 0 below, then reverted.

// Mirrors test/generators.test.js's cellsOf/jaccard (same 20³ grid over
// [-1.3, 1.3]). Not imported directly: `node --test test/*.test.js` runs
// each matched file as its own test-runner process, and importing another
// *.test.js file would re-register and re-run its tests inside this one.
function cellsOf250k(out) {
  const s = new Set(); const n = out.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const q = (d) => Math.min(19, Math.max(0, Math.floor((out.positions[i * 3 + d] + 1.3) / 2.6 * 20)));
    s.add((q(0) * 20 + q(1)) * 20 + q(2));
  }
  return s;
}
function jaccard250k(a, b) {
  let inter = 0; for (const v of a) if (b.has(v)) inter++;
  return inter / (a.size + b.size - inter);
}

// Continuous speech stream: same per-frame model as 'one speaker talking does
// not churn the design' above, parameterized so (f0, rate, bright) combos
// land on each of the four flow systems via the app's real register×delivery
// routing (pickSystemLive).
function makeSpeechStream({ f0, jitter, voicedFrac, rate, loud, bright, seed }) {
  let s = seed;
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  return (t) => {
    const syl = 0.5 + 0.5 * Math.sin(2 * Math.PI * rate * t);
    const voiced = syl > (1 - voicedFrac) && rnd() > 0.12;
    const hz = f0 * (1 + 0.25 * Math.sin(2 * Math.PI * 0.35 * t + seed)) * (1 + jitter * (rnd() - 0.5));
    const chroma = new Float32Array(12);
    for (let k = 0; k < 12; k++) chroma[k] = 0.25 * rnd();
    chroma[((Math.round(12 * Math.log2(hz / 55)) % 12) + 12) % 12] = 1;
    return {
      pitchHz: voiced ? hz : 0,
      pitchConf: voiced ? 0.6 + 0.3 * rnd() : 0.1 * rnd(),
      chroma, rms: loud * (0.25 + 0.75 * syl) * (voiced ? 1 : 0.35),
      flux: 0.002 * syl * (voiced ? 1 : 2.2) * loud,
      centroid: bright * (voiced ? 0.75 : 1.6) * (0.85 + 0.3 * rnd()),
      spread: 0.35 + 0.3 * (voiced ? 0.2 : 0.9) + 0.1 * rnd(),
    };
  };
}

// Three voices per system, picked by sweeping f0/rate/bright and bucketing
// by which system a full session actually locks onto (verified fallback-free:
// none of these ever exhausts the retry loop into a capture-path fallback).
// Voices within one system's routing cell necessarily share register/delivery
// character — that IS the app's routing (see pickSystemLive's "six cells over
// four systems" comment) — so diversity here comes from f0/rate/bright, not
// from spanning cells that would just route to a different system.
const M7_VOICES = {
  thomas: [
    { f0: 250, rate: 3.8, bright: 0.12, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2326 },
    { f0: 300, rate: 5.0, bright: 0.16, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2407 },
    { f0: 220, rate: 2.2, bright: 0.26, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2284 },
    // These two were missed by the original three fixtures: a code-review
    // ablation of this branch's complexify()-on-`b` addition (attractor.js,
    // commit cb61fa2) showed these voices hit the capture-path fallback
    // (attractor.js:488) repeatedly, tanking consecutive-regeneration
    // overlap to 0.013/0.110 — the M7 test passed (min 0.653) without them
    // only because the original three never exercised the fallback.
    { f0: 150, rate: 5.2, bright: 0.22, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 9023 },
    { f0: 330, rate: 2.4, bright: 0.22, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 9037 },
  ],
  halvorsen: [
    { f0: 70, rate: 3.0, bright: 0.12, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2006 },
    { f0: 70, rate: 3.8, bright: 0.08, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2010 },
    { f0: 85, rate: 4.5, bright: 0.08, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2050 },
  ],
  aizawa: [
    { f0: 220, rate: 5.0, bright: 0.16, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2302 },
    { f0: 300, rate: 5.5, bright: 0.16, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2412 },
    { f0: 280, rate: 6.0, bright: 0.08, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2380 },
  ],
  lorenz: [
    { f0: 100, rate: 6.0, bright: 0.26, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2104 },
    { f0: 70,  rate: 5.0, bright: 0.20, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2023 },
    { f0: 70,  rate: 4.5, bright: 0.16, jitter: 0.06, voicedFrac: 0.6, loud: 0.14, seed: 2017 },
  ],
};

// Simulates one live session (6s at 60fps) for a voice through the real
// LiveConductor tick loop, generating REAL attractor geometry at production
// density (250k) on every regeneration, and returns the consecutive
// cell-occupancy Jaccard for every regeneration once the system has locked.
async function runContinuitySession(cfg, expectSystem) {
  const stream = makeSpeechStream(cfg);
  const frame = { current: stream(0) };
  const overlaps = [];
  let prevCells = null;
  const { conductor } = harness({
    frame,
    generate: async (fp, p) => {
      const out = attractorGenerate(fp, { ...p, density: 250000 });
      const cells = cellsOf250k(out);
      if (prevCells) overlaps.push(jaccard250k(prevCells, cells));
      prevCells = cells;
      return out;
    },
    getParams: () => ({ mode: 'attractor', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 250000, exposure: 30, scale: 1, grain: 1 }),
  });
  const FPS = 60, DUR = 6;
  for (let i = 0; i < FPS * DUR; i++) {
    const t = i / FPS;
    frame.current = stream(t);
    conductor.tick(t);
    await settle();
  }
  assert.equal(conductor.lockedSystem, expectSystem,
    `fixture routing drifted: expected ${expectSystem}, session locked ${conductor.lockedSystem}`);
  return overlaps;
}

for (const system of ['thomas', 'halvorsen', 'aizawa', 'lorenz']) {
  test(`live modulation: per-step geometric continuity holds at production density — ${system}`, async () => {
    let min = 1, below50 = 0, total = 0;
    for (const cfg of M7_VOICES[system]) {
      const overlaps = await runContinuitySession(cfg, system);
      assert.ok(overlaps.length >= 10, `expected sustained modulation, got ${overlaps.length} steps`);
      for (const v of overlaps) { min = Math.min(min, v); if (v < 0.50) below50++; total++; }
    }
    assert.ok(min >= 0.55,
      `${system}: consecutive-regeneration overlap dropped to ${min.toFixed(3)} — design chopped, not morphed`);
    assert.equal(below50, 0,
      `${system}: ${below50}/${total} steps fell below 0.50 overlap — design chopped, not morphed`);
  });
}

test('modulation crossfade is short enough to read as deformation', () => {
  assert.ok(MODULATE_CROSSFADE_SEC <= 0.2,
    `${MODULATE_CROSSFADE_SEC}s reads as a dissolve between designs, not a deformation`);
});

test('modulation interval is not faster than generation can complete', () => {
  assert.ok(MODULATE_INTERVAL >= 0.2, `${MODULATE_INTERVAL}s regenerates faster than generation completes`);
});

test('conductor reports auto parameters for the sliders', async () => {
  const seen = [];
  const { conductor } = harness();
  conductor.onAutoParams = (v) => seen.push(v);
  for (let i = 0; i < 120; i++) { conductor.tick(i / 60); await settle(); }
  assert.ok(seen.length > 0, 'onAutoParams never fired');
  const last = seen[seen.length - 1];
  for (const k of ['complexity', 'twist', 'scale', 'visibleFraction']) {
    assert.ok(typeof last[k] === 'number' && Number.isFinite(last[k]), `${k} missing from auto params`);
  }
});

// _lockSystem() records a lock for every mode (Task 5's behaviour, needed so
// paint's attractor brush and future mode switches have somewhere to read
// from), but the fast modulation cadence must only engage when that lock is
// actually consumed — today, only attractor mode passes lockedSystem into the
// generator. Without the mode gate, cymatics/radial/oscillo/harmonic would
// all regenerate unconditionally every MODULATE_INTERVAL with no fingerprint
// anchoring identity, which is exactly the "chopping and changing" this task
// exists to remove.
test('modulation cadence does not engage outside attractor mode', async () => {
  const gens = [];
  const frame = { current: mkFrame() };
  const { conductor } = harness({
    frame,
    generate: async (fp, p) => { gens.push(p); return { positions: new Float32Array(3), attr: new Float32Array(1), strands: [] }; },
    getParams: () => ({ mode: 'cymatics', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, exposure: 30, scale: 1, grain: 1 }),
  });
  const DUR = 10, FPS = 60;
  for (let i = 0; i < FPS * DUR; i++) {
    conductor.tick(i / FPS);
    await settle();
  }
  assert.ok(conductor.lockedSystem, 'lock is still recorded regardless of mode (Task 5 behaviour)');
  // Steady sound in a mode that does not consume the lock: this must fall
  // back to the debounced morph cadence (one morph, then min-interval), not
  // the fast modulation cadence — MODULATE_INTERVAL would produce ~40
  // regenerations in 10s if the mode gate were missing.
  assert.equal(gens.length, 1,
    `non-attractor mode regenerated on the modulation cadence (${gens.length} calls in ${DUR}s)`);
});

// While modulating, the fingerprint-delta debounce is bypassed entirely, so
// the only thing standing between a persistently failing generator and a
// zero-gap retry loop (which, combined with the main-thread synchronous
// worker fallback, is a hard UI freeze) is lastMorph advancing on failure
// paths too, not just on success.
test('a generator that always rejects does not produce an unbounded dispatch storm', async () => {
  let calls = 0;
  const frame = { current: mkFrame() };
  const { conductor } = harness({
    frame,
    generate: async () => { calls++; throw new Error('boom'); },
  });
  const DUR = 10, FPS = 60;
  for (let i = 0; i < FPS * DUR; i++) {
    conductor.tick(i / FPS);
    await settle();
  }
  assert.ok(calls <= Math.ceil(DUR / MODULATE_INTERVAL) + 2,
    `failing generator dispatched ${calls} times in ${DUR}s — no backpressure`);
});

// setVisibleFraction is the "costs nothing" half of the auto-params layer —
// it must actually reach the renderer and move with loudness, not just be
// called with an unread value.
test('auto visibleFraction responds to loudness', async () => {
  const frame = { current: mkFrame({ rms: 0.05 }) };
  const { conductor, log } = harness({ frame });
  for (let i = 0; i < 120; i++) { conductor.tick(i / 60); await settle(); }
  assert.ok(log.visibleFractions.length > 0, 'setVisibleFraction never called');
  const quiet = log.visibleFractions[log.visibleFractions.length - 1];
  frame.current = mkFrame({ rms: 0.35 });
  for (let i = 120; i < 300; i++) { conductor.tick(i / 60); await settle(); }
  const loud = log.visibleFractions[log.visibleFractions.length - 1];
  assert.ok(loud > quiet, `visibleFraction did not rise with loudness (quiet=${quiet}, loud=${loud})`);
});

// crossfadeTo's duration must track the same gate as the modulation cadence
// itself (`modulating`, i.e. locked AND attractor mode) — not raw
// `lockedSystem`, which Task 5 sets for every mode regardless of whether that
// mode consumes it. Using raw lockedSystem here would give cymatics/radial/
// oscillo/harmonic morphs the fast 0.15s crossfade after their first design,
// even though Critical 1 correctly kept their regeneration on the slow,
// debounced cadence — a flash cut where a dissolve was intended.
test('crossfade duration matches the modulation gate, not raw lockedSystem', async () => {
  // Attractor mode: once modulating, crossfades use the fast modulation duration.
  const attractorFrame = { current: mkFrame() };
  const { conductor: ac, log: alog } = harness({ frame: attractorFrame });
  for (let i = 0; i < 60 * 3; i++) { ac.tick(i / 60); await settle(); }
  assert.ok(alog.xfadeDurations.length >= 2, 'expected several attractor crossfades');
  assert.ok(alog.xfadeDurations.slice(1).every((d) => d === MODULATE_CROSSFADE_SEC),
    `attractor crossfades after the first must use MODULATE_CROSSFADE_SEC, got ${alog.xfadeDurations.slice(1)}`);

  // Cymatics mode: lockedSystem is still recorded (Task 5), but the mode does
  // not consume it — every morph, including ones AFTER lockedSystem is set,
  // must keep the slower MORPH_CROSSFADE_SEC dissolve.
  const cymFrame = { current: mkFrame() };
  const { conductor: cc, log: clog } = harness({
    frame: cymFrame,
    getParams: () => ({ mode: 'cymatics', complexity: 0.5, symmetry: 1, twist: 0,
                        cymStyle: 'auto', liveDensity: 1000, exposure: 30, scale: 1, grain: 1 }),
  });
  for (let i = 0; i < 70; i++) cc.tick(i / 30);   // first morph — sets lockedSystem
  await settle();
  assert.equal(clog.xfades, 1);
  assert.ok(cc.lockedSystem, 'lock is recorded even though cymatics does not consume it');
  const c2 = new Float32Array(12); c2[2] = 1; c2[6] = 0.85; c2[9] = 0.9; // different chord
  cymFrame.current = mkFrame({ pitchHz: 880, chroma: c2 });
  for (let i = 70; i < 220; i++) cc.tick(i / 30);  // 5 more seconds, real sound change
  await settle();
  assert.ok(clog.xfades >= 2, 'expected a second cymatics morph after lockedSystem was set');
  assert.ok(clog.xfadeDurations.slice(1).every((d) => d === MORPH_CROSSFADE_SEC),
    `cymatics morphs after lockedSystem is set must use MORPH_CROSSFADE_SEC, got ${clog.xfadeDurations.slice(1)}`);
});

// ── Paint pause / resume ───────────────────────────────────────────────────
// Before this, freeze() was terminal for a painting: main.js nulled the
// conductor, so the brush's live orbit, the BrushPace envelope, the revealed
// count and the segment boundaries were all destroyed. The only way back to a
// canvas was Clear, which discards the painting entirely.

test('freeze marks a painted session resumable and keeps its paint state', async () => {
  const frame = { current: mkFrame({ rms: 0.3 }) };
  const { conductor } = harness({ frame });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 200; i++) { conductor.tick(i / 60); await settle(); }
  const before = conductor.paint.count;
  assert.ok(before > 0, 'fixture must actually paint something');

  const out = conductor.freeze();
  assert.ok(out, 'freeze must produce a capture');
  assert.equal(out.resumable, true, 'a painted session must report itself resumable');
  assert.ok(conductor.canResume(), 'paint state must survive freeze');
  assert.equal(conductor.paint.count, before, 'freeze must not discard the revealed count');
  assert.ok(conductor.paint.begun, 'freeze must not reset the canvas');
});

test('a non-painted live session is not resumable', async () => {
  const { conductor } = harness();
  for (let i = 0; i < 80; i++) { conductor.tick(i / 60); await settle(); }
  const out = conductor.freeze();
  assert.ok(out, 'freeze must produce a capture');
  assert.ok(!out.resumable, 'morph sessions have no painting to resume');
  assert.ok(!conductor.canResume());
});

test('resume rebuilds the paint buffer and continues from the same count', async () => {
  const frame = { current: mkFrame({ rms: 0.3 }) };
  const { conductor, log } = harness({ frame });
  conductor.setGrowthMode('paint');
  for (let i = 0; i < 200; i++) { conductor.tick(i / 60); await settle(); }
  const frozenAt = conductor.paint.count;
  const out = conductor.freeze();
  assert.ok(!conductor.running, 'freeze must stop the loop');

  log.paintBegun = 0; log.paintWrites.length = 0;
  const ok = conductor.resume(out.cloud, 600000);
  assert.equal(ok, true, 'resume must succeed on a resumable session');
  assert.equal(log.paintBegun, 600000, 'resume must re-allocate the paint buffer');
  assert.deepEqual(log.paintWrites[0], [0, frozenAt],
    'resume must write the frozen cloud back from offset 0');
  assert.equal(conductor.paint.count, frozenAt, 'resume must not rewind the painting');
  assert.ok(conductor.running, 'resume must restart the loop');

  // and it keeps painting from there
  for (let i = 0; i < 60; i++) { conductor.tick(10 + i / 60); await settle(); }
  assert.ok(conductor.paint.count > frozenAt, 'painting must continue past the frozen count');
});

test('resume refuses when there is nothing to resume', async () => {
  const { conductor } = harness();
  for (let i = 0; i < 80; i++) { conductor.tick(i / 60); await settle(); }
  conductor.freeze();
  assert.equal(conductor.resume({ positions: new Float32Array(3), attr: new Float32Array(1) }, 1000), false,
    'a morph session must not be resumable as a painting');
});
