import { fnv1a } from './generators/common.js';

// Autocorrelation pitch detector (NAC). buf = time-domain Float32Array.
export function detectPitch(buf, sampleRate) {
  const n = buf.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.01) return { freq: 0, confidence: 0 };

  const minLag = Math.floor(sampleRate / 1000);   // 1000 Hz ceiling
  const maxLag = Math.min(Math.floor(sampleRate / 60), n - 1); // 60 Hz floor
  let bestLag = -1, bestCorr = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0, norm = 0;
    const nSamples = n - lag;
    for (let i = 0; i < nSamples; i++) {
      corr += buf[i] * buf[i + lag];
      norm += buf[i] * buf[i] + buf[i + lag] * buf[i + lag];
    }
    // Normalize by sample count to prevent bias toward larger lags
    const normCorr = norm > 0 ? (2 * corr) / norm * nSamples : 0;
    if (normCorr > bestCorr) { bestCorr = normCorr; bestLag = lag; }
  }
  if (bestLag < 0) return { freq: 0, confidence: 0 };
  // Normalize confidence back to [0,1] by removing the sample count scaling
  const confidence = bestCorr > 0 ? bestCorr / Math.max(1, n - bestLag) : 0;
  if (confidence < 0.3) return { freq: 0, confidence };
  return { freq: sampleRate / bestLag, confidence };
}

// Fold FFT magnitudes into 12 pitch classes (55 Hz – 4 kHz), max-normalised.
export function chromaFromFFT(mag, sampleRate, fftSize) {
  const chroma = new Float32Array(12);
  const binHz = sampleRate / fftSize;
  for (let i = 1; i < mag.length; i++) {
    const f = i * binHz;
    if (f < 55 || f > 4000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    chroma[((Math.round(midi) % 12) + 12) % 12] += mag[i];
  }
  let max = 0;
  for (const v of chroma) max = Math.max(max, v);
  if (max > 0) for (let i = 0; i < 12; i++) chroma[i] /= max;
  return chroma;
}

// Positive spectral difference (onset strength).
export function spectralFlux(mag, prevMag) {
  let s = 0;
  for (let i = 0; i < mag.length; i++) {
    const d = mag[i] - prevMag[i];
    if (d > 0) s += d;
  }
  return s / mag.length;
}

const TRIADS = (() => {
  const t = [];
  for (let r = 0; r < 12; r++) {
    t.push({ root: r, major: true,  pcs: [r, (r + 4) % 12, (r + 7) % 12] });
    t.push({ root: r, major: false, pcs: [r, (r + 3) % 12, (r + 7) % 12] });
  }
  return t;
})();

const clamp01 = v => Math.max(0, Math.min(1, v));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };

export function buildFingerprint(frames, durationSec) {
  const voiced = frames.filter(f => f.pitchConf > 0.5 && f.pitchHz > 0);
  const pitchConfidence = clamp01(voiced.length / Math.max(1, frames.length));

  const logs = voiced.map(f => Math.log2(f.pitchHz / 55) / 5); // 55 Hz–1760 Hz → 0..1
  const pitchMedian = voiced.length ? clamp01(median(logs)) : 0.5;
  const pitchRange = voiced.length
    ? clamp01((Math.max(...logs) - Math.min(...logs)) * 5 / 3)
    : 0;

  // Contour: 8 samples resampled over voiced frames (0.5 when unvoiced)
  const contour = new Float32Array(8).fill(0.5);
  if (logs.length >= 2) {
    for (let i = 0; i < 8; i++) {
      contour[i] = clamp01(logs[Math.min(logs.length - 1, Math.round((i / 7) * (logs.length - 1)))]);
    }
  }

  // RMS-weighted chroma histogram
  const chroma = new Float32Array(12);
  let wSum = 0;
  for (const f of frames) {
    for (let i = 0; i < 12; i++) chroma[i] += f.chroma[i] * f.rms;
    wSum += f.rms;
  }
  let cMax = 0;
  for (const v of chroma) cMax = Math.max(cMax, v);
  if (cMax > 0) for (let i = 0; i < 12; i++) chroma[i] /= cMax;

  const noteSet = [];
  for (let i = 0; i < 12; i++) if (chroma[i] >= 0.45) noteSet.push(i);
  if (noteSet.length === 0) noteSet.push(chroma.indexOf(Math.max(...chroma)));
  const noteCount = noteSet.length;

  // Harmony: best triad-template match
  let best = { score: -1, major: true };
  for (const t of TRIADS) {
    let inSum = 0, outSum = 0;
    for (let i = 0; i < 12; i++) {
      if (t.pcs.includes(i)) inSum += chroma[i]; else outSum += chroma[i];
    }
    const score = inSum / 3 - (outSum / 9) * 0.5;
    if (score > best.score) best = { score, major: t.major };
  }
  const consonance = clamp01(best.score * 1.4);
  const majorLeaning = best.major;

  // Velocity: onset peaks per second blended with mean onset strength
  const fluxes = frames.map(f => f.flux);
  const fMean = fluxes.reduce((a, b) => a + b, 0) / Math.max(1, fluxes.length);
  const fStd = Math.sqrt(fluxes.reduce((a, b) => a + (b - fMean) ** 2, 0) / Math.max(1, fluxes.length));
  let onsets = 0;
  for (let i = 1; i < fluxes.length - 1; i++) {
    if (fluxes[i] > fMean + fStd && fluxes[i] >= fluxes[i - 1] && fluxes[i] >= fluxes[i + 1]) onsets++;
  }
  const onsetsPerSec = onsets / Math.max(0.25, durationSec);
  const velocity = clamp01(0.6 * (onsetsPerSec / 8) + 0.4 * clamp01(fMean * 4));

  // Dynamics
  const rmses = frames.map(f => f.rms);
  const volMean = clamp01(rmses.reduce((a, b) => a + b, 0) / Math.max(1, rmses.length) * 2.5);
  const vVar = rmses.reduce((a, b) => a + (b - volMean / 2.5) ** 2, 0) / Math.max(1, rmses.length);
  const volVar = clamp01(Math.sqrt(vVar) * 5);
  let rise = 0;
  for (let i = 1; i < rmses.length; i++) rise = Math.max(rise, rmses[i] - rmses[i - 1]);
  const attackSlope = clamp01(rise * 8);

  const centroid = clamp01(frames.reduce((a, f) => a + f.centroid, 0) / Math.max(1, frames.length));
  const spread = clamp01(frames.reduce((a, f) => a + f.spread, 0) / Math.max(1, frames.length));

  // Deterministic seed from the quantised fingerprint
  const q = v => Math.round(v * 255);
  const seedStr = [pitchMedian, pitchRange, velocity, volMean, centroid, spread, consonance]
    .map(q).join(',') + '|' + noteSet.join(',') + '|' + [...contour].map(q).join(',');
  const seed = fnv1a(seedStr);

  return { pitchMedian, pitchRange, contour, pitchConfidence, chroma, noteSet, noteCount,
           consonance, majorLeaning, velocity, volMean, volVar, attackSlope,
           centroid, spread, seed };
}
