// Live mode conductor: rolling feature window, instant envelopes, kick
// detection, and structural morph scheduling. All I/O (audio, renderer,
// worker, palette) is injected — this module is node-testable.
import { buildFingerprint, buildTrajectory } from './features.js?v=44';
import { liveTarget, glideStops, stopsToHex } from './livecolor.js?v=44';
import { BrushPace, PAINT_MAX_POINTS } from './paint.js?v=44';
import { createOrbitBrush } from './generators/attractor.js?v=44';

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
       + 0.3 * Math.abs(a.velocity - b.velocity)
       + 0.35 * Math.abs((a.centroid ?? 0) - (b.centroid ?? 0))
       + 0.25 * Math.abs((a.spread ?? 0) - (b.spread ?? 0));
}

// Reveal-based Paint: `strands` (sparse backbone curves, for export) and
// `positions`/`attr` (the dense rendered cloud `count` indexes into) come
// from the same generator call but are NOT index-aligned with each other.
// If the reveal reached completion, use strands as-is (full fidelity, the
// common case). If frozen mid-reveal, truncate each strand independently to
// the same fraction as an honest approximation — not a claim of exact
// per-point alignment between the two arrays.
export function clipStrandsToCount(strands, revealTotal, count) {
  if (!revealTotal || count >= revealTotal) return strands;
  const frac = count / revealTotal;
  return strands.map((s) => {
    const keep = Math.max(0, Math.floor((s.length / 3) * frac)) * 3;
    return s.subarray(0, keep);
  });
}

