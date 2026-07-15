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

export class LiveConductor {
  constructor({ audio, renderer, generate, applyStops, getParams, onVu = null }) {
    Object.assign(this, { audio, renderer, generate, applyStops, getParams, onVu });
    this.frames = [];                 // { t: seconds, f: musical frame }
    this.running = true;              // live from construction; stop()/freeze() end it
                                      // (tests drive tick() directly without start())
    this.ampEnv = new Envelope(0.05, 0.25);
    this.grainEnv = new Envelope(0.15, 0.4, 0.5);
    this.rotEnv = new Envelope(0.4, 0.8, 0.3);
    this.kick = new KickDetector();
    this.freqSmooth = 6;
    this.chromaSmooth = new Float32Array(12);
    this.colour = null;               // glideStops state
    this.shownFp = null;              // fingerprint of the geometry on screen
    this.lastCheck = 0;
    this.lastMorph = -Infinity;
    this.inFlight = false;
    this.forceNext = false;
    this._lastNow = 0;
  }

  start() {
    this.running = true;
    this._lastNow = 0;
    this.renderer.setLoopPeriod(8);
    this.renderer.setPlaying(true);   // advances uTime so the wave travels
    const loop = () => {
      if (!this.running) return;
      this.tick(performance.now() / 1000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    this.renderer.setPlaying(false);
    this.renderer.setWave(0, this.freqSmooth);
  }

  forceMorph() { this.forceNext = true; }

  tick(nowSec) {
    const dt = Math.min(0.1, this._lastNow ? nowSec - this._lastNow : 1 / 60);
    this._lastNow = nowSec;
    const f = this.audio.getMusicalFrame();
    if (!f) return;
    this.frames.push({ t: nowSec, f });
    trimWindow(this.frames, nowSec);
    if (this.onVu) this.onVu(f.rms);

    // ── instant layer: volume → breathing, pitch → wave frequency ──
    const amp = this.ampEnv.step(Math.min(0.09, f.rms * 0.6), dt);
    if (f.pitchConf > 0.5 && f.pitchHz > 0) {
      const p = Math.min(1, Math.max(0, Math.log2(f.pitchHz / 55) / 6));
      this.freqSmooth += (3 + 9 * p - this.freqSmooth) * (1 - Math.exp(-dt / 0.2));
    }
    this.renderer.setWave(amp, this.freqSmooth);

    const kick = this.kick.step(f.flux, dt);
    const base = this.getParams();
    this.renderer.setParams({
      exposure: base.exposure * (1 + 1.4 * kick),
      scale: base.scale * (1 + 0.035 * kick),
      grain: base.grain * (0.85 + 0.5 * this.grainEnv.step(f.centroid, dt)),
      autoRotate: 0.25 + 0.6 * this.rotEnv.step(f.spread, dt),
    });

    // ── colour: smoothed chroma → pastel ramp, gliding ──
    const ck = 1 - Math.exp(-dt / 0.3);
    for (let i = 0; i < 12; i++) this.chromaSmooth[i] += (f.chroma[i] - this.chromaSmooth[i]) * ck;
    this.colour = glideStops(this.colour, liveTarget(this.chromaSmooth, f.centroid), dt);
    this.applyStops(stopsToHex(this.colour));

    // ── structural layer: throttled fingerprint check → crossfade morph ──
    const due = nowSec - this.lastCheck >= MORPH_CHECK_INTERVAL || this.forceNext;
    const allowed = !this.inFlight && nowSec - this.lastMorph >= MORPH_MIN_INTERVAL
                 && this.frames.length >= LIVE_MIN_FRAMES;
    if (!due || !allowed) return;
    this.lastCheck = nowSec;
    const meanRms = this.frames.reduce((a, x) => a + x.f.rms, 0) / this.frames.length;
    if (meanRms < SILENCE_RMS) return;               // the room is quiet — idle
    const fp = this.windowFingerprint();
    if (!this.forceNext && fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) return;
    this.forceNext = false;
    this.inFlight = true;
    const p = this.getParams();
    this.generate(fp, { mode: p.mode, density: p.liveDensity, complexity: p.complexity,
                        symmetry: p.symmetry, twist: p.twist, strandCount: 96,
                        cymStyle: p.cymStyle })
      .then((out) => {
        this.inFlight = false;
        if (!this.running || !out) return;
        this.lastMorph = this._lastNow;
        this.shownFp = fp;
        this.renderer.crossfadeTo(out.positions, out.attr, 1.0);
      })
      .catch(() => { this.inFlight = false; });
  }

  windowFingerprint() {
    const raw = this.frames.map(x => x.f);
    const dur = this.frames.length >= 2
      ? this.frames[this.frames.length - 1].t - this.frames[0].t : 0.25;
    const fp = buildFingerprint(raw, Math.max(0.25, dur));
    fp.trajectory = buildTrajectory(raw);
    fp.trajectoryChannels = 4;
    return fp;
  }

  freeze() {
    if (this.frames.length < LIVE_MIN_FRAMES) return null;
    this.stop();
    return { fingerprint: this.windowFingerprint(), stops: stopsToHex(this.colour) };
  }
}
