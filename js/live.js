// Live mode conductor: rolling feature window, instant envelopes, kick
// detection, and structural morph scheduling. All I/O (audio, renderer,
// worker, palette) is injected — this module is node-testable.
import { buildFingerprint, buildTrajectory } from './features.js?v=51';
import { liveTarget, glideStops, stopsToHex } from './livecolor.js?v=51';
import { BrushPace, PAINT_MAX_POINTS } from './paint.js?v=51';
import { createOrbitBrush, pickSystemLive, modulatesContinuously } from './generators/attractor.js?v=51';
import { AutoParams, featuresFromFingerprint } from './autoparams.js?v=51';

export const WINDOW_SEC = 4;
export const MORPH_CHECK_INTERVAL = 0.15;
export const MORPH_MIN_INTERVAL = 1.5;
export const MORPH_THRESHOLD = 0.18;

// A change must survive this many consecutive checks before it morphs the
// geometry. Checking every 0.3s instead of 0.75s is most of the responsiveness
// win, but it also triples the chances to fire on a syllable-level blip — and
// the two jitteriest fingerprint channels, pitchMedian and the note set, carry
// the two heaviest weights in fingerprintDelta. Raising the threshold instead
// would be the wrong lever: it suppresses quiet-but-real changes (a timbre-only
// shift scores ~0.21) while a loud transient still sails through. Requiring
// persistence discriminates on the axis that actually matters — a real change
// stays, a blip does not.
export const MORPH_CONFIRM_CHECKS = 2;
export const MORPH_CROSSFADE_SEC = 0.45;

// Continuous modulation of a LOCKED design, as distinct from morphing between
// designs. Cadence is bounded by generation cost (~110ms for 250k points with
// 8 strands), and the crossfade only has to hide point-identity shuffle: a
// chaotic regeneration reshuffles which point is where even when the attractor
// SET barely moves, and additive density rendering makes an identically
// distributed cloud look identical, so a brief blend is enough.
export const MODULATE_INTERVAL = 0.25;
export const MODULATE_CROSSFADE_SEC = 0.15;

// A reveal splice replaces the whole unpainted remainder — up to 600k points,
// which is 7.2 MB of positions plus 2.4 MB of attributes uploaded in a single
// frame. That is a guaranteed hitch. Write it across frames instead.
export const PAINT_SPLICE_CHUNK = 40_000;

// The window stays 4s — that context is what keeps a design stable — but the
// fingerprint is no longer a flat mean of it. A flat mean makes new audio reach
// full weight only after 4 full seconds, which was the largest single term in
// the sound→geometry lag. An exponential recency weight puts the window's
// centre of mass ~1.2s back instead of ~2s, so a change registers while the
// older frames still damp out frame-to-frame jitter.
export const RECENCY_TAU = 2.5;