// Attractor-brush Paint has no discrete strands — writePaintPoints appends
// at strictly increasing offsets, so the point buffer is already one
// continuous stroke in time order. Slice it into segments at each recorded
// steer() boundary so downstream RDP simplification runs per-segment
// instead of over one enormous strand.
export function sliceSegments(positions, boundaries, count) {
  const bounds = boundaries.filter((b) => b < count).concat(count);
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b > a) out.push(positions.subarray(a * 3, b * 3));
  }
  return out;
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
    this.growthMode = 'morph';
    this.growGen = 0;            // stale-generation guard across mode switches/clears
    this.onGrowStatus = null;
    this.paint = null;           // { pace, brush, count, revealTotal, strands, segments, pendingGen, retried, done, begun }
    this.paintMax = null;        // test override; otherwise getParams/paint default
  }

  forceMorph() {
    if (this.growthMode === 'paint') {
      // Settings tweaks steer the brush; they must never wipe the canvas.
      // (Mode switches restart the canvas explicitly via setGrowthMode.)
      if (this.paint) this.paint.forceSteer = true;
      return;
    }
    this.forceNext = true;
  }

  setGrowthMode(mode) {
    this.growthMode = mode;
    this.growGen++;
    this.paint = mode === 'paint'
      ? { pace: new BrushPace(), brush: null, count: 0, revealTotal: 0, strands: [], segments: [0],
          pendingGen: false, retried: false, done: false, begun: false }
      : null;
  }

  _paintTick(nowSec, f, kick, dt) {
    const p = this.getParams();
    const max = this.paintMax ?? p.paintMaxPoints ?? PAINT_MAX_POINTS;
    const st = this.paint;

    // Start the canvas once we have enough sound to fingerprint.
    if (!st.begun) {
      if (this.frames.length < LIVE_MIN_FRAMES) return;
      const meanRms = this.frames.reduce((a, x) => a + x.f.rms, 0) / this.frames.length;
      if (meanRms < SILENCE_RMS) return;
      const fp = this.windowFingerprint();
      st.begun = true;
      this.renderer.beginPaint(max);
      this.shownFp = fp;
      if (p.mode === 'attractor') {
        st.brush = createOrbitBrush(fp, { complexity: p.complexity });
      } else {
        this._requestReveal(fp, p, max, 0);
      }
      return;
    }

    // Advance the brush.
    const k = st.pace.pointsThisFrame(f.rms, kick, dt);
    if (k > 0 && !st.done) {
      if (st.brush) {
        const take = Math.min(k, max - st.count);
        if (take > 0) {
          const chunk = st.brush.next(take, dt);
          this.renderer.writePaintPoints(st.count, chunk.positions, chunk.attr);
          st.count += take;
          this.renderer.setPaintCount(st.count);
        }
      } else if (st.revealTotal > 0) {
        st.count = Math.min(st.count + k, st.revealTotal);
        this.renderer.setPaintCount(st.count);
      }
      const target = st.brush ? max : (st.revealTotal || max);
      if (st.count >= target && !st.done) {
        st.done = true;
        if (this.onGrowStatus) this.onGrowStatus('Painting complete — freeze or clear');
      }
    }

    // Steering: reuse the morph scheduler's cadence and threshold.
    // forceSteer (a settings tweak) bypasses both, but never resets the canvas.
    const due = nowSec - this.lastCheck >= MORPH_CHECK_INTERVAL || st.forceSteer;
    const allowed = (nowSec - this.lastMorph >= MORPH_MIN_INTERVAL || st.forceSteer)
                 && this.frames.length >= LIVE_MIN_FRAMES && !st.done;
    if (!due || !allowed) return;
    this.lastCheck = nowSec;
    const meanRms = this.frames.reduce((a, x) => a + x.f.rms, 0) / this.frames.length;
    if (meanRms < SILENCE_RMS) return;
    const fp = this.windowFingerprint();
    if (!st.forceSteer && fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) return;
    st.forceSteer = false;
    this.lastMorph = nowSec;
    this.shownFp = fp;
    if (st.brush) {
      st.segments.push(st.count);                // mark the bend as a segment boundary
      st.brush.steer(fp);                        // ribbons bend from here on
    } else if (!st.pendingGen) {
      this._requestReveal(fp, p, max, st.count); // repaint the unpainted remainder
    }
  }

  // Full-resolution design for reveal painting; spliceFrom = painted count
  // whose strokes must be preserved (0 = fresh canvas).
  _requestReveal(fp, p, max, spliceFrom) {
    const st = this.paint;
    st.pendingGen = true;
    const gen = this.growGen;
    this.generate(fp, { mode: p.mode, density: max, complexity: p.complexity,
                        symmetry: p.symmetry, twist: p.twist, strandCount: 8,
                        cymStyle: p.cymStyle, liveVariance: true })
      .then((out) => {
        st.pendingGen = false;
        if (!this.running || gen !== this.growGen) return;
        if (!out) {
          if (!st.retried) { st.retried = true; this._requestReveal(fp, p, max, spliceFrom); }
          else if (this.onGrowStatus) this.onGrowStatus('Paint: generation failed — keep making sound to retry');
          return;
        }
        st.retried = false;
        const total = out.attr.length;
        const from = Math.min(spliceFrom, total);
        this.renderer.writePaintPoints(from,
          out.positions.subarray(from * 3), out.attr.subarray(from));
        st.revealTotal = total;
        st.strands = out.strands;
      })
      .catch(() => { st.pendingGen = false; });
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

    // ── paint mode: the sound is the brush ──
    if (this.growthMode === 'paint') {
      this._paintTick(nowSec, f, kick, dt);
      return;
    }

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
    const morphGen = this.growGen;
    const p = this.getParams();
    this.generate(fp, { mode: p.mode, density: p.liveDensity, complexity: p.complexity,
                        symmetry: p.symmetry, twist: p.twist, strandCount: 96,
                        cymStyle: p.cymStyle, liveVariance: true })
      .then((out) => {
        this.inFlight = false;
        if (!this.running || !out || morphGen !== this.growGen) return;
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
    const out = { fingerprint: this.windowFingerprint(), stops: stopsToHex(this.colour) };
    if (this.growthMode === 'paint' && this.paint && this.paint.count > 0) {
      const st = this.paint;
      out.cloud = this.renderer.getPaintSlice(st.count);
      out.cloud.strands = st.brush
        ? sliceSegments(out.cloud.positions, st.segments, st.count)
        : clipStrandsToCount(st.strands, st.revealTotal, st.count);
    }
    return out;
  }
}
