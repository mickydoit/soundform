import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, chromaFromFFT, spectralFlux, buildFingerprint, bestTriad, buildTrajectory } from '../js/features.js';

const SR = 44100;

function sine(freq, n = 2048) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin(2 * Math.PI * freq * i / SR) * 0.5;
  return b;
}

test('detectPitch finds 440 Hz', () => {
  const { freq, confidence } = detectPitch(sine(440), SR);
  assert.ok(Math.abs(freq - 440) < 6, `got ${freq}`);
  assert.ok(confidence > 0.8);
});

test('detectPitch sweep: accurate across the 60-3200 Hz band (incl. whistle register)', () => {
  for (const f of [82, 110, 220, 440, 660, 950, 1000, 1200, 1500, 2000, 2500, 3200]) {
    const { freq, confidence } = detectPitch(sine(f), SR);
    const tol = Math.max(2, 0.01 * f);
    assert.ok(Math.abs(freq - f) <= tol, `expected ~${f} Hz, got ${freq}`);
    assert.ok(confidence > 0.85, `low confidence ${confidence} at ${f} Hz`);
  }
});

test('buildFingerprint: whistles at different pitches → distinct pitchMedian, no clamp', () => {
  const mkFrames = (freq) => {
    const frames = [];
    for (let k = 0; k < 60; k++) {
      const r = detectPitch(sine(freq), SR);
      const chroma = new Float32Array(12); chroma[3] = 1;
      frames.push({ pitchHz: r.freq, pitchConf: r.confidence, chroma,
                    flux: 0.02, rms: 0.08, centroid: 0.55, spread: 0.12 });
    }
    return frames;
  };
  const lo = buildFingerprint(mkFrames(1200), 2);
  const hi = buildFingerprint(mkFrames(2800), 2);
  assert.ok(lo.pitchMedian < 1 && hi.pitchMedian < 1, 'whistle register must not clamp to 1.0');
  assert.ok(hi.pitchMedian - lo.pitchMedian > 0.1,
    `whistles an octave+ apart must differ (lo=${lo.pitchMedian.toFixed(3)}, hi=${hi.pitchMedian.toFixed(3)})`);
  assert.notEqual(lo.seed, hi.seed);
});

test('detectPitch reports low confidence on noise', () => {
  const b = new Float32Array(2048);
  let s = 1; // deterministic LCG noise
  for (let i = 0; i < 2048; i++) { s = (s * 48271) % 2147483647; b[i] = (s / 2147483647 - 0.5) * 0.5; }
  assert.ok(detectPitch(b, SR).confidence < 0.6);
});

test('chromaFromFFT peaks at pitch class A for 440 Hz', () => {
  const mag = new Float32Array(1024);
  mag[Math.round(440 / (SR / 2048))] = 1;
  const c = chromaFromFFT(mag, SR, 2048);
  assert.equal(c.indexOf(Math.max(...c)), 9); // A = 9
});

test('spectralFlux positive on rising energy', () => {
  const a = new Float32Array(8).fill(0), b = new Float32Array(8).fill(1);
  assert.ok(spectralFlux(b, a) > 0);
  assert.equal(spectralFlux(a, b), 0);
});

function fakeFrames() {
  const frames = [];
  for (let i = 0; i < 120; i++) {
    const chroma = new Float32Array(12);
    chroma[0] = 1; chroma[4] = 0.8; chroma[7] = 0.7; // C major triad
    frames.push({ pitchHz: 261.6, pitchConf: 0.9, chroma, flux: i % 30 === 0 ? 0.5 : 0.02,
                  rms: 0.3 + 0.1 * Math.sin(i / 10), centroid: 0.4, spread: 0.3 });
  }
  return frames;
}

test('buildFingerprint: C major triad → consonant, major, 3 notes, deterministic', () => {
  const fp = buildFingerprint(fakeFrames(), 2.0);
  assert.deepEqual(fp.noteSet, [0, 4, 7]);
  assert.equal(fp.noteCount, 3);
  assert.ok(fp.consonance > 0.5);
  assert.equal(fp.majorLeaning, true);
  assert.ok(fp.pitchMedian > 0 && fp.pitchMedian < 1);
  const fp2 = buildFingerprint(fakeFrames(), 2.0);
  assert.equal(fp.seed, fp2.seed);
  assert.deepEqual([...fp.contour], [...fp2.contour]);
});

