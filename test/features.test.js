import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, chromaFromFFT, spectralFlux, buildFingerprint } from '../js/features.js';

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