export function recencyWeights(frames, nowSec) {
  return frames.map(({ t }) => Math.exp(-Math.max(0, nowSec - t) / RECENCY_TAU));
}
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
    const src = s.pts ?? s;
    const keep = Math.max(0, Math.floor((src.length / 3) * frac)) * 3;
    const cut = src.subarray(0, keep);
    return s.pts ? { ...s, pts: cut } : cut;
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
    this.lockedSystem = null;         // attractor system, fixed for the session
    this.auto = new AutoParams();     // voice-driven slider values
    this.onAutoParams = null;         // (values) => void, for the UI sliders
    this.lastCheck = 0;
    this.overChecks = 0;           // consecutive checks over MORPH_THRESHOLD
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

  // Spec: system lock is "cleared on Clear and on mode switch". A generator
  // mode change (attractor/cymatics/…) is exactly such a switch, but it only
  // ever calls forceMorph() — the same regeneration path a settings tweak
  // uses — so without this the locked system survived a mode change and a
  // user who disliked their locked form had no escape short of Clear.
  resetLock() {
    this.lockedSystem = null;
  }

  setGrowthMode(mode) {
    this.growthMode = mode;
    this.growGen++;
    this.lockedSystem = null;         // a fresh canvas re-picks the form
    this.paint = mode === 'paint'
      ? { pace: new BrushPace(), brush: null, count: 0, revealTotal: 0, strands: [], segments: [0],
          pendingGen: false, retried: false, done: false, begun: false, pending: null , restore: null }
      : null;
  }

  _paintTick(nowSec, f, kick, dt) {
    const p = this.getParams();
    const max = this.paintMax ?? p.paintMaxPoints ?? PAINT_MAX_POINTS;
    const st = this.paint;

    // Re-materialising a resumed painting. Unlike a splice — which fills the
    // buffer AHEAD of the reveal frontier — this is rebuilding what is already
    // meant to be on screen, so the visible count has to follow the written
    // frontier exactly: revealing past it would draw uninitialised points as a
    // blob at the origin. The brush stays parked until the canvas is whole.
    if (st.restore) {
      const q = st.restore;
      const end = Math.min(q.total, q.next + PAINT_SPLICE_CHUNK);
      this.renderer.writePaintPoints(q.next,
        q.positions.subarray(q.next * 3, end * 3), q.attr.subarray(q.next, end));
      q.next = end;
      st.count = end;
      this.renderer.setPaintCount(end);
      if (q.next >= q.total) st.restore = null;
      return;
    }

    // Drain a queued splice a chunk at a time so no single frame uploads
    // megabytes. Always stays ahead of the reveal by a comfortable margin:
    // the reveal (`st.count`, advanced below) can grow by at most
    // BrushPace.pointsThisFrame per tick — capped at dt * 40_000, so ≤4,000
    // points at the 0.1s dt clamp — while this drain advances `q.next` by up
    // to PAINT_SPLICE_CHUNK (40_000) per tick, a 10x margin. (revealTotal is
    // the full new total as of splice time, not a bound on `q.next`.)
    if (st.pending) {
      const q = st.pending;
      const end = Math.min(q.total, q.next + PAINT_SPLICE_CHUNK);
      if (end > q.next) {
        this.renderer.writePaintPoints(q.next,
          q.positions.subarray(q.next * 3, end * 3), q.attr.subarray(q.next, end));
        q.next = end;
      }
      if (q.next >= q.total) st.pending = null;
    }

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
        // Resolve once and hand the answer to the brush, rather than letting it
        // re-derive one independently and hope the two agree.
        st.brush = createOrbitBrush(fp, { complexity: p.complexity,
                                          attractorSystem: this._lockSystem(fp, p) });
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
    // Same debounce as the morph path. Without it Paint fired on a single
    // threshold crossing, and after the check interval dropped 0.75s -> 0.15s
    // that meant 15 design splices per 30s of one person talking.
    if (!st.forceSteer) {
      if (fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) { st.overChecks = 0; return; }
      st.overChecks = (st.overChecks || 0) + 1;
      if (st.overChecks < MORPH_CONFIRM_CHECKS) return;
    }
    st.overChecks = 0;
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
                        cymStyle: p.cymStyle, liveVariance: true,
                        attractorSystem: p.attractorSystem,
                        lockedSystem: this._lockSystem(fp, p) })
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
        // Recompute from the CURRENT count, not the one captured when this
        // generation was requested — the brush kept moving while the worker ran,
        // and writing from the stale offset repaints points already on screen.
        const from = Math.min(Math.max(spliceFrom, st.count), total);
        st.revealTotal = total;
        st.strands = out.strands;
        st.pending = { positions: out.positions, attr: out.attr, next: from, total };
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

    // ── auto parameters: the voice moves the sliders ──
    if (this.shownFp) {
      const vals = this.auto.step(featuresFromFingerprint(this.shownFp, f.rms * 4), dt);
      this.renderer.setVisibleFraction(vals.visibleFraction);
      if (this.onAutoParams) this.onAutoParams(vals);
    }

    // ── paint mode: the sound is the brush ──
    if (this.growthMode === 'paint') {
      this._paintTick(nowSec, f, kick, dt);
      return;
    }

    // ── structural layer: throttled fingerprint check → crossfade morph ──
    // Once a system is locked, the design is modulated on a fast fixed cadence
    // rather than morphed on a delta threshold — there is no longer anything to
    // switch TO, so waiting for a big change would just make it unresponsive.
    // …and only for a system that stays coherent when deformed. thomas does
    // not (see modulatesContinuously), so it takes the ordinary morph path:
    // regenerate on a real change in the sound, dissolved over the full
    // crossfade, rather than 4 Hz regeneration that would read as flickering
    // between unrelated designs.
    const modulating = !!this.lockedSystem && base.mode === 'attractor'
                    && modulatesContinuously(this.lockedSystem);
    const interval = modulating ? MODULATE_INTERVAL : MORPH_CHECK_INTERVAL;
    const minGap = modulating ? MODULATE_INTERVAL : MORPH_MIN_INTERVAL;
    const due = nowSec - this.lastCheck >= interval || this.forceNext;
    const allowed = !this.inFlight && nowSec - this.lastMorph >= minGap
                 && this.frames.length >= LIVE_MIN_FRAMES;
    if (!due || !allowed) return;
    this.lastCheck = nowSec;
    const meanRms = this.frames.reduce((a, x) => a + x.f.rms, 0) / this.frames.length;
    if (meanRms < SILENCE_RMS) return;               // the room is quiet — idle
    const fp = this.windowFingerprint();
    // While modulating, every tick regenerates: the auto parameters have moved
    // even when the fingerprint has not, and the whole point is a design that
    // breathes with the voice rather than one that waits for a threshold.
    if (!this.forceNext && !modulating) {
      // Debounce: the change has to still be there on the next check. A blip
      // resets the run; the very first morph of a session is exempt so the
      // opening design still appears immediately.
      if (fingerprintDelta(fp, this.shownFp) < MORPH_THRESHOLD) { this.overChecks = 0; return; }
      this.overChecks = (this.overChecks || 0) + 1;
      if (this.shownFp && this.overChecks < MORPH_CONFIRM_CHECKS) return;
    }
    this.overChecks = 0;
    this.forceNext = false;
    this.inFlight = true;
    const morphGen = this.growGen;
    const p = this.getParams();
    const a = this.auto.value;
    // A parameter the user has taken manual ownership of (main.js's
    // autoOwned[key] === false) must use their value, not the voice-driven
    // glide: this.auto keeps stepping every tick regardless of ownership (it
    // still needs to for visibleFraction and the UI slider readout), so
    // reading a.* unconditionally here silently overrode a dragged Twist or
    // Complexity slider with the auto value on every single regeneration.
    // p.complexity/p.twist already hold the right value in both cases —
    // paintAutoSliders keeps them synced to the auto glide only while owned,
    // and manual input writes them directly and stops syncing — so honouring
    // ownership just means picking p.* over a.* for an owned key.
    const owned = p.autoOwned || {};
    this.generate(fp, { mode: p.mode, density: p.liveDensity,
                        complexity: owned.complexity === false ? p.complexity : a.complexity,
                        symmetry: p.symmetry,
                        twist: owned.twist === false ? p.twist : a.twist,
                        strandCount: 8,
                        cymStyle: p.cymStyle, liveVariance: true,
                        attractorSystem: p.attractorSystem,
                        lockedSystem: this._lockSystem(fp, p) })
      .then((out) => {
        this.inFlight = false;
        if (!this.running || morphGen !== this.growGen) return;
        // A failed generation still has to arm the backoff gate: with the
        // debounce bypassed while modulating, leaving lastMorph untouched
        // would make the next tick immediately eligible again — a zero-gap
        // retry loop against a generator that keeps failing.
        if (!out) { this.lastMorph = this._lastNow; return; }
        this.lastMorph = this._lastNow;
        this.shownFp = fp;
        this.renderer.crossfadeTo(out.positions, out.attr,
          modulating ? MODULATE_CROSSFADE_SEC : MORPH_CROSSFADE_SEC);
      })
      .catch(() => { this.inFlight = false; this.lastMorph = this._lastNow; });
  }

  // The form is chosen once, from the first sound that is worth fingerprinting,
  // and held for the rest of the session. Everything after that is modulation
  // of that one design — which is the whole point: system identity dominates
  // appearance (same-system designs overlap 0.60-0.88 by cell occupancy,
  // cross-system only 0.10-0.39), so re-picking mid-session reads as swapping
  // designs, not as responding to a voice.
  // An explicit pick from the Mode panel skips the lock's whole reason for
  // existing — there is nothing to hold steady, the user has already said which
  // form they want — so it is recorded as the lock outright. Everything the
  // conductor and the UI read off `lockedSystem` (the modulation gate, the
  // paint brush, the tests) then reports the system actually being built.
  _lockSystem(fp, params = {}) {
    const choice = params.attractorSystem;
    if (choice != null && choice !== 'auto') {
      this.lockedSystem = choice;
    } else if (!this.lockedSystem) {
      this.lockedSystem = pickSystemLive(fp);
    }
    return this.lockedSystem;
  }

  windowFingerprint() {
    const raw = this.frames.map(x => x.f);
    const dur = this.frames.length >= 2
      ? this.frames[this.frames.length - 1].t - this.frames[0].t : 0.25;
    const now = this.frames.length ? this.frames[this.frames.length - 1].t : 0;
    const fp = buildFingerprint(raw, Math.max(0.25, dur), recencyWeights(this.frames, now));
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
      // Capturing mid-rebuild would slice a partially rewritten buffer and
      // permanently truncate the painting. Today that is unreachable — freeze
      // needs LIVE_MIN_FRAMES frames and a rebuild always finishes within
      // PAINT_MAX / PAINT_SPLICE_CHUNK = 15 ticks — but that is a coincidence
      // between three unrelated constants, not a guarantee. Finish the rebuild
      // instead of depending on it. The loop is already stopped, so the cost of
      // one large write here is nothing.
      if (st.restore) {
        const q = st.restore;
        if (q.total > q.next) {
          this.renderer.writePaintPoints(q.next,
            q.positions.subarray(q.next * 3, q.total * 3), q.attr.subarray(q.next, q.total));
        }
        st.count = q.total;
        this.renderer.setPaintCount(q.total);
        st.restore = null;
      }
      out.cloud = this.renderer.getPaintSlice(st.count);
      out.cloud.strands = st.brush
        ? sliceSegments(out.cloud.positions, st.segments, st.count)
        : clipStrandsToCount(st.strands, st.revealTotal, st.count);
      out.resumable = true;   // paint state is intact; resume() can pick it up
    }
    return out;
  }

  // Freeze stops the loop but leaves every piece of paint state in place —
  // the brush's live orbit and glided coefficients, the BrushPace envelope,
  // the revealed count, and the segment boundaries. Painting can therefore
  // CONTINUE rather than restart, which recreating the brush from the frozen
  // fingerprint could not do: a fresh orbit re-warms from a different point
  // and the stroke would jump.
  //
  // The renderer's paint buffer does not survive, though — capture calls
  // setCloud(), which drops _paintPos. So the caller hands the frozen cloud
  // back and we re-establish the buffer from it before restarting.
  canResume() {
    return this.growthMode === 'paint' && !!this.paint && this.paint.begun
        && this.paint.count > 0 && !this.paint.done;
  }

  resume(cloud, maxPoints) {
    // Re-entrancy guard. The caller has to await microphone permission before
    // getting here, and a second click during that gap would otherwise restore
    // twice and install a second animation loop on the same conductor —
    // doubling the tick rate, the paint speed and the generation dispatches.
    if (this.running) return false;
    if (!this.canResume()) return false;
    const st = this.paint;
    const n = Math.min(st.count, cloud ? cloud.attr.length : 0);
    if (!n) return false;
    this.renderer.beginPaint(maxPoints);
    // Re-materialise across frames rather than in one write. A full painting is
    // 600k points — 7.2 MB of positions plus 2.4 MB of attributes — and pushing
    // that in a single frame is the same hitch PAINT_SPLICE_CHUNK exists to
    // prevent. Revealing it in chunks also reads better than a hard pop.
    st.restore = { positions: cloud.positions, attr: cloud.attr, next: 0, total: n };
    st.count = 0;
    this.renderer.setPaintCount(0);
    // A splice queued when we froze refers to the pre-freeze buffer; the
    // reveal will re-request one from the current sound if it needs it.
    st.pending = null;
    st.pendingGen = false;
    // Make the conductor live again, but leave installing the animation loop
    // to the caller — start() needs requestAnimationFrame, and keeping that
    // out of here is what lets resume() be driven directly by tick() in tests.
    this.running = true;
    this._lastNow = 0;
    return true;
  }
}