test('bestTriad finds C major from a C-E-G chroma', () => {
  const chroma = new Float32Array(12);
  chroma[0] = 1; chroma[4] = 0.8; chroma[7] = 0.9; // C E G
  const t = bestTriad(chroma);
  assert.equal(t.root, 0);
  assert.equal(t.major, true);
  assert.ok(t.score > 0.5);
});

test('bestTriad finds A minor from an A-C-E chroma', () => {
  const chroma = new Float32Array(12);
  chroma[9] = 1; chroma[0] = 0.85; chroma[4] = 0.9; // A C E
  const t = bestTriad(chroma);
  assert.equal(t.root, 9);
  assert.equal(t.major, false);
});

test('buildTrajectory packs 4 channels and zeroes unvoiced pitch', () => {
  const frames = [
    { centroid: 0.3, rms: 0.2, spread: 0.5, pitchHz: 220, pitchConf: 0.9 },
    { centroid: 0.6, rms: 0.1, spread: 0.2, pitchHz: 220, pitchConf: 0.1 },
  ];
  const t = buildTrajectory(frames);
  assert.equal(t.length, 8);
  assert.ok(Math.abs(t[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(t[3] - Math.log2(220 / 55) / 6) < 1e-6);
  assert.equal(t[7], 0); // low confidence → 0
});

// The live window is a flat 4s mean, so a new sound only reaches full weight
// after 4 seconds — the single largest term in the geometry lag. Weighting
// recent frames higher lets a change register while keeping 4s of context for
// stability. Uniform weights must stay byte-identical to the unweighted call,
// because the capture path relies on it (snapshot checksums).
test('buildFingerprint: uniform weights reproduce the unweighted result', () => {
  const frames = [];
  for (let i = 0; i < 40; i++) {
    const c = new Float32Array(12); c[i % 12] = 1; c[(i + 4) % 12] = 0.7;
    frames.push({ pitchHz: 110 + i * 4, pitchConf: 0.9, chroma: c,
                  rms: 0.1 + 0.002 * i, flux: 0.002, centroid: 0.3, spread: 0.4 });
  }
  const plain = buildFingerprint(frames, 4);
  const uniform = buildFingerprint(frames, 4, frames.map(() => 1));
  for (const k of ['pitchMedian', 'pitchConfidence', 'consonance', 'velocity',
                   'volMean', 'centroid', 'spread', 'seed']) {
    assert.equal(uniform[k], plain[k], `weighted-uniform changed ${k}`);
  }
  assert.deepEqual([...uniform.noteSet], [...plain.noteSet]);
});

test('buildFingerprint: recency weighting tracks a changed sound faster', () => {
  const mk = (hz, cent, spread, pc) => {
    const c = new Float32Array(12); c[pc] = 1; c[(pc + 7) % 12] = 0.8;
    return { pitchHz: hz, pitchConf: 0.9, chroma: c, rms: 0.15, flux: 0.002,
             centroid: cent, spread };
  };
  // 3s of a low hum, then 1s of a high bright tone — the moment 1s after a
  // change, with a 4s window.
  const frames = [];
  for (let i = 0; i < 45; i++) frames.push(mk(110, 0.15, 0.3, 0));
  for (let i = 0; i < 15; i++) frames.push(mk(880, 0.75, 0.7, 6));
  const target = buildFingerprint(Array.from({ length: 60 }, () => mk(880, 0.75, 0.7, 6)), 4);

  const flat = buildFingerprint(frames, 4);
  const w = [];
  for (let i = 0; i < frames.length; i++) w.push(Math.exp(-((frames.length - 1 - i) / 60 * 4) / 1.2));
  const recent = buildFingerprint(frames, 4, w);

  const dist = (fp) => Math.abs(fp.pitchMedian - target.pitchMedian)
                     + Math.abs(fp.centroid - target.centroid)
                     + Math.abs(fp.spread - target.spread);
  assert.ok(dist(recent) < dist(flat) * 0.6,
    `recency weighting barely helped (flat ${dist(flat).toFixed(3)} vs weighted ${dist(recent).toFixed(3)})`);
});
