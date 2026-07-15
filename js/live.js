// Live mode conductor: rolling feature window, instant envelopes, kick
// detection, and structural morph scheduling. All I/O (audio, renderer,
// worker, palette) is injected — this module is node-testable.
import { buildFingerprint, buildTrajectory } from './features.js?v=31';
import { liveTarget, glideStops, stopsToHex } from './livecolor.js?v=31';

export const WINDOW_SEC = 4;
export const MORPH_CHECK_INTERVAL = 0.75;
export const MORPH_MIN_INTERVAL = 1.5;
export const MORPH_THRESHOLD = 0.18;
export const LIVE_MIN_FRAMES = 20;
export const SILENCE_RMS = 0.008;

// Asymmetric exponential smoother: fast attack, slow release.
export class Envelope {
  constructor(attackSec, releaseSec, value = 0) {
    this.a = attackSec; this.r = releaseSec; this.value = value;
  }
  step(target, dt) {
    const tau = target > this.value ? this.a : this.r;
    this.value += (target - this.value) * (1 - Math.exp(-dt / Math.max(1e-4, tau)));
    return this.value;
  }
}

// Onset detector on spectral flux: fires (value=1) when flux exceeds
// mean + 1.5σ of ~1s of history, then decays with τ=0.12s. 150ms refractory.
export class KickDetector {
  constructor() { this.hist = []; this.value = 0; this.refractory = 0; }
  step(flux, dt) {
    this.value *= Math.exp(-dt / 0.12);
    this.refractory = Math.max(0, this.refractory - dt);
    this.hist.push(flux);
    if (this.hist.length > 60) this.hist.shift();
    const n = this.hist.length;
    if (n >= 10 && this.refractory === 0) {
      const mean = this.hist.reduce((a, b) => a + b, 0) / n;
      const std = Math.sqrt(this.hist.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
      if (flux > mean + 1.5 * std && flux > 0.001) { this.value = 1; this.refractory = 0.15; }
    }
    return this.value;
  }
}

export function trimWindow(frames, nowSec, windowSec = WINDOW_SEC) {
  while (frames.length && nowSec - frames[0].t > windowSec) frames.shift();
  return frames;
}

// How far the sound has moved from the fingerprint currently on screen.
// Weighted mix of note-set Jaccard distance, register, harmony, and energy.
export function fingerprintDelta(a, b) {
  if (!a || !b) return Infinity;
  const setA = new Set(a.noteSet), setB = new Set(b.noteSet);
  let inter = 0;
  for (const v of setA) if (setB.has(v)) inter++;
  const union = setA.size + setB.size - inter;
  const jaccard = union ? 1 - inter / union : 0;
  return 0.45 * jaccard
       + 0.9 * Math.abs(a.pitchMedian - b.pitchMedian)
       + 0.35 * Math.abs(a.consonance - b.consonance)
       + (a.majorLeaning !== b.majorLeaning ? 0.15 : 0)
       + 0.3 * Math.abs(a.velocity - b.velocity);
}
